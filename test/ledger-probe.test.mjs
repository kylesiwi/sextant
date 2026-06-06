// test/ledger-probe.test.mjs — recordLedgerProbe (the trust-on-first-use ledger
// seed the SessionStart hook writes to user scope) + userBase resolution.
//
// HERMETIC: every test points the ledger at a throwaway dir via SEXTANT_USER_BASE
// so it can NEVER touch the real ~/.claude. (An earlier version of this test let
// a call fall through to the real $HOME and polluted the live ledger — userBase()
// + this isolation are the fix.)
//
// The key behavioural property is write-once `created_*`: after a plugin update
// the ledger still names the version that FIRST wrote it, which is how the marker
// proves a hook-written file survives an update.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { recordLedgerProbe } from '../lib/hooks/sessionStart.mjs';
import { userBase } from '../lib/paths.mjs';

async function mkPluginRoot(version) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-plugin-'));
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'sextant', version }),
  );
  return root;
}

// Redirect the ledger to a fresh temp dir for the duration of one test, and
// guarantee no real-home write by also clearing SEXTANT_RUNTIME_BASE.
async function isolatedUserBase(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sxt-userbase-'));
  const prevU = process.env.SEXTANT_USER_BASE;
  const prevR = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_USER_BASE = dir;
  delete process.env.SEXTANT_RUNTIME_BASE;
  t.after(async () => {
    if (prevU === undefined) delete process.env.SEXTANT_USER_BASE;
    else process.env.SEXTANT_USER_BASE = prevU;
    if (prevR === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prevR;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const readLedger = async (dir) =>
  JSON.parse(await fs.readFile(path.join(dir, 'ledger-probe.json'), 'utf8'));

test('userBase precedence: SEXTANT_USER_BASE > SEXTANT_RUNTIME_BASE > home', (t) => {
  const prevU = process.env.SEXTANT_USER_BASE;
  const prevR = process.env.SEXTANT_RUNTIME_BASE;
  t.after(() => {
    if (prevU === undefined) delete process.env.SEXTANT_USER_BASE; else process.env.SEXTANT_USER_BASE = prevU;
    if (prevR === undefined) delete process.env.SEXTANT_RUNTIME_BASE; else process.env.SEXTANT_RUNTIME_BASE = prevR;
  });
  delete process.env.SEXTANT_USER_BASE;
  delete process.env.SEXTANT_RUNTIME_BASE;
  assert.equal(userBase({ home: '/h' }), path.join('/h', '.claude', 'sextant'));
  process.env.SEXTANT_RUNTIME_BASE = '/rt';
  assert.equal(userBase({ home: '/h' }), path.join('/rt', 'user-scope'), 'runtime base isolates away from home');
  process.env.SEXTANT_USER_BASE = '/ub';
  assert.equal(userBase({ home: '/h' }), '/ub', 'explicit override wins');
});

test('first run creates the ledger stamped with the current version + project', async (t) => {
  const ub = await isolatedUserBase(t);
  const root = await mkPluginRoot('0.39.0');
  const cwd = '/home/u/proj-a';

  await recordLedgerProbe({ pluginRoot: root, cwd, now: 't1' });

  const l = await readLedger(ub);
  assert.equal(l.created_by_version, '0.39.0');
  assert.equal(l.created_ts, 't1');
  assert.equal(l.last_seen_by_version, '0.39.0');
  assert.equal(l.session_count, 1);
  assert.equal(l.projects[cwd].first_seen_version, '0.39.0');
  assert.equal(l.projects[cwd].first_seen_ts, 't1');
});

test('a later version updates last_seen but NOT created_* (write-once survival proof)', async (t) => {
  const ub = await isolatedUserBase(t);
  const cwd = '/home/u/proj-a';

  await recordLedgerProbe({ pluginRoot: await mkPluginRoot('0.39.0'), cwd, now: 't1' });
  await recordLedgerProbe({ pluginRoot: await mkPluginRoot('0.40.0'), cwd, now: 't2' });

  const l = await readLedger(ub);
  assert.equal(l.created_by_version, '0.39.0', 'created_by_version frozen at first writer');
  assert.equal(l.created_ts, 't1', 'created_ts frozen');
  assert.equal(l.last_seen_by_version, '0.40.0', 'last_seen advances');
  assert.equal(l.last_seen_ts, 't2');
  assert.equal(l.session_count, 2);
  assert.equal(l.projects[cwd].first_seen_version, '0.39.0', 'project first_seen frozen');
  assert.equal(l.projects[cwd].last_seen_version, '0.40.0');
});

test('a second project is recorded distinctly', async (t) => {
  const ub = await isolatedUserBase(t);
  const root = await mkPluginRoot('0.39.0');

  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-a', now: 't1' });
  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-b', now: 't2' });

  const l = await readLedger(ub);
  assert.deepEqual(Object.keys(l.projects).sort(), ['/home/u/proj-a', '/home/u/proj-b']);
  assert.equal(l.session_count, 2);
});

test('missing pluginRoot is a silent no-op — writes nothing, never throws', async (t) => {
  const ub = await isolatedUserBase(t);
  await assert.doesNotReject(() => recordLedgerProbe({ cwd: '/x' }));
  await assert.doesNotReject(() => recordLedgerProbe({}));
  await assert.rejects(() => fs.access(path.join(ub, 'ledger-probe.json')), 'no ledger file created');
});

test('corrupt existing ledger is replaced, not fatal', async (t) => {
  const ub = await isolatedUserBase(t);
  const root = await mkPluginRoot('0.39.0');
  await fs.mkdir(ub, { recursive: true });
  await fs.writeFile(path.join(ub, 'ledger-probe.json'), 'not json {{{');

  await recordLedgerProbe({ pluginRoot: root, cwd: '/home/u/proj-a', now: 't1' });

  const l = await readLedger(ub);
  assert.equal(l.created_by_version, '0.39.0');
  assert.equal(l.session_count, 1);
});
