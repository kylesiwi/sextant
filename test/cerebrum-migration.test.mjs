// cerebrum-v2 / tranche T1: migration script tests.
//
// Two layers:
//   - Pure transforms (direct import): migrateBucketTokens, migrateRuleLine,
//     migrateCerebrumStores, assertMigrationIntegrity — the token remap and the
//     lossless-body invariant, exercised with a hermetic inline fixture that
//     covers every bucket type (no reading of a real project's store).
//   - CLI orchestration (spawned subprocess): non-destructive backup, the v2
//     header idempotency sentinel, --dry-run, and --rollback.

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
  migrateBucketTokens,
  migrateRuleLine,
  migrateCerebrumStores,
  assertMigrationIntegrity,
  CEREBRUM_V2_HEADER,
  parseCerebrum,
} from '../lib/stores/cerebrum.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'cerebrum.mjs');

// Hermetic fixture exercising every remap branch.
const FIXTURE_MANDATORY =
  '<!-- always-injected rules — use [!] tokens -->\n' +
  '- 2026-05-12: [!] [kw:plugins/cache] Never overwrite the installed plugin. Bump versions.\n' +
  '- 2026-05-12: [!] [kw:*WSL2, *pwsh, env, port ; min=2] Watch the shell on Windows.\n' +
  '- 2026-05-13: [!] [node:lib/state.mjs] Reuse the lock primitive here.\n' +
  '- 2026-05-14: [!global] Always read the charter before editing scope.\n';

const FIXTURE_REGULAR =
  '<!-- ranked rules — append entries per § 6.2 -->\n' +
  '- 2026-05-15: [!review] Low-confidence auto-tagged thing about parsing.\n' +
  '- 2026-05-16: [ai-provisional] Agent guessed this one.\n' +
  '- 2026-05-17: [node:lib/foo.mjs] File-scoped note that was inert in regular.md.\n' +
  '<!-- sextant:auto-tag confidence=low -->\n' +
  '- 2026-05-18: [!global] [todo] The inert global leak (by: sess-7)\n';

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000, ...opts });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function freshRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-migrate-' + crypto.randomUUID());
  fsSync.mkdirSync(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function seedStore(root, { mandatory = FIXTURE_MANDATORY, regular = FIXTURE_REGULAR, archive = '<!-- demoted -->\n' } = {}) {
  const dir = path.join(root, '.sextant', 'cerebrum');
  await fs.writeFile(path.join(dir, 'mandatory.md'), mandatory, 'utf8');
  await fs.writeFile(path.join(dir, 'regular.md'), regular, 'utf8');
  await fs.writeFile(path.join(dir, 'archive.md'), archive, 'utf8');
}

const rulePrefixes = (text) =>
  parseCerebrum(text).lines
    .filter((e) => e.kind === 'rule')
    .map((e) => e.raw.match(/^\s*-\s+\d{4}-\d{2}-\d{2}:\s*((?:\[[^\]]*\]\s*)*)/)?.[1].trim() ?? '');

// -- migrateBucketTokens (the remap table) ---------------------------------

// cerebrum-v2 T6: [!] is kw-only — the migration drops the redundant [!] from
// node:/global rules (they fire by scope; the normalizer re-adds the internal '!'
// to [global] at read time), and keeps it on [kw:] rules.
test('migrateBucketTokens: [!global] → [global] (no redundant [!]; T6)', () => {
  assert.deepEqual(migrateBucketTokens(['!global']), ['global']);
});

test('migrateBucketTokens: [!][node:F] → [node:F] (no redundant [!]; T6)', () => {
  assert.deepEqual(migrateBucketTokens(['!', 'node:lib/state.mjs']), ['node:lib/state.mjs']);
});

test('migrateBucketTokens: a bare mandatory [!] (no scope) stays [!] (lint flags it; T6)', () => {
  assert.deepEqual(migrateBucketTokens(['!']), ['!']);
});

test('migrateBucketTokens: [!][kw:…] → [kw:…][!] (importance kept on kw rules)', () => {
  assert.deepEqual(migrateBucketTokens(['!', 'kw:plugins/cache']), ['kw:plugins/cache', '!']);
});

test('migrateBucketTokens: [!review] → [provisional]; no importance', () => {
  assert.deepEqual(migrateBucketTokens(['!review']), ['provisional']);
});

test('migrateBucketTokens: [ai-provisional] is dropped', () => {
  assert.deepEqual(migrateBucketTokens(['ai-provisional']), []);
});

