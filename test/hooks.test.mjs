// Tests for lib/hooks/*.mjs — direct invocation of each handler.
//
// Each test sets up an isolated SEXTANT_RUNTIME_BASE, instantiates a synthetic
// payload + ctx (mirroring what bin/cli.mjs builds), calls the handler, and
// asserts (a) hooks.log got the expected JSONL line and (b) any state
// mutation actually happened.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { runtimeBase, durableBase, hooksLogPath, runtimeFile, durableFile } from '../lib/paths.mjs';
import { readState, withState } from '../lib/state.mjs';
import { setOutputMode } from '../lib/config.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { readStats } from '../lib/stores/stats.mjs';
import { lineHash as cerebrumLineHash, CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

import sessionStart, { pickArm } from '../lib/hooks/sessionStart.mjs';
import {
  composeSessionStartBlock,
  relativeTime,
  SESSION_START_OPEN_MARKER,
  SESSION_START_CLOSE_MARKER,
} from '../lib/hooks/composeSessionStart.mjs';
import sessionEnd from '../lib/hooks/sessionEnd.mjs';
import userPromptSubmit from '../lib/hooks/userPromptSubmit.mjs';
import { composeTrancheNudge } from '../lib/hooks/tranchesInject.mjs';
import preToolUse from '../lib/hooks/preToolUse.mjs';
import postToolUse from '../lib/hooks/postToolUse.mjs';
import postToolUseFailure from '../lib/hooks/postToolUseFailure.mjs';
import preCompact from '../lib/hooks/preCompact.mjs';
import postCompact from '../lib/hooks/postCompact.mjs';
import fileChanged from '../lib/hooks/fileChanged.mjs';
import stop, { agentRepliedNoCaptures } from '../lib/hooks/stop.mjs';
import subagentStop from '../lib/hooks/subagentStop.mjs';
import notification from '../lib/hooks/notification.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';
import {
  SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  CONFIDENCE,
  GRAPH,
  NODE,
  EDGE,
  fileNodeId,
} from '../lib/graph/schema.mjs';

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

// A real (durable) project root with .sextant/config.json set to `mode`. The
// migrated hooks gate user-facing systemMessages on messageMode(cwd), which
// reads that file; pass the returned cwd as payload.cwd to exercise a mode.
async function projectWithMode(t, mode) {
  const cwd = path.join(os.tmpdir(), 'sextant-proj-' + crypto.randomUUID());
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  await setOutputMode(cwd, mode);
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

// systemMessage carries ANSI color; strip it for content assertions.
const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : s);

// Build a ctx object identical to what bin/cli.mjs constructs.
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

async function readLogLines(sid) {
  const raw = await fs.readFile(hooksLogPath(sid), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// -- logger -----------------------------------------------------------------

test('appendLog: creates the runtime dir and writes one JSONL line', async (t) => {
  await setupEnv(t);
  const sid = 'log-sid';
  // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
  await appendLog(sid, { ts: '2026-01-01T00:00:00Z', event: 'X', sid }, null);
  const lines = await readLogLines(sid);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'X');
  assert.equal(lines[0].sid, sid);
});

test('appendLog: multiple calls append; each line is independent JSON', async (t) => {
  await setupEnv(t);
  const sid = 'log-multi';
  // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
  await appendLog(sid, { event: 'A' }, null);
  await appendLog(sid, { event: 'B' }, null);
  await appendLog(sid, { event: 'C' }, null);
  const lines = await readLogLines(sid);
  assert.deepEqual(lines.map((l) => l.event), ['A', 'B', 'C']);
});

// -- pickArm ----------------------------------------------------------------

test('pickArm: deterministic per sessionId', () => {
  // Same input → same output across calls.
  const a1 = pickArm('hello');
  const a2 = pickArm('hello');
  assert.equal(a1, a2);
  // Always 'A' or 'B'.
  assert.ok(a1 === 'A' || a1 === 'B', `expected A|B got ${a1}`);
});

test('pickArm: distributes A and B across many sids', () => {
  let a = 0, b = 0;
  for (let i = 0; i < 200; i++) {
    const arm = pickArm(`sid-${i}`);
    if (arm === 'A') a++;
    else b++;
  }
  // Loose sanity bounds — 200 sha256 first-bytes should be roughly balanced.
  assert.ok(a > 50 && b > 50, `unbalanced: A=${a} B=${b}`);
});

// -- SessionStart -----------------------------------------------------------

test('sessionStart: logs + sets ab_arm + does not zero cumulative counters', async (t) => {
  await setupEnv(t);
  const sid = 'sess-start';

  // Pre-seed cumulative state so we can confirm SessionStart didn't reset it.
  await withState(sid, null, (s) => {
    s.reads.total = 42;
    s.bugs.open = 3;
  });

  await sessionStart({ session_id: sid, cwd: '/foo' }, makeCtx(sid, 'SessionStart'));

  const state = await readState(sid);
  assert.ok(state.ab_arm === 'A' || state.ab_arm === 'B');
  assert.equal(state.reads.total, 42, 'cumulative reads must persist');
  assert.equal(state.bugs.open, 3, 'cumulative bugs must persist');

  const lines = await readLogLines(sid);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'SessionStart');
  assert.equal(lines[0].sid, sid);
  assert.equal(lines[0].cwd, '/foo');
  // ts must be a parseable date
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
});

test('sessionStart: ab_arm matches pickArm for the sid', async (t) => {
  await setupEnv(t);
  const sid = 'sess-arm-check';
  await sessionStart({ session_id: sid, cwd: '/x' }, makeCtx(sid, 'SessionStart'));
  const state = await readState(sid);
  assert.equal(state.ab_arm, pickArm(sid));
});

// -- SessionStart Phase 1a (composeSessionStart) ----------------------------

// Small fs helper for tests that need an on-disk .sextant/ tree.
async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('composeSessionStartBlock: returns null when nothing to emit', () => {
  const r = composeSessionStartBlock({
    projectMd: null,
    lastJson: null,
    graphStats: null,
    isStale: false,
  });
  assert.equal(r, null);
});

test('composeSessionStartBlock: project.md alone produces a fenced block', () => {
  const r = composeSessionStartBlock({
    projectMd: '# Test Project\n\n## Stack\nNode 20',
    lastJson: null,
    graphStats: null,
    isStale: false,
  });
  assert.ok(typeof r === 'string');
  assert.ok(r.startsWith(SESSION_START_OPEN_MARKER));
  assert.ok(r.endsWith(SESSION_START_CLOSE_MARKER));
  // R13: imperative line present
  assert.ok(r.includes('Follow the project conventions and context below'));
  assert.ok(r.includes('# Test Project'));
  assert.ok(r.includes('Node 20'));
});

test('composeSessionStartBlock: last.json with full shape renders sentence', () => {
  const r = composeSessionStartBlock({
    projectMd: null,
    lastJson: { ended_at: '2026-05-10T12:00:00Z', focus: 'auth refactor', open_todos: ['fix A', 'fix B'] },
    graphStats: null,
    isStale: false,
  });
  assert.ok(r.includes('## Last session'));
  assert.ok(r.includes('Last session ended at 2026-05-10T12:00:00Z'));
  assert.ok(r.includes('working on auth refactor'));
  assert.ok(r.includes('open todos: fix A, fix B'));
});

test('composeSessionStartBlock: last.json with missing fields renders gracefully', () => {
  // No ended_at, no focus — just open_todos.
  const r = composeSessionStartBlock({
    projectMd: null,
    lastJson: { open_todos: ['only todo'] },
    graphStats: null,
    isStale: false,
  });
  assert.ok(r.includes('## Last session'));
  assert.ok(r.includes('open todos: only todo'));
  assert.ok(!r.includes('ended at'));
  assert.ok(!r.includes('working on'));
});

test('composeSessionStartBlock: empty last.json (no useful fields) suppresses section', () => {
  const r = composeSessionStartBlock({
    projectMd: '# P',
    lastJson: {},
    graphStats: null,
    isStale: false,
  });
  // project.md remained, but no "Last session" header.
  assert.ok(r.includes('# P'));
  assert.ok(!r.includes('## Last session'));
});

test('composeSessionStartBlock: graph stats render with relative time', () => {
  const now = 1_700_000_000_000; // fixed reference epoch ms
  const builtAtMs = now - (2 * 60 * 60 * 1000); // 2 hours ago
  const r = composeSessionStartBlock({
    projectMd: null,
    lastJson: null,
    graphStats: { files: 42, builtAtMs },
    isStale: false,
    now: () => now,
  });
  assert.ok(r.includes('## Graph'));
  assert.ok(r.includes('Graph: 42 files indexed, last build 2h ago.'));
  assert.ok(!r.includes('stale'));
});

test('composeSessionStartBlock: isStale appends the hint', () => {
  const now = 1_700_000_000_000;
  const r = composeSessionStartBlock({
    projectMd: null,
    lastJson: null,
    graphStats: { files: 7, builtAtMs: now - (48 * 60 * 60 * 1000) },
    isStale: true,
    now: () => now,
  });
  assert.ok(r.includes('Graph: 7 files indexed, last build 2d ago.'));
  assert.ok(r.includes('(stale — run /sextant:graph-build)'));
});

// --- T2: carry-forward concern surfacing at SessionStart ------------------

test('composeSessionStartBlock: surfaces open carry-forward concerns + reminder count', () => {
  const block = composeSessionStartBlock({
    trancheState: {
      feature: 'tranche-unknowns',
      workflow_state: 'IMPLEMENTING',
      active_tranche_id: '2',
      tranches: [{ id: '2', title: 'T2', status: 'IN-FLIGHT', doc_path: 'docs/t2.md' }],
      carry_forward: [
        { id: '1', text: 'normalize URL params across producers', status: 'open', raised_by: '1', target: '2' },
        { id: '2', text: 'audit row reversibility', status: 'open', raised_by: '1', target: null },
        { id: '3', text: 'already handled', status: 'resolved', raised_by: '1', target: null },
      ],
    },
    trancheDocParsed: null,
    now: () => 0,
  });
  assert.match(block, /Carry-forward concerns \(open: 2\):/);
  assert.match(block, /#1 ← for this tranche: normalize URL params across producers/);
  assert.match(block, /#2: audit row reversibility/);
  assert.ok(!block.includes('already handled'), 'resolved concerns are not listed');
  // Count folded into the first-turn reminder.
  assert.match(block, /The feature has 2 open carry-forward concerns that must be consumed before it can finalize\./);
});

test('composeSessionStartBlock: no concern block or reminder when none are open', () => {
  const block = composeSessionStartBlock({
    trancheState: {
      feature: 'F',
      workflow_state: 'IMPLEMENTING',
      active_tranche_id: '1',
      tranches: [{ id: '1', title: 'T1', status: 'IN-FLIGHT' }],
      carry_forward: [{ id: '1', text: 'done', status: 'resolved', raised_by: '1', target: null }],
    },
    trancheDocParsed: null,
    now: () => 0,
  });
  assert.ok(!block.includes('Carry-forward concerns'));
  assert.ok(!block.includes('carry-forward concern'), 'no reminder clause when none open');
});

// --- T3: per-turn nudge surfaces current-phase unknowns + concerns --------

test('composeTrancheNudge: renders before-ship questions + concerns, capped at 3', () => {
  const ts = {
    feature: 'F',
    charter_path: 'c',
    spec_path: 's',
    active_tranche_id: '2',
    tranches: [{ id: '2', title: 'T2', status: 'IN-FLIGHT', scope: ['src/a.ts'], doc_path: 'd' }],
  };
  const block = composeTrancheNudge(ts, null, {
    unknowns: { label: 'before ship', items: ['q1', 'q2', 'q3', 'q4'] },
    concerns: [{ id: '5', text: 'consume me', target: '2' }],
  });
  assert.match(block, /Open questions before ship \(4\) — resolve before shipping \(or escalate to a concern\):/);
  assert.match(block, /- q1/);
  assert.match(block, /- q3/);
  assert.ok(!block.includes('q4'), 'caps at 3 items');
  assert.match(block, /…\+1 more \(\/sextant:tranche-status\)/);
  assert.match(block, /Open carry-forward concerns for this tranche \(1\)/);
  assert.match(block, /- #5: consume me/);
});

test('composeTrancheNudge: no extras → no attention lines (backward compatible)', () => {
  const ts = {
    feature: 'F',
    charter_path: 'c',
    spec_path: 's',
    active_tranche_id: '1',
    tranches: [{ id: '1', title: 'T1', status: 'IN-FLIGHT', scope: [], doc_path: 'd' }],
  };
  const block = composeTrancheNudge(ts, 'A. thing');
  assert.match(block, /Active: T1 "T1" — IN-FLIGHT/);
  assert.ok(!block.includes('Open questions before ship'));
  assert.ok(!block.includes('carry-forward concerns for this tranche'));
});

test('relativeTime: known buckets', () => {
  assert.equal(relativeTime(-100), 'just now');
  assert.equal(relativeTime(0), '0s ago');
  assert.equal(relativeTime(59_000), '59s ago');
  assert.equal(relativeTime(60_000), '1m ago');
  assert.equal(relativeTime(60 * 60 * 1000), '1h ago');
  assert.equal(relativeTime(48 * 60 * 60 * 1000), '2d ago');
});

// -- SessionStart Phase 1a (integration with handler) -----------------------

test('sessionStart: project.md is injected as additionalContext', async (t) => {
  await setupEnv(t);
  const sid = 'ss-proj';
  const cwd = await freshProjectCwd(t);
  await writeFile(durableFile(cwd, 'project.md'), '# My Project\n\n## Stack\nTypeScript');

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));

  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput in result');
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string', `expected additionalContext string, got: ${ctx}`);
  assert.ok(ctx.startsWith(SESSION_START_OPEN_MARKER), 'should start with the open marker');
  assert.ok(ctx.endsWith(SESSION_START_CLOSE_MARKER), 'should end with the close marker');
  assert.ok(ctx.includes('# My Project'));
  assert.ok(ctx.includes('TypeScript'));
});

test('sessionStart: last.json produces the "last session" line', async (t) => {
  await setupEnv(t);
  const sid = 'ss-last';
  const cwd = await freshProjectCwd(t);
  const last = { ended_at: '2026-05-10T00:00:00Z', focus: 'tests', open_todos: ['ship'] };
  await writeFile(path.join(durableBase(cwd), 'session', 'last.json'), JSON.stringify(last));

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));

  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput in result');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('## Last session'));
  assert.ok(ctx.includes('ended at 2026-05-10T00:00:00Z'));
  assert.ok(ctx.includes('working on tests'));
  assert.ok(ctx.includes('open todos: ship'));
});

test('sessionStart: no project.md and no last.json returns undefined (no envelope)', async (t) => {
  await setupEnv(t);
  const sid = 'ss-empty';
  const cwd = await freshProjectCwd(t);

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  assert.equal(result, undefined, 'expected no JSON envelope when there is nothing to say');

  // State still got written.
  const state = await readState(sid);
  assert.ok(state.ab_arm === 'A' || state.ab_arm === 'B');
});

test('sessionStart: stale graph sets state.graph.state and emits systemMessage', async (t) => {
  await setupEnv(t);
  const sid = 'ss-stale';
  const cwd = await freshProjectCwd(t);
  // Build a valid graph.json then backdate its mtime + built_at to 48h ago.
  const graphPath = path.join(durableBase(cwd), 'graph', 'graph.json');
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const graph = {
    schema_version: 1,
    nodes: [],
    edges: [],
    built_at: fortyEightHoursAgo,
    stats: { files: 0, edges: 0 },
  };
  await writeFile(graphPath, JSON.stringify(graph));
  // Also backdate mtime as a belt-and-suspenders fallback.
  const utime = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
  await fs.utimes(graphPath, utime, utime);

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));

  // State carries graph.state='stale'.
  const state = await readState(sid);
  assert.equal(state.graph.state, 'stale');

  // systemMessage fires once.
  assert.ok(result && typeof result.systemMessage === 'string', `expected systemMessage; got ${JSON.stringify(result)}`);
  assert.match(result.systemMessage, /stale/);
  assert.match(result.systemMessage, /\/sextant:graph-build/);

  // graph_stale is session-scoped → key lands in the session map (survives Stop).
  assert.equal(state.systemmessage_fired_session.graph_stale, true);
});

test('sessionStart: systemMessage does NOT fire twice in the same session (suppression)', async (t) => {
  await setupEnv(t);
  const sid = 'ss-stale-suppress';
  const cwd = await freshProjectCwd(t);
  const graphPath = path.join(durableBase(cwd), 'graph', 'graph.json');
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await writeFile(graphPath, JSON.stringify({
    schema_version: 1, nodes: [], edges: [],
    built_at: fortyEightHoursAgo, stats: { files: 0, edges: 0 },
  }));
  const utime = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
  await fs.utimes(graphPath, utime, utime);

  // First fire: should emit.
  const r1 = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  assert.ok(r1 && r1.systemMessage, 'first fire should emit systemMessage');

  // Second fire (simulating SessionStart after /clear): MUST NOT re-emit.
  const r2 = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  assert.ok(!r2 || !r2.systemMessage, `second fire should NOT emit systemMessage, got ${JSON.stringify(r2)}`);

  // state.graph.state should still be 'stale'.
  const state = await readState(sid);
  assert.equal(state.graph.state, 'stale');
});

