// Tests for lib/ledger/tokens.mjs — Phase 8 token estimation heuristic.
//
// We pin the exact rounding semantics so changes here are visible. The
// estimator is intentionally simple (Math.ceil(text.length / 4)) so the
// ledger ships dependency-free; § 10.10 documents the precision gap.

import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens, estimateForCodeFile } from '../lib/ledger/tokens.mjs';

test('estimateTokens: empty string returns 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('estimateTokens: single character rounds up to 1', () => {
  assert.equal(estimateTokens(' '), 1);
  assert.equal(estimateTokens('a'), 1);
});

test('estimateTokens: "hello" (5 chars) → ceil(5/4) === 2', () => {
  assert.equal(estimateTokens('hello'), 2);
});

test('estimateTokens: 4-char chunks are exact', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});

test('estimateTokens: 3-char input rounds up', () => {
  assert.equal(estimateTokens('abc'), 1);
});

test('estimateTokens: 5-char input rounds up', () => {
  assert.equal(estimateTokens('abcde'), 2);
});

test('estimateTokens: long text gets a linear estimate', () => {
  const text = 'lorem ipsum dolor sit amet '.repeat(100); // 2700 chars
  const got = estimateTokens(text);
  assert.equal(got, Math.ceil(text.length / 4));
  assert.ok(got > 600 && got < 700, `expected ~675, got ${got}`);
});

test('estimateTokens: non-string input returns 0 (defensive)', () => {
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(42), 0);
  assert.equal(estimateTokens({}), 0);
});

test('estimateForCodeFile: same heuristic in v1 (per § 10.10 disclosure)', () => {
  // estimateForCodeFile is a forward-looking hook; v1 just proxies
  // estimateTokens so the ledger's call sites pick up a future code-tuned
  // ratio by changing one function instead of every caller.
  const sample = 'const x = 1;\nconst y = 2;\n';
  assert.equal(estimateForCodeFile(sample), estimateTokens(sample));
});
