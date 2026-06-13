// Tests for lean-interventions T1 — hook-state plumbing:
//   - turnState.mjs       : PER_TURN_FIELDS allowlist + resetPerTurnFields
//   - toolResult.mjs      : classifyToolResult tri-state + toolExecutedOk legacy
//   - restore.mjs         : clearPendingRestore now clears fired_full_this_turn
//   - over-emit-safe      : absent == empty reader contract (no under-emit)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { PER_TURN_FIELDS, resetPerTurnFields } from '../lib/hooks/turnState.mjs';
import { classifyToolResult, toolExecutedOk } from '../lib/hooks/toolResult.mjs';
import { clearPendingRestore } from '../lib/hooks/restore.mjs';
import { turnStatePath } from '../lib/paths.mjs';
import { writeJsonAtomic, readJson, readModifyJson } from '../lib/io.mjs';

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
  const base = path.join(os.tmpdir(), 'sextant-ts-test-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

// ---------------------------------------------------------------------------
// turnState.mjs — the allowlist registry
// ---------------------------------------------------------------------------

test('PER_TURN_FIELDS contains exactly the four per-turn fields and no session field', () => {
  const keys = Object.keys(PER_TURN_FIELDS).sort();
  assert.deepEqual(keys, ['bash_bounced', 'cerebrum_read_nodes_seen', 'fired_full_this_turn', 'injected_nodes']);
  // Session-lifetime fields must NEVER be in the registry (each has a consumer
  // that breaks if reset per turn).
  for (const sessionField of [
    'turn_id', 'started_at', 'kw_general_last_turn',
    'mandatory_globals_digest', 'pending_restore', 'outside_root_approved',
  ]) {
    assert.ok(!(sessionField in PER_TURN_FIELDS), `${sessionField} must not be per-turn`);
  }
});

test('resetPerTurnFields clears every per-turn field and leaves session fields untouched', () => {
  const o = {
    injected_nodes: ['a', 'b'],
    cerebrum_read_nodes_seen: ['h1'],
    bash_bounced: ['cmd1'],
    fired_full_this_turn: { h9: true },
    // session fields that must survive:
    turn_id: 7,
    started_at: '2026-06-13T00:00:00Z',
    mandatory_globals_digest: 'abc',
    kw_general_last_turn: { hX: 3 },
    outside_root_approved: ['/etc/foo'],
  };
  resetPerTurnFields(o);
  assert.deepEqual(o.injected_nodes, []);
  assert.deepEqual(o.cerebrum_read_nodes_seen, []);
  assert.deepEqual(o.bash_bounced, []);
  assert.deepEqual(o.fired_full_this_turn, {});
  // session fields untouched:
  assert.equal(o.turn_id, 7);
  assert.equal(o.started_at, '2026-06-13T00:00:00Z');
  assert.equal(o.mandatory_globals_digest, 'abc');
  assert.deepEqual(o.kw_general_last_turn, { hX: 3 });
  assert.deepEqual(o.outside_root_approved, ['/etc/foo']);
});

test('resetPerTurnFields returns FRESH copies (two turns do not share a reference)', () => {
  const o = {};
  resetPerTurnFields(o);
  o.injected_nodes.push('x');
  o.fired_full_this_turn.h = true;
  resetPerTurnFields(o);
  assert.deepEqual(o.injected_nodes, [], 'array must be a fresh empty, not the mutated one');
  assert.deepEqual(o.fired_full_this_turn, {}, 'object must be a fresh empty');
});

test('resetPerTurnFields reproduces the legacy two-field reset exactly', () => {
  // The pre-T1 behavior set only injected_nodes=[] and cerebrum_read_nodes_seen=[].
  const o = { injected_nodes: ['n'], cerebrum_read_nodes_seen: ['s'] };
  resetPerTurnFields(o);
  assert.deepEqual(o.injected_nodes, []);
  assert.deepEqual(o.cerebrum_read_nodes_seen, []);
});

// ---------------------------------------------------------------------------
// toolResult.mjs — tri-state classifier
// ---------------------------------------------------------------------------

test('classifyToolResult returns success/error/unknown', () => {
  assert.equal(classifyToolResult({ tool_response: { is_error: false } }), 'success');
  assert.equal(classifyToolResult({ tool_response: { is_error: true } }), 'error');
  assert.equal(classifyToolResult({ tool_response: { is_error: 0 } }), 'success'); // falsy is_error
  assert.equal(classifyToolResult({ tool_response: { is_error: 1 } }), 'error');   // truthy is_error
  // unknown: absent / null / non-object / no is_error key
  assert.equal(classifyToolResult({}), 'unknown');
  assert.equal(classifyToolResult({ tool_response: null }), 'unknown');
  assert.equal(classifyToolResult({ tool_response: 'ok' }), 'unknown');
  assert.equal(classifyToolResult({ tool_response: { stdout: 'x' } }), 'unknown');
  assert.equal(classifyToolResult(null), 'unknown');
});

test('toolExecutedOk preserves legacy semantics: ok unless a CONFIRMED error (unknown counts as ok)', () => {
  assert.equal(toolExecutedOk({ tool_response: { is_error: false } }), true);
  assert.equal(toolExecutedOk({ tool_response: { is_error: true } }), false);
  assert.equal(toolExecutedOk({}), true);                       // unknown ⇒ ok (legacy default)
  assert.equal(toolExecutedOk({ tool_response: 'str' }), true); // unknown ⇒ ok
});

// ---------------------------------------------------------------------------
// restore.mjs — compaction clears fired_full_this_turn (not injected_nodes)
// ---------------------------------------------------------------------------

test('clearPendingRestore deletes fired_full_this_turn but preserves injected_nodes', async (t) => {
  await setupRuntime(t);
  const sid = 'ts-compact-' + crypto.randomUUID().slice(0, 8);
  const cwd = path.join(os.tmpdir(), 'sextant-ts-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  await writeJsonAtomic(turnStatePath(sid, cwd), {
    pending_restore: true,
    fired_full_this_turn: { h1: true, h2: true },
    injected_nodes: ['node-a'],
    mandatory_globals_digest: 'digest',
    kw_general_last_turn: { hk: 2 },
    bash_bounced: ['cmd-hash'],
  });

  await clearPendingRestore(sid, '2026-06-13T00:00:00.000Z', cwd);

  const ts = await readJson(turnStatePath(sid, cwd));
  assert.ok(!('fired_full_this_turn' in ts), 'fired_full_this_turn must be deleted on compaction');
  assert.ok(!('mandatory_globals_digest' in ts), 'globals digest still cleared (existing behavior)');
  assert.ok(!('kw_general_last_turn' in ts), 'kw clock still cleared (existing behavior)');
  assert.equal(ts.pending_restore, false);
  // injected_nodes is deliberately NOT compaction-cleared:
  assert.deepEqual(ts.injected_nodes, ['node-a'], 'injected_nodes must survive compaction (unchanged behavior)');
  // bash_bounced surviving is harmless and intended:
  assert.deepEqual(ts.bash_bounced, ['cmd-hash'], 'bash_bounced is not compaction-cleared');
});

