// Tests for write-path keyword-rule behavior after the [!] write-gate REMOVAL
// (v0.44.0). The old gate escalated an Edit/Write/MultiEdit to
// permissionDecision:'ask' when a [kw:…][!] rule's keyword word-boundary-matched
// the changed hunk. That gate over-fired (~50% of writes in dogfooding) and its
// reason could never render at the file-tool permission card (CC discards it),
// so it was deleted. These tests pin the replacement contract:
//   - NO write ever produces a permissionDecision (no ask, no deny) on the
//     keyword path — the wall is gone.
//   - A matched [kw:…][!] rule still SURFACES, now as additionalContext (the
//     normal WRITE keyword-injection block), so the agent sees it before its
//     next action.
//   - Provisional rules and non-matching edits still don't surface a kw block.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { durableBase, durableFile, runtimeBase } from '../lib/paths.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-wg-test-' + crypto.randomUUID());
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

function makeCtx(sid) {
  return {
    eventName: 'PreToolUse',
    runtimeBase,
    durableBase,
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-wg-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function seedCerebrum(cwd, lines) {
  await writeFile(durableFile(cwd, path.join('cerebrum', 'cerebrum.md')), lines.join('\n') + '\n');
}

// The whole point of the change: a write NEVER carries a permissionDecision.
function hasPermissionDecision(result) {
  return Boolean(result && result.hookSpecificOutput
    && result.hookSpecificOutput.permissionDecision);
}

function additionalContext(result) {
  return (result && result.hookSpecificOutput
    && typeof result.hookSpecificOutput.additionalContext === 'string')
    ? result.hookSpecificOutput.additionalContext
    : '';
}

// ---------------------------------------------------------------------------
// the wall is gone: a matching [kw:…][!] rule NO LONGER asks/denies
// ---------------------------------------------------------------------------

test('write-gate removed: Edit matching a [kw:][!] rule does NOT ask/deny', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-edit-noask-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, [
    '- 2026-05-12: [kw:passwords] [!] Never log raw passwords (by: sess-1)',
  ]);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );

  assert.ok(!hasPermissionDecision(result),
    `a matching write must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate removed: a matched [kw:][!] rule still SURFACES as additionalContext', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-edit-inject-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, [
    '- 2026-05-12: [kw:passwords] [!] Never log raw passwords (by: sess-1)',
  ]);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );

  assert.ok(!hasPermissionDecision(result), 'still no permission decision');
  assert.match(additionalContext(result), /Never log raw passwords/,
    `the matched rule must inject as context; got ${JSON.stringify(result)}`);
});

test('write-gate removed: Write content matching a [kw:][!] rule does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-write-noask-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, ['- 2026-05-12: [kw:sandbox] [!] Sandbox writes fail silently (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'note.md'), content: 'remember the sandbox quirk' },
    },
    makeCtx(sid),
  );
  assert.ok(!hasPermissionDecision(result), `Write must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate removed: MultiEdit matching a [kw:][!] rule does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-multiedit-noask-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, ['- 2026-05-12: [kw:secret] [!] Never hardcode a secret (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'MultiEdit',
      tool_input: {
        file_path: path.join(cwd, 'c.ts'),
        edits: [{ old_string: 'a', new_string: 'harmless change' }, { old_string: 'b', new_string: 'const secret = 42' }],
      },
    },
    makeCtx(sid),
  );
  assert.ok(!hasPermissionDecision(result), `MultiEdit must not gate; got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// the original over-fire complaint: an ordinary edit whose hunk merely mentions
// a common keyword must not wall — this was the ~50% misfire being removed.
// ---------------------------------------------------------------------------

test('write-gate removed: an ordinary edit mentioning a common keyword does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-overfire-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // The exact dogfooding shape: a [!] rule with common-word keywords.
  await seedCerebrum(cwd, ['- 2026-05-12: [kw:agents, skills, commands] [!] Do not edit ~/.claude install dirs (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/registry.ts'), old_string: 'x', new_string: 'const agents = loadAgents();' },
    },
    makeCtx(sid),
  );
  assert.ok(!hasPermissionDecision(result),
    `an incidental keyword mention must never wall; got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// unrelated / non-[!] / provisional / empty — never a gate (unchanged contract)
// ---------------------------------------------------------------------------

test('write-gate removed: unrelated change does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-noop-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, ['- 2026-05-12: [kw:passwords] [!] Never log raw passwords (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/util.ts'), old_string: 'x', new_string: 'return a + b;' },
    },
    makeCtx(sid),
  );
  assert.ok(!hasPermissionDecision(result), `unrelated edit must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate removed: empty store → no gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-empty-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );
  assert.ok(!hasPermissionDecision(result), `empty store must not gate; got ${JSON.stringify(result)}`);
});