test('migrateBucketTokens: node: scope is preserved', () => {
  assert.deepEqual(migrateBucketTokens(['node:lib/foo.mjs']), ['node:lib/foo.mjs']);
});

test('migrateBucketTokens: kw scoring markers (* and ;min=) are stripped', () => {
  assert.deepEqual(
    migrateBucketTokens(['!', 'kw:*WSL2, *pwsh, env, port ; min=2']),
    ['kw:WSL2, pwsh, env, port', '!'],
  );
});

// -- migrateRuleLine (body preservation) -----------------------------------

test('migrateRuleLine: rewrites only the prefix; body + (by:) preserved verbatim', () => {
  const raw = '- 2026-05-18: [!global] [todo] The inert global leak (by: sess-7)';
  const out = migrateRuleLine(raw);
  // [todo] is not a bucket — it stays in the body region, untouched.
  assert.equal(out.rest, '[todo] The inert global leak (by: sess-7)');
  // tokens space-separated, matching the existing store convention (cmdRemember).
  // T6: [!global] → [global] (no redundant [!]).
  assert.equal(out.raw, '- 2026-05-18: [global] [todo] The inert global leak (by: sess-7)');
});

test('migrateRuleLine: non-rule line returns null', () => {
  assert.equal(migrateRuleLine('<!-- a comment -->'), null);
  assert.equal(migrateRuleLine(''), null);
});

test('migrateRuleLine: preserves leading whitespace in the head', () => {
  const out = migrateRuleLine('  - 2026-01-01: [!review] body');
  assert.equal(out.raw, '  - 2026-01-01: [provisional] body');
});

// -- migrateCerebrumStores (merge + structure) -----------------------------

test('migrateCerebrumStores: header first, mandatory rules then regular rules', () => {
  const { text } = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  assert.ok(text.startsWith(CEREBRUM_V2_HEADER + '\n'));
  const prefixes = rulePrefixes(text);
  // 4 mandatory + 4 regular rules, in that order.
  assert.equal(prefixes.length, 8);
  // first rule is the first mandatory one; last is the regular global leak.
  assert.ok(text.indexOf('Bump versions') < text.indexOf('inert global leak'));
});

test('migrateCerebrumStores: rulesIn == rulesOut; v1 decorative headers dropped, real markers kept', () => {
  const res = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  assert.equal(res.rulesIn, 8);
  assert.equal(res.rulesOut, 8);
  assert.ok(!res.text.includes('always-injected'));
  assert.ok(!res.text.includes('ranked rules'));
  assert.ok(res.text.includes('<!-- sextant:auto-tag confidence=low -->')); // real marker preserved
});

test('migrateCerebrumStores: every rule remaps to the expected v2 token set', () => {
  // Assert the remap per source rule line via migrateRuleLine().after (robust —
  // no re-parsing of the merged output with a version-specific regex).
  const ruleLines = (txt) => txt.split('\n').filter((l) => /^\s*-\s+\d{4}-\d{2}-\d{2}:/.test(l));
  const afters = [...ruleLines(FIXTURE_MANDATORY), ...ruleLines(FIXTURE_REGULAR)]
    .map((l) => migrateRuleLine(l).after);
  assert.deepEqual(afters, [
    ['kw:plugins/cache', '!'],          // kw keeps [!]
    ['kw:WSL2, pwsh, env, port', '!'],  // kw keeps [!]
    ['node:lib/state.mjs'],             // T6: node drops redundant [!]
    ['global'],                         // T6: global drops redundant [!]
    ['provisional'],
    [],                       // [ai-provisional] dropped → no buckets
    ['node:lib/foo.mjs'],
    ['global'],                         // T6: regular.md [!global] leak → [global] (no [!])
  ]);
});

test('migrateCerebrumStores: dead→live report flags inert regular.md rules that now fire', () => {
  const res = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  // Two regular.md rules go live in the unified store: the [!global][todo] leak →
  // [global] (T6: no redundant [!]); and the [node:lib/foo.mjs] rule, which was
  // inert in regular.md but now fires by scope (T5.6).
  assert.equal(res.deadToLive.length, 2);
  const globalLeak = res.deadToLive.find((d) => d.rest.includes('inert global leak'));
  assert.deepEqual(globalLeak.after, ['global']);
  const nodeLive = res.deadToLive.find((d) => d.rest.includes('File-scoped note'));
  assert.deepEqual(nodeLive.after, ['node:lib/foo.mjs']);
});

// -- assertMigrationIntegrity ----------------------------------------------

