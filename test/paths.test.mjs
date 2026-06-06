// Tests for lib/paths.mjs — runtime/durable path helpers.
//
// Isolation: each test uses a tempdir as SEXTANT_RUNTIME_BASE so we never
// touch /tmp/sextant-* on the host. Process env is mutated before each test
// and restored after; tests are not parallel-safe wrt env, but node:test
// runs files concurrently and tests within a file serially, which is fine.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  runtimeBase,
  runtimeRoot,
  durableBase,
  statuslineStatePath,
  lockfilePath,
  hooksLogPath,
  runtimeFile,
  durableFile,
  ensureRuntimeDir,
  ensureDurableDir,
  lastProjectFileEditPath,
  turnStatePath,
  testRunPendingFlagPath,
  commitPendingFlagPath,
  editsPath,
} from '../lib/paths.mjs';
import {
  runtimeRootFor,
  nativeRuntimeRoot,
  projectHash,
} from '../lib/runtime-locate.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-test-' + crypto.randomUUID());
}

// Helper to swap env vars for a single test, restoring afterward.
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

test('runtimeBase: uses SEXTANT_RUNTIME_BASE when set (test override; cwd ignored)', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(runtimeBase('sid123', '/anything'), path.join(base, 'sextant-sid123'));
  // No-cwd is also fine when the override is set.
  assert.equal(runtimeBase('sid123'), path.join(base, 'sextant-sid123'));
});

test('runtimeBase: with no override, returns a NATIVE-FS path off the project tree', (t) => {
  // Hot state must not live under <cwd>/.sextant (v9fs on WSL). It resolves to
  // the native runtime root (XDG/tmpdir), keyed by projectHash, + sextant-<sid>.
  withEnv(t, { SEXTANT_RUNTIME_BASE: undefined });
  const got = runtimeBase('sid', '/home/foo/proj');
  const expected = path.join(nativeRuntimeRoot(), projectHash('/home/foo/proj'), 'sextant-sid');
  assert.equal(got, expected);
  assert.ok(!got.includes(`${path.sep}.sextant${path.sep}`), `hot state must be off the project tree, got ${got}`);
});

test('runtimeBase: native path is deterministic and per-project isolated', (t) => {
  withEnv(t, { SEXTANT_RUNTIME_BASE: undefined });
  // same cwd+sid → same path
  assert.equal(runtimeBase('s', '/home/a/proj'), runtimeBase('s', '/home/a/proj'));
  // different project → different runtime root (projectHash isolation)
  assert.notEqual(runtimeBase('s', '/home/a/proj'), runtimeBase('s', '/home/b/proj'));
  // trailing slash / relative normalisation does not split a project
  assert.equal(projectHash('/home/a/proj'), projectHash('/home/a/proj/'));
});

test('runtimeRoot: matches runtimeBase parent (consistent root)', (t) => {
  withEnv(t, { SEXTANT_RUNTIME_BASE: undefined });
  assert.equal(runtimeRoot('/home/foo/proj'), runtimeRootFor('/home/foo/proj'));
  assert.equal(runtimeBase('sid', '/home/foo/proj'), path.join(runtimeRoot('/home/foo/proj'), 'sextant-sid'));
});

test('runtimeBase: with no override and no cwd, throws', (t) => {
  withEnv(t, { SEXTANT_RUNTIME_BASE: undefined });
  assert.throws(() => runtimeBase('sid'), /cwd required/);
});

test('runtimeBase: with no override and non-absolute cwd, throws', (t) => {
  withEnv(t, { SEXTANT_RUNTIME_BASE: undefined });
  assert.throws(() => runtimeBase('sid', 'relative/path'), /cwd must be absolute/);
});

test('durableBase: returns cwd + /.sextant', () => {
  assert.equal(durableBase('/home/foo/proj'), '/home/foo/proj/.sextant');
});

test('durableBase: resolves to absolute', () => {
  // Relative cwd should still produce absolute (path.resolve semantics).
  const result = durableBase('relative/path');
  assert.ok(path.isAbsolute(result), `expected absolute, got ${result}`);
  assert.ok(result.endsWith('/.sextant'));
});

