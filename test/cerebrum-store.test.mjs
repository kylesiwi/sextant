// cerebrum-v2 / tranche T2: one-store reader + compat shim + cutover.
//
// Covers the deterministic read path's cutover to the v2 one store via
// readResolvedCerebrum: the unified v1+v2 parser, the v2→v1 bucket normalizer,
// the recall=1.0 invariant (migrated globals/node rules still fire through the
// unchanged listMandatoryFor channel), the read-freshness regen (mid-session
// writes stay visible), the SEXTANT_CEREBRUM_V2 kill-switch, and cold start.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseCerebrum,
  normalizeV2Buckets,
  readResolvedCerebrum,
  autoMigrateIfNeeded,
  migrateCerebrumStores,
  listMandatoryFor,
  CEREBRUM_V2_HEADER,
} from '../lib/stores/cerebrum.mjs';

function freshDir(t) {
  const dir = path.join(os.tmpdir(), 'sextant-store-' + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const MAN =
  '- 2026-05-12: [!] [node:lib/a.mjs] rule A\n' +
  '- 2026-05-13: [!] [!global] constitution rule\n' +
  '- 2026-05-14: [!] [kw:deploy] keyword rule\n';
const REG =
  '- 2026-05-15: [!review] low-confidence note\n' +
  '- 2026-05-18: [!global] [todo] the inert global leak\n';

async function seedTwoFile(dir, { man = MAN, reg = REG } = {}) {
  await fs.writeFile(path.join(dir, 'mandatory.md'), man, 'utf8');
  await fs.writeFile(path.join(dir, 'regular.md'), reg, 'utf8');
}
async function seedMigrated(dir, opts) {
  await seedTwoFile(dir, opts);
  const man = await fs.readFile(path.join(dir, 'mandatory.md'), 'utf8');
  const reg = await fs.readFile(path.join(dir, 'regular.md'), 'utf8');
  const res = migrateCerebrumStores({ mandatoryText: man, regularText: reg });
  await fs.writeFile(path.join(dir, 'cerebrum.md'), res.text, 'utf8');
}

// -- unified parser ---------------------------------------------------------

test('parseCerebrum tokenizes v2 [global]/[provisional] alongside v1 tokens', () => {
  const p = parseCerebrum(
    '- 2026-01-01: [global] [!] a\n- 2026-01-02: [provisional] b\n- 2026-01-03: [!global] c\n',
  );
  const buckets = p.lines.filter((e) => e.kind === 'rule').map((e) => e.buckets);
  assert.deepEqual(buckets, [['global', '!'], ['provisional'], ['!global']]);
});

// -- normalizeV2Buckets -----------------------------------------------------

test('normalizeV2Buckets: [global] → !global + ! (constitution always fires)', () => {
  assert.deepEqual(normalizeV2Buckets(['global', '!']), ['!global', '!']);
});
test('normalizeV2Buckets: [provisional] → !review (stays queued)', () => {
  assert.deepEqual(normalizeV2Buckets(['provisional']), ['!review']);
});
test('normalizeV2Buckets: v1 !global passes through WITHOUT gaining ! (fallback preserved)', () => {
  assert.deepEqual(normalizeV2Buckets(['!global']), ['!global']);
});
test('normalizeV2Buckets: node:/kw:/! pass through', () => {
  assert.deepEqual(normalizeV2Buckets(['node:x.mjs', 'kw:foo', '!']), ['node:x.mjs', 'kw:foo', '!']);
});

// -- readResolvedCerebrum: source selection ---------------------------------

test('readResolvedCerebrum: v2 source when a migrated cerebrum.md is present', async (t) => {
  const dir = freshDir(t);
  await seedMigrated(dir);
  const r = await readResolvedCerebrum(dir, { env: {} });
  assert.equal(r.source, 'v2');
});

test('readResolvedCerebrum: empty store (no cerebrum.md) resolves to an empty v2 store, no throw', async (t) => {
  const dir = freshDir(t);
  // cerebrum-v2 / T3.5: v1 fallback + kill-switch retired. A missing cerebrum.md
  // is an empty store; reading the two old v1 files is no longer a code path.
  const r = await readResolvedCerebrum(dir);
  assert.equal(r.source, 'v2');
  assert.deepEqual(r.parsed.lines.filter((e) => e.kind === 'rule'), []);
});

// -- recall = 1.0 invariant -------------------------------------------------

test('recall: migrated node + global rules fire via listMandatoryFor on the v2 store', async (t) => {
  const dir = freshDir(t);
  await seedMigrated(dir);
  const { parsed } = await readResolvedCerebrum(dir, { env: {} });
  // node:lib/a.mjs fires on its file (plus the 2 globals which fire on every read).
  const onFile = listMandatoryFor(parsed, 'lib/a.mjs');
  assert.ok(onFile.some((e) => e.body === 'rule A'), 'node-scoped rule fires on its file');
  // global sentinel: only the globals (constitution rule + resurrected leak).
  const globals = listMandatoryFor(parsed, '/__sextant_no_match__').map((e) => e.body);
  assert.ok(globals.includes('constitution rule'));
  assert.ok(globals.some((b) => b.includes('inert global leak')), 'inert regular [!global] resurrected');
});

test('recall: [provisional] (migrated [!review]) does NOT fire deterministically', async (t) => {
  const dir = freshDir(t);
  await seedMigrated(dir);
  const { parsed } = await readResolvedCerebrum(dir, { env: {} });
  const all = listMandatoryFor(parsed, 'lib/a.mjs').map((e) => e.body);
  assert.ok(!all.some((b) => b.includes('low-confidence')), 'provisional stays out of the deterministic tier');
});

// -- cold start -------------------------------------------------------------

test('cold start: a 1-rule migrated store fires its global', async (t) => {
  const dir = freshDir(t);
  await seedMigrated(dir, { man: '- 2026-05-13: [!] [!global] only rule\n', reg: '' });
  const { parsed } = await readResolvedCerebrum(dir);
  const globals = listMandatoryFor(parsed, '/__sextant_no_match__').map((e) => e.body);
  assert.deepEqual(globals, ['only rule']);
});

// -- auto-heal (T3.5/R3) ----------------------------------------------------
// Uses a proper <root>/.sextant/cerebrum layout so the backup lands under
// .sextant/backups (inside the cleaned-up root).
function freshCerebrumDir(t) {
  const root = path.join(os.tmpdir(), 'sextant-heal-' + crypto.randomUUID());
  const cdir = path.join(root, '.sextant', 'cerebrum');
  fsSync.mkdirSync(cdir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return cdir;
}

test('autoMigrateIfNeeded: un-migrated v1 store → migrates, backs up, reads back as v2', async (t) => {
  const cdir = freshCerebrumDir(t);
  await fs.writeFile(path.join(cdir, 'mandatory.md'),
    '- 2026-05-12: [!] [!global] run prettier\n- 2026-05-12: [!] [kw:rm] careful\n', 'utf8');
  const r = await autoMigrateIfNeeded(cdir);
  assert.equal(r.status, 'migrated');
  assert.equal(r.count, 2);
  const one = await fs.readFile(path.join(cdir, 'cerebrum.md'), 'utf8');
  assert.ok(one.startsWith(CEREBRUM_V2_HEADER), 'v2 header written');
  // Non-destructive: the v1 files are backed up under .sextant/backups.
  const bak = await fs.readFile(path.join(cdir, '..', 'backups', 'cerebrum-pre-v2', 'mandatory.md'), 'utf8');
  assert.match(bak, /run prettier/);
  // The migrated store now resolves and fires the global.
  const { parsed } = await readResolvedCerebrum(cdir);
  assert.ok(listMandatoryFor(parsed, '/x').some((e) => e.body === 'run prettier'), 'global fires post-heal');
});

test('autoMigrateIfNeeded: already-migrated store → noop (idempotent)', async (t) => {
  const cdir = freshCerebrumDir(t);
  await fs.writeFile(path.join(cdir, 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n- 2026-05-12: [global] [!] already here\n', 'utf8');
  assert.deepEqual(await autoMigrateIfNeeded(cdir), { status: 'noop' });
});

test('autoMigrateIfNeeded: fresh project (no v1 rules) → empty, no cerebrum.md written', async (t) => {
  const cdir = freshCerebrumDir(t);
  const r = await autoMigrateIfNeeded(cdir);
  assert.equal(r.status, 'empty');
  assert.equal(fsSync.existsSync(path.join(cdir, 'cerebrum.md')), false);
});
