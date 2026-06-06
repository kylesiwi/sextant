// lib/capture/commit-snapshot.mjs — Phase 5 § 5.6 / § 5.9 commit helpers.
//
// detectCommitCommand(cmdStr): true if `cmdStr` is a `git commit`
// invocation. Anchored to allow leading whitespace; rejects read-only git
// commands (status, log, diff, ...).
//
// snapshotEdits(durableBase, sessionId, ts, edits): write the in-flight
// edits array to .sextant/session/<sessionId>/commits/<ts>.json, where
// `<ts>` is the ISO timestamp with colons sanitized so we don't trip on
// Windows-backed mounts (drvfs / NTFS forbid ':' in paths).

import path from 'node:path';

import { writeJsonAtomic } from '../io.mjs';
import { durableBase as durableBaseFromCwd } from '../paths.mjs';

const COMMIT_RE = /^\s*git\s+commit\b/;

/**
 * detectCommitCommand(cmdStr): true if cmdStr looks like a `git commit`
 * invocation. We intentionally accept variations like `git commit -m "..."`,
 * `git commit --amend`, etc.; the matcher only needs to find the literal
 * `git commit` token at the start (with optional whitespace).
 *
 * NOTE: matches `git commit` only — NOT `git status`, `git log`, etc.
 */
export function detectCommitCommand(cmdStr) {
  if (typeof cmdStr !== 'string' || cmdStr.length === 0) return false;
  return COMMIT_RE.test(cmdStr);
}

/**
 * sanitizeTsForPath(ts): turn an ISO timestamp into something safe to use
 * as a filename component on Windows-backed filesystems. Colons → dashes;
 * other unsafe chars → underscores. Idempotent for already-clean inputs.
 */
export function sanitizeTsForPath(ts) {
  if (typeof ts !== 'string' || ts.length === 0) {
    return new Date().toISOString().replace(/:/g, '-').replace(/[^0-9A-Za-z._-]/g, '_');
  }
  return ts.replace(/:/g, '-').replace(/[^0-9A-Za-z._-]/g, '_');
}

/**
 * commitsDir(cwd, sessionId): the directory holding per-commit snapshots
 * for one session. Lives under .sextant/session/<sid>/commits/.
 */
export function commitsDir(cwd, sessionId) {
  return path.join(durableBaseFromCwd(cwd), 'session', sessionId, 'commits');
}

/**
 * commitSnapshotPath(cwd, sessionId, ts): the absolute path to the JSON
 * snapshot for one commit. `<ts>` is sanitized for filesystem safety.
 */
export function commitSnapshotPath(cwd, sessionId, ts) {
  return path.join(commitsDir(cwd, sessionId), `${sanitizeTsForPath(ts)}.json`);
}

/**
 * snapshotEdits(cwd, sessionId, ts, edits): atomic write of the edits array
 * to commits/<ts>.json. Returns the absolute path written.
 *
 * Contents: { ts, session_id, edits: [...] } where edits is whatever the
 * caller passed in. Phase 5 wires this from runtime/edits.json, but the
 * function itself is agnostic to where the edits came from.
 */
export async function snapshotEdits(cwd, sessionId, ts, edits) {
  const out = {
    ts: typeof ts === 'string' && ts.length > 0 ? ts : new Date().toISOString(),
    session_id: sessionId,
    edits: Array.isArray(edits) ? edits : [],
  };
  const dst = commitSnapshotPath(cwd, sessionId, out.ts);
  await writeJsonAtomic(dst, out);
  return dst;
}
