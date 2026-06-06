// test/graph-rebuild-trigger.test.mjs — § 5.8.4 PostToolUse graph rebuild
// trigger.
//
// Coverage:
//   - Single Edit doesn't trigger (dirty_count = 1, state stays idle/stale).
//   - Fifth Edit triggers (dirty_count reset to 0, state = 'rebuilding').
//   - Stale last_rebuild_ts (>24h) triggers on the first edit.
//   - In-flight rebuild ('rebuilding') doesn't double-trigger.
//   - Bash PostToolUse doesn't increment dirty_count.
//   - Edits under .sextant/ don't increment dirty_count.
//   - Spawn argv via the SEXTANT_TEST_GRAPH_SPAWN_HOOK sentinel:
//       writes a JSON line per spawn → assert cwd correct + path resolvable.
//   - Spawn failure (SEXTANT_TEST_GRAPH_SPAWN_FAIL=1) rolls state back to
//       'stale' so the next trigger retries.
//
// Test mocking strategy: postToolUse honours two env knobs purely for
// testability — SEXTANT_TEST_GRAPH_SPAWN_HOOK (file path to append a JSON
// line to in place of spawning), and SEXTANT_TEST_GRAPH_SPAWN_FAIL=1 (force
// the spawn helper to throw). This avoids the complexity of a real child
// process and the flakiness of asserting on detached subprocesses.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { runtimeBase, durableBase, hooksLogPath } from '../lib/paths.mjs';
import { readState, withState } from '../lib/state.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import postToolUse from '../lib/hooks/postToolUse.mjs';

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

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function makeCtx(sid) {
  return {
    eventName: 'PostToolUse',
    runtimeBase,
    durableBase,
    // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

// Configure the trigger to record (instead of spawn) into a temp sentinel
// file. Returns the sentinel path so the test can read it back.
async function installSpawnSentinel(t) {
  const hookFile = path.join(os.tmpdir(), 'sextant-spawn-sentinel-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_TEST_GRAPH_SPAWN_HOOK: hookFile });
  t.after(() => fs.rm(hookFile, { force: true }));
  return hookFile;
}

async function readSentinelLines(p) {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function editPayload({ sid, cwd, filePath, tool = 'Edit' }) {
  return {
    session_id: sid,
    cwd,
    tool_name: tool,
    tool_input: { file_path: filePath },
    tool_response: { content: 'ok' },
  };
}

async function fireEdit({ sid, cwd, filePath, tool = 'Edit' }) {
  await postToolUse(await editPayload({ sid, cwd, filePath, tool }), makeCtx(sid));
}

// -- Tests ----------------------------------------------------------------

test('graph-rebuild: single edit increments dirty_count but does NOT trigger', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-single';
  const cwd = await freshProjectCwd(t);

  // Seed a recent last_rebuild_ts so the staleness path doesn't trip on its
  // own. Without a prior rebuild, staleAge is Infinity and the very first
  // edit triggers — that "first edit ever" behavior is exercised by the
  // stale-ts test below.
  await withState(sid, null, (s) => {
    s.graph = { state: 'idle', last_rebuild_ts: Date.now(), dirty_count: 0 };
  });

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/a.ts') });

  const state = await readState(sid);
  assert.equal(state.graph.dirty_count, 1, 'dirty_count incremented');
  assert.notEqual(state.graph.state, 'rebuilding', 'no rebuild claimed');

  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 0, 'no spawn fired for a single edit');
});

test('graph-rebuild: fifth edit triggers spawn + resets dirty_count', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-fifth';
  const cwd = await freshProjectCwd(t);

  // Seed a recent last_rebuild_ts so staleness doesn't fire the first edit.
  await withState(sid, null, (s) => {
    s.graph = { state: 'idle', last_rebuild_ts: Date.now(), dirty_count: 0 };
  });

  for (let i = 0; i < 5; i++) {
    await fireEdit({ sid, cwd, filePath: path.join(cwd, `src/f${i}.ts`) });
  }

  const state = await readState(sid);
  assert.equal(state.graph.state, 'rebuilding', 'state claimed for rebuild');
  assert.equal(state.graph.dirty_count, 0, 'dirty_count reset on trigger');

  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 1, 'exactly one spawn fired');
  assert.equal(spawns[0].cwd, cwd, 'spawn called with the project cwd');
});

test('graph-rebuild: stale last_rebuild_ts (>24h) triggers on the first edit', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-stale';
  const cwd = await freshProjectCwd(t);

  // Seed state.graph with a 25-hour-old last_rebuild_ts.
  const longAgo = Date.now() - 25 * 3600 * 1000;
  await withState(sid, null, (s) => {
    s.graph = { state: 'idle', last_rebuild_ts: longAgo, dirty_count: 0 };
  });

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/x.ts') });

  const state = await readState(sid);
  assert.equal(state.graph.state, 'rebuilding', 'staleness alone triggers a rebuild');
  assert.equal(state.graph.dirty_count, 0, 'dirty_count reset post-trigger');

  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 1, 'one spawn fired on stale-trigger');
});

