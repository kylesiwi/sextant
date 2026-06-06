// lib/stores/stats.mjs — durable A/B measurement store (§ 6.4).
//
// Phase 8 ships this as instrumentation. The on-disk file lives at
// <cwd>/.sextant/stats.json and accumulates over the project's lifetime.
// It is NOT a per-session runtime artifact (compare runtimeBase, which
// is wiped at SessionEnd).
//
// Schema (per § 6.4):
//   {
//     schema_version: 1,
//     ab_arm: 'A' | 'B',
//     session_count: number,
//     tokens_saved_estimate: number,   // ALWAYS 0 in v1, see § 10.10
//     tokens_paid_extra: number,       // grows on additionalContext emission
//     net_savings: number,             // = saved - paid; recomputed on write
//     rule_fires: {
//       <line_hash>: {
//         fires: number,
//         contradicted: boolean,
//         last_fired: <iso string>,
//       }
//     },
//     redundant_reads_blocked: number, // grows on PreToolUse dedup hit
//     last_updated: <iso string> | null,
//   }
//
// A/B arm semantics (§ 10.5 composition risk):
//   Increments here happen ONLY on the treatment arm (state.ab_arm === 'B').
//   The control arm must not touch rule_fires or the promotion ladder
//   (Phase 10) is corrupted by suppression bias. Callers are responsible
//   for gating before invoking the mutators.
//
// Atomicity: readJson tolerates ENOENT + SyntaxError; writeJsonAtomic does
// tmp + rename so a reader never sees a half-written file. Concurrent
// writers (e.g. two Claude Code sessions in the same project) are
// coordinated via withPathLock on stats.json so the on-disk file can't be
// corrupted by interleaved writes. Lost-update semantics across the
// read/mutate/writeStats sequence remain the caller's concern — wrap the
// whole sequence in withPathLock too if you need strict accumulation.

import path from 'node:path';

import { readJson } from '../io.mjs';
import { withPathLock } from '../state.mjs';

const STATS_FILENAME = 'stats.json';

// Durable-store lock timeout. See lib/stores/bugs.mjs for rationale: a
// missed bug/stats write is worse than waiting in line for a busy peer.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 2;

export const STATS_SCHEMA_VERSION = 1;

export function defaultStats() {
  return {
    schema_version: STATS_SCHEMA_VERSION,
    ab_arm: 'A',
    session_count: 0,
    tokens_saved_estimate: 0,
    tokens_paid_extra: 0,
    net_savings: 0,
    rule_fires: {},
    redundant_reads_blocked: 0,
    globals_deduped: 0,
    last_updated: null,
  };
}

// statsPath: helper centralising the filename so callers can't typo it.
export function statsPath(durableBase) {
  return path.join(durableBase, STATS_FILENAME);
}

// readStats: load + merge with defaults. Missing / malformed file → defaults.
// We shallow-merge so an older on-disk shape (missing newer fields) still
// produces a complete object on the way back out.
export async function readStats(durableBase) {
  const file = statsPath(durableBase);
  const data = await readJson(file);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...defaultStats(), ...data };
  }
  return defaultStats();
}

// writeStats: lock-coordinated atomic write. Stamps last_updated and
// recomputes net_savings, then writes through withPathLock so a concurrent
// session's writeStats can't tear the JSON. Returns the post-stamp object
// so callers can chain assertions. The on-disk current value is discarded
// and overwritten with `stats` — callers wanting accumulation across
// processes should build the merged snapshot themselves before calling.
export async function writeStats(durableBase, stats) {
  const file = statsPath(durableBase);
  stats.last_updated = new Date().toISOString();
  stats.net_savings = (stats.tokens_saved_estimate ?? 0) - (stats.tokens_paid_extra ?? 0);
  await withPathLock(
    file,
    () => stats,
    { defaultValue: defaultStats(), lockTimeoutMs: LOCK_TIMEOUT_MS, pollIntervalMs: LOCK_POLL_MS },
  );
  return stats;
}

