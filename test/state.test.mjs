// Tests for lib/state.mjs — statusline-state.json read-modify-write coordinator.
//
// Concurrency test rationale: two withState calls in Promise.all, each
// reading state, sleeping briefly (to force the race window), then
// incrementing reads.total. Without the lock, the second writer would
// overwrite the first's increment and the final total would be 1, not 2.
// With the lock, mutations serialize and the final total is 2.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  defaultState,
  readState,
  withState,
  resetTurnAndSession,
} from '../lib/state.mjs';
import { lockfilePath, statuslineStatePath, runtimeBase } from '../lib/paths.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-test-' + crypto.randomUUID());
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
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

test('defaultState: returns v1 schema with provided sessionId', () => {
  const s = defaultState({ sessionId: 'abc' });
  assert.equal(s.version, 1);
  assert.equal(s.session_id, 'abc');
  assert.equal(s.ab_arm, 'A');
  assert.deepEqual(s.reads, { total: 0, redundant_blocked: 0 });
  assert.deepEqual(s.rules, {
    fires_this_turn: 0,
    mandatory_fires: 0,
    blocked: 0,
    deny_red: false,
  });
  assert.deepEqual(s.bugs, { open: 0 });
  assert.equal(s.review_queue_depth, 0);
  assert.deepEqual(s.auto_tag, { high_confidence: 0, low_confidence_review: 0 });
  assert.deepEqual(s.graph, { state: 'idle', last_rebuild_ts: null, dirty_count: 0 });
  assert.deepEqual(s.compaction, {
    last_snapshot_ts: null,
    last_restore_ts: null,
    compaction_n: 0,
  });
  assert.deepEqual(s.stuck, { tool: null, file: null, count: 0 });
  assert.deepEqual(s.systemmessage_fired, {});
  assert.deepEqual(s.last_event, { tag: null, ts: null });
});

test('defaultState: honors abArm override', () => {
  const s = defaultState({ sessionId: 'abc', abArm: 'B' });
  assert.equal(s.ab_arm, 'B');
});

test('readState: returns defaultState when file missing', async (t) => {
  await setupEnv(t);
  const s = await readState('sid-missing');
  assert.equal(s.session_id, 'sid-missing');
  assert.equal(s.version, 1);
  assert.equal(s.reads.total, 0);
});

test('readState: returns defaultState when file is unparseable', async (t) => {
  await setupEnv(t);
  const sid = 'sid-corrupt';
  // Create the runtime dir and write garbage
  await fs.mkdir(runtimeBase(sid), { recursive: true });
  await fs.writeFile(statuslineStatePath(sid), 'not json {{{', 'utf8');
  const s = await readState(sid);
  assert.equal(s.version, 1);
  assert.equal(s.session_id, sid);
  assert.equal(s.reads.total, 0);
});

test('readState: returns parsed state when file is valid', async (t) => {
  await setupEnv(t);
  const sid = 'sid-parsed';
  await fs.mkdir(runtimeBase(sid), { recursive: true });
  const payload = { version: 1, session_id: sid, reads: { total: 42, redundant_blocked: 3 } };
  await fs.writeFile(statuslineStatePath(sid), JSON.stringify(payload), 'utf8');
  const s = await readState(sid);
  assert.equal(s.reads.total, 42);
  assert.equal(s.reads.redundant_blocked, 3);
});

test('withState: persists mutation atomically', async (t) => {
  await setupEnv(t);
  const sid = 'sid-write';
  const result = await withState(sid, null, (state) => {
    state.reads.total = 7;
  });
  assert.equal(result.reads.total, 7);

  // Re-read from disk to confirm persistence.
  const persisted = await readState(sid);
  assert.equal(persisted.reads.total, 7);
});

test('withState: serializes concurrent writers via flock (no lost updates)', async (t) => {
  await setupEnv(t);
  const sid = 'sid-concurrent';

  // Each writer reads, sleeps (forcing the race window), then increments.
  // Without serialization, both would read total=0 and both write total=1.
  // With serialization, the second sees total=1 and writes total=2.
  const mutator = async (state) => {
    const cur = state.reads.total;
    await sleep(20); // force overlap
    state.reads.total = cur + 1;
  };

  await Promise.all([withState(sid, null, mutator), withState(sid, null, mutator)]);

  const final = await readState(sid);
  assert.equal(final.reads.total, 2, 'expected lock to serialize both increments');
});

test('withState: releases lock when mutator throws', async (t) => {
  await setupEnv(t);
  const sid = 'sid-throw';
  await assert.rejects(
    () => withState(sid, null, () => { throw new Error('boom'); }),
    /boom/
  );
  // Lockfile should not be left behind.
  assert.equal(fsSync.existsSync(lockfilePath(sid)), false);
  // Subsequent withState must succeed.
  const result = await withState(sid, null, (s) => { s.reads.total = 5; });
  assert.equal(result.reads.total, 5);
});

test('withState: returns null and logs to stderr on lock-acquire timeout', async (t) => {
  await setupEnv(t);
  const sid = 'sid-timeout';
  // Pre-create the runtime dir + the lockfile to simulate a held lock.
  await fs.mkdir(runtimeBase(sid), { recursive: true });
  const lock = lockfilePath(sid);
  fsSync.writeFileSync(lock, '', { flag: 'wx' });
  t.after(() => fsSync.rmSync(lock, { force: true }));

  // Capture stderr.
  const origWrite = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  t.after(() => { process.stderr.write = origWrite; });

  const result = await withState(
    sid,
    null,
    (s) => { s.reads.total = 999; },
    { lockTimeoutMs: 30, pollIntervalMs: 5 }
  );
  assert.equal(result, null);
  const joined = lines.join('');
  assert.match(joined, /sextant: state-lock timeout sid=sid-timeout/);

  // State file must NOT have been written.
  await assert.rejects(() => fs.access(statuslineStatePath(sid)));
});

test('withState: creates runtime dir if missing', async (t) => {
  await setupEnv(t);
  const sid = 'sid-mkdir';
  // No pre-mkdir
  const result = await withState(sid, null, (s) => { s.reads.total = 1; });
  assert.equal(result.reads.total, 1);
  const stat = await fs.stat(runtimeBase(sid));
  assert.ok(stat.isDirectory());
});

test('withState: passes existing state to mutator on subsequent calls', async (t) => {
  await setupEnv(t);
  const sid = 'sid-existing';
  await withState(sid, null, (s) => { s.reads.total = 10; });
  await withState(sid, null, (s) => { s.reads.total += 5; });
  const final = await readState(sid);
  assert.equal(final.reads.total, 15);
});

test('resetTurnAndSession: zeros turn/session keys, preserves cumulative', () => {
  const s = defaultState({ sessionId: 'x' });
  s.reads.total = 100;
  s.reads.redundant_blocked = 25;
  s.rules.fires_this_turn = 4;
  s.rules.mandatory_fires = 2;
  s.rules.blocked = 3;
  s.rules.deny_red = true;
  s.systemmessage_fired = { auto_tag_low_conf: true, precompact_1: true };
  s.bugs.open = 7;

  resetTurnAndSession(s);

  assert.equal(s.rules.fires_this_turn, 0);
  assert.equal(s.rules.mandatory_fires, 0);
  assert.equal(s.rules.blocked, 0);
  assert.equal(s.rules.deny_red, false);
  assert.deepEqual(s.systemmessage_fired, {});

  // Cumulative counters preserved.
  assert.equal(s.reads.total, 100);
  assert.equal(s.reads.redundant_blocked, 25);
  assert.equal(s.bugs.open, 7);
});
