// Tests for the Stop/SubagentStop cerebrum format gate (cerebrum-v2 T5.5).
// Drives the real hooks against temp stores. The accepted-hash set (seeded at
// SessionStart) means only SESSION-NEW rules are gated; fail-open at 3 records
// the rule as accepted so it never re-blocks; the counter advances only on
// no-progress; subagents never block.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import stop from '../lib/hooks/stop.mjs';
import subagentStop from '../lib/hooks/subagentStop.mjs';
import sessionStart from '../lib/hooks/sessionStart.mjs';
import { withState, readState } from '../lib/state.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { durableBase, durableFile, runtimeBase } from '../lib/paths.mjs';
import { lineHash } from '../lib/stores/cerebrum.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

const MALFORMED = '- 2026-05-12: [todo] read the plan and capture the outcome here please';
const FIXED     = '- 2026-05-12: [global] read the plan and capture the outcome here please';
const CLEAN     = '- 2026-05-12: [kw:deploy] [!] never deploy on a friday afternoon (by: s)';

function withEnv(t, overrides) {
  const before = {};
  for (const [k, v] of Object.entries(overrides)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
async function setupEnv(t) {
  const base = path.join(os.tmpdir(), 'sextant-sfg-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
}
function makeCtx(sid) {
  return { eventName: 'Stop', runtimeBase, durableBase, log: (e) => appendLog(sid, e, null), nowIso: () => new Date().toISOString() };
}
async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-sfg-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
async function writeStore(cwd, lines) {
  const p = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8');
}
const seedAccepted = (sid, cwd, hashes) => withState(sid, cwd, (s) => { s.cerebrum_accepted_hashes = hashes; });
const isBlock = (r) => Boolean(r && r.decision === 'block');

test('pre-existing malformed rule does NOT block (it is in the SessionStart baseline)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-baseline-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [MALFORMED]);
  await seedAccepted(sid, cwd, [lineHash(MALFORMED)]); // baseline includes it
  const r = await stop({ session_id: sid, cwd }, makeCtx(sid));
  assert.ok(!isBlock(r), `pre-existing rule must not gate; got ${JSON.stringify(r)}`);
});

test('a session-NEW malformed rule blocks at Stop with an actionable reason', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-new-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await seedAccepted(sid, cwd, []);            // empty baseline → the rule is "new"
  await writeStore(cwd, [MALFORMED]);
  const r = await stop({ session_id: sid, cwd }, makeCtx(sid));
  assert.ok(isBlock(r), `expected block; got ${JSON.stringify(r)}`);
  assert.match(r.reason, /mis-formatted/i);
  assert.match(r.reason, /bucket-shaped tag/);
});

test('fixing the rule unblocks and records it as accepted', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-fix-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await seedAccepted(sid, cwd, []);
  await writeStore(cwd, [MALFORMED]);
  assert.ok(isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), 'blocks first');
  await writeStore(cwd, [FIXED]);              // agent fixes it
  const r = await stop({ session_id: sid, cwd }, makeCtx(sid));
  assert.ok(!isBlock(r), `fixed rule must unblock; got ${JSON.stringify(r)}`);
  const st = await readState(sid, cwd);
  assert.ok(st.cerebrum_accepted_hashes.includes(lineHash(FIXED)), 'fixed rule accepted');
  assert.equal(st.cerebrum_format_block_count, 0, 'counter reset after clean');
});

test('fail-open after 3 blocks: lets through + records as accepted (no re-block)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-failopen-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await seedAccepted(sid, cwd, []);
  await writeStore(cwd, [MALFORMED]);          // never fixed
  for (let i = 1; i <= 3; i++) {
    assert.ok(isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), `block #${i}`);
  }
  const r4 = await stop({ session_id: sid, cwd }, makeCtx(sid));
  assert.ok(!isBlock(r4), `4th must fail open; got ${JSON.stringify(r4)}`);
  const st = await readState(sid, cwd);
  assert.ok(st.cerebrum_accepted_hashes.includes(lineHash(MALFORMED)), 'fail-opened rule recorded as accepted');
  // And it stays unblocked next turn.
  assert.ok(!isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), '5th still unblocked');
});

test('no-progress counter: a pure shrink (fixing one of two) does NOT advance the valve', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-progress-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  const A = '- 2026-05-12: [todo] first malformed rule body long enough to pass length';
  const B = '- 2026-05-12: [wip] second malformed rule body long enough to pass length';
  await seedAccepted(sid, cwd, []);
  await writeStore(cwd, [A, B]);
  assert.ok(isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), 'blocks with two');
  let st = await readState(sid, cwd);
  assert.equal(st.cerebrum_format_block_count, 1, 'count=1 after first block');
  // Fix B (pure shrink: failing set goes {A,B} → {A}).
  await writeStore(cwd, [A, '- 2026-05-12: [global] second rule fixed body long enough to pass']);
  assert.ok(isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), 'still blocks (A remains)');
  st = await readState(sid, cwd);
  assert.equal(st.cerebrum_format_block_count, 1, 'count must NOT advance on a pure shrink (progress)');
});

test('self-seed fallback: with no baseline, first Stop seeds + skips (never gates pre-existing)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-selfseed-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [MALFORMED]);          // no accepted-set seeded at all
  const r = await stop({ session_id: sid, cwd }, makeCtx(sid));
  assert.ok(!isBlock(r), `first Stop must self-seed + skip; got ${JSON.stringify(r)}`);
  const st = await readState(sid, cwd);
  assert.ok(st.cerebrum_accepted_hashes.includes(lineHash(MALFORMED)), 'baseline now includes it');
});

test('SubagentStop never blocks, even on a malformed new rule', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-subagent-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await seedAccepted(sid, cwd, []);
  await writeStore(cwd, [MALFORMED]);
  const r = await subagentStop({ session_id: sid, cwd, parent_session_id: 'parent-x' }, makeCtx(sid));
  assert.equal(r, undefined, 'subagentStop must never return a block');
});

test('SessionStart seeds the accepted-hash baseline from the current store', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'sfg-sessionstart-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [CLEAN, MALFORMED]);
  await sessionStart({ session_id: sid, cwd }, makeCtx(sid));
  const st = await readState(sid, cwd);
  assert.ok(Array.isArray(st.cerebrum_accepted_hashes), 'accepted set seeded');
  assert.ok(st.cerebrum_accepted_hashes.includes(lineHash(CLEAN)), 'includes clean rule');
  assert.ok(st.cerebrum_accepted_hashes.includes(lineHash(MALFORMED)), 'includes pre-existing malformed rule (baseline)');
  // Therefore a Stop right after SessionStart does not gate the pre-existing rule.
  assert.ok(!isBlock(await stop({ session_id: sid, cwd }, makeCtx(sid))), 'no block post-SessionStart');
});
