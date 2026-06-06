// Tests for lib/stores/tranches.mjs — durable tranche state store.
//
// Pure mutator tests run in-memory. File I/O tests use isolated tmp dirs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  defaultTranches,
  readTranches,
  writeTranches,
  readTrancheDoc,
  startFeature,
  advanceTranche,
  setChecklistComplete,
  recordAmendment,
  finalizeFeature,
  recordCapture,
  resetSessionCaptures,
  activeTranche,
  tranchesByStatus,
  extractDeliverablesSummary,
  readTrancheDeliverables,
  extractUncheckedItems,
  readTrancheUnchecked,
  recordConcern,
  resolveConcern,
  openConcerns,
  TRANCHES_SCHEMA_VERSION,
} from '../lib/stores/tranches.mjs';

function freshTmpDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-tranches-' + crypto.randomUUID());
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

function makeState() {
  return defaultTranches();
}

function makeTranches() {
  return [
    { id: '1', title: 'Foundation', doc_path: 'tranches/t1.md', scope: ['src/a.ts'], depends_on: [] },
    { id: '2', title: 'Write flows', doc_path: 'tranches/t2.md', scope: ['src/b.ts'], depends_on: ['1'] },
    { id: '3', title: 'Payments', doc_path: 'tranches/t3.md', scope: ['src/c.ts'], depends_on: ['2'] },
  ];
}

// ---- defaultTranches -------------------------------------------------------

test('defaultTranches: returns expected shape', () => {
  const s = defaultTranches();
  assert.equal(s.schema_version, TRANCHES_SCHEMA_VERSION);
  assert.equal(s.feature, null);
  assert.equal(s.workflow_state, 'IDLE');
  assert.deepEqual(s.tranches, []);
  assert.deepEqual(s.amendments, []);
  assert.deepEqual(s.captures_this_session, { rules: 0, bugs: 0 });
  assert.equal(s.pending_amendment, false);
});

// ---- readTranches / writeTranches -----------------------------------------

test('readTranches: ENOENT returns defaults', async (t) => {
  const dir = freshTmpDir(t);
  await fs.mkdir(dir, { recursive: true });
  const s = await readTranches(dir);
  assert.equal(s.feature, null);
  assert.equal(s.workflow_state, 'IDLE');
});

test('readTranches: reads written data', async (t) => {
  const dir = freshTmpDir(t);
  await fs.mkdir(path.join(dir, '.sextant'), { recursive: true });
  const state = makeState();
  state.feature = 'test-feature';
  state.workflow_state = 'IMPLEMENTING';
  await writeTranches(dir, state);
  const read = await readTranches(dir);
  assert.equal(read.feature, 'test-feature');
  assert.equal(read.workflow_state, 'IMPLEMENTING');
});

// ---- startFeature ----------------------------------------------------------

test('startFeature: initializes state correctly', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'quotes',
    docRoot: 'docs/quotes',
    charterPath: 'docs/quotes/charter.md',
    specPath: 'docs/quotes/spec.md',
    tranches: makeTranches(),
  });
  assert.equal(s.feature, 'quotes');
  assert.equal(s.doc_root, 'docs/quotes');
  assert.equal(s.charter_path, 'docs/quotes/charter.md');
  assert.equal(s.spec_path, 'docs/quotes/spec.md');
  assert.equal(s.tranches.length, 3);
  assert.equal(s.active_tranche_id, '1');
  assert.equal(s.workflow_state, 'PLANNING');
});

test('startFeature: rejects when feature already active', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f1',
    docRoot: 'd',
    charterPath: 'c',
    specPath: 's',
    tranches: [{ id: '1', title: 't', scope: [] }],
  });
  assert.throws(() => {
    startFeature(s, {
      feature: 'f2',
      docRoot: 'd2',
      charterPath: 'c2',
      specPath: 's2',
      tranches: [{ id: '1', title: 't2', scope: [] }],
    });
  }, /must be IDLE/i);
});

// ---- advanceTranche --------------------------------------------------------

test('advanceTranche: STUB -> READY', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  assert.equal(s.tranches[0].status, 'READY');
  assert.equal(s.workflow_state, 'DETAILING');
});

test('advanceTranche: READY -> IN-FLIGHT requires checklist_complete', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  assert.throws(() => {
    advanceTranche(s, '1', 'IN-FLIGHT');
  }, /checklist/i);
});

