// test/config-cli.test.mjs — the /sextant:output CLI (bin/config.mjs).
//
// Two tracks: in-process parseArgs coverage, and subprocess CLI round-trips
// against a synthetic project root (.sextant/config.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../bin/config.mjs';
import { readOutputMode, readCaptureNudgeMode } from '../lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'config.mjs');

async function freshRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-cfg-' + crypto.randomUUID());
  await fs.mkdir(path.join(root, '.sextant'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });

// -- parseArgs --------------------------------------------------------------

test('parseArgs: positional + --root + help', () => {
  const a = parseArgs(['verbose', '--root', '/tmp/x']);
  assert.deepEqual(a.positional, ['verbose']);
  assert.equal(a.root, '/tmp/x');
  assert.equal(parseArgs(['-h']).help, true);
});

// -- CLI round-trips --------------------------------------------------------

test('get: defaults to quiet on a fresh project', async (t) => {
  const root = await freshRoot(t);
  const r = run(['get', '--root', root]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'quiet');
});

test('set then get round-trips and persists', async (t) => {
  const root = await freshRoot(t);
  const s = run(['set', 'verbose', '--root', root]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /verbose/);
  assert.equal(run(['get', '--root', root]).stdout.trim(), 'verbose');
  assert.equal(await readOutputMode(root), 'verbose', 'persisted to .sextant/config.json');
});

test('set off / quiet / verbose all accepted', async (t) => {
  const root = await freshRoot(t);
  for (const m of ['off', 'quiet', 'verbose']) {
    assert.equal(run(['set', m, '--root', root]).status, 0, `set ${m}`);
    assert.equal(run(['get', '--root', root]).stdout.trim(), m);
  }
});

test('set rejects an invalid mode (exit 1)', async (t) => {
  const root = await freshRoot(t);
  const r = run(['set', 'loud', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid output mode/);
});

test('set with no mode exits 2', async (t) => {
  const root = await freshRoot(t);
  assert.equal(run(['set', '--root', root]).status, 2);
});

test('unknown subcommand exits 2', async (t) => {
  const root = await freshRoot(t);
  assert.equal(run(['bogus', '--root', root]).status, 2);
});

test('no subcommand prints usage, exits 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Usage: config/);
});

// -- autorules (capture_nudge) subcommands ----------------------------------

test('autorules-get: defaults to on for a fresh project', async (t) => {
  const root = await freshRoot(t);
  const r = run(['autorules-get', '--root', root]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'on');
});

test('autorules-set then -get round-trips and persists', async (t) => {
  const root = await freshRoot(t);
  const s = run(['autorules-set', 'off', '--root', root]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /off/);
  assert.equal(run(['autorules-get', '--root', root]).stdout.trim(), 'off');
  assert.equal(await readCaptureNudgeMode(root), 'off', 'persisted to .sextant/config.json');
  // Flipping back to on works too.
  assert.equal(run(['autorules-set', 'on', '--root', root]).status, 0);
  assert.equal(await readCaptureNudgeMode(root), 'on');
});

test('autorules-set does not disturb the output_mode key', async (t) => {
  const root = await freshRoot(t);
  run(['set', 'verbose', '--root', root]);
  run(['autorules-set', 'off', '--root', root]);
  assert.equal(await readOutputMode(root), 'verbose', 'output_mode preserved');
  assert.equal(await readCaptureNudgeMode(root), 'off');
});

test('autorules-set rejects an invalid mode (exit 1)', async (t) => {
  const root = await freshRoot(t);
  const r = run(['autorules-set', 'sometimes', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid autorules mode/);
});

test('autorules-set with no mode exits 2', async (t) => {
  const root = await freshRoot(t);
  assert.equal(run(['autorules-set', '--root', root]).status, 2);
});