// ---------------------------------------------------------------------------
// over-emit-safe: absent == empty (a lost update re-emits, never suppresses)
// ---------------------------------------------------------------------------

test('absent == empty reader contract: a missing/empty fired-flag reads as "not shown" (re-emit)', () => {
  // The documented reader pattern. All three states must read falsy → re-emit.
  const reader = (ts, h) => Boolean((ts.fired_full_this_turn || {})[h]);
  assert.equal(reader({}, 'h'), false, 'absent field reads as not-shown');
  assert.equal(reader({ fired_full_this_turn: {} }, 'h'), false, 'empty field reads as not-shown');
  assert.equal(reader({ fired_full_this_turn: { other: true } }, 'h'), false, 'missing hash reads as not-shown');
  assert.equal(reader({ fired_full_this_turn: { h: true } }, 'h'), true, 'recorded hash reads as shown');
});

test('concurrent unlocked writes to a per-turn field leave VALID json and never a stale "true"', async (t) => {
  await setupRuntime(t);
  const sid = 'ts-race-' + crypto.randomUUID().slice(0, 8);
  const cwd = path.join(os.tmpdir(), 'sextant-ts-race-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));

  await writeJsonAtomic(turnStatePath(sid, cwd), { fired_full_this_turn: {} });

  // Two "inject sites" racing to record their hash (record-AFTER-emit pattern).
  const recordHash = (h) => readModifyJson(turnStatePath(sid, cwd), (o) => {
    o.fired_full_this_turn = o.fired_full_this_turn || {};
    o.fired_full_this_turn[h] = true;
  });
  await Promise.all([recordHash('hA'), recordHash('hB')]);

  // The file must be valid JSON regardless of who won the race.
  const ts = await readJson(turnStatePath(sid, cwd));
  const map = ts.fired_full_this_turn || {};
  // Over-emit-safe invariant: every hash is either present(true) or absent(falsy)
  // — a lost update can only DROP a record (→ re-emit), never fabricate a stale
  // "true" for a hash that was never recorded.
  for (const h of ['hA', 'hB']) {
    const v = map[h];
    assert.ok(v === true || v === undefined, `${h} must be true or absent, got ${JSON.stringify(v)}`);
  }
  // And at least one of the two writes survived (no total loss).
  assert.ok(map.hA === true || map.hB === true, 'at least one concurrent record must survive');
});
