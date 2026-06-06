// test/commit-snapshot.test.mjs — Phase 5 § 5.6 / § 5.9 unit tests.
//
// detectCommitCommand: positive/negative table.
// snapshotEdits: writes the expected file shape and content.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  detectCommitCommand,
  snapshotEdits,
  commitSnapshotPath,
  sanitizeTsForPath,
} from '../lib/capture/commit-snapshot.mjs';

async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-commit-snap-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

// --- detectCommitCommand positives -----------------------------------------

const POSITIVES = [
  'git commit',
  'git commit -m "msg"',
  'git commit --amend',
  'git commit -a -m "msg"',
  '  git commit',                          // leading whitespace
  'git commit --no-verify -m "msg"',
  "git commit -m 'msg with spaces'",
];

for (const cmd of POSITIVES) {
  test(`detectCommitCommand: positive — ${JSON.stringify(cmd)}`, () => {
    assert.equal(detectCommitCommand(cmd), true);
  });
}

// --- detectCommitCommand negatives -----------------------------------------

const NEGATIVES = [
  'git status',
  'git log',
  'git diff',
  'git diff HEAD',
  'git push',
  'git add .',
  'gitcommit',                              // typo, not a real command
  'echo git commit',                        // git commit appears, but not anchored
  'ls',
  '',
];

for (const cmd of NEGATIVES) {
  test(`detectCommitCommand: negative — ${JSON.stringify(cmd)}`, () => {
    assert.equal(detectCommitCommand(cmd), false);
  });
}

test('detectCommitCommand: non-string returns false', () => {
  assert.equal(detectCommitCommand(null), false);
  assert.equal(detectCommitCommand(undefined), false);
  assert.equal(detectCommitCommand(123), false);
});

// --- sanitizeTsForPath -----------------------------------------------------

test('sanitizeTsForPath: colons become dashes', () => {
  const out = sanitizeTsForPath('2026-05-10T14:33:00.123Z');
  assert.ok(!out.includes(':'), `expected no colons; got ${out}`);
  assert.equal(out, '2026-05-10T14-33-00.123Z');
});

test('sanitizeTsForPath: handles missing input', () => {
  const out = sanitizeTsForPath(undefined);
  assert.ok(typeof out === 'string' && out.length > 0);
  assert.ok(!out.includes(':'));
});

// --- snapshotEdits ---------------------------------------------------------

test('snapshotEdits: writes commits/<ts>.json with expected shape', async (t) => {
  const cwd = await freshCwd(t);
  const sid = 'snap-sid';
  const ts = '2026-05-10T14:33:00.123Z';
  const edits = [
    { path: 'src/a.ts', ts: '2026-05-10T14:30:00Z', kind: 'Edit' },
    { path: 'src/b.ts', ts: '2026-05-10T14:32:00Z', kind: 'Write' },
  ];

  const dst = await snapshotEdits(cwd, sid, ts, edits);

  // Path location.
  const expected = commitSnapshotPath(cwd, sid, ts);
  assert.equal(dst, expected);
  assert.match(dst, /\.sextant\/session\/snap-sid\/commits\/2026-05-10T14-33-00\.123Z\.json$/);

  // File content.
  const raw = await fs.readFile(dst, 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.ts, ts);
  assert.equal(obj.session_id, sid);
  assert.deepEqual(obj.edits, edits);
});

test('snapshotEdits: empty edits array still writes the file', async (t) => {
  const cwd = await freshCwd(t);
  const sid = 'snap-sid-empty';
  const dst = await snapshotEdits(cwd, sid, '2026-05-10T15:00:00Z', []);
  const obj = JSON.parse(await fs.readFile(dst, 'utf8'));
  assert.deepEqual(obj.edits, []);
});

test('snapshotEdits: missing ts defaults to current ISO time', async (t) => {
  const cwd = await freshCwd(t);
  const sid = 'snap-sid-default';
  const dst = await snapshotEdits(cwd, sid, '', [{ path: 'x.ts', ts: 'now', kind: 'Edit' }]);
  // The file path uses a sanitized ts; just confirm it landed somewhere valid.
  const obj = JSON.parse(await fs.readFile(dst, 'utf8'));
  assert.ok(!Number.isNaN(Date.parse(obj.ts)));
});

test('snapshotEdits: non-array edits coerce to []', async (t) => {
  const cwd = await freshCwd(t);
  const sid = 'snap-sid-coerce';
  const dst = await snapshotEdits(cwd, sid, '2026-05-10T16:00:00Z', null);
  const obj = JSON.parse(await fs.readFile(dst, 'utf8'));
  assert.deepEqual(obj.edits, []);
});
