// Tests for lib/capture/structural-gate.mjs — the Phase 7 structural gate over
// cerebrum-write candidate lines.
//
//   - checkSchema: anchored regex; missing colon; non-rule lines skip.
//   - checkSpecificity: body length ≥ 20.
//   - checkRedundancy: Lunr score against existing corpus.
//   - checkProvenance: mandatory ([!]) rules need a (by:) suffix.
//   - runAllChecks: aggregate behaviour over a mixed batch.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSchema,
  checkSpecificity,
  checkRedundancy,
  checkProvenance,
  runAllChecks,
  buildSingleLineIndex,
  _internals,
} from '../lib/capture/structural-gate.mjs';
import { parseCerebrum } from '../lib/stores/cerebrum.mjs';

// Helper: parse one line into the structural-gate's canonical shape.
function parseLine(line) {
  const parsed = parseCerebrum(line);
  if (!parsed || !parsed.lines || parsed.lines.length === 0) return null;
  const e = parsed.lines[0];
  return e && e.kind === 'rule' ? e : null;
}

// -- checkSchema ------------------------------------------------------------

test('checkSchema: well-formed dated rule with node bucket passes', () => {
  const r = checkSchema('- 2026-05-10: [node:foo.ts] some rule body');
  assert.equal(r.ok, true);
});

test('checkSchema: well-formed mandatory rule passes', () => {
  const r = checkSchema('- 2026-05-10: [!] [!global] mandatory body (by: sess-1)');
  assert.equal(r.ok, true);
});

test('checkSchema: the anchor parses a stray [ai-provisional] token as a bucket, not body', () => {
  const r = checkSchema('- 2026-05-10: [ai-provisional] [node:foo.ts] a thought long enough to pass');
  assert.equal(r.ok, true);
});

test('checkSchema: dated rule missing colon fails with reason', () => {
  const r = checkSchema('- 2026-05-10 [node:foo.ts] body without colon');
  assert.equal(r.ok, false);
  assert.match(r.reason, /schema:/);
  assert.match(r.reason, /colon/i);
});

test('checkSchema: non-zero-padded date fails', () => {
  const r = checkSchema('- 2026-5-1: [node:foo.ts] sloppy date');
  assert.equal(r.ok, false);
  assert.match(r.reason, /YYYY-MM-DD|date/i);
});

test('checkSchema: no-prefix dated line passes (auto-tagger handles post-write)', () => {
  const r = checkSchema('- 2026-05-10: A long enough body with no bucket prefix');
  assert.equal(r.ok, true);
});

test('checkSchema: plain list item passes (auto-tagger dates + tags it post-write)', () => {
  const r = checkSchema('- just a note no date');
  assert.equal(r.ok, true);
});

test('checkSchema: non-list-item prose passes', () => {
  const r1 = checkSchema('just a string of text');
  const r2 = checkSchema('## A heading');
  const r3 = checkSchema('');
  const r4 = checkSchema('<!-- comment -->');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(r4.ok, true);
});

test('checkSchema: non-string input passes (defensive)', () => {
  const r = checkSchema(null);
  assert.equal(r.ok, true);
});

// cerebrum-v2 (T5): the anchor recognizes the v2 token set ([global], [kw:…],
// [provisional]) — a CLARITY alignment of the captured prefix. checkSchema was
// already permissive (the prefix group is optional + the regex end-unanchored),
// so these rules passed before too; this asserts the capture now reflects them.
test('checkSchema: v2 rules (global/kw/provisional prefixes) pass', () => {
  assert.equal(checkSchema('- 2026-05-10: [global] [!] some sufficiently long global rule body (by: s)').ok, true);
  assert.equal(checkSchema('- 2026-05-10: [kw:deploy,ship] [!] never deploy on a friday afternoon (by: s)').ok, true);
  assert.equal(checkSchema('- 2026-05-10: [provisional] a tentative rule that is long enough to pass').ok, true);
});

test('RULE_ANCHOR: captures the v2 token prefix (not a zero-token match)', () => {
  const m = '- 2026-05-10: [global] [kw:deploy] [provisional] [!] body here'.match(_internals.RULE_ANCHOR);
  assert.ok(m, 'must match');
  const prefix = m[1];
  assert.match(prefix, /\[global\]/);
  assert.match(prefix, /\[kw:deploy\]/);
  assert.match(prefix, /\[provisional\]/);
});