test('advanceTranche: READY -> IN-FLIGHT with checklist_complete', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  assert.equal(s.tranches[0].status, 'IN-FLIGHT');
  assert.equal(s.workflow_state, 'IMPLEMENTING');
});

test('advanceTranche: rejects backward transitions', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  assert.throws(() => {
    advanceTranche(s, '1', 'STUB');
  }, /not forward/i);
});

test('advanceTranche: rejects skipping statuses', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  assert.throws(() => {
    advanceTranche(s, '1', 'IN-FLIGHT');
  }, /skip|invalid/i);
});

test('advanceTranche: rejects when depends_on not satisfied', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  assert.throws(() => {
    advanceTranche(s, '2', 'READY');
  }, /depend/i);
});

test('advanceTranche: IN-FLIGHT -> SHIPPED works', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  advanceTranche(s, '1', 'SHIPPED');
  assert.equal(s.tranches[0].status, 'SHIPPED');
  assert.ok(s.tranches[0].shipped_at);
});

test('advanceTranche: rejects unknown tranche id', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  assert.throws(() => {
    advanceTranche(s, '99', 'READY');
  }, /not found/i);
});

// ---- setChecklistComplete --------------------------------------------------

test('setChecklistComplete: sets the flag', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  setChecklistComplete(s, '1');
  assert.equal(s.tranches[0].checklist_complete, true);
});

// ---- finalizeFeature -------------------------------------------------------

function shipAll(s) {
  for (const id of ['1', '2', '3']) {
    advanceTranche(s, id, 'READY');
    setChecklistComplete(s, id);
    advanceTranche(s, id, 'IN-FLIGHT');
    advanceTranche(s, id, 'SHIPPED');
  }
}

test('finalizeFeature: COMPLETING resets state machine to IDLE defaults', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  shipAll(s);
  assert.equal(s.workflow_state, 'COMPLETING');

  finalizeFeature(s);

  assert.equal(s.feature, null);
  assert.equal(s.workflow_state, 'IDLE');
  assert.equal(s.active_tranche_id, null);
  assert.equal(s.charter_path, null);
  assert.deepEqual(s.tranches, []);
  assert.deepEqual(s, defaultTranches());
});

test('finalizeFeature: rejects when not COMPLETING without force', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  assert.throws(() => finalizeFeature(s), /must be COMPLETING/i);
  // state untouched
  assert.equal(s.feature, 'f');
});

test('finalizeFeature: force abandons a mid-flight feature', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  assert.equal(s.workflow_state, 'IMPLEMENTING');

  finalizeFeature(s, { force: true });
  assert.equal(s.feature, null);
  assert.equal(s.workflow_state, 'IDLE');
});

test('finalizeFeature: rejects when no active feature', () => {
  const s = makeState();
  assert.throws(() => finalizeFeature(s), /no active feature/i);
});

test('finalizeFeature: a new feature can be started after finalize', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f1', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  shipAll(s);
  finalizeFeature(s);
  // startFeature requires IDLE — this throws before the fix if state lingers.
  startFeature(s, {
    feature: 'f2', docRoot: 'd2', charterPath: 'c2', specPath: 's2',
    tranches: makeTranches(),
  });
  assert.equal(s.feature, 'f2');
  assert.equal(s.workflow_state, 'PLANNING');
});

// ---- recordAmendment -------------------------------------------------------

test('recordAmendment: appends to amendments array', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  recordAmendment(s, { trancheId: '1', text: 'Changed schema' });
  assert.equal(s.amendments.length, 1);
  assert.equal(s.amendments[0].text, 'Changed schema');
  assert.equal(s.amendments[0].tranche_id, '1');
  assert.ok(s.amendments[0].ts);
});

// ---- recordCapture / resetSessionCaptures ---------------------------------

test('recordCapture: increments rule counter', () => {
  const s = makeState();
  recordCapture(s, 'rule');
  assert.equal(s.captures_this_session.rules, 1);
  recordCapture(s, 'rule');
  assert.equal(s.captures_this_session.rules, 2);
});

test('recordCapture: increments bug counter', () => {
  const s = makeState();
  recordCapture(s, 'bug');
  assert.equal(s.captures_this_session.bugs, 1);
});

