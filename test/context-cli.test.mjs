// test/context-cli.test.mjs — Phase 9 /sextant:project-context CLI.
//
// Backs bin/context.mjs. Two coverage tracks:
//   1. In-process unit coverage of the collectors (collectRecentFiles,
//      collectOpenBugs, collectRecentCommits, collectMandatoryRules) and
//      parseArgs.
//   2. Subprocess CLI invocation with synthetic .sextant/ + runtime trees,
//      asserting on stdout (text + --json) and exit codes.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  collectRecentFiles,
  collectOpenBugs,
  collectRecentCommits,
  collectMandatoryRules,
  detectLatestSessionId,
} from '../bin/context.mjs';
import { writeJsonAtomic } from '../lib/io.mjs';
import { editsPath, durableBase } from '../lib/paths.mjs';
import { commitsDir } from '../lib/capture/commit-snapshot.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'context.mjs');

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-ctx-' + crypto.randomUUID());
}

async function freshProjectRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-ctx-proj-' + crypto.randomUUID());
  await fs.mkdir(path.join(root, '.sextant'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
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

function runCli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---- unit: parseArgs ------------------------------------------------------

test('parseArgs: collects all flags', () => {
  const r = parseArgs(['--root', '/p', '--sid', 'sX', '--json']);
  assert.equal(r.root, '/p');
  assert.equal(r.sid, 'sX');
  assert.equal(r.json, true);
  assert.equal(r.help, false);
});

test('parseArgs: --help short form', () => {
  const r = parseArgs(['-h']);
  assert.equal(r.help, true);
});

// ---- unit: collectors -----------------------------------------------------

test('collectRecentFiles: returns [] when sid is null', async () => {
  const out = await collectRecentFiles(null);
  assert.deepEqual(out, []);
});

test('collectRecentFiles: returns [] when edits.json missing', async (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const out = await collectRecentFiles('sid-X');
  assert.deepEqual(out, []);
});

test('collectRecentFiles: dedups by path and caps at 5 newest-first', async (t) => {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const sid = 'collect-sid';
  await writeJsonAtomic(editsPath(sid), [
    { path: 'src/a.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' },
    { path: 'src/b.ts', ts: '2026-05-11T10:01:00Z', kind: 'Write' },
    { path: 'src/c.ts', ts: '2026-05-11T10:02:00Z', kind: 'Edit' },
    { path: 'src/d.ts', ts: '2026-05-11T10:03:00Z', kind: 'Edit' },
    { path: 'src/e.ts', ts: '2026-05-11T10:04:00Z', kind: 'Edit' },
    { path: 'src/a.ts', ts: '2026-05-11T10:05:00Z', kind: 'Edit' },
    { path: 'src/f.ts', ts: '2026-05-11T10:06:00Z', kind: 'Edit' },
  ]);

  const out = await collectRecentFiles(sid);
  assert.equal(out.length, 5);
  const paths = out.map((f) => f.path);
  assert.deepEqual(paths, ['src/f.ts', 'src/a.ts', 'src/e.ts', 'src/d.ts', 'src/c.ts']);
});

test('collectOpenBugs: filters !fix_verified and (optionally) by session', async (t) => {
  const root = await freshProjectRoot(t);
  await writeJsonAtomic(path.join(durableBase(root), 'bugs.json'), [
    { id: 'bug-1', session_id: 's1', fix_verified: false, file: 'a.ts', error_message: 'e1' },
    { id: 'bug-2', session_id: 's1', fix_verified: true,  file: 'b.ts', error_message: 'e2' },
    { id: 'bug-3', session_id: 's2', fix_verified: false, file: 'c.ts', error_message: 'e3' },
  ]);
  // No session → all open.
  const all = await collectOpenBugs(root, null);
  assert.equal(all.length, 2);
  // s1 only.
  const s1 = await collectOpenBugs(root, 's1');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].id, 'bug-1');
});

test('collectOpenBugs: returns [] when bugs.json missing', async (t) => {
  const root = await freshProjectRoot(t);
  const out = await collectOpenBugs(root, 's1');
  assert.deepEqual(out, []);
});

test('collectRecentCommits: returns [] when sid null', async () => {
  const out = await collectRecentCommits('/nonexistent', null);
  assert.deepEqual(out, []);
});

test('collectRecentCommits: returns [] when commits dir missing', async (t) => {
  const root = await freshProjectRoot(t);
  const out = await collectRecentCommits(root, 'sid-X');
  assert.deepEqual(out, []);
});

