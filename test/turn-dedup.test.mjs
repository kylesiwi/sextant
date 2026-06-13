// Tests for lean-interventions T5: per-turn fire dedup + stubs.
//
// The first fire of a rule in a turn renders its full body; a later same-turn
// fire collapses to a stub line that still carries the rule text. Layered
// BENEATH keywordDedup — a rule keywordDedup suppressed this turn is absent from
// kwRules and so can never be stubbed (it never references an unshown body).
//
// These drive the REAL preToolUse + userPromptSubmit hooks against temp stores,
// exactly like node-firing.test.mjs. The T1 state-plumbing (per-turn reset,
// compaction clear, absent==empty, concurrency) is covered in turn-state.test.mjs;
// here we test the end-to-end full-vs-stub behavior the hook now produces.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import userPromptSubmit from '../lib/hooks/userPromptSubmit.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { durableBase, durableFile, runtimeBase } from '../lib/paths.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
import { clearPendingRestore } from '../lib/hooks/restore.mjs';
import { withState } from '../lib/state.mjs';
import { readStats } from '../lib/stores/stats.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

function withEnv(t, overrides) {
  const before = {};
  for (const [k, v] of Object.entries(overrides)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
async function setupEnv(t) {
  const base = path.join(os.tmpdir(), 'sextant-td-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
}
function makeCtx(sid, eventName = 'PreToolUse') {
  return { eventName, runtimeBase, durableBase, log: (e) => appendLog(sid, e, null), nowIso: () => new Date().toISOString() };
}
async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-td-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
async function writeStore(cwd, lines) {
  const p = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, [CEREBRUM_V2_HEADER, ...lines].join('\n') + '\n', 'utf8');
}
const ac = (r) => (r && r.hookSpecificOutput && typeof r.hookSpecificOutput.additionalContext === 'string')
  ? r.hookSpecificOutput.additionalContext : '';
const edit = (sid, cwd, rel) => preToolUse(
  { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, rel), old_string: 'a', new_string: 'b' } }, makeCtx(sid));
const grep = (sid, cwd, pattern) => preToolUse(
  { session_id: sid, cwd, tool_name: 'Grep', tool_input: { pattern, path: cwd } }, makeCtx(sid));
const newTurn = (sid, cwd) => userPromptSubmit({ session_id: sid, cwd }, makeCtx(sid, 'UserPromptSubmit'));

const NODE_RULE = '- 2026-05-12: [node:src/a.ts] keep this module tiny and dependency-free';
const STUB_HEADER = /already shown this turn/;
const FULL_HEADER = /rules for this file/;

// ── 1. First fire = full, second same-turn fire = stub ──────────────────────
test('T5: node rule fired twice in one turn → first full, second stub (carrying body)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-twice-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [NODE_RULE]);

  const r1 = ac(await edit(sid, cwd, 'src/a.ts'));
  assert.match(r1, FULL_HEADER, 'first fire renders the full block header');
  assert.match(r1, /keep this module tiny/, 'first fire carries the body');
  assert.doesNotMatch(r1, STUB_HEADER, 'first fire is NOT a stub');

  const r2 = ac(await edit(sid, cwd, 'src/a.ts'));
  assert.match(r2, STUB_HEADER, 'second same-turn fire collapses to a stub');
  assert.match(r2, /keep this module tiny/, 'stub still carries the rule text (self-sufficient)');
  assert.doesNotMatch(r2, FULL_HEADER, 'second fire drops the full block header');
});

// ── 2. Per-turn reset: a new turn re-fires FULL ─────────────────────────────
test('T5: across turns the same rule re-fires FULL (per-turn reset)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-perturn-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [NODE_RULE]);

  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'turn 1: full');
  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), STUB_HEADER, 'turn 1: stub on repeat');
  await newTurn(sid, cwd);
  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'turn 2: full again after reset');
});

// ── 3. Loud rule ([!]) stub carries the FULL body (anchor #6) ───────────────
test('T5: a [!] (loud) rule stub carries the FULL untruncated body', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-loud-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  const longTail = 'CRITICAL_TAIL_TOKEN_AT_THE_VERY_END';
  const body = 'always run the full integration suite and never skip the schema migration safety check or the seed-data backfill before shipping a release because ' + longTail;
  assert.ok(body.length > 140, 'body must exceed the truncation threshold to make the test meaningful');
  await writeStore(cwd, [`- 2026-05-12: [node:src/a.ts][!] ${body}`]);

  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'first fire full');
  const r2 = ac(await edit(sid, cwd, 'src/a.ts'));
  assert.match(r2, STUB_HEADER, 'second fire is a stub');
  assert.match(r2, new RegExp(longTail), 'loud-rule stub must carry the FULL body (no truncation) — anchor #6');
  assert.doesNotMatch(r2, /…/, 'loud-rule stub must not be ellipsis-truncated');
});

