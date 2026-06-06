// Tests for the broadened injection surfaces (cerebrum-v2 T4 — spec §13 grid).
//
// The PreToolUse matcher in .claude-plugin/plugin.json now admits Task /
// WebFetch / WebSearch / AskUserQuestion / NotebookEdit / MCP (mcp__.*) — and
// must NOT admit TodoWrite. These surfaces emit [global] (digest-deduped) +
// kw rules matched via the per-tool corpus map. Edit/Write/Grep/Glob keep
// their existing kw-only behavior.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { digestGlobals, GLOBALS_DIGEST_FIELD } from '../lib/hooks/mandatoryGlobals.mjs';
import { readJson, writeJsonAtomic } from '../lib/io.mjs';
import { durableBase, durableFile, runtimeBase, turnStatePath } from '../lib/paths.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

const PLUGIN_JSON = fileURLToPath(new URL('../.claude-plugin/plugin.json', import.meta.url));

// ---------------------------------------------------------------------------
// (1) Matcher config: broadened tools admitted, TodoWrite excluded
// ---------------------------------------------------------------------------

async function preToolUseMatchers() {
  const raw = await fs.readFile(PLUGIN_JSON, 'utf8');
  const cfg = JSON.parse(raw);
  return cfg.hooks.PreToolUse.map((e) => e.matcher).filter(Boolean);
}

// Model Claude Code's full-string matcher semantics: a tool fires a hook entry
// when its name fully matches one of the matcher's alternatives.
function matcherMatches(matcher, toolName) {
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}
function anyMatcherMatches(matchers, toolName) {
  return matchers.some((m) => matcherMatches(m, toolName));
}

test('matcher: broadened AC tools are all admitted by a PreToolUse matcher', async () => {
  const matchers = await preToolUseMatchers();
  for (const tool of ['Task', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'NotebookEdit']) {
    assert.ok(anyMatcherMatches(matchers, tool), `${tool} must be admitted`);
  }
  assert.ok(anyMatcherMatches(matchers, 'mcp__github__create_issue'), 'mcp__* must be admitted');
  assert.ok(anyMatcherMatches(matchers, 'mcp__local__do'), 'any MCP server/tool must be admitted');
});

test('matcher: TodoWrite is NOT admitted by any PreToolUse matcher', async () => {
  const matchers = await preToolUseMatchers();
  assert.ok(!anyMatcherMatches(matchers, 'TodoWrite'), 'TodoWrite must never spawn rule injection');
});

test('matcher: existing surfaces still admitted', async () => {
  const matchers = await preToolUseMatchers();
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'Bash']) {
    assert.ok(anyMatcherMatches(matchers, tool), `${tool} must still be admitted`);
  }
});

// ---------------------------------------------------------------------------
// integration harness (mirrors globals-dedup.test.mjs)
// ---------------------------------------------------------------------------

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
  const base = path.join(os.tmpdir(), 'sextant-bt-test-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base, SEXTANT_GLOBALS_DEDUP: undefined });
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

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-bt-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function seedCerebrum(cwd, lines) {
  const p = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// (2) kw injection on a broadened surface (Task)
// ---------------------------------------------------------------------------

test('Task: a [kw:][!] rule matching the prompt surfaces via additionalContext', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'bt-task-kw-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const body = 'Always run smoke tests after a deploy.';
  await seedCerebrum(cwd, [`- 2026-05-12: [kw:deploy] [!] ${body} (by: sess-1)`]);

  const result = await preToolUse(
    {
      session_id: sid, cwd, tool_name: 'Task',
      tool_input: { description: 'ship it', prompt: 'Please deploy the app to staging', subagent_type: 'general-purpose' },
    },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, `expected injection; got ${JSON.stringify(result)}`);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string' && ctx.includes(body), 'kw rule body must surface on a Task');
});

test('WebSearch: query matching a [kw:][!] rule surfaces the rule', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'bt-websearch-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const body = 'Cite primary sources for security claims.';
  await seedCerebrum(cwd, [`- 2026-05-12: [kw:security] [!] ${body} (by: sess-1)`]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'WebSearch', tool_input: { query: 'latest security advisories node' } },
    makeCtx(sid),
  );
  assert.ok(result && result.hookSpecificOutput, 'expected injection on WebSearch');
  assert.ok(result.hookSpecificOutput.additionalContext.includes(body));
});

// ---------------------------------------------------------------------------
// (3) globals (digest-deduped) on a broadened surface
// ---------------------------------------------------------------------------

test('Task: first call emits [!global] (action-rules block) + persists digest', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'bt-task-global-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Never write to a sandbox-mounted path from inside CC.';
  await seedCerebrum(cwd, [`- 2026-05-12: [!] [!global] ${globalBody}`]);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Task', tool_input: { description: 'x', prompt: 'do a thing' } },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, 'first Task must emit globals');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('<!-- sextant:action-rules -->'), 'must use the action-rules marker (not bash-global)');
  assert.ok(ctx.includes(globalBody), 'global body must appear');

  const ts = await readJson(turnStatePath(sid, cwd));
  assert.ok(ts && ts[GLOBALS_DIGEST_FIELD] && ts[GLOBALS_DIGEST_FIELD].length > 0, 'digest must persist');
});

test('Task: pre-seeded matching digest suppresses globals (shared turn-state)', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'bt-task-dedup-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Bump versions after changes.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await seedCerebrum(cwd, [rawLine]);

  // Pre-seed the digest the same way SessionStart / a prior Read or Bash would.
  const digest = digestGlobals([{ raw: rawLine, body: globalBody, buckets: ['!', '!global'] }]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'WebFetch', tool_input: { url: 'https://x.test', prompt: 'summarize' } },
    makeCtx(sid),
  );
  assert.equal(result, undefined, 'globals already seen this session must be suppressed on the new surface');
});

// ---------------------------------------------------------------------------
// (4) TodoWrite produces no injection even if the hook is invoked directly
// ---------------------------------------------------------------------------

test('TodoWrite: even when invoked, emits no globals and no kw injection', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  const sid = 'bt-todowrite-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // A global is present — Bash/Task would emit it; TodoWrite must not.
  await seedCerebrum(cwd, ['- 2026-05-12: [!] [!global] Some always-on rule.']);

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'do deploy security thing', status: 'pending' }] } },
    makeCtx(sid),
  );
  assert.equal(result, undefined, 'TodoWrite must not surface rules (not in the globals-emitting set; empty corpus)');
});
