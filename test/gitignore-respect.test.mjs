// Tests for the git-aware listSourceFiles enumeration in lib/graph/build.mjs.
//
// The git-aware path uses `git ls-files --cached --others --exclude-standard
// -z` to enumerate files, which respects .gitignore. The walker path
// (used when there is no `.git`) does NOT respect .gitignore. Both must be
// covered, plus the opt-out env var and the git-error fallback.
//
// We use real `git init` (via execFileSync) to construct test fixtures —
// faking the `.git/` structure is brittle across git versions. Tests will
// skip if git is not on PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { listSourceFiles } from '../lib/graph/build.mjs';

// --- helpers ---------------------------------------------------------------

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

function freshTempDir(prefix = 'sextant-gitignore-') {
  const p = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tempProject(t, prefix = 'sextant-gitignore-') {
  const dir = freshTempDir(prefix);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// Initialise a git repo at `root`, configured so commands like `git add` work
// in CI environments without a global user/email config. We don't actually
// commit anything — `git ls-files` only needs `--cached` (the index) or
// `--others` (working tree). Calling `git add .` is enough to populate the
// index.
function gitInit(root) {
  // -b main keeps git happy on newer versions; ignore failures from older
  // git that doesn't support -b (fall back to default branch).
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  }
  // Per-repo identity so `git add` / `git commit` don't fail under -c
  // user.email=... requirements.
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Sextant Test'], { cwd: root, stdio: 'ignore' });
}

function gitAdd(root, ...args) {
  execFileSync('git', ['add', ...args], { cwd: root, stdio: 'ignore' });
}

// Capture process.stderr.write for the duration of an async fn. Returns the
// joined captured output (anything written via process.stderr.write).
async function captureStderr(t, fn) {
  const origWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  t.after(() => { process.stderr.write = origWrite; });
  try {
    const r = await fn();
    return { result: r, stderr: lines.join('') };
  } finally {
    process.stderr.write = origWrite;
  }
}

// Snapshot then restore an env var across a test. Use to set / unset
// SEXTANT_GRAPH_USE_GITIGNORE without leaking into other tests.
function withEnv(t, key, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  });
}

// --- 1. .gitignore respected ---------------------------------------------

test('listSourceFiles: respects .gitignore in a git repo', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, '.gitignore'), 'generated/\n');
  await write(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'generated', 'b.ts'), 'export const B = 2;\n');
  gitInit(root);
  gitAdd(root, '.');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('src/a.ts'), `expected src/a.ts in: ${JSON.stringify(files)}`);
  assert.ok(!files.includes('generated/b.ts'),
    `generated/b.ts should be ignored, got: ${JSON.stringify(files)}`);
});

// --- 2. no .git -> walker path -------------------------------------------

test('listSourceFiles: no .git directory falls back to walker (ignores .gitignore)', async (t) => {
  const root = tempProject(t);
  // We write a .gitignore but never `git init`. The walker MUST NOT respect
  // it — it has no idea what .gitignore is. Both files should be indexed.
  await write(path.join(root, '.gitignore'), 'generated/\n');
  await write(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'generated', 'b.ts'), 'export const B = 2;\n');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('src/a.ts'));
  assert.ok(files.includes('generated/b.ts'),
    `walker should not respect .gitignore, got: ${JSON.stringify(files)}`);
});

// --- 3. opt-out via env var ----------------------------------------------

test('listSourceFiles: SEXTANT_GRAPH_USE_GITIGNORE=0 opts out (walker indexes everything)', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, '.gitignore'), 'generated/\n');
  await write(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'generated', 'b.ts'), 'export const B = 2;\n');
  gitInit(root);
  gitAdd(root, '.');

  withEnv(t, 'SEXTANT_GRAPH_USE_GITIGNORE', '0');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('src/a.ts'));
  assert.ok(files.includes('generated/b.ts'),
    `opt-out should index ignored dirs, got: ${JSON.stringify(files)}`);
});

