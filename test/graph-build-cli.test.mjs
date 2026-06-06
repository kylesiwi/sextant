// Tests for bin/graph-build.mjs — the CLI wrapper around buildGraph().
//
// Strategy: spawn `node bin/graph-build.mjs` as a child process against a
// freshly-created synthetic project, then assert on exit code, summary line,
// stderr presence/absence of progress lines, and the produced graph.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO, 'bin', 'graph-build.mjs');

function freshTempDir(t, prefix = 'sextant-cli-build-') {
  const p = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  t.after(() => fs.rm(p, { recursive: true, force: true }));
  return p;
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function spawnScript(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO,
    timeout: 30000,
  });
}

// --- 1. smoke: synthetic project produces a graph.json --------------------

test('graph-build CLI: --root <tmp> --quiet produces graph.json (exit 0)', async (t) => {
  const root = freshTempDir(t);
  await write(path.join(root, 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'b.ts'), 'import { A } from "./a";\nexport const B = 2;\n');

  const r = spawnScript(['--root', root, '--quiet']);
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}; stdout=${r.stdout}`);

  // graph.json on disk.
  const graphPath = path.join(root, '.sextant', 'graph', 'graph.json');
  const stat = await fs.stat(graphPath);
  assert.ok(stat.isFile(), 'graph.json should exist at the expected path');

  // Summary line is the only thing on stdout, ending in newline.
  assert.match(
    r.stdout,
    /^Indexed 2 files, \d+ edges\. Wrote .*\/\.sextant\/graph\/graph\.json\. Took \d+ms\.\n$/,
    `unexpected stdout: ${JSON.stringify(r.stdout)}`,
  );
});

// --- 2. --root pointing to a non-directory exits 1 -------------------------

test('graph-build CLI: --root pointing to a non-directory exits 1', async (t) => {
  const root = freshTempDir(t);
  const file = path.join(root, 'not-a-dir.txt');
  await fs.writeFile(file, 'plain file', 'utf8');

  const r = spawnScript(['--root', file, '--quiet']);
  assert.equal(r.status, 1, `expected exit 1 for non-dir; stderr=${r.stderr}`);
  assert.match(r.stderr, /not a directory/, `stderr should explain: ${r.stderr}`);
});

test('graph-build CLI: --root pointing to a non-existent path exits 1', async (t) => {
  const root = freshTempDir(t);
  const missing = path.join(root, 'does-not-exist');

  const r = spawnScript(['--root', missing, '--quiet']);
  assert.equal(r.status, 1, `expected exit 1 for missing path; stderr=${r.stderr}`);
  assert.match(r.stderr, /not found/, `stderr should explain: ${r.stderr}`);
});

// --- 3. --quiet suppresses progress lines ---------------------------------

test('graph-build CLI: --quiet suppresses stderr progress; only summary on stdout', async (t) => {
  const root = freshTempDir(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');

  const r = spawnScript(['--root', root, '--quiet']);
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  // No "graph build —" progress lines in --quiet mode.
  assert.equal(r.stderr.trim(), '', `expected empty stderr in --quiet mode, got: ${r.stderr}`);
  // Summary line still arrives on stdout.
  assert.match(r.stdout, /^Indexed 1 files,/);
});

test('graph-build CLI: without --quiet, stderr carries progress lines', async (t) => {
  const root = freshTempDir(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');

  const r = spawnScript(['--root', root]);
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  // The builder emits "sextant: graph build — N candidate files" and a
  // closing "sextant: graph build — N files, M edges in Xms" line. Both
  // start with "sextant:".
  assert.match(r.stderr, /sextant: graph build/, `expected progress on stderr, got: ${r.stderr}`);
  // Summary line still arrives on stdout.
  assert.match(r.stdout, /^Indexed 1 files,/);
});

// --- 4. unknown arg exits 2 -----------------------------------------------

test('graph-build CLI: unknown flag exits 2', async (t) => {
  const r = spawnScript(['--bogus']);
  assert.equal(r.status, 2, `expected exit 2 for unknown flag; stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown arg/);
});

// --- 5. --force is accepted (Phase 1a no-op forward-compat) ----------------

test('graph-build CLI: --force is accepted as a no-op (forward-compat)', async (t) => {
  const root = freshTempDir(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');

  const r = spawnScript(['--root', root, '--quiet', '--force']);
  assert.equal(r.status, 0, `expected exit 0 with --force; stderr=${r.stderr}`);
  assert.match(r.stdout, /^Indexed 1 files,/);
});

// --- 6. empty project: 0 files, exit 0 ------------------------------------

test('graph-build CLI: empty project produces 0 files and exits 0', async (t) => {
  const root = freshTempDir(t);
  // No .ts files at all.

  const r = spawnScript(['--root', root, '--quiet']);
  assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
  assert.match(r.stdout, /^Indexed 0 files, 0 edges\./);
});
