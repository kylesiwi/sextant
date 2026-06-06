// Tests for bin/bugs.mjs — log / search / list subcommands.
//
// We spawn the CLI as a subprocess (matching production usage) against a
// synthetic .sextant/ tree, then assert on stdout + on-disk state. In-process
// unit coverage of helpers (parseArgs / parseTagsCSV / renderEntryLine) is
// exercised via direct import.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs, parseTagsCSV, renderEntryLine } from '../bin/bugs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'bugs.mjs');

function freshProjectRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-bugs-cli-' + crypto.randomUUID());
  fsSync.mkdirSync(path.join(root, '.sextant'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    ...opts,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---- unit: parseArgs ------------------------------------------------------

test('parseArgs: collects long-form flag values', () => {
  const r = parseArgs([
    '--file', 'src/x.ts',
    '--error', 'oops',
    '--root-cause', 'why',
    '--fix', 'patch',
    '--symbol', 'foo',
    '--tags', 'a,b,c',
    '--root', '/r',
  ]);
  assert.equal(r.file, 'src/x.ts');
  assert.equal(r.error, 'oops');
  assert.equal(r.rootCause, 'why');
  assert.equal(r.fix, 'patch');
  assert.equal(r.symbol, 'foo');
  assert.equal(r.tags, 'a,b,c');
  assert.equal(r.root, '/r');
  assert.equal(r.openOnly, false);
});

test('parseArgs: --open-only is a boolean flag', () => {
  const r = parseArgs(['--open-only']);
  assert.equal(r.openOnly, true);
});

test('parseTagsCSV: splits + trims', () => {
  assert.deepEqual(parseTagsCSV('a, b,  c'), ['a', 'b', 'c']);
  assert.deepEqual(parseTagsCSV(''), []);
  assert.deepEqual(parseTagsCSV(null), []);
});

test('renderEntryLine: produces "<id> [<file>:<node>] <err>"', () => {
  const line = renderEntryLine({
    id: 'bug-7',
    file: 'src/x.ts',
    graph_node: 'foo',
    error_message: 'TypeError',
  });
  assert.equal(line, 'bug-7 [src/x.ts:foo] TypeError');
});

// ---- subcommand: log ------------------------------------------------------

test('cli log: writes a new entry and prints the id', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli([
    'log',
    '--root', root,
    '--file', 'src/api/auth.ts',
    '--error', 'TypeError on validateToken',
    '--root-cause', 'response was null',
    '--fix', 'optional chaining',
  ]);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);
  assert.match(r.stdout.trim(), /^bug-1$/);

  const data = JSON.parse(await fs.readFile(path.join(root, '.sextant', 'bugs.json'), 'utf8'));
  assert.equal(data.length, 1);
  assert.equal(data[0].id, 'bug-1');
  assert.equal(data[0].file, 'src/api/auth.ts');
  assert.equal(data[0].error_message, 'TypeError on validateToken');
  assert.equal(data[0].root_cause, 'response was null');
  assert.equal(data[0].fix, 'optional chaining');
  assert.equal(data[0].fix_verified, false);
  assert.ok(!Number.isNaN(Date.parse(data[0].ts)));
});

test('cli log: --symbol pre-tags as symbol-match', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli([
    'log',
    '--root', root,
    '--file', 'src/x.ts',
    '--error', 'err',
    '--root-cause', 'rc',
    '--fix', 'fx',
    '--symbol', 'validateToken',
  ]);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);
  const data = JSON.parse(await fs.readFile(path.join(root, '.sextant', 'bugs.json'), 'utf8'));
  assert.equal(data[0].graph_node, 'validateToken');
  assert.equal(data[0].graph_node_confidence, 'symbol-match');
});

test('cli log: --tags collects CSV list', async (t) => {
  const root = freshProjectRoot(t);
  runCli([
    'log',
    '--root', root,
    '--file', 'src/x.ts',
    '--error', 'e', '--root-cause', 'r', '--fix', 'f',
    '--tags', 'null-check,api-response',
  ]);
  const data = JSON.parse(await fs.readFile(path.join(root, '.sextant', 'bugs.json'), 'utf8'));
  assert.deepEqual(data[0].tags, ['null-check', 'api-response']);
});

