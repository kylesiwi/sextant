// lib/hooks/keywordDedup.mjs — per-session windowed dedup for [kw:] rule fires.
//
// Motivation:
//   listKeywordMatches annotates each match with a trigger ('critical' |
//   'general'). The desensitization problem (the same rule re-shown on call
//   after call until the agent skips the whole block) is attacked here:
//
//     - CRITICAL-triggered fires (a '*'-marked keyword is present) ALWAYS emit.
//       These are the decisive / safety-critical signals; re-showing them every
//       turn is the point.
//     - GENERAL-triggered fires (an OPTED-IN rule's corroborating keywords)
//       emit at most once per N turns per rule. A rule that genuinely matches a
//       general token on every Bash call no longer re-fires 30×.
//     - LEGACY fires (unmarked `[kw:a,b,c]` OR buckets) are NEVER throttled —
//       a pre-existing rule emits exactly as before until its author opts in,
//       so an un-re-authored safety rule can't silently under-fire. Throttling
//       is opt-in on BOTH axes (scoring AND frequency), consistent with the
//       legacy-matching guarantee in lib/stores/cerebrum.mjs.
//
// State:
//   turn-state.json#kw_general_last_turn : { <lineHash>: <turn_id> }
//   maps each rule to the turn it last emitted via the general path. turn-state
//   survives across turns within a session (only injected_nodes is reset per
//   UserPromptSubmit), so the throttle is naturally session-scoped. The map is
//   cleared on compaction (restore.mjs) so post-compact the next general fire
//   is fresh.
//
// Clocks are INDEPENDENT: a critical fire never stamps the general clock, so
// "generals once every N turns" means N turns since the last GENERAL emit —
// criticals firing in between don't move it.
//
// Fail-open: if turn-state is missing/malformed or carries no turn_id (e.g. a
// tool call before any UserPromptSubmit), we emit everything. We never suppress
// a rule on uncertain state.
//
// Escape hatches:
//   SEXTANT_KW_DEDUP=off        — disable entirely (every general fire emits).
//   SEXTANT_KW_DEDUP_TURNS=<N>  — window size in turns (default 5).

import { turnStatePath } from '../paths.mjs';
import { readJson, readModifyJson } from '../io.mjs';
import { lineHash } from '../stores/cerebrum.mjs';

export const KW_GENERAL_FIELD = 'kw_general_last_turn';
const DEFAULT_WINDOW_TURNS = 5;

// keywordDedupDisabled(): env escape hatch mirroring globalsDedupDisabled().
export function keywordDedupDisabled() {
  const raw = process.env.SEXTANT_KW_DEDUP;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// keywordDedupWindow(): turns between successive general-triggered emits of the
// same rule. SEXTANT_KW_DEDUP_TURNS overrides; default 5.
export function keywordDedupWindow() {
  const raw = process.env.SEXTANT_KW_DEDUP_TURNS;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw.trim(), 10);
    if (n > 0) return n;
  }
  return DEFAULT_WINDOW_TURNS;
}

// partitionKeywordMatches(matches, turnId, lastMap, window): PURE.
//   matches  — [{ rule, trigger }] from listKeywordMatches.
//   turnId   — current turn_id (number).
//   lastMap  — { <lineHash>: <turn_id> } of prior general emits.
//   window   — turns between general emits.
// Returns { emit: [rule,...], updates: { <lineHash>: turnId } } where `updates`
// records the general fires we let through (callers persist them).
export function partitionKeywordMatches(matches, turnId, lastMap, window) {
  const emit = [];
  const updates = {};
  const last = (lastMap && typeof lastMap === 'object') ? lastMap : {};
  if (!Array.isArray(matches)) return { emit, updates };
  for (const m of matches) {
    if (!m || !m.rule || typeof m.rule.raw !== 'string') continue;
    const rule = m.rule;
    // Only opted-in 'general' fires throttle. 'critical' ('*'-marked) and
    // 'legacy' (unmarked OR buckets) always emit and never touch the clock.
    if (m.trigger !== 'general') {
      emit.push(rule);
      continue;
    }
    const h = lineHash(rule.raw);
    const prev = last[h];
    const elapsed = (typeof prev === 'number' && Number.isFinite(prev)) ? (turnId - prev) : Infinity;
    if (elapsed >= window) {
      emit.push(rule);
      updates[h] = turnId;
    }
  }
  return { emit, updates };
}

// dedupKeywordMatches(matches, sid, cwd): async wrapper. Reads turn-state,
// partitions, persists the general-emit timestamps, and returns the rule
// entries to emit. Best-effort: any I/O failure or missing turn_id fails OPEN
// (returns every matched rule). Returns a flat array of rule entries so callers
// drop in where the old listKeywordMatches return used to go.
export async function dedupKeywordMatches(matches, sid, cwd) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  const allRules = () => matches.map((m) => (m && m.rule) ? m.rule : null).filter(Boolean);
  if (keywordDedupDisabled()) return allRules();

  let ts = null;
  try { ts = await readJson(turnStatePath(sid, cwd)); } catch { ts = null; }
  const turnId = (ts && Number.isFinite(ts.turn_id)) ? ts.turn_id : null;
  if (turnId === null) return allRules(); // no turn context → fail open

  const lastMap = (ts && ts[KW_GENERAL_FIELD] && typeof ts[KW_GENERAL_FIELD] === 'object')
    ? ts[KW_GENERAL_FIELD]
    : {};
  const { emit, updates } = partitionKeywordMatches(matches, turnId, lastMap, keywordDedupWindow());

  if (Object.keys(updates).length > 0) {
    try {
      await readModifyJson(turnStatePath(sid, cwd), (o) => {
        const cur = (o[KW_GENERAL_FIELD] && typeof o[KW_GENERAL_FIELD] === 'object') ? o[KW_GENERAL_FIELD] : {};
        o[KW_GENERAL_FIELD] = { ...cur, ...updates };
      });
    } catch { /* best-effort; the emit decision already stands */ }
  }
  return emit;
}