test('assertMigrationIntegrity: passes for a faithful remap', () => {
  const res = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  const n = assertMigrationIntegrity({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR }, res.text);
  assert.equal(n, 8);
});

test('assertMigrationIntegrity: throws on rule-count drift (dropped/fused rule)', () => {
  const res = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  const truncated = res.text.split('\n').slice(0, -2).join('\n'); // drop a rule line
  assert.throws(
    () => assertMigrationIntegrity({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR }, truncated),
    /rule count drift/,
  );
});

test('assertMigrationIntegrity: throws on body drift (a non-prefix edit)', () => {
  const res = migrateCerebrumStores({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR });
  const tampered = res.text.replace('Bump versions', 'Bump VERSIONS-EDITED');
  assert.throws(
    () => assertMigrationIntegrity({ mandatoryText: FIXTURE_MANDATORY, regularText: FIXTURE_REGULAR }, tampered),
    /body drift/,
  );
});

// -- CLI orchestration (spawned) -------------------------------------------

test('migrate CLI: writes cerebrum.md, backs up out-of-store, leaves old files intact', async (t) => {
  const root = freshRoot(t);
  await seedStore(root);
  const dir = path.join(root, '.sextant', 'cerebrum');
  const manBefore = await fs.readFile(path.join(dir, 'mandatory.md'), 'utf8');
  const regBefore = await fs.readFile(path.join(dir, 'regular.md'), 'utf8');

  const r = runCli(['migrate', '--root', root]);
  assert.equal(r.code, 0, r.stderr);

  // one store written with the v2 header
  const one = await fs.readFile(path.join(dir, 'cerebrum.md'), 'utf8');
  assert.ok(one.startsWith(CEREBRUM_V2_HEADER));
  assert.ok(one.includes('[provisional]'));

  // non-destructive: old files byte-identical
  assert.equal(await fs.readFile(path.join(dir, 'mandatory.md'), 'utf8'), manBefore);
  assert.equal(await fs.readFile(path.join(dir, 'regular.md'), 'utf8'), regBefore);

  // backup lives OUTSIDE the cerebrum dir (so a future glob-the-store won't index it)
  const bDir = path.join(root, '.sextant', 'backups', 'cerebrum-pre-v2');
  assert.ok(fsSync.existsSync(path.join(bDir, 'mandatory.md')));
  assert.equal(await fs.readFile(path.join(bDir, 'mandatory.md'), 'utf8'), manBefore);

  // report surfaced the dead→live transition
  assert.match(r.stdout, /previously-inert/);
});

test('migrate CLI: idempotent — second run is a no-op', async (t) => {
  const root = freshRoot(t);
  await seedStore(root);
  assert.equal(runCli(['migrate', '--root', root]).code, 0);
  const one1 = await fs.readFile(path.join(root, '.sextant', 'cerebrum', 'cerebrum.md'), 'utf8');

  const r2 = runCli(['migrate', '--root', root]);
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /already migrated/);
  const one2 = await fs.readFile(path.join(root, '.sextant', 'cerebrum', 'cerebrum.md'), 'utf8');
  assert.equal(one1, one2);
});

test('migrate CLI: --dry-run reports without writing', async (t) => {
  const root = freshRoot(t);
  await seedStore(root);
  const r = runCli(['migrate', '--root', root, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Dry-run: nothing written/);
  assert.equal(fsSync.existsSync(path.join(root, '.sextant', 'cerebrum', 'cerebrum.md')), false);
  assert.equal(fsSync.existsSync(path.join(root, '.sextant', 'backups', 'cerebrum-pre-v2')), false);
});

test('migrate CLI: --rollback restores pre-v2 state exactly', async (t) => {
  const root = freshRoot(t);
  await seedStore(root);
  const dir = path.join(root, '.sextant', 'cerebrum');
  const manBefore = await fs.readFile(path.join(dir, 'mandatory.md'), 'utf8');

  assert.equal(runCli(['migrate', '--root', root]).code, 0);
  assert.ok(fsSync.existsSync(path.join(dir, 'cerebrum.md')));

  const r = runCli(['migrate', '--root', root, '--rollback']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fsSync.existsSync(path.join(dir, 'cerebrum.md')), false);
  assert.equal(await fs.readFile(path.join(dir, 'mandatory.md'), 'utf8'), manBefore);
});

test('migrate CLI: --rollback with no backup errors cleanly', async (t) => {
  const root = freshRoot(t);
  await seedStore(root);
  const r = runCli(['migrate', '--root', root, '--rollback']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nothing to roll back/);
});