test('sessionStart: verbose mode disables systemMessage suppression', async (t) => {
  await setupEnv(t);
  const sid = 'ss-verbose';
  const cwd = await freshProjectCwd(t);
  await setOutputMode(cwd, 'verbose');
  const graphPath = path.join(durableBase(cwd), 'graph', 'graph.json');
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await writeFile(graphPath, JSON.stringify({
    schema_version: 1, nodes: [], edges: [],
    built_at: fortyEightHoursAgo, stats: { files: 0, edges: 0 },
  }));
  const utime = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
  await fs.utimes(graphPath, utime, utime);

  const r1 = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  const r2 = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  assert.ok(r1 && r1.systemMessage);
  assert.ok(r2 && r2.systemMessage, 'verbose mode should re-emit (bypasses one-shot suppression)');
});

test('sessionStart: fresh graph (< threshold) does NOT mark stale', async (t) => {
  await setupEnv(t);
  const sid = 'ss-fresh';
  const cwd = await freshProjectCwd(t);
  const graphPath = path.join(durableBase(cwd), 'graph', 'graph.json');
  // Built 1 hour ago — well under the 24h default.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(graphPath, JSON.stringify({
    schema_version: 1, nodes: [], edges: [],
    built_at: oneHourAgo, stats: { files: 5, edges: 2 },
  }));

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));
  const state = await readState(sid);
  // Default state.graph.state is 'idle' (per defaultState in lib/state.mjs);
  // we should NOT have flipped it.
  assert.equal(state.graph.state, 'idle');
  // No systemMessage.
  assert.ok(!result || !result.systemMessage);

  // Should still surface the graph stats in additionalContext.
  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Graph: 5 files indexed'));
  assert.ok(!ctx.includes('(stale'));
});

// -- SessionEnd -------------------------------------------------------------

test('sessionEnd: logs + resets turn/session counters but keeps cumulative', async (t) => {
  await setupEnv(t);
  const sid = 'sess-end';

  await withState(sid, null, (s) => {
    s.rules.fires_this_turn = 5;
    s.rules.mandatory_fires = 2;
    s.rules.deny_red = true;
    s.systemmessage_fired = { foo: true };
    s.reads.total = 100;
    s.bugs.open = 4;
  });

  await sessionEnd({ session_id: sid }, makeCtx(sid, 'SessionEnd'));

  const state = await readState(sid);
  assert.equal(state.rules.fires_this_turn, 0);
  assert.equal(state.rules.mandatory_fires, 0);
  assert.equal(state.rules.deny_red, false);
  assert.deepEqual(state.systemmessage_fired, {});
  assert.equal(state.reads.total, 100, 'cumulative reads preserved');
  assert.equal(state.bugs.open, 4, 'cumulative bugs preserved');

  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'SessionEnd');
});

// -- UserPromptSubmit -------------------------------------------------------

test('userPromptSubmit: logs and returns nothing', async (t) => {
  await setupEnv(t);
  const sid = 'ups';
  const result = await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  assert.equal(result, undefined);
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'UserPromptSubmit');
});

// -- PreToolUse -------------------------------------------------------------

test('preToolUse: Read increments reads.total', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-read';
  await preToolUse(
    { session_id: sid, tool_name: 'Read', tool_input: { file_path: '/a' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);

  await preToolUse(
    { session_id: sid, tool_name: 'Read', tool_input: { file_path: '/b' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const state2 = await readState(sid);
  assert.equal(state2.reads.total, 2);

  const lines = await readLogLines(sid);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'Read');
});

test('preToolUse: Edit does NOT increment reads.total', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-edit';
  await preToolUse(
    { session_id: sid, tool_name: 'Edit', tool_input: {} },
    makeCtx(sid, 'PreToolUse'),
  );
  const state = await readState(sid);
  assert.equal(state.reads.total, 0);

  const lines = await readLogLines(sid);
  assert.equal(lines[0].tool, 'Edit');
});

test('preToolUse: Bash does NOT increment reads.total', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const state = await readState(sid);
  assert.equal(state.reads.total, 0);
});

// -- PreToolUse Phase 1a (Read injection) -----------------------------------

// Helper: write a synthetic graph.json into a project root.
async function writeSyntheticGraph(cwd, graph) {
  const dir = path.join(durableBase(cwd), 'graph');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'graph.json'), JSON.stringify(graph), 'utf8');
}

function syntheticGraph() {
  // src/a.ts imports src/b.ts; src/c.ts imports src/a.ts.
  const aId = fileNodeId('src/a.ts');
  const bId = fileNodeId('src/b.ts');
  const cId = fileNodeId('src/c.ts');
  return {
    [GRAPH.SCHEMA_VERSION]: SCHEMA_VERSION,
    [GRAPH.NODES]: [
      { [NODE.ID]: aId, [NODE.TYPE]: NODE_TYPES.FILE, [NODE.LABEL]: 'a.ts', [NODE.PATH]: 'src/a.ts', [NODE.SYMBOLS]: ['alpha', 'Beta'], [NODE.COMMUNITY]: null },
      { [NODE.ID]: bId, [NODE.TYPE]: NODE_TYPES.FILE, [NODE.LABEL]: 'b.ts', [NODE.PATH]: 'src/b.ts', [NODE.SYMBOLS]: ['b'], [NODE.COMMUNITY]: null },
      { [NODE.ID]: cId, [NODE.TYPE]: NODE_TYPES.FILE, [NODE.LABEL]: 'c.ts', [NODE.PATH]: 'src/c.ts', [NODE.SYMBOLS]: ['c'], [NODE.COMMUNITY]: null },
    ],
    [GRAPH.EDGES]: [
      { [EDGE.FROM]: aId, [EDGE.TO]: bId, [EDGE.TYPE]: EDGE_TYPES.IMPORTS, [EDGE.CONFIDENCE]: CONFIDENCE.INTRA_FILE_ONLY },
      { [EDGE.FROM]: cId, [EDGE.TO]: aId, [EDGE.TYPE]: EDGE_TYPES.IMPORTS, [EDGE.CONFIDENCE]: CONFIDENCE.INTRA_FILE_ONLY },
    ],
    [GRAPH.BUILT_AT]: new Date().toISOString(),
    [GRAPH.STATS]: { files: 3, edges: 2 },
  };
}

test('preToolUse: Read of a graph file with no rules returns undefined (wallpaper moved to Write)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-graph-hit';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  // Read-context hygiene: the advisory wallpaper (graph/bug/Lunr) no longer
  // rides on Read — it moved to the Edit/Write path. With no mandatory rules to
  // emit, Read returns nothing.
  assert.equal(result, undefined, 'Read no longer emits graph wallpaper');

  // Phase 0 contract preserved: reads.total bumped.
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);
});

test('preToolUse: Edit of a graph file emits the advisory wallpaper (read-context hygiene)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-edit-wallpaper';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, `Edit now emits wallpaper; got ${JSON.stringify(result)}`);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('<!-- sextant:read-context -->'));
  assert.ok(ctx.includes('<!-- /sextant:read-context -->'));
  assert.match(ctx, /graph: a\.ts; community: none/);
  assert.match(ctx, /-> b\.ts \[imports, intra-file-only\]/);
  assert.match(ctx, /<- c\.ts \[imports, intra-file-only\]/);
  assert.match(ctx, /symbols \(up to 20\): alpha\(\), Beta/);

  // Edit does not bump reads.total (Phase 0 = Read only).
  const state = await readState(sid);
  assert.equal(state.reads.total, 0);
});

test('preToolUse: Read of a file NOT in the graph returns undefined', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-graph-miss';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/unknown.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.equal(result, undefined);
  // But reads.total still incremented.
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);
});

test('preToolUse: Read without graph.json returns undefined (graceful passthrough)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-graph';
  const cwd = await freshProjectCwd(t);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.equal(result, undefined);
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);
});

test('preToolUse: Edit of a file NOT in the graph and with no rules returns undefined', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-edit-passthrough';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // A file absent from the graph + no bugs + no Lunr hits → no wallpaper, no
  // node/keyword rules → no block.
  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/unknown.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.equal(result, undefined);
  // Reads.total unchanged for Edit.
  const state = await readState(sid);
  assert.equal(state.reads.total, 0);
});

test('preToolUse: restore + read concat never clips a read-context block mid-marker', async (t) => {
  // Regression for the old slice-to-headroom bug: when the restore block + the
  // per-Read rule floor exceeded the 10K budget, the read block was sliced
  // mid-string, which could cut an opening `<!-- sextant:read-context -->` off
  // from its close. The fix drops the per-Read block WHOLE instead, so the
  // markers in the combined output are always balanced.
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-concat-balance';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // A large mandatory floor (~80 node rules) so the per-Read block is big.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  const ruleLines = [];
  for (let i = 0; i < 80; i++) {
    ruleLines.push(`- 2026-05-10: [!] [node:src/a.ts] mandatory rule number ${i} padded out to roughly one hundred and twenty characters so the floor block grows past the budget`);
  }
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), CEREBRUM_V2_HEADER + '\n' + ruleLines.join('\n') + '\n', 'utf8');

  // Seed a pending restore snapshot with a sizeable payload.
  const { writeJsonAtomic } = await import('../lib/io.mjs');
  const restoreRules = [];
  for (let i = 0; i < 30; i++) restoreRules.push(`restored rule ${i} with enough text to make the restoration block a few thousand characters long in total`);
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), { pending_restore: true, snapshot_ts: '2026-06-04T00:00:00Z' });
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json'), {
    ts: '2026-06-04T00:00:00Z',
    payload: { rules: restoreRules, todos: null, files: [], bugs: [], commits: [] },
  });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, 'expected a combined block');
  const ctx = result.hookSpecificOutput.additionalContext;
  const open = (ctx.match(/<!-- sextant:read-context -->/g) || []).length;
  const close = (ctx.match(/<!-- \/sextant:read-context -->/g) || []).length;
  assert.equal(open, close, `read-context markers must be balanced (never clipped mid-block); open=${open} close=${close}`);
  // The restore block always survives (it goes first and is never clipped).
  assert.ok(ctx.includes('<!-- sextant:post-compact-restore -->'), 'restore block present');
});

test('preToolUse: Read with no cwd returns undefined (defensive)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-cwd';
  const result = await preToolUse(
    { session_id: sid, tool_name: 'Read', tool_input: { file_path: '/some/abs/path.ts' } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.equal(result, undefined);
  // Reads still increments — Phase 0 contract is independent of injection.
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);
});

test('preToolUse: Read with no tool_input.file_path returns undefined', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-filepath';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: {} },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.equal(result, undefined);
  const state = await readState(sid);
  assert.equal(state.reads.total, 1);
});

// -- PreToolUse Phase 2c (mandatory rules injection) -----------------------

test('preToolUse: Read with mandatory rules in cerebrum injects priority-1 block + bumps rule fires', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-mandatory-hit';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Populated cerebrum.md (T3.5 single store): one global rule, one node-scoped
  // rule for src/a.ts, plus an unrelated node-scoped rule that should NOT fire.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [!] [!global] always run prettier (by: sess-1)',
      '- 2026-05-10: [!] [node:src/a.ts] never log secrets (by: sess-1)',
      '- 2026-05-10: [!] [node:src/other.ts] unrelated rule (by: sess-2)',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, 'should return hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /rules \(2\):/, 'priority-1 header with count=2');
  assert.match(ctx, /always run prettier/, 'global rule rendered');
  assert.match(ctx, /never log secrets/, 'node-scoped rule rendered');
  assert.ok(!ctx.includes('unrelated rule'), 'non-matching node rule should be filtered');

  // Read is now rules-only — the graph identity wallpaper moved to the Write
  // path, so there is no `graph:` line on Read to order against.
  assert.ok(!ctx.includes('graph:'), 'Read emits no graph wallpaper');

  // State counters updated: 2 fires for 2 mandatory rules.
  const state = await readState(sid);
  assert.equal(state.rules.fires_this_turn, 2, 'fires_this_turn += 2');
  assert.equal(state.rules.mandatory_fires, 2, 'mandatory_fires += 2');
  // reads.total still bumped from Phase 0 contract.
  assert.equal(state.reads.total, 1);
});

test('preToolUse: Read with empty mandatory.md does NOT include the mandatory block', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-mandatory-empty';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(path.join(cerebrumDir, 'mandatory.md'), '<!-- empty -->\n', 'utf8');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  // Empty cerebrum → no mandatory rules; Read no longer emits graph wallpaper
  // → no block at all.
  assert.equal(result, undefined, 'empty cerebrum + no Read wallpaper → no block');

  const state = await readState(sid);
  // No mandatory rules fired → counters stay at 0.
  assert.equal(state.rules.fires_this_turn ?? 0, 0);
  assert.equal(state.rules.mandatory_fires ?? 0, 0);
});

test('preToolUse: Read surfaces a v2 BM25-ranked [kw:] rule at priority-1 with a [kw] label (cerebrum-v2 T3)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-v2-kw-ranked';
  const cwd = await freshProjectCwd(t);
  // v2 one store, no graph: a [kw:billing] ranked rule (NO '!') + filler kw rules
  // so 'billing' is discriminating. End-to-end regression for the hook↔compose
  // seam: a BM25-surfaced kw rule carries only [kw:…] and must render at
  // priority-1 as [kw], not be silently dropped.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  let body = '- 2026-06-01: [kw:billing] ranked billing rule\n';
  for (const k of ['auth', 'docker', 'cache', 'render', 'parser', 'graph']) {
    body += `- 2026-06-01: [kw:${k}] ${k} rule\n`;
  }
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), CEREBRUM_V2_HEADER + '\n' + body, 'utf8');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/billing.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput, 'v2 BM25 kw match emits additionalContext');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /rules \(1\):/, 'priority-1 block with the single kw match');
  assert.match(ctx, /• \[kw\] ranked billing rule/, 'ranked kw rule renders with the [kw] label (not dropped)');
  assert.ok(!ctx.includes('docker rule'), 'a non-matching kw rule does not fire');
});

test('preToolUse: Read does NOT leak a v2 [provisional] rule into the priority-8 body-ranked block (cerebrum-v2 T3)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-v2-prov-pri8';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph()); // src/a.ts node carries symbol 'alpha'

  // A [provisional] rule whose BODY contains 'alpha' (a genuine priority-8
  // candidate via buildLunrQuery's symbol terms) but whose KEYWORD won't match
  // the file_path corpus — so the kw branch never fires it, and the ONLY thing
  // that can exclude it from the ranked block is the priority-8 bucket filter.
  // Filler rules make 'alpha' discriminating so its body match clears 0.3.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  let body = '- 2026-06-01: [provisional] [kw:zzznomatch] alpha alpha handling is delicate\n';
  for (const k of ['one', 'two', 'three', 'four', 'five']) {
    body += `- 2026-06-01: [kw:${k}] unrelated ${k} guidance\n`;
  }
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), CEREBRUM_V2_HEADER + '\n' + body, 'utf8');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  // Graph hit always emits a block; the provisional body must be absent from it.
  const ctx = (result && result.hookSpecificOutput && result.hookSpecificOutput.additionalContext) || '';
  assert.ok(!ctx.includes('alpha handling is delicate'),
    `provisional rule must not leak into the priority-8 ranked block; got:\n${ctx}`);
});

test('preToolUse: Read with mandatory rule + no graph still injects (Phase 2c independence)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-mandatory-no-graph';
  const cwd = await freshProjectCwd(t);
  // No graph.json — Phase 1a would return undefined here, but Phase 2c still
  // surfaces the mandatory rule.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [!global] always run linter\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/random.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, 'mandatory rules alone trigger injection');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /rules \(1\):/);
  assert.match(ctx, /always run linter/);
});

// -- PostToolUse ------------------------------------------------------------

test('postToolUse: logs ok=true when tool_response has no is_error', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-post-ok';
  await postToolUse(
    { session_id: sid, tool_name: 'Read', tool_response: { content: 'x' } },
    makeCtx(sid, 'PostToolUse'),
  );
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'PostToolUse');
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].tool, 'Read');
});

test('postToolUse: logs ok=false when tool_response.is_error=true', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-post-err';
  await postToolUse(
    { session_id: sid, tool_name: 'Edit', tool_response: { is_error: true } },
    makeCtx(sid, 'PostToolUse'),
  );
  const lines = await readLogLines(sid);
  assert.equal(lines[0].ok, false);
});

test('postToolUse: missing tool_response defaults ok=true', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-post-missing';
  await postToolUse(
    { session_id: sid, tool_name: 'Bash' },
    makeCtx(sid, 'PostToolUse'),
  );
  const lines = await readLogLines(sid);
  assert.equal(lines[0].ok, true);
});

// -- PostToolUseFailure -----------------------------------------------------

test('postToolUseFailure: logs', async (t) => {
  await setupEnv(t);
  const sid = 'ptuf';
  await postToolUseFailure(
    { session_id: sid, tool_name: 'Bash' },
    makeCtx(sid, 'PostToolUseFailure'),
  );
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'PostToolUseFailure');
  assert.equal(lines[0].tool, 'Bash');
});

// -- PreCompact -------------------------------------------------------------

