// Tests for bin/cli.mjs — the hook dispatcher.
//
// Strategy: spawn `node bin/cli.mjs <Event>` as a child process, feed
// synthetic JSON to stdin, and assert on (a) exit code 0, (b) the runtime
// dir contents, (c) parsed hooks.log entries. This tests the full pipe the
// plugin manifest will exercise — eventToModule resolution, dynamic
// import, error swallowing — exactly as Claude Code will invoke it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hooksLogPath, runtimeBase, runtimeFile, statuslineStatePath } from '../lib/paths.mjs';
import { readState } from '../lib/state.mjs';
import { eventToModule } from '../bin/cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '..', 'bin', 'cli.mjs');

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-test-' + crypto.randomUUID());
}

// Spawn the dispatcher, write JSON to stdin, await exit.
function runDispatcher(eventName, payload, runtimeBaseDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, SEXTANT_RUNTIME_BASE: runtimeBaseDir };
    const child = execFile(
      process.execPath,
      [cliPath, eventName],
      { env, timeout: 10000 },
      (err, stdout, stderr) => {
        resolve({
          // execFile reports a "killed" error if exit != 0; we treat any exit
          // status returned by the child as informational.
          code: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          err,
        });
      },
    );
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

async function readLogLines(sid, base) {
  const file = path.join(base, `sextant-${sid}`, 'hooks.log');
  const raw = await fs.readFile(file, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// -- eventToModule unit tests ----------------------------------------------

test('eventToModule: SessionStart → sessionStart.mjs', () => {
  assert.equal(eventToModule('SessionStart'), 'sessionStart.mjs');
});
test('eventToModule: PreToolUse → preToolUse.mjs', () => {
  assert.equal(eventToModule('PreToolUse'), 'preToolUse.mjs');
});
test('eventToModule: PostToolUseFailure → postToolUseFailure.mjs', () => {
  assert.equal(eventToModule('PostToolUseFailure'), 'postToolUseFailure.mjs');
});
test('eventToModule: UserPromptSubmit → userPromptSubmit.mjs', () => {
  assert.equal(eventToModule('UserPromptSubmit'), 'userPromptSubmit.mjs');
});
test('eventToModule: empty/null returns null', () => {
  assert.equal(eventToModule(''), null);
  assert.equal(eventToModule(null), null);
  assert.equal(eventToModule(undefined), null);
});

// -- end-to-end dispatcher tests -------------------------------------------

test('dispatcher: SessionStart end-to-end (exit 0, log line, state file)', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-ss';
  const payload = {
    session_id: sid,
    cwd: '/some/cwd',
    hook_event_name: 'SessionStart',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  };
  const r = await runDispatcher('SessionStart', payload, base);
  assert.equal(r.code, 0, `expected exit 0, stderr=${r.stderr}`);

  // hooks.log got a line
  const lines = await readLogLines(sid, base);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'SessionStart');

  // statusline-state.json exists with ab_arm
  const stateRaw = await fs.readFile(path.join(base, `sextant-${sid}`, 'statusline-state.json'), 'utf8');
  const state = JSON.parse(stateRaw);
  assert.ok(state.ab_arm === 'A' || state.ab_arm === 'B');
});

test('dispatcher: PreToolUse Read increments reads.total', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-read';
  const payload = {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'PreToolUse',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
    tool_name: 'Read',
    tool_input: { file_path: '/a.ts' },
  };
  const r = await runDispatcher('PreToolUse', payload, base);
  assert.equal(r.code, 0, `stderr=${r.stderr}`);

  const stateRaw = await fs.readFile(
    path.join(base, `sextant-${sid}`, 'statusline-state.json'),
    'utf8',
  );
  const state = JSON.parse(stateRaw);
  assert.equal(state.reads.total, 1);
});

