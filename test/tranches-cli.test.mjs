// Tests for bin/tranches.mjs — focused on the --tranche id normalization that
// lets agents pass either the display form "T4" (as `status` prints it) or the
// bare "4" the store keys on. Unit coverage of normalizeTrancheId via direct
// import; end-to-end coverage by spawning the CLI against a synthetic .sextant/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { normalizeTrancheId } from '../bin/tranches.mjs';
import { defaultTranches, startFeature, writeTranches } from '../lib/stores/tranches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'tranches.mjs');

function freshProjectRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-tranches-cli-' + crypto.randomUUID());
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

async function seedFeature(root) {
  const state = defaultTranches();
  startFeature(state, {
    feature: 'feat',
    docRoot: 'docs/feat',
    charterPath: 'docs/feat/charter.md',
    specPath: 'docs/feat/spec.md',
    tranches: [
      { id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] },
      { id: '2', title: 'T2', scope: ['src/b.ts'], depends_on: ['1'] },
    ],
  });
  await writeTranches(root, state);
}

// ---- unit: normalizeTrancheId --------------------------------------------

test('normalizeTrancheId: strips a leading T before a digit (display form)', () => {
  assert.equal(normalizeTrancheId('T4'), '4');
  assert.equal(normalizeTrancheId('t4'), '4');
  assert.equal(normalizeTrancheId('T12'), '12');
});

test('normalizeTrancheId: leaves a bare numeric id untouched', () => {
  assert.equal(normalizeTrancheId('4'), '4');
  assert.equal(normalizeTrancheId('12'), '12');
});

test('normalizeTrancheId: leaves non-display / non-numeric ids untouched', () => {
  // No digit after the T → not the display form; don't mangle it.
  assert.equal(normalizeTrancheId('TEST'), 'TEST');
  assert.equal(normalizeTrancheId('abc'), 'abc');
  assert.equal(normalizeTrancheId(undefined), undefined);
});

// ---- e2e: the bug scenario through the real binary ------------------------

test('advance --tranche T1 (display form) succeeds, not "TT1 not found"', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);

  const r = runCli(['advance', '--tranche', 'T1', '--to', 'READY', '--root', root]);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /T1 → READY/);
  // The old double-prefix bug surfaced as "TT1" in messages — must not recur.
  assert.ok(!(r.stdout + r.stderr).includes('TT1'), 'must not double-prefix the id');
});

test('checklist-done + advance to IN-FLIGHT accept the display form', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);

  assert.equal(runCli(['advance', '--tranche', 'T1', '--to', 'READY', '--root', root]).code, 0);
  const cd = runCli(['checklist-done', '--tranche', 'T1', '--root', root]);
  assert.equal(cd.code, 0, `checklist-done failed: ${cd.stderr}`);
  assert.match(cd.stdout, /T1 checklist marked complete/);
  const inflight = runCli(['advance', '--tranche', 'T1', '--to', 'IN-FLIGHT', '--root', root]);
  assert.equal(inflight.code, 0, `IN-FLIGHT advance failed: ${inflight.stderr}`);
  assert.match(inflight.stdout, /T1 → IN-FLIGHT/);
});

test('ship prints the review-before-ship reminder and still ships (exit 0)', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);

  assert.equal(runCli(['advance', '--tranche', 'T1', '--to', 'READY', '--root', root]).code, 0);
  assert.equal(runCli(['checklist-done', '--tranche', 'T1', '--root', root]).code, 0);
  assert.equal(runCli(['advance', '--tranche', 'T1', '--to', 'IN-FLIGHT', '--root', root]).code, 0);

  const ship = runCli(['ship', '--tranche', 'T1', '--root', root]);
  assert.equal(ship.code, 0, `ship failed: ${ship.stderr}`);
  assert.match(ship.stdout, /T1 shipped/);
  // Soft review-before-ship reminder on stdout; never blocks.
  assert.match(ship.stdout, /shipping freezes this tranche's scope/i);
  assert.match(ship.stdout, /adversarial review/i);
  assert.match(ship.stdout, /tranche-amend/);
});

test('a genuinely missing tranche resolves the id and is never double-prefixed', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);

  const r = runCli(['advance', '--tranche', 'T9', '--to', 'READY', '--root', root]);
  assert.notEqual(r.code, 0);
  // advance's not-found comes from the store, which keys on the normalized bare
  // id ("9"). The point is the input "T9" resolved to "9" (not "T9"/"TT9").
  assert.match(r.stderr, /Tranche 9 not found/);
  assert.ok(!r.stderr.includes('TT9'), 'error message must not double-prefix');
});

// ---- e2e: carry-forward concerns (T2) ------------------------------------

async function seedSingle(root) {
  const state = defaultTranches();
  startFeature(state, {
    feature: 'feat',
    docRoot: 'docs/feat',
    charterPath: 'docs/feat/charter.md',
    specPath: 'docs/feat/spec.md',
    tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
  });
  await writeTranches(root, state);
}