test('preCompact: writes precompact.json + turn-state.json with pending_restore', async (t) => {
  await setupEnv(t);
  const sid = 'pc';
  const cwd = await projectWithMode(t, 'verbose'); // snapshot line is routine → verbose-only
  const result = await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));

  // precompact.json — Phase 2.5: payload has rules array + todos null when
  // no rules-fired.jsonl and no transcript_path is present. Phase 9 adds
  // files/bugs/commits sections (all empty when nothing is on disk).
  const pcRaw = await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8');
  const pc = JSON.parse(pcRaw);
  assert.equal(pc.schema_version, 1);
  assert.equal(pc.compaction_n, 1);
  assert.ok(!Number.isNaN(Date.parse(pc.ts)));
  assert.deepEqual(pc.payload, { rules: [], todos: null, files: [], bugs: [], commits: [], tranche: null });

  // turn-state.json
  const tsRaw = await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8');
  const tsObj = JSON.parse(tsRaw);
  assert.equal(tsObj.pending_restore, true);
  assert.ok(!Number.isNaN(Date.parse(tsObj.snapshot_ts)));

  // statusline-state.json got compaction.compaction_n bumped + last_snapshot_ts set.
  const state = await readState(sid);
  assert.equal(state.compaction.compaction_n, 1);
  assert.ok(!Number.isNaN(Date.parse(state.compaction.last_snapshot_ts)));

  // Phase 2.5: emits a routine systemMessage "snapshot saved…" (verbose-only,
  // ANSI-colored, lowercase `sextant:` prefix).
  assert.ok(result && typeof result.systemMessage === 'string');
  assert.match(stripAnsi(result.systemMessage), /sextant: snapshot saved/);

  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'PreCompact');
});

test('preCompact: a second fire increments compaction_n to 2', async (t) => {
  await setupEnv(t);
  const sid = 'pc-twice';
  await preCompact({ session_id: sid }, makeCtx(sid, 'PreCompact'));
  await preCompact({ session_id: sid }, makeCtx(sid, 'PreCompact'));
  const state = await readState(sid);
  assert.equal(state.compaction.compaction_n, 2);

  // turn-state.json carries compaction_n=2.
  const tsRaw = await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8');
  assert.equal(JSON.parse(tsRaw).compaction_n, 2);
});

test('preCompact: preserves unrelated fields in turn-state.json (read-modify)', async (t) => {
  await setupEnv(t);
  const sid = 'pc-preserve';

  // Pre-seed turn-state.json with a Phase 2.5-style field we shouldn't clobber.
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    dedup_keys: ['rule-a', 'rule-b'],
    phase25_marker: true,
  });

  await preCompact({ session_id: sid }, makeCtx(sid, 'PreCompact'));

  const after = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(after.pending_restore, true, 'pending_restore set by preCompact');
  assert.ok(!Number.isNaN(Date.parse(after.snapshot_ts)), 'snapshot_ts is a valid ISO date');
  assert.deepEqual(after.dedup_keys, ['rule-a', 'rule-b'], 'Phase 2.5-style field preserved');
  assert.equal(after.phase25_marker, true, 'other Phase 2.5-style field preserved');
});

// -- PostCompact ------------------------------------------------------------

test('postCompact: sets last_restore_ts; emits routine systemMessage under verbose; NO additionalContext', async (t) => {
  await setupEnv(t);
  const sid = 'post-compact';
  const cwd = await projectWithMode(t, 'verbose');
  const result = await postCompact({ session_id: sid, cwd }, makeCtx(sid, 'PostCompact'));

  // Routine line surfaces under verbose. Per R7 PostCompact MUST NOT emit
  // additionalContext. Message carries ANSI color + the lowercase `sextant:`
  // prefix; strip escapes for the content check.
  assert.ok(result && typeof result.systemMessage === 'string');
  assert.match(stripAnsi(result.systemMessage), /sextant: post-compact restoration ready/);
  assert.ok(!('hookSpecificOutput' in result),
    'PostCompact must not emit hookSpecificOutput (no additionalContext)');

  const state = await readState(sid);
  assert.ok(!Number.isNaN(Date.parse(state.compaction.last_restore_ts)));
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'PostCompact');
});

test('postCompact: routine line is suppressed under quiet; state still updates', async (t) => {
  await setupEnv(t);
  const sid = 'post-compact-quiet';
  const cwd = await projectWithMode(t, 'quiet');
  const r = await postCompact({ session_id: sid, cwd }, makeCtx(sid, 'PostCompact'));
  assert.equal(r, undefined, 'no systemMessage under quiet (routine level)');
  const state = await readState(sid);
  assert.ok(!Number.isNaN(Date.parse(state.compaction.last_restore_ts)), 'last_restore_ts still set');
});

// -- FileChanged ------------------------------------------------------------

test('fileChanged: logs the file_path', async (t) => {
  await setupEnv(t);
  const sid = 'fc';
  await fileChanged(
    { session_id: sid, file_path: '/some/file.ts' },
    makeCtx(sid, 'FileChanged'),
  );
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'FileChanged');
  assert.equal(lines[0].file, '/some/file.ts');
});

test('fileChanged: missing file_path logs null', async (t) => {
  await setupEnv(t);
  const sid = 'fc-null';
  await fileChanged({ session_id: sid }, makeCtx(sid, 'FileChanged'));
  const lines = await readLogLines(sid);
  assert.equal(lines[0].file, null);
});

// -- Stop -------------------------------------------------------------------

test('stop: resets rules.fires_this_turn to 0', async (t) => {
  await setupEnv(t);
  const sid = 'stop-test';

  // Pre-seed fires_this_turn=5 as required by the task spec.
  await withState(sid, null, (s) => {
    s.rules.fires_this_turn = 5;
    s.rules.mandatory_fires = 3;
    s.reads.total = 50;
  });

  await stop({ session_id: sid }, makeCtx(sid, 'Stop'));

  const state = await readState(sid);
  assert.equal(state.rules.fires_this_turn, 0);
  assert.equal(state.rules.mandatory_fires, 0);
  assert.equal(state.reads.total, 50, 'cumulative reads preserved');

  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'Stop');
});

// -- SubagentStop -----------------------------------------------------------

test('subagentStop: logs, no state change', async (t) => {
  await setupEnv(t);
  const sid = 'sas';
  await subagentStop({ session_id: sid }, makeCtx(sid, 'SubagentStop'));
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'SubagentStop');
});

// -- Notification -----------------------------------------------------------

test('notification: logs, no state change', async (t) => {
  await setupEnv(t);
  const sid = 'notif';
  await notification({ session_id: sid }, makeCtx(sid, 'Notification'));
  const lines = await readLogLines(sid);
  assert.equal(lines[0].event, 'Notification');
});

// -- Phase 2b: SessionStart / UserPromptSubmit turn-state lifecycle --------

test('sessionStart: seeds turn-state.json with turn_id=1 + started_at', async (t) => {
  await setupEnv(t);
  const sid = 'ss-turn-state';
  await sessionStart({ session_id: sid, cwd: '/foo' }, makeCtx(sid, 'SessionStart'));

  const raw = await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.turn_id, 1);
  assert.ok(!Number.isNaN(Date.parse(obj.started_at)), 'started_at parseable');
});

test('userPromptSubmit: increments turn_id + resets started_at', async (t) => {
  await setupEnv(t);
  const sid = 'ups-turn-state';

  // First, SessionStart seeds turn_id=1.
  await sessionStart({ session_id: sid, cwd: '/foo' }, makeCtx(sid, 'SessionStart'));
  const before = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(before.turn_id, 1);
  const t0 = before.started_at;

  // Wait long enough that the next ISO timestamp is distinguishable.
  await new Promise((r) => setTimeout(r, 5));

  await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  const after = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(after.turn_id, 2);
  assert.ok(after.started_at >= t0, 'started_at advanced (or equal at ms resolution)');

  // Another UPS bumps to 3.
  await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  const after2 = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(after2.turn_id, 3);
});

test('userPromptSubmit: increments from missing turn_id to 1', async (t) => {
  await setupEnv(t);
  const sid = 'ups-no-prior';

  await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  const obj = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(obj.turn_id, 1);
  assert.ok(!Number.isNaN(Date.parse(obj.started_at)));
});

test('userPromptSubmit: preserves unrelated turn-state.json fields', async (t) => {
  await setupEnv(t);
  const sid = 'ups-preserve';

  // Pre-seed a pending_restore flag (the kind of thing PreCompact sets).
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    pending_restore: true,
    snapshot_ts: '2026-05-10T10:00:00Z',
    turn_id: 5,
  });

  await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  const obj = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(obj.turn_id, 6, 'turn_id incremented from 5');
  assert.equal(obj.pending_restore, true, 'pending_restore preserved');
  assert.equal(obj.snapshot_ts, '2026-05-10T10:00:00Z', 'snapshot_ts preserved');
});

// -- Phase 2b: PostToolUse Edit on project files records last_project_file_edit ---

test('postToolUse: Edit on a project file writes last_project_file_edit.json', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-project-edit';
  const cwd = await freshProjectCwd(t);
  const targetRel = 'src/api/auth.ts';
  const target = path.join(cwd, targetRel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '// stub\n', 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const raw = await fs.readFile(runtimeFile(sid, 'last_project_file_edit.json'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.path, targetRel);
  assert.ok(!Number.isNaN(Date.parse(obj.ts)), 'ts is valid ISO');
});

test('postToolUse: Write on a project file also records last_project_file_edit', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-write-project';
  const cwd = await freshProjectCwd(t);
  const targetRel = 'lib/util.ts';
  const target = path.join(cwd, targetRel);

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const obj = JSON.parse(await fs.readFile(runtimeFile(sid, 'last_project_file_edit.json'), 'utf8'));
  assert.equal(obj.path, targetRel);
});

test('postToolUse: MultiEdit on a project file records last_project_file_edit', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-multiedit';
  const cwd = await freshProjectCwd(t);
  const targetRel = 'lib/c.ts';
  const target = path.join(cwd, targetRel);

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'MultiEdit',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const obj = JSON.parse(await fs.readFile(runtimeFile(sid, 'last_project_file_edit.json'), 'utf8'));
  assert.equal(obj.path, targetRel);
});

test('postToolUse: Edit on file under .sextant/ does NOT record project edit', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-sextant-edit';
  const cwd = await freshProjectCwd(t);
  const target = path.join(cwd, '.sextant', 'bugs', 'foo.json');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // last_project_file_edit.json should NOT exist for .sextant/ files.
  await assert.rejects(
    fs.readFile(runtimeFile(sid, 'last_project_file_edit.json'), 'utf8'),
    /ENOENT/,
  );
});

test('postToolUse: failed Edit (is_error) does NOT record project edit', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-failed-edit';
  const cwd = await freshProjectCwd(t);
  const target = path.join(cwd, 'src/a.ts');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: target },
      tool_response: { is_error: true },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  await assert.rejects(
    fs.readFile(runtimeFile(sid, 'last_project_file_edit.json'), 'utf8'),
    /ENOENT/,
  );
});

// -- Phase 2b: PostToolUse Edit on cerebrum.md → auto-tag ------------------

// Helper: write a cerebrum file with given text.
async function writeCerebrum(cwd, kind, text) {
  const p = path.join(cwd, '.sextant', 'cerebrum', `${kind}.md`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, 'utf8');
  return p;
}

test('postToolUse: Edit on cerebrum + recent project edit → high-confidence tag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-cerebrum-high';
  const cwd = await freshProjectCwd(t);

  // Seed turn-state.json so the auto-tagger has a turn-start cutoff.
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    started_at: '2026-05-10T12:00:00.000Z',
    turn_id: 1,
  });

  // Seed last_project_file_edit.json as if a project file was just edited.
  await writeJsonAtomic(runtimeFile(sid, 'last_project_file_edit.json'), {
    path: 'src/api/auth.ts',
    ts: '2026-05-10T12:05:00.000Z',
  });

  // Cerebrum file with one untagged rule (high-confidence target).
  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: Avoid console.log\n');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // File was re-tagged with [node:src/api/auth.ts].
  const after = await fs.readFile(cerebrumPath, 'utf8');
  assert.match(after, /\[node:src\/api\/auth\.ts\]/);
  assert.match(after, /confidence=high/);

  // Statusline state reflects the high-confidence count.
  const state = await readState(sid);
  assert.equal(state.auto_tag.high_confidence, 1);
  assert.equal(state.auto_tag.low_confidence_review, 0);
  // No review-queue entries: the only rule got [node:...].
  assert.equal(state.review_queue_depth, 0);
});

test('postToolUse: Edit on cerebrum + old project edit → low-confidence + systemMessage', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-cerebrum-low';
  const cwd = await freshProjectCwd(t);

  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  // Turn started AFTER the project edit → edit is "old".
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    started_at: '2026-05-10T12:00:00.000Z',
    turn_id: 1,
  });
  await writeJsonAtomic(runtimeFile(sid, 'last_project_file_edit.json'), {
    path: 'src/old.ts',
    ts: '2026-05-09T11:00:00.000Z', // before turn start
  });

  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: Random capture\n');

  const result = await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // The file was re-tagged [provisional] (cerebrum-v2 T3.5).
  const after = await fs.readFile(cerebrumPath, 'utf8');
  assert.match(after, /\[provisional\]/);
  assert.match(after, /confidence=low/);

  // systemMessage emitted with the auto_tag_low_conf nudge.
  assert.ok(result, 'expected a return envelope');
  assert.match(result.systemMessage, /\[provisional\]/);
  assert.match(result.systemMessage, /\/sextant:triage/);

  const state = await readState(sid);
  assert.equal(state.auto_tag.low_confidence_review, 1);
  assert.equal(state.auto_tag.high_confidence, 0);
  assert.equal(state.review_queue_depth, 1, '[provisional] entry queued');
  assert.equal(state.systemmessage_fired.auto_tag_low_conf, true);
});

test('postToolUse: second low-confidence cerebrum write in same session → systemMessage suppressed', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-cerebrum-suppress';
  const cwd = await freshProjectCwd(t);

  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    started_at: '2026-05-10T12:00:00.000Z',
    turn_id: 1,
  });

  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: Line A\n');

  // First call: low-confidence (no lastProjectFileEdit at all) → emit.
  const r1 = await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.ok(r1 && r1.systemMessage, 'first call emits systemMessage');

  // Add a NEW untagged rule and call again.
  await fs.appendFile(cerebrumPath, '- 2026-05-10: Line B\n', 'utf8');
  const r2 = await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // Second call: still low-confidence but suppression key bit is set.
  assert.equal(r2, undefined, 'second call suppresses systemMessage');

  // But statusline counters keep incrementing.
  const state = await readState(sid);
  assert.equal(state.auto_tag.low_confidence_review, 2);
});

test('postToolUse: Edit on cerebrum mandatory.md also triggers auto-tag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-mandatory';
  const cwd = await freshProjectCwd(t);

  const cerebrumPath = await writeCerebrum(cwd, 'mandatory', '- 2026-05-10: Always do X\n');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // No lastProjectFileEdit → low-confidence tag ([provisional] in v2).
  const after = await fs.readFile(cerebrumPath, 'utf8');
  assert.match(after, /\[provisional\]/);

  const state = await readState(sid);
  assert.equal(state.auto_tag.low_confidence_review, 1);
});

test('postToolUse: Edit on cerebrum records cerebrum_last_write_ts for FileChanged dedup', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-cerebrum-ts';
  const cwd = await freshProjectCwd(t);

  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: A line\n');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: cerebrumPath },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const state = await readState(sid);
  assert.equal(typeof state.cerebrum_last_write_ts, 'number');
  assert.ok(state.cerebrum_last_write_ts > 0);
});

// -- Phase 2b: FileChanged reconciliation -----------------------------------

test('fileChanged: cerebrum.md without recent Sextant write → runs autoTagFile', async (t) => {
  await setupEnv(t);
  const sid = 'fc-cerebrum-external';
  const cwd = await freshProjectCwd(t);
  await setOutputMode(cwd, 'verbose'); // reconcile notice is routine → verbose-only

  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: User added this directly\n');

  // No cerebrum_last_write_ts in state — treat as external.
  const result = await fileChanged(
    { session_id: sid, cwd, file_path: cerebrumPath },
    makeCtx(sid, 'FileChanged'),
  );

  // Auto-tagged with [provisional] (no lastProjectFileEdit; cerebrum-v2 T3.5).
  const after = await fs.readFile(cerebrumPath, 'utf8');
  assert.match(after, /\[provisional\]/);

  const state = await readState(sid);
  assert.equal(state.hand_edits_reconciled, 1);
  assert.equal(state.auto_tag.low_confidence_review, 1);

  assert.ok(result && result.systemMessage, 'systemMessage emitted on reconciliation');
  assert.match(stripAnsi(result.systemMessage), /sextant: reconciled 1 hand-edited lines in regular\.md/);
});

test('fileChanged: cerebrum.md WITH recent Sextant write (mtime within window) → skipped', async (t) => {
  await setupEnv(t);
  const sid = 'fc-cerebrum-ours';
  const cwd = await freshProjectCwd(t);

  const cerebrumPath = await writeCerebrum(cwd, 'regular', '- 2026-05-10: User added this\n');

  // Stat the file we just created and record an mtime ~now in state. The
  // FileChanged handler stats the file, compares to recorded ts; mtime
  // matches (we just wrote it) so the change is considered ours.
  const st = await fs.stat(cerebrumPath);
  await withState(sid, null, (s) => {
    s.cerebrum_last_write_ts = st.mtimeMs;
  });

  const result = await fileChanged(
    { session_id: sid, cwd, file_path: cerebrumPath },
    makeCtx(sid, 'FileChanged'),
  );

  // No reconciliation → no systemMessage.
  assert.equal(result, undefined);

  // File content unchanged.
  const after = await fs.readFile(cerebrumPath, 'utf8');
  assert.match(after, /User added this/);
  assert.doesNotMatch(after, /\[!review\]/);

  const state = await readState(sid);
  // hand_edits_reconciled stays at 0/undefined → assertion-friendly.
  assert.ok(!state.hand_edits_reconciled, 'no reconciliation counter bump');
});

