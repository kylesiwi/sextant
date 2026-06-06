// Tests for bin/import-bridge.mjs — both pure (applyCerebrumMarkers) and
// end-to-end (spawn the script and inspect side effects).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { applyCerebrumMarkers, runImportBridge } from '../bin/import-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(REPO, 'bin', 'import-bridge.mjs');

const MARKER = '<!-- sextant:migrated -->';

function freshDir(t) {
  const dir = path.join(os.tmpdir(), 'sextant-import-bridge-' + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeWolf(dir, { cerebrum, buglog } = {}) {
  fsSync.mkdirSync(dir, { recursive: true });
  if (cerebrum !== undefined) {
    fsSync.writeFileSync(path.join(dir, 'cerebrum.md'), cerebrum, 'utf8');
  }
  if (buglog !== undefined) {
    fsSync.writeFileSync(path.join(dir, 'buglog.json'), buglog, 'utf8');
  }
}

// -- pure: applyCerebrumMarkers --------------------------------------------

test('applyCerebrumMarkers: prepends marker to each rule line, leaves others alone', () => {
  const src = [
    '# My cerebrum',
    '',
    '- 2026-05-01: always use tabs',
    '  (note)',
    '- 2026-05-02: never commit secrets',
    'random line',
  ].join('\n');
  const out = applyCerebrumMarkers(src);
  const lines = out.split('\n');
  // Markers must precede each rule.
  assert.equal(lines.filter((l) => l === MARKER).length, 2);
  // Non-rule lines preserved verbatim.
  assert.ok(out.includes('# My cerebrum'));
  assert.ok(out.includes('  (note)'));
  assert.ok(out.includes('random line'));
});

test('applyCerebrumMarkers: idempotent — re-running does not duplicate markers', () => {
  const src = [
    '- 2026-05-01: foo',
    '- 2026-05-02: bar',
  ].join('\n');
  const once = applyCerebrumMarkers(src);
  const twice = applyCerebrumMarkers(once);
  assert.equal(once, twice, 'second pass must be a no-op');
  // Exactly 2 markers, not 4.
  assert.equal(twice.split('\n').filter((l) => l === MARKER).length, 2);
});

test('applyCerebrumMarkers: does not match non-rule dashes', () => {
  const src = [
    '- this is not a rule',
    '- 2026-05-02-not-a-rule',
    '- 2026-05-02: this is one',
  ].join('\n');
  const out = applyCerebrumMarkers(src);
  assert.equal(out.split('\n').filter((l) => l === MARKER).length, 1);
});

// -- end-to-end: spawn the script ------------------------------------------

function spawnScript(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO,
    timeout: 10000,
  });
}

