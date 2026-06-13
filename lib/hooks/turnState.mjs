// lib/hooks/turnState.mjs — the per-turn turn-state field registry.
//
// turn-state.json mixes two lifetimes:
//   - SESSION-lifetime fields (turn_id, started_at, kw_general_last_turn,
//     mandatory_globals_digest, pending_restore, outside_root_approved) persist
//     across turns by design — each has a consumer that breaks if reset early
//     (keywordDedup window math, the stop.mjs turn filter, session dedup, the
//     compaction drain, the T3 approval set).
//   - PER-TURN fields are cleared at the top of every UserPromptSubmit so each
//     turn starts with a fresh "have I already shown / bounced this" window.
//
// There is NO generic per-turn sweep: a field not named here stays
// session-lifetime by default. Before this registry existed, the per-turn
// reset was two hardcoded lines in userPromptSubmit.mjs, so a new per-turn
// field could silently be forgotten there and leak across turns — under-firing
// a safety rule for the rest of the session. PER_TURN_FIELDS makes adding a
// per-turn field a one-line append in ONE place.
//
// Contract — ABSENT == EMPTY. resetPerTurnFields sets each field to its empty
// value ({} / []), but the compaction path (restore.mjs clearPendingRestore)
// `delete`s some of these instead. Readers MUST therefore treat an absent field
// and an empty field identically, e.g. `(ts.fired_full_this_turn || {})[hash]`
// — never assume the field exists.
//
// The registry is an opt-in ALLOWLIST keyed to each field's empty value, so it
// can only ever touch the four fields below and physically cannot clobber a
// session-lifetime field.

// Field name → its "empty" value. Add a per-turn field here (one line) and it
// is cleared every turn automatically.
export const PER_TURN_FIELDS = {
  // Phase 6 / cerebrum-v2 T5.6 (pre-existing per-turn fields):
  injected_nodes: [],            // node ids whose wallpaper was injected this turn
  cerebrum_read_nodes_seen: [],  // lineHashes of node rules shown on a Read this turn
  // lean-interventions additions:
  bash_bounced: [],              // T2: command-hashes already deny-bounced this turn
  fired_full_this_turn: {},      // T5: lineHash → true for rules whose FULL body fired this turn
};

// resetPerTurnFields(o): mutate the turn-state object in place, clearing every
// registered per-turn field to a FRESH copy of its empty value. Returns `o`.
// Used by userPromptSubmit (turn boundary). A fresh copy per call avoids two
// turns sharing the same array/object reference.
export function resetPerTurnFields(o) {
  if (!o || typeof o !== 'object') return o;
  for (const [field, empty] of Object.entries(PER_TURN_FIELDS)) {
    o[field] = Array.isArray(empty) ? [] : {};
  }
  return o;
}

// ── T5: per-turn fire dedup ────────────────────────────────────────────────
//
// The first fire of a rule in a turn renders its full body; later same-turn
// fires of the SAME rule collapse to a short stub that still carries the rule's
// text (so it is self-sufficient — never a dangling bare reference). State lives
// in turn-state.json#fired_full_this_turn (lineHash → true), a registered
// per-turn field (cleared each UserPromptSubmit AND on compaction). The map is
// only ever READ to decide full-vs-stub and recorded AFTER a full body emits, so
// a lost update re-emits full (over-emit, safe) and never stubs an unshown rule.

import { lineHash } from '../stores/cerebrum.mjs';

export const FIRED_FULL_FIELD = 'fired_full_this_turn';

// Truncation for a non-loud rule's stub body. Loud rules (below) carry the full
// body untruncated, so this never clips a [!]/critical rule.
const STUB_TRUNC = 120;

// turnDedupDisabled(): env escape hatch mirroring keywordDedupDisabled() /
// globalsDedupDisabled(). When off, every fire renders full every time.
export function turnDedupDisabled() {
  const raw = process.env.SEXTANT_TURN_DEDUP;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// isLoudRule(rule): a [!]-importance rule (bucket '!') or a critical-keyword
// rule ([kw:*…]). These surface their full text 100% (charter anchor #6), so a
// stub of a loud rule carries the WHOLE body — it still drops the per-block
// boilerplate, but never truncates the rule itself.
export function isLoudRule(rule) {
  const buckets = Array.isArray(rule && rule.buckets) ? rule.buckets : [];
  for (const b of buckets) {
    if (b === '!') return true;
    if (typeof b === 'string' && b.startsWith('kw:') && b.includes('*')) return true;
  }
  return false;
}

// stubBody(rule): the text a stub line carries — full for loud rules, else
// truncated to STUB_TRUNC so the stub stays actionable without the original
// (anchor #4 / R7 — a bare hash would dangle after the full body scrolls off).
export function stubBody(rule) {
  const body = (rule && typeof rule.body === 'string' && rule.body)
    ? rule.body
    : (rule && typeof rule.raw === 'string' ? rule.raw : '');
  const t = body.trim();
  if (isLoudRule(rule) || t.length <= STUB_TRUNC) return t;
  return `${t.slice(0, STUB_TRUNC)}…`;
}

// partitionFiredFull(rules, seenMap): PURE. Split rules into `fresh` (full body
// not yet shown this turn → render full + record) and `stubbed` (already shown
// → collapse to a stub line). `seenMap` is fired_full_this_turn (lineHash →
// true), treated READ-ONLY. Returns `freshHashes` so the caller persists them
// and can thread them into a sibling block's partition within the same call (a
// rule shared by both the node and keyword block emits full once, not twice).
// turnDedupDisabled → everything fresh (full-every-time). A same-list duplicate
// of a fresh rule is dropped (already shown full just above).
export function partitionFiredFull(rules, seenMap) {
  const list = Array.isArray(rules) ? rules : [];
  if (turnDedupDisabled()) return { fresh: list.slice(), stubbed: [], freshHashes: [] };
  const seen = (seenMap && typeof seenMap === 'object') ? seenMap : {};
  const fresh = [];
  const stubbed = [];
  const freshHashes = [];
  for (const r of list) {
    const raw = (r && typeof r.raw === 'string')
      ? r.raw
      : (r && typeof r.body === 'string' ? r.body : '');
    const h = lineHash(raw);
    if (seen[h]) {
      stubbed.push(r);
    } else if (freshHashes.includes(h)) {
      // same rule appears twice in this list — already emitted full above; drop.
    } else {
      fresh.push(r);
      freshHashes.push(h);
    }
  }
  return { fresh, stubbed, freshHashes };
}