test('resetSessionCaptures: zeros both counters', () => {
  const s = makeState();
  recordCapture(s, 'rule');
  recordCapture(s, 'bug');
  resetSessionCaptures(s);
  assert.deepEqual(s.captures_this_session, { rules: 0, bugs: 0 });
});

// ---- activeTranche ---------------------------------------------------------

test('activeTranche: returns null when no active id', () => {
  const s = makeState();
  assert.equal(activeTranche(s), null);
});

test('activeTranche: returns matching tranche', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  const active = activeTranche(s);
  assert.equal(active.id, '1');
  assert.equal(active.title, 'Foundation');
});

// ---- tranchesByStatus ------------------------------------------------------

test('tranchesByStatus: filters by status', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'f', docRoot: 'd', charterPath: 'c', specPath: 's',
    tranches: makeTranches(),
  });
  advanceTranche(s, '1', 'READY');
  const ready = tranchesByStatus(s, 'READY');
  const stub = tranchesByStatus(s, 'STUB');
  assert.equal(ready.length, 1);
  assert.equal(stub.length, 2);
});

// ---- readTrancheDoc -------------------------------------------------------

test('readTrancheDoc: parses tranche markdown', async (t) => {
  const dir = freshTmpDir(t);
  const docDir = path.join(dir, 'docs', 'tranches');
  await fs.mkdir(docDir, { recursive: true });

  const doc = `# Tranche 1: Foundation

**Status**: IN-FLIGHT
**Depends on**: none
**Delivers**: Schema + read-only admin

---

## Open questions before implementation

## Locked deliverables

### A. Database schema
- Create quotes table
- Create installments table

### B. Admin page
- Read-only listing

## Floating details
- Found existing payments table

## Pre-implementation checklist
- [x] Grep run
- [x] Files accounted for
- [ ] Floating details updated

## Verification gates
- [x] A1: Schema created
- [ ] A2: Indexes added
- [x] B1: Admin page renders
- [ ] B2: Pagination works

## Spec amendments discovered
- (none yet)
`;
  await fs.writeFile(path.join(docDir, 'tranche-1-foundation.md'), doc, 'utf8');
  const parsed = await readTrancheDoc(dir, 'docs/tranches/tranche-1-foundation.md');

  assert.ok(parsed);
  assert.equal(parsed.open_questions_count, 0);
  assert.equal(parsed.checklist_total, 3);
  assert.equal(parsed.checklist_done, 2);
  assert.equal(parsed.verification_gates_total, 4);
  assert.equal(parsed.verification_gates_done, 2);
  assert.ok(Array.isArray(parsed.deliverables_summary));
  assert.ok(parsed.deliverables_summary.length > 0);
});

test('readTrancheDoc: returns null for missing file', async (t) => {
  const dir = freshTmpDir(t);
  await fs.mkdir(dir, { recursive: true });
  const parsed = await readTrancheDoc(dir, 'nonexistent.md');
  assert.equal(parsed, null);
});

// --- extractDeliverablesSummary (cheap slice extractor) ---

test('extractDeliverablesSummary: pulls ### titles under Locked deliverables', () => {
  const doc = `# T1
## Open questions before implementation
- q
## Locked deliverables
### A. Database schema
- create table
### B. Admin page
- listing
## Floating details
### NOT a deliverable
`;
  assert.deepEqual(extractDeliverablesSummary(doc), ['A. Database schema', 'B. Admin page']);
});

test('extractDeliverablesSummary: tolerates a suffixed header and runs to EOF', () => {
  const doc = `## Locked deliverables (FROZEN)
### Only deliverable
- detail`;
  assert.deepEqual(extractDeliverablesSummary(doc), ['Only deliverable']);
});

test('extractDeliverablesSummary: empty when section absent or input non-string', () => {
  assert.deepEqual(extractDeliverablesSummary('## Floating details\n### x'), []);
  assert.deepEqual(extractDeliverablesSummary(''), []);
  assert.deepEqual(extractDeliverablesSummary(null), []);
});

test('extractDeliverablesSummary: agrees with full readTrancheDoc parse', async (t) => {
  const dir = freshTmpDir(t);
  const docDir = path.join(dir, 'docs', 'tranches');
  await fs.mkdir(docDir, { recursive: true });
  const doc = `# T
## Locked deliverables
### A. First
### B. Second
## Verification gates
- [ ] g`;
  await fs.writeFile(path.join(docDir, 't.md'), doc, 'utf8');
  const parsed = await readTrancheDoc(dir, 'docs/tranches/t.md');
  assert.deepEqual(parsed.deliverables_summary, extractDeliverablesSummary(doc));
  assert.deepEqual(parsed.deliverables_summary, ['A. First', 'B. Second']);
});