test('end-to-end: 3 rule lines + 1 non-rule line → 3 markers + non-rule preserved', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    cerebrum: [
      'header comment',
      '- 2026-01-01: rule-1',
      '- 2026-02-02: rule-2',
      '- 2026-03-03: rule-3',
    ].join('\n'),
    buglog: '[]',
  });
  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}\nstdout=${r.stdout}`);

  const dst = fsSync.readFileSync(path.join(sextant, 'cerebrum', 'regular.md'), 'utf8');
  assert.equal(dst.split('\n').filter((l) => l === MARKER).length, 3);
  assert.ok(dst.includes('- 2026-01-01: rule-1'));
  assert.ok(dst.includes('- 2026-02-02: rule-2'));
  assert.ok(dst.includes('- 2026-03-03: rule-3'));
  assert.ok(dst.includes('header comment'));
});

test('end-to-end: buglog.json round-trips with one entry', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  const bug = { id: 'bug-1', title: 'broken thing', tags: ['core'], status: 'open' };
  makeWolf(wolf, { buglog: JSON.stringify([bug]) });

  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 0, `script failed: stderr=${r.stderr}`);

  const bugs = JSON.parse(fsSync.readFileSync(path.join(sextant, 'bugs.json'), 'utf8'));
  assert.deepEqual(bugs, [bug]);
});

test('end-to-end: re-running on already-migrated cerebrum is idempotent', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    cerebrum: '- 2026-01-01: rule-1\n- 2026-02-02: rule-2',
  });

  const r1 = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r1.status, 0, `first run failed: ${r1.stderr}`);

  const r2 = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r2.status, 0, `second run failed: ${r2.stderr}`);

  const dst = fsSync.readFileSync(path.join(sextant, 'cerebrum', 'regular.md'), 'utf8');
  assert.equal(dst.split('\n').filter((l) => l === MARKER).length, 2);
});

test('end-to-end: existing non-empty bugs.json without --force exits 1', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    buglog: JSON.stringify([{ id: 'new', title: 'new bug' }]),
  });
  // Pre-existing destination with content.
  fsSync.mkdirSync(sextant, { recursive: true });
  fsSync.writeFileSync(
    path.join(sextant, 'bugs.json'),
    JSON.stringify([{ id: 'existing', title: 'existing bug' }], null, 2) + '\n',
    'utf8',
  );

  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /--force/);

  // Existing content untouched.
  const existing = JSON.parse(fsSync.readFileSync(path.join(sextant, 'bugs.json'), 'utf8'));
  assert.equal(existing[0].id, 'existing');
});

test('end-to-end: --force overwrites existing non-empty bugs.json', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    buglog: JSON.stringify([{ id: 'new', title: 'new bug' }]),
  });
  fsSync.mkdirSync(sextant, { recursive: true });
  fsSync.writeFileSync(
    path.join(sextant, 'bugs.json'),
    JSON.stringify([{ id: 'existing', title: 'existing bug' }], null, 2) + '\n',
    'utf8',
  );

  const r = spawnScript(['--from', wolf, '--to', sextant, '--force']);
  assert.equal(r.status, 0, `expected exit 0 with --force, got ${r.status}; stderr=${r.stderr}`);

  const after = JSON.parse(fsSync.readFileSync(path.join(sextant, 'bugs.json'), 'utf8'));
  assert.equal(after[0].id, 'new', 'destination should be overwritten with --force');
});

test('end-to-end: empty-array bugs.json is treated as empty (no --force needed)', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    buglog: JSON.stringify([{ id: 'fresh', title: 'fresh bug' }]),
  });
  fsSync.mkdirSync(sextant, { recursive: true });
  fsSync.writeFileSync(path.join(sextant, 'bugs.json'), '[]\n', 'utf8');

  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 0, `expected exit 0 with empty-array dest, got ${r.status}; stderr=${r.stderr}`);
  const after = JSON.parse(fsSync.readFileSync(path.join(sextant, 'bugs.json'), 'utf8'));
  assert.equal(after[0].id, 'fresh');
});

test('end-to-end: missing .wolf dir exits 0 with friendly message', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf-does-not-exist');
  const sextant = path.join(tmp, '.sextant');

  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 0, `expected exit 0 for missing wolf, got ${r.status}`);
  assert.match(r.stdout, /no \.wolf\/ found/);
});

test('end-to-end: summary message includes counts', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    cerebrum: '- 2026-01-01: rule-A',
    buglog: '[]',
  });

  const r = spawnScript(['--from', wolf, '--to', sextant]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Migrated 1 rules \+ 0 bugs/);
  assert.match(r.stdout, /graphify-out not copied/);
});

// -- programmatic import: runImportBridge ----------------------------------

test('runImportBridge: programmatic call returns counts', (t) => {
  const tmp = freshDir(t);
  const wolf = path.join(tmp, '.wolf');
  const sextant = path.join(tmp, '.sextant');
  makeWolf(wolf, {
    cerebrum: '- 2026-01-01: r1\n- 2026-02-02: r2',
    buglog: JSON.stringify([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]),
  });
  const result = runImportBridge({ from: wolf, to: sextant });
  assert.deepEqual(result, { rules: 2, bugs: 3 });
});