// --- 4. git error -> fall back to walker with stderr warning -------------

test('listSourceFiles: corrupted .git falls back to walker with stderr warning', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'src', 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'generated', 'b.ts'), 'export const B = 2;\n');
  // Create a .git directory that's a directory (so isGitRepo says yes) but
  // contains no objects / HEAD / config — git ls-files will fail to read it.
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  // Write garbage HEAD so git sees this as broken.
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'this is not a valid HEAD\n', 'utf8');

  const { result: files, stderr } = await captureStderr(t, () => listSourceFiles(root));
  // Walker fallback indexes both files because it ignores .gitignore.
  assert.ok(files.includes('src/a.ts'));
  assert.ok(files.includes('generated/b.ts'),
    `walker fallback should index everything, got: ${JSON.stringify(files)}`);
  assert.match(stderr, /git ls-files failed/, `expected stderr warning, got: ${JSON.stringify(stderr)}`);
});

// --- 5. untracked-but-not-ignored file is included -----------------------

test('listSourceFiles: untracked file matching extension is included', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, '.gitignore'), 'ignored/\n');
  await write(path.join(root, 'committed.ts'), 'export const C = 1;\n');
  gitInit(root);
  gitAdd(root, 'committed.ts');
  // After init+add, the index has only committed.ts. Now create a NEW
  // untracked file that's not in .gitignore. With --others
  // --exclude-standard, git ls-files should still return it.
  await write(path.join(root, 'untracked.ts'), 'export const U = 1;\n');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('committed.ts'),
    `expected committed.ts, got: ${JSON.stringify(files)}`);
  assert.ok(files.includes('untracked.ts'),
    `expected untracked.ts to be included via --others, got: ${JSON.stringify(files)}`);
});

// --- 6. git add -f into a gitignored dir is included --------------------

test('listSourceFiles: file force-added into a .gitignored dir is included', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, '.gitignore'), 'forced/\n');
  await write(path.join(root, 'forced', 'a.ts'), 'export const F = 1;\n');
  gitInit(root);
  // -f overrides .gitignore — the file ends up in the index.
  gitAdd(root, '-f', 'forced/a.ts');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('forced/a.ts'),
    `git knows about forced/a.ts; expected it in listing, got: ${JSON.stringify(files)}`);
});

// --- 7. hardcoded skip-list applied even when git would include it -------

test('listSourceFiles: node_modules dropped even when git tracks it', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  // No .gitignore — by default, git would happily track node_modules.
  await write(path.join(root, 'src', 'keep.ts'), 'export const K = 1;\n');
  await write(path.join(root, 'node_modules', 'pkg', 'index.ts'), 'export const NM = 1;\n');
  gitInit(root);
  gitAdd(root, '.');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('src/keep.ts'));
  assert.ok(!files.includes('node_modules/pkg/index.ts'),
    `node_modules must be dropped by hardcoded skip-list, got: ${JSON.stringify(files)}`);
});

// --- 8. extension filter still applies in git path -----------------------

test('listSourceFiles: extension filter applies under git path', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'README.md'), '# hello\n');
  await write(path.join(root, 'package.json'), '{}\n');
  gitInit(root);
  gitAdd(root, '.');

  const files = await listSourceFiles(root);
  assert.ok(files.includes('a.ts'));
  assert.ok(!files.includes('README.md'));
  assert.ok(!files.includes('package.json'));
});

// --- 9. sorted output ----------------------------------------------------

test('listSourceFiles: git path returns sorted paths', { skip: !HAS_GIT && 'git not available' }, async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'z.ts'), 'export const Z = 1;\n');
  await write(path.join(root, 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'm.ts'), 'export const M = 1;\n');
  gitInit(root);
  gitAdd(root, '.');

  const files = await listSourceFiles(root);
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted, `expected sorted output, got: ${JSON.stringify(files)}`);
});
