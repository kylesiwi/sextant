// test/launch.test.mjs — statusline launcher / render-time version resolver.
//
// Covers statusline/launch.mjs (the stable, version-agnostic launcher that
// settings.json points at) and sessionStart.refreshStatuslineLauncher (which
// installs/refreshes it). The launcher resolves the plugin version active for
// the current project from installed_plugins.json and execs that version's
// statusline/statusline.mjs, degrading to a minimal line on any failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  findSextantEntries,
  pickEntryForCwd,
  resolveTarget,
} from '../statusline/launch.mjs';
import { refreshStatuslineLauncher } from '../lib/hooks/sessionStart.mjs';

const LAUNCHER = fileURLToPath(new URL('../statusline/launch.mjs', import.meta.url));
const DEGRADED = 'sxt · ctx 0%\n● idle · rules 0 · reads 0\n';

function freshDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-launch-' + crypto.randomUUID());
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

// Spawn a launcher file with a controlled HOME + stdin payload; capture stdout.
function runLauncher(launcherPath, { home, payload }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcherPath], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Build a temp HOME with installed_plugins.json + a fake renderer that echoes a
// marker (proving stdin passthrough). Returns { home, installPath, cwd }.
async function seedHome(t, { scopeEntries, cwd }) {
  const home = freshDir(t);
  const installPath = path.join(home, 'cache', 'sextant', '0.11.0');
  // Fake renderer: reads the payload, echoes the cwd back so we can assert
  // the original stdin reached it unmodified.
  await fs.mkdir(path.join(installPath, 'statusline'), { recursive: true });
  await fs.writeFile(
    path.join(installPath, 'statusline', 'statusline.mjs'),
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{let cwd='';try{cwd=JSON.parse(d||'{}').workspace?.current_dir||''}catch{}process.stdout.write('FAKE-RENDER '+cwd+'\\n')});\n",
    'utf8',
  );
  if (scopeEntries) {
    const db = {
      version: 2,
      plugins: {
        'sextant@kylesiwi': scopeEntries.map((e) => ({ installPath, ...e })),
      },
    };
    await fs.mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify(db),
      'utf8',
    );
  }
  return { home, installPath, cwd: cwd || home };
}

// ── findSextantEntries ──────────────────────────────────────────────────────

test('findSextantEntries: extracts sextant entries across marketplaces, ignores others', () => {
  const db = {
    plugins: {
      'sextant@kylesiwi': [{ scope: 'user', installPath: '/a' }],
      'sextant@other': [{ scope: 'project', installPath: '/b', projectPath: '/p' }],
      'vercel@official': [{ scope: 'user', installPath: '/c' }],
      'sextant-extras@x': [{ scope: 'user', installPath: '/d' }], // name !== "sextant"
    },
  };
  const got = findSextantEntries(db).map((e) => e.installPath).sort();
  assert.deepEqual(got, ['/a', '/b']);
});

test('findSextantEntries: tolerates junk shapes', () => {
  assert.deepEqual(findSextantEntries(null), []);
  assert.deepEqual(findSextantEntries({}), []);
  assert.deepEqual(findSextantEntries({ plugins: 'nope' }), []);
  assert.deepEqual(findSextantEntries({ plugins: { 'sextant@m': 'nope' } }), []);
  // entries missing installPath are dropped
  assert.deepEqual(findSextantEntries({ plugins: { 'sextant@m': [{ scope: 'user' }] } }), []);
});

// ── pickEntryForCwd ─────────────────────────────────────────────────────────

test('pickEntryForCwd: project-scoped entry wins when cwd is inside its projectPath', () => {
  const entries = [
    { scope: 'user', installPath: '/u' },
    { scope: 'project', installPath: '/p', projectPath: '/home/user/projects/app' },
  ];
  const got = pickEntryForCwd(entries, '/home/user/projects/app/src');
  assert.equal(got.installPath, '/p');
});

test('pickEntryForCwd: path boundary is exact — sibling prefix does NOT match', () => {
  const entries = [
    { scope: 'user', installPath: '/u' },
    { scope: 'project', installPath: '/p', projectPath: '/foo/bar' },
  ];
  // /foo/bar-old must NOT match projectPath /foo/bar → fall back to user.
  assert.equal(pickEntryForCwd(entries, '/foo/bar-old').installPath, '/u');
  // exact match and child both hit the project entry.
  assert.equal(pickEntryForCwd(entries, '/foo/bar').installPath, '/p');
  assert.equal(pickEntryForCwd(entries, '/foo/bar/x').installPath, '/p');
});