test('graph-rebuild: in-flight rebuild does NOT spawn again on subsequent edits', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-inflight';
  const cwd = await freshProjectCwd(t);

  // Seed state.graph.state = 'rebuilding' to simulate an in-flight build.
  await withState(sid, null, (s) => {
    s.graph = { state: 'rebuilding', last_rebuild_ts: null, dirty_count: 0 };
  });

  for (let i = 0; i < 10; i++) {
    await fireEdit({ sid, cwd, filePath: path.join(cwd, `src/r${i}.ts`) });
  }

  const state = await readState(sid);
  // dirty_count stays 0 because the in-flight check short-circuits BEFORE
  // we increment. (This keeps the count meaningful: it counts edits-since-
  // last-rebuild, and "during the in-flight rebuild" doesn't count.)
  assert.equal(state.graph.dirty_count, 0, 'in-flight edits do not accumulate');
  assert.equal(state.graph.state, 'rebuilding', 'state unchanged during in-flight');

  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 0, 'no additional spawns while in-flight');
});

test('graph-rebuild: Bash tool does NOT increment dirty_count', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-bash';
  const cwd = await freshProjectCwd(t);

  await postToolUse({
    session_id: sid,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { content: 'hi\n' },
  }, makeCtx(sid));

  const state = await readState(sid);
  // Bash routes through handleBashPostToolUse → returns before any
  // graph-trigger logic. dirty_count stays at its default 0.
  assert.equal(state.graph.dirty_count, 0, 'Bash never bumps dirty_count');
  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 0, 'no spawns from Bash');
});

test('graph-rebuild: edits under .sextant/ do NOT increment dirty_count', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-sextant-internal';
  const cwd = await freshProjectCwd(t);

  // Editing a cerebrum file is "under .sextant/" — handled by the cerebrum
  // branch, never reaches the graph trigger.
  await fireEdit({
    sid,
    cwd,
    filePath: path.join(cwd, '.sextant', 'cerebrum', 'regular.md'),
  });

  const state = await readState(sid);
  assert.equal(state.graph.dirty_count, 0, 'cerebrum edit does not bump dirty_count');
  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 0, 'cerebrum edit does not spawn');
});

test('graph-rebuild: spawn argv records expected cwd in the sentinel hook', async (t) => {
  // Same as the fifth-edit test but with a focus on the spawn payload —
  // the test hook records { cwd, ts } per call and we assert cwd matches.
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-argv';
  const cwd = await freshProjectCwd(t);

  // Lower the threshold to make this a one-shot.
  withEnv(t, { SEXTANT_GRAPH_DIRTY_THRESHOLD: '1' });

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/one.ts') });

  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cwd, cwd);
  assert.ok(typeof spawns[0].ts === 'number' && spawns[0].ts > 0);
});

test('graph-rebuild: subprocess spawn failure rolls state back to stale', async (t) => {
  await setupEnv(t);
  const sid = 'gr-spawn-fail';
  const cwd = await freshProjectCwd(t);

  // Force the spawn helper to throw, AND lower the threshold so a single
  // edit fires it.
  withEnv(t, {
    SEXTANT_TEST_GRAPH_SPAWN_FAIL: '1',
    SEXTANT_GRAPH_DIRTY_THRESHOLD: '1',
  });

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/will-fail.ts') });

  const state = await readState(sid);
  // Pre-spawn: state was claimed as 'rebuilding'.
  // Post-failure rollback: state must be 'stale' so the next edit retries.
  assert.equal(state.graph.state, 'stale', 'spawn-failure rolled state back to stale');
});

test('graph-rebuild: SEXTANT_STALENESS_HOURS env controls the staleness window', async (t) => {
  await setupEnv(t);
  const hookFile = await installSpawnSentinel(t);
  const sid = 'gr-stale-env';
  const cwd = await freshProjectCwd(t);

  // Make staleness window 1 hour, seed last_rebuild_ts at 90 minutes ago.
  withEnv(t, { SEXTANT_STALENESS_HOURS: '1' });
  await withState(sid, null, (s) => {
    s.graph = {
      state: 'idle',
      last_rebuild_ts: Date.now() - 90 * 60 * 1000,
      dirty_count: 0,
    };
  });

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/env.ts') });

  const state = await readState(sid);
  assert.equal(state.graph.state, 'rebuilding', 'env-tuned staleness still triggers');
  const spawns = await readSentinelLines(hookFile);
  assert.equal(spawns.length, 1);
});

// Sanity check: hooks.log still gets the PostToolUse event regardless.
test('graph-rebuild: trigger does not suppress the base PostToolUse log line', async (t) => {
  await setupEnv(t);
  await installSpawnSentinel(t);
  const sid = 'gr-log';
  const cwd = await freshProjectCwd(t);

  await fireEdit({ sid, cwd, filePath: path.join(cwd, 'src/log.ts') });

  const raw = await fs.readFile(hooksLogPath(sid), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  const base = lines.find((l) => l.event === 'PostToolUse');
  assert.ok(base, 'base PostToolUse log line present');
  assert.equal(base.tool, 'Edit');
  assert.equal(base.ok, true);
});