test('fileChanged: non-cerebrum file path → no reconciliation', async (t) => {
  await setupEnv(t);
  const sid = 'fc-not-cerebrum';
  const cwd = await freshProjectCwd(t);
  const target = path.join(cwd, 'src/random.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '// hi\n', 'utf8');

  const result = await fileChanged(
    { session_id: sid, cwd, file_path: target },
    makeCtx(sid, 'FileChanged'),
  );

  assert.equal(result, undefined);
});

test('fileChanged: external write to cerebrum with all-already-tagged lines → no message', async (t) => {
  await setupEnv(t);
  const sid = 'fc-no-changes';
  const cwd = await freshProjectCwd(t);

  // Already-tagged rule: autoTagFile will pass through as 'unchanged'.
  const cerebrumPath = await writeCerebrum(
    cwd, 'regular',
    '- 2026-05-10: [node:src/x.ts] Already tagged <!-- sextant:auto-tag confidence=high -->\n',
  );

  const result = await fileChanged(
    { session_id: sid, cwd, file_path: cerebrumPath },
    makeCtx(sid, 'FileChanged'),
  );

  // No high/low → no systemMessage.
  assert.equal(result, undefined);
});

// -- Phase 2.5: rules-fired logging on PreToolUse mandatory fires ----------

test('preToolUse: mandatory rule fire appends an entry to rules-fired.jsonl', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-rules-fired';
  const cwd = await freshProjectCwd(t);

  // Seed a mandatory rule that will fire on the target file.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [!global] always run prettier (by: sess-1)\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/foo.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  // Returned context exists with the priority-1 rules block.
  assert.ok(result && result.hookSpecificOutput, 'should return hookSpecificOutput');
  assert.match(result.hookSpecificOutput.additionalContext, /rules \(1\)/);

  // rules-fired.jsonl now has one line for the fired rule.
  const rfPath = runtimeFile(sid, 'rules-fired.jsonl');
  const rfRaw = await fs.readFile(rfPath, 'utf8');
  const lines = rfRaw.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'one rule fired → one JSONL line');
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.body, 'always run prettier');
  assert.equal(entry.bucket, '[!global]');
  assert.ok(entry.source_file.endsWith('cerebrum/cerebrum.md'));
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
});

test('preToolUse: multiple matching rules append multiple JSONL lines', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-rules-fired-multi';
  const cwd = await freshProjectCwd(t);

  // Two rules both apply to src/a.ts (one global, one node-scoped).
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [!] [!global] always run prettier',
      '- 2026-05-10: [!] [node:src/a.ts] never log secrets',
      '',
    ].join('\n'),
    'utf8',
  );

  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  const rfRaw = await fs.readFile(runtimeFile(sid, 'rules-fired.jsonl'), 'utf8');
  const lines = rfRaw.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const bodies = lines.map((l) => JSON.parse(l).body).sort();
  assert.deepEqual(bodies, ['always run prettier', 'never log secrets']);
});

test('preToolUse: no mandatory rules → rules-fired.jsonl is NOT created', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-rules-fired';
  const cwd = await freshProjectCwd(t);

  // No mandatory.md → no rules fire.
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  await assert.rejects(
    fs.readFile(runtimeFile(sid, 'rules-fired.jsonl'), 'utf8'),
    /ENOENT/,
  );
});

// -- Phase 2.5: PreCompact reads rules-fired and writes precompact.json ----

test('preCompact: reads rules-fired.jsonl + writes precompact.json with the rules', async (t) => {
  await setupEnv(t);
  const sid = 'pc-rules-fired-read';

  // Seed rules-fired.jsonl with 3 entries (newest at the bottom).
  const entries = [
    { ts: '2026-05-11T10:00:00Z', body: 'rule one', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
    { ts: '2026-05-11T10:01:00Z', body: 'rule two', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
    { ts: '2026-05-11T10:02:00Z', body: 'rule three', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!]' },
  ];
  const rfPath = runtimeFile(sid, 'rules-fired.jsonl');
  await fs.mkdir(path.dirname(rfPath), { recursive: true });
  await fs.writeFile(rfPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const cwd = await projectWithMode(t, 'verbose'); // snapshot line is routine → verbose-only
  const result = await preCompact({ session_id: sid, cwd }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.rules.length, 3);
  // Newest first.
  assert.equal(pc.payload.rules[0].body, 'rule three');
  assert.equal(pc.payload.rules[2].body, 'rule one');
  // Todos null when no transcript_path.
  assert.equal(pc.payload.todos, null);

  // systemMessage reports counts.
  assert.match(stripAnsi(result.systemMessage), /3 rules/);
  assert.match(stripAnsi(result.systemMessage), /0 todos/);
});

test('preCompact: dedups rules with same (body, source_file) — newest fire wins', async (t) => {
  await setupEnv(t);
  const sid = 'pc-rules-fired-dedup';

  // Same rule fires 3 times, only one slot in the snapshot.
  const entries = [
    { ts: '2026-05-11T10:00:00Z', body: 'always run prettier', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
    { ts: '2026-05-11T10:01:00Z', body: 'always run prettier', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
    { ts: '2026-05-11T10:02:00Z', body: 'always run prettier', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
  ];
  const rfPath = runtimeFile(sid, 'rules-fired.jsonl');
  await fs.mkdir(path.dirname(rfPath), { recursive: true });
  await fs.writeFile(rfPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  await preCompact({ session_id: sid }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.rules.length, 1, 'deduplicated to a single entry');
  assert.equal(pc.payload.rules[0].ts, '2026-05-11T10:02:00Z', 'newest fire kept');
});

test('preCompact: reads TodoWrite tool_use from transcript JSONL', async (t) => {
  await setupEnv(t);
  const sid = 'pc-transcript-todos';
  const base = process.env.SEXTANT_RUNTIME_BASE;
  const transcript = path.join(base, 'transcript.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });

  const todos = [
    { content: 'A', status: 'completed' },
    { content: 'B', status: 'in_progress' },
  ];
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } }),
  ];
  await fs.writeFile(transcript, lines.join('\n') + '\n', 'utf8');

  await preCompact({ session_id: sid, transcript_path: transcript }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.deepEqual(pc.payload.todos, todos);
});

test('preCompact: picks the NEWEST TodoWrite when multiple exist in the transcript', async (t) => {
  await setupEnv(t);
  const sid = 'pc-transcript-todos-newest';
  const base = process.env.SEXTANT_RUNTIME_BASE;
  const transcript = path.join(base, 'transcript.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });

  const oldTodos = [{ content: 'old', status: 'pending' }];
  const newTodos = [{ content: 'new', status: 'in_progress' }];

  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: oldTodos } }] } }),
    JSON.stringify({ type: 'user', message: { content: 'between' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: newTodos } }] } }),
  ];
  await fs.writeFile(transcript, lines.join('\n') + '\n', 'utf8');

  await preCompact({ session_id: sid, transcript_path: transcript }, makeCtx(sid, 'PreCompact'));

  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.deepEqual(pc.payload.todos, newTodos);
});

test('preCompact: missing/empty transcript_path → todos=null', async (t) => {
  await setupEnv(t);
  const sid = 'pc-no-transcript';
  await preCompact({ session_id: sid, transcript_path: '' }, makeCtx(sid, 'PreCompact'));
  const pc = JSON.parse(await fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'));
  assert.equal(pc.payload.todos, null);
});

test('preCompact: snapshot line is routine — quiet suppresses, verbose shows', async (t) => {
  await setupEnv(t);
  const sid = 'pc-suppress';
  const quietCwd = await projectWithMode(t, 'quiet');
  const rq = await preCompact({ session_id: sid, cwd: quietCwd }, makeCtx(sid, 'PreCompact'));
  assert.equal(rq, undefined, 'routine snapshot line suppressed under quiet');
  const verboseCwd = await projectWithMode(t, 'verbose');
  const rv = await preCompact({ session_id: sid, cwd: verboseCwd }, makeCtx(sid, 'PreCompact'));
  assert.ok(rv && rv.systemMessage, 'routine snapshot line surfaces under verbose');
});

// -- Phase 2.5: UserPromptSubmit reads pending_restore ----------------------

test('userPromptSubmit: pending_restore=true → emits restoration block + clears flag + rotates precompact.json', async (t) => {
  await setupEnv(t);
  const sid = 'ups-restore';
  const snapshotTs = '2026-05-11T10:00:00.000Z';

  // Seed precompact.json + pending_restore=true.
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json'), {
    schema_version: 1,
    compaction_n: 1,
    ts: snapshotTs,
    payload: {
      rules: [
        { ts: '2026-05-11T09:00:00Z', body: 'always run prettier', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
      ],
      todos: [
        { content: 'Ship Phase 2.5', status: 'in_progress' },
      ],
    },
  });
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    pending_restore: true,
    snapshot_ts: snapshotTs,
    compaction_n: 1,
  });

  const result = await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));

  // Returned additionalContext.
  assert.ok(result && result.hookSpecificOutput, 'should return hookSpecificOutput');
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /<!-- sextant:post-compact-restore -->/);
  assert.match(ctx, /always run prettier/);
  assert.match(ctx, /Ship Phase 2\.5/);
  assert.match(ctx, /in_progress/);

  // pending_restore cleared; turn_id still bumped.
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(ts.pending_restore, false);
  assert.equal(ts.turn_id, 1, 'turn_id bumped from missing to 1');

  // precompact.json rotated to precompact-<sanitized>.json.
  await assert.rejects(
    fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'),
    /ENOENT/,
  );
  const sanitized = snapshotTs.replace(/[^0-9A-Za-z._-]/g, '_');
  const rotated = await fs.readFile(runtimeFile(sid, `precompact-${sanitized}.json`), 'utf8');
  assert.ok(rotated.length > 0, 'rotated snapshot retained for diagnostics');
});

test('userPromptSubmit: pending_restore=false → no additionalContext, no rotation', async (t) => {
  await setupEnv(t);
  const sid = 'ups-no-restore';
  const result = await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  assert.equal(result, undefined);
  // turn_id still incremented.
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(ts.turn_id, 1);
});

test('userPromptSubmit: empty payload (no rules, no todos) → minimal placeholder block', async (t) => {
  await setupEnv(t);
  const sid = 'ups-empty-restore';

  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json'), {
    schema_version: 1,
    compaction_n: 1,
    ts: '2026-05-11T10:00:00.000Z',
    payload: { rules: [], todos: null },
  });
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    pending_restore: true,
    snapshot_ts: '2026-05-11T10:00:00.000Z',
  });

  const result = await userPromptSubmit({ session_id: sid }, makeCtx(sid, 'UserPromptSubmit'));
  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /no captured state to restore/);
});

// -- Phase 2.5: PreToolUse fallback for pending_restore --------------------

test('preToolUse Read: pending_restore=true → emits restoration block ahead of per-Read block', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-fallback';
  const cwd = await freshProjectCwd(t);

  // Seed a mandatory rule so the per-Read block is non-empty.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [!global] always run prettier (by: sess-1)\n',
    'utf8',
  );

  // Pre-stage pending restore.
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json'), {
    schema_version: 1,
    compaction_n: 1,
    ts: '2026-05-11T10:00:00.000Z',
    payload: {
      rules: [{ ts: '2026-05-11T09:00:00Z', body: 'never log secrets', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' }],
      todos: null,
    },
  });
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    pending_restore: true,
    snapshot_ts: '2026-05-11T10:00:00.000Z',
  });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/foo.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;

  // Both blocks present.
  assert.ok(ctx.includes('<!-- sextant:post-compact-restore -->'), 'restoration marker present');
  assert.ok(ctx.includes('<!-- sextant:read-context -->'), 'per-Read marker present');
  assert.ok(ctx.includes('never log secrets'), 'restored rule body present');
  assert.ok(/rules \(\d+\):/.test(ctx), 'per-Read rules block present');

  // Order: restoration FIRST.
  const idxRestore = ctx.indexOf('<!-- sextant:post-compact-restore -->');
  const idxRead = ctx.indexOf('<!-- sextant:read-context -->');
  assert.ok(idxRestore < idxRead, `restore must come before read-context (restore=${idxRestore} read=${idxRead})`);

  // pending_restore cleared.
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(ts.pending_restore, false);

  // precompact.json rotated.
  await assert.rejects(
    fs.readFile(runtimeFile(sid, 'precompact.json'), 'utf8'),
    /ENOENT/,
  );
});

test('preToolUse Read: pending_restore=true with no per-Read content → emits restoration block alone', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-fallback-bare';
  const cwd = await freshProjectCwd(t);

  // No cerebrum, no graph — per-Read block would be empty.
  const { writeJsonAtomic } = await import('../lib/hooks/fileio.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json'), {
    schema_version: 1,
    compaction_n: 1,
    ts: '2026-05-11T10:00:00.000Z',
    payload: {
      rules: [{ ts: '2026-05-11T09:00:00Z', body: 'rule body', source_file: 'x.md', bucket: '[!]' }],
      todos: null,
    },
  });
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    pending_restore: true,
    snapshot_ts: '2026-05-11T10:00:00.000Z',
  });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/foo.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  // Still emits the restoration block alone.
  assert.ok(result && result.hookSpecificOutput, 'restoration must still surface');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('<!-- sextant:post-compact-restore -->'));
  assert.ok(ctx.includes('rule body'));
  // No per-Read content.
  assert.ok(!ctx.includes('<!-- sextant:read-context -->'));
});

test('preToolUse Read: pending_restore=false → no restoration block (Phase 2c behaviour preserved)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-pending';
  const cwd = await freshProjectCwd(t);

  // Seed a mandatory rule so the per-Read block is non-empty for sanity.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [!global] always run prettier\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/foo.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(!ctx.includes('post-compact-restore'),
    `should NOT contain restoration block when no pending_restore; got:\n${ctx}`);
  assert.ok(ctx.includes('<!-- sextant:read-context -->'), 'per-Read block present');
});

// -- Phase 2.5: paths.mjs helper -------------------------------------------

test('rulesFiredPath: returns runtime-relative rules-fired.jsonl path', async (t) => {
  await setupEnv(t);
  const { rulesFiredPath } = await import('../lib/paths.mjs');
  const p = rulesFiredPath('sid-x');
  assert.ok(p.endsWith('rules-fired.jsonl'));
  assert.ok(p.includes('sextant-sid-x'));
});

// -- Phase 3: PostToolUse bug-sweep ----------------------------------------

async function writeBugsJson(cwd, bugs) {
  const file = path.join(cwd, '.sextant', 'bugs.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(bugs), 'utf8');
  return file;
}

async function readBugsJson(cwd) {
  const file = path.join(cwd, '.sextant', 'bugs.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('postToolUse: Edit triggers bug-sweep — symbol-match wins for matching error', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-bug-sweep-symbol';
  const cwd = await freshProjectCwd(t);

  // Seed a graph with a known file + symbol.
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Bug for src/a.ts that mentions a symbol from that file (alpha).
  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      session_id: 's',
      file: 'src/a.ts',
      error_message: 'alpha returned undefined',
      root_cause: 'unhandled null',
      fix: 'guard',
      fix_verified: false,
      tags: [],
    },
  ]);

  // Trigger Edit on some OTHER file — sweep runs regardless of which file.
  const projFile = path.join(cwd, 'src/some-other.ts');
  await fs.mkdir(path.dirname(projFile), { recursive: true });
  await fs.writeFile(projFile, '// stub\n', 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: projFile },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const after = await readBugsJson(cwd);
  assert.equal(after[0].graph_node, 'alpha');
  assert.equal(after[0].graph_node_confidence, 'symbol-match');
});

test('postToolUse: Edit triggers bug-sweep — file-level fallback when no symbol matches', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-bug-sweep-file-level';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      session_id: 's',
      file: 'src/a.ts',
      error_message: 'Generic UnknownError thrown by something',
      root_cause: 'who knows',
      fix: 'guarded',
      fix_verified: false,
      tags: [],
    },
  ]);

  const projFile = path.join(cwd, 'src/other2.ts');
  await fs.mkdir(path.dirname(projFile), { recursive: true });
  await fs.writeFile(projFile, '// stub\n', 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: projFile },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const after = await readBugsJson(cwd);
  assert.equal(after[0].graph_node, 'src/a.ts');
  assert.equal(after[0].graph_node_confidence, 'file-level');
});

test('postToolUse: bug-sweep throttle — second call within 5s skips work', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-bug-sweep-throttle';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());
  // No graph_node — sweep will tag it.
  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      session_id: 's',
      file: 'src/a.ts',
      error_message: 'alpha err',
      root_cause: 'x',
      fix: 'y',
      fix_verified: false,
      tags: [],
    },
  ]);

  const projFile = path.join(cwd, 'src/some.ts');
  await fs.mkdir(path.dirname(projFile), { recursive: true });
  await fs.writeFile(projFile, '// stub\n', 'utf8');

  // First call: tags the entry.
  await postToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: projFile }, tool_response: { content: 'ok' } },
    makeCtx(sid, 'PostToolUse'),
  );
  const after1 = await readBugsJson(cwd);
  assert.equal(after1[0].graph_node, 'alpha');

  // Manually corrupt the entry on disk to a placeholder; if the throttle
  // gate works, the second call should NOT re-sweep and leave it as-is.
  await fs.writeFile(
    path.join(cwd, '.sextant', 'bugs.json'),
    JSON.stringify([{ ...after1[0], graph_node: undefined, graph_node_confidence: undefined }]),
    'utf8',
  );

  // Second call within throttle window.
  await postToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: projFile }, tool_response: { content: 'ok' } },
    makeCtx(sid, 'PostToolUse'),
  );
  const after2 = await readBugsJson(cwd);
  // Throttle gate prevented the sweep — entry remains un-tagged.
  assert.equal(after2[0].graph_node, undefined);
  assert.equal(after2[0].graph_node_confidence, undefined);
});

// -- Phase 3: PreToolUse Read priority-2 (bug summary) ---------------------

