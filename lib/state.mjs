// lib/state.mjs — coordinator for runtime/statusline-state.json (§ 6.5 + R9).
//
// Lock primitive: fs.openSync(lockfilePath, 'wx') — POSIX-atomic exclusive
// create. Chosen over mkdir because it's cheaper (no inode for a directory)
// and equally atomic on all platforms Node supports. A held lock = lockfile
// exists. A crashed hook may leak the lockfile; subsequent callers see it,
// hit the timeout, log to stderr, and continue. SessionStart's sweep (Phase 2)
// wipes the whole runtime dir to recover.
//
// All writes are atomic: write to <file>.tmp.<pid>.<rand>, then rename.
// Renames within the same filesystem are atomic on POSIX, so a reader can
// never observe a partial state file.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  statuslineStatePath,
  lockfilePath,
  ensureRuntimeDir,
} from './paths.mjs';

export function defaultState({ sessionId, abArm = 'A' } = {}) {
  return {
    version: 1,
    session_id: sessionId,
    ab_arm: abArm,
    reads: { total: 0, redundant_blocked: 0 },
    rules: {
      fires_this_turn: 0,
      mandatory_fires: 0,
      blocked: 0,
      deny_red: false,
    },
    bugs: { open: 0 },
    review_queue_depth: 0,
    auto_tag: { high_confidence: 0, low_confidence_review: 0 },
    graph: { state: 'idle', last_rebuild_ts: null, dirty_count: 0 },
    compaction: {
      last_snapshot_ts: null,
      last_restore_ts: null,
      compaction_n: 0,
    },
    stuck: { tool: null, file: null, count: 0 },
    // systemmessage_fired: TURN-scoped one-shot keys — cleared every Stop by
    // resetTurnAndSession (so a keyed message re-arms each turn).
    systemmessage_fired: {},
    // systemmessage_fired_session: SESSION-scoped one-shot keys — survives Stop,
    // fresh only on a new session (new sid → new state). For messages that
    // should appear at most once per session (e.g. a migration notice).
    systemmessage_fired_session: {},
    tranche: null,
    last_event: { tag: null, ts: null },
  };
}

export async function readState(sessionId, cwd) {
  const file = statuslineStatePath(sessionId, cwd);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState({ sessionId });
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    // Minimal sanity: must be an object with a version. Otherwise treat as
    // corrupt and reset. (We don't migrate v1 → v1, but future versions
    // should be handled here.)
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return defaultState({ sessionId });
    }
    return parsed;
  } catch {
    return defaultState({ sessionId });
  }
}

// Acquire the lock by creating the lockfile exclusively. Returns the fd on
// success; throws (other than EEXIST) on real errors. EEXIST means contended.
function tryAcquireLock(lockPath) {
  // Use fsSync.openSync because the open + EEXIST detection is a tight
  // primitive and avoids the cost of promisified rejection in the spin loop.
  try {
    const fd = fsSync.openSync(lockPath, 'wx');
    return fd;
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
}

async function acquireLockWithTimeout(lockPath, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  // Try once immediately.
  let fd = tryAcquireLock(lockPath);
  if (fd !== null) return fd;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    fd = tryAcquireLock(lockPath);
    if (fd !== null) return fd;
  }
  return null;
}