test('collectRecentCommits: returns 3 most-recent by mtime', async (t) => {
  const root = await freshProjectRoot(t);
  const sid = 'commit-sid';
  const dir = commitsDir(root, sid);
  await fs.mkdir(dir, { recursive: true });

  async function snapshot(name, ts, edits) {
    await writeJsonAtomic(path.join(dir, `${name}.json`), { ts, session_id: sid, edits });
    await new Promise((r) => setTimeout(r, 10));
  }
  await snapshot('c1', '2026-05-11T10:00:00Z', [{ path: 'a.ts', ts: 't', kind: 'Edit' }]);
  await snapshot('c2', '2026-05-11T10:01:00Z', [{ path: 'b.ts', ts: 't', kind: 'Edit' }]);
  await snapshot('c3', '2026-05-11T10:02:00Z', [{ path: 'c.ts', ts: 't', kind: 'Edit' }]);
  await snapshot('c4', '2026-05-11T10:03:00Z', [{ path: 'd.ts', ts: 't', kind: 'Edit' }]);
  await snapshot('c5', '2026-05-11T10:04:00Z', [{ path: 'e.ts', ts: 't', kind: 'Edit' }]);

  const out = await collectRecentCommits(root, sid);
  assert.equal(out.length, 3);
  // Newest first
  assert.equal(out[0].ts, '2026-05-11T10:04:00Z');
  assert.equal(out[1].ts, '2026-05-11T10:03:00Z');
  assert.equal(out[2].ts, '2026-05-11T10:02:00Z');
});

test('collectMandatoryRules: returns the deterministic (node/global) rules from cerebrum.md', async (t) => {
  const root = await freshProjectRoot(t);
  const cerebDir = path.join(durableBase(root), 'cerebrum');
  await fs.mkdir(cerebDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebDir, 'cerebrum.md'),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [global] always run prettier (by: sess-1)',
      '- 2026-05-10: [node:src/auth.ts] Reads from env.JWT_SECRET (by: sess-2)',
      '- 2026-05-10: [kw:deploy] never deploy on friday (by: sess-3)',
      'some non-rule line',
      '',
    ].join('\n'),
    'utf8',
  );
  const out = await collectMandatoryRules(root);
  // node + global are deterministic and surfaced; the [kw:] rule is the ranked
  // tier and is excluded; the non-rule line is ignored.
  assert.equal(out.length, 2);
  assert.equal(out[0].body, 'always run prettier');
  assert.equal(out[0].bySession, 'sess-1');
  assert.ok(out[0].buckets.includes('!global'));
  assert.equal(out[1].body, 'Reads from env.JWT_SECRET');
  assert.ok(!out.some((r) => r.body.includes('never deploy')), 'kw rule excluded');
});

test('collectMandatoryRules: missing file returns []', async (t) => {
  const root = await freshProjectRoot(t);
  const out = await collectMandatoryRules(root);
  assert.deepEqual(out, []);
});

test('detectLatestSessionId: returns null when runtime base empty', async (t) => {
  const base = freshTempBase();
  await fs.mkdir(base, { recursive: true });
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sid = await detectLatestSessionId();
  assert.equal(sid, null);
});

test('detectLatestSessionId: picks most-recent sextant-* dir', async (t) => {
  const base = freshTempBase();
  await fs.mkdir(base, { recursive: true });
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(base, 'sextant-old'), { recursive: true });
  await new Promise((r) => setTimeout(r, 20));
  await fs.mkdir(path.join(base, 'sextant-newer'), { recursive: true });

  const sid = await detectLatestSessionId();
  assert.equal(sid, 'newer');
});

// ---- CLI subprocess --------------------------------------------------------

test('CLI: --help prints usage', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: context/);
});

