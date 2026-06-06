// Tests for the T2 end-of-turn summary in lib/hooks/stop.mjs.
//
// stop() composes a multi-line systemMessage from this-turn rule fires
// (rules-fired.jsonl, filtered by turn-state.started_at) and emits it on the
// normal turn-end (reset) path. A fresh cwd (no tranche, no cerebrum) skips the
// capture/format gates so the summary path is reached.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import stop from '../lib/hooks/stop.mjs';
import { readState } from '../lib/state.mjs';
import { setOutputMode } from '../lib/config.mjs';
import { runtimeBase, rulesFiredPath, rulesAuthoredPath, turnStatePath } from '../lib/paths.mjs';
import {
  defaultTranches, startFeature, advanceTranche, setChecklistComplete, writeTranches,
} from '../lib/stores/tranches.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
import { durableFile } from '../lib/paths.mjs';

const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : s);

function freshDir(prefix) {
  const p = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function setup(t, mode) {
  const cwd = freshDir('sextant-stopsum-cwd');
  const runtime = freshDir('sextant-stopsum-rt');
  const prevRt = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = runtime;
  t.after(async () => {
    if (prevRt === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prevRt;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(runtime, { recursive: true, force: true });
  });
  const sid = 'stopsum-' + crypto.randomUUID().slice(0, 8);
  return { cwd, sid, mode: mode ? setOutputMode(cwd, mode) : Promise.resolve() };
}

const ctx = { eventName: 'Stop', nowIso: () => new Date().toISOString(), log: async () => {} };

async function seedTurn(sid, cwd, startTs, firedEntries) {
  const dir = runtimeBase(sid, cwd);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(turnStatePath(sid, cwd), JSON.stringify({ started_at: startTs, turn_id: 1 }), 'utf8');
  if (firedEntries) {
    await fs.writeFile(
      rulesFiredPath(sid, cwd),
      firedEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
  }
}

const START = '2026-06-03T12:00:00.000Z';
const AFTER = '2026-06-03T12:00:05.000Z';
const BEFORE = '2026-06-03T11:59:00.000Z';
const fire = (ts, bucket) => ({ ts, body: 'a rule', source_file: '.sextant/cerebrum/cerebrum.md', bucket });

test('stop summary: a turn with rule fires surfaces a breakdown (quiet)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, [
    fire(AFTER, '[node:lib/a.mjs]'),
    fire(AFTER, '[!global]'),
    fire(AFTER, '[!]'),
    fire(BEFORE, '[node:lib/old.mjs]'), // previous turn — must be excluded
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(r && typeof r.systemMessage === 'string', 'summary emitted');
  assert.equal(stripAnsi(r.systemMessage), '\nsextant: 3 rules injected this turn (1 path, 1 global, 1 keyword)');
});

test('stop summary: singular phrasing + partial breakdown', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, [fire(AFTER, '[node:lib/a.mjs]')]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.equal(stripAnsi(r.systemMessage), '\nsextant: 1 rule injected this turn (1 path)');
});

test('stop summary: composite bucket labels classify correctly (regression)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  // Live data showed keyword fires logged as `[kw:…][!]` (composite), not plain
  // `[!]` — the old exact-match dropped them. Both forms must count as keyword.
  await seedTurn(sid, cwd, START, [
    fire(AFTER, '[node:lib/a.mjs]'),
    fire(AFTER, '[kw:settings.local, agents, skills][!]'),
    fire(AFTER, '[!global]'),
    fire(AFTER, '[!]'),
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.equal(
    stripAnsi(r.systemMessage),
    '\nsextant: 4 rules injected this turn (1 path, 1 global, 2 keyword)',
  );
});

test('stop summary: pre-turn fires only → silent', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, [fire(BEFORE, '[node:lib/a.mjs]'), fire(BEFORE, '[!global]')]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage, 'no summary when all fires predate this turn');
});

test('stop summary: a quiet turn with no fires → silent', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, null); // no rules-fired.jsonl
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage, 'no summary when nothing fired');
});

test('stop summary: off mode silences it', async (t) => {
  const { cwd, sid, mode } = setup(t, 'off');
  await mode;
  await seedTurn(sid, cwd, START, [fire(AFTER, '[node:lib/a.mjs]'), fire(AFTER, '[!]')]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage, 'off mode yields no summary');
});

test('stop summary: surfaces under verbose too (summary level)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  await seedTurn(sid, cwd, START, [fire(AFTER, '[!global]'), fire(AFTER, '[!global]')]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  // Verbose shows the count line + per-rule expansion (T3-D); the fire() body is 'a rule'.
  const s = stripAnsi(r.systemMessage);
  assert.match(s, /sextant: 2 rules injected this turn \(2 global\)/);
  assert.match(s, /· a rule/);
});

async function writeTranchesState(cwd, { feature = 'f', workflow_state, active, statuses }) {
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  const s = defaultTranches();
  s.feature = feature;
  s.workflow_state = workflow_state;
  s.active_tranche_id = active;
  s.tranches = Object.entries(statuses).map(([id, status]) => ({
    id, title: `T${id}`, scope: [], status, depends_on: [],
  }));
  await writeTranches(cwd, s);
}

