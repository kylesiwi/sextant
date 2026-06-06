// Tests for cerebrum-v2 T5.6: node: rules fire by SCOPE alone, on READ
// (deduped per-turn) and on WRITE (100%, no dedup). Drives the real preToolUse
// + userPromptSubmit hooks against temp stores. The seen-set lives in turn-state
// and is cleared each turn by UserPromptSubmit (same lifetime as injected_nodes).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import preToolUse from '../lib/hooks/preToolUse.mjs';
import userPromptSubmit from '../lib/hooks/userPromptSubmit.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { durableBase, durableFile, runtimeBase, rulesFiredPath } from '../lib/paths.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
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
  const base = path.join(os.tmpdir(), 'sextant-nf-' + crypto.randomUUID());
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
}
function makeCtx(sid, eventName = 'PreToolUse') {
  return { eventName, runtimeBase, durableBase, log: (e) => appendLog(sid, e, null), nowIso: () => new Date().toISOString() };
}
async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-nf-proj-' + crypto.randomUUID());
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
const read = (sid, cwd, rel) => preToolUse(
  { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, rel) } }, makeCtx(sid));
const edit = (sid, cwd, rel) => preToolUse(
  { session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, rel), old_string: 'a', new_string: 'b' } }, makeCtx(sid));
const newTurn = (sid, cwd) => userPromptSubmit({ session_id: sid, cwd }, makeCtx(sid, 'UserPromptSubmit'));

const BARE_NODE = '- 2026-05-12: [node:src/a.ts] keep this module tiny and dependency-free';

test('node: a bare [node:F] rule (no [!]) fires on READ of F', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-read-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  const r = await read(sid, cwd, 'src/a.ts');
  assert.match(ac(r), /keep this module tiny/, `node rule should fire on read; got: ${ac(r)}`);
});

test('node: fires on WRITE (Edit) of F — its own block, 100%', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-write-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  const r = await edit(sid, cwd, 'src/a.ts');
  const out = ac(r);
  assert.match(out, /keep this module tiny/, `node rule must fire on write; got: ${out}`);
  assert.match(out, /sextant:node-rules/, 'node rules render in their own block (not keyword block)');
});

test('node: a node-rule fire on Edit is logged to rules-fired.jsonl as [node:…] (T3-A)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-log-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]); // [node:src/a.ts]
  await edit(sid, cwd, 'src/a.ts');
  const raw = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
  const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(
    entries.some((e) => typeof e.bucket === 'string' && e.bucket.includes('node:src/a.ts')),
    `expected a [node:src/a.ts] entry so the Stop summary counts edit-fired node rules; got ${JSON.stringify(entries.map((e) => e.bucket))}`,
  );
});

test('node: write does NOT fire for a DIFFERENT file (addressed-only)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-write-other-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  const r = await edit(sid, cwd, 'src/b.ts');
  assert.doesNotMatch(ac(r), /keep this module tiny/, 'node rule must not fire on a different file');
});

test('node: globals are NOT re-surfaced on WRITE (only node rules)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-write-noglobal-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE, '- 2026-05-12: [global] run the linter before committing']);
  const r = await edit(sid, cwd, 'src/a.ts');
  const out = ac(r);
  assert.match(out, /keep this module tiny/, 'node rule fires on write');
  assert.doesNotMatch(out, /run the linter before committing/, 'globals must not re-surface on write');
});

test('node READ-dedup: a repeat read in the SAME turn is suppressed', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-dedup-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  const r1 = await read(sid, cwd, 'src/a.ts');
  assert.match(ac(r1), /keep this module tiny/, 'first read fires');
  const r2 = await read(sid, cwd, 'src/a.ts');
  assert.doesNotMatch(ac(r2), /keep this module tiny/, 'second read (same turn) is deduped');
});

test('node READ-dedup is PER-TURN: re-fires after UserPromptSubmit clears the window', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-perturn-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  assert.match(ac(await read(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'fires turn 1');
  assert.doesNotMatch(ac(await read(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'deduped within turn 1');
  await newTurn(sid, cwd);             // new user prompt → fresh window
  assert.match(ac(await read(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'fires again turn 2');
});

test('node WRITE track is independent: write fires even after a read marked it seen', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-indep-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, [BARE_NODE]);
  assert.match(ac(await read(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'read fires + marks seen');
  // write must STILL fire (writes never consult the read-seen set)
  assert.match(ac(await edit(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'write fires despite read-seen');
  // and a repeat read in the same turn is still deduped (write did not reset it)
  assert.doesNotMatch(ac(await read(sid, cwd, 'src/a.ts')), /keep this module tiny/, 'read still deduped (write did not populate read-seen)');
});

test('node: a [provisional][node:F] rule does NOT fire deterministically (read or write)', async (t) => {
  _resetGraphCache(); await setupEnv(t);
  const sid = 'nf-prov-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, ['- 2026-05-12: [provisional] [node:src/a.ts] unreviewed capture about src/a.ts']);
  assert.doesNotMatch(ac(await read(sid, cwd, 'src/a.ts')), /unreviewed capture/, 'provisional must not fire at p1 on read');
  assert.doesNotMatch(ac(await edit(sid, cwd, 'src/a.ts')), /unreviewed capture/, 'provisional must not fire at p1 on write');
});