test('CLI: empty project root → all sections show "(none)"', async (t) => {
  const root = await freshProjectRoot(t);
  // Empty runtime base so no session is detected.
  const rtBase = freshTempBase();
  await fs.mkdir(rtBase, { recursive: true });
  t.after(() => fs.rm(rtBase, { recursive: true, force: true }));

  const r = runCli(['--root', root], { SEXTANT_RUNTIME_BASE: rtBase });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /## Recent files/);
  assert.match(r.stdout, /## Open bugs/);
  assert.match(r.stdout, /## Recent commits/);
  assert.match(r.stdout, /## Mandatory rules/);
  // Each section reports "(none)".
  const noneCount = (r.stdout.match(/\(none\)/g) ?? []).length;
  assert.equal(noneCount, 4, `expected 4 "(none)" markers, got ${noneCount}`);
});

test('CLI: surfaces all 4 sections with --sid', async (t) => {
  const root = await freshProjectRoot(t);
  const rtBase = freshTempBase();
  await fs.mkdir(rtBase, { recursive: true });
  t.after(() => fs.rm(rtBase, { recursive: true, force: true }));
  const sid = 'ctx-cli-1';

  // Seed cerebrum rules.
  const cerebDir = path.join(durableBase(root), 'cerebrum');
  await fs.mkdir(cerebDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebDir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n- 2026-05-10: [global] Always run prettier (by: sess-1)\n`,
    'utf8',
  );

  // Seed bugs.
  await writeJsonAtomic(path.join(durableBase(root), 'bugs.json'), [
    { id: 'bug-1', session_id: sid, fix_verified: false, file: 'src/auth.ts',
      error_message: 'TypeError: undefined property' },
  ]);

  // Seed edits.json (runtime side).
  const sessionDir = path.join(rtBase, `sextant-${sid}`);
  await fs.mkdir(sessionDir, { recursive: true });
  await writeJsonAtomic(path.join(sessionDir, 'edits.json'), [
    { path: 'src/api/auth.ts', ts: new Date(Date.now() - 60_000).toISOString(), kind: 'Edit' },
  ]);

  // Seed a commit snapshot.
  const cDir = commitsDir(root, sid);
  await fs.mkdir(cDir, { recursive: true });
  await writeJsonAtomic(path.join(cDir, 'snap-1.json'), {
    ts: '2026-05-11T10:00:00Z',
    session_id: sid,
    edits: [{ path: 'src/auth.ts', ts: 't', kind: 'Edit' }],
  });

  const r = runCli(['--root', root, '--sid', sid], { SEXTANT_RUNTIME_BASE: rtBase });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  // Recent files contains the edit.
  assert.match(r.stdout, /src\/api\/auth\.ts/);
  // Open bugs contains bug-1.
  assert.match(r.stdout, /bug-1 \[src\/auth\.ts\] TypeError/);
  // Recent commits row.
  assert.match(r.stdout, /2026-05-11T10:00:00Z: 1 edits across 1 files/);
  // Mandatory rule (labeled by scope, no spurious [!]).
  assert.match(r.stdout, /\[!global\] Always run prettier/);
});

test('CLI: --json emits a JSON object', async (t) => {
  const root = await freshProjectRoot(t);
  const rtBase = freshTempBase();
  await fs.mkdir(rtBase, { recursive: true });
  t.after(() => fs.rm(rtBase, { recursive: true, force: true }));
  const sid = 'ctx-cli-json';

  // Mandatory rule + an edit so we have non-trivial data.
  const cerebDir = path.join(durableBase(root), 'cerebrum');
  await fs.mkdir(cerebDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebDir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n- 2026-05-10: [global] g (by: s)\n`,
    'utf8',
  );
  const sessionDir = path.join(rtBase, `sextant-${sid}`);
  await fs.mkdir(sessionDir, { recursive: true });
  await writeJsonAtomic(path.join(sessionDir, 'edits.json'), [
    { path: 'x.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' },
  ]);

  const r = runCli(['--root', root, '--sid', sid, '--json'], { SEXTANT_RUNTIME_BASE: rtBase });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.sid, sid);
  assert.equal(parsed.root, root);
  assert.equal(parsed.recent_files.length, 1);
  assert.equal(parsed.recent_files[0].path, 'x.ts');
  assert.equal(parsed.mandatory_rules.length, 1);
});

test('CLI: auto-detects session id when --sid omitted', async (t) => {
  const root = await freshProjectRoot(t);
  const rtBase = freshTempBase();
  await fs.mkdir(rtBase, { recursive: true });
  t.after(() => fs.rm(rtBase, { recursive: true, force: true }));
  const sid = 'auto-sid';

  // Single session dir under rtBase + a recorded edit.
  const sessionDir = path.join(rtBase, `sextant-${sid}`);
  await fs.mkdir(sessionDir, { recursive: true });
  await writeJsonAtomic(path.join(sessionDir, 'edits.json'), [
    { path: 'auto.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' },
  ]);

  const r = runCli(['--root', root, '--json'], { SEXTANT_RUNTIME_BASE: rtBase });
  assert.equal(r.code, 0, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.sid, sid);
  assert.equal(parsed.recent_files[0].path, 'auto.ts');
});

test('CLI: still prints mandatory rules when no session is resolvable', async (t) => {
  const root = await freshProjectRoot(t);
  const rtBase = freshTempBase();
  await fs.mkdir(rtBase, { recursive: true });
  t.after(() => fs.rm(rtBase, { recursive: true, force: true }));

  // Mandatory rule but no runtime sessions.
  const cerebDir = path.join(durableBase(root), 'cerebrum');
  await fs.mkdir(cerebDir, { recursive: true });
  await fs.writeFile(
    path.join(cerebDir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n- 2026-05-10: [global] durable rule survives (by: s)\n`,
    'utf8',
  );

  const r = runCli(['--root', root], { SEXTANT_RUNTIME_BASE: rtBase });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /durable rule survives/);
});

// File-existence sanity: the CLI script is the one that the SKILL.md
// references via $CLAUDE_PLUGIN_ROOT/bin/context.mjs.
test('CLI file is present at the expected path', () => {
  assert.ok(fsSync.existsSync(CLI), `expected CLI at ${CLI}`);
});
