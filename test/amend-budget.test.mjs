// Tests for lean-interventions T4 — the amend EDIT BUDGET. Pure helpers in
// lib/stores/tranches.mjs: budget normalization, TTL, file-scoping, the shared
// fileNeedsAmendment, and consume-with-re-freeze. (The pre-allows/post-consumes
// hook integration is covered in test/hooks.test.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readAmendmentBudget,
  amendmentExpired,
  budgetCoversFile,
  fileNeedsAmendment,
  consumeAmendmentEdit,
  openAmendment,
  AMENDMENT_TTL_MS,
} from '../lib/stores/tranches.mjs';

// A minimal active-feature state with one SHIPPED tranche (src/a.ts) and one STUB
// tranche (src/b.ts), charter frozen (past PLANNING).
function activeState(over = {}) {
  return {
    feature: 'feat',
    workflow_state: 'IMPLEMENTING',
    charter_path: 'docs/feat/charter.md',
    tranches: [
      { id: '1', title: 'T1', status: 'SHIPPED', scope: ['src/a.ts'] },
      { id: '2', title: 'T2', status: 'STUB', scope: ['src/b.ts'] },
    ],
    pending_amendment: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// readAmendmentBudget — normalization + back-compat
// ---------------------------------------------------------------------------

test('readAmendmentBudget: false → null', () => {
  assert.equal(readAmendmentBudget({ pending_amendment: false }), null);
  assert.equal(readAmendmentBudget({}), null);
});

test('readAmendmentBudget: legacy bare true → 1 edit, any file, no TTL', () => {
  assert.deepEqual(readAmendmentBudget({ pending_amendment: true }), {
    files: null, edits_remaining: 1, created_ts: null,
  });
});

test('readAmendmentBudget: object normalizes files/edits/ts', () => {
  assert.deepEqual(readAmendmentBudget({ pending_amendment: { files: ['x'], edits_remaining: 3, created_ts: '2026-06-13T00:00:00Z' } }), {
    files: ['x'], edits_remaining: 3, created_ts: '2026-06-13T00:00:00Z',
  });
  // empty files array → any-file (null)
  assert.deepEqual(readAmendmentBudget({ pending_amendment: { files: [], edits_remaining: 1 } }).files, null);
});

// ---------------------------------------------------------------------------
// amendmentExpired — TTL
// ---------------------------------------------------------------------------

test('amendmentExpired: null created_ts (legacy) never expires', () => {
  assert.equal(amendmentExpired({ created_ts: null }, '2030-01-01T00:00:00Z'), false);
});

test('amendmentExpired: within / past the TTL window', () => {
  const created = '2026-06-13T00:00:00.000Z';
  const within = new Date(Date.parse(created) + AMENDMENT_TTL_MS - 1000).toISOString();
  const past = new Date(Date.parse(created) + AMENDMENT_TTL_MS + 1000).toISOString();
  assert.equal(amendmentExpired({ created_ts: created }, within), false);
  assert.equal(amendmentExpired({ created_ts: created }, past), true);
});

// ---------------------------------------------------------------------------
// budgetCoversFile
// ---------------------------------------------------------------------------

test('budgetCoversFile: null files → any; list → membership', () => {
  assert.equal(budgetCoversFile({ files: null }, 'anything'), true);
  assert.equal(budgetCoversFile({ files: ['a', 'b'] }, 'a'), true);
  assert.equal(budgetCoversFile({ files: ['a', 'b'] }, 'c'), false);
});

// ---------------------------------------------------------------------------
// fileNeedsAmendment — the shared source of truth
// ---------------------------------------------------------------------------

test('fileNeedsAmendment: charter frozen past PLANNING', () => {
  const p = fileNeedsAmendment(activeState(), 'docs/feat/charter.md');
  assert.equal(p && p.kind, 'charter');
});

test('fileNeedsAmendment: charter NOT frozen during PLANNING', () => {
  assert.equal(fileNeedsAmendment(activeState({ workflow_state: 'PLANNING' }), 'docs/feat/charter.md'), null);
});

test('fileNeedsAmendment: shipped-scope file is protected', () => {
  const p = fileNeedsAmendment(activeState(), 'src/a.ts');
  assert.equal(p && p.kind, 'shipped');
  assert.match(p.reason, /SHIPPED/);
});

test('fileNeedsAmendment: pending-scope exemption (file also owned by a STUB tranche)', () => {
  // src/a.ts shipped in T1 but also claimed by a pending T3 → exempt.
  const s = activeState();
  s.tranches.push({ id: '3', title: 'T3', status: 'STUB', scope: ['src/a.ts'] });
  assert.equal(fileNeedsAmendment(s, 'src/a.ts'), null);
});

test('fileNeedsAmendment: unrelated file / IDLE → null', () => {
  assert.equal(fileNeedsAmendment(activeState(), 'src/unrelated.ts'), null);
  assert.equal(fileNeedsAmendment(activeState({ workflow_state: 'IDLE', feature: null }), 'src/a.ts'), null);
});

// ---------------------------------------------------------------------------
// consumeAmendmentEdit — decrement + re-freeze, fail toward re-freeze
// ---------------------------------------------------------------------------

test('consumeAmendmentEdit: 1-edit budget on a protected file decrements to re-freeze', () => {
  const s = activeState({ pending_amendment: { files: null, edits_remaining: 1, created_ts: null } });
  const consumed = consumeAmendmentEdit(s, 'src/a.ts', '2026-06-13T00:00:00Z');
  assert.equal(consumed, true);
  assert.equal(s.pending_amendment, false, 'budget exhausted → re-freeze');
});

test('consumeAmendmentEdit: multi-edit budget decrements but stays open until 0', () => {
  const s = activeState({ pending_amendment: { files: ['src/a.ts'], edits_remaining: 3, created_ts: '2026-06-13T00:00:00Z' } });
  consumeAmendmentEdit(s, 'src/a.ts', '2026-06-13T00:01:00Z');
  assert.equal(s.pending_amendment.edits_remaining, 2);
  consumeAmendmentEdit(s, 'src/a.ts', '2026-06-13T00:01:00Z');
  assert.equal(s.pending_amendment.edits_remaining, 1);
  consumeAmendmentEdit(s, 'src/a.ts', '2026-06-13T00:01:00Z');
  assert.equal(s.pending_amendment, false, 'third edit exhausts → re-freeze');
});

test('consumeAmendmentEdit: an edit to a NON-protected file does not spend budget', () => {
  const s = activeState({ pending_amendment: { files: null, edits_remaining: 1, created_ts: null } });
  const consumed = consumeAmendmentEdit(s, 'src/unrelated.ts', '2026-06-13T00:00:00Z');
  assert.equal(consumed, false);
  assert.deepEqual(s.pending_amendment, { files: null, edits_remaining: 1, created_ts: null }, 'budget intact');
});

test('consumeAmendmentEdit: a file outside the --files list does not spend budget', () => {
  const s = activeState({ pending_amendment: { files: ['src/b.ts'], edits_remaining: 2, created_ts: '2026-06-13T00:00:00Z' } });
  // src/a.ts is protected but NOT in the budget's files → not covered.
  const consumed = consumeAmendmentEdit(s, 'src/a.ts', '2026-06-13T00:01:00Z');
  assert.equal(consumed, false);
  assert.equal(s.pending_amendment.edits_remaining, 2);
});

test('consumeAmendmentEdit: an EXPIRED budget is cleared (re-freeze) without consuming', () => {
  const created = '2026-06-13T00:00:00.000Z';
  const past = new Date(Date.parse(created) + AMENDMENT_TTL_MS + 5000).toISOString();
  const s = activeState({ pending_amendment: { files: null, edits_remaining: 3, created_ts: created } });
  const consumed = consumeAmendmentEdit(s, 'src/a.ts', past);
  assert.equal(consumed, false);
  assert.equal(s.pending_amendment, false, 'expired → re-freeze');
});

// ---------------------------------------------------------------------------
// openAmendment
// ---------------------------------------------------------------------------

test('openAmendment: sets a scoped multi-edit budget; empty files → any-file', () => {
  const s = activeState();
  openAmendment(s, { files: ['src/a.ts', 'src/b.ts'], edits: 3, ts: '2026-06-13T00:00:00Z' });
  assert.deepEqual(s.pending_amendment, { files: ['src/a.ts', 'src/b.ts'], edits_remaining: 3, created_ts: '2026-06-13T00:00:00Z' });

  const s2 = activeState();
  openAmendment(s2, { files: null, edits: 1, ts: '2026-06-13T00:00:00Z' });
  assert.equal(s2.pending_amendment.files, null);
  assert.equal(s2.pending_amendment.edits_remaining, 1);
});