test('pickEntryForCwd: longest (most specific) projectPath wins among matches', () => {
  const entries = [
    { scope: 'project', installPath: '/outer', projectPath: '/a' },
    { scope: 'local', installPath: '/inner', projectPath: '/a/b' },
  ];
  assert.equal(pickEntryForCwd(entries, '/a/b/c').installPath, '/inner');
  assert.equal(pickEntryForCwd(entries, '/a/x').installPath, '/outer');
});

test('pickEntryForCwd: no project match falls back to scope-less, managed over user', () => {
  const entries = [
    { scope: 'user', installPath: '/u' },
    { scope: 'managed', installPath: '/m' },
    { scope: 'project', installPath: '/p', projectPath: '/elsewhere' },
  ];
  assert.equal(pickEntryForCwd(entries, '/home/other').installPath, '/m');
  // without managed, user wins
  assert.equal(
    pickEntryForCwd(entries.filter((e) => e.scope !== 'managed'), '/home/other').installPath,
    '/u',
  );
});

test('pickEntryForCwd: empty / null returns null', () => {
  assert.equal(pickEntryForCwd([], '/x'), null);
  assert.equal(pickEntryForCwd(null, '/x'), null);
  // only a project entry, cwd not inside it, no scope-less fallback → null
  assert.equal(
    pickEntryForCwd([{ installPath: '/p', projectPath: '/elsewhere' }], '/x'),
    null,
  );
});

// ── resolveTarget: self-reference (fork-bomb) guard ─────────────────────────

