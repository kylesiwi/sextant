// lib/hooks/fileChanged.mjs — FileChanged handler.
//
// Phase 0: log file_path. Phase 2b (§ 5.16) adds reconciliation of cerebrum
// hand-edits that bypass the auto-tag loop (e.g., the user opens
// .sextant/cerebrum/cerebrum.md in an external editor). The frozen v1 backups
// (regular.md/mandatory.md) are still watched so a hand-edit to them reconciles.
//
// Sextant vs. external: a Sextant-managed write (postToolUse → autoTagFile)
// always updates state.cerebrum_last_write_ts to the cerebrum file's mtimeMs
// immediately after writing. If FileChanged sees an mtime within ~2s of
// that recorded ts, it was us — skip. Anything else is external and gets
// the same auto-tagger pass that postToolUse runs.
//
// The systemMessage suppression key is `filechanged_<sha1(filepath)>_<turn_id>`
// per § 4.5.1, so the same hand-edited file in the same turn nudges once.

import path from 'node:path';
import fs from 'node:fs/promises';

import { withState } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { readJson } from '../io.mjs';
import { turnStatePath, lastProjectFileEditPath, durableFile, durableBase } from '../paths.mjs';
import { autoTagFile } from '../capture/auto-tag.mjs';
import { readCerebrumFile, listReviewQueue } from '../stores/cerebrum.mjs';
import { migrateRuleFires } from '../stores/stats.mjs';

// Window for "this was a Sextant write": cerebrum file mtime within
// SAME_WRITE_WINDOW_MS of state.cerebrum_last_write_ts → skip.
//
// 2000 ms is wide enough to swallow ordinary FileChanged delivery latency
// (typical fs watcher debounce is sub-second; the rename in writeCerebrumFile
// finalises mtime in microseconds), and tight enough that two distinct
// edits separated by a human-scale interval can never collide.
const SAME_WRITE_WINDOW_MS = 2000;

function isCerebrumFile(absFilePath, cwd) {
  if (!cwd || typeof absFilePath !== 'string') return null;
  // cerebrum-v2 (T3.5): cerebrum.md is the live store; regular/mandatory are
  // retired frozen backups, still recognized so hand-edits to them reconcile.
  for (const [name, kind] of [['cerebrum.md', 'cerebrum'], ['regular.md', 'regular'], ['mandatory.md', 'mandatory']]) {
    if (absFilePath === durableFile(cwd, path.join('cerebrum', name))) return kind;
  }
  return null;
}

async function reviewQueueDepth(cerebrumPath) {
  try {
    const parsed = await readCerebrumFile(cerebrumPath);
    return listReviewQueue(parsed).length;
  } catch {
    return 0;
  }
}

export default async function fileChanged(payload, ctx) {
  const sid = payload.session_id;
  const file = payload.file_path ?? null;
  await ctx.log({ ts: ctx.nowIso(), event: 'FileChanged', sid, file });

  if (typeof file !== 'string' || file.length === 0) return undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  if (!cwd) return undefined;

  const cerebrumKind = isCerebrumFile(file, cwd);
  if (cerebrumKind === null) return undefined;

  try {
    // Step 1: stat the file. If we can't, there's nothing to reconcile.
    let mtimeMs = null;
    try {
      const st = await fs.stat(file);
      mtimeMs = st.mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }

    // Step 2: was this our write? Read statusline state to find the last
    // recorded cerebrum write timestamp.
    const ours = await (async () => {
      const recordedTs = await readRecordedCerebrumTs(sid, cwd);
      if (recordedTs === null) return false;
      return Math.abs(mtimeMs - recordedTs) < SAME_WRITE_WINDOW_MS;
    })();

    if (ours) return undefined;

    // Step 3: run the auto-tagger on the externally modified file.
    const lastProjectFileEdit = await readJson(lastProjectFileEditPath(sid, cwd));
    const turnInfo = await readJson(turnStatePath(sid, cwd));
    const turnStartTs = (turnInfo && typeof turnInfo.started_at === 'string')
      ? turnInfo.started_at
      : ctx.nowIso();
    const today = new Date().toISOString().slice(0, 10);

    const result = await autoTagFile({
      filePath: file,
      lastProjectFileEdit,
      turnStartTs,
      today,
    });

    // Re-tagging a hand-edited line rehashes it; carry the rule's fire history
    // across so an already-fired rule doesn't orphan its counts.
    await migrateRuleFires(durableBase(cwd), result.rewrites);

    const totalReconciled = result.high + result.low;
    if (totalReconciled === 0) return undefined;

    // Track this write so the next FileChanged doesn't loop on our own
    // ripples. Capture the post-write mtime.
    let newMtimeMs = mtimeMs;
    try {
      const st2 = await fs.stat(file);
      newMtimeMs = st2.mtimeMs;
    } catch { /* ignore */ }

    const queueDepth = await reviewQueueDepth(file);

    await withState(sid, cwd, (state) => {
      state.hand_edits_reconciled = (state.hand_edits_reconciled ?? 0) + totalReconciled;
      state.auto_tag = state.auto_tag ?? { high_confidence: 0, low_confidence_review: 0 };
      state.auto_tag.high_confidence += result.high;
      state.auto_tag.low_confidence_review += result.low;
      state.review_queue_depth = queueDepth;
      state.cerebrum_last_write_ts = newMtimeMs;
    });

    // Routine reconcile notice — verbose-only (a quiet background capture, not
    // an alert). Emit after the lock releases (helper takes its own lock).
    return mergeSystemMessage(
      undefined,
      `reconciled ${totalReconciled} hand-edited lines in ${path.basename(file)}`,
      { category: 'rules', level: 'routine', sid, cwd },
    );
  } catch (err) {
    process.stderr.write(`sextant: fileChanged reconcile err=${err.message}\n`);
  }

  return undefined;
}

// Read the recorded cerebrum write timestamp without taking the state lock.
// statusline-state.json is JSON; we tolerate ENOENT / parse errors as "no
// record yet" → treat the change as external.
async function readRecordedCerebrumTs(sid, cwd) {
  const { statuslineStatePath } = await import('../paths.mjs');
  const obj = await readJson(statuslineStatePath(sid, cwd));
  if (obj && typeof obj.cerebrum_last_write_ts === 'number' && Number.isFinite(obj.cerebrum_last_write_ts)) {
    return obj.cerebrum_last_write_ts;
  }
  return null;
}