test('preToolUse Edit: open bugs → bug summary in the write wallpaper', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-bug-summary';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      session_id: 's',
      file: 'src/a.ts',
      graph_node: 'alpha',
      graph_node_confidence: 'symbol-match',
      error_message: 'TypeError on alpha',
      root_cause: 'x',
      fix: 'y',
      fix_verified: false,
      tags: [],
    },
  ]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /bugs: 1 open in project/);
  assert.match(ctx, /most recent in this file: TypeError on alpha \(id bug-1\)/);
  // priority-2: bug summary precedes the priority-3 identity line.
  const idxBugs = ctx.indexOf('bugs: 1 open');
  const idxIdent = ctx.indexOf('graph:');
  assert.ok(idxBugs >= 0 && idxIdent > idxBugs,
    `bug summary should precede identity; bugs=${idxBugs} graph=${idxIdent}`);
});

test('preToolUse Read: zero open bugs → no bug summary section', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-no-open-bugs';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      file: 'src/a.ts',
      error_message: 'old bug',
      fix_verified: true,
      verified_ts: '2026-05-10T10:01:00Z',
      verified_by: 'test-pass',
      tags: [],
    },
  ]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  const ctx = (result && result.hookSpecificOutput) ? result.hookSpecificOutput.additionalContext : '';
  assert.ok(!ctx.includes('bugs:'),
    `verified bugs should not surface; got:\n${ctx}`);
});

test('preToolUse Edit: open bug for OTHER file → count present, no most-recent line', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-other-file-bug';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: '2026-05-10T10:00:00Z',
      file: 'src/elsewhere.ts',
      error_message: 'bug far away',
      fix_verified: false,
      tags: [],
    },
  ]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /bugs: 1 open in project/);
  // Not in THIS file → no most-recent suffix.
  assert.ok(!ctx.includes('most recent in this file'),
    `should not render most-recent for a different file's bug; got:\n${ctx}`);
});

// -- Per-tool verbose signals (risk / impact / orientation / capture) -------
// All gated to output_mode=verbose (routine level). A test in the default quiet
// mode would assert absence and pass vacuously — so the positive cases use
// projectWithMode(t, 'verbose') and the negative case pins quiet suppression.

test('per-tool signals: verbose Edit surfaces risk (bug + safety rule) + impact', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-edit-verbose';
  const cwd = await projectWithMode(t, 'verbose');
  await writeSyntheticGraph(cwd, syntheticGraph());
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [node:src/a.ts] never log secrets\n',
    'utf8',
  );
  await writeBugsJson(cwd, [
    { id: 'bug-1', ts: '2026-05-10T10:00:00Z', file: 'src/a.ts', error_message: 'TypeError on alpha', fix_verified: false, tags: [] },
  ]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  const msg = stripAnsi(result?.systemMessage ?? '');
  assert.match(msg, /open bug: TypeError on alpha \(bug-1\)/, 'risk: open-bug warning');
  assert.match(msg, /safety rule governs src\/a\.ts/, 'risk: safety rule note');
  assert.match(msg, /used by/, 'impact: fan-in digest');
});

test('per-tool signals: quiet mode emits NO per-tool systemMessage (still injects context)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-edit-quiet';
  const cwd = await projectWithMode(t, 'quiet');
  await writeSyntheticGraph(cwd, syntheticGraph());
  await writeBugsJson(cwd, [
    { id: 'bug-1', ts: '2026-05-10T10:00:00Z', file: 'src/a.ts', error_message: 'TypeError on alpha', fix_verified: false, tags: [] },
  ]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  // The advisory wallpaper still rides as additionalContext (not mode-gated)…
  assert.ok(result && result.hookSpecificOutput, 'context still injected in quiet');
  // …but the user-facing per-tool signal is suppressed under quiet.
  assert.ok(!result.systemMessage, 'no per-tool systemMessage under quiet');
});

test('per-tool signals: verbose PostToolUse Bash confirms logged bug + captured rule', async (t) => {
  await setupEnv(t);
  const sid = 'sig-cap-verbose';
  const cwd = await projectWithMode(t, 'verbose');

  const bugRes = await postToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'node bin/bugs.mjs log ...' }, tool_response: { stdout: 'bug-3' } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.match(stripAnsi(bugRes?.systemMessage ?? ''), /logged bug-3/);

  const ruleRes = await postToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'node bin/cerebrum.mjs remember ...' }, tool_response: { stdout: 'Appended to cerebrum.md: - 2026-06-04: [node:x] a rule' } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.match(stripAnsi(ruleRes?.systemMessage ?? ''), /captured 1 rule/);
});

test('per-tool signals: a Bash command merely MENTIONING a capture emits no confirmation', async (t) => {
  await setupEnv(t);
  const sid = 'sig-cap-falsepos';
  const cwd = await projectWithMode(t, 'verbose');
  const res = await postToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'git commit -m "wire bugs.mjs log"' }, tool_response: { stdout: '[main abc] wire bugs.mjs log' } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.ok(!res || !res.systemMessage, 'no confirmation without a real stdout signal');
});

test('per-tool signals: verbose UserPromptSubmit surfaces primed files', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-ori-verbose';
  const cwd = await projectWithMode(t, 'verbose');
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'please fix the bug in src/a.ts' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  assert.match(stripAnsi(result?.systemMessage ?? ''), /primed .*a\.ts/);
});

// A graph with an isolated leaf node (no import edges in or out) alongside the
// connected synthetic nodes, for the graph-suppression tests.
function graphWithLeaf() {
  const g = syntheticGraph();
  g[GRAPH.NODES].push({
    [NODE.ID]: fileNodeId('src/leaf.ts'), [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: 'leaf.ts', [NODE.PATH]: 'src/leaf.ts', [NODE.SYMBOLS]: ['leafFn'], [NODE.COMMUNITY]: null,
  });
  return g;
}

test('per-tool signals: graph wallpaper suppressed on a 0-edge, no-rule file', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-leaf';
  const cwd = await projectWithMode(t, 'verbose');
  await writeSyntheticGraph(cwd, graphWithLeaf());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/leaf.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  const ctx = result?.hookSpecificOutput?.additionalContext ?? '';
  assert.ok(!ctx.includes('graph: leaf.ts'), 'no graph identity for a disconnected leaf');
  assert.ok(!ctx.includes('symbols (up to'), 'no symbols block for a disconnected leaf');
  const msg = stripAnsi(result?.systemMessage ?? '');
  assert.ok(!/dep/.test(msg) && !/used by/.test(msg), 'no zero-edge impact signal');
});

test('per-tool signals: graph wallpaper + impact retained on a connected file', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-connected';
  const cwd = await projectWithMode(t, 'verbose');
  await writeSyntheticGraph(cwd, graphWithLeaf());

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  const ctx = result?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /graph: a\.ts/, 'connected file keeps its graph block');
  assert.match(stripAnsi(result?.systemMessage ?? ''), /used by/, 'connected file keeps its impact signal');
});

test('per-tool signals: a 0-edge file WITH a node rule keeps its graph block but no zero-edge impact line', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'sig-leaf-ruled';
  const cwd = await projectWithMode(t, 'verbose');
  await writeSyntheticGraph(cwd, graphWithLeaf());
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [node:src/leaf.ts] handle the leaf carefully\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/leaf.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  const ctx = result?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /handle the leaf carefully/, 'the node rule still fires');
  assert.match(ctx, /graph: leaf.ts/, 'an annotated file keeps its graph block even at 0 edges');
  assert.ok(!/used by 0/.test(stripAnsi(result?.systemMessage ?? '')), 'still no zero-edge impact noise');
});

// -- Phase 5: PreToolUse Bash → flag files ----------------------------------

import { testRunPendingFlagPath, commitPendingFlagPath, editsPath } from '../lib/paths.mjs';

test('preToolUse Bash: npm test sets test-run-pending.flag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-npm-test';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'npm test' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const exists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(exists, true, 'test-run-pending.flag should exist');
  // commit flag should NOT exist.
  const commitExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(commitExists, false);
});

test('preToolUse Bash: pytest sets test-run-pending.flag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-pytest';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'pytest tests/' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const exists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(exists, true);
});

test('preToolUse Bash: git commit sets commit-pending.flag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-git-commit';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const exists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(exists, true, 'commit-pending.flag should exist');
  // test flag should NOT exist.
  const testExists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(testExists, false);
});

test('preToolUse Bash: git status does NOT set any flag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-git-status';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git status' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const commitExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  const testExists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(commitExists, false);
  assert.equal(testExists, false);
});

test('preToolUse Bash: ls does NOT set any flag', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-ls';
  await preToolUse(
    { session_id: sid, tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    makeCtx(sid, 'PreToolUse'),
  );
  const commitExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  const testExists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(commitExists, false);
  assert.equal(testExists, false);
});

// -- Phase 5: PostToolUse Bash → test verification path --------------------

import { writeFlagFile } from '../lib/hooks/flags.mjs';

test('postToolUse Bash: test-flag + exit 0 + recent unverified bug → bug.fix_verified=true', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-test-verify';
  const cwd = await freshProjectCwd(t);

  // Pre-seed: write the test flag (as if PreToolUse Bash had set it).
  await writeFlagFile(testRunPendingFlagPath(sid));

  // Pre-seed: one unverified bug with this session_id, ts within 1h.
  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: new Date().toISOString(),
      session_id: sid,
      file: 'src/a.ts',
      error_message: 'something broke',
      root_cause: 'x',
      fix: 'y',
      fix_verified: false,
      tags: [],
    },
  ]);

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0, stdout: 'all tests passed' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const after = await readBugsJson(cwd);
  assert.equal(after[0].fix_verified, true);
  assert.equal(after[0].verified_by, 'test-pass');
  assert.ok(!Number.isNaN(Date.parse(after[0].verified_ts)));

  // Flag should be cleared.
  const flagExists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(flagExists, false, 'test-run-pending.flag should be cleared');
});

test('postToolUse Bash: test-flag + exit 0 + bug from OTHER session → not verified', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-test-other-session';
  const cwd = await freshProjectCwd(t);
  await writeFlagFile(testRunPendingFlagPath(sid));
  // Bug from a different session.
  await writeBugsJson(cwd, [
    {
      id: 'bug-1',
      ts: new Date().toISOString(),
      session_id: 'different-session',
      file: 'src/a.ts',
      error_message: 'x',
      root_cause: 'y',
      fix: 'z',
      fix_verified: false,
      tags: [],
    },
  ]);

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const after = await readBugsJson(cwd);
  assert.equal(after[0].fix_verified, false, 'bug from other session must stay unverified');
});

test('postToolUse Bash: test-flag + non-zero exit → systemMessage emitted', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-test-fail';
  const cwd = await freshProjectCwd(t);
  await writeFlagFile(testRunPendingFlagPath(sid));

  const result = await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 1, stdout: 'FAIL\nTests: 1 failed', is_error: true },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  assert.ok(result, 'expected a return envelope');
  assert.ok(typeof result.systemMessage === 'string');
  assert.match(result.systemMessage, /test run failed/i);
  assert.match(result.systemMessage, /\/sextant:bug-log/);

  // Flag should still be cleared.
  const flagExists = await fs.access(testRunPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(flagExists, false);
});

test('postToolUse Bash: no flag → no return value, no side effects', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-no-flag';
  const cwd = await freshProjectCwd(t);

  const result = await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    },
    makeCtx(sid, 'PostToolUse'),
  );
  // No flag → no return value.
  assert.equal(result, undefined);
});

// -- Phase 5: PostToolUse Bash → commit snapshot path ---------------------

import { snapshotEdits as snapshotEditsFn, commitSnapshotPath } from '../lib/capture/commit-snapshot.mjs';

test('postToolUse Bash: commit-flag + exit 0 + non-empty edits → commits/<ts>.json written', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-commit';
  const cwd = await freshProjectCwd(t);

  await writeFlagFile(commitPendingFlagPath(sid));
  // Seed runtime/edits.json with two entries.
  await fs.mkdir(path.dirname(editsPath(sid)), { recursive: true });
  await fs.writeFile(editsPath(sid), JSON.stringify([
    { path: 'src/x.ts', ts: '2026-05-10T10:00:00Z', kind: 'Edit' },
    { path: 'src/y.ts', ts: '2026-05-10T10:05:00Z', kind: 'Write' },
  ]), 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "x"' },
      tool_response: { exit_code: 0 },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  // commit flag cleared.
  const flagExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(flagExists, false);

  // commits/<ts>.json exists.
  const commitsDir = path.join(cwd, '.sextant', 'session', sid, 'commits');
  const files = await fs.readdir(commitsDir);
  assert.equal(files.length, 1, `expected exactly one snapshot file; got ${files}`);
  const snap = JSON.parse(await fs.readFile(path.join(commitsDir, files[0]), 'utf8'));
  assert.equal(snap.session_id, sid);
  assert.equal(snap.edits.length, 2);
  assert.equal(snap.edits[0].path, 'src/x.ts');

  // edits.json reset.
  const editsAfter = JSON.parse(await fs.readFile(editsPath(sid), 'utf8'));
  assert.deepEqual(editsAfter, []);
});

test('postToolUse Bash: commit-flag + exit 0 + empty edits → flag cleared, no snapshot', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-commit-empty';
  const cwd = await freshProjectCwd(t);

  await writeFlagFile(commitPendingFlagPath(sid));
  // No edits.json — empty list.

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "empty"' },
      tool_response: { exit_code: 0 },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const flagExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(flagExists, false);

  // No commits directory written.
  const commitsDir = path.join(cwd, '.sextant', 'session', sid, 'commits');
  const dirExists = await fs.access(commitsDir).then(() => true).catch(() => false);
  assert.equal(dirExists, false);
});

test('postToolUse Bash: commit-flag + non-zero exit → flag cleared, no snapshot', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-commit-fail';
  const cwd = await freshProjectCwd(t);

  await writeFlagFile(commitPendingFlagPath(sid));
  await fs.mkdir(path.dirname(editsPath(sid)), { recursive: true });
  await fs.writeFile(editsPath(sid), JSON.stringify([
    { path: 'src/x.ts', ts: '2026-05-10T10:00:00Z', kind: 'Edit' },
  ]), 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "bad"' },
      tool_response: { exit_code: 1, is_error: true },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const flagExists = await fs.access(commitPendingFlagPath(sid)).then(() => true).catch(() => false);
  assert.equal(flagExists, false);

  const commitsDir = path.join(cwd, '.sextant', 'session', sid, 'commits');
  const dirExists = await fs.access(commitsDir).then(() => true).catch(() => false);
  assert.equal(dirExists, false, 'no snapshot on failed commit');

  // edits.json should NOT be reset on failure.
  const editsAfter = JSON.parse(await fs.readFile(editsPath(sid), 'utf8'));
  assert.equal(editsAfter.length, 1, 'edits not cleared on failed commit');
});

// -- Phase 5: PostToolUse Edit/Write/MultiEdit → edits.json append ---------

test('postToolUse: Edit on a project file appends to edits.json', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-edits-append';
  const cwd = await freshProjectCwd(t);
  const target = path.join(cwd, 'src/foo.ts');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '// stub\n', 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const raw = await fs.readFile(editsPath(sid), 'utf8');
  const arr = JSON.parse(raw);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].path, 'src/foo.ts');
  assert.equal(arr[0].kind, 'Edit');
  assert.ok(!Number.isNaN(Date.parse(arr[0].ts)));
});

test('postToolUse: multiple Edits stack in edits.json', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-edits-stack';
  const cwd = await freshProjectCwd(t);
  const targets = ['a.ts', 'b.ts', 'c.ts'].map((n) => path.join(cwd, 'src', n));
  for (const t2 of targets) {
    await fs.mkdir(path.dirname(t2), { recursive: true });
    await fs.writeFile(t2, '// stub\n', 'utf8');
    await postToolUse(
      {
        session_id: sid,
        cwd,
        tool_name: 'Write',
        tool_input: { file_path: t2 },
        tool_response: { content: 'ok' },
      },
      makeCtx(sid, 'PostToolUse'),
    );
  }
  const arr = JSON.parse(await fs.readFile(editsPath(sid), 'utf8'));
  assert.equal(arr.length, 3);
  assert.deepEqual(arr.map((e) => e.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(arr.map((e) => e.kind), ['Write', 'Write', 'Write']);
});

test('postToolUse: Edit under .sextant/ does NOT append to edits.json', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-edits-sextant-skip';
  const cwd = await freshProjectCwd(t);
  const target = path.join(cwd, '.sextant', 'cerebrum', 'regular.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '- 2026-05-10: A rule\n', 'utf8');

  await postToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: target },
      tool_response: { content: 'ok' },
    },
    makeCtx(sid, 'PostToolUse'),
  );

  const editsExists = await fs.access(editsPath(sid)).then(() => true).catch(() => false);
  assert.equal(editsExists, false, 'edits.json should not be touched for .sextant/ writes');
});

// Avoid unused-variable warning for snapshot helper imports.
void snapshotEditsFn; void commitSnapshotPath;

// ----------------------------------------------------------------------------
// Phase 6 § 5.2 — UserPromptSubmit preload + cross-turn dedup
// ----------------------------------------------------------------------------

test('userPromptSubmit Phase 6: prompt with known file emits preload block', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-path';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'please look at src/a.ts now' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /<!-- sextant:prompt-preload -->/);
  assert.match(ctx, /<!-- \/sextant:prompt-preload -->/);
  // R13: imperative line present in preload block
  assert.match(ctx, /Use the following graph context when editing or reasoning/);
  assert.match(ctx, /## src\/a\.ts/);
  assert.match(ctx, /graph: a\.ts; community: none/);
});

