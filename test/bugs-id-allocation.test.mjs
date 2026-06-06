// Tests for the fixed `bug-N` id-allocation in lib/stores/bugs.mjs#addBug.
//
// The old implementation used `bug-${bugs.length + 1}` which reused ids
// after a `/sextant:forget` (or any writeBugs that shrank the array) — a
// later addBug would collide with the deleted entry's old id, silently
// pointing old transcript references at a different bug. The fix is to
// compute `max(existing numeric ids) + 1` so an id is never reused within
// the lifetime of bugs.json. These tests pin that invariant.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { addBug, readBugs, writeBugs, BUGS_FILE } from '../lib/stores/bugs.mjs';

function freshTmpDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-bugid-' + crypto.randomUUID());
  fsSync.mkdirSync(d, { recursive: true });
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

function makeEntry(overrides = {}) {
  return {
    ts: '2026-05-10T14:33:00Z',
    session_id: 'sess-1',
    file: 'src/x.ts',
    error_message: 'oops',
    root_cause: 'because',
    fix: 'patched',
    fix_verified: false,
    verified_ts: null,
    verified_by: null,
    tags: [],
    ...overrides,
  };
}

// ---- baseline ordering ----------------------------------------------------

test('addBug: sequential calls produce bug-1, bug-2, bug-3', async (t) => {
  const dir = freshTmpDir(t);
  const a = await addBug(dir, makeEntry({ error_message: 'a' }));
  const b = await addBug(dir, makeEntry({ error_message: 'b' }));
  const c = await addBug(dir, makeEntry({ error_message: 'c' }));
  assert.equal(a.id, 'bug-1');
  assert.equal(b.id, 'bug-2');
  assert.equal(c.id, 'bug-3');
});

test('addBug: empty array → first bug is bug-1', async (t) => {
  const dir = freshTmpDir(t);
  await writeBugs(dir, []);
  const r = await addBug(dir, makeEntry());
  assert.equal(r.id, 'bug-1');
});

test('addBug: no file at all → first bug is bug-1', async (t) => {
  const dir = freshTmpDir(t);
  // No writeBugs call; the file doesn't exist yet. defaultValue=[] kicks in.
  const r = await addBug(dir, makeEntry());
  assert.equal(r.id, 'bug-1');
});

// ---- the headline regression test ----------------------------------------

test('addBug: deleting bug-2 from the middle does NOT cause id reuse', async (t) => {
  const dir = freshTmpDir(t);

  const a = await addBug(dir, makeEntry({ error_message: 'a' }));
  const b = await addBug(dir, makeEntry({ error_message: 'b' }));
  const c = await addBug(dir, makeEntry({ error_message: 'c' }));
  assert.deepEqual([a.id, b.id, c.id], ['bug-1', 'bug-2', 'bug-3']);

  // Simulate /sextant:forget removing bug-2 from the array.
  const remaining = (await readBugs(dir)).filter((x) => x.id !== 'bug-2');
  await writeBugs(dir, remaining);

  // OLD BUG: with bugs.length=2, next allocation was 'bug-3' — colliding
  // with the still-extant c.id.
  // NEW CONTRACT: max(remaining) + 1 = max(1, 3) + 1 = 4.
  const d = await addBug(dir, makeEntry({ error_message: 'd' }));
  assert.equal(d.id, 'bug-4', 'must not reuse the deleted id "bug-2"');
  assert.notEqual(d.id, 'bug-3', 'must not collide with surviving bug-3');

  const all = await readBugs(dir);
  const ids = all.map((x) => x.id).sort();
  assert.deepEqual(ids, ['bug-1', 'bug-3', 'bug-4']);
});

test('addBug: deleting the tail re-uses the slot (max+1 over CURRENT array)', async (t) => {
  // Allocation is `max(existing numeric ids in the array) + 1`. With the
  // tail removed, max=2, so the next id is bug-3 — reusing the deleted
  // slot. This is a known constraint of the array-only schema: a stronger
  // never-reuse invariant would require a persisted watermark (out of
  // scope for this fix). The headline regression — deletes in the MIDDLE
  // not clobbering surviving tail ids — is what's actually fixed.
  const dir = freshTmpDir(t);
  await addBug(dir, makeEntry()); // bug-1
  await addBug(dir, makeEntry()); // bug-2
  await addBug(dir, makeEntry()); // bug-3

  const trimmed = (await readBugs(dir)).filter((x) => x.id !== 'bug-3');
  await writeBugs(dir, trimmed);

  const r = await addBug(dir, makeEntry());
  assert.equal(r.id, 'bug-3');
  // And critically, it does NOT collide with bug-1 or bug-2 still present.
  const ids = (await readBugs(dir)).map((x) => x.id).sort();
  assert.deepEqual(ids, ['bug-1', 'bug-2', 'bug-3']);
});

