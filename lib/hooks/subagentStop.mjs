// lib/hooks/subagentStop.mjs — SubagentStop handler.
//
// Phase 0: log only. No state changes — subagent lifecycle does not affect
// parent session statusline.
//
// cerebrum-v2 T5.5: lint cerebrum rules a subagent added, but NEVER block — a
// subagent can't easily amend its own work. We log format errors for
// observability; the parent Stop gate (which DOES block) and `cerebrum doctor`
// are the enforcers. (decision: log-for-doctor only on subagents.)

import { readState } from '../state.mjs';
import { collectRuleLint } from './cerebrumFormatGate.mjs';

export default async function subagentStop(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  await ctx.log({ ts: ctx.nowIso(), event: 'SubagentStop', sid });

  if (cwd) {
    try {
      let accepted = [];
      try {
        const st = await readState(sid, cwd);
        accepted = Array.isArray(st?.cerebrum_accepted_hashes) ? st.cerebrum_accepted_hashes : [];
      } catch { accepted = []; }
      const { failing } = await collectRuleLint(cwd, accepted);
      if (failing.length > 0) {
        process.stderr.write(`sextant: SubagentStop cerebrum-format — ${failing.length} new rule(s) with format errors (not blocking; parent Stop / doctor will surface)\n`);
      }
    } catch (err) {
      process.stderr.write(`sextant: subagentStop cerebrum-format err=${err.message}\n`);
    }
  }

  return undefined;
}
