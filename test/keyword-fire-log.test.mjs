// T3-A: userPromptSubmit logs prompt-fired keyword rules to rules-fired.jsonl
// (bucket '[!]'), so the Stop turn-summary breakdown counts them. preToolUse
// only logs Read-path fires; this closes the prompt-keyword gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import userPromptSubmit from '../lib/hooks/userPromptSubmit.mjs';
import { durableFile, rulesFiredPath } from '../lib/paths.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

function withRuntime(t) {
  const base = path.join(os.tmpdir(), 'sextant-kwlog-' + crypto.randomUUID());
  const prev = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = base;
  t.after(async () => {
    if (prev === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prev;
    await fs.rm(base, { recursive: true, force: true });
  });
}
async function freshCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-kwlog-proj-' + crypto.randomUUID());
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}
async function writeStore(cwd, lines) {
  const p = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, [CEREBRUM_V2_HEADER, ...lines].join('\n') + '\n', 'utf8');
}
const ctx = () => ({ eventName: 'UserPromptSubmit', nowIso: () => new Date().toISOString(), log: async () => {} });

test('T3-A: a prompt firing keyword rules logs them to rules-fired.jsonl as [!]', async (t) => {
  withRuntime(t);
  const sid = 'kwlog-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, ['- 2026-05-12: [kw:zebra] [!] zebra handling is delicate']);

  await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'how do I handle zebra zebra zebra here' },
    ctx(),
  );

  const raw = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
  const entries = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(entries.length >= 1, `expected ≥1 keyword fire logged; got ${entries.length}`);
  assert.ok(entries.every((e) => e.bucket === '[!]'), 'logged with [!] bucket (→ keyword in Stop breakdown)');
  assert.match(entries[0].body, /zebra handling is delicate/);
});

test('T3-A: a prompt matching no keyword rules writes nothing', async (t) => {
  withRuntime(t);
  const sid = 'kwlog-none-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshCwd(t);
  await writeStore(cwd, ['- 2026-05-12: [kw:zebra] [!] zebra handling is delicate']);

  await userPromptSubmit(
    { session_id: sid, cwd, prompt: 'completely unrelated giraffe topic' },
    ctx(),
  );

  // rules-fired.jsonl should not exist (or be empty) — no keyword matched.
  let exists = true;
  try { await fs.access(rulesFiredPath(sid, cwd)); } catch { exists = false; }
  if (exists) {
    const raw = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
    assert.equal(raw.trim(), '', 'no entries when no keyword rule matched');
  }
});
