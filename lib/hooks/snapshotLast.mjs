// lib/hooks/snapshotLast.mjs — shared cross-session continuity snapshot.
//
// Produces .sextant/session/last.json (§ 7.7), the file SessionStart reads to
// render the "where we left off" line in its additionalContext block.
//
// Called by:
//   - lib/hooks/sessionEnd.mjs (BEFORE the resetTurnAndSession write — order
//     matters; resetTurnAndSession zeroes some of the fields we snapshot)
//   - lib/hooks/stop.mjs (end of every turn — gives a checkpoint even if the
//     session crashes before SessionEnd fires)
//
// Best-effort: any failure (read error, write error, missing turn-state) is
// logged to stderr and swallowed. The producing hook MUST still complete its
// primary duties (log + reset).

import fs from 'node:fs/promises';
import path from 'node:path';

import { readState } from '../state.mjs';
import { lastJsonPath, turnStatePath } from '../paths.mjs';
import { readJson, writeJsonAtomic } from '../io.mjs';
import { readTranches, activeTranche } from '../stores/tranches.mjs';

/**
 * Write the cross-session continuity snapshot for `sid` to .sextant/session/last.json.
 *
 * @param {string} sid     - session id
 * @param {string} cwd     - project root (durable base)
 * @param {string} nowIso  - ISO timestamp to stamp into `ended_at`
 * @returns {Promise<void>}
 */
export async function snapshotLast(sid, cwd, nowIso) {
  if (!cwd || typeof cwd !== 'string') {
    // Without a cwd we have nowhere to put the durable file. Quietly skip —
    // this happens when the payload lacks `cwd`, which is rare but possible.
    return;
  }
  try {
    const state = await readState(sid, cwd);

    // turn_id lives in the per-session runtime scratch (turn-state.json),
    // not the statusline state. Falls back to null if the file is missing
    // (e.g. a session that ends before any UserPromptSubmit fired).
    let turnId = null;
    try {
      const ts = await readJson(turnStatePath(sid, cwd));
      if (ts && typeof ts.turn_id === 'number') turnId = ts.turn_id;
    } catch {
      turnId = null;
    }

    let trancheSnapshot = null;
    try {
      const tState = await readTranches(cwd);
      const active = activeTranche(tState);
      if (active) {
        trancheSnapshot = {
          feature: tState.feature,
          active_id: active.id,
          status: active.status,
        };
      }
    } catch {}

    const payload = {
      session_id: sid,
      ended_at: nowIso,
      ab_arm: state?.ab_arm ?? null,
      turn_id: turnId,
      graph_state: state?.graph?.state ?? null,
      tranche: trancheSnapshot,
      stats_summary: {
        rules_fired_this_turn: state?.rules?.fires_this_turn ?? 0,
        mandatory_fires: state?.rules?.mandatory_fires ?? 0,
        reads_total: state?.reads?.total ?? 0,
        bugs_open: state?.bugs?.open ?? 0,
        review_queue_depth: state?.review_queue_depth ?? 0,
      },
    };

    const out = lastJsonPath(cwd);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await writeJsonAtomic(out, payload);
  } catch (err) {
    process.stderr.write(`sextant: last.json write error sid=${sid} err=${err.message}\n`);
  }
}
