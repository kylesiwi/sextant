// lib/paths.mjs — runtime/durable path helpers for the Sextant plugin.
//
// Two storage tiers (per § 11 R11 hot/cold split):
//   - Runtime ("hot"): ephemeral, per-session, single-host (statusline-state.json,
//     turn-state.json, hooks.log, …). Lives on FAST NATIVE FS resolved by
//     lib/runtime-locate.mjs ($XDG_RUNTIME_DIR / tmpdir, keyed by projectHash) —
//     NOT the project tree. v0.7.0 put it under <cwd>/.sextant/runtime "for
//     cross-host visibility"; that taxed every hook with v9fs write latency for a
//     consumer that doesn't exist (hot state is single-session/single-host). See
//     docs/hot-state-relocation-design.md.
//   - Durable ("cold"): per-project, genuinely cross-host, committed-or-gitignored
//     under <cwd>/.sextant/. Holds cerebrum, bugs/, graph, journal, etc.
//
// All paths returned are absolute and WITHOUT trailing slash. sessionId is
// validated to prevent traversal (no `..`, no `/`).

import fs from 'node:fs/promises';
import path from 'node:path';

import { runtimeRootFor } from './runtime-locate.mjs';

function validateSessionId(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    throw new Error('sessionId required');
  }
  if (typeof sessionId !== 'string') {
    throw new Error('sessionId required');
  }
  if (sessionId.includes('/') || sessionId.includes('..')) {
    throw new Error('invalid sessionId');
  }
}

function validateCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd required');
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error('cwd must be absolute');
  }
}

// runtimeBase: returns <runtimeRootFor(cwd)>/sextant-<sessionId> — by default a
// native-FS path (lib/runtime-locate.mjs), per-project-keyed and off the v9fs
// project tree.
//
// SEXTANT_RUNTIME_BASE overrides the root (documented setting + test isolation +
// cross-host opt-in): when set, the cwd argument is ignored and the path becomes
// `${SEXTANT_RUNTIME_BASE}/sextant-<sessionId>` — same as the historical override.
export function runtimeBase(sessionId, cwd) {
  validateSessionId(sessionId);
  // cwd is only needed to derive the projectHash; the override path ignores it.
  const hasOverride = !!(process.env.SEXTANT_RUNTIME_BASE && process.env.SEXTANT_RUNTIME_BASE.length > 0);
  if (!hasOverride) validateCwd(cwd);
  return path.join(runtimeRootFor(cwd), `sextant-${sessionId}`);
}

// runtimeRoot: the per-project parent of all sextant-<sid>/ directories. Used by
// out-of-hook callers (e.g. bin/context.mjs) that scan for active sessions.
// Resolves to the same native root as runtimeBase. Like
// durableBase, we skip cwd validation here (asymmetric with runtimeBase) — the
// callers are CLI-style entrypoints that have already resolved their root.
export function runtimeRoot(cwd) {
  return runtimeRootFor(cwd);
}

export function durableBase(cwd) {
  return path.resolve(cwd, '.sextant');
}

export function statuslineStatePath(sessionId, cwd) {
  return path.join(runtimeBase(sessionId, cwd), 'statusline-state.json');
}

export function lockfilePath(sessionId, cwd) {
  return path.join(runtimeBase(sessionId, cwd), 'statusline-state.json.lock');
}

export function hooksLogPath(sessionId, cwd) {
  return path.join(runtimeBase(sessionId, cwd), 'hooks.log');
}

export function runtimeFile(sessionId, name, cwd) {
  return path.join(runtimeBase(sessionId, cwd), name);
}

// Phase 2b § 5.8: postToolUse stores the last project-file edit's relative
// path + ts here. The auto-tagger reads this on cerebrum writes to decide
// whether to attribute new rules to that file (high confidence) or fall to
// [!review] (low confidence). Per-session, ephemeral.
export function lastProjectFileEditPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'last_project_file_edit.json', cwd);
}

// Phase 2.5 § 5.11: PreToolUse appends one JSONL entry here per fired
// mandatory rule. PreCompact reads the tail of this log and bundles it
// into precompact.json so the next prompt's restoration block can list
// the rules that fired in the compacted session. Per-session, ephemeral.
export function rulesFiredPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'rules-fired.jsonl', cwd);
}

// T3-B: postToolUse appends one JSONL entry here per `cerebrum remember`
// authoring event (detected on the Bash tool). The Stop turn-summary reads it,
// filters by ts >= turn-state.started_at, and reports "authored N rule(s) this
// turn". A genuine-author signal — unlike a cerebrum line-hash set-diff, it is
// immune to in-place rehashes (auto-tag / promote / reconcile) that change a
// rule's hash without authoring anything. Per-session, ephemeral.
export function rulesAuthoredPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'rules-authored.jsonl', cwd);
}

// turn-state.json: a per-session scratchpad covering several distinct
// fields owned by different hooks:
//   - pending_restore + snapshot_ts + compaction_n (PreCompact → § 5.11)
//   - started_at + turn_id                         (SessionStart / UPS → § 5.8.3)
// Centralised here so callers don't hard-code "turn-state.json".
export function turnStatePath(sessionId, cwd) {
  return runtimeFile(sessionId, 'turn-state.json', cwd);
}

// Phase 5 § 5.6: PreToolUse Bash sets a sentinel flag in the runtime dir
// when it detects a test runner invocation. PostToolUse Bash reads the flag
// to know whether to run the test-pass / test-fail loop and clears it.
export function testRunPendingFlagPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'test-run-pending.flag', cwd);
}

// Phase 5 § 5.6: same idea, but for `git commit` invocations. PostToolUse
// Bash reads the flag, snapshots edits.json into commits/<ts>.json on a
// zero-exit-code response, and clears it.
export function commitPendingFlagPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'commit-pending.flag', cwd);
}

// Phase 5 § 5.8 (1) + § 6.6: postToolUse appends one entry per
// Edit/Write/MultiEdit on a project file. The commit-snapshot path
// (postToolUse Bash on a successful git commit) consumes the array, writes
// it to .sextant/session/<sid>/commits/<ts>.json, and clears the runtime
// file. The file lives in the runtime dir so it's session-ephemeral; the
// commit snapshot itself is durable.
export function editsPath(sessionId, cwd) {
  return runtimeFile(sessionId, 'edits.json', cwd);
}

export function durableFile(cwd, name) {
  return path.join(durableBase(cwd), name);
}

// Cross-session continuity snapshot (§ 7.7). Consumed by sessionStart.mjs:100
// to render a "where we left off" line in the additionalContext block.
// Produced by sessionEnd.mjs / stop.mjs — each writes an atomic snapshot of
// the runtime statusline-state at end of turn / end of session.
export function lastJsonPath(cwd) {
  return path.join(durableBase(cwd), 'session', 'last.json');
}

export function tranchesJsonPath(cwd) {
  return durableFile(cwd, 'tranches.json');
}

export async function ensureRuntimeDir(sessionId, cwd) {
  const dir = runtimeBase(sessionId, cwd);
  // 0700: the native root may sit in a shared /tmp; keep per-user-private.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function ensureDurableDir(cwd, subdir) {
  const base = durableBase(cwd);
  const dir = subdir ? path.join(base, subdir) : base;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
