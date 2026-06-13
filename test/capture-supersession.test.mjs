// Tests for lean-interventions T6 (recalibrated): the cerebrum structural gate's
// redundancy DENY no longer false-positives on complementary / unrelated rules.
//
// Empirical finding (measured against the real cerebrum, recorded in the T6
// tranche doc): BM25 raw scores cannot separate "redundant" from "complementary"
// at cerebrum corpus sizes — genuinely complementary same-file rules score well
// above the old 0.85 floor, an unrelated rule scores ~2, while only a near-exact
// paraphrase scores ~15. The old floor denied essentially any new rule with
// incidental term overlap. T6 raises the floor above the complementary band and
// keeps Signal 1 (exact normalized-body match) as the reliable, corpus-size-
// independent deny. /remember itself appends via the `cerebrum` CLI (Bash), not
// an Edit/Write tool, so this gate only fires on direct cerebrum.md edits — the
// over-deny was latent, but real.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSingleLineIndex,
  runAllChecks,
  checkRedundancy,
  _internals,
} from '../lib/capture/structural-gate.mjs';
import { parseCerebrum, lineHash } from '../lib/stores/cerebrum.mjs';

// A multi-doc corpus of same-domain (hooks/cerebrum) rules — enough shared
// vocabulary that a complementary new rule scores well ABOVE the old 0.85 floor.
const CORPUS_RULES = [
  'The Edit/Write/MultiEdit permission card renders only the diff and a yes/no prompt to the user',
  'Read-context hygiene: the Read path emits only the mandatory rule floor composed once per turn',
  'composeWallpaperBlock computes import-edge degree from the graph for the file being edited',
  'mergeSystemMessage acquires its own withState lock so it never blocks the main hook return',
  'The Stop turn-summary reads rules-fired.jsonl to count how many node rules fired this turn',
  'listMandatoryFor filters on the bucket marker and exact-matches the node path for the file',
  'resetTurnAndSession clears the systemmessage fired flag on every Stop so the next turn is fresh',
  'The transcript-flush race means a concurrent read can observe a half-written turn-state file',
  'renderMandatoryRulesWithBudget trims long rule bodies tail-first to a floor with an ellipsis',
  'The auto-tagger runs on the PostToolUse pass and scopes an untagged rule to the edited file',
];
function makeIndex() {
  const entries = CORPUS_RULES.map((body) => ({ id: lineHash(body), body }));
  return buildSingleLineIndex(entries);
}
function parseLine(line) {
  const p = parseCerebrum(line);
  return p.lines.find((e) => e && e.kind === 'rule') ?? null;
}
function rawScore(env, body) {
  const safe = body.replace(/[+\-:~^*?"()[\]{}\\]/g, ' ').trim();
  let hits = [];
  try { hits = env.index.search(safe); } catch { hits = []; }
  return hits.length > 0 ? hits[0].score : 0;
}

test('T6: the recalibrated threshold sits above the complementary band', () => {
  assert.equal(typeof _internals.REDUNDANCY_THRESHOLD, 'number');
  assert.ok(_internals.REDUNDANCY_THRESHOLD >= 8,
    `threshold must clear the measured complementary band (~4.6); got ${_internals.REDUNDANCY_THRESHOLD}`);
});

test('T6 (gate #3/#4): a complementary same-domain rule scores above 0.85 but PASSES', () => {
  const env = makeIndex();
  // A genuinely new, complementary rule that shares vocabulary with the corpus
  // (Read path / mandatory rule floor / permission card / diff) but states a
  // different fact — exactly the case the old 0.85 floor false-denied.
  const line = '- 2026-06-13: [node:lib/hooks/preToolUse.mjs] the Read path mandatory rule floor is composed before the permission card diff is shown to the user';
  const parsed = parseLine(line);
  const score = rawScore(env, parsed.body);
  assert.ok(score > 0.85, `precondition: complementary rule must beat the OLD floor to prove the fix (score=${score})`);
  assert.ok(score < _internals.REDUNDANCY_THRESHOLD, `precondition: but stay below the new floor (score=${score})`);
  const r = checkRedundancy(line, parsed, env);
  assert.equal(r.ok, true, `complementary rule must PASS at the recalibrated floor; got ${JSON.stringify(r)}`);
});

test('T6 (gate #4): an unrelated rule PASSES (silence below floor)', () => {
  const env = makeIndex();
  const line = '- 2026-06-13: [kw:pnpm] always pin the pnpm version in the engines field before publishing the package to the registry';
  const parsed = parseLine(line);
  const r = checkRedundancy(line, parsed, env);
  assert.equal(r.ok, true, `unrelated rule must PASS; got ${JSON.stringify(r)}`);
});

test('T6 (gate #1): an EXACT duplicate is denied and the reason carries hash + body', () => {
  const env = makeIndex();
  const dupBody = CORPUS_RULES[0];
  const line = `- 2026-06-13: [node:other.ts] ${dupBody}`;
  const parsed = parseLine(line);
  const r = checkRedundancy(line, parsed, env);
  assert.equal(r.ok, false, 'exact dup must be denied (Signal 1, corpus-size-independent)');
  assert.match(r.reason, /redundancy/);
  assert.match(r.reason, new RegExp(`\\[${lineHash(dupBody)}\\]`), 'reason names the matched rule hash');
  assert.match(r.reason, /permission card renders only the diff/, 'reason carries the matched body');
});

// The BM25 backstop (Signal 2) fires only when the top score clears the floor.
// That score is corpus-size-dependent (on the real ~20-rule cerebrum a near-exact
// paraphrase scores ~15; on a tiny corpus it stays low), so we test the threshold
// CONTRACT deterministically with a stub index rather than a fragile synthetic
// paraphrase: a body that is NOT an exact match (Signal 1 silent) whose top BM25
// score exceeds the floor must be denied, naming the matched rule's hash.
test('T6 (gate #1): a BM25 score above the floor is denied and names the matched hash', () => {
  const stub = (score) => ({
    index: { search: () => [{ ref: 'abc123def456', score }] },
    docs: new Map([['abc123def456', { id: 'abc123def456', body: 'the existing matched rule body content' }]]),
  });
  const line = '- 2026-06-13: [node:x.ts] a brand new rule body that is not a byte-identical duplicate';
  const parsed = parseLine(line);

  const denied = checkRedundancy(line, parsed, stub(_internals.REDUNDANCY_THRESHOLD + 5));
  assert.equal(denied.ok, false, 'above-floor BM25 match must be denied');
  assert.match(denied.reason, /near-exact match/);
  assert.match(denied.reason, /\[abc123def456\]/, 'reason names the matched rule hash');
  assert.match(denied.reason, /the existing matched rule body/, 'reason carries the matched body');

  const passed = checkRedundancy(line, parsed, stub(_internals.REDUNDANCY_THRESHOLD - 1));
  assert.equal(passed.ok, true, 'below-floor BM25 match must PASS (no false positive)');
});

test('T6 (gate #2): no redundancy reason emits an imperative /forget', () => {
  const env = makeIndex();
  // Drive several denials and assert none train deletion with a `/forget <hash>`.
  const lines = [
    `- 2026-06-13: [node:x.ts] ${CORPUS_RULES[0]}`,            // exact dup
    `- 2026-06-13: [node:y.ts] ${CORPUS_RULES[1]} extra tail`, // near match
  ];
  const r = runAllChecks(lines, { existingLunrIndex: env, today: '2026-06-13' });
  for (const f of r.failures) {
    assert.doesNotMatch(f.reason, /\/forget/, 'redundancy reason must never emit an imperative /forget');
  }
});