test('stop summary: emits a tranche-transition line on a status change (T3-C)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  const { withState } = await import('../lib/state.mjs');
  // Last Stop saw T1 IN-FLIGHT (snapshot in hot state).
  await withState(sid, cwd, (s) => {
    s.tranche_summary_prev = { workflow_state: 'IMPLEMENTING', active: '1', statuses: { 1: 'IN-FLIGHT' } };
  });
  // Live tranches.json now shows T1 SHIPPED, T2 STUB, workflow DETAILING.
  await writeTranchesState(cwd, {
    workflow_state: 'DETAILING', active: '2', statuses: { 1: 'SHIPPED', 2: 'STUB' },
  });
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.match(stripAnsi(r.systemMessage || ''), /T1 IN-FLIGHT → SHIPPED/);
});

test('stop summary: no transition line when tranche state is unchanged (T3-C)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  const snap = { workflow_state: 'IMPLEMENTING', active: '1', statuses: { 1: 'IN-FLIGHT' } };
  const { withState } = await import('../lib/state.mjs');
  await withState(sid, cwd, (s) => { s.tranche_summary_prev = snap; });
  await writeTranchesState(cwd, { workflow_state: 'IMPLEMENTING', active: '1', statuses: { 1: 'IN-FLIGHT' } });
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage || !/→/.test(stripAnsi(r.systemMessage)), 'no transition arrow when unchanged');
});

async function seedInFlight(cwd) {
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  const s = defaultTranches();
  startFeature(s, {
    feature: 'f', docRoot: 'docs/f', charterPath: 'docs/f/charter.md',
    specPath: 'docs/f/spec.md', tranches: [{ id: '1', title: 'T1', scope: ['x'], depends_on: [] }],
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT'); // workflow → IMPLEMENTING (arms the capture gate)
  await writeTranches(cwd, s);
}

test('stop summary: rides the capture-gate decision:block (T3-I)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedInFlight(cwd); // IMPLEMENTING + no captures → capture gate blocks
  await seedTurn(sid, cwd, START, [fire(AFTER, '[node:lib/a.mjs]'), fire(AFTER, '[!]')]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.equal(r.decision, 'block', 'capture gate still blocks the turn');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'block reason preserved');
  assert.ok(typeof r.systemMessage === 'string', 'summary rides alongside the block');
  assert.match(stripAnsi(r.systemMessage), /2 rules injected this turn \(1 path, 1 keyword\)/);
});

test('stop summary: verbose expands each fired rule to its own line (T3-D)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  await seedTurn(sid, cwd, START, [
    { ts: AFTER, body: 'keep this module tiny and dependency-free', source_file: 'x', bucket: '[node:lib/a.mjs]' },
    { ts: AFTER, body: 'never force-push to main', source_file: 'x', bucket: '[!global]' },
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const s = stripAnsi(r.systemMessage);
  assert.match(s, /2 rules injected this turn \(1 path, 1 global\)/);
  assert.match(s, /· keep this module tiny and dependency-free/);
  assert.match(s, /· never force-push to main/);
});

test('stop summary: verbose detail lines are BARE — no per-line sextant: prefix', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  await seedTurn(sid, cwd, START, [
    { ts: AFTER, body: 'keep this module tiny', source_file: 'x', bucket: '[node:lib/a.mjs]' },
    { ts: AFTER, body: 'never force-push to main', source_file: 'x', bucket: '[!global]' },
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const out = stripAnsi(r.systemMessage);
  const detailLines = out.split('\n').filter((l) => l.startsWith('· '));
  assert.ok(detailLines.length >= 2, 'detail lines present under verbose');
  assert.ok(detailLines.every((l) => !l.includes('sextant:')),
    'detail (·) lines must NOT carry the sextant: prefix — they read as one block under the headline');
  // The headline still carries the prefix.
  assert.ok(out.split('\n').some((l) => l.includes('sextant:') && /injected this turn/.test(l)),
    'the count headline keeps the sextant: prefix');
});

test('stop summary: identical rules collapse to one detail line with (×N)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  // Same node rule fires 3× (3 reads/edits of its file) + a distinct rule once.
  await seedTurn(sid, cwd, START, [
    { ts: AFTER, body: 'keep this module tiny', source_file: 'x', bucket: '[node:lib/a.mjs]' },
    { ts: AFTER, body: 'keep this module tiny', source_file: 'x', bucket: '[node:lib/a.mjs]' },
    { ts: AFTER, body: 'keep this module tiny', source_file: 'x', bucket: '[node:lib/a.mjs]' },
    { ts: AFTER, body: 'never force-push to main', source_file: 'x', bucket: '[node:lib/b.mjs]' },
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const out = stripAnsi(r.systemMessage);
  // Headline still counts every fire.
  assert.match(out, /4 rules injected this turn \(4 path\)/);
  // The repeated rule appears once, with a multiplier; the distinct one has none.
  const details = out.split('\n').filter((l) => l.startsWith('· '));
  assert.equal(details.length, 2, 'two distinct rules → two detail lines');
  assert.ok(details.some((l) => /keep this module tiny \(×3\)/.test(l)), 'repeated rule shows (×3)');
  assert.ok(details.some((l) => /never force-push to main$/.test(l)), 'single-fire rule has no multiplier');
});

test('stop summary: detail snippet allows up to 200 chars of the body', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  const longBody = 'X'.repeat(250);
  await seedTurn(sid, cwd, START, [{ ts: AFTER, body: longBody, source_file: 'x', bucket: '[node:lib/a.mjs]' }]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const detail = stripAnsi(r.systemMessage).split('\n').find((l) => l.startsWith('· '));
  assert.ok(detail.includes('X'.repeat(200)), 'shows up to 200 chars (more than the old 100)');
  assert.ok(!detail.includes('X'.repeat(201)), 'truncated at 200');
});

test('stop summary: quiet does NOT expand per-rule (T3-D)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, [
    { ts: AFTER, body: 'keep this module tiny', source_file: 'x', bucket: '[node:lib/a.mjs]' },
  ]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const s = stripAnsi(r.systemMessage);
  assert.match(s, /1 rule injected this turn \(1 path\)/);
  assert.ok(!s.includes('· keep'), 'no per-rule expansion under quiet');
});

