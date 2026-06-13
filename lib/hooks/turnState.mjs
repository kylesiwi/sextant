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
