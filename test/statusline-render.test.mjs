// test/statusline-render.test.mjs — pure rendering tests for the v0.6.0
// two-line statusline. Asserts the visible string after ANSI is stripped so
// the tests are robust to terminal-token shifts; separate cases assert that
// specific ANSI sequences appear for severity (color is redundancy, never
// the only signal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';

import { lineOne, lineTwo, liveTranche, T } from '../statusline/statusline.mjs';

// ── fixture helpers ───────────────────────────────────────────────
function rm(dir) {
  fsSync.rmSync(dir, { recursive: true, force: true });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

function mkState(overrides = {}) {
  return {
    version: 1,
    ab_arm: 'A',
    reads: { total: 0, redundant_blocked: 0 },
    rules: { fires_this_turn: 0, mandatory_fires: 0, blocked: 0, deny_red: false },
    bugs: { open: 0 },
    review_queue_depth: 0,
    graph: { state: 'idle', last_rebuild_ts: null, dirty_count: 0 },
    compaction: { compaction_n: 0 },
    stuck: { tool: null, file: null, count: 0 },
    last_event: { tag: null, ts: null },
    ...overrides,
  };
}
const pl = (pct) => ({ context_window: { used_percentage: pct } });

// ── lineOne ──────────────────────────────────────────────────────

test('lineOne: quiet idle renders sxt · ctx N%', () => {
  assert.equal(stripAnsi(lineOne(pl(42), mkState(), '')), 'sxt · ctx 42%');
});

test('lineOne: ctx threshold 39 is normal (no warn/error color)', () => {
  const out = lineOne(pl(39), mkState(), '');
  assert.ok(!out.includes(T.warn));
  assert.ok(!out.includes(T.error));
});

test('lineOne: ctx threshold 40 is warn (yellow)', () => {
  const out = lineOne(pl(40), mkState(), '');
  assert.ok(out.includes(T.warn));
  assert.ok(!out.includes(T.error));
});

test('lineOne: ctx threshold 69 is warn (yellow)', () => {
  const out = lineOne(pl(69), mkState(), '');
  assert.ok(out.includes(T.warn));
  assert.ok(!out.includes(T.error));
});

test('lineOne: ctx threshold 70 is error (red)', () => {
  const out = lineOne(pl(70), mkState(), '');
  assert.ok(out.includes(T.error));
});

test('lineOne: arm A is hidden (progressive disclosure)', () => {
  assert.ok(!stripAnsi(lineOne(pl(20), mkState({ ab_arm: 'A' }), '')).includes('arm:'));
});

test('lineOne: arm B is shown', () => {
  assert.ok(stripAnsi(lineOne(pl(20), mkState({ ab_arm: 'B' }), '')).includes('arm:B'));
});

test('lineOne: comp:N hidden when zero', () => {
  assert.ok(!stripAnsi(lineOne(pl(20), mkState({ compaction: { compaction_n: 0 } }), '')).includes('comp:'));
});

test('lineOne: comp:N shown when > 0', () => {
  assert.ok(stripAnsi(lineOne(pl(20), mkState({ compaction: { compaction_n: 3 } }), '')).includes('comp:3'));
});

test('lineOne: bugs chip appears before diagnostics (mobile-40 priority)', () => {
  const out = stripAnsi(lineOne(pl(20), mkState({ ab_arm: 'B', bugs: { open: 4 } }), ''));
  assert.ok(out.indexOf('⚠ bugs 4') < out.indexOf('arm:B'));
});

test('lineOne: graph stale chip shows state and dirty count', () => {
  const out = stripAnsi(lineOne(pl(20), mkState({ graph: { state: 'stale', dirty_count: 12 } }), ''));
  assert.ok(out.includes('⚠ graph stale·12'));
});

test('lineOne: review chip shows queue depth', () => {
  const out = stripAnsi(lineOne(pl(20), mkState({ review_queue_depth: 5 }), ''));
  assert.ok(out.includes('✎ review 5'));
});

test('lineOne: zero-state chips all collapse', () => {
  const out = stripAnsi(lineOne(pl(20), mkState(), ''));
  assert.equal(out, 'sxt · ctx 20%');
});

test('lineOne: degrades on null state and empty payload', () => {
  assert.equal(stripAnsi(lineOne({}, null, '')), 'sxt · ctx 0%');
});

test('lineOne: chips are plain text — never wrapped in OSC 8 hyperlinks', () => {
  const out = lineOne(pl(20), mkState({ bugs: { open: 2 }, review_queue_depth: 3 }), '/some/cwd', 'A');
  assert.ok(!out.includes('\x1b]8;;'), `expected no osc8 in: ${JSON.stringify(out)}`);
  assert.ok(stripAnsi(out).includes('⚠ bugs 2'));
  assert.ok(stripAnsi(out).includes('✎ review 3'));
});

// ── lineTwo ──────────────────────────────────────────────────────

test('lineTwo: quiet idle renders ● idle · rules 0 · reads 0', () => {
  assert.equal(stripAnsi(lineTwo(mkState())), '● idle · rules 0 · reads 0');
});

test('lineTwo: active action shows ▸ + truncated detail', () => {
  const out = stripAnsi(lineTwo(mkState({
    last_event: { tag: 'PreToolUse:Edit', detail: 'edit cerebrum-regular.md' },
  })));
  assert.ok(out.startsWith('▸ edit cerebrum-r…'), `got: ${JSON.stringify(out)}`);
});

test('lineTwo: rules chips concat without inner spaces', () => {
  const out = stripAnsi(lineTwo(mkState({
    rules: { fires_this_turn: 19, mandatory_fires: 4, blocked: 1, deny_red: false },
  })));
  assert.ok(out.includes('rules 19↑4⊘1'));
});

test('lineTwo: deny_red renders ⚠deny chip', () => {
  const out = stripAnsi(lineTwo(mkState({
    rules: { fires_this_turn: 7, mandatory_fires: 0, blocked: 2, deny_red: true },
  })));
  assert.ok(out.includes('⚠deny'));
});

test('lineTwo: stuck overrides badge and action regardless of last_event', () => {
  const out = stripAnsi(lineTwo(mkState({
    stuck: { tool: 'Bash', count: 3 },
    last_event: { tag: 'PreToolUse:Read', detail: 'read foo.mjs' },
  })));
  assert.ok(out.startsWith('✕ stuck:Bash×3'));
});

test('lineTwo: PreCompact event shows compacting', () => {
  const out = stripAnsi(lineTwo(mkState({ last_event: { tag: 'PreCompact' } })));
  assert.ok(out.startsWith('⏵ compacting'));
});

test('lineTwo: PostCompact event shows compacted', () => {
  const out = stripAnsi(lineTwo(mkState({ last_event: { tag: 'PostCompact' } })));
  assert.ok(out.startsWith('⏵ compacted'));
});

test('lineTwo: Stop event shows ✓ idle', () => {
  const out = stripAnsi(lineTwo(mkState({ last_event: { tag: 'Stop' } })));
  assert.ok(out.startsWith('✓ idle'));
});

test('lineTwo: redundant reads chip appears when > 0', () => {
  const out = stripAnsi(lineTwo(mkState({ reads: { total: 47, redundant_blocked: 2 } })));
  assert.ok(out.includes('reads 47↺2'));
});

test('lineTwo: degrades on null state', () => {
  assert.equal(stripAnsi(lineTwo(null)), '● idle · rules 0 · reads 0');
});

test('lineTwo: rules/reads segments are plain text — never wrapped in OSC 8', () => {
  const out = lineTwo(mkState({
    rules: { fires_this_turn: 5, mandatory_fires: 0, blocked: 0, deny_red: false },
    reads: { total: 10, redundant_blocked: 0 },
  }), '/some/cwd', 'Z');
  assert.ok(!out.includes('\x1b]8;;'), `expected no osc8 in: ${JSON.stringify(out)}`);
});

// ── liveTranche: realtime chip derivation from durable tranches.json ──────
// Writes a tranches.json under <dir>/.sextant and returns the dir.
function makeTranchesFixture(tranches) {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sextant-tr-'));
  const sxt = path.join(dir, '.sextant');
  fsSync.mkdirSync(sxt, { recursive: true });
  fsSync.writeFileSync(path.join(sxt, 'tranches.json'), JSON.stringify(tranches));
  return dir;
}

test('liveTranche: returns null for empty cwd', () => {
  assert.equal(liveTranche(''), null);
});

test('liveTranche: returns null when tranches.json is missing', () => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sextant-tr-'));
  try { assert.equal(liveTranche(dir), null); } finally { rm(dir); }
});