async function writeCerebrum(cwd, rawLines) {
  const p = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, [CEREBRUM_V2_HEADER, ...rawLines].join('\n') + '\n', 'utf8');
}

const RULE_A = '- 2026-05-12: [global] run the linter before committing';
const RULE_B = '- 2026-05-12: [global] never force-push to main';

// Seed the per-session rules-authored.jsonl — one entry per `cerebrum remember`
// event (postToolUse:Bash logs these). The Stop count filters by ts >= turn start.
async function seedAuthored(sid, cwd, entries) {
  const dir = runtimeBase(sid, cwd);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    rulesAuthoredPath(sid, cwd),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

test('stop summary: a rule authored this turn surfaces an authored line (T3-B)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, null);
  await seedAuthored(sid, cwd, [{ ts: AFTER }]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.match(stripAnsi(r.systemMessage || ''), /1 rule authored this turn/);
});

test('stop summary: no authored line when nothing was remembered (T3-B)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, null); // no rules-authored.jsonl at all
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage || !/authored/.test(stripAnsi(r.systemMessage)),
    'no authored line when no remember event fired');
});

test('stop summary: pre-turn authoring is excluded (T3-B)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, null);
  await seedAuthored(sid, cwd, [{ ts: BEFORE }]); // authored in a previous turn
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage || !/authored/.test(stripAnsi(r.systemMessage)),
    'a remember from a previous turn does not count this turn');
});

// The advisor's discriminating test: an in-place rehash (auto-tag / promote /
// reconcile rewrites a rule, changing its line-hash) authors NOTHING, so it must
// NOT surface an authored line. The count comes from the remember-event log, not
// a hash set-diff, so a changed store with no remember event stays silent.
test('stop summary: an in-place rehash is NOT counted as authored (T3-B)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, null);
  await writeCerebrum(cwd, [RULE_A]);
  await stop({ session_id: sid, cwd }, ctx); // baseline stop — nothing authored
  // Rehash RULE_A in place: SAME body, different bucket → a DIFFERENT lineHash,
  // but NO `cerebrum remember` event (the authored log stays empty). The removed
  // set-diff impl would see a "new" hash here and falsely report "1 authored";
  // the event-based count must stay silent. (A single-stop version would not
  // discriminate — set-diff also stays silent on its baseline turn.)
  await writeCerebrum(cwd, ['- 2026-05-12: [node:src/x.ts] run the linter before committing']);
  const r = await stop({ session_id: sid, cwd }, ctx);
  assert.ok(!r || !r.systemMessage || !/authored/.test(stripAnsi(r.systemMessage)),
    'a rehash with no remember event must not report an authored rule');
});

test('stop summary: verbose expands the authored rule with its hash + snippet (T3-B)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  await seedTurn(sid, cwd, START, null);
  await seedAuthored(sid, cwd, [{ ts: AFTER }]);
  // The freshly-authored rule sits at the cerebrum tail; the snippet reads from there.
  await writeCerebrum(cwd, [RULE_A, RULE_B]);
  const r = await stop({ session_id: sid, cwd }, ctx);
  const s = stripAnsi(r.systemMessage || '');
  assert.match(s, /1 rule authored this turn/);
  assert.match(s, /· [0-9a-f]{8} — never force-push to main/);
});

test('stop: turn counters still reset after the summary', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await seedTurn(sid, cwd, START, [fire(AFTER, '[!]')]);
  // Pre-load a non-zero fires_this_turn to prove the reset runs.
  const { withState } = await import('../lib/state.mjs');
  await withState(sid, cwd, (s) => { s.rules.fires_this_turn = 7; });
  await stop({ session_id: sid, cwd }, ctx);
  const state = await readState(sid, cwd);
  assert.equal(state.rules.fires_this_turn, 0, 'fires_this_turn reset to 0');
});
