// test/ledger-probe.test.mjs — recordLedgerProbe (the trust-on-first-use ledger
// seed written to user scope by the SessionStart hook). The key property is
// write-once `created_*`, so that after a plugin update the ledger still names
// the version that FIRST wrote it — which is how we prove user-scope durability.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { recordLedgerProbe } from '../lib/hooks/sessionStart.mjs';

async function mkPluginRoot(version) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-plugin-'));
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'sextant', version }),
  );
  return root;
}

async function readLedger(home) {
  const raw = await fs.readFile(path.join(home, '.claude', 'sextant', 'ledger-probe.json'), 'utf8');
  return JSON.parse(raw);
}

test('first run creates the ledger stamped with the current version + project', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-home-'));
  const root = await mkPluginRoot('0.39.0');
  const cwd = '/home/u/proj-a';

  await recordLedgerProbe({ pluginRoot: root, cwd, home, now: 't1' });

  const l = await readLedger(home);
  assert.equal(l.created_by_version, '0.39.0');
  assert.equal(l.created_ts, 't1');
  assert.equal(l.last_seen_by_version, '0.39.0');
  assert.equal(l.session_count, 1);
  assert.equal(l.projects[cwd].first_seen_version, '0.39.0');
  assert.equal(l.projects[cwd].first_seen_ts, 't1');
});

test('a later version updates last_seen but NOT created_* (write-once survival proof)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-home-'));
  const cwd = '/home/u/proj-a';

  const v1 = await mkPluginRoot('0.39.0');
  await recordLedgerProbe({ pluginRoot: v1, cwd, home, now: 't1' });

  // Simulate the next release writing into the SAME durable file.
  const v2 = await mkPluginRoot('0.40.0');
  await recordLedgerProbe({ pluginRoot: v2, cwd, home, now: 't2' });

  const l = await readLedger(home);
  assert.equal(l.created_by_version, '0.39.0', 'created_by_version frozen at first writer');
  assert.equal(l.created_ts, 't1', 'created_ts frozen');
  assert.equal(l.last_seen_by_version, '0.40.0', 'last_seen advances');
  assert.equal(l.last_seen_ts, 't2');
  assert.equal(l.session_count, 2);
  assert.equal(l.projects[cwd].first_seen_version, '0.39.0', 'project first_seen frozen');
  assert.equal(l.projects[cwd].last_seen_version, '0.40.0');
});

test('a second project is recorded distinctly', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-home-'));
  const root = await mkPluginRoot('0.39.0');

  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-a', home, now: 't1' });
  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-b', home, now: 't2' });

  const l = await readLedger(home);
  assert.deepEqual(Object.keys(l.projects).sort(), ['/home/u/proj-a', '/home/u/proj-b']);
  assert.equal(l.session_count, 2);
});

test('best-effort: missing pluginRoot/home is a silent no-op (never throws)', async () => {
  await assert.doesNotReject(() => recordLedgerProbe({ cwd: '/x' }));
  await assert.doesNotReject(() => recordLedgerProbe({ pluginRoot: '/nope', home: '', cwd: '/x' }));
});

test('corrupt existing ledger is replaced, not fatal', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-home-'));
  const root = await mkPluginRoot('0.39.0');
  const dir = path.join(home, '.claude', 'sextant');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'ledger-probe.json'), 'not json {{{');

  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-a', home, now: 't1' });

  const l = await readLedger(home);
  assert.equal(l.created_by_version, '0.39.0');
  assert.equal(l.session_count, 1);
});