// ── 4. Non-loud long rule stub IS truncated ─────────────────────────────────
test('T5: a non-loud long rule stub is truncated with an ellipsis', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-trunc-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  const tail = 'NONLOUD_TAIL_TOKEN_PAST_THE_LIMIT';
  const body = 'prefer dependency injection over module-level singletons across this whole subsystem so tests can stub collaborators cleanly ' + tail;
  assert.ok(body.length > 140);
  await writeStore(cwd, [`- 2026-05-12: [node:src/a.ts] ${body}`]);

  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'first fire full');
  const r2 = ac(await edit(sid, cwd, 'src/a.ts'));
  assert.match(r2, STUB_HEADER, 'second fire stub');
  assert.match(r2, /…/, 'non-loud stub truncates with an ellipsis');
  assert.doesNotMatch(r2, new RegExp(tail), 'the truncated tail must NOT appear in a non-loud stub');
});

// ── 5. keywordDedup-suppressed rule is NOT stubbed (layering, advisor #4) ────
test('T5: a general kw rule keywordDedup suppressed this turn is NOT stubbed', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-layer-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [
    '- 2026-05-12: [kw:zebrafication] general legacy rule about zebrafication',
    '- 2026-05-12: [kw:*octopus][!] critical loud rule about octopus handling',
  ]);
  await newTurn(sid, cwd); // set turn_id so keywordDedup's window math engages

  const c1 = ac(await grep(sid, cwd, 'zebrafication octopus'));
  assert.match(c1, /about zebrafication/, 'call 1: general rule fires full');
  assert.match(c1, /about octopus handling/, 'call 1: critical rule fires full');

  const c2 = ac(await grep(sid, cwd, 'zebrafication octopus'));
  // keywordDedup throttles the general rule (elapsed 0 < window) → absent from
  // kwRules → T5 never sees it → not stubbed, not referenced at all.
  assert.doesNotMatch(c2, /zebrafication/, 'call 2: the suppressed general rule is ABSENT (never stubbed)');
  // the critical rule is never throttled → present, and now a stub.
  assert.match(c2, STUB_HEADER, 'call 2: critical rule collapses to a stub');
  assert.match(c2, /about octopus handling/, 'call 2: critical stub carries its (loud) body');
});

// ── 6. Compaction clears fired_full → next fire is full ─────────────────────
test('T5: compaction clears the fired-full map → the next fire is full again', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-compact-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [NODE_RULE]);

  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'full');
  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), STUB_HEADER, 'stub');
  // Real compaction-clear path (same fn the PreCompact/restore flow calls).
  await clearPendingRestore(sid, '2026-06-13T00:00:00.000Z', cwd);
  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'post-compact fire is full, not a dangling stub');
});

// ── 7. SEXTANT_TURN_DEDUP=off → full every time ─────────────────────────────
test('T5: SEXTANT_TURN_DEDUP=off restores full-every-time behavior', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  withEnv(t, { SEXTANT_TURN_DEDUP: 'off' });
  const sid = 'td-off-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [NODE_RULE]);

  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), FULL_HEADER, 'first full');
  const r2 = ac(await edit(sid, cwd, 'src/a.ts'));
  assert.match(r2, FULL_HEADER, 'kill-switch: second fire is STILL full');
  assert.doesNotMatch(r2, STUB_HEADER, 'kill-switch: no stub when disabled');
});

// ── 8. tokens_not_emitted increments on arm B, untouched on arm A ────────────
test('T5: tokens_not_emitted accrues on the treatment arm (B) only', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-statsB-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  // long non-loud body so the stub genuinely collapses tokens (positive delta).
  const body = 'prefer composition to inheritance throughout this subsystem and keep each adapter behind a narrow port so swaps stay local and cheap to test thoroughly';
  await writeStore(cwd, [`- 2026-05-12: [node:src/a.ts] ${body}`]);
  await withState(sid, cwd, (s) => { s.ab_arm = 'B'; });

  await edit(sid, cwd, 'src/a.ts'); // full (records hash)
  await edit(sid, cwd, 'src/a.ts'); // stub (collapses → tokens_not_emitted++)
  const stats = await readStats(durableBase(cwd));
  assert.ok(stats.tokens_not_emitted > 0, `arm B must accrue tokens_not_emitted; got ${stats.tokens_not_emitted}`);
  // honesty: the standalone counter is NOT folded into net_savings.
  assert.equal(stats.net_savings, (stats.tokens_saved_estimate ?? 0) - (stats.tokens_paid_extra ?? 0),
    'net_savings must exclude tokens_not_emitted');
});

test('T5: control arm (A, default) does not accrue tokens_not_emitted', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'td-statsA-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  const body = 'prefer composition to inheritance throughout this subsystem and keep each adapter behind a narrow port so swaps stay local and cheap to test thoroughly';
  await writeStore(cwd, [`- 2026-05-12: [node:src/a.ts] ${body}`]);
  // Do NOT set ab_arm → defaults to 'A' (control): no ledger writes at all.

  await edit(sid, cwd, 'src/a.ts');
  await edit(sid, cwd, 'src/a.ts');
  const stats = await readStats(durableBase(cwd));
  assert.equal(stats.tokens_not_emitted ?? 0, 0, 'control arm must not touch tokens_not_emitted');
});
