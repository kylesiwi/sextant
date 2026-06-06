// Tests for lib/state.mjs#withPathLock — the generic path-driven lock
// primitive used by stores/bugs.mjs and stores/stats.mjs.
//
// Coverage focus:
//   - round-trip on a fresh file
//   - default value applied when file is missing
//   - corrupt JSON falls back to defaultValue (same as withState)
//   - concurrent writers serialize (no lost updates)
//   - lockfile lives at <path>.lock
//   - lock-timeout returns null (and stderr complaint), matching withState

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { withPathLock } from '../lib/state.mjs';

function freshTmpDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-pathlock-' + crypto.randomUUID());
  fsSync.mkdirSync(d, { recursive: true });
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

test('withPathLock: round-trip writes mutator-returned value', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'data.json');
  const r = await withPathLock(file, () => ({ x: 1 }), { defaultValue: {} });
  assert.deepEqual(r, { x: 1 });

  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { x: 1 });
});

test('withPathLock: in-place mutation (mutator returns undefined) writes input', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'data.json');

  // Seed an initial value.
  await withPathLock(file, () => ({ count: 0 }), { defaultValue: {} });

  // Mutate in place; mutator returns undefined.
  const r = await withPathLock(file, (v) => { v.count += 5; }, { defaultValue: {} });
  assert.deepEqual(r, { count: 5 });

  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { count: 5 });
});

test('withPathLock: missing file → mutator receives defaultValue', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'missing.json');

  let observed;
  await withPathLock(file, (v) => {
    observed = v;
    return [];
  }, { defaultValue: [] });
  assert.deepEqual(observed, []);
});

test('withPathLock: defaultValue defaults to null when not provided', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'missing.json');

  let observed = 'sentinel';
  await withPathLock(file, (v) => {
    observed = v;
    return { written: true };
  });
  assert.equal(observed, null);
});

test('withPathLock: corrupt JSON → mutator receives defaultValue', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'data.json');
  await fs.writeFile(file, '{ not valid json', 'utf8');

  let observed;
  await withPathLock(file, (v) => {
    observed = v;
    return { recovered: true };
  }, { defaultValue: { recovered: false } });
  assert.deepEqual(observed, { recovered: false });

  // And it now contains valid recovered JSON.
  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { recovered: true });
});

test('withPathLock: concurrent writers serialize (no lost updates)', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'counter.json');

  // Seed.
  await withPathLock(file, () => ({ n: 0 }), { defaultValue: {} });

  // Spawn 10 concurrent increments. With lock-coordinated R-M-W the final
  // value is exactly 10. Without the lock, interleaved readers would each
  // see n=0 and write n=1, leaving final < 10.
  const N = 10;
  // A relatively long timeout so the spin loop has time to contend the lock
  // under load. The default 50ms is tight when N concurrent callers all
  // queue up on the same lockfile.
  const opts = { lockTimeoutMs: 5000, pollIntervalMs: 2, defaultValue: { n: 0 } };
  const tasks = [];
  for (let i = 0; i < N; i++) {
    tasks.push(withPathLock(file, (v) => { v.n += 1; }, opts));
  }
  const results = await Promise.all(tasks);
  // None of them should have timed out (null return).
  for (const r of results) {
    assert.notEqual(r, null, 'no writer should hit the lock timeout');
  }

  const back = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(back.n, N, `final counter should be ${N}, got ${back.n}`);
});

test('withPathLock: lockfile path is <file>.lock', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'something.json');

  // Pause inside the mutator long enough to observe the lockfile presence,
  // then release.
  let saw = false;
  await withPathLock(file, async () => {
    saw = fsSync.existsSync(`${file}.lock`);
    return { ok: true };
  }, { defaultValue: {} });
  assert.equal(saw, true, 'expected <file>.lock to exist while mutator runs');

  // And it's removed on completion.
  assert.equal(fsSync.existsSync(`${file}.lock`), false,
    'lockfile should be cleaned up after withPathLock returns');
});

test('withPathLock: returns null when lock is held past timeout', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'contested.json');
  const lockPath = `${file}.lock`;

  // Manually grab the lock so withPathLock can't acquire it.
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const fd = fsSync.openSync(lockPath, 'wx');
  t.after(() => {
    try { fsSync.closeSync(fd); } catch { /* already closed */ }
    try { fsSync.unlinkSync(lockPath); } catch { /* already gone */ }
  });

  const r = await withPathLock(
    file,
    () => { throw new Error('mutator should not run when lock is contested'); },
    { lockTimeoutMs: 20, pollIntervalMs: 5, defaultValue: {} },
  );
  assert.equal(r, null);
});

test('withPathLock: read errors other than ENOENT/SyntaxError throw out', async (t) => {
  const dir = freshTmpDir(t);
  // Pass a directory path instead of a file path — the read will fail with
  // EISDIR (not ENOENT, not SyntaxError), and withPathLock should rethrow.
  const file = dir; // dir IS the path; readFile(dir) → EISDIR

  await assert.rejects(
    async () => withPathLock(file, () => ({})),
    (err) => err.code === 'EISDIR',
  );
});

test('withPathLock: parent directory is created on first write', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'nested', 'deeper', 'data.json');
  await withPathLock(file, () => ({ ok: true }), { defaultValue: {} });
  const back = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(back, { ok: true });
});

test('withPathLock: custom parse/serialize hooks are used', async (t) => {
  const dir = freshTmpDir(t);
  const file = path.join(dir, 'pretty.json');

  // Pretty-print on serialize; default JSON.parse on read.
  await withPathLock(
    file,
    () => ({ a: 1, b: 2 }),
    {
      defaultValue: {},
      serialize: (v) => JSON.stringify(v, null, 2),
    },
  );
  const raw = await fs.readFile(file, 'utf8');
  // Pretty-printed body has newlines.
  assert.match(raw, /\n/);
  assert.deepEqual(JSON.parse(raw), { a: 1, b: 2 });
});