test('userPromptSubmit Phase 6: prompt with symbol in graph emits preload block', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-sym';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // The synthetic graph's src/a.ts node carries symbols ['alpha', 'Beta'].
  // Prompt mentions 'Beta', no path → should resolve to src/a.ts via filterToGraph.
  const result = await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'check the Beta logic' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.match(ctx, /<!-- sextant:prompt-preload -->/);
  assert.match(ctx, /## src\/a\.ts/, 'preload should reference src/a.ts (parent of Beta)');
});

test('userPromptSubmit Phase 6: no prompt → no preload (turn-state still updated)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-noprompt';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await userPromptSubmit(
    { session_id: sid, cwd /* no prompt */ },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  assert.equal(result, undefined);
  // turn_id still bumped.
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.equal(ts.turn_id, 1);
});

test('userPromptSubmit Phase 6: prompt with no matches → no preload', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-nomatch';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  const result = await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'The And For But Or Not You This' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  // All symbols stoplisted, no paths → no preload.
  assert.equal(result, undefined);
});

test('userPromptSubmit Phase 6: writes injected_nodes for matched files', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-inject';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'please review src/a.ts' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.deepEqual(ts.injected_nodes, [fileNodeId('src/a.ts')]);
});

test('userPromptSubmit Phase 6: clears injected_nodes from previous turn', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ups6-clear';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Pre-seed injected_nodes from a prior turn.
  const { writeJsonAtomic } = await import('../lib/io.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    injected_nodes: ['node:src/old.ts'],
    turn_id: 5,
  });

  await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'no relevant tokens here' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  // After clearing + no preload, injected_nodes should be [] (or at least not contain old).
  assert.ok(Array.isArray(ts.injected_nodes));
  assert.ok(!ts.injected_nodes.includes('node:src/old.ts'),
    'stale injected_nodes must be cleared');
});

test('preToolUse Phase 6: Edit on injected_nodes file skips the wallpaper (node rule still emits)', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu6-dedup';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Node rule for src/a.ts so the write still emits a node-rule block while the
  // advisory wallpaper is deduped away.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [node:src/a.ts] never log secrets\n',
    'utf8',
  );

  // Seed injected_nodes containing the file's nodeId (simulating an earlier
  // UserPromptSubmit preload or an earlier edit this turn).
  const { writeJsonAtomic } = await import('../lib/io.mjs');
  await writeJsonAtomic(runtimeFile(sid, 'turn-state.json'), {
    injected_nodes: [fileNodeId('src/a.ts')],
  });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  // Node-rule write block present.
  assert.match(ctx, /never log secrets/);
  // Advisory wallpaper (graph identity / connections / symbols) suppressed.
  assert.ok(!ctx.includes('graph: a.ts'),
    `graph identity should be suppressed; got:\n${ctx}`);
  assert.ok(!ctx.includes('connections (top'),
    `connections section should be suppressed; got:\n${ctx}`);
  assert.ok(!ctx.includes('symbols (up to'),
    `symbols section should be suppressed; got:\n${ctx}`);

  // reads.redundant_blocked bumped by the wallpaper dedup hit.
  const state = await readState(sid);
  assert.equal(state.reads.redundant_blocked, 1, 'reads.redundant_blocked bumped');
});

test('preToolUse Phase 6: Edit on file NOT in injected_nodes renders the wallpaper + appends nodeId', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu6-fresh';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Empty turn-state — no injected_nodes.
  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  // Full wallpaper present.
  assert.match(ctx, /graph: a\.ts/);
  assert.match(ctx, /symbols \(up to 20\)/);

  // nodeId now appended.
  const ts = JSON.parse(await fs.readFile(runtimeFile(sid, 'turn-state.json'), 'utf8'));
  assert.deepEqual(ts.injected_nodes, [fileNodeId('src/a.ts')]);

  // redundant_blocked stays at 0.
  const state = await readState(sid);
  assert.equal(state.reads.redundant_blocked ?? 0, 0);
});

test('preToolUse Phase 6: redundant_blocked increments only on a wallpaper dedup hit, not on first Edit', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu6-counter';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // First Edit: fresh — wallpaper emits, no dedup.
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  let state = await readState(sid);
  assert.equal(state.reads.redundant_blocked ?? 0, 0, 'first Edit = no dedup');

  // Second Edit of SAME file: now injected_nodes contains src/a.ts → dedup.
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  state = await readState(sid);
  assert.equal(state.reads.redundant_blocked, 1, 'second Edit = dedup hit');

  // Third Edit of a DIFFERENT file: fresh — no new dedup.
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/b.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  state = await readState(sid);
  assert.equal(state.reads.redundant_blocked, 1, 'different file = no new dedup');
});

// -- PreToolUse Phase 7 (structural gate at cerebrum write) -----------------

// Helper to write a cerebrum file into a project cwd (returns the absolute path).
async function seedCerebrum(cwd, kind, body) {
  const p = path.join(cwd, '.sextant', 'cerebrum', `${kind}.md`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
  return p;
}

test('preToolUse Phase 7: Edit on cerebrum/regular.md with malformed new line → permissionDecision=deny', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-malformed';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n- 2026-05-01: [!global] existing rule body long enough\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // Append a malformed line (missing the colon after the date).
  const malformedAddition = '- 2026-05-10 [node:foo.ts] missing colon but otherwise long enough';
  const proposed = seed + malformedAddition + '\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput,
    `expected gate envelope; got ${JSON.stringify(result)}`);
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /structural gate/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /schema/);

  // rules.deny_red flag flipped.
  const state = await readState(sid);
  assert.equal(state.rules.deny_red, true, 'deny_red should be set');
  assert.ok((state.rules.blocked ?? 0) >= 1, 'rules.blocked should be bumped');
});

test('preToolUse Phase 7: SEXTANT_CEREBRUM_GATE=off disables the gate (no deny on a malformed line)', async (t) => {
  await setupEnv(t);
  // Kill-switch (v0.44.0): the gate denies (not asks) and a deny has no user
  // override, so the env escape hatch must short-circuit it entirely.
  withEnv(t, { SEXTANT_CEREBRUM_GATE: 'off' });
  const sid = 'ptu7-killswitch';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n- 2026-05-01: [!global] existing rule body long enough\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // Same malformed addition the gate would normally deny.
  const proposed = seed + '- 2026-05-10 [node:foo.ts] missing colon but otherwise long enough' + '\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // With the gate off, no permissionDecision is emitted — the write passes through.
  if (result && result.hookSpecificOutput) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny',
      `kill-switch must suppress the deny; got ${JSON.stringify(result)}`);
  }
});

test('preToolUse Phase 7: Edit on cerebrum/regular.md with VALID no-bucket line passes', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-no-bucket';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // No-bucket dated rule (PostToolUse auto-tagger will add the bucket).
  const proposed = seed + '- 2026-05-10: A long enough rule body explaining things in detail\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // No envelope = pass-through (Edit/Write don't otherwise emit additionalContext).
  assert.equal(result, undefined, `expected pass-through; got ${JSON.stringify(result)}`);

  // deny_red NOT flipped.
  const state = await readState(sid);
  assert.equal(state.rules.deny_red, false, 'deny_red should remain false');
});

test('preToolUse Phase 7 (T3.5): Edit on cerebrum.md with VALID v2 buckets passes the gate', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-v2-ok';
  const cwd = await freshProjectCwd(t);
  // The one store the agent now edits directly. v2 buckets ([global]/[kw:]/
  // [provisional]/[!]) must NOT be false-rejected by the (structural) gate.
  // [!] rules carry a (by: …) provenance suffix (the gate enforces this for any
  // mandatory rule, v1 or v2); [provisional]/[node:] non-[!] lines do not need it.
  const seed = CEREBRUM_V2_HEADER + '\n- 2026-05-01: [global] [!] existing rule body long enough to pass (by: s0)\n';
  const cerebrumPath = await seedCerebrum(cwd, 'cerebrum', seed);
  const proposed = seed +
    '- 2026-06-01: [kw:billing, invoice] [!] never auto-charge without an explicit confirmation step (by: s1)\n' +
    '- 2026-06-01: [provisional] [node:src/x.ts] a provisional note that is plenty descriptive here\n';

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: cerebrumPath, content: proposed } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.equal(result, undefined, `valid v2 edit must pass the gate; got ${JSON.stringify(result)}`);
  const state = await readState(sid);
  assert.equal(state.rules.deny_red, false, 'deny_red stays false on a valid v2 edit');
});

test('preToolUse Phase 7 (T3.5): the gate is ACTIVE on cerebrum.md (malformed line → deny)', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-v2-malformed';
  const cwd = await freshProjectCwd(t);
  const seed = CEREBRUM_V2_HEADER + '\n';
  const cerebrumPath = await seedCerebrum(cwd, 'cerebrum', seed);
  // Missing the colon after the date — schema check must fire on cerebrum.md too.
  const proposed = seed + '- 2026-06-01 [global] missing colon but otherwise long enough to pass specificity\n';

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Write', tool_input: { file_path: cerebrumPath, content: proposed } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput, 'gate must run on cerebrum.md');
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /structural gate/);
});

test('preToolUse Phase 7: Edit on a NON-cerebrum file → no gate, normal pass-through', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu7-non-cerebrum';
  const cwd = await freshProjectCwd(t);
  await writeSyntheticGraph(cwd, syntheticGraph());

  // Even with the same malformed body, an Edit on a non-cerebrum file MUST
  // pass through. The structural gate only applies to cerebrum writes.
  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: path.join(cwd, 'src', 'random.ts'),
        content: '- 2026-05-10 missing colon — would fail the gate if it ran',
      },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.equal(result, undefined, 'Edit on non-cerebrum should pass through');
  const state = await readState(sid);
  assert.equal(state.rules.deny_red, false, 'deny_red should remain false');
});

test('preToolUse Phase 7: Edit on cerebrum/regular.md with specificity violation → deny', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-specificity';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // Body 'be careful' is 10 chars — under the 20-char specificity threshold.
  const proposed = seed + '- 2026-05-10: [node:foo.ts] be careful\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput,
    `expected gate envelope; got ${JSON.stringify(result)}`);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /specificity/);
});

test('preToolUse Phase 7: Edit on cerebrum/mandatory.md without (by:) → deny', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-no-by';
  const cwd = await freshProjectCwd(t);
  const seed = '# Mandatory\n\n';
  const cerebrumPath = await seedCerebrum(cwd, 'mandatory', seed);

  const proposed = seed + '- 2026-05-10: [!] [!global] mandatory rule without provenance suffix\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /provenance/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /by:/);
});

test('preToolUse Phase 7: Edit on cerebrum with a malformed rule → deny', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-gate-malformed';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // A mandatory ([!]) rule with no (by: <session>) provenance suffix trips the gate.
  const proposed =
    seed + '- 2026-05-10: [!] [node:foo.ts] mandatory rule with no provenance suffix here\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /provenance|by:/);
});

test('preToolUse Phase 7: Edit tool with old_string/new_string semantics drives the gate', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-edit-sub';
  const cwd = await freshProjectCwd(t);
  const seed =
    '# Cerebrum\n\n- 2026-05-01: [!global] some long existing rule body\n[PLACEHOLDER]\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // Substitute PLACEHOLDER with a malformed line via Edit tool semantics.
  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: cerebrumPath,
        old_string: '[PLACEHOLDER]',
        new_string: '- 2026-05-10 [node:foo.ts] body without the colon — schema fail',
      },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput,
    `expected gate envelope; got ${JSON.stringify(result)}`);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /schema/);
});

test('preToolUse Phase 7: Edit replacing nothing (same content) does not trigger the gate', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-noop';
  const cwd = await freshProjectCwd(t);
  const seed = '# Cerebrum\n\n- 2026-05-01: [!global] some long existing rule body\n';
  const cerebrumPath = await seedCerebrum(cwd, 'regular', seed);

  // Edit that's a no-op (old_string -> same new_string) → no new lines → no gate fire.
  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: cerebrumPath,
        old_string: '# Cerebrum',
        new_string: '# Cerebrum',
      },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.equal(result, undefined, 'no-op Edit on cerebrum should pass through');
});

test('preToolUse Phase 7: cerebrum file path absent on disk seeds an empty-existing diff', async (t) => {
  await setupEnv(t);
  const sid = 'ptu7-missing-file';
  const cwd = await freshProjectCwd(t);
  // Don't seed the file — only the directory.
  await fs.mkdir(path.join(cwd, '.sextant', 'cerebrum'), { recursive: true });
  const cerebrumPath = path.join(cwd, '.sextant', 'cerebrum', 'regular.md');

  // Write a brand-new cerebrum file with a malformed line. Existing=='', so the
  // diff is the whole file content.
  const proposed = '# Cerebrum\n\n- 2026-05-10 [node:foo.ts] missing colon malformed line\n';

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: cerebrumPath, content: proposed },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /schema/);
});

// -- PreToolUse Phase 8 (token ledger + A/B measurement) --------------------

// Helper: pin the session's ab_arm into statusline-state.json BEFORE the
// PreToolUse fire so finalize's instrumentation sees the right arm. (In
// production the arm is set by SessionStart; we synthesize it here.)
async function pinArm(sid, arm) {
  await withState(sid, null, (state) => {
    state.ab_arm = arm;
  });
}

test('preToolUse Phase 8: treatment arm (B) → stats.rule_fires + tokens_paid_extra update', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-ph8-treatment';
  const cwd = await freshProjectCwd(t);

  await pinArm(sid, 'B');

  // Mandatory rule that will fire on a Read of src/a.ts.
  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  const ruleLine = '- 2026-05-10: [!] [node:src/a.ts] never log secrets (by: sess-1)';
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n' + ruleLine + '\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  // Sanity: the mandatory block fired (so additionalContext should exist).
  assert.ok(result && result.hookSpecificOutput, 'mandatory block should emit additionalContext');
  const block = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof block === 'string' && block.length > 0);

  const stats = await readStats(durableBase(cwd));
  // tokens_paid_extra should equal the estimator on the emitted block.
  assert.ok(stats.tokens_paid_extra > 0, `expected tokens_paid_extra>0, got ${stats.tokens_paid_extra}`);
  assert.equal(stats.tokens_paid_extra, Math.ceil(block.length / 4));
  // rule_fires keyed by SHA1-16 of the rule's raw text.
  const hash = cerebrumLineHash(ruleLine);
  assert.ok(stats.rule_fires[hash], `rule_fires should contain hash ${hash}`);
  assert.equal(stats.rule_fires[hash].fires, 1);
  // No dedup hit (first read of this file this turn).
  assert.equal(stats.redundant_reads_blocked, 0);
  // Ledger leaves savings at 0 in v1 → net is negative.
  assert.equal(stats.tokens_saved_estimate, 0);
  assert.equal(stats.net_savings, -stats.tokens_paid_extra);
});

test('preToolUse Phase 8: control arm (A) → stats.json NOT updated', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-ph8-control';
  const cwd = await freshProjectCwd(t);

  await pinArm(sid, 'A');

  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-10: [!] [node:src/a.ts] never log secrets (by: sess-1)\n',
    'utf8',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result && result.hookSpecificOutput, 'mandatory block still emits (control arm only suppresses ledger)');

  // stats.json should not exist on the control arm.
  await assert.rejects(
    fs.readFile(path.join(cwd, '.sextant', 'stats.json'), 'utf8'),
    /ENOENT/,
    'control arm must not touch stats.json',
  );
});

test('preToolUse Phase 8: treatment arm — multiple fires sum into one hash entry', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-ph8-multi-fire';
  const cwd = await freshProjectCwd(t);
  await pinArm(sid, 'B');

  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  // cerebrum-v2 (T3.5): a [kw:src][!] rule fires every Read whose path contains
  // 'src' via the exact word-boundary floor ([!] kw → 'critical' → never throttled).
  // [!global] would session-dedup after the first emit, so a kw[!] rule is used.
  const ruleLine = '- 2026-05-10: [kw:src] [!] never log secrets (by: sess-1)';
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), CEREBRUM_V2_HEADER + '\n' + ruleLine + '\n', 'utf8');

  // Three reads of different files — kw rule fires each time (each file
  // path contains the `src` token between word boundaries).
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/a.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/b.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/c.ts') } },
    makeCtx(sid, 'PreToolUse'),
  );

  const stats = await readStats(durableBase(cwd));
  const hash = cerebrumLineHash(ruleLine);
  assert.equal(stats.rule_fires[hash].fires, 3, 'rule fired 3 times');
  assert.ok(stats.tokens_paid_extra > 0);
});

test('preToolUse Phase 8: treatment arm — Edit on a non-cerebrum file → no ledger write', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-ph8-edit-skip';
  const cwd = await freshProjectCwd(t);
  await pinArm(sid, 'B');

  // No mandatory.md, no graph — Edit is a pass-through that should never
  // touch the ledger (the per-Read instrumentation is gated on Read-only
  // emission paths).
  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' } },
    makeCtx(sid, 'PreToolUse'),
  );

  await assert.rejects(
    fs.readFile(path.join(cwd, '.sextant', 'stats.json'), 'utf8'),
    /ENOENT/,
    'Edit must not write stats.json',
  );
});

