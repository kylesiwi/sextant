// Tests for lean-interventions T3 — the one user-facing `ask`: a write whose
// resolved path is OUTSIDE the project root (and not a temp/dev carve-out or an
// already-approved path) prompts the user. Plus the realpath carve-out helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import postToolUse from '../lib/hooks/postToolUse.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { realpathSafe, isUnderRoot, isCarvedOutPath, turnStatePath, runtimeBase, durableBase } from '../lib/paths.mjs';
import { readJson } from '../lib/io.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

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
  const base = path.join(os.tmpdir(), 'sextant-or-rt-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-or-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function makeCtx(sid) {
  return {
    eventName: 'PreToolUse',
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

function isAsk(result) {
  return Boolean(result && result.hookSpecificOutput
    && result.hookSpecificOutput.permissionDecision === 'ask');
}

// A deterministic path that is OUTSIDE both the project cwd AND every carve-out
// (not under os.tmpdir). preToolUse only evaluates — it never writes here.
function outsidePath() {
  return path.join('/opt', 'sextant-outside-' + crypto.randomUUID(), 'file.ts');
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

test('isUnderRoot: exact + nested + sibling', () => {
  assert.equal(isUnderRoot('/a/b', '/a/b'), true);
  assert.equal(isUnderRoot('/a/b/c', '/a/b'), true);
  assert.equal(isUnderRoot('/a/bc', '/a/b'), false); // prefix but not a path boundary
  assert.equal(isUnderRoot('/x', '/a/b'), false);
});

test('realpathSafe resolves an existing dir and a not-yet-existing file under it', async (t) => {
  const dir = path.join(os.tmpdir(), 'sextant-rp-' + crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const realDir = await realpathSafe(dir);
  assert.equal(typeof realDir, 'string');
  // A new file that does not exist yet still resolves (parent realpath + tail).
  const newFile = path.join(dir, 'sub', 'new.ts');
  const realNew = await realpathSafe(newFile);
  assert.ok(isUnderRoot(realNew, realDir), `${realNew} should resolve under ${realDir}`);
  assert.ok(realNew.endsWith(path.join('sub', 'new.ts')));
});

test('isCarvedOutPath: tmpdir is carved, an /opt path is not', async () => {
  const tmpFile = path.join(os.tmpdir(), 'sextant-carve-' + crypto.randomUUID() + '.ts');
  assert.equal(await isCarvedOutPath(await realpathSafe(tmpFile)), true);
  assert.equal(await isCarvedOutPath(await realpathSafe(outsidePath())), false);
});

// ---------------------------------------------------------------------------
// the ask
// ---------------------------------------------------------------------------

test('outside-root Edit → ask (the one user-facing card)', async (t) => {
  _resetGraphCache();
  await setupRuntime(t);
  const sid = 'or-ask-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: outsidePath(), old_string: 'a', new_string: 'b' },
    },
    makeCtx(sid),
  );
  assert.ok(isAsk(result), `expected ask; got ${JSON.stringify(result)}`);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /OUTSIDE your project/);
});

test('in-project Edit → no ask', async (t) => {
  _resetGraphCache();
  await setupRuntime(t);
  const sid = 'or-inproj-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'src/a.ts'), content: 'x' },
    },
    makeCtx(sid),
  );
  assert.ok(!isAsk(result), `in-project write must not ask; got ${JSON.stringify(result)}`);
});

test('write under a temp carve-out → no ask', async (t) => {
  _resetGraphCache();
  await setupRuntime(t);
  const sid = 'or-tmp-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // A sibling temp path: string-OUTSIDE cwd, but under os.tmpdir() → carved out.
  const tmpTarget = path.join(os.tmpdir(), 'sextant-or-tmpwrite-' + crypto.randomUUID() + '.ts');
  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Write',
      tool_input: { file_path: tmpTarget, content: 'x' },
    },
    makeCtx(sid),
  );
  assert.ok(!isAsk(result), `temp write must not ask; got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// approval set: a successful outside write records, so the re-edit doesn't re-ask
// ---------------------------------------------------------------------------

test('successful outside write records approval → re-edit does NOT re-ask', async (t) => {
  _resetGraphCache();
  await setupRuntime(t);
  const sid = 'or-approve-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);
  const target = outsidePath();

  // 1. First edit asks.
  const ask1 = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: target, old_string: 'a', new_string: 'b' } },
    makeCtx(sid),
  );
  assert.ok(isAsk(ask1), 'first outside edit should ask');

  // 2. PostToolUse on a CONFIRMED success records the approval.
  await postToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'a', new_string: 'b' },
      tool_response: { is_error: false },
    },
    makeCtx(sid),
  );
  const ts = await readJson(turnStatePath(sid, cwd));
  const approved = (ts && ts.outside_root_approved) || [];
  assert.ok(approved.includes(await realpathSafe(target)), `approval set must contain the realpath; got ${JSON.stringify(approved)}`);

  // 3. Re-edit the same path → no re-ask.
  const ask2 = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: target, old_string: 'b', new_string: 'c' } },
    makeCtx(sid),
  );
  assert.ok(!isAsk(ask2), `approved path must not re-ask; got ${JSON.stringify(ask2)}`);
});

test('a FAILED outside write does NOT record approval (next attempt re-asks)', async (t) => {
  _resetGraphCache();
  await setupRuntime(t);
  const sid = 'or-fail-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);
  const target = outsidePath();

  await postToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: target, old_string: 'a', new_string: 'b' },
      tool_response: { is_error: true }, // confirmed error
    },
    makeCtx(sid),
  );
  const ts = await readJson(turnStatePath(sid, cwd)).catch(() => null);
  const approved = (ts && ts.outside_root_approved) || [];
  assert.ok(!approved.includes(await realpathSafe(target)), 'a failed write must not record approval');

  const ask = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: target, old_string: 'a', new_string: 'b' } },
    makeCtx(sid),
  );
  assert.ok(isAsk(ask), 'after a failed write, the path still asks');
});