export async function withState(sessionId, cwd, mutator, opts = {}) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 50;
  const pollIntervalMs = opts.pollIntervalMs ?? 5;
  const abArm = opts.abArm ?? 'A';

  await ensureRuntimeDir(sessionId, cwd);
  const file = statuslineStatePath(sessionId, cwd);
  const lock = lockfilePath(sessionId, cwd);

  const fd = await acquireLockWithTimeout(lock, lockTimeoutMs, pollIntervalMs);
  if (fd === null) {
    process.stderr.write(`sextant: state-lock timeout sid=${sessionId}\n`);
    return null;
  }

  try {
    // Read current state (or default if missing/corrupt).
    let state;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      state = (parsed && typeof parsed === 'object' && parsed.version === 1)
        ? parsed
        : defaultState({ sessionId, abArm });
    } catch (err) {
      if (err.code === 'ENOENT') {
        state = defaultState({ sessionId, abArm });
      } else if (err instanceof SyntaxError) {
        state = defaultState({ sessionId, abArm });
      } else {
        throw err;
      }
    }

    // Apply mutation. Mutator may be sync or async.
    await mutator(state);

    // Atomic write: tmp + rename.
    const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8');
    await fs.rename(tmp, file);

    return state;
  } finally {
    // Release the lock no matter what. Close fd first, then unlink the file.
    try { fsSync.closeSync(fd); } catch { /* fd already closed */ }
    try { fsSync.unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * withPathLock(filePath, mutator, opts):
 *   Generic flock-coordinated read-modify-write for any JSON file. Sibling of
 *   withState() but path-driven instead of session-driven, so any store
 *   (bugs.json, stats.json, etc.) can serialize concurrent writers with the
 *   same lock primitive.
 *
 *   Lockfile path = <filePath>.lock. Same O_EXCL acquisition + timeout +
 *   atomic tmp+rename write as withState. Returns the final written value, or
 *   null on lock timeout (matches withState's "log + give up" semantics so
 *   callers don't need a different failure handler).
 *
 *   Behavior:
 *   - Reads current JSON (defaulting to opts.defaultValue ?? null on ENOENT
 *     or SyntaxError — corruption is treated the same as missing, on the
 *     theory that a half-written file is recoverable by overwriting).
 *   - Calls mutator(value); sync or async; may mutate in place or return a
 *     new value. If the return is undefined, the input is written; otherwise
 *     the returned value is written.
 *   - Writes via tmp + rename so readers never observe a partial file.
 *
 *   Read errors other than ENOENT / SyntaxError throw out — callers can
 *   distinguish "first write" from "disk full".
 *
 *   opts:
 *     lockTimeoutMs?: number = 50
 *     pollIntervalMs?: number = 5
 *     defaultValue?: any        = null
 *     parse?: (raw) => any       = JSON.parse
 *     serialize?: (value) => string = (v) => JSON.stringify(v)
 */
export async function withPathLock(filePath, mutator, opts = {}) {
  const lockTimeoutMs = opts.lockTimeoutMs ?? 50;
  const pollIntervalMs = opts.pollIntervalMs ?? 5;
  const defaultValue = 'defaultValue' in opts ? opts.defaultValue : null;
  const parse = typeof opts.parse === 'function' ? opts.parse : JSON.parse;
  const serialize = typeof opts.serialize === 'function'
    ? opts.serialize
    : (v) => JSON.stringify(v);

  // Make sure the parent dir exists so the lockfile can land.
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const lockPath = `${filePath}.lock`;
  const fd = await acquireLockWithTimeout(lockPath, lockTimeoutMs, pollIntervalMs);
  if (fd === null) {
    process.stderr.write(`sextant: path-lock timeout file=${filePath}\n`);
    return null;
  }

  try {
    // Read current value (or default on ENOENT / SyntaxError).
    let value;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      value = parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        value = defaultValue;
      } else {
        throw err;
      }
    }

    // Apply mutation. The mutator may return a new value or mutate in place.
    const mutated = await mutator(value);
    const finalValue = mutated === undefined ? value : mutated;

    // Atomic write: tmp + rename.
    const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    await fs.writeFile(tmp, serialize(finalValue), 'utf8');
    await fs.rename(tmp, filePath);

    return finalValue;
  } finally {
    try { fsSync.closeSync(fd); } catch { /* fd already closed */ }
    try { fsSync.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

// resetTurnAndSession: zero per-turn / per-session counters. Per § 6.5 field
// semantics, cumulative counters (reads.total, reads.redundant_blocked,
// bugs.open, etc.) are NOT reset here. Called from Stop / SessionEnd.
export function resetTurnAndSession(state) {
  state.rules.fires_this_turn = 0;
  state.rules.mandatory_fires = 0;
  state.rules.blocked = 0;
  state.rules.deny_red = false;
  // Turn-scoped suppression clears every Stop; session-scoped
  // (systemmessage_fired_session) deliberately survives, resetting only on a
  // new session.
  state.systemmessage_fired = {};
}