test('resolveTarget: never returns the launcher\'s own path', async (t) => {
  const home = freshDir(t);
  // Make the DB resolve to a renderer path that IS the launcher itself.
  const selfPath = path.join(home, 'cache', 'sextant', '0.0.0', 'statusline', 'statusline.mjs');
  await fs.mkdir(path.dirname(selfPath), { recursive: true });
  await fs.writeFile(selfPath, '// self', 'utf8');
  const db = {
    plugins: {
      'sextant@m': [{ scope: 'user', installPath: path.join(home, 'cache', 'sextant', '0.0.0') }],
    },
  };
  await fs.mkdir(path.join(home, '.claude', 'plugins'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(db), 'utf8');

  // With selfPath passed, the DB hit equals selfPath → must be rejected → null.
  assert.equal(resolveTarget('/anywhere', home, selfPath), null);
});

// ── end-to-end: spawn the launcher ──────────────────────────────────────────

test('launcher: resolves via installed_plugins.json and passes stdin through', async (t) => {
  const { home, cwd } = await seedHome(t, { scopeEntries: [{ scope: 'user' }] });
  const { out, code } = await runLauncher(LAUNCHER, {
    home,
    payload: { workspace: { current_dir: cwd } },
  });
  assert.equal(code, 0);
  assert.equal(out, `FAKE-RENDER ${cwd}\n`);
});

test('launcher: entry guard is name-agnostic — runs when installed as statusline.mjs', async (t) => {
  const { home, cwd } = await seedHome(t, { scopeEntries: [{ scope: 'user' }] });
  // Install the launcher at the real production path/name and run THAT copy.
  const installed = path.join(home, '.claude', 'sextant', 'statusline.mjs');
  await fs.mkdir(path.dirname(installed), { recursive: true });
  await fs.copyFile(LAUNCHER, installed);
  const { out, code } = await runLauncher(installed, {
    home,
    payload: { workspace: { current_dir: cwd } },
  });
  assert.equal(code, 0);
  // Resolves to the fake renderer (≠ itself, so no recursion) and passes through.
  assert.equal(out, `FAKE-RENDER ${cwd}\n`);
});

test('launcher: project-scope cwd selects the project version', async (t) => {
  const { home } = await seedHome(t, {
    scopeEntries: [{ scope: 'project', projectPath: '/home/user/projects/app' }],
  });
  const { out } = await runLauncher(LAUNCHER, {
    home,
    payload: { workspace: { current_dir: '/home/user/projects/app/lib' } },
  });
  assert.equal(out, 'FAKE-RENDER /home/user/projects/app/lib\n');
});

test('launcher: falls back to the SessionStart pointer when the DB is absent', async (t) => {
  const home = freshDir(t);
  const installPath = path.join(home, 'cache', 'sextant', '0.11.0');
  const renderer = path.join(installPath, 'statusline', 'statusline.mjs');
  await fs.mkdir(path.dirname(renderer), { recursive: true });
  await fs.writeFile(renderer, "process.stdout.write('VIA-POINTER\\n');\n", 'utf8');
  // No installed_plugins.json — only the pointer.
  await fs.mkdir(path.join(home, '.claude', 'sextant'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'sextant', 'statusline-target'), renderer + '\n', 'utf8');

  const { out } = await runLauncher(LAUNCHER, { home, payload: { cwd: '/whatever' } });
  assert.equal(out, 'VIA-POINTER\n');
});

test('launcher: degrades to a minimal line when nothing resolves', async (t) => {
  const home = freshDir(t); // empty — no DB, no pointer
  const { out, code } = await runLauncher(LAUNCHER, { home, payload: { cwd: '/x' } });
  assert.equal(code, 0);
  assert.equal(out, DEGRADED);
});

// ── refreshStatuslineLauncher (sessionStart) ────────────────────────────────

test('refreshStatuslineLauncher: installs launcher + pointer, idempotently', async (t) => {
  const home = freshDir(t);
  // A fake plugin root with the real launcher source + a renderer.
  const pluginRoot = path.join(home, 'plugin');
  await fs.mkdir(path.join(pluginRoot, 'statusline'), { recursive: true });
  const launcherBody = await fs.readFile(LAUNCHER, 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'statusline', 'launch.mjs'), launcherBody, 'utf8');
  await fs.writeFile(path.join(pluginRoot, 'statusline', 'statusline.mjs'), '// renderer', 'utf8');

  await refreshStatuslineLauncher({ pluginRoot, home });

  const dest = path.join(home, '.claude', 'sextant', 'statusline.mjs');
  const ptr = path.join(home, '.claude', 'sextant', 'statusline-target');
  assert.equal(await fs.readFile(dest, 'utf8'), launcherBody);
  assert.equal((await fs.readFile(ptr, 'utf8')).trim(), path.join(pluginRoot, 'statusline', 'statusline.mjs'));

  // Idempotent: a second run with the same root leaves content identical.
  await refreshStatuslineLauncher({ pluginRoot, home });
  assert.equal(await fs.readFile(dest, 'utf8'), launcherBody);
});

test('refreshStatuslineLauncher: repoints to a new plugin version', async (t) => {
  const home = freshDir(t);
  const launcherBody = await fs.readFile(LAUNCHER, 'utf8');
  async function mkRoot(ver) {
    const r = path.join(home, 'plugin', ver);
    await fs.mkdir(path.join(r, 'statusline'), { recursive: true });
    await fs.writeFile(path.join(r, 'statusline', 'launch.mjs'), launcherBody, 'utf8');
    await fs.writeFile(path.join(r, 'statusline', 'statusline.mjs'), '// renderer', 'utf8');
    return r;
  }
  const v1 = await mkRoot('0.10.2');
  await refreshStatuslineLauncher({ pluginRoot: v1, home });
  const ptr = path.join(home, '.claude', 'sextant', 'statusline-target');
  assert.ok((await fs.readFile(ptr, 'utf8')).includes('0.10.2'));

  const v2 = await mkRoot('0.11.0');
  await refreshStatuslineLauncher({ pluginRoot: v2, home });
  assert.ok((await fs.readFile(ptr, 'utf8')).includes('0.11.0'));
});

test('refreshStatuslineLauncher: no-ops when launcher source is missing', async (t) => {
  const home = freshDir(t);
  const pluginRoot = path.join(home, 'plugin'); // no statusline/launch.mjs
  await fs.mkdir(pluginRoot, { recursive: true });
  await refreshStatuslineLauncher({ pluginRoot, home });
  // Nothing written.
  await assert.rejects(fs.readFile(path.join(home, '.claude', 'sextant', 'statusline.mjs'), 'utf8'));
});