// --- readTrancheDeliverables (focused per-turn read) ---

test('readTrancheDeliverables: reads titles live from a doc on disk', async (t) => {
  const dir = freshTmpDir(t);
  const docDir = path.join(dir, 'docs', 'tranches');
  await fs.mkdir(docDir, { recursive: true });
  await fs.writeFile(
    path.join(docDir, 't3.md'),
    '## Locked deliverables\n### A. Apply updates\n### B. Audit\n',
    'utf8',
  );
  const out = await readTrancheDeliverables(dir, 'docs/tranches/t3.md');
  assert.deepEqual(out, ['A. Apply updates', 'B. Audit']);
});

test('readTrancheDeliverables: empty array on missing file or missing args', async (t) => {
  const dir = freshTmpDir(t);
  await fs.mkdir(dir, { recursive: true });
  assert.deepEqual(await readTrancheDeliverables(dir, 'nope.md'), []);
  assert.deepEqual(await readTrancheDeliverables(null, 'x.md'), []);
  assert.deepEqual(await readTrancheDeliverables(dir, null), []);
});

// ---- Full lifecycle smoke test --------------------------------------------

test('full lifecycle: STUB -> READY -> IN-FLIGHT -> SHIPPED', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'quotes',
    docRoot: 'docs/quotes',
    charterPath: 'docs/quotes/charter.md',
    specPath: 'docs/quotes/spec.md',
    tranches: [
      { id: '1', title: 'Foundation', scope: ['src/a.ts'], depends_on: [] },
    ],
  });

  assert.equal(s.workflow_state, 'PLANNING');

  advanceTranche(s, '1', 'READY');
  assert.equal(s.workflow_state, 'DETAILING');

  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  assert.equal(s.workflow_state, 'IMPLEMENTING');

  advanceTranche(s, '1', 'SHIPPED');
  assert.equal(s.tranches[0].status, 'SHIPPED');
  assert.ok(s.tranches[0].shipped_at);
});

test('full lifecycle: multi-tranche with dependencies', () => {
  const s = makeState();
  startFeature(s, {
    feature: 'multi',
    docRoot: 'd',
    charterPath: 'c',
    specPath: 's',
    tranches: makeTranches(),
  });

  // T1: STUB -> READY -> IN-FLIGHT -> SHIPPED
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  advanceTranche(s, '1', 'SHIPPED');

  // Shipping T1 completes it and advances straight to the next tranche.
  assert.equal(s.active_tranche_id, '2');
  assert.equal(s.workflow_state, 'DETAILING');

  // T2 can now advance (depends on T1 which is SHIPPED)
  advanceTranche(s, '2', 'READY');
  setChecklistComplete(s, '2');
  advanceTranche(s, '2', 'IN-FLIGHT');

  assert.equal(s.tranches[1].status, 'IN-FLIGHT');

  // T3 still blocked (depends on T2)
  assert.throws(() => advanceTranche(s, '3', 'READY'), /depend/i);
});

// --- carry-forward concerns (T2) ------------------------------------------

function startedState() {
  const s = defaultTranches();
  startFeature(s, {
    feature: 'F',
    docRoot: 'docs/f',
    charterPath: 'docs/f/charter.md',
    specPath: 'docs/f/spec.md',
    tranches: [{ id: '1', title: 'T1', scope: [], depends_on: [] }],
  });
  return s; // active_tranche_id === '1'
}

test('carry_forward: defaultTranches seeds an empty array', () => {
  assert.deepEqual(defaultTranches().carry_forward, []);
});

test('recordConcern: monotonic ids, additive, never unlocks deny gates', () => {
  const s = startedState();
  const c1 = recordConcern(s, { text: '  first  ' });
  const c2 = recordConcern(s, { text: 'second', target: '4' });
  assert.equal(c1.id, '1');
  assert.equal(c2.id, '2');
  assert.equal(c1.text, 'first');           // trimmed
  assert.equal(c1.raised_by, '1');
  assert.equal(c1.status, 'open');
  assert.equal(c1.target, null);
  assert.equal(c2.target, '4');
  assert.equal(s.pending_amendment, false, 'a concern is metadata, not an edit');
  assert.equal(s.carry_forward.length, 2);
});

