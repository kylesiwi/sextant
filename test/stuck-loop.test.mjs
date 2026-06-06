// Tests for the stuck-loop detector in lib/hooks/postToolUseFailure.mjs.
//
// Spec § 5.10: same (tool, file) failing 3+ consecutive times triggers a
// corrective hint with additionalContext, a one-shot systemMessage, and a
// statusline tag.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { runtimeBase, hooksLogPath } from '../lib/paths.mjs';
import { readState } from '../lib/state.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import postToolUseFailure from '../lib/hooks/postToolUseFailure.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-stuck-' + crypto.randomUUID());
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

async function setupEnv(t, extraEnv = {}) {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base, ...extraEnv });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

function makeCtx(sid) {
  return {
    eventName: 'PostToolUseFailure',
    runtimeBase,
    // SEXTANT_RUNTIME_BASE override; cwd is unused in this test
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

function editPayload(sid, file) {
  return {
    session_id: sid,
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'foo', new_string: 'bar' },
  };
}

function writePayload(sid, file) {
  return {
    session_id: sid,
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'hi' },
  };
}

async function readLogLines(sid) {
  const raw = await fs.readFile(hooksLogPath(sid), 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// -- baseline counting -------------------------------------------------------

test('stuck-loop: first Edit failure → count=1, no trigger', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-first';
  const out = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.equal(out, undefined);
  const s = await readState(sid);
  assert.equal(s.stuck.count, 1);
  assert.equal(s.stuck.tool, 'Edit');
  assert.equal(s.stuck.file, '/work/a.ts');
  assert.equal(s.last_event.tag, null);
});

test('stuck-loop: second Edit failure (same file) → count=2, no trigger', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-second';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const out = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.equal(out, undefined);
  const s = await readState(sid);
  assert.equal(s.stuck.count, 2);
  assert.equal(s.last_event.tag, null);
});

test('stuck-loop: third Edit failure (same file) → triggers nudge', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-third';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const out = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));

  assert.ok(out, 'expected nudge return value');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(out.hookSpecificOutput.additionalContext, /sextant:stuck-loop/);
  assert.match(out.hookSpecificOutput.additionalContext, /Edit on `\/work\/a\.ts`/);
  assert.match(out.hookSpecificOutput.additionalContext, /failed 3 consecutive times/);
  // R13: imperative steps instead of "Consider" suggestions
  assert.match(out.hookSpecificOutput.additionalContext, /1\. Re-read/);
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('Consider'),
    'should not contain vague "Consider" verb');
  assert.match(out.systemMessage, /Edit on \/work\/a\.ts has failed 3 times/);

  const s = await readState(sid);
  assert.equal(s.stuck.count, 3);
  assert.equal(s.last_event.tag, 'stuck:Edit×3');
  assert.ok(s.last_event.ts);
});

// -- reset cases -------------------------------------------------------------

test('stuck-loop: different file resets the counter', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-diff-file';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/b.ts'), makeCtx(sid));
  const s = await readState(sid);
  assert.equal(s.stuck.count, 1);
  assert.equal(s.stuck.file, '/work/b.ts');
  assert.equal(s.last_event.tag, null);
});

test('stuck-loop: different tool on same file resets the counter', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-diff-tool';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(writePayload(sid, '/work/a.ts'), makeCtx(sid));
  const s = await readState(sid);
  assert.equal(s.stuck.count, 1);
  assert.equal(s.stuck.tool, 'Write');
});

// -- suppression -------------------------------------------------------------

test('stuck-loop: 4th consecutive failure does not re-emit systemMessage', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-suppress';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const out3 = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.ok(out3, '3rd should trigger');
  assert.ok(out3.systemMessage, '3rd should emit systemMessage');

  const out4 = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.equal(out4, undefined, '4th should be suppressed');

  const s = await readState(sid);
  assert.equal(s.stuck.count, 4);
  // tag was updated on 4th too (count is now 4).
  assert.equal(s.last_event.tag, 'stuck:Edit×4');
});

test('stuck-loop: re-entering same (tool, file) after a reset re-arms the nudge', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-rearm';
  // Burst 1: fire on file_a x3.
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const out3 = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.ok(out3.systemMessage);

  // Reset via different file, then come back to file_a.
  await postToolUseFailure(editPayload(sid, '/work/b.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const outAgain = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.ok(outAgain, 'second burst on same file should re-fire after a reset');
  assert.ok(outAgain.systemMessage);
});

// -- tool/payload gating -----------------------------------------------------

test('stuck-loop: Bash failure without a parseable file does not count', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-bash-noop';
  // A typical complex command (pipes, multiple args) — should not produce a
  // single-file signature.
  const payload = {
    session_id: sid,
    tool_name: 'Bash',
    tool_input: { command: 'grep -rn foo src | wc -l' },
  };
  await postToolUseFailure(payload, makeCtx(sid));
  await postToolUseFailure(payload, makeCtx(sid));
  const out = await postToolUseFailure(payload, makeCtx(sid));
  assert.equal(out, undefined);
  const s = await readState(sid);
  // Counter never incremented.
  assert.equal(s.stuck.count, 0);
  // Still logged though.
  const lines = await readLogLines(sid);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].event, 'PostToolUseFailure');
});

test('stuck-loop: non-stuckable tool (Glob/Grep) does not count', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-nonstuckable';
  const payload = {
    session_id: sid,
    tool_name: 'Glob',
    tool_input: { pattern: '**/*.ts' },
  };
  await postToolUseFailure(payload, makeCtx(sid));
  await postToolUseFailure(payload, makeCtx(sid));
  await postToolUseFailure(payload, makeCtx(sid));
  const s = await readState(sid);
  assert.equal(s.stuck.count, 0);
  assert.equal(s.last_event.tag, null);
});

// -- env override ------------------------------------------------------------

test('stuck-loop: SEXTANT_STUCK_THRESHOLD=2 fires on the second failure', async (t) => {
  await setupEnv(t, { SEXTANT_STUCK_THRESHOLD: '2' });
  const sid = 'stuck-threshold-2';
  const out1 = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.equal(out1, undefined);
  const out2 = await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  assert.ok(out2, 'should fire at threshold=2');
  assert.match(out2.hookSpecificOutput.additionalContext, /failed 2 consecutive times/);
  const s = await readState(sid);
  assert.equal(s.last_event.tag, 'stuck:Edit×2');
});

// -- logging contract --------------------------------------------------------

test('stuck-loop: log line records tool + file for each call', async (t) => {
  await setupEnv(t);
  const sid = 'stuck-log';
  await postToolUseFailure(editPayload(sid, '/work/a.ts'), makeCtx(sid));
  const lines = await readLogLines(sid);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'PostToolUseFailure');
  assert.equal(lines[0].tool, 'Edit');
  assert.equal(lines[0].file, '/work/a.ts');
});
