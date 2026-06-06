// Tests for bin/conflicts.mjs — CLI wrapper around lib/conflicts.mjs.
//
// Spawn the script against synthetic fixtures and assert exit codes +
// JSON output shape.

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
const SCRIPT = path.join(REPO, 'bin', 'conflicts.mjs');

function freshDir(t, prefix = 'sextant-conflicts-cli-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function spawnScript(args, opts = {}) {
  // Override HOME on each spawn so we don't pick up the developer's real
  // ~/.claude/ during tests.
  const env = { ...process.env, HOME: opts.home ?? '/nonexistent-home-for-test' };
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10000,
  });
}

test('clean tree → exit 0, "No conflicts detected." pretty output', (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  const r = spawnScript(['--root', cwd], { home });
  assert.equal(r.status, 0, `expected 0 on clean tree, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /No conflicts detected\./);
});

test('clean tree --json → exit 0, output is "[]"', (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  const r = spawnScript(['--root', cwd, '--json'], { home });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, []);
});

test('medium-only tree → exit 0, summary mentions medium', (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  fsSync.mkdirSync(path.join(cwd, '.graphify'), { recursive: true });

  const r = spawnScript(['--root', cwd], { home });
  assert.equal(r.status, 0, `medium-only must exit 0; got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /medium: graphify/);
  assert.match(r.stdout, /Summary: 1 medium/);
});

test('high-severity tree (.wolf/) → exit 1', (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  fsSync.mkdirSync(path.join(cwd, '.wolf'), { recursive: true });

  const r = spawnScript(['--root', cwd], { home });
  assert.equal(r.status, 1, `high must exit 1; got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /high: openwolf-bridge/);
  assert.match(r.stdout, /Sextant will NOT modify other plugins'/);
});

test('--json output is well-formed array with required fields', (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  fsSync.mkdirSync(path.join(cwd, '.wolf'), { recursive: true });
  fsSync.mkdirSync(path.join(cwd, '.graphify'), { recursive: true });

  const r = spawnScript(['--root', cwd, '--json'], { home });
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
  for (const f of parsed) {
    assert.ok(typeof f.kind === 'string', 'kind is string');
    assert.ok(['high', 'medium', 'low'].includes(f.severity), 'severity enum');
    assert.ok(typeof f.location === 'string', 'location is string');
    assert.ok(typeof f.message === 'string', 'message is string');
    assert.ok(typeof f.action_hint === 'string', 'action_hint is string');
  }
  const kinds = parsed.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['graphify', 'openwolf-bridge']);
});

test('--help exits 0 with usage', () => {
  const r = spawnScript(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:.*conflicts\.mjs/);
});

test('unknown arg exits 2 with stderr', () => {
  const r = spawnScript(['--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown arg/);
});