// ---- non-conforming ids: skipped in max, preserved in array --------------

test('addBug: non-conforming ids are preserved + skipped in max calculation', async (t) => {
  const dir = freshTmpDir(t);
  // Seed with a mixed-id array: import-bridge style ids alongside numeric.
  const seed = [
    { ...makeEntry({ error_message: 'imported' }), id: 'imported-XYZ' },
    { ...makeEntry({ error_message: 'one' }), id: 'bug-1' },
    { ...makeEntry({ error_message: 'two' }), id: 'bug-2' },
    { ...makeEntry({ error_message: 'weird' }), id: 'not-a-bug-id' },
  ];
  await writeBugs(dir, seed);

  const next = await addBug(dir, makeEntry({ error_message: 'three' }));
  assert.equal(next.id, 'bug-3', 'max(bug-N) = 2 → next is bug-3');

  // Original non-conforming entries survive.
  const all = await readBugs(dir);
  const ids = all.map((x) => x.id);
  assert.ok(ids.includes('imported-XYZ'),
    'non-conforming id "imported-XYZ" should still be present');
  assert.ok(ids.includes('not-a-bug-id'),
    'non-conforming id "not-a-bug-id" should still be present');
  assert.equal(all.length, 5);
});

test('addBug: bug entries with non-string id are tolerated', async (t) => {
  const dir = freshTmpDir(t);
  // Defensive: someone wrote a malformed entry with id: 42 (numeric).
  const seed = [
    { ...makeEntry({ error_message: 'malformed' }), id: 42 },
    { ...makeEntry({ error_message: 'normal' }), id: 'bug-7' },
  ];
  await writeBugs(dir, seed);

  const r = await addBug(dir, makeEntry({ error_message: 'fresh' }));
  assert.equal(r.id, 'bug-8', 'max of valid ids = 7 → next is bug-8');
});

test('addBug: array of only non-conforming ids → next is bug-1', async (t) => {
  const dir = freshTmpDir(t);
  const seed = [
    { ...makeEntry(), id: 'imported-A' },
    { ...makeEntry(), id: 'imported-B' },
  ];
  await writeBugs(dir, seed);

  const r = await addBug(dir, makeEntry());
  // No matching bug-N id → max=0 → next=bug-1.
  assert.equal(r.id, 'bug-1');
});

// ---- concurrent addBug --------------------------------------------------

test('addBug: 20 concurrent calls produce 20 unique bug-N ids', async (t) => {
  const dir = freshTmpDir(t);

  // Promise.all 20 addBug calls. With lock-coordinated R-M-W under
  // withPathLock, each one sees the previous writers' ids and allocates the
  // next slot. Without the lock, several would all see N items and clobber
  // each other on the next bug-(N+1) write.
  const N = 20;
  const tasks = [];
  for (let i = 0; i < N; i++) {
    tasks.push(addBug(dir, makeEntry({ error_message: `m${i}` })));
  }
  const results = await Promise.all(tasks);

  const ids = results.map((r) => r.id).sort((a, b) => {
    return parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10);
  });
  const expected = [];
  for (let i = 1; i <= N; i++) expected.push(`bug-${i}`);
  assert.deepEqual(ids, expected,
    'every concurrent addBug should get a unique sequential bug-N id');

  // And the on-disk array also contains all 20 entries.
  const persisted = await readBugs(dir);
  assert.equal(persisted.length, N);
  const persistedIds = persisted.map((x) => x.id).sort((a, b) => {
    return parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10);
  });
  assert.deepEqual(persistedIds, expected);
});

// ---- file shape sanity (the bug file should still parse as an array) ----

test('addBug: on-disk file remains a JSON array after many writes', async (t) => {
  const dir = freshTmpDir(t);
  await addBug(dir, makeEntry());
  await addBug(dir, makeEntry());
  await addBug(dir, makeEntry());

  const file = path.join(dir, BUGS_FILE);
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 3);
});
