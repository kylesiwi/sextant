// T3 E/F/G — lifecycle, compaction & capture-loop systemMessages.
//   E. sessionStart: a one-shot "restored session" line when last.json exists.
//   F. postCompact: "restoration ready" stays routine (verbose-only).
//   G. postToolUse Bash: a fail→pass test "recovery" transition (and steady
//      green stays silent).
// All gated on the output mode (off silences everything).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import sessionStart from '../lib/hooks/sessionStart.mjs';
import postCompact from '../lib/hooks/postCompact.mjs';
import postToolUse from '../lib/hooks/postToolUse.mjs';
import { withState } from '../lib/state.mjs';
import { setOutputMode } from '../lib/config.mjs';
import { lastJsonPath, testRunPendingFlagPath, runtimeBase } from '../lib/paths.mjs';

const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : s);

function freshDir(prefix) {
  const p = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}
function setup(t, mode) {
  const cwd = freshDir('sextant-life-cwd');
  const runtime = freshDir('sextant-life-rt');
  const prevRt = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = runtime;
  t.after(async () => {
    if (prevRt === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prevRt;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(runtime, { recursive: true, force: true });
  });
  const sid = 'life-' + crypto.randomUUID().slice(0, 8);
  return { cwd, sid, mode: mode ? setOutputMode(cwd, mode) : Promise.resolve() };
}
const ctx = (eventName) => ({ eventName, nowIso: () => new Date().toISOString(), log: async () => {} });

async function writeLastJson(cwd, obj) {
  const p = lastJsonPath(cwd);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj), 'utf8');
}

// ---- E: restored-session line ------------------------------------------------

test('E: a present last.json surfaces a restored-session line (quiet)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await writeLastJson(cwd, { ended_at: '2026-06-02T10:00:00.000Z', focus: 'the thing' });
  const r = await sessionStart({ session_id: sid, cwd }, ctx('SessionStart'));
  assert.ok(r && typeof r.systemMessage === 'string', 'a systemMessage is emitted');
  assert.match(stripAnsi(r.systemMessage), /restored session/);
});

test('E: a clean session (no last.json) does not surface a restored line', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  const r = await sessionStart({ session_id: sid, cwd }, ctx('SessionStart'));
  assert.ok(!r || !r.systemMessage || !/restored session/.test(stripAnsi(r.systemMessage)),
    'no restored line without a prior checkpoint');
});

test('E: off mode silences the restored line', async (t) => {
  const { cwd, sid, mode } = setup(t, 'off');
  await mode;
  await writeLastJson(cwd, { ended_at: '2026-06-02T10:00:00.000Z' });
  const r = await sessionStart({ session_id: sid, cwd }, ctx('SessionStart'));
  assert.ok(!r || !r.systemMessage || !/restored session/.test(stripAnsi(r.systemMessage)),
    'off mode emits no restored line');
});

// ---- F: postCompact restoration-ready is routine -----------------------------

test('F: postCompact restoration line shows under verbose', async (t) => {
  const { cwd, sid, mode } = setup(t, 'verbose');
  await mode;
  const r = await postCompact({ session_id: sid, cwd }, ctx('PostCompact'));
  assert.ok(r && typeof r.systemMessage === 'string', 'verbose shows the routine line');
  assert.match(stripAnsi(r.systemMessage), /restoration ready/);
});

test('F: postCompact restoration line is silent under quiet (routine)', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  const r = await postCompact({ session_id: sid, cwd }, ctx('PostCompact'));
  assert.ok(!r || !r.systemMessage, 'routine line is verbose-only — quiet stays silent');
});

// ---- G: test fail→pass recovery transition -----------------------------------

async function armTestFlag(sid, cwd) {
  await fs.mkdir(runtimeBase(sid, cwd), { recursive: true });
  await fs.writeFile(testRunPendingFlagPath(sid, cwd), '1', 'utf8');
}
const bashTest = (sid, cwd, tool_response) => postToolUse(
  { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response },
  ctx('PostToolUse'));

test('G: a passing run after a failing one emits a recovery transition', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await armTestFlag(sid, cwd);
  await bashTest(sid, cwd, { exit_code: 1, stdout: '# fail 1' }); // fail → marks failing
  await armTestFlag(sid, cwd);
  const r = await bashTest(sid, cwd, { exit_code: 0, stdout: '# pass 1' }); // pass → recovery
  assert.ok(r && typeof r.systemMessage === 'string', 'recovery message emitted on the flip');
  assert.match(stripAnsi(r.systemMessage), /passing again/);
});

test('G: a steady-green run emits no recovery line', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await armTestFlag(sid, cwd);
  const r = await bashTest(sid, cwd, { exit_code: 0, stdout: '# pass 1' });
  assert.ok(!r || !r.systemMessage || !/passing again/.test(stripAnsi(r.systemMessage)),
    'no flip → no recovery line');
});

test('G: the test-fail nudge still fires on a failing run', async (t) => {
  const { cwd, sid, mode } = setup(t, 'quiet');
  await mode;
  await armTestFlag(sid, cwd);
  const r = await bashTest(sid, cwd, { exit_code: 1, stdout: '# fail 1' });
  assert.ok(r && typeof r.systemMessage === 'string', 'fail nudge emitted');
  assert.match(stripAnsi(r.systemMessage), /test run failed/);
});