// -- checkSpecificity -------------------------------------------------------

test('checkSpecificity: body < 20 chars fails', () => {
  const line = '- 2026-05-10: [node:f.ts] be careful';
  const parsed = parseLine(line);
  const r = checkSpecificity(line, parsed);
  assert.equal(r.ok, false);
  assert.match(r.reason, /specificity/);
  assert.match(r.reason, /chars/);
});

test('checkSpecificity: body exactly 20 chars passes (boundary inclusive)', () => {
  const body = 'A'.repeat(20);
  const line = `- 2026-05-10: [node:f.ts] ${body}`;
  const parsed = parseLine(line);
  assert.equal(parsed.body.length, 20);
  const r = checkSpecificity(line, parsed);
  assert.equal(r.ok, true);
});

test('checkSpecificity: long body passes', () => {
  const line = '- 2026-05-10: [node:f.ts] A long enough rule body explaining things in detail';
  const parsed = parseLine(line);
  const r = checkSpecificity(line, parsed);
  assert.equal(r.ok, true);
});

test('checkSpecificity: non-rule (parsed=null) passes', () => {
  const r = checkSpecificity('just prose', null);
  assert.equal(r.ok, true);
});

// -- checkRedundancy --------------------------------------------------------

test('checkRedundancy: duplicate body against a single-rule corpus fails', () => {
  const corpusBody = 'avoid logging secrets in production code paths';
  const env = buildSingleLineIndex([{ id: 'a', body: corpusBody }]);
  const proposedLine = `- 2026-05-10: [node:f.ts] ${corpusBody}`;
  const parsed = parseLine(proposedLine);
  const r = checkRedundancy(proposedLine, parsed, env);
  assert.equal(r.ok, false, `expected redundancy fail; got ${JSON.stringify(r)}`);
  assert.match(r.reason, /redundancy/);
});

test('checkRedundancy: unrelated body passes against a single-rule corpus', () => {
  const env = buildSingleLineIndex([
    { id: 'a', body: 'avoid logging secrets in production code paths' },
  ]);
  const proposedLine = '- 2026-05-10: [node:other.ts] unrelated cooking metaphor with fresh basil leaves';
  const parsed = parseLine(proposedLine);
  const r = checkRedundancy(proposedLine, parsed, env);
  assert.equal(r.ok, true, `expected redundancy pass; got ${JSON.stringify(r)}`);
});

test('checkRedundancy: no corpus (null envelope) passes', () => {
  const proposedLine = '- 2026-05-10: [node:f.ts] some body text long enough to count';
  const parsed = parseLine(proposedLine);
  const r = checkRedundancy(proposedLine, parsed, null);
  assert.equal(r.ok, true);
});

test('checkRedundancy: empty corpus (buildSingleLineIndex returns null) passes', () => {
  const env = buildSingleLineIndex([]);
  assert.equal(env, null);
  const proposedLine = '- 2026-05-10: [node:f.ts] some body text long enough to count';
  const parsed = parseLine(proposedLine);
  const r = checkRedundancy(proposedLine, parsed, env);
  assert.equal(r.ok, true);
});

test('checkRedundancy: identifier-heavy body with Lunr-meaningful chars does not throw', () => {
  const env = buildSingleLineIndex([{ id: 'a', body: 'unrelated body content' }]);
  // body contains Lunr-special chars (`:` `+` etc.) — the implementation strips
  // them before search().
  const proposedLine = '- 2026-05-10: [node:f.ts] foo:bar+baz auth+token (special chars)';
  const parsed = parseLine(proposedLine);
  const r = checkRedundancy(proposedLine, parsed, env);
  // Either ok or not — main goal is no throw. We assert it's a defined object.
  assert.equal(typeof r.ok, 'boolean');
});

// -- checkProvenance --------------------------------------------------------

test('checkProvenance: mandatory rule without (by:) fails', () => {
  const line = '- 2026-05-10: [!] [node:foo.ts] mandatory thing without provenance';
  const parsed = parseLine(line);
  const r = checkProvenance(line, parsed);
  assert.equal(r.ok, false);
  assert.match(r.reason, /provenance/);
  assert.match(r.reason, /by:/);
});