// incrementRuleFire: bump fires + stamp last_fired for a given line_hash.
// First touch creates the entry with contradicted=false. The contradicted
// flag is reserved for Phase 10's reviewer subagent.
//
// Note: this is a pure in-memory mutator. Durable coordination is handled
// by withPathLock inside writeStats. Hook callers (preToolUse,
// postToolUse) follow the readStats → mutate(s) → writeStats(base, s)
// pattern; the lock at writeStats prevents file corruption, but
// lost-updates across the read/write window remain possible — that's a
// wider refactor outside this fix's scope.
export function incrementRuleFire(stats, lineHash) {
  if (!stats.rule_fires || typeof stats.rule_fires !== 'object') {
    stats.rule_fires = {};
  }
  if (!stats.rule_fires[lineHash]) {
    stats.rule_fires[lineHash] = { fires: 0, contradicted: false, last_fired: null };
  }
  stats.rule_fires[lineHash].fires += 1;
  stats.rule_fires[lineHash].last_fired = new Date().toISOString();
}

// Move a rule's fire history from one line-hash to another. An in-place rule
// edit (promote adds [!]; the auto-tagger adds a scope bucket) rewrites the
// line, so its content-derived hash changes — without this, the accrued fires
// orphan under the old hash and the rule resets to zero. Mutates stats in
// place; returns true iff an entry moved. No-ops when oldHash has no history
// or the hashes match (so callers don't need to pre-check). On collision
// (newHash already has history) the counters merge conservatively: fires sum,
// last_fired takes the later, contradicted ORs.
export function migrateRuleFireKey(stats, oldHash, newHash) {
  if (!stats || typeof stats !== 'object') return false;
  if (!oldHash || !newHash || oldHash === newHash) return false;
  const rf = stats.rule_fires;
  if (!rf || typeof rf !== 'object' || !rf[oldHash]) return false;
  const moving = rf[oldHash];
  const dst = rf[newHash];
  if (dst) {
    dst.fires = (dst.fires || 0) + (moving.fires || 0);
    if (moving.last_fired && (!dst.last_fired || moving.last_fired > dst.last_fired)) {
      dst.last_fired = moving.last_fired;
    }
    dst.contradicted = Boolean(dst.contradicted || moving.contradicted);
  } else {
    rf[newHash] = moving;
  }
  delete rf[oldHash];
  return true;
}

// Apply a batch of {oldHash, newHash} rewrites to the durable ledger (read →
// migrate → write, only if something moved). Best-effort: a missing/locked
// store is a no-op, matching the rest of the stats writers.
export async function migrateRuleFires(durableBase, rewrites) {
  if (!Array.isArray(rewrites) || rewrites.length === 0) return;
  const stats = await readStats(durableBase);
  let changed = false;
  for (const r of rewrites) {
    if (r && migrateRuleFireKey(stats, r.oldHash, r.newHash)) changed = true;
  }
  if (changed) await writeStats(durableBase, stats);
}

// addTokensPaid / addTokensSaved / bumpRedundantRead / bumpSessionCount:
// pure in-memory mutators. See incrementRuleFire's note re: durable
// coordination.
export function addTokensPaid(stats, n) {
  if (!Number.isFinite(n) || n <= 0) return;
  stats.tokens_paid_extra = (stats.tokens_paid_extra ?? 0) + n;
}

export function addTokensSaved(stats, n) {
  if (!Number.isFinite(n) || n <= 0) return;
  stats.tokens_saved_estimate = (stats.tokens_saved_estimate ?? 0) + n;
}

export function bumpRedundantRead(stats) {
  stats.redundant_reads_blocked = (stats.redundant_reads_blocked ?? 0) + 1;
}

// bumpGlobalsDeduped: count a suppression of [!global] mandatory rules
// (already injected in this session, digest matched). Per § 6.4 the
// counter is treatment-arm-only; gating lives at the call site.
export function bumpGlobalsDeduped(stats) {
  stats.globals_deduped = (stats.globals_deduped ?? 0) + 1;
}

// bumpSessionCount: increment session_count. Reserved for SessionStart wiring
// (post-v1); v1 ships the field as 0 until the hook is instrumented. Keeps
// the helper here so the store's API surface is complete.
export function bumpSessionCount(stats) {
  stats.session_count = (stats.session_count ?? 0) + 1;
}