test('recordConcern: requires non-empty text', () => {
  const s = startedState();
  assert.throws(() => recordConcern(s, { text: '' }), /text required/i);
  assert.throws(() => recordConcern(s, { text: '   ' }), /text required/i);
  assert.throws(() => recordConcern(s, {}), /text required/i);
});

test('resolveConcern: flips status + stamps resolver; errors on unknown/already', () => {
  const s = startedState();
  recordConcern(s, { text: 'x' });
  const r = resolveConcern(s, { id: '1', note: 'addressed in follow-up' });
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolved_by, '1');
  assert.equal(r.note, 'addressed in follow-up');
  assert.ok(r.resolved_at);
  assert.throws(() => resolveConcern(s, { id: '1' }), /already resolved/i);
  assert.throws(() => resolveConcern(s, { id: '99' }), /not found/i);
});

test('openConcerns: returns only the open ones', () => {
  const s = startedState();
  recordConcern(s, { text: 'a' });
  recordConcern(s, { text: 'b' });
  resolveConcern(s, { id: '1' });
  assert.deepEqual(openConcerns(s).map((c) => c.id), ['2']);
});

test('finalizeFeature: blocked by an open concern, passes once resolved', () => {
  const s = startedState();
  s.workflow_state = 'COMPLETING';
  recordConcern(s, { text: 'must be consumed downstream' });
  assert.throws(() => finalizeFeature(s), /open carry-forward concern/i);
  resolveConcern(s, { id: '1' });
  finalizeFeature(s);
  assert.equal(s.feature, null, 'finalize wipes state once no concern is open');
});

test('finalizeFeature: --force abandons open concerns', () => {
  const s = startedState();
  s.workflow_state = 'COMPLETING';
  recordConcern(s, { text: 'abandon me' });
  finalizeFeature(s, { force: true });
  assert.equal(s.feature, null);
});

// --- T3: open questions before ship (parser + helpers) ---------------------

test('readTrancheDoc: counts unchecked "open questions before ship" separately', async (t) => {
  const dir = freshTmpDir(t);
  const docDir = path.join(dir, 'docs');
  await fs.mkdir(docDir, { recursive: true });
  const doc = `# Tranche 1
**Status**: IN-FLIGHT

## Open questions before implementation
- (none)

## Open questions before ship
- [ ] can we batch the writes?
- [x] resolved during impl
- [ ] does the index cover the new query?

## Verification gates
- [ ] g1
`;
  await fs.writeFile(path.join(docDir, 't.md'), doc, 'utf8');
  const parsed = await readTrancheDoc(dir, 'docs/t.md');
  assert.equal(parsed.open_questions_before_ship_count, 2, 'only unchecked before-ship items');
  assert.equal(parsed.open_questions_count, 0, 'impl questions are a separate bucket');
});

test('extractUncheckedItems: pulls "- [ ]" items under a named section, ignoring checked', () => {
  const content = `## Open questions before ship
- [ ] first
- [x] done
- [ ] second
## Verification gates
- [ ] not this one`;
  assert.deepEqual(extractUncheckedItems(content, 'open questions before ship'), ['first', 'second']);
});

test('extractUncheckedItems: empty for absent section or bad input', () => {
  assert.deepEqual(extractUncheckedItems('## Other\n- [ ] x', 'open questions before ship'), []);
  assert.deepEqual(extractUncheckedItems('', 'open questions before ship'), []);
  assert.deepEqual(extractUncheckedItems('## s\n- [ ] x', ''), []);
});

test('readTrancheUnchecked: reads a section live from disk', async (t) => {
  const dir = freshTmpDir(t);
  const docDir = path.join(dir, 'docs');
  await fs.mkdir(docDir, { recursive: true });
  await fs.writeFile(
    path.join(docDir, 't.md'),
    '## Open questions before ship\n- [ ] alpha\n- [ ] beta\n## Verification gates\n- [ ] g',
    'utf8',
  );
  assert.deepEqual(
    await readTrancheUnchecked(dir, 'docs/t.md', 'open questions before ship'),
    ['alpha', 'beta'],
  );
  assert.deepEqual(await readTrancheUnchecked(dir, 'missing.md', 'open questions before ship'), []);
});