test('cli log: ids increment across calls', async (t) => {
  const root = freshProjectRoot(t);
  const r1 = runCli(['log', '--root', root, '--file', 'a.ts', '--error', 'e1', '--root-cause', 'r', '--fix', 'f']);
  const r2 = runCli(['log', '--root', root, '--file', 'b.ts', '--error', 'e2', '--root-cause', 'r', '--fix', 'f']);
  const r3 = runCli(['log', '--root', root, '--file', 'c.ts', '--error', 'e3', '--root-cause', 'r', '--fix', 'f']);
  assert.equal(r1.stdout.trim(), 'bug-1');
  assert.equal(r2.stdout.trim(), 'bug-2');
  assert.equal(r3.stdout.trim(), 'bug-3');
});

test('cli log: SEXTANT_SESSION_ID is respected', async (t) => {
  const root = freshProjectRoot(t);
  runCli(
    ['log', '--root', root, '--file', 'x.ts', '--error', 'e', '--root-cause', 'r', '--fix', 'f'],
    { env: { ...process.env, SEXTANT_SESSION_ID: 'sess-abc' } },
  );
  const data = JSON.parse(await fs.readFile(path.join(root, '.sextant', 'bugs.json'), 'utf8'));
  assert.equal(data[0].session_id, 'sess-abc');
});

test('cli log: missing --file → exit 1', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['log', '--root', root, '--error', 'e', '--root-cause', 'r', '--fix', 'f']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file is required/);
});

test('cli log: missing --error → exit 1', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['log', '--root', root, '--file', 'x', '--root-cause', 'r', '--fix', 'f']);
  assert.equal(r.code, 1);
});

// ---- subcommand: search ---------------------------------------------------

test('cli search: prints matching entries', async (t) => {
  const root = freshProjectRoot(t);
  runCli(['log', '--root', root, '--file', 'src/a.ts', '--error', 'errA1', '--root-cause', 'r', '--fix', 'f']);
  runCli(['log', '--root', root, '--file', 'src/a.ts', '--error', 'errA2', '--root-cause', 'r', '--fix', 'f']);
  runCli(['log', '--root', root, '--file', 'src/b.ts', '--error', 'errB1', '--root-cause', 'r', '--fix', 'f']);

  const r = runCli(['search', '--root', root, '--file', 'src/a.ts']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^bug-1 \[src\/a\.ts:\] errA1$/);
  assert.match(lines[1], /^bug-2 \[src\/a\.ts:\] errA2$/);
});

test('cli search: --symbol narrows by graph_node', async (t) => {
  const root = freshProjectRoot(t);
  runCli([
    'log', '--root', root,
    '--file', 'src/x.ts', '--error', 'e1', '--root-cause', 'r', '--fix', 'f',
    '--symbol', 'foo',
  ]);
  runCli([
    'log', '--root', root,
    '--file', 'src/x.ts', '--error', 'e2', '--root-cause', 'r', '--fix', 'f',
    '--symbol', 'bar',
  ]);
  const r = runCli(['search', '--root', root, '--file', 'src/x.ts', '--symbol', 'foo']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[src\/x\.ts:foo\]/);
});

test('cli search: no match → empty stdout, exit 0', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['search', '--root', root, '--file', 'nope.ts']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

test('cli search: missing --file → exit 1', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['search', '--root', root]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--file is required/);
});

// ---- subcommand: list -----------------------------------------------------

test('cli list: prints all entries', async (t) => {
  const root = freshProjectRoot(t);
  runCli(['log', '--root', root, '--file', 'a.ts', '--error', 'e1', '--root-cause', 'r', '--fix', 'f']);
  runCli(['log', '--root', root, '--file', 'b.ts', '--error', 'e2', '--root-cause', 'r', '--fix', 'f']);
  const r = runCli(['list', '--root', root]);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
});

test('cli list: --open-only filters out fix_verified', async (t) => {
  const root = freshProjectRoot(t);
  runCli(['log', '--root', root, '--file', 'a.ts', '--error', 'open', '--root-cause', 'r', '--fix', 'f']);
  runCli(['log', '--root', root, '--file', 'b.ts', '--error', 'closed', '--root-cause', 'r', '--fix', 'f']);

  // Mark bug-2 as fix_verified.
  const file = path.join(root, '.sextant', 'bugs.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data[1].fix_verified = true;
  await fs.writeFile(file, JSON.stringify(data), 'utf8');

  const r = runCli(['list', '--root', root, '--open-only']);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /open/);
});

test('cli list: empty store → empty stdout, exit 0', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['list', '--root', root]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '');
});

// ---- error / help paths ---------------------------------------------------

test('cli: unknown subcommand → exit 2 with help', async () => {
  const r = runCli(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown subcommand/);
});

test('cli: --help prints usage', async () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Subcommands:/);
});

test('cli: unknown arg → exit 2', async () => {
  const r = runCli(['log', '--bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown arg/);
});
