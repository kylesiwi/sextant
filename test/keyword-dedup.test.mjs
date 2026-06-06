// Tests for lib/hooks/keywordDedup.mjs — per-session windowed dedup of [kw:]
// rule fires. Criticals emit every turn; general fires throttle to once per N
// turns per rule. Pure partition logic + the async turn-state wrapper.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  partitionKeywordMatches,
  dedupKeywordMatches,
  keywordDedupWindow,
  keywordDedupDisabled,
  KW_GENERAL_FIELD,
} from '../lib/hooks/keywordDedup.mjs';
import { lineHash } from '../lib/stores/cerebrum.mjs';
import { writeJsonAtomic, readJson } from '../lib/io.mjs';
import { turnStatePath } from '../lib/paths.mjs';

// -- helpers -----------------------------------------------------------------

function critMatch(id) {
  return { rule: { raw: `- 2026-05-12: [!] [kw:*c${id}] critical rule ${id} body`, body: `crit ${id}` }, trigger: 'critical' };
}
function genMatch(id) {
  return { rule: { raw: `- 2026-05-12: [!] [kw:g${id}] general rule ${id} body`, body: `gen ${id}` }, trigger: 'general' };
}
function legacyMatch(id) {
  return { rule: { raw: `- 2026-05-12: [!] [kw:l${id}] legacy rule ${id} body`, body: `legacy ${id}` }, trigger: 'legacy' };
}

