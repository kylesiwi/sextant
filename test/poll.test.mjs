// test/poll.test.mjs — the shared bounded-poll primitive (lib/poll.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollUntil, sleep, POLL_DEFAULTS } from '../lib/poll.mjs';

test('pollUntil: returns the truthy value on the first call without waiting', async () => {
  let calls = 0;
  const start = Date.now();
  const r = await pollUntil(() => { calls++; return 'hit'; }, { budgetMs: 250 });
  assert.equal(r, 'hit');
  assert.equal(calls, 1, 'fn runs exactly once when it succeeds immediately');
  assert.ok(Date.now() - start < 50, 'no wait incurred on an immediate hit');
});

test('pollUntil: budgetMs 0 means a single immediate check, no waiting', async () => {
  let calls = 0;
  const r = await pollUntil(() => { calls++; return false; }, { budgetMs: 0 });
  assert.equal(r, false);
  assert.equal(calls, 1, 'fn runs once even with a zero budget');
});

test('pollUntil: catches a value that becomes truthy partway through the budget', async () => {
  let calls = 0;
  const r = await pollUntil(() => { calls++; return calls >= 3 ? 'late' : null; }, { budgetMs: 250, intervalMs: 10 });
  assert.equal(r, 'late');
  assert.ok(calls >= 3, 'polled until the value appeared');
});

test('pollUntil: returns the final falsy value once the budget elapses', async () => {
  const start = Date.now();
  const r = await pollUntil(() => false, { budgetMs: 60, intervalMs: 10 });
  assert.equal(r, false);
  assert.ok(Date.now() - start >= 55, 'waited roughly the full budget before giving up');
});

test('pollUntil: a throw from fn propagates (callers must catch inside fn)', async () => {
  await assert.rejects(() => pollUntil(() => { throw new Error('boom'); }, { budgetMs: 0 }), /boom/);
});

test('POLL_DEFAULTS are the bug-7-tuned transcript-flush values', () => {
  assert.deepEqual(POLL_DEFAULTS, { budgetMs: 250, intervalMs: 25 });
});

test('sleep resolves after roughly the requested delay', async () => {
  const start = Date.now();
  await sleep(30);
  assert.ok(Date.now() - start >= 25);
});