test('checkProvenance: mandatory rule with (by:) passes', () => {
  const line = '- 2026-05-10: [!] [node:foo.ts] mandatory thing with provenance (by: sess-abc)';
  const parsed = parseLine(line);
  const r = checkProvenance(line, parsed);
  assert.equal(r.ok, true);
});

test('checkProvenance: non-mandatory rule passes regardless of (by:)', () => {
  const line = '- 2026-05-10: [node:foo.ts] non-mandatory body, no provenance needed';
  const parsed = parseLine(line);
  const r = checkProvenance(line, parsed);
  assert.equal(r.ok, true);
});

// cerebrum-v2 T4: the `[match: <regex>]` field was deleted (charter anchor #8).
// It is no longer parsed or validated — a mandatory rule with `[match:]`-shaped
// text in its body now passes provenance on the strength of `(by:)` alone,
// even for what used to be a ReDoS-prone pattern. The write-protection
// capability moved to the runtime [!] write-gate (see test/write-gate.test.mjs).
test('checkProvenance: legacy [match:]-looking text no longer triggers a regex check', () => {
  const line = '- 2026-05-10: [!] [!global] redos-looking text (by: sess-1) [match: (a+)+$]';
  const parsed = parseLine(line);
  const r = checkProvenance(line, parsed);
  assert.equal(r.ok, true);
});

test('checkProvenance: non-rule (parsed=null) passes', () => {
  const r = checkProvenance('prose', null);
  assert.equal(r.ok, true);
});

// -- runAllChecks aggregator ------------------------------------------------

test('runAllChecks: empty input returns ok with no failures', () => {
  const r = runAllChecks([]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.failures, []);
});

test('runAllChecks: mixed pass/fail batch returns the right failure shape', () => {
  const env = buildSingleLineIndex([{ id: 'a', body: 'a known existing rule body content here' }]);
  const lines = [
    '- 2026-05-10: [node:foo.ts] valid body that is long enough to pass specificity', // pass
    '- 2026-05-10: [node:foo.ts] short body',                                          // specificity fail
    '- 2026-05-10 [node:foo.ts] missing colon and long enough body',                  // schema fail
    '- 2026-05-10: [!] [node:foo.ts] mandatory without provenance suffix here',        // provenance fail
    '- 2026-05-10: [node:foo.ts] a known existing rule body content here',             // redundancy fail
    '',                                                                                // blank: skip
    '## A heading',                                                                    // non-rule: skip
  ];
  const r = runAllChecks(lines, { existingLunrIndex: env, today: '2026-05-10' });
  assert.equal(r.ok, false);
  // Check that every kind of failure landed at least once.
  const kinds = new Set(r.failures.map((f) => f.check));
  assert.ok(kinds.has('specificity'), `expected specificity failure; got ${[...kinds]}`);
  assert.ok(kinds.has('schema'), `expected schema failure; got ${[...kinds]}`);
  assert.ok(kinds.has('provenance'), `expected provenance failure; got ${[...kinds]}`);
  assert.ok(kinds.has('redundancy'), `expected redundancy failure; got ${[...kinds]}`);
  // Every failure has a non-empty reason + carries the line that triggered it.
  for (const f of r.failures) {
    assert.equal(typeof f.line, 'string');
    assert.equal(typeof f.check, 'string');
    assert.equal(typeof f.reason, 'string');
    assert.ok(f.reason.length > 0);
  }
});

test('runAllChecks: all-valid batch returns ok', () => {
  const lines = [
    '- 2026-05-10: [node:foo.ts] a perfectly valid rule body long enough to pass',
    '- 2026-05-10: [node:bar.ts] another rule with different body content here',
    '- a plain undated note (auto-tagger handles this post-write)',
    '',
  ];
  const r = runAllChecks(lines, { existingLunrIndex: null, today: '2026-05-10' });
  assert.equal(r.ok, true, `expected ok; got failures=${JSON.stringify(r.failures)}`);
});

test('runAllChecks: internals expose tuneable constants', () => {
  assert.equal(typeof _internals.MIN_BODY_CHARS, 'number');
  assert.equal(typeof _internals.REDUNDANCY_THRESHOLD, 'number');
});
