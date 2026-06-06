// Tests for lib/stores/stats.mjs — Phase 8 durable ledger.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  defaultStats,
  readStats,
  writeStats,
  incrementRuleFire,
  addTokensPaid,
  addTokensSaved,
  bumpRedundantRead,
  bumpSessionCount,
  statsPath,
  STATS_SCHEMA_VERSION,
  migrateRuleFireKey,
} from '../lib/stores/stats.mjs';
import { resolveRuleBodies } from '../bin/stats.mjs';
import { lineHash, CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

async function freshBase(t) {
  const base = path.join(os.tmpdir(), 'sextant-stats-' + crypto.randomUUID());
  await fs.mkdir(base, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

test('defaultStats: returns the documented schema', () => {
  const s = defaultStats();
  assert.equal(s.schema_version, STATS_SCHEMA_VERSION);
  assert.equal(s.ab_arm, 'A');
  assert.equal(s.session_count, 0);
  assert.equal(s.tokens_saved_estimate, 0);
  assert.equal(s.tokens_paid_extra, 0);
  assert.equal(s.net_savings, 0);
  assert.deepEqual(s.rule_fires, {});
  assert.equal(s.redundant_reads_blocked, 0);
  assert.equal(s.last_updated, null);
});

test('readStats: missing file → defaults', async (t) => {
  const base = await freshBase(t);
  const s = await readStats(base);
  assert.deepEqual(s, defaultStats());
});

test('readStats: malformed JSON → defaults (corruption-tolerant)', async (t) => {
  const base = await freshBase(t);
  await fs.writeFile(statsPath(base), '{not json', 'utf8');
  const s = await readStats(base);
  assert.deepEqual(s, defaultStats());
});

test('readStats: partial file → merged with defaults', async (t) => {
  const base = await freshBase(t);
  // Only one field present on disk; the rest should fill in.
  await fs.writeFile(
    statsPath(base),
    JSON.stringify({ tokens_paid_extra: 42 }),
    'utf8',
  );
  const s = await readStats(base);
  assert.equal(s.tokens_paid_extra, 42);
  assert.equal(s.tokens_saved_estimate, 0);
  assert.equal(s.schema_version, STATS_SCHEMA_VERSION);
  assert.deepEqual(s.rule_fires, {});
});

test('writeStats: stamps last_updated + recomputes net_savings', async (t) => {
  const base = await freshBase(t);
  const s = defaultStats();
  addTokensSaved(s, 100);
  addTokensPaid(s, 30);
  const written = await writeStats(base, s);
  assert.equal(written.net_savings, 70, 'net_savings = saved - paid');
  assert.ok(typeof written.last_updated === 'string' && written.last_updated.length > 0);
  // Round-trip from disk.
  const back = await readStats(base);
  assert.equal(back.net_savings, 70);
  assert.equal(back.tokens_paid_extra, 30);
  assert.equal(back.tokens_saved_estimate, 100);
});

test('writeStats: handles negative net_savings (treatment may underperform)', async (t) => {
  const base = await freshBase(t);
  const s = defaultStats();
  addTokensPaid(s, 500);
  // tokens_saved_estimate stays 0 in v1; this is the realistic Phase 8 state.
  const written = await writeStats(base, s);
  assert.equal(written.net_savings, -500);
});

test('incrementRuleFire: creates entry on first touch', () => {
  const s = defaultStats();
  incrementRuleFire(s, 'aaaabbbbccccdddd');
  assert.equal(s.rule_fires['aaaabbbbccccdddd'].fires, 1);
  assert.equal(s.rule_fires['aaaabbbbccccdddd'].contradicted, false);
  assert.ok(typeof s.rule_fires['aaaabbbbccccdddd'].last_fired === 'string');
});

test('incrementRuleFire: bumps fires + updates last_fired', () => {
  const s = defaultStats();
  incrementRuleFire(s, 'hash1');
  const firstStamp = s.rule_fires['hash1'].last_fired;
  // Sleep-free way: stamp manually then re-fire.
  s.rule_fires['hash1'].last_fired = '2020-01-01T00:00:00.000Z';
  incrementRuleFire(s, 'hash1');
  assert.equal(s.rule_fires['hash1'].fires, 2);
  assert.notEqual(s.rule_fires['hash1'].last_fired, '2020-01-01T00:00:00.000Z',
    'last_fired must advance on each fire');
  // Sanity: first stamp was a valid iso (just for shape).
  assert.ok(typeof firstStamp === 'string');
});

test('incrementRuleFire: tolerates missing rule_fires object', () => {
  // Defensive — if a stale on-disk shape lacks rule_fires entirely we should
  // still record the increment without throwing.
  const s = { rule_fires: null };
  incrementRuleFire(s, 'hash1');
  assert.equal(s.rule_fires['hash1'].fires, 1);
});

test('addTokensPaid: increments by n', () => {
  const s = defaultStats();
  addTokensPaid(s, 10);
  addTokensPaid(s, 5);
  assert.equal(s.tokens_paid_extra, 15);
});

test('addTokensPaid: ignores non-positive / non-finite', () => {
  const s = defaultStats();
  addTokensPaid(s, 0);
  addTokensPaid(s, -5);
  addTokensPaid(s, NaN);
  addTokensPaid(s, Infinity);
  assert.equal(s.tokens_paid_extra, 0);
});

test('addTokensSaved: increments by n', () => {
  const s = defaultStats();
  addTokensSaved(s, 100);
  assert.equal(s.tokens_saved_estimate, 100);
});

test('bumpRedundantRead: increments by 1', () => {
  const s = defaultStats();
  bumpRedundantRead(s);
  bumpRedundantRead(s);
  assert.equal(s.redundant_reads_blocked, 2);
});

test('bumpSessionCount: increments by 1', () => {
  const s = defaultStats();
  bumpSessionCount(s);
  bumpSessionCount(s);
  bumpSessionCount(s);
  assert.equal(s.session_count, 3);
});

test('round-trip: write then read preserves all fields', async (t) => {
  const base = await freshBase(t);
  const s = defaultStats();
  s.ab_arm = 'B';
  bumpSessionCount(s);
  addTokensPaid(s, 50);
  incrementRuleFire(s, 'rule-a-hash');
  incrementRuleFire(s, 'rule-a-hash');
  incrementRuleFire(s, 'rule-b-hash');
  bumpRedundantRead(s);
  await writeStats(base, s);

  const back = await readStats(base);
  assert.equal(back.ab_arm, 'B');
  assert.equal(back.session_count, 1);
  assert.equal(back.tokens_paid_extra, 50);
  assert.equal(back.rule_fires['rule-a-hash'].fires, 2);
  assert.equal(back.rule_fires['rule-b-hash'].fires, 1);
  assert.equal(back.redundant_reads_blocked, 1);
  assert.equal(back.net_savings, -50);
});

test('resolveRuleBodies: resolves rule_fires hashes to bodies from cerebrum.md', async (t) => {
  const root = path.join(os.tmpdir(), 'sextant-statsbody-' + crypto.randomUUID());
  await fs.mkdir(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const line = '- 2026-01-01: [kw:deploy] never deploy on a friday';
  await fs.writeFile(
    path.join(root, '.sextant', 'cerebrum', 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n${line}\n`,
    'utf8',
  );
  const h = lineHash(line);
  const bodies = await resolveRuleBodies(root, { [h]: { fires: 3 } });
  assert.equal(bodies.get(h), 'never deploy on a friday');
});

test('migrateRuleFireKey: moves fire history to the new hash', () => {
  const s = defaultStats();
  s.rule_fires = { old: { fires: 60, contradicted: false, last_fired: '2026-01-01T00:00:00Z' } };
  assert.equal(migrateRuleFireKey(s, 'old', 'new'), true);
  assert.equal(s.rule_fires.new.fires, 60);
  assert.ok(!('old' in s.rule_fires), 'old key removed');
});

test('migrateRuleFireKey: collision sums fires + takes the later last_fired', () => {
  const s = defaultStats();
  s.rule_fires = {
    old: { fires: 60, contradicted: true, last_fired: '2026-02-01T00:00:00Z' },
    new: { fires: 5, contradicted: false, last_fired: '2026-01-01T00:00:00Z' },
  };
  migrateRuleFireKey(s, 'old', 'new');
  assert.equal(s.rule_fires.new.fires, 65);
  assert.equal(s.rule_fires.new.last_fired, '2026-02-01T00:00:00Z');
  assert.equal(s.rule_fires.new.contradicted, true);
  assert.ok(!('old' in s.rule_fires));
});

test('migrateRuleFireKey: no-ops when oldHash absent or hashes equal', () => {
  const s = defaultStats();
  s.rule_fires = { x: { fires: 3, contradicted: false, last_fired: null } };
  assert.equal(migrateRuleFireKey(s, 'missing', 'new'), false);
  assert.equal(migrateRuleFireKey(s, 'x', 'x'), false);
  assert.deepEqual(Object.keys(s.rule_fires), ['x'], 'untouched');
});
