// lib/hooks/mandatoryGlobals.mjs — session-scoped dedup helpers for
// [!global] mandatory rule injection.
//
// Motivation (per __URGENT_IMPLEMENTATION.md):
//   SessionStart already injects every [!global] rule verbatim into the
//   agent's context. PreToolUse:Bash and PreToolUse:Read then re-emit the
//   same rule set on every fire — 30 Bash calls and 15 Read calls in a
//   single turn measured ~27k tokens of duplication. The rules are
//   session-wide constants; they don't change between tool calls.
//
// Design:
//   - Compute a stable digest over the active [!global] rule set.
//   - Persist the last-emitted digest in turn-state.json
//     (mandatory_globals_digest). turn-state survives UserPromptSubmit
//     (only injected_nodes is reset), so the field is naturally
//     session-scoped without needing a separate session-state file.
//   - First Bash/Read that triggers globals in the session → full emit,
//     persist digest. Subsequent calls with matching digest → suppress
//     globals entirely (no compact reminder; long turns lose to even a
//     50-token reminder fired 30+ times).
//   - Digest mismatch (cerebrum.md edited mid-session) → full re-emit.
//   - Compaction safety net: clearPendingRestore also clears the digest
//     so post-compact, the next emit is full.
//   - SEXTANT_GLOBALS_DEDUP=off disables — always full, restores
//     pre-fix behavior.
//
// [node:<path>] rules are NEVER deduped: they're per-file and value-dense.
// [kw:] rules are handled separately in lib/hooks/keywordDedup.mjs —
// critical ('*'-marked) fires emit every turn; general fires are windowed
// (once per N turns per rule). This module only governs the [!global] set.

import crypto from 'node:crypto';

const DIGEST_FIELD = 'mandatory_globals_digest';

// isGlobalRule(rule): true when the rule's buckets array contains the
// '!global' marker. Defensive — accepts any shape.
export function isGlobalRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  const buckets = Array.isArray(rule.buckets) ? rule.buckets : [];
  return buckets.includes('!global');
}

// partitionGlobals(rules): split into { globals, nonGlobals }. Preserves
// order within each partition. nonGlobals carries [!] [node:<path>] and
// [kw:] rules — anything not marked [!global].
export function partitionGlobals(rules) {
  const globals = [];
  const nonGlobals = [];
  if (!Array.isArray(rules)) return { globals, nonGlobals };
  for (const r of rules) {
    if (isGlobalRule(r)) globals.push(r);
    else nonGlobals.push(r);
  }
  return { globals, nonGlobals };
}

// digestGlobals(rules): stable 16-char sha1 over the sorted raw bodies of
// the [!global] entries. Sorted so two rules in different orders produce
// the same digest. Empty / no-globals → ''.
//
// We hash `raw` rather than `body` so edits that only touch the bucket
// prefix (e.g., adding [!review]) still register as a change.
export function digestGlobals(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return '';
  const raws = [];
  for (const r of rules) {
    if (!isGlobalRule(r)) continue;
    const raw = (r && typeof r.raw === 'string') ? r.raw : '';
    if (raw.length > 0) raws.push(raw);
  }
  if (raws.length === 0) return '';
  raws.sort();
  return crypto.createHash('sha1').update(raws.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

// globalsDedupDisabled(): env-var escape hatch. Truthy when the user has
// set SEXTANT_GLOBALS_DEDUP=off (or any of the obvious negatives). Falsy
// when unset or set to anything else.
export function globalsDedupDisabled() {
  const raw = process.env.SEXTANT_GLOBALS_DEDUP;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// shouldEmitFullGlobals(turnState, currentDigest): true when the agent
// has NOT yet seen this digest in the session (so we should emit full),
// false when the digest already matches (suppress).
//
// Treats unset / mismatched / malformed turn-state field as "emit full".
export function shouldEmitFullGlobals(turnState, currentDigest) {
  if (typeof currentDigest !== 'string' || currentDigest.length === 0) {
    // No globals at all → caller has nothing to emit; "full" is vacuously fine.
    return true;
  }
  if (!turnState || typeof turnState !== 'object') return true;
  const stored = turnState[DIGEST_FIELD];
  return typeof stored !== 'string' || stored !== currentDigest;
}

// digestField(): the key name used in turn-state.json. Exported so call
// sites and tests share a single string constant (avoids typo drift).
export const GLOBALS_DIGEST_FIELD = DIGEST_FIELD;

// cerebrum-v2 T5.6: the turn-state key holding lineHashes of node-scoped rules
// already surfaced on a Read THIS TURN. Node rules fire on every WRITE (100%)
// but a re-read of the same file within a turn is deduped against this set.
// Cleared each turn by UserPromptSubmit (same lifetime as injected_nodes).
// Shared constant so preToolUse + userPromptSubmit + tests never drift.
export const READ_NODES_SEEN_FIELD = 'cerebrum_read_nodes_seen';
