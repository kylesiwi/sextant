// T3-B: postToolUse:Bash logs rule-authoring events to rules-authored.jsonl
// (one entry per appended rule). Detection is by the cerebrum CLI's stdout
// confirmation `Appended to cerebrum.md:` — NOT the command text, which
// false-positives on any Bash call that merely mentions "cerebrum remember"
// (a commit message, a `tranches amend --text`, an echo). The Stop turn-summary
// counts this-turn entries to report the authored-rule line.

const APPENDED = (body) => `Appended to cerebrum.md: - 2026-06-03: [global] ${body}`;

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import postToolUse from '../lib/hooks/postToolUse.mjs';
import { rulesAuthoredPath } from '../lib/paths.mjs';

function withRuntime(t) {
  const base = path.join(os.tmpdir(), 'sextant-authlog-' + crypto.randomUUID());
  const prev = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = base;
  t.after(async () => {
    if (prev === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prev;
    await fs.rm(base, { recursive: true, force: true });
  });
}
async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-authlog-proj-' + crypto.randomUUID());
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
const ctx = () => ({ eventName: 'PostToolUse', nowIso: () => new Date().toISOString(), log: async () => {} });
const bash = (sid, cwd, command, tool_response) => postToolUse(
  { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command }, tool_response }, ctx());

async function readAuthored(sid, cwd) {
  try {
    const raw = await fs.readFile(rulesAuthoredPath(sid, cwd), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('T3-B: a successful remember (append confirmation in stdout) logs one entry', async (t) => {
  withRuntime(t);
  const sid = 'authlog-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await bash(sid, cwd,
    `node bin/cerebrum.mjs remember --root "$PWD" --global --text-stdin`,
    { exit_code: 0, stdout: APPENDED('run the linter before committing') });
  const entries = await readAuthored(sid, cwd);
  assert.equal(entries.length, 1, 'one authored entry logged');
  assert.ok(typeof entries[0].ts === 'string', 'entry carries a ts');
});

test('T3-B: a FAILED remember (no confirmation line) is not counted', async (t) => {
  withRuntime(t);
  const sid = 'authlog-fail-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await bash(sid, cwd,
    `node bin/cerebrum.mjs remember --root "$PWD" --global --text-stdin`,
    { exit_code: 1, stderr: 'cerebrum remember: malformed rule rejected' });
  assert.equal((await readAuthored(sid, cwd)).length, 0, 'rejected remember authors nothing');
});

test('T3-B: a command that only MENTIONS "cerebrum remember" is not counted (regression)', async (t) => {
  withRuntime(t);
  const sid = 'authlog-mention-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  // The real bug: a git commit whose MESSAGE contains the phrase, and a
  // `tranches amend --text` describing the mechanism — both matched the old
  // command-string regex and logged phantom authorings. Neither prints the CLI
  // confirmation, so neither counts now.
  await bash(sid, cwd,
    `git commit -F - <<'EOF'\nfeat: count genuine cerebrum remember events\nEOF`,
    { exit_code: 0, stdout: '[main abc1234] feat: count genuine cerebrum remember events\n 1 file changed' });
  await bash(sid, cwd,
    `node bin/tranches.mjs amend --text "logged on each 'cerebrum remember'"`,
    { exit_code: 0, stdout: 'Amendment recorded.' });
  assert.equal((await readAuthored(sid, cwd)).length, 0,
    'mentioning the phrase must not log an authored rule');
});

test('T3-B: promote / unrelated Bash do NOT log an authored entry', async (t) => {
  withRuntime(t);
  const sid = 'authlog-other-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await bash(sid, cwd, `node bin/cerebrum.mjs promote --line-hash abc123`, { exit_code: 0, stdout: 'Promoted rule.' });
  await bash(sid, cwd, `ls -la`, { exit_code: 0, stdout: 'total 8' });
  assert.equal((await readAuthored(sid, cwd)).length, 0, 'only an actual append counts');
});

test('T3-B: two appends in one Bash call log two entries', async (t) => {
  withRuntime(t);
  const sid = 'authlog-two-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await bash(sid, cwd,
    `node bin/cerebrum.mjs remember ... && node bin/cerebrum.mjs remember ...`,
    { exit_code: 0, stdout: APPENDED('rule one') + '\n' + APPENDED('rule two') });
  assert.equal((await readAuthored(sid, cwd)).length, 2, 'one entry per appended rule');
});