test('liveTranche: returns null when no active tranche', () => {
  const dir = makeTranchesFixture({ active_tranche_id: null, tranches: [] });
  try { assert.equal(liveTranche(dir), null); } finally { rm(dir); }
});

test('liveTranche: derives active id + status from durable source', () => {
  const dir = makeTranchesFixture({
    active_tranche_id: '3',
    tranches: [
      { id: '2', status: 'SHIPPED' },
      { id: '3', status: 'IN-FLIGHT' },
    ],
  });
  try {
    assert.deepEqual(liveTranche(dir), { active_id: '3', status: 'IN-FLIGHT' });
  } finally { rm(dir); }
});

test('liveTranche: null when active_tranche_id points at a missing entry', () => {
  const dir = makeTranchesFixture({
    active_tranche_id: '9',
    tranches: [{ id: '1', status: 'SHIPPED' }],
  });
  try { assert.equal(liveTranche(dir), null); } finally { rm(dir); }
});

test('lineOne: renders T<id>:<status> chip from a live tranche object', () => {
  const out = lineOne(pl(20), mkState({ tranche: { active_id: '3', status: 'IN-FLIGHT' } }), '');
  assert.ok(stripAnsi(out).includes('T3:inflight'), `expected T3:inflight in: ${stripAnsi(out)}`);
});

// ── color-blind / accessibility invariant ─────────────────────────

test('accessibility: every emitted chip carries a glyph or label (no color-only signals)', () => {
  const state = mkState({
    bugs: { open: 3 },
    graph: { state: 'stale', dirty_count: 12 },
    review_queue_depth: 5,
    ab_arm: 'B',
    compaction: { compaction_n: 2 },
    rules: { fires_this_turn: 19, mandatory_fires: 4, blocked: 1, deny_red: true },
    reads: { total: 47, redundant_blocked: 2 },
    last_event: { tag: 'PreToolUse:Edit', detail: 'edit X' },
  });
  const plain = stripAnsi(lineOne(pl(75), state, '/x') + '\n' + lineTwo(state));
  // Each meaningful chip token must carry a glyph or label.
  for (const tok of ['sxt', 'ctx', '⚠ bugs', '⚠ graph', '✎ review', 'arm:', 'comp:', 'rules', '↑', '⊘', '⚠deny', 'reads', '↺']) {
    assert.ok(plain.includes(tok), `missing glyph/label token: ${tok}`);
  }
});
