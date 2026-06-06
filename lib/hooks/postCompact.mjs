// lib/hooks/postCompact.mjs — PostCompact handler.
//
// Per R7 / verified Claude Code docs: PostCompact does NOT support
// `additionalContext`. The allowed output keys are continue, stopReason,
// suppressOutput, systemMessage.
//
// Phase 2.5 (§ 5.15.a):
//   - Emit a routine systemMessage ("post-compact restoration ready …") via the
//     shared helper. Routine → visible only under `verbose` (lifecycle
//     reassurance, not an alert); no suppression key needed (routine is
//     quiet-suppressed and verbose bypasses keys, so a key would be inert).
//   - Do NOT emit additionalContext — verbatim docs forbid it for this hook.
//   - Update statusline-state.json#compaction.last_restore_ts.

import { withState } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';

export default async function postCompact(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const ts = ctx.nowIso();

  await ctx.log({ ts, event: 'PostCompact', sid });

  await withState(sid, cwd, (s) => {
    s.compaction.last_restore_ts = ts;
    s.last_event = { tag: 'PostCompact', ts, detail: 'compacted' };
  });

  // Emit AFTER the lock is released — mergeSystemMessage takes its own
  // withState lock and must never be called inside one (see its contract).
  return mergeSystemMessage(
    undefined,
    'post-compact restoration ready (resumes on next prompt)',
    { category: 'transition', level: 'routine', sid, cwd },
  );
}