test('dispatcher: PreToolUse Edit does NOT increment reads.total', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-edit';
  const payload = {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'PreToolUse',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
    tool_name: 'Edit',
    tool_input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
  };
  const r = await runDispatcher('PreToolUse', payload, base);
  assert.equal(r.code, 0);

  // PreToolUse for Edit does not touch state — statusline-state.json may not
  // exist yet (no withState was called). Either absence or reads.total=0 is fine.
  try {
    const stateRaw = await fs.readFile(
      path.join(base, `sextant-${sid}`, 'statusline-state.json'),
      'utf8',
    );
    const state = JSON.parse(stateRaw);
    assert.equal(state.reads.total, 0);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File absent → handler correctly didn't mutate state.
  }

  // Log entry still present.
  const lines = await readLogLines(sid, base);
  assert.equal(lines[0].tool, 'Edit');
});

test('dispatcher: PreCompact writes precompact.json + turn-state.json with pending_restore', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-pc';
  const payload = {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'PreCompact',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  };
  const r = await runDispatcher('PreCompact', payload, base);
  assert.equal(r.code, 0, `stderr=${r.stderr}`);

  const pcRaw = await fs.readFile(path.join(base, `sextant-${sid}`, 'precompact.json'), 'utf8');
  const pc = JSON.parse(pcRaw);
  assert.equal(pc.schema_version, 1);
  // Phase 2.5: payload.rules is empty (no rules-fired.jsonl seeded), todos
  // is null (no transcript_path provided). compaction_n stamps the snapshot.
  // Phase 9: files/bugs/commits also present and empty.
  assert.equal(pc.compaction_n, 1);
  assert.deepEqual(pc.payload, { rules: [], todos: null, files: [], bugs: [], commits: [], tranche: null });

  const tsRaw = await fs.readFile(path.join(base, `sextant-${sid}`, 'turn-state.json'), 'utf8');
  const tsObj = JSON.parse(tsRaw);
  assert.equal(tsObj.pending_restore, true);
});

test('dispatcher: Stop resets fires_this_turn after seeding to 5', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-stop';

  // Seed state via withState directly (the same module the handler uses).
  // We do this by setting SEXTANT_RUNTIME_BASE for this test's lifetime and
  // calling withState with that env, but since the dispatcher reads the env
  // in a child process we instead pre-write the state file by hand.
  const dir = path.join(base, `sextant-${sid}`);
  await fs.mkdir(dir, { recursive: true });
  const seedState = {
    version: 1,
    session_id: sid,
    ab_arm: 'A',
    reads: { total: 10, redundant_blocked: 0 },
    rules: { fires_this_turn: 5, mandatory_fires: 0, blocked: 0, deny_red: false },
    bugs: { open: 0 },
    review_queue_depth: 0,
    auto_tag: { high_confidence: 0, low_confidence_review: 0 },
    graph: { state: 'idle', last_rebuild_ts: null, dirty_count: 0 },
    compaction: { last_snapshot_ts: null, last_restore_ts: null, compaction_n: 0 },
    stuck: { tool: null, file: null, count: 0 },
    systemmessage_fired: {},
    last_event: { tag: null, ts: null },
  };
  await fs.writeFile(path.join(dir, 'statusline-state.json'), JSON.stringify(seedState), 'utf8');

  const payload = {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'Stop',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  };
  const r = await runDispatcher('Stop', payload, base);
  assert.equal(r.code, 0, `stderr=${r.stderr}`);

  const stateRaw = await fs.readFile(path.join(dir, 'statusline-state.json'), 'utf8');
  const state = JSON.parse(stateRaw);
  assert.equal(state.rules.fires_this_turn, 0);
  // Cumulative preserved
  assert.equal(state.reads.total, 10);
});

test('dispatcher: malformed JSON on stdin exits 0 and does not crash', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const r = await runDispatcher('SessionStart', 'not json {{{', base);
  assert.equal(r.code, 0);
  // stderr should mention the parse error
  assert.match(r.stderr, /stdin-parse error/);
});

