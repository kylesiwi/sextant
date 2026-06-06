// lib/capture/edits.mjs — Phase 5 § 5.8 (1) runtime edit tracking.
//
// runtime/edits.json holds the in-flight list of project-file edits made
// in this session since the last commit boundary. Each entry is shaped
// { path, ts, kind } where `kind` is one of 'Edit' | 'Write' | 'MultiEdit'.
//
// Lifecycle:
//   - PostToolUse Edit / Write / MultiEdit on a project file → append.
//   - PostToolUse Bash on a successful `git commit` → snapshot + clear.
//   - Stop / SessionEnd: NOT cleared (compaction-friendly). Only commit
//     boundaries reset the tracking.
//
// Single-writer per file is assumed (the hook fires serially), so we do
// a simple read-modify-atomic-write here.

import fs from 'node:fs/promises';

import { readJson, writeJsonAtomic } from '../io.mjs';
import { editsPath } from '../paths.mjs';

const VALID_KINDS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * readEdits(sessionId): return the current edits array (or [] if missing).
 * Never throws; ENOENT / malformed JSON → [].
 */
export async function readEdits(sessionId, cwd) {
  const value = await readJson(editsPath(sessionId, cwd));
  if (!Array.isArray(value)) return [];
  return value;
}

/**
 * appendEdit(sessionId, { path, ts, kind }): push one entry into edits.json
 * and write atomically. No-op if `path` is missing or `kind` is not one of
 * Edit/Write/MultiEdit — Phase 5 § 5.8 (1)'s shape contract.
 */
export async function appendEdit(sessionId, entry, cwd) {
  if (!entry || typeof entry !== 'object') return;
  if (typeof entry.path !== 'string' || entry.path.length === 0) return;
  if (typeof entry.kind !== 'string' || !VALID_KINDS.has(entry.kind)) return;
  const ts = typeof entry.ts === 'string' && entry.ts.length > 0
    ? entry.ts
    : new Date().toISOString();
  const current = await readEdits(sessionId, cwd);
  current.push({ path: entry.path, ts, kind: entry.kind });
  await writeJsonAtomic(editsPath(sessionId, cwd), current);
}

/**
 * resetEdits(sessionId): truncate edits.json (write []). Atomic.
 *
 * NOTE: we deliberately write an empty array rather than unlinking so
 * the file's stat is fresh and concurrent readers never see ENOENT
 * between the unlink and a subsequent append.
 */
export async function resetEdits(sessionId, cwd) {
  await writeJsonAtomic(editsPath(sessionId, cwd), []);
}

/**
 * removeEditsFile(sessionId): hard delete the edits.json file (used by
 * tests + by SessionStart sweep). Not normally called by the hook code.
 */
export async function removeEditsFile(sessionId, cwd) {
  try {
    await fs.unlink(editsPath(sessionId, cwd));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
