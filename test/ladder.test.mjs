// Tests for lib/promotion/ladder.mjs (Phase 10 promotion ladder).
//
// Coverage targets:
//   - listPromotionCandidates: fires >= threshold + !contradicted yields a
//     candidate; contradicted rules are excluded; already-mandatory rules
//     are excluded; rules missing from the cerebrum are excluded.
//   - listDemoteCandidates: low fire ratio AND stale last_fired yields a
//     candidate; recently-fired rules with low ratio are NOT demoted.
//   - summarizeReviewQueue: aggregate shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCerebrum,
  lineHash,
} from '../lib/stores/cerebrum.mjs';
import { defaultStats, incrementRuleFire } from '../lib/stores/stats.mjs';
import {
  listPromotionCandidates,
  listDemoteCandidates,
  summarizeReviewQueue,
  DEMOTION_OPPORTUNITY_RATIO,
  DEMOTION_LAST_FIRED_DAYS,
} from '../lib/promotion/ladder.mjs';

const TODAY = '2026-05-11';

function ruleLine(date, prefix, body) {
  return `- ${date}: ${prefix} ${body}`;
}

// Fire a rule N times on a stats object. We don't sleep between fires —
// last_fired ends at "now" once.
function fireN(stats, hash, n) {
  for (let i = 0; i < n; i++) incrementRuleFire(stats, hash);
}

// -- listPromotionCandidates ------------------------------------------------

// cerebrum-v2 T6: promotion is KW-ONLY (promote adds [!], the kw recall floor +
// write-gate). node:/global rules fire by scope and are never promotion candidates.
test('listPromotionCandidates: kw rule with 50 fires + no contradiction → candidate', () => {
  const line = ruleLine(TODAY, '[kw:prettier]', 'Always run prettier');
  const text = line + '\n';
  const parsed = parseCerebrum(text);
  const stats = defaultStats();
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 50);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].line_hash, h);
  assert.equal(candidates[0].fires, 50);
  assert.equal(candidates[0].body, 'Always run prettier');
  assert.deepEqual(candidates[0].current_buckets, ['kw:prettier']);
});

test('listPromotionCandidates: kw rule with 49 fires → NOT candidate at threshold 50', () => {
  const line = ruleLine(TODAY, '[kw:prettier]', 'Always run prettier');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 49);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 0);
});

test('listPromotionCandidates: contradicted kw rule → excluded', () => {
  const line = ruleLine(TODAY, '[kw:prettier]', 'Always run prettier');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 100);
  stats.rule_fires[h].contradicted = true;
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 0);
});

test('listPromotionCandidates: a non-kw (node/global) rule is NEVER a candidate (T6)', () => {
  const line = ruleLine(TODAY, '[!global]', 'Always run prettier');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 100);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 0, 'node:/global rules fire by scope; never promoted');
});

test('listPromotionCandidates: already-mandatory kw rule → excluded', () => {
  const line = ruleLine(TODAY, '[kw:deploy] [!]', 'Already mandatory');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 100);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 0);
});

test('listPromotionCandidates: rule hash absent from cerebrum → excluded', () => {
  // Stats has fires for a hash that no longer exists in the cerebrum
  // (forgotten/archived). We must not surface it.
  const parsed = parseCerebrum('');
  const stats = defaultStats();
  fireN(stats, 'aaaaaaaaaaaaaaaa', 100);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 0);
});

test('listPromotionCandidates: sorted by fires desc', () => {
  const a = ruleLine(TODAY, '[kw:alpha]', 'Rule A');
  const b = ruleLine(TODAY, '[kw:beta]', 'Rule B');
  const parsed = parseCerebrum([a, b].join('\n') + '\n');
  const stats = defaultStats();
  const hA = lineHash(parsed.lines[0].raw);
  const hB = lineHash(parsed.lines[1].raw);
  fireN(stats, hA, 60);
  fireN(stats, hB, 80);
  const candidates = listPromotionCandidates(stats, parsed, { threshold: 50 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].body, 'Rule B');
  assert.equal(candidates[1].body, 'Rule A');
});

// -- listDemoteCandidates ---------------------------------------------------

test('listDemoteCandidates: low fire ratio + stale last_fired → candidate', () => {
  const line = ruleLine(TODAY, '[!global]', 'Rarely fires');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  stats.session_count = 100; // → opportunities = 1000
  const h = lineHash(parsed.lines[0].raw);
  // 1 fire / 1000 opportunities = 0.001, well below the 0.05 ratio.
  incrementRuleFire(stats, h);
  // Stamp last_fired to 60 days ago so it's past the 30-day cutoff.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  stats.rule_fires[h].last_fired = sixtyDaysAgo;
  const candidates = listDemoteCandidates(stats, parsed);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].line_hash, h);
  assert.equal(candidates[0].fires, 1);
  assert.ok(candidates[0].ratio < DEMOTION_OPPORTUNITY_RATIO);
});

test('listDemoteCandidates: low ratio BUT recent fire → NOT a candidate', () => {
  const line = ruleLine(TODAY, '[!global]', 'Recently used');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  stats.session_count = 100;
  const h = lineHash(parsed.lines[0].raw);
  incrementRuleFire(stats, h);
  // last_fired stamped just now by incrementRuleFire — within 30-day window.
  const candidates = listDemoteCandidates(stats, parsed);
  assert.equal(candidates.length, 0);
});

test('listDemoteCandidates: never-fired rule → candidate (when sessions > 0)', () => {
  // A rule whose row exists in stats but with fires=0 + last_fired=null is
  // a strong demotion signal — the user kept it but it never matched.
  const line = ruleLine(TODAY, '[!global]', 'Never fires');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  stats.session_count = 100;
  const h = lineHash(parsed.lines[0].raw);
  stats.rule_fires[h] = { fires: 0, contradicted: false, last_fired: null };
  const candidates = listDemoteCandidates(stats, parsed);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fires, 0);
});

test('listDemoteCandidates: fire ratio >= threshold → NOT a candidate', () => {
  const line = ruleLine(TODAY, '[!global]', 'Hot rule');
  const parsed = parseCerebrum(line + '\n');
  const stats = defaultStats();
  stats.session_count = 1; // opportunities = 10
  const h = lineHash(parsed.lines[0].raw);
  fireN(stats, h, 5); // ratio = 0.5, way above 0.05
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  stats.rule_fires[h].last_fired = sixtyDaysAgo;
  const candidates = listDemoteCandidates(stats, parsed);
  assert.equal(candidates.length, 0);
});

test('listDemoteCandidates: rule absent from cerebrum → excluded', () => {
  const parsed = parseCerebrum('');
  const stats = defaultStats();
  stats.session_count = 100;
  stats.rule_fires['bbbbbbbbbbbbbbbb'] = {
    fires: 0,
    contradicted: false,
    last_fired: null,
  };
  const candidates = listDemoteCandidates(stats, parsed);
  assert.equal(candidates.length, 0);
});

test('listDemoteCandidates: respects DEMOTION_LAST_FIRED_DAYS = 30', () => {
  // Validate the documented cutoff constant matches behaviour.
  assert.equal(DEMOTION_LAST_FIRED_DAYS, 30);
});

// -- summarizeReviewQueue ---------------------------------------------------

test('summarizeReviewQueue: aggregate shape includes all three lists', () => {
  const parsed = parseCerebrum('- 2026-05-11: [!global] Sample rule\n');
  const stats = defaultStats();
  const summary = summarizeReviewQueue(parsed, stats);
  assert.ok(Array.isArray(summary.promotion));
  assert.ok(Array.isArray(summary.demote));
  assert.ok(Array.isArray(summary.contradictions));
});