test('statuslineStatePath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    statuslineStatePath('sid'),
    path.join(base, 'sextant-sid', 'statusline-state.json')
  );
});

test('lockfilePath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    lockfilePath('sid'),
    path.join(base, 'sextant-sid', 'statusline-state.json.lock')
  );
});

test('hooksLogPath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    hooksLogPath('sid'),
    path.join(base, 'sextant-sid', 'hooks.log')
  );
});

test('runtimeFile: general helper', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    runtimeFile('sid', 'foo.json'),
    path.join(base, 'sextant-sid', 'foo.json')
  );
});

test('lastProjectFileEditPath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    lastProjectFileEditPath('sid'),
    path.join(base, 'sextant-sid', 'last_project_file_edit.json'),
  );
});

test('turnStatePath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    turnStatePath('sid'),
    path.join(base, 'sextant-sid', 'turn-state.json'),
  );
});

test('testRunPendingFlagPath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    testRunPendingFlagPath('sid'),
    path.join(base, 'sextant-sid', 'test-run-pending.flag'),
  );
});

test('commitPendingFlagPath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    commitPendingFlagPath('sid'),
    path.join(base, 'sextant-sid', 'commit-pending.flag'),
  );
});

test('editsPath composes correctly', (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  assert.equal(
    editsPath('sid'),
    path.join(base, 'sextant-sid', 'edits.json'),
  );
});

test('durableFile: general helper', () => {
  assert.equal(
    durableFile('/home/foo/proj', 'cerebrum.md'),
    '/home/foo/proj/.sextant/cerebrum.md'
  );
});

test('sessionId validation: empty string throws', () => {
  assert.throws(() => runtimeBase(''), /sessionId required/);
  assert.throws(() => statuslineStatePath(''), /sessionId required/);
  assert.throws(() => lockfilePath(''), /sessionId required/);
});

test('sessionId validation: undefined/null throws', () => {
  assert.throws(() => runtimeBase(undefined), /sessionId required/);
  assert.throws(() => runtimeBase(null), /sessionId required/);
});

test('sessionId validation: contains ".." throws', () => {
  assert.throws(() => runtimeBase('..'), /invalid sessionId/);
  assert.throws(() => runtimeBase('foo..bar'), /invalid sessionId/);
  assert.throws(() => runtimeBase('../etc'), /invalid sessionId/);
});

test('sessionId validation: contains "/" throws', () => {
  assert.throws(() => runtimeBase('foo/bar'), /invalid sessionId/);
  assert.throws(() => runtimeBase('/abs'), /invalid sessionId/);
});

test('ensureRuntimeDir: creates the directory', async (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const result = await ensureRuntimeDir('sid1');
  assert.equal(result, path.join(base, 'sextant-sid1'));
  const stat = await fs.stat(result);
  assert.ok(stat.isDirectory());
});

test('ensureRuntimeDir: idempotent (twice does not throw)', async (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await ensureRuntimeDir('sid2');
  await ensureRuntimeDir('sid2'); // should not throw
  const stat = await fs.stat(path.join(base, 'sextant-sid2'));
  assert.ok(stat.isDirectory());
});

test('ensureDurableDir: creates .sextant/', async (t) => {
  const cwd = path.join(os.tmpdir(), 'sextant-test-cwd-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const result = await ensureDurableDir(cwd);
  assert.equal(result, path.join(cwd, '.sextant'));
  const stat = await fs.stat(result);
  assert.ok(stat.isDirectory());
});

test('ensureDurableDir: creates subdir under .sextant/', async (t) => {
  const cwd = path.join(os.tmpdir(), 'sextant-test-cwd-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  const result = await ensureDurableDir(cwd, 'bugs');
  assert.equal(result, path.join(cwd, '.sextant', 'bugs'));
  const stat = await fs.stat(result);
  assert.ok(stat.isDirectory());
});

test('ensureDurableDir: idempotent', async (t) => {
  const cwd = path.join(os.tmpdir(), 'sextant-test-cwd-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  await ensureDurableDir(cwd);
  await ensureDurableDir(cwd); // no-throw
  await ensureDurableDir(cwd, 'bugs');
  await ensureDurableDir(cwd, 'bugs'); // no-throw
});
