// Tests for the cross-session continuity producer (§ 7.7).
//
// The PRODUCER is split across two hooks: SessionEnd (called once at end of
// session) and Stop (called at end of every turn). Both write
// .sextant/session/last.json via the shared helper lib/hooks/snapshotLast.mjs.
//
// These tests verify:
//   - SessionEnd writes last.json with the expected shape + fields, sourcing
//     them from the runtime statusline state and turn-state.json.
//   - Stop also writes last.json (last write wins).
//   - First-ever session end (no .sextant/ yet) creates the directory.
//   - Missing turn-state.json yields turn_id: null without crashing.
//   - Concurrent SessionEnd + Stop don't crash the process.
//
// All tests use SEXTANT_RUNTIME_BASE to isolate the runtime tier and a per-test
// cwd under tmp for the durable tier.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import sessionEnd from '../lib/hooks/sessionEnd.mjs';
import stop from '../lib/hooks/stop.mjs';
import { withState } from '../lib/state.mjs';
import { writeJsonAtomic } from '../lib/io.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import {
  runtimeBase,
  durableBase,
  lastJsonPath,
  turnStatePath,
} from '../lib/paths.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-lastjson-' + crypto.randomUUID());
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

async function setupEnv(t) {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  const cwd = freshTempBase();
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return { base, cwd };
}

function makeCtx(sid, eventName) {
  return {
    eventName,
    runtimeBase,
    durableBase,
    // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

async function readLastJson(cwd) {
  const raw = await fs.readFile(lastJsonPath(cwd), 'utf8');
  return JSON.parse(raw);
}

// --------------------------------------------------------------------------

test('sessionEnd: writes last.json with expected shape after a productive session', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-end';

  // Pre-seed runtime state to look like a session with real activity.
  await withState(sid, null, (s) => {
    s.ab_arm = 'B';
    s.reads.total = 42;
    s.rules.fires_this_turn = 3;
    s.rules.mandatory_fires = 1;
    s.bugs.open = 2;
    s.review_queue_depth = 7;
    s.graph = { state: 'fresh', last_rebuild_ts: null, dirty_count: 0 };
  });

  // Pre-seed turn-state.json with a turn_id.
  await writeJsonAtomic(turnStatePath(sid), { turn_id: 17, started_at: '2026-05-11T00:00:00Z' });

  await sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd'));

  const last = await readLastJson(cwd);
  assert.equal(last.session_id, sid);
  assert.equal(typeof last.ended_at, 'string');
  assert.match(last.ended_at, /^\d{4}-\d{2}-\d{2}T/, 'ended_at is ISO timestamp');
  assert.equal(last.ab_arm, 'B');
  assert.equal(last.turn_id, 17);
  assert.equal(last.graph_state, 'fresh');

  assert.deepEqual(last.stats_summary, {
    rules_fired_this_turn: 3,
    mandatory_fires: 1,
    reads_total: 42,
    bugs_open: 2,
    review_queue_depth: 7,
  });
});

test('sessionEnd: snapshot captures pre-reset counter values', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-pre-reset';

  // fires_this_turn=5 is a per-turn counter zeroed by resetTurnAndSession.
  // Snapshot must capture the live 5, not the post-reset 0.
  await withState(sid, null, (s) => {
    s.rules.fires_this_turn = 5;
    s.rules.mandatory_fires = 4;
    s.reads.total = 10;
  });

  await sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd'));

  const last = await readLastJson(cwd);
  assert.equal(last.stats_summary.rules_fired_this_turn, 5);
  assert.equal(last.stats_summary.mandatory_fires, 4);
  assert.equal(last.stats_summary.reads_total, 10);
});

test('stop: writes last.json (last write wins after multiple fires)', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-stop';

  await withState(sid, null, (s) => {
    s.reads.total = 1;
    s.rules.fires_this_turn = 1;
  });
  await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  const first = await readLastJson(cwd);
  assert.equal(first.stats_summary.rules_fired_this_turn, 1);
  const firstEndedAt = first.ended_at;

  // Bump state, fire Stop again. New snapshot should overwrite the old one.
  await withState(sid, null, (s) => {
    s.reads.total = 5;
    s.rules.fires_this_turn = 2;
  });
  // Ensure ISO timestamp differs (resolution is ms).
  await new Promise((r) => setTimeout(r, 5));
  await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));

  const second = await readLastJson(cwd);
  assert.equal(second.stats_summary.rules_fired_this_turn, 2);
  assert.equal(second.stats_summary.reads_total, 5);
  assert.notEqual(second.ended_at, firstEndedAt, 'ended_at advances on each Stop');
});

test('sessionEnd: creates .sextant/session/ dir when nothing exists yet', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-first-ever';

  // No state mutated. No durable dir. Pristine first-ever session end.
  await sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd'));

  // .sextant/session/last.json must now exist.
  const stat = await fs.stat(lastJsonPath(cwd));
  assert.ok(stat.isFile(), 'last.json was created');

  const last = await readLastJson(cwd);
  // With no state ever written, defaults are zeros / nulls / 'idle'.
  assert.equal(last.session_id, sid);
  assert.equal(last.turn_id, null, 'turn_id null when turn-state.json missing');
  assert.equal(last.stats_summary.reads_total, 0);
  assert.equal(last.stats_summary.rules_fired_this_turn, 0);
});

test('sessionEnd: missing turn-state.json yields turn_id: null', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-no-turn';

  // Write some statusline state but DO NOT write turn-state.json.
  await withState(sid, null, (s) => { s.reads.total = 3; });

  await sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd'));

  const last = await readLastJson(cwd);
  assert.equal(last.turn_id, null);
  assert.equal(last.stats_summary.reads_total, 3);
});

test('concurrent sessionEnd + stop do not crash and produce a valid last.json', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-concurrent';

  await withState(sid, null, (s) => {
    s.reads.total = 9;
    s.rules.fires_this_turn = 2;
  });

  // Fire both handlers in parallel. Each writes its own snapshot via tmp+rename,
  // so even if they race, the file is always valid JSON (no partial writes).
  await Promise.all([
    sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd')),
    stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop')),
  ]);

  const last = await readLastJson(cwd);
  assert.equal(last.session_id, sid);
  // Whichever finished last wins; both reads should observe a non-negative count.
  assert.ok(last.stats_summary.reads_total >= 0);
  // ended_at must be parseable.
  assert.ok(!Number.isNaN(Date.parse(last.ended_at)));
});

test('snapshot includes ab_arm and graph_state from runtime state', async (t) => {
  const { cwd } = await setupEnv(t);
  const sid = 'last-json-fields';

  await withState(sid, null, (s) => {
    s.ab_arm = 'A';
    s.graph = { state: 'stale', last_rebuild_ts: null, dirty_count: 3 };
  });

  await sessionEnd({ session_id: sid, cwd }, makeCtx(sid, 'SessionEnd'));

  const last = await readLastJson(cwd);
  assert.equal(last.ab_arm, 'A');
  assert.equal(last.graph_state, 'stale');
});