test('concern add → list → resolve round-trips through the CLI', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);

  const add = runCli(['concern', 'add', '--text', 'normalize URL params downstream', '--target', 'T2', '--root', root]);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /concern #1 recorded \(target T2\)/);

  const list1 = runCli(['concern', 'list', '--root', root]);
  assert.match(list1.stdout, /open: 1, resolved: 0/);
  assert.match(list1.stdout, /#1 \[open\] → T2 \(raised by T1\): normalize URL params downstream/);

  // `status` must also surface the open concern (deliverable C).
  const status = runCli(['status', '--root', root]);
  assert.match(status.stdout, /Carry-forward concerns \(open: 1\):/);
  assert.match(status.stdout, /#1 → T2 \(raised by T1\): normalize URL params downstream/);

  const res = runCli(['concern', 'resolve', '--id', '1', '--note', 'done in T2', '--root', root]);
  assert.equal(res.code, 0, res.stderr);

  const list2 = runCli(['concern', 'list', '--root', root]);
  assert.match(list2.stdout, /open: 0, resolved: 1/);
  assert.match(list2.stdout, /#1 \[resolved/);
});

test('concern add without --text errors', async (t) => {
  const root = freshProjectRoot(t);
  await seedFeature(root);
  const r = runCli(['concern', 'add', '--root', root]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--text required/);
});

test('finalize is hard-blocked by an open concern; passes once resolved', async (t) => {
  const root = freshProjectRoot(t);
  await seedSingle(root);
  // Drive the single tranche to SHIPPED → workflow COMPLETING.
  runCli(['advance', '--tranche', '1', '--to', 'READY', '--root', root]);
  runCli(['checklist-done', '--tranche', '1', '--root', root]);
  runCli(['advance', '--tranche', '1', '--to', 'IN-FLIGHT', '--root', root]);
  runCli(['concern', 'add', '--text', 'must address before close', '--root', root]);
  runCli(['ship', '--tranche', '1', '--root', root]);

  const blocked = runCli(['finalize', '--root', root]);
  assert.notEqual(blocked.code, 0, 'finalize must refuse with an open concern');
  assert.match(blocked.stderr, /open carry-forward concern/i);

  runCli(['concern', 'resolve', '--id', '1', '--root', root]);
  const ok = runCli(['finalize', '--root', root]);
  assert.equal(ok.code, 0, `finalize should pass once resolved: ${ok.stderr}`);
  assert.match(ok.stdout, /finalized/);
});

test('finalize --force abandons open concerns loudly', async (t) => {
  const root = freshProjectRoot(t);
  await seedSingle(root);
  runCli(['advance', '--tranche', '1', '--to', 'READY', '--root', root]);
  runCli(['checklist-done', '--tranche', '1', '--root', root]);
  runCli(['advance', '--tranche', '1', '--to', 'IN-FLIGHT', '--root', root]);
  runCli(['concern', 'add', '--text', 'abandon this one', '--root', root]);

  const forced = runCli(['finalize', '--force', '--root', root]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stderr, /abandoning 1 open carry-forward concern/i);
  assert.match(forced.stderr, /#1: abandon this one/);
});

// ---- e2e: ship soft-gate on "open questions before ship" (T3) -------------

test('ship warns on unresolved before-ship questions but still ships (soft gate)', async (t) => {
  const root = freshProjectRoot(t);
  const docRel = 'docs/t1.md';
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  // Impl questions empty (so checklist-done passes); before-ship has 2 unchecked.
  await fs.writeFile(path.join(root, docRel), [
    '# Tranche 1',
    '## Open questions before implementation',
    '- (none)',
    '## Pre-implementation checklist',
    '- [x] done',
    '## Open questions before ship',
    '- [ ] batch the writes?',
    '- [ ] index covers new query?',
    '## Verification gates',
    '- [x] g1',
    '',
  ].join('\n'), 'utf8');

  const state = defaultTranches();
  startFeature(state, {
    feature: 'feat',
    docRoot: 'docs',
    charterPath: 'docs/charter.md',
    specPath: 'docs/spec.md',
    tranches: [{ id: '1', title: 'T1', doc_path: docRel, scope: ['src/a.ts'], depends_on: [] }],
  });
  await writeTranches(root, state);

  runCli(['advance', '--tranche', '1', '--to', 'READY', '--root', root]);
  runCli(['checklist-done', '--tranche', '1', '--root', root]);
  runCli(['advance', '--tranche', '1', '--to', 'IN-FLIGHT', '--root', root]);

  const ship = runCli(['ship', '--tranche', '1', '--root', root]);
  assert.equal(ship.code, 0, 'soft gate: ship still succeeds');
  assert.match(ship.stdout, /T1 shipped/);
  assert.match(ship.stderr, /2 open questions before ship unresolved/);
  assert.match(ship.stderr, /escalate each to a carry-forward concern/);
});

test('ship emits no before-ship warning when the section is clean', async (t) => {
  const root = freshProjectRoot(t);
  const docRel = 'docs/t1.md';
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, docRel), [
    '# Tranche 1',
    '## Open questions before implementation',
    '- (none)',
    '## Pre-implementation checklist',
    '- [x] done',
    '## Open questions before ship',
    '- [x] resolved before shipping',
    '## Verification gates',
    '- [x] g1',
    '',
  ].join('\n'), 'utf8');

  const state = defaultTranches();
  startFeature(state, {
    feature: 'feat', docRoot: 'docs', charterPath: 'docs/charter.md', specPath: 'docs/spec.md',
    tranches: [{ id: '1', title: 'T1', doc_path: docRel, scope: ['src/a.ts'], depends_on: [] }],
  });
  await writeTranches(root, state);

  runCli(['advance', '--tranche', '1', '--to', 'READY', '--root', root]);
  runCli(['checklist-done', '--tranche', '1', '--root', root]);
  runCli(['advance', '--tranche', '1', '--to', 'IN-FLIGHT', '--root', root]);
  const ship = runCli(['ship', '--tranche', '1', '--root', root]);
  assert.equal(ship.code, 0, ship.stderr);
  assert.ok(!ship.stderr.includes('before ship'), 'no before-ship warning when all resolved');
});
