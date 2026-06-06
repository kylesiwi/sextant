// lib/hooks/sessionEnd.mjs — SessionEnd handler.
//
// Phase 0: log + reset turn/session-scoped counters. Cumulative counters
// (reads.total, bugs.open, etc.) are preserved per § 6.5 field semantics.
//
// Cross-session continuity (§ 7.7): BEFORE the reset, snapshot the runtime
// state to .sextant/session/last.json so the next SessionStart can render a
// "where we left off" line. Order matters — resetTurnAndSession zeroes some
// of the very fields we're capturing.

import { withState, resetTurnAndSession } from '../state.mjs';
import { snapshotLast } from './snapshotLast.mjs';

export default async function sessionEnd(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  await ctx.log({ ts: ctx.nowIso(), event: 'SessionEnd', sid });

  // Snapshot BEFORE the reset so fires_this_turn / mandatory_fires reflect
  // the actual final-turn activity rather than zeros.
  await snapshotLast(sid, cwd, ctx.nowIso());

  await withState(sid, cwd, (state) => {
    resetTurnAndSession(state);
    state.last_event = { tag: 'SessionEnd', ts: ctx.nowIso(), detail: 'idle' };
  });

  return undefined;
}