test('preToolUse: opted-in general [kw:] rule throttles across turns; legacy/critical exempt', async (t) => {
  await setupEnv(t);
  _resetGraphCache();
  const sid = 'ptu-kw-throttle';
  const cwd = await freshProjectCwd(t);
  const { readModifyJson } = await import('../lib/io.mjs');
  const { turnStatePath } = await import('../lib/paths.mjs');

  const cerebrumDir = path.join(cwd, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  // cerebrum-v2 (T3.5): a non-[!] kw rule fires on Bash as a 'general' trigger
  // (word-boundary match) and is windowed-deduped; [!] kw rules ('critical') are
  // exempt. (The v1 *-critical / ;min scoring grammar is retired.)
  const ruleLine = '- 2026-05-12: [kw:alpha, beta] never commit api keys to the repo (by: s1)';
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), CEREBRUM_V2_HEADER + '\n' + ruleLine + '\n', 'utf8');

  const input = { command: 'run alpha then beta in sequence' }; // matches both generals
  const fire = () => preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: input },
    makeCtx(sid, 'PreToolUse'),
  );
  const emitted = (r) => !!(r && r.hookSpecificOutput
    && (r.hookSpecificOutput.additionalContext || '').includes('never commit api keys'));

  // turn 7: first general fire → emits
  await readModifyJson(turnStatePath(sid, cwd), (o) => { o.turn_id = 7; });
  assert.equal(emitted(await fire()), true, 'turn 7 emits the first general fire');

  // turn 9 (within the 5-turn window) → suppressed
  await readModifyJson(turnStatePath(sid, cwd), (o) => { o.turn_id = 9; });
  assert.equal(emitted(await fire()), false, 'turn 9 is throttled');

  // turn 12 (window elapsed) → re-emits
  await readModifyJson(turnStatePath(sid, cwd), (o) => { o.turn_id = 12; });
  assert.equal(emitted(await fire()), true, 'turn 12 re-emits after the window');
});

// -- [!global] mandatory rules: compose + sessionStart + Bash injection -----

test('composeSessionStartBlock: globalRules section renders when present', () => {
  const r = composeSessionStartBlock({
    projectMd: '# P',
    lastJson: null,
    graphStats: null,
    isStale: false,
    globalRules: [{ body: 'Never push to main without review.', raw: '- 2026-05-12: [!] [!global] Never push to main without review.' }],
  });
  assert.ok(typeof r === 'string');
  assert.ok(r.includes('## Global mandatory rules'));
  assert.ok(r.includes('Apply every global rule below for the entire session.'));
  assert.ok(r.includes('Never push to main without review.'));
});

test('composeSessionStartBlock: empty globalRules omits the section', () => {
  const r = composeSessionStartBlock({
    projectMd: '# P',
    lastJson: null,
    graphStats: null,
    isStale: false,
    globalRules: [],
  });
  assert.ok(typeof r === 'string');
  assert.ok(!r.includes('Global mandatory rules'));
});

test('sessionStart: surfaces [!] [!global] mandatory rules in additionalContext', async (t) => {
  await setupEnv(t);
  const sid = 'ss-globals';
  const cwd = await freshProjectCwd(t);
  // Need at least one segment besides globalRules to keep the block non-null
  // path simple; project.md is fine.
  await writeFile(durableFile(cwd, 'project.md'), '# P');
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    CEREBRUM_V2_HEADER + '\n- 2026-05-12: [!] [!global] Sandbox blocks writes to .claude/agents.\n',
  );

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));

  assert.ok(result && result.hookSpecificOutput, 'expected hookSpecificOutput');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes('## Global mandatory rules'));
  assert.ok(ctx.includes('Sandbox blocks writes to .claude/agents.'));
});

test('sessionStart auto-heal (T3.5/R3): an un-migrated v1 store is migrated + surfaced, and its globals fire', async (t) => {
  await setupEnv(t);
  const sid = 'ss-autoheal';
  const cwd = await freshProjectCwd(t);
  await writeFile(durableFile(cwd, 'project.md'), '# P');
  // v1 store only (no cerebrum.md) — pre-retirement this would silently fire via
  // the v1 reader; post-retirement R3 must auto-migrate it.
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'mandatory.md')),
    '- 2026-05-12: [!] [!global] Never force-push to main.\n',
  );

  const result = await sessionStart({ session_id: sid, cwd }, makeCtx(sid, 'SessionStart'));

  // The auto-heal banner is surfaced...
  assert.ok(result, 'expected a result envelope');
  assert.match(result.systemMessage || '', /migrated 1 cerebrum rule/);
  // ...cerebrum.md was written...
  const one = await fs.readFile(durableFile(cwd, path.join('cerebrum', 'cerebrum.md')), 'utf8');
  assert.ok(one.startsWith(CEREBRUM_V2_HEADER));
  // ...and the global rule now fires in the block.
  assert.ok(result.hookSpecificOutput.additionalContext.includes('Never force-push to main.'));
});

test('preToolUse: Bash with [!] [!global] mandatory rule surfaces it', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-global';
  const cwd = await freshProjectCwd(t);
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    CEREBRUM_V2_HEADER + '\n- 2026-05-12: [!] [!global] Never cp into .claude/agents from inside CC.\n',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput, `expected hookSpecificOutput; got ${JSON.stringify(result)}`);
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes('<!-- sextant:bash-global-rules -->'));
  assert.ok(ctx.includes('Apply every rule below before running this command.'));
  assert.ok(ctx.includes('Never cp into .claude/agents from inside CC.'));
});

test('preToolUse: Bash with no mandatory globals and no kw match returns undefined', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-empty';
  const cwd = await freshProjectCwd(t);
  // Empty mandatory.md — no rules to surface.
  await writeFile(durableFile(cwd, path.join('cerebrum', 'mandatory.md')), '');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.equal(result, undefined);
});

test('preToolUse: Bash [kw:] match still works (regression)', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-kw';
  const cwd = await freshProjectCwd(t);
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    CEREBRUM_V2_HEADER + '\n- 2026-05-12: [!] [kw:rm] Be careful with destructive commands.\n',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'rm -rf foo' } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes('Be careful with destructive commands.'));
});

test('preToolUse: Bash merges [!global] + [kw:] without duplicating', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bash-merge';
  const cwd = await freshProjectCwd(t);
  // Two distinct rules: one global, one kw-matched by the command. Should
  // both appear, each exactly once.
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-12: [!] [!global] Global rule body.',
      '- 2026-05-12: [!] [kw:rm] Keyword rule body.',
      '',
    ].join('\n'),
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'rm foo' } },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result && result.hookSpecificOutput);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('Global rule body.'));
  assert.ok(ctx.includes('Keyword rule body.'));
  // Each body should appear exactly once.
  const globalCount = (ctx.match(/Global rule body\./g) || []).length;
  const kwCount = (ctx.match(/Keyword rule body\./g) || []).length;
  assert.equal(globalCount, 1, 'global body should appear once');
  assert.equal(kwCount, 1, 'kw body should appear once');
});

// -- Tranche hook integration tests -----------------------------------------

import {
  defaultTranches,
  startFeature,
  advanceTranche,
  setChecklistComplete,
  finalizeFeature,
  recordConcern,
  recordCapture,
  writeTranches,
  readTranches,
} from '../lib/stores/tranches.mjs';

function freshProjectDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-tranche-hook-' + crypto.randomUUID());
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

async function seedTranches(cwd, mutator) {
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  const state = defaultTranches();
  mutator(state);
  await writeTranches(cwd, state);
  return state;
}

// -- PostToolUse: tranche scope-drift nudge (migrated to the shared helper) --

test('postToolUse scope-drift: editing outside an IN-FLIGHT tranche scope emits a TOP-LEVEL systemMessage, deduped per file', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-scope-drift';
  const cwd = freshProjectDir(t);
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat',
      docRoot: 'docs/feat',
      charterPath: 'docs/feat/charter.md',
      specPath: 'docs/feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/in-scope.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  const payload = {
    session_id: sid,
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(cwd, 'src/out-of-scope.ts') },
  };

  // Transition-level → visible under default quiet (no config written → quiet).
  const r1 = await postToolUse(payload, makeCtx(sid, 'PostToolUse'));
  assert.ok(r1 && typeof r1.systemMessage === 'string', 'emits a top-level systemMessage');
  assert.match(stripAnsi(r1.systemMessage), /outside tranche T1 scope/);
  assert.match(stripAnsi(r1.systemMessage), /tranche-amend/);
  // The fix: systemMessage must be TOP-LEVEL, not nested under hookSpecificOutput.
  assert.ok(
    !(r1.hookSpecificOutput && r1.hookSpecificOutput.systemMessage),
    'systemMessage is not nested under hookSpecificOutput',
  );

  // driftKey dedups a second edit of the same file in the same turn.
  const r2 = await postToolUse(payload, makeCtx(sid, 'PostToolUse'));
  assert.ok(!r2 || !r2.systemMessage, 'second edit of the same out-of-scope file is suppressed');
});

test('postToolUse scope-drift: an in-scope edit produces no nudge', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-scope-inscope';
  const cwd = freshProjectDir(t);
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat',
      docRoot: 'docs/feat',
      charterPath: 'docs/feat/charter.md',
      specPath: 'docs/feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/in-scope.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  const r = await postToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/in-scope.ts') } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.ok(!r || !r.systemMessage, 'in-scope edit emits no drift nudge');
});

// -- bug-7: sanctioned capture paths must satisfy the tranche capture gate ---

async function seedInFlight(cwd) {
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat', docRoot: 'docs/feat', charterPath: 'docs/feat/charter.md', specPath: 'docs/feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });
}

test('postToolUse bug-7: a cerebrum-CLI append via Bash bumps captures_this_session.rules', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-rule-capture';
  const cwd = freshProjectDir(t);
  await seedInFlight(cwd);

  await postToolUse(
    {
      session_id: sid, cwd, tool_name: 'Bash',
      tool_input: { command: 'node bin/cerebrum.mjs remember --node src/a.ts --text-stdin' },
      tool_response: { stdout: 'Appended to cerebrum.md: - 2026-06-04: [node:src/a.ts] a lesson' },
    },
    makeCtx(sid, 'PostToolUse'),
  );
  const tState = await readTranches(cwd);
  assert.equal(tState.captures_this_session.rules, 1, 'remember-by-CLI now satisfies the capture gate');
});

test('postToolUse bug-7: a `bugs.mjs log` Bash call bumps captures_this_session.bugs (not the old `add` typo)', async (t) => {
  await setupEnv(t);
  const sid = 'ptu-bug-capture';
  const cwd = freshProjectDir(t);
  await seedInFlight(cwd);

  // A list invocation prints `bug-N [..]` lines (id + trailing text) — must NOT
  // count as a capture (only a bare-id `log` confirmation does).
  await postToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'node bin/bugs.mjs list --open-only' }, tool_response: { stdout: 'bug-1 [src/a.ts:foo] TypeError\nbug-2 [src/b.ts:bar] RangeError' } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.equal((await readTranches(cwd)).captures_this_session.bugs, 0, 'list lines (id + trailing text) must not count');

  // bug-6-class guard: a command that MENTIONS `bugs.mjs log` but prints no
  // confirmation (a commit message, a failed log → empty stdout) must NOT count.
  // This is the regression that justifies matching the OUTPUT, not the command.
  await postToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'git commit -m "wire bugs.mjs log into the capture gate"' }, tool_response: { stdout: '[main abc] wire bugs.mjs log into the capture gate' } },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.equal((await readTranches(cwd)).captures_this_session.bugs, 0, 'a command merely mentioning bugs.mjs log must not count');

  await postToolUse(
    {
      session_id: sid, cwd, tool_name: 'Bash',
      tool_input: { command: 'node /p/bin/bugs.mjs log --file src/a.ts --error e --root-cause r --fix f --root .' },
      tool_response: { stdout: 'bug-3' },
    },
    makeCtx(sid, 'PostToolUse'),
  );
  assert.equal((await readTranches(cwd)).captures_this_session.bugs, 1, 'a bare bug-N confirmation satisfies the capture gate');
});

// bug-7 (ack-escape half): agentRepliedNoCaptures must recognize an agent reply
// that starts with the acknowledgment phrase, and reject a nudge echo / an
// earlier-turn ack. These pin the FUNCTION behavior. The parser-only cases pass
// { budgetMs: 0 } for a single immediate read; the transcript-flush race (the
// reply not yet visible when Stop reads — bug-7's residual loop) is pinned
// separately below by the late-flush test, which relies on the default poll.
async function writeTranscript(t, lines) {
  const p = path.join(os.tmpdir(), 'sextant-transcript-' + crypto.randomUUID() + '.jsonl');
  await fs.writeFile(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  t.after(() => fs.rm(p, { force: true }).catch(() => {}));
  return p;
}

test('bug-7 ack: agentRepliedNoCaptures is TRUE when the last assistant message starts with the phrase', async (t) => {
  const p = await writeTranscript(t, [
    { type: 'user', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No captures needed — this turn was pure reading.' }] } },
  ]);
  assert.equal(await agentRepliedNoCaptures(p), true);
});

test('bug-7 ack: a nudge echo (starts "Sextant: Tranche…") does NOT clear the gate', async (t) => {
  const p = await writeTranscript(t, [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "Sextant: Tranche IN-FLIGHT. Reply 'no captures needed' if nothing to record." }] } },
  ]);
  assert.equal(await agentRepliedNoCaptures(p, { budgetMs: 0 }), false);
});

test('bug-7 ack: only the MOST-RECENT assistant message counts (stale ack ignored)', async (t) => {
  const p = await writeTranscript(t, [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No captures needed.' }] } },
    { type: 'user', message: { role: 'user', content: 'now do real work' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done — edited src/a.ts.' }] } },
  ]);
  assert.equal(await agentRepliedNoCaptures(p, { budgetMs: 0 }), false);
});

// bug-7 residual (flush race): the ack line is appended AFTER Stop starts reading
// (slow / 9p mount). A single read misses it and the gate loops; the bounded poll
// must catch the late-flushed ack. Simulate by writing the transcript without the
// ack, then appending it mid-poll. With the default budget this resolves true;
// before the poll fix (a single read) it would be false.
test('bug-7 ack (race): a late-flushed ack is caught by the poll, not missed', async (t) => {
  const p = await writeTranscript(t, [
    { type: 'user', message: { role: 'user', content: 'where did we leave off?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is where we left off: T4 is functionally done.' }] } },
  ]);
  // Flush the ack ~60ms in — well inside the 250ms default budget.
  const ack = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No captures needed — orientation only.' }] } };
  const timer = setTimeout(() => {
    fs.appendFile(p, JSON.stringify(ack) + '\n', 'utf8').catch(() => {});
  }, 60);
  t.after(() => clearTimeout(timer));
  assert.equal(await agentRepliedNoCaptures(p), true);

  // Control: the SAME pre-ack transcript with a single immediate read stays false
  // (proves the race is real and the poll — not the parser — is what fixes it).
  const p2 = await writeTranscript(t, [
    { type: 'user', message: { role: 'user', content: 'where did we leave off?' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is where we left off: T4 is functionally done.' }] } },
  ]);
  assert.equal(await agentRepliedNoCaptures(p2, { budgetMs: 0 }), false);
});

// -- UserPromptSubmit: per-turn tranche nudge reads deliverables LIVE --------
// Regression guard for the "deliverables nudge goes stale after a mid-session
// advance" bug. The nudge must show the CURRENTLY-active tranche's deliverables,
// parsed live from its doc each turn — not a value frozen at SessionStart.
test('userPromptSubmit tranche nudge: deliverables track the active tranche live across an advance', async (t) => {
  await setupEnv(t);
  const sid = 'ups-tranche-live-deliverables';
  const cwd = freshProjectDir(t);

  // Two tranches, each with its own doc carrying a DISTINCT deliverable title.
  await fs.mkdir(path.join(cwd, 'docs', 'feat'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, 'docs', 'feat', 't1.md'),
    '## Locked deliverables\n### OLD-T1-DELIVERABLE\n- detail\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(cwd, 'docs', 'feat', 't2.md'),
    '## Locked deliverables\n### LIVE-T2-DELIVERABLE\n- detail\n',
    'utf8',
  );

  // Drive the state machine to: T1 SHIPPED, T2 IN-FLIGHT (T2 now active) — the
  // exact mid-session advance that used to leave the cached summary pointing at
  // T1's deliverables.
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat',
      docRoot: 'docs/feat',
      charterPath: 'docs/feat/charter.md',
      specPath: 'docs/feat/spec.md',
      tranches: [
        { id: '1', title: 'T1', doc_path: 'docs/feat/t1.md', scope: ['src/a.ts'], depends_on: [] },
        { id: '2', title: 'T2', doc_path: 'docs/feat/t2.md', scope: ['src/b.ts'], depends_on: ['1'] },
      ],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED');
    advanceTranche(s, '2', 'READY');
    setChecklistComplete(s, '2');
    advanceTranche(s, '2', 'IN-FLIGHT');
  });

  const result = await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'continue' },
    makeCtx(sid, 'UserPromptSubmit'),
  );
  const ctx = result?.hookSpecificOutput?.additionalContext || '';

  assert.match(ctx, /Active: T2 .*IN-FLIGHT/, 'nudge names the live active tranche T2');
  assert.match(ctx, /LIVE-T2-DELIVERABLE/, 'nudge shows T2 deliverables read live from its doc');
  assert.ok(!ctx.includes('OLD-T1-DELIVERABLE'), 'nudge must not show the previous tranche\'s deliverables');
});

