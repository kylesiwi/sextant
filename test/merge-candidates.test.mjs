// Tests for lean-interventions T7-A: the /sextant:review merge-candidate
// GENERATOR (lib/promotion/mergeCandidates.mjs).
//
// We test the generator only — recall (near-dups surface) and noise rejection
// (obviously-unrelated pairs don't) and the funnel caps (topN, symmetric dedup,
// hash present). The redundant-vs-complementary JUDGEMENT is the sextant-reviewer
// LLM's job (prose, not unit-tested), because BM25 provably can't make that call
// at cerebrum corpus sizes (T6).

import test from 'node:test';
import assert from 'node:assert/strict';

import { findMergeCandidates, MERGE_TOP_N } from '../lib/promotion/mergeCandidates.mjs';
import { parseCerebrum, lineHash } from '../lib/stores/cerebrum.mjs';

function rules(...lines) {
  return parseCerebrum(lines.join('\n')).lines.filter((e) => e.kind === 'rule');
}

test('T7-A: two near-duplicate rules surface as a candidate pair', () => {
  const entries = rules(
    '- 2026-01-01: [kw:booking] use santiagoToday and asDateOnly for booking dates never new Date because Vercel runs UTC',
    '- 2026-01-01: [kw:booking] for booking dates use santiagoToday asDateOnly not new Date since Vercel is UTC and breaks at midnight',
    '- 2026-01-01: [node:lib/graph/parser.mjs] tree-sitter wasm grammars load lazily and cache per language for the process',
  );
  const cands = findMergeCandidates(entries);
  assert.equal(cands.length, 1, `expected exactly the near-dup pair; got ${JSON.stringify(cands.map((c) => c.score))}`);
  const bodies = cands[0].rules.map((r) => r.body).join(' || ');
  assert.match(bodies, /santiagoToday/);
  assert.doesNotMatch(bodies, /tree-sitter/, 'the unrelated parser rule must not be in the pair');
});

test('T7-A: an obviously-unrelated store yields no candidates (below the noise floor)', () => {
  const entries = rules(
    '- 2026-01-01: [node:lib/a.mjs] keep this module pure and free of side effects',
    '- 2026-01-01: [kw:postgres] always parameterise queries to avoid injection vulnerabilities',
    '- 2026-01-01: [global] prefer composition over inheritance in new abstractions',
  );
  const cands = findMergeCandidates(entries);
  assert.deepEqual(cands, [], `unrelated rules must not cluster; got ${JSON.stringify(cands)}`);
});

test('T7-A: candidates carry the line_hash that /forget consumes', () => {
  // Realistic store variety (filler rules) so the near-dup pair's shared terms
  // carry meaningful IDF — a degenerate all-near-dup store scores everything low.
  const a = '- 2026-01-01: [kw:cache] invalidate the redis cache key on every write to the user profile record';
  const b = '- 2026-01-01: [kw:cache] on any write to the user profile record invalidate its redis cache key immediately';
  const entries = rules(
    a, b,
    '- 2026-01-01: [node:lib/graph/parser.mjs] tree-sitter grammars load lazily per language',
    '- 2026-01-01: [global] prefer composition over inheritance in fresh abstractions',
    '- 2026-01-01: [kw:postgres] parameterise every query to avoid sql injection vulnerabilities',
  );
  const cands = findMergeCandidates(entries);
  assert.equal(cands.length, 1, `expected the cache pair only; got ${JSON.stringify(cands.map((c) => c.score))}`);
  const hashes = cands[0].rules.map((r) => r.line_hash).sort();
  const expected = [lineHash(entries[0].raw), lineHash(entries[1].raw)].sort();
  assert.deepEqual(hashes, expected, 'each candidate rule must carry lineHash(raw)');
});

test('T7-A: output is capped at MERGE_TOP_N and symmetric pairs are de-duped', () => {
  // Build many near-duplicate pairs (more distinct pairs than the cap).
  const lines = [];
  for (let i = 0; i < MERGE_TOP_N + 4; i++) {
    lines.push(`- 2026-01-01: [kw:topic${i}] the quick brown fox subsystem ${i} jumps over the lazy dog handler alpha`);
    lines.push(`- 2026-01-01: [kw:topic${i}] subsystem ${i} the quick brown fox jumps over the lazy dog handler alpha beta`);
  }
  const cands = findMergeCandidates(rules(...lines));
  assert.ok(cands.length <= MERGE_TOP_N, `must cap at MERGE_TOP_N=${MERGE_TOP_N}; got ${cands.length}`);
  // No pair appears twice (A-B and B-A collapsed to one).
  const keys = cands.map((c) => c.rules.map((r) => r.line_hash).sort().join('::'));
  assert.equal(new Set(keys).size, keys.length, 'pairs must be symmetric-deduped');
  // Sorted by score descending.
  for (let i = 1; i < cands.length; i++) {
    assert.ok(cands[i - 1].score >= cands[i].score, 'candidates must be sorted by score desc');
  }
});

test('T7-A: a store with fewer than two rules yields no candidates', () => {
  assert.deepEqual(findMergeCandidates([]), []);
  assert.deepEqual(findMergeCandidates(rules('- 2026-01-01: [global] only one rule here in the whole store')), []);
});
