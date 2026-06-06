// test/session-start-sweep.test.mjs — coverage for sweepStaleRuntimeDirs.
//
// The sweep is the documented recovery path for leaked O_EXCL lockfiles
// (see lib/state.mjs:7-8). These tests pin the safety contract:
//   - old sibling dirs go
//   - fresh + current dirs survive
//   - missing parent dir is a no-op (no throw)
//   - SEXTANT_SWEEP_AGE_HOURS=0.0001 (≈ 360ms) deletes recently-touched dirs
//
// We isolate the sweep from /tmp by setting SEXTANT_RUNTIME_BASE per test —
// the env override is documented in lib/paths.mjs:31-34 as test-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { sweepStaleRuntimeDirs } from '../lib/hooks/sessionStart.mjs';

function freshBase() {
  return path.join(os.tmpdir(), 'sextant-sweep-test-' + crypto.randomUUID());
}

async function makeDir(base, name, mtimeMs) {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  // Drop a marker file inside so we're sweeping non-empty dirs (the real
  // failure mode — empty dirs would lull us into a false sense of security
  // about whether { recursive: true } actually fires).
  await fs.writeFile(path.join(dir, 'marker'), 'x', 'utf8');
  if (typeof mtimeMs === 'number') {
    const t = new Date(mtimeMs);
    await fs.utimes(dir, t, t);
  }
  return dir;
}

async function dirExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

test('sweep: removes old sibling dirs, keeps fresh + current', async (t) => {
  const base = freshBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Capture/restore SEXTANT_RUNTIME_BASE for hermeticity.
  const prev = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = base;
  t.after(() => {
    if (prev === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prev;
  });

  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  const currentSid = 'current-session';
  await fs.mkdir(base, { recursive: true });

  // Three old (mtime far before the 24h cutoff).
  const old1 = await makeDir(base, 'sextant-old-1', now - 2 * oneDayMs);
  const old2 = await makeDir(base, 'sextant-old-2', now - 3 * oneDayMs);
  const old3 = await makeDir(base, 'sextant-old-3', now - 5 * oneDayMs);

  // One fresh (mtime ~1h ago, well under cutoff).
  const fresh = await makeDir(base, 'sextant-fresh', now - 60 * 60 * 1000);

  // The current session's dir — must survive even though we'll backdate it.
  const current = await makeDir(base, `sextant-${currentSid}`, now - 10 * oneDayMs);

  // A non-sextant sibling that happens to live in the same parent — must be
  // left alone (the prefix filter is the safety belt against nuking unrelated
  // tenants of XDG_RUNTIME_DIR).
  const foreign = await makeDir(base, 'other-tool-cache', now - 10 * oneDayMs);

  // A plain file in the parent dir — must be ignored entirely (not a directory).
  const strayFile = path.join(base, 'sextant-not-a-dir.txt');
  await fs.writeFile(strayFile, 'hi', 'utf8');

  await sweepStaleRuntimeDirs(currentSid);

  assert.equal(await dirExists(old1), false, 'old1 should be swept');
  assert.equal(await dirExists(old2), false, 'old2 should be swept');
  assert.equal(await dirExists(old3), false, 'old3 should be swept');
  assert.equal(await dirExists(fresh), true, 'fresh should survive');
  assert.equal(await dirExists(current), true, 'current must always survive');
  assert.equal(await dirExists(foreign), true, 'non-sextant sibling must survive');
  // Stray file is technically a file, sweep should leave it alone.
  assert.equal(await dirExists(strayFile), true, 'stray file should survive');
});

test('sweep: missing parent dir does not throw', async (t) => {
  const base = freshBase();
  // Note: we do NOT create `base`. That's the whole point.
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const prev = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = base;
  t.after(() => {
    if (prev === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prev;
  });

  // Must not throw; we just want a clean resolution.
  await sweepStaleRuntimeDirs('any-session');
  // Sanity: the parent was not magically created.
  assert.equal(await dirExists(base), false);
});

test('sweep: SEXTANT_SWEEP_AGE_HOURS=0.0001 deletes recently-touched dirs', async (t) => {
  const base = freshBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const prev = process.env.SEXTANT_RUNTIME_BASE;
  const prevAge = process.env.SEXTANT_SWEEP_AGE_HOURS;
  process.env.SEXTANT_RUNTIME_BASE = base;
  process.env.SEXTANT_SWEEP_AGE_HOURS = '0.0001'; // ~360ms cutoff
  t.after(() => {
    if (prev === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prev;
    if (prevAge === undefined) delete process.env.SEXTANT_SWEEP_AGE_HOURS;
    else process.env.SEXTANT_SWEEP_AGE_HOURS = prevAge;
  });

  await fs.mkdir(base, { recursive: true });

  // Create a sibling with mtime backdated by 1 second — well past 360ms.
  const oneSecondAgo = Date.now() - 1000;
  const recent = await makeDir(base, 'sextant-recent', oneSecondAgo);

  // And a "current" we must not touch.
  const current = await makeDir(base, 'sextant-curr', Date.now() - 1000);

  await sweepStaleRuntimeDirs('curr');

  assert.equal(await dirExists(recent), false, 'recent dir should be swept under tiny cutoff');
  assert.equal(await dirExists(current), true, 'current dir always survives, even past cutoff');
});
