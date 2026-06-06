// Tests for `cerebrum doctor` (cerebrum-v2 T5) — the store lint + un/partly-
// migrated detection. Runs the CLI as a subprocess (production path) against
// temp stores. Also validates the "[!]-with-no-scope fires nowhere" premise
// directly via listMandatoryFor (not just that the lint flags a fixture).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCerebrum, listMandatoryFor, CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'cerebrum.mjs');

function freshRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-doctor-' + crypto.randomUUID());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function seed(root, file, content) {
  const p = path.join(root, '.sextant', 'cerebrum', file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

function doctor(root) {
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--root', root], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------------------
// clean store → no warnings
// ---------------------------------------------------------------------------

test('doctor: a clean v2 store has no warnings', async (t) => {
  const root = freshRoot(t);
  // node: path must exist under root → create it.
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), '// x\n');
  await seed(root, 'cerebrum.md', [
    CEREBRUM_V2_HEADER,
    '- 2026-05-12: [node:src/a.ts] keep this module small and focused enough',
    '- 2026-05-12: [kw:deploy] [!] never deploy on a friday (by: s)',
    '- 2026-05-12: [global] always bump versions after a change (by: s)',
  ].join('\n') + '\n');

  const r = doctor(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /0 warning\(s\)/);
  assert.match(r.stdout, /OK — no misfiled/);
});

// ---------------------------------------------------------------------------
// each misfiled/malformed condition is flagged
// ---------------------------------------------------------------------------

test('doctor: flags a stale [node:] path (does not exist under root)', async (t) => {
  const root = freshRoot(t);
  await seed(root, 'cerebrum.md', [
    CEREBRUM_V2_HEADER,
    '- 2026-05-12: [node:src/does-not-exist.ts] rule pointing at a vanished file',
  ].join('\n') + '\n');
  const r = doctor(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 warning/);
  assert.match(r.stdout, /path does not exist/);
});

test('doctor: flags a [kw:] bucket that parses with no terms (e.g. comma-only)', async (t) => {
  const root = freshRoot(t);
  // A truly-empty `[kw:]` falls into the body (not tokenized); a kw bucket that
  // parses but yields no terms is the lintable malformed case (a trailing comma
  // or whitespace-only content).
  await seed(root, 'cerebrum.md', [
    CEREBRUM_V2_HEADER,
    '- 2026-05-12: [kw:,] [!] a rule whose keyword bucket has no real terms (by: s)',
  ].join('\n') + '\n');
  const r = doctor(root);
  assert.match(r.stdout, /no keyword terms/);
});

test('doctor: flags a [!] rule with no scope (fires nowhere)', async (t) => {
  const root = freshRoot(t);
  await seed(root, 'cerebrum.md', [
    CEREBRUM_V2_HEADER,
    '- 2026-05-12: [!] a mandatory rule with importance but no scope token here (by: s)',
  ].join('\n') + '\n');
  const r = doctor(root);
  assert.match(r.stdout, /no scope/);
  assert.match(r.stdout, /fires nowhere/);
});

// ---------------------------------------------------------------------------
// premise check (advisor #5): a scope-less [!] rule really does fire nowhere
// ---------------------------------------------------------------------------

test('listMandatoryFor: a [!]-only rule (no scope) is returned for NO path', () => {
  const parsed = parseCerebrum('- 2026-05-12: [!] scope-less mandatory rule body (by: s)');
  // Try the rule's own date path, an arbitrary path, and the global sentinel.
  assert.deepEqual(listMandatoryFor(parsed, 'anything.ts'), []);
  assert.deepEqual(listMandatoryFor(parsed, '/__sextant_no_match__'), []);
  // Contrast: the same body with [!global] DOES surface via the global sentinel.
  const g = parseCerebrum('- 2026-05-12: [!] [!global] scope-less? no — global (by: s)');
  assert.equal(listMandatoryFor(g, '/__sextant_no_match__').length, 1);
});

// ---------------------------------------------------------------------------
// migrate recommendation is HEALTH-gated, not presence-gated (advisor #2)
// ---------------------------------------------------------------------------

test('doctor: v1 files BESIDE a healthy v2 store → info "safe to archive", NOT a migrate warning', async (t) => {
  const root = freshRoot(t);
  await seed(root, 'cerebrum.md', [CEREBRUM_V2_HEADER, '- 2026-05-12: [global] [!] healthy rule body here (by: s)'].join('\n') + '\n');
  await seed(root, 'regular.md', '- 2026-05-12: [node:x.ts] a retained v1 rule\n');
  await seed(root, 'mandatory.md', '- 2026-05-12: [!] a retained v1 mandatory rule\n');

  const r = doctor(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /safe to archive/);
  assert.doesNotMatch(r.stdout, /run 'cerebrum migrate'/);
});

test('doctor: v1 files with NO cerebrum.md → recommend migrate', async (t) => {
  const root = freshRoot(t);
  await seed(root, 'regular.md', '- 2026-05-12: [node:x.ts] an un-migrated v1 rule\n');
  await seed(root, 'mandatory.md', '- 2026-05-12: [!] an un-migrated v1 mandatory rule\n');

  const r = doctor(root);
  assert.match(r.stdout, /run 'cerebrum migrate'/);
});

test('doctor: cerebrum.md with rules but NO v2 header → recommend migrate (partial migration)', async (t) => {
  const root = freshRoot(t);
  await seed(root, 'cerebrum.md', '- 2026-05-12: [node:x.ts] a rule with no v2 header above it here\n');
  const r = doctor(root);
  assert.match(r.stdout, /lacks the v2 header/);
  assert.match(r.stdout, /run 'cerebrum migrate'/);
});

test('doctor: no store at all → nothing to lint, exit 0', async (t) => {
  const root = freshRoot(t);
  await fs.mkdir(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  const r = doctor(root);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no store found/i);
});
