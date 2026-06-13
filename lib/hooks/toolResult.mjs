// lib/hooks/toolResult.mjs — best-effort PostToolUse execution classifier.
//
// PostToolUse infers whether a tool actually executed/succeeded from
// `payload.tool_response.is_error`, but the schema of tool_response varies per
// tool — so the genuine third state ("we can't tell") must be surfaced, not
// collapsed into a boolean.
//
// classifyToolResult(payload) → 'success' | 'error' | 'unknown'
//   - 'success' : tool_response is an object with is_error === false (or a
//                 falsy is_error).
//   - 'error'   : tool_response is an object with a truthy is_error.
//   - 'unknown' : tool_response absent / null / non-object / no is_error key.
//
// Why tri-state and not a boolean: two callers have OPPOSITE safe directions on
// 'unknown', so no single default is safe for both —
//   - T3 (outside-root approval set): record an approval ONLY on 'success';
//     'unknown'/'error' → don't approve (the next write re-asks). Fail toward
//     re-ask on doubt.
//   - T4 (amend freeze-unlock budget): decrement on 'success' OR 'unknown'
//     (fail toward re-freeze); skip ONLY on a confirmed 'error' so a known-
//     failed edit never burns budget. Fail toward re-freeze on doubt.
// Each caller owns its 'unknown' policy; this module just reports honestly.

export function classifyToolResult(payload) {
  const tr = payload ? payload.tool_response : null;
  if (tr && typeof tr === 'object' && 'is_error' in tr) {
    return tr.is_error ? 'error' : 'success';
  }
  return 'unknown';
}

// toolExecutedOk(payload): boolean convenience preserving the LEGACY
// postToolUse semantics exactly — `ok` was true unless tool_response carried a
// truthy is_error (so 'unknown' counted as ok). Equivalent to
// classifyToolResult(payload) !== 'error'. Provided so the existing post-hook
// branches (auto-tag, capture tracking) keep their current behavior verbatim
// while routing through the one classifier.
export function toolExecutedOk(payload) {
  return classifyToolResult(payload) !== 'error';
}
