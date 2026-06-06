// Tests for lib/promotion/contradictions.mjs (Phase 10 heuristic detector).
//
// Coverage targets:
//   - detectContradictions: always/never, prefer/avoid, must/must-not,
//     required/forbidden — flagged when scope overlaps + keywords share.
//   - Non-overlapping scope ([node:a] vs [node:b]) → not flagged.
//   - No keyword overlap → not flagged (avoid false positives on neutral
//     language).
//   - markContradicted: writes contradicted=true onto stats.rule_fires for
//     each side of every conflict pair.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCerebrum, lineHash } from '../lib/stores/cerebrum.mjs';
import { defaultStats } from '../lib/stores/stats.mjs';
import {
  detectContradictions,
  markContradicted,
  CONTRADICTION_PAIRS,
} from '../lib/promotion/contradictions.mjs';

// -- structural pair coverage ----------------------------------------------

test('CONTRADICTION_PAIRS: includes the four canonical pairs from spec', () => {
  // Spec calls out always/never, prefer/avoid, must/must-not,
  // required/forbidden as the documented surface. We assert each
  // appears in the pair list.
  const allPatternsAsString = CONTRADICTION_PAIRS.flat().map((re) => re.source).join('|');
  assert.ok(/always/i.test(allPatternsAsString), 'always pattern');
  assert.ok(/never/i.test(allPatternsAsString), 'never pattern');
  assert.ok(/prefer/i.test(allPatternsAsString), 'prefer pattern');
  assert.ok(/avoid/i.test(allPatternsAsString), 'avoid pattern');
  assert.ok(/must/i.test(allPatternsAsString), 'must pattern');
  assert.ok(/required/i.test(allPatternsAsString), 'required pattern');
  assert.ok(/forbidden/i.test(allPatternsAsString), 'forbidden pattern');
});

// -- always / never ---------------------------------------------------------

test('detectContradictions: always X vs never X, both [!global] → flagged', () => {
  const text = [
    '- 2026-05-10: [!global] Always use Temporal API for dates',
    '- 2026-05-10: [!global] Never use Temporal API for dates',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].reason, /always.*never|never.*always/i);
  assert.equal(conflicts[0].line_a.body, 'Always use Temporal API for dates');
  assert.equal(conflicts[0].line_b.body, 'Never use Temporal API for dates');
});

test('detectContradictions: always X vs never X, both [node:same-path] → flagged', () => {
  const text = [
    '- 2026-05-10: [node:src/api/auth.ts] Always validate JWT signatures',
    '- 2026-05-10: [node:src/api/auth.ts] Never validate JWT signatures',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

test('detectContradictions: [!global] vs [node:path] → NOT flagged (node compared only against same-file rules)', () => {
  const text = [
    '- 2026-05-10: [!global] Always use prettier for formatting',
    '- 2026-05-10: [node:src/foo.ts] Never use prettier for formatting',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 0);
});

// -- keyword-scoped rules (the tier the docs steer toward) ------------------

test('detectContradictions: always X vs never X, both [kw:] with shared keywords → flagged', () => {
  const text = [
    '- 2026-05-10: [kw:deploy,production] Always deploy to production after a merge',
    '- 2026-05-10: [kw:deploy,production] Never deploy to production on a friday',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

test('detectContradictions: [!global] vs [kw:] same content → flagged', () => {
  const text = [
    '- 2026-05-10: [!global] Always validate webhook signatures before processing',
    '- 2026-05-10: [kw:webhook,signature] Never validate webhook signatures before processing',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

// -- prefer / avoid ---------------------------------------------------------

test('detectContradictions: prefer X vs avoid X → flagged', () => {
  const text = [
    '- 2026-05-10: [!global] Prefer async/await syntax for promises',
    '- 2026-05-10: [!global] Avoid async/await syntax for promises',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

// -- must / must not --------------------------------------------------------

test('detectContradictions: must X vs must not X → flagged', () => {
  const text = [
    '- 2026-05-10: [!global] You must validate inputs before processing',
    '- 2026-05-10: [!global] You must not validate inputs before processing',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

// -- required / forbidden ---------------------------------------------------

test('detectContradictions: required vs forbidden → flagged', () => {
  const text = [
    '- 2026-05-10: [!global] Logging is required for failed authentication',
    '- 2026-05-10: [!global] Logging is forbidden for failed authentication',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 1);
});

// -- scope non-overlap ------------------------------------------------------

test('detectContradictions: non-overlapping scope (different node paths) → NOT flagged', () => {
  const text = [
    '- 2026-05-10: [node:src/a.ts] Always validate inputs',
    '- 2026-05-10: [node:src/b.ts] Never validate inputs',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 0);
});

test('detectContradictions: same body shape but no shared keyword → NOT flagged', () => {
  // Both rules use "always" / "never" but the rest of the bodies don't
  // overlap meaningfully. We rely on the keyword filter to skip these.
  const text = [
    '- 2026-05-10: [!global] Always lubricate the gears',
    '- 2026-05-10: [!global] Never sharpen the rapiers',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 0);
});

test('detectContradictions: same direction (both always) → NOT flagged', () => {
  // Two rules saying the same thing — agreement, not contradiction.
  const text = [
    '- 2026-05-10: [!global] Always use Temporal API for dates',
    '- 2026-05-10: [!global] Always use Temporal API for time values',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const conflicts = detectContradictions(parsed);
  assert.equal(conflicts.length, 0);
});

test('detectContradictions: empty cerebrum → []', () => {
  const parsed = parseCerebrum('');
  assert.deepEqual(detectContradictions(parsed), []);
});

test('detectContradictions: single rule → []', () => {
  const parsed = parseCerebrum('- 2026-05-10: [!global] Always something\n');
  assert.deepEqual(detectContradictions(parsed), []);
});

// -- markContradicted -------------------------------------------------------

test('markContradicted: flips contradicted=true on both sides of each conflict', () => {
  const text = [
    '- 2026-05-10: [!global] Always run prettier on save',
    '- 2026-05-10: [!global] Never run prettier on save',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const stats = defaultStats();
  const hA = lineHash(parsed.lines[0].raw);
  const hB = lineHash(parsed.lines[1].raw);
  // Pre-seed rule_fires for one of them to exercise both code paths
  // (existing entry + brand-new entry).
  stats.rule_fires[hA] = { fires: 5, contradicted: false, last_fired: '2026-05-10T00:00:00Z' };

  const count = markContradicted(stats, parsed);
  assert.equal(count, 1, 'one pair flagged');
  assert.equal(stats.rule_fires[hA].contradicted, true);
  assert.equal(stats.rule_fires[hB].contradicted, true);
  assert.equal(stats.rule_fires[hB].fires, 0, 'newly-created entry has 0 fires');
});

test('markContradicted: idempotent — running twice doesnt change anything', () => {
  const text = [
    '- 2026-05-10: [!global] Always run prettier on save',
    '- 2026-05-10: [!global] Never run prettier on save',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const stats = defaultStats();
  markContradicted(stats, parsed);
  const snapshot = JSON.parse(JSON.stringify(stats.rule_fires));
  markContradicted(stats, parsed);
  assert.deepEqual(stats.rule_fires, snapshot);
});

test('markContradicted: empty cerebrum → 0 pairs, no mutation', () => {
  const stats = defaultStats();
  const count = markContradicted(stats, parseCerebrum(''));
  assert.equal(count, 0);
  assert.deepEqual(stats.rule_fires, {});
});