test('userPromptSubmit tranche nudge: IN-FLIGHT surfaces before-ship Qs + relevant concerns (real hook path)', async (t) => {
  await setupEnv(t);
  const sid = 'ups-tranche-before-ship';
  const cwd = freshProjectDir(t);
  await fs.mkdir(path.join(cwd, 'docs', 'feat'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, 'docs', 'feat', 't1.md'),
    '## Open questions before ship\n- [ ] batch the writes?\n- [x] resolved one\n',
    'utf8',
  );
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat', docRoot: 'docs/feat', charterPath: 'docs/feat/charter.md', specPath: 'docs/feat/spec.md',
      tranches: [{ id: '1', title: 'T1', doc_path: 'docs/feat/t1.md', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    // One concern targeting T1, one untargeted (both relevant); one targeting a
    // different tranche (must NOT surface for T1).
    recordConcern(s, { text: 'CONSUME-FOR-T1', target: '1' });
    recordConcern(s, { text: 'UNTARGETED-CONCERN' });
    s.carry_forward.push({ id: '9', text: 'OTHER-TRANCHE-ONLY', status: 'open', raised_by: '1', target: '5', resolved_by: null, resolved_at: null, note: null });
  });

  const result = await userPromptSubmit({ session_id: sid, cwd, prompt: 'continue' }, makeCtx(sid, 'UserPromptSubmit'));
  const ctx = result?.hookSpecificOutput?.additionalContext || '';

  assert.match(ctx, /Open questions before ship \(1\)/, 'surfaces the unchecked before-ship question');
  assert.match(ctx, /- batch the writes\?/);
  assert.ok(!ctx.includes('resolved one'), 'checked before-ship items are not surfaced');
  assert.match(ctx, /CONSUME-FOR-T1/, 'concern targeting this tranche surfaces');
  assert.match(ctx, /UNTARGETED-CONCERN/, 'untargeted concern surfaces');
  assert.ok(!ctx.includes('OTHER-TRANCHE-ONLY'), 'concern targeting a different tranche is filtered out');
});

test('userPromptSubmit tranche nudge: STUB surfaces impl questions, not before-ship', async (t) => {
  await setupEnv(t);
  const sid = 'ups-tranche-stub-phase';
  const cwd = freshProjectDir(t);
  await fs.mkdir(path.join(cwd, 'docs', 'feat'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, 'docs', 'feat', 't1.md'),
    '## Open questions before implementation\n- [ ] IMPL-PHASE-Q\n## Open questions before ship\n- [ ] SHIP-PHASE-Q\n',
    'utf8',
  );
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'feat', docRoot: 'docs/feat', charterPath: 'docs/feat/charter.md', specPath: 'docs/feat/spec.md',
      tranches: [{ id: '1', title: 'T1', doc_path: 'docs/feat/t1.md', scope: ['src/a.ts'], depends_on: [] }],
    });
    // stays STUB
  });

  const result = await userPromptSubmit({ session_id: sid, cwd, prompt: 'continue' }, makeCtx(sid, 'UserPromptSubmit'));
  const ctx = result?.hookSpecificOutput?.additionalContext || '';
  assert.match(ctx, /Open questions before READY \(1\)/);
  assert.match(ctx, /- IMPL-PHASE-Q/);
  assert.ok(!ctx.includes('SHIP-PHASE-Q'), 'pre-flight nudge must not show before-ship questions');
});

// DEFERRED COVERAGE (logged in tranche-1 doc): the contradiction-detected
// systemMessage (postToolUse.mjs contradiction sweep) has no direct test — the
// sweep's preconditions (A/B arm == 'B' + a detector-flagged pair + seeded
// stats.rule_fires) make a faithful fixture costly. Its behavior was preserved
// by the migration (only reformatted via the helper), so risk is low. Revisit
// when the contradiction surface gets dedicated hook-level coverage.

// -- PreToolUse: charter freeze deny ----------------------------------------

test('preToolUse tranche: denies edit to frozen charter', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-charter-deny';
  const cwd = freshProjectDir(t);
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'docs/test-feat/charter.md') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('frozen'));
});

test('preToolUse tranche: allows charter edit during PLANNING', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-charter-planning';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'docs/test-feat/charter.md') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // No deny — undefined or non-deny result
  if (result && result.hookSpecificOutput) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  }
});

// -- PreToolUse: shipped scope deny -----------------------------------------

test('preToolUse tranche: denies edit to shipped scope file', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-shipped-deny';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [
        { id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] },
        { id: '2', title: 'T2', scope: ['src/b.ts'], depends_on: ['1'] },
      ],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED');
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('SHIPPED'));
});

test('preToolUse tranche: a shipped file also claimed by a pending (STUB) tranche is NOT denied', async (t) => {
  // Reported bug: a file that ships with T1 but is ALSO in a LATER tranche's scope
  // (here T3, still STUB) must stay editable — it's planned, in-scope work, not
  // frozen. The old gate exempted only IN-FLIGHT scope, so a future STUB/READY
  // tranche's files re-froze and forced a per-edit amendment dance.
  await setupEnv(t);
  const sid = 'tranche-pending-scope-exempt';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [
        { id: '1', title: 'T1', scope: ['shared.ts'], depends_on: [] },
        { id: '2', title: 'T2', scope: ['src/b.ts'], depends_on: ['1'] },
        { id: '3', title: 'T3', scope: ['shared.ts'], depends_on: ['2'] }, // STUB, re-claims shared.ts
      ],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED'); // shared.ts now in SHIPPED T1 + STUB T3
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'shared.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // Not denied — a pending tranche (T3, STUB) claims it.
  if (result && result.hookSpecificOutput) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  }

  // And it did NOT consume the (unset) pending_amendment.
  const after = await readTranches(cwd);
  assert.equal(after.pending_amendment, false);
});

test('preToolUse tranche: finalize lifts the shipped-scope deny gate', async (t) => {
  // The reported bug: after a feature is finished, its shipped scope files stay
  // locked in unrelated later work. finalize must clear that.
  await setupEnv(t);
  const sid = 'tranche-finalize-clears-deny';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED');
  });

  const edit = () => preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // Before finalize: denied (single all-terminal tranche → workflow is COMPLETING).
  const before = await edit();
  assert.ok(before);
  assert.equal(before.hookSpecificOutput.permissionDecision, 'deny');

  // Finalize the finished feature.
  const state = await readTranches(cwd);
  finalizeFeature(state);
  await writeTranches(cwd, state);

  // After finalize: no deny/ask envelope — the file is freely editable again.
  const after = await edit();
  if (after && after.hookSpecificOutput) {
    assert.notEqual(after.hookSpecificOutput.permissionDecision, 'deny');
    assert.notEqual(after.hookSpecificOutput.permissionDecision, 'ask');
  }
});

test('preToolUse tranche: allows edit to shipped file also in active in-flight scope', async (t) => {
  // Minimal repro: T1 ships src/foo.ts; T2 (depends on T1) re-touches the same
  // file and is IN-FLIGHT. Editing src/foo.ts must be allowed with no amendment.
  await setupEnv(t);
  const sid = 'tranche-shipped-inflight-exempt';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [
        { id: '1', title: 'T1', scope: ['src/foo.ts'], depends_on: [] },
        { id: '2', title: 'T2', scope: ['src/foo.ts'], depends_on: ['1'] },
      ],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED');
    advanceTranche(s, '2', 'READY');
    setChecklistComplete(s, '2');
    advanceTranche(s, '2', 'IN-FLIGHT');
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/foo.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // Allowed: no deny/ask envelope.
  if (result && result.hookSpecificOutput) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'ask');
  }

  // The exemption must NOT consume the one-shot amendment flag.
  const after = await readTranches(cwd);
  assert.equal(after.pending_amendment, false);
});

test('preToolUse tranche: pending_amendment unlocks shipped scope deny once', async (t) => {
  // A shipped-scope file NOT in any in-flight tranche's scope is still gated;
  // pending_amendment provides exactly one unlock, then re-denies.
  await setupEnv(t);
  const sid = 'tranche-shipped-amend-unlock';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [
        { id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] },
        { id: '2', title: 'T2', scope: ['src/b.ts'], depends_on: ['1'] },
      ],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    advanceTranche(s, '1', 'SHIPPED');
    // T2 stays STUB — src/a.ts is in no in-flight scope.
    s.pending_amendment = true;
  });

  // First edit: unlocked by pending_amendment.
  const first = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );
  if (first && first.hookSpecificOutput) {
    assert.notEqual(first.hookSpecificOutput.permissionDecision, 'deny');
  }

  // Flag consumed — second edit denied.
  const second = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(second);
  assert.equal(second.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(second.hookSpecificOutput.permissionDecisionReason.includes('SHIPPED'));
});

test('advanceTranche: IN-FLIGHT repoints active_tranche_id and sets IMPLEMENTING', () => {
  // A tranche entering implementation becomes the active tranche. The repoint on
  // IN-FLIGHT guards out-of-order/parallel work: even if active_tranche_id points
  // elsewhere, taking a tranche IN-FLIGHT makes it active so activeTranche() —
  // read by the deny gate and ~8 hooks — tracks the tranche being worked.
  // (Tracked here because test/ is gitignored except hooks/globals-dedup.)
  const s = defaultTranches();
  startFeature(s, {
    feature: 'f',
    docRoot: 'd',
    charterPath: 'c',
    specPath: 's',
    tranches: [
      { id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] },
      { id: '2', title: 'T2', scope: ['src/b.ts'], depends_on: ['1'] },
    ],
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT');
  advanceTranche(s, '1', 'SHIPPED');
  // Shipping T1 completes it and advances active straight to the next tranche.
  assert.equal(s.active_tranche_id, '2');
  assert.equal(s.workflow_state, 'DETAILING');

  advanceTranche(s, '2', 'READY');
  setChecklistComplete(s, '2');
  advanceTranche(s, '2', 'IN-FLIGHT');
  assert.equal(s.active_tranche_id, '2');
  assert.equal(s.workflow_state, 'IMPLEMENTING');
});

// -- PreToolUse: checklist gate (deny) --------------------------------------

test('preToolUse tranche: denies when checklist incomplete on scope file', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-checklist-deny';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  assert.ok(result);
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('checklist'));
});

test('preToolUse tranche: no gate when checklist complete', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-checklist-done';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
  });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // Should not deny or ask for scope file edit
  if (result && result.hookSpecificOutput) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'ask');
  }
});

// -- PreToolUse: pending_amendment unlock + one-shot consumption ------------

test('preToolUse tranche: pending_amendment unlocks charter deny and is consumed', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-amend-unlock';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    s.pending_amendment = true;
  });

  // First edit: should be allowed (pending_amendment = true)
  const result1 = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'docs/test-feat/charter.md') },
    },
    makeCtx(sid, 'PreToolUse'),
  );
  if (result1 && result1.hookSpecificOutput) {
    assert.notEqual(result1.hookSpecificOutput.permissionDecision, 'deny');
  }

  // Flag should be consumed — second edit should be denied
  const result2 = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'docs/test-feat/charter.md') },
    },
    makeCtx(sid, 'PreToolUse'),
  );
  assert.ok(result2);
  assert.equal(result2.hookSpecificOutput.permissionDecision, 'deny');
});

// -- PreToolUse: no feature active → no gate --------------------------------

test('preToolUse tranche: no gate when no feature active', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-idle';
  const cwd = freshProjectDir(t);
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });

  const result = await preToolUse(
    {
      session_id: sid,
      cwd,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/anything.ts') },
    },
    makeCtx(sid, 'PreToolUse'),
  );

  // No deny or ask — either undefined or no permissionDecision
  if (result && result.hookSpecificOutput && result.hookSpecificOutput.permissionDecision) {
    assert.notEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  }
});

// -- Stop: auto-capture enforcement -----------------------------------------

test('stop tranche: blocks when IN-FLIGHT and no captures', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-block';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  const result = await stop(
    { session_id: sid, cwd },
    makeCtx(sid, 'Stop'),
  );

  assert.ok(result);
  assert.equal(result.decision, 'block');
  assert.ok(result.reason.length > 0);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.hookSpecificOutput, undefined);
});

test('stop tranche: releases when captures present', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-release';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
    s.captures_this_session = { rules: 1, bugs: 0 };
  });

  const result = await stop(
    { session_id: sid, cwd },
    makeCtx(sid, 'Stop'),
  );

  // No block — result should be undefined (normal stop)
  assert.equal(result, undefined);
});

test('stop tranche: skips for subagents (parent_session_id)', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-subagent';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  const result = await stop(
    { session_id: sid, cwd, parent_session_id: 'parent-123' },
    makeCtx(sid, 'Stop'),
  );

  // Subagent → no capture gate
  assert.equal(result, undefined);
});

test('stop tranche: safety valve after 3 blocks', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-valve';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  // Fire stop 3 times (should all block)
  for (let i = 0; i < 3; i++) {
    const r = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
    assert.ok(r, `block ${i + 1} should return result`);
    assert.equal(r.decision, 'block');
  }

  // 4th time: safety valve — should release
  const r4 = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(r4, undefined, 'after 3 blocks, safety valve releases');
});

test('stop tranche: no gate when IDLE', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-idle';
  const cwd = freshProjectDir(t);
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });

  const result = await stop(
    { session_id: sid, cwd },
    makeCtx(sid, 'Stop'),
  );

  assert.equal(result, undefined);
});

test('stop tranche: releases after "no captures needed" acknowledgment', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-ack';
  const cwd = freshProjectDir(t);

  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });

  // Verify stop would block without acknowledgment
  const r1 = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.ok(r1, 'should block before acknowledgment');
  assert.equal(r1.decision, 'block');

  // Simulate user saying "no captures needed" via userPromptSubmit
  await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'no captures needed' },
    makeCtx(sid, 'UserPromptSubmit'),
  );

  // Now stop should release
  const r2 = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(r2, undefined, 'should release after "no captures needed" acknowledgment');
});

// Helper: seed an IN-FLIGHT tranche with no captures (the gate-active state).
async function seedInFlightNoCaptures(cwd) {
  await seedTranches(cwd, (s) => {
    startFeature(s, {
      feature: 'test-feat',
      docRoot: 'docs/test-feat',
      charterPath: 'docs/test-feat/charter.md',
      specPath: 'docs/test-feat/spec.md',
      tranches: [{ id: '1', title: 'T1', scope: ['src/a.ts'], depends_on: [] }],
    });
    advanceTranche(s, '1', 'READY');
    setChecklistComplete(s, '1');
    advanceTranche(s, '1', 'IN-FLIGHT');
  });
}

test('stop tranche bug-7: a recorded capture releases the gate (no block, no loop)', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-captured';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  // The gate blocks with zero captures...
  const blocked = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(blocked.decision, 'block', 'zero captures → blocked');

  // ...and once a capture is recorded (the path Fix 1/Fix 2 now wire up), it
  // releases — this is the loop the user hit, gone.
  await seedTranches(cwd, (s) => { recordCapture(s, 'rule'); });
  const released = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(released, undefined, 'captures_this_session.rules>0 → gate releases');
});

test('stop tranche: block return carries no systemMessage (de-duped render)', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-nodup';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  const result = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(result.decision, 'block');
  assert.ok(result.reason.length > 0, 'reason still carries the nudge');
  assert.equal(result.systemMessage, undefined, 'systemMessage must not duplicate the block reason');
});

test('stop tranche: agent reply "no captures needed" in the transcript releases the gate', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-transcript-ack';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  const transcript = path.join(cwd, 'transcript.jsonl');
  await fs.writeFile(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'finalize the tranche' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'No captures needed.' }] } }),
  ].join('\n') + '\n', 'utf8');

  const result = await stop({ session_id: sid, cwd, transcript_path: transcript }, makeCtx(sid, 'Stop'));
  assert.equal(result, undefined, 'last assistant message acknowledges → gate releases');
});

test('stop tranche: an unrelated final assistant message does NOT release the gate', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-transcript-noack';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  const transcript = path.join(cwd, 'transcript.jsonl');
  await fs.writeFile(transcript, [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no captures needed' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the T1 summary instead.' }] } }),
  ].join('\n') + '\n', 'utf8');

  const result = await stop({ session_id: sid, cwd, transcript_path: transcript }, makeCtx(sid, 'Stop'));
  assert.ok(result, 'only the MOST RECENT assistant message counts');
  assert.equal(result.decision, 'block');
});

test('stop tranche: the nudge text (contains the phrase mid-text) does NOT clear the gate', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-nudge-noclear';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  // The capture nudge itself contains "no captures needed" (as an instruction)
  // but begins with "Sextant:". If it were echoed as the last assistant
  // message, the anchored check must still BLOCK — only a message that STARTS
  // with the phrase is a real acknowledgment.
  const nudgeEcho = 'Sextant: Tranche T1 is IN-FLIGHT. Before this turn ends, capture any learnings. Nothing to capture this turn: Reply "no captures needed".';
  const transcript = path.join(cwd, 'transcript.jsonl');
  await fs.writeFile(transcript,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: nudgeEcho }] } }) + '\n',
    'utf8');

  const result = await stop({ session_id: sid, cwd, transcript_path: transcript }, makeCtx(sid, 'Stop'));
  assert.ok(result, 'a message that merely CONTAINS the phrase must not release');
  assert.equal(result.decision, 'block');
});

test('stop tranche: block counter resets after an acknowledgment release', async (t) => {
  await setupEnv(t);
  const sid = 'tranche-stop-reset';
  const cwd = freshProjectDir(t);
  await seedInFlightNoCaptures(cwd);

  const r1 = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(r1.decision, 'block');
  let st = await readState(sid, cwd);
  assert.equal(st.tranche_stop_block_count, 1, 'one block recorded');

  await userPromptSubmit({ session_id: sid, cwd, prompt: 'no captures needed' }, makeCtx(sid, 'UserPromptSubmit'));
  const r2 = await stop({ session_id: sid, cwd }, makeCtx(sid, 'Stop'));
  assert.equal(r2, undefined, 'release on acknowledgment');

  st = await readState(sid, cwd);
  assert.equal(st.tranche_stop_block_count, 0, 'counter reset so a later turn gets a fresh gate');
});