test('dispatcher: unknown event name exits 0', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const r = await runDispatcher('FooBar', { session_id: 'x' }, base);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /unknown event "FooBar"/);
});

test('dispatcher: missing session_id exits 0', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const r = await runDispatcher('SessionStart', { cwd: '/x' }, base);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /missing session_id/);
});

test('dispatcher: empty stdin exits 0 (parse error path)', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const r = await runDispatcher('SessionStart', '', base);
  assert.equal(r.code, 0);
});

test('dispatcher: Notification end-to-end logs and exits 0', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-notif';
  const payload = {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'Notification',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  };
  const r = await runDispatcher('Notification', payload, base);
  assert.equal(r.code, 0);
  const lines = await readLogLines(sid, base);
  assert.equal(lines[0].event, 'Notification');
});

test('dispatcher: SessionEnd resets turn state + logs', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'cli-se';
  // Seed
  const dir = path.join(base, `sextant-${sid}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'statusline-state.json'), JSON.stringify({
    version: 1,
    session_id: sid,
    ab_arm: 'A',
    reads: { total: 99, redundant_blocked: 0 },
    rules: { fires_this_turn: 7, mandatory_fires: 3, blocked: 1, deny_red: true },
    bugs: { open: 2 },
    review_queue_depth: 0,
    auto_tag: { high_confidence: 0, low_confidence_review: 0 },
    graph: { state: 'idle', last_rebuild_ts: null, dirty_count: 0 },
    compaction: { last_snapshot_ts: null, last_restore_ts: null, compaction_n: 0 },
    stuck: { tool: null, file: null, count: 0 },
    systemmessage_fired: { foo: true },
    last_event: { tag: null, ts: null },
  }));

  const r = await runDispatcher('SessionEnd', {
    session_id: sid,
    cwd: '/x',
    hook_event_name: 'SessionEnd',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  }, base);
  assert.equal(r.code, 0);

  const stateRaw = await fs.readFile(path.join(dir, 'statusline-state.json'), 'utf8');
  const state = JSON.parse(stateRaw);
  assert.equal(state.rules.fires_this_turn, 0);
  assert.equal(state.rules.deny_red, false);
  assert.deepEqual(state.systemmessage_fired, {});
  assert.equal(state.reads.total, 99);
  assert.equal(state.bugs.open, 2);
});

test('dispatcher: SessionStart stdout is empty when cwd has no .sextant/ artifacts', async (t) => {
  // Phase 1a: SessionStart returns additionalContext when project.md or a
  // last.json snapshot exists, or systemMessage when the graph is stale.
  // For a synthetic cwd with no .sextant/, the handler should return
  // undefined → empty stdout.
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Use a temp cwd that exists but has no .sextant/ tree.
  const cwd = path.join(base, 'empty-cwd');
  await fs.mkdir(cwd, { recursive: true });

  const sid = 'cli-stdout';
  const r = await runDispatcher('SessionStart', {
    session_id: sid,
    cwd,
    hook_event_name: 'SessionStart',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  }, base);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', `expected empty stdout, got: ${r.stdout}`);
});

test('dispatcher: SessionStart emits additionalContext JSON when project.md exists', async (t) => {
  const base = freshTempBase();
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  // Synthesize a project.md under <cwd>/.sextant/.
  const cwd = path.join(base, 'with-project-md');
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.sextant', 'project.md'), '# Synth\n\nProject text.\n', 'utf8');

  const sid = 'cli-ss-ctx';
  const r = await runDispatcher('SessionStart', {
    session_id: sid,
    cwd,
    hook_event_name: 'SessionStart',
    transcript_path: '',
    permission_mode: 'default',
    effort: { level: 'medium' },
  }, base);
  assert.equal(r.code, 0, `stderr=${r.stderr}`);

  // stdout should be a single JSON envelope.
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /<!-- sextant:session-start -->/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /# Synth/);
});
