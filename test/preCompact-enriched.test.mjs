// test/preCompact-enriched.test.mjs — Phase 9 enrichment.
//
// PreCompact now bundles three additional sections into precompact.json:
// files (from runtime/edits.json), bugs (from .sextant/bugs.json), and
// commits (from .sextant/session/<sid>/commits/*.json). Each runs
// independently and best-effort; failures degrade to an empty array.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  runtimeBase,
  durableBase,
  hooksLogPath,
  runtimeFile,
  editsPath,
} from '../lib/paths.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import preCompact from '../lib/hooks/preCompact.mjs';
import { writeJsonAtomic } from '../lib/io.mjs';
import { commitsDir } from '../lib/capture/commit-snapshot.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-test-' + crypto.randomUUID());
}

function withEnv(t, overrides) {
  const before = {};
  for (const [k, v] of Object.entries(overrides)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function setupEnv(t) {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function makeCtx(sid, eventName) {
  return {
    eventName,
    runtimeBase,
    durableBase,
    // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

// -- files section ---------------------------------------------------------

test('preCompact files: reads edits.json, dedups paths, caps at 5 newest-first', async (t) => {
  await setupEnv(t);
  const sid = 'pc-files';
  const cwd = await freshProjectCwd(t);

  // 7 edits: 4 unique paths repeated; expect 5-cap with newest first by ts.
  // Construct so deduplication takes the LATEST occurrence (newest ts) for
  // each repeat path.
  await writeJsonAtomic(editsPath(sid), [
    { path: 'src/a.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' },
    { path: 'src/b.ts', ts: '2026-05-11T10:01:00Z', kind: 'Write' },
    { path: 'src/c.ts', ts: '2026-05-11T10:02:00Z', kind: 'Edit' },
    { path: 'src/d.ts', ts: '2026-05-11T10:03:00Z', kind: 'MultiEdit' },
    { path: 'src/e.ts', ts: '2026-05-11T10:04:00Z', kind: 'Edit' },
    { path: 'src/a.ts', ts: '2026-05-11T10:05:00Z', kind: 'Edit' }, // dup
    { path: 'src/f.ts', ts: '2026-05-11T10:06:00Z', kind: 'Edit' },
  ]);

  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.files.length, 5, 'capped at 5 unique paths');
  // Newest-first order (matching unique-newest-first dedup). a.ts at index 1
  // because dup of a is the newest after f.
  const paths = pc.payload.files.map((f) => f.path);
  assert.deepEqual(paths, ['src/f.ts', 'src/a.ts', 'src/e.ts', 'src/d.ts', 'src/c.ts']);
  // Each entry preserves path/ts/kind.
  for (const f of pc.payload.files) {
    assert.equal(typeof f.path, 'string');
    assert.equal(typeof f.ts, 'string');
    assert.equal(typeof f.kind, 'string');
  }
});

test('preCompact files: missing edits.json → empty files array', async (t) => {
  await setupEnv(t);
  const sid = 'pc-files-empty';
  const cwd = await freshProjectCwd(t);
  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.deepEqual(pc.payload.files, []);
});

// -- bugs section ---------------------------------------------------------

test('preCompact bugs: filters to this-session !fix_verified', async (t) => {
  await setupEnv(t);
  const sid = 'pc-bugs';
  const cwd = await freshProjectCwd(t);

  // 3 bugs: 1 verified (same session) + 2 unfixed (one this session, one
  // another session). Expect only 1 entry in payload.bugs.
  await fs.mkdir(durableBase(cwd), { recursive: true });
  await writeJsonAtomic(path.join(durableBase(cwd), 'bugs.json'), [
    {
      id: 'bug-1',
      ts: '2026-05-11T10:00:00Z',
      session_id: sid,
      file: 'src/auth.ts',
      error_message: 'TypeError: undefined',
      fix_verified: false,
    },
    {
      id: 'bug-2',
      ts: '2026-05-11T10:01:00Z',
      session_id: sid,
      file: 'src/util.ts',
      error_message: 'fixed earlier',
      fix_verified: true, // verified
      verified_ts: '2026-05-11T10:02:00Z',
    },
    {
      id: 'bug-3',
      ts: '2026-05-11T10:03:00Z',
      session_id: 'other-session',
      file: 'src/x.ts',
      error_message: 'not my session',
      fix_verified: false,
    },
  ]);

  // Add a second unfixed bug for this session.
  await writeJsonAtomic(path.join(durableBase(cwd), 'bugs.json'), [
    {
      id: 'bug-1',
      ts: '2026-05-11T10:00:00Z',
      session_id: sid,
      file: 'src/auth.ts',
      error_message: 'TypeError: undefined',
      fix_verified: false,
    },
    {
      id: 'bug-2',
      ts: '2026-05-11T10:01:00Z',
      session_id: sid,
      file: 'src/util.ts',
      error_message: 'fixed earlier',
      fix_verified: true,
      verified_ts: '2026-05-11T10:02:00Z',
    },
    {
      id: 'bug-3',
      ts: '2026-05-11T10:03:00Z',
      session_id: 'other-session',
      file: 'src/x.ts',
      error_message: 'not my session',
      fix_verified: false,
    },
    {
      id: 'bug-4',
      ts: '2026-05-11T10:04:00Z',
      session_id: sid,
      file: 'src/api.ts',
      error_message: 'second open bug',
      fix_verified: false,
    },
  ]);

  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.bugs.length, 2, 'two open bugs for this session');
  const ids = pc.payload.bugs.map((b) => b.id);
  assert.deepEqual(ids.sort(), ['bug-1', 'bug-4']);
});

test('preCompact bugs: missing bugs.json → empty bugs array', async (t) => {
  await setupEnv(t);
  const sid = 'pc-bugs-empty';
  const cwd = await freshProjectCwd(t);
  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.deepEqual(pc.payload.bugs, []);
});

// -- commits section ------------------------------------------------------

test('preCompact commits: reads 3 newest by mtime + summarises', async (t) => {
  await setupEnv(t);
  const sid = 'pc-commits';
  const cwd = await freshProjectCwd(t);

  const dir = commitsDir(cwd, sid);
  await fs.mkdir(dir, { recursive: true });

  // Write 5 commit snapshots; we expect only the 3 most-recent by mtime.
  // Use synthetic edit arrays so file_paths counts are predictable.
  async function snapshot(name, ts, edits) {
    await writeJsonAtomic(path.join(dir, `${name}.json`), { ts, session_id: sid, edits });
    // Tiny pause so mtimes differ enough on faster filesystems.
    await new Promise((r) => setTimeout(r, 10));
  }
  await snapshot('c1', '2026-05-11T10:00:00Z', [
    { path: 'src/a.ts', ts: 't1', kind: 'Edit' },
  ]);
  await snapshot('c2', '2026-05-11T10:01:00Z', [
    { path: 'src/b.ts', ts: 't2', kind: 'Write' },
    { path: 'src/b.ts', ts: 't3', kind: 'Edit' }, // dup path; counts as 1 file
  ]);
  await snapshot('c3', '2026-05-11T10:02:00Z', [
    { path: 'src/a.ts', ts: 't4', kind: 'Edit' },
    { path: 'src/c.ts', ts: 't5', kind: 'Edit' },
    { path: 'src/d.ts', ts: 't6', kind: 'Edit' },
  ]);
  await snapshot('c4', '2026-05-11T10:03:00Z', [
    { path: 'src/e.ts', ts: 't7', kind: 'Edit' },
  ]);
  await snapshot('c5', '2026-05-11T10:04:00Z', [
    { path: 'src/f.ts', ts: 't8', kind: 'Edit' },
    { path: 'src/g.ts', ts: 't9', kind: 'Edit' },
  ]);

  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.commits.length, 3, '3 most-recent commits');

  // Newest first. c5/c4/c3.
  const tsValues = pc.payload.commits.map((c) => c.ts);
  assert.deepEqual(tsValues, ['2026-05-11T10:04:00Z', '2026-05-11T10:03:00Z', '2026-05-11T10:02:00Z']);

  // edit_count + unique file_paths.
  assert.equal(pc.payload.commits[0].edit_count, 2);
  assert.deepEqual(pc.payload.commits[0].file_paths, ['src/f.ts', 'src/g.ts']);

  assert.equal(pc.payload.commits[1].edit_count, 1);
  assert.deepEqual(pc.payload.commits[1].file_paths, ['src/e.ts']);

  // c3 had 3 unique edits.
  assert.equal(pc.payload.commits[2].edit_count, 3);
  assert.deepEqual(pc.payload.commits[2].file_paths, ['src/a.ts', 'src/c.ts', 'src/d.ts']);
});

test('preCompact commits: file_paths capped at 5 unique paths', async (t) => {
  await setupEnv(t);
  const sid = 'pc-commits-cap';
  const cwd = await freshProjectCwd(t);

  const dir = commitsDir(cwd, sid);
  await fs.mkdir(dir, { recursive: true });
  // One commit with 7 unique paths: file_paths capped at 5.
  await writeJsonAtomic(path.join(dir, 'big.json'), {
    ts: '2026-05-11T10:00:00Z',
    session_id: sid,
    edits: [
      { path: 'a.ts', ts: 't1', kind: 'Edit' },
      { path: 'b.ts', ts: 't2', kind: 'Edit' },
      { path: 'c.ts', ts: 't3', kind: 'Edit' },
      { path: 'd.ts', ts: 't4', kind: 'Edit' },
      { path: 'e.ts', ts: 't5', kind: 'Edit' },
      { path: 'f.ts', ts: 't6', kind: 'Edit' },
      { path: 'g.ts', ts: 't7', kind: 'Edit' },
    ],
  });

  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.commits.length, 1);
  assert.equal(pc.payload.commits[0].edit_count, 7);
  assert.equal(pc.payload.commits[0].file_paths.length, 5);
});

test('preCompact commits: missing commits dir → empty commits array', async (t) => {
  await setupEnv(t);
  const sid = 'pc-commits-empty';
  const cwd = await freshProjectCwd(t);
  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.deepEqual(pc.payload.commits, []);
});

// -- combined / shape check ----------------------------------------------

test('preCompact: payload shape carries all 5 sections', async (t) => {
  await setupEnv(t);
  const sid = 'pc-shape';
  const cwd = await freshProjectCwd(t);
  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.ok(pc.payload && typeof pc.payload === 'object');
  for (const k of ['rules', 'todos', 'files', 'bugs', 'commits']) {
    assert.ok(k in pc.payload, `payload.${k} present`);
  }
});

// Ensure hooks.log records the event so logger contract is honored.
test('preCompact: still logs the event line', async (t) => {
  await setupEnv(t);
  const sid = 'pc-log';
  const cwd = await freshProjectCwd(t);
  await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));
  const raw = await fs.readFile(hooksLogPath(sid), 'utf8');
  const lines = raw.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].event, 'PreCompact');
});
