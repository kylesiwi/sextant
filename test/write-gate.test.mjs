// Tests for the [!] write-gate (cerebrum-v2 T4 — replaces the deleted [match:]
// enforcement). On Edit/Write/MultiEdit to a non-cerebrum file, a [kw:…][!]
// safety rule whose keyword terms word-boundary-match the CHANGED HUNK escalates
// to permissionDecision:'ask'. Provisional rules and non-[!] kw rules never gate.
// Every fire is recorded in telemetry (state.rules + rules-fired JSONL).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import { readState } from '../lib/state.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { durableBase, durableFile, runtimeBase, rulesFiredPath } from '../lib/paths.mjs';
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

function isAsk(result) {
  return Boolean(result && result.hookSpecificOutput
    && result.hookSpecificOutput.permissionDecision === 'ask');
}

// ---------------------------------------------------------------------------
// fires on a matching [kw:…][!] rule
// ---------------------------------------------------------------------------

test('write-gate: Edit whose new_string matches a [kw:][!] rule → ask', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-edit-fire-' + crypto.randomUUID().slice(0, 8);
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

  assert.ok(isAsk(result), `expected ask; got ${JSON.stringify(result)}`);
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /safety rule/i);
  assert.match(reason, /Never log raw passwords/);
});

test('write-gate: Write content matching a [kw:][!] rule → ask', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-write-fire-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, ['- 2026-05-12: [kw:sandbox] [!] Sandbox writes fail silently (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'note.md'), content: 'remember the sandbox quirk' },
    },
    makeCtx(sid),
  );
  assert.ok(isAsk(result), `expected ask; got ${JSON.stringify(result)}`);
});

test('write-gate: MultiEdit gates on any joined edit hunk', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-multiedit-' + crypto.randomUUID().slice(0, 8);
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
  assert.ok(isAsk(result), `expected ask on the second edit; got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// does NOT fire — unrelated content, non-[!], provisional
// ---------------------------------------------------------------------------

test('write-gate: unrelated change does NOT gate (no false positive)', async (t) => {
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
  assert.ok(!isAsk(result), `unrelated edit must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate: a [kw:] rule WITHOUT [!] does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-no-bang-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // Non-[!] kw rule: relevant but not a hard safety floor → no escalation.
  await seedCerebrum(cwd, ['- 2026-05-12: [kw:passwords] Prefer a password manager (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );
  assert.ok(!isAsk(result), `non-[!] kw rule must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate: a [provisional] [kw:][!] rule does NOT gate', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-provisional-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // [provisional] normalizes to !review — provisional rules never gate a write.
  await seedCerebrum(cwd, ['- 2026-05-12: [provisional] [kw:passwords] [!] Maybe avoid logging passwords (by: sess-1)']);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );
  assert.ok(!isAsk(result), `provisional rule must not gate; got ${JSON.stringify(result)}`);
});

test('write-gate: empty store → no gating', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-empty-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // No cerebrum.md at all.
  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );
  assert.ok(!isAsk(result), `empty store must not gate; got ${JSON.stringify(result)}`);
});

// ---------------------------------------------------------------------------
// telemetry: a fire bumps state + appends a write-gate-block JSONL entry
// ---------------------------------------------------------------------------

test('write-gate: a fire records telemetry (state.rules + rules-fired JSONL)', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'wg-telemetry-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  await seedCerebrum(cwd, ['- 2026-05-12: [kw:passwords] [!] Never log raw passwords (by: sess-1)']);

  await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/auth.ts'), old_string: 'x', new_string: 'logger.info(passwords)' },
    },
    makeCtx(sid),
  );

  const state = await readState(sid, cwd);
  assert.equal(state.rules.deny_red, true, 'deny_red must flip on a gate fire');
  assert.ok((state.rules.blocked ?? 0) >= 1, 'rules.blocked must increment');

  const jsonl = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
  const entries = jsonl.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fire = entries.find((e) => e.event === 'write-gate-block');
  assert.ok(fire, `expected a write-gate-block JSONL entry; got ${jsonl}`);
  assert.equal(fire.term, 'passwords');
  assert.match(fire.source_file, /cerebrum\.md$/);
});