function withEnv(t, overrides) {
  const before = {};
  for (const [k, v] of Object.entries(overrides)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function setupRuntime(t) {
  const base = path.join(os.tmpdir(), 'sextant-kwdedup-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base, SEXTANT_KW_DEDUP: undefined, SEXTANT_KW_DEDUP_TURNS: undefined });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

// -- partitionKeywordMatches (pure) ------------------------------------------

test('partition: criticals always emit and never stamp the general clock', () => {
  const { emit, updates } = partitionKeywordMatches([critMatch(1)], 10, {}, 5);
  assert.equal(emit.length, 1);
  assert.deepEqual(updates, {}, 'critical fire must not write a general timestamp');
});

test('partition: a critical still emits even if its hash sits in lastMap', () => {
  const m = critMatch(1);
  const h = lineHash(m.rule.raw);
  const { emit } = partitionKeywordMatches([m], 11, { [h]: 10 }, 5);
  assert.equal(emit.length, 1, 'criticals bypass the window entirely');
});

test('partition: first general fire emits and records turnId', () => {
  const m = genMatch(1);
  const { emit, updates } = partitionKeywordMatches([m], 10, {}, 5);
  assert.equal(emit.length, 1);
  assert.equal(updates[lineHash(m.rule.raw)], 10);
});

test('partition: general within the window is suppressed', () => {
  const m = genMatch(1);
  const h = lineHash(m.rule.raw);
  const { emit, updates } = partitionKeywordMatches([m], 12, { [h]: 10 }, 5); // elapsed 2 < 5
  assert.equal(emit.length, 0);
  assert.deepEqual(updates, {});
});

test('partition: general at exactly the window boundary re-emits', () => {
  const m = genMatch(1);
  const h = lineHash(m.rule.raw);
  const { emit, updates } = partitionKeywordMatches([m], 15, { [h]: 10 }, 5); // elapsed 5 >= 5
  assert.equal(emit.length, 1);
  assert.equal(updates[h], 15);
});

test('partition: legacy fires always emit and never stamp the clock', () => {
  const m = legacyMatch(1);
  const h = lineHash(m.rule.raw);
  // even with a "recent" timestamp, a legacy fire is exempt from throttling
  const { emit, updates } = partitionKeywordMatches([m], 11, { [h]: 10 }, 5);
  assert.equal(emit.length, 1, 'legacy (unmarked) rules are never suppressed');
  assert.deepEqual(updates, {}, 'legacy fire must not write a timestamp');
});

test('partition: mixed batch — critical emits, throttled general suppressed', () => {
  const c = critMatch(1);
  const g = genMatch(2);
  const gh = lineHash(g.rule.raw);
  const { emit } = partitionKeywordMatches([c, g], 11, { [gh]: 10 }, 5);
  assert.equal(emit.length, 1);
  assert.equal(emit[0].body, 'crit 1');
});

// -- env knobs ---------------------------------------------------------------

test('keywordDedupWindow: default 5, override via SEXTANT_KW_DEDUP_TURNS', (t) => {
  withEnv(t, { SEXTANT_KW_DEDUP_TURNS: undefined });
  assert.equal(keywordDedupWindow(), 5);
  withEnv(t, { SEXTANT_KW_DEDUP_TURNS: '3' });
  assert.equal(keywordDedupWindow(), 3);
  withEnv(t, { SEXTANT_KW_DEDUP_TURNS: 'garbage' });
  assert.equal(keywordDedupWindow(), 5, 'invalid value falls back to default');
});

test('keywordDedupDisabled: honours off/0/false/no', (t) => {
  withEnv(t, { SEXTANT_KW_DEDUP: undefined });
  assert.equal(keywordDedupDisabled(), false);
  for (const v of ['off', '0', 'false', 'NO']) {
    withEnv(t, { SEXTANT_KW_DEDUP: v });
    assert.equal(keywordDedupDisabled(), true, `${v} disables`);
  }
});

// -- dedupKeywordMatches (async, turn-state) ---------------------------------

test('dedup: no turn_id in turn-state → fail open (emit all)', async (t) => {
  await setupRuntime(t);
  const sid = 'kw-failopen';
  const cwd = path.join(os.tmpdir(), 'proj-' + crypto.randomUUID());
  // no turn-state written at all
  const emit = await dedupKeywordMatches([genMatch(1), genMatch(2)], sid, cwd);
  assert.equal(emit.length, 2, 'missing turn context emits everything');
});

test('dedup: general fire emits once then throttles within window', async (t) => {
  await setupRuntime(t);
  const sid = 'kw-throttle';
  const cwd = path.join(os.tmpdir(), 'proj-' + crypto.randomUUID());
  const g = genMatch(1);
  const h = lineHash(g.rule.raw);

  await writeJsonAtomic(turnStatePath(sid, cwd), { turn_id: 7 });
  const first = await dedupKeywordMatches([g], sid, cwd);
  assert.equal(first.length, 1, 'first general fire emits');

  const ts1 = await readJson(turnStatePath(sid, cwd));
  assert.equal(ts1[KW_GENERAL_FIELD][h], 7, 'turn-state records the emit turn');

  // same turn / next turn within the window → suppressed
  await writeJsonAtomic(turnStatePath(sid, cwd), { turn_id: 9, [KW_GENERAL_FIELD]: { [h]: 7 } });
  const second = await dedupKeywordMatches([g], sid, cwd);
  assert.equal(second.length, 0, 'within-window re-fire is suppressed');

  // window elapsed → re-emits
  await writeJsonAtomic(turnStatePath(sid, cwd), { turn_id: 12, [KW_GENERAL_FIELD]: { [h]: 7 } });
  const third = await dedupKeywordMatches([g], sid, cwd);
  assert.equal(third.length, 1, 'after the window the rule re-emits');
});

test('dedup: criticals emit every turn regardless of recent fire', async (t) => {
  await setupRuntime(t);
  const sid = 'kw-crit';
  const cwd = path.join(os.tmpdir(), 'proj-' + crypto.randomUUID());
  const c = critMatch(1);
  const h = lineHash(c.rule.raw);
  await writeJsonAtomic(turnStatePath(sid, cwd), { turn_id: 8, [KW_GENERAL_FIELD]: { [h]: 8 } });
  const emit = await dedupKeywordMatches([c], sid, cwd);
  assert.equal(emit.length, 1, 'critical fires even with a fresh timestamp present');
});

test('dedup: SEXTANT_KW_DEDUP=off emits everything', async (t) => {
  await setupRuntime(t);
  withEnv(t, { SEXTANT_KW_DEDUP: 'off' });
  const sid = 'kw-off';
  const cwd = path.join(os.tmpdir(), 'proj-' + crypto.randomUUID());
  const g = genMatch(1);
  const h = lineHash(g.rule.raw);
  await writeJsonAtomic(turnStatePath(sid, cwd), { turn_id: 2, [KW_GENERAL_FIELD]: { [h]: 2 } });
  const emit = await dedupKeywordMatches([g], sid, cwd);
  assert.equal(emit.length, 1, 'disabled dedup ignores the window');
});
