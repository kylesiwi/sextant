// Tests for bin/review.mjs — Phase 10 review CLI.
//
// Coverage targets:
//   - Plain text output contains all three section headers and the
//     synthetic candidate bodies.
//   - --json output parses to the expected shape with promotion / demote /
//     contradictions arrays.
//   - Missing stats.json prints the friendly "no measurement data yet"
//     message and exits 0.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lineHash, CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
import { writeStats, defaultStats, incrementRuleFire } from '../lib/stores/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'review.mjs');

async function freshProjectRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-review-' + crypto.randomUUID());
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: 15000,
  });
  return {
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

// -- no-data path -----------------------------------------------------------

test('review CLI: missing stats.json → no-data message + exit 0', async (t) => {
  const root = await freshProjectRoot(t);
  const r = runCli(['--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no measurement data yet/);
});

test('review CLI --json: missing stats.json → exists=false + empty arrays', async (t) => {
  const root = await freshProjectRoot(t);
  const r = runCli(['--root', root, '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.exists, false);
  assert.deepEqual(parsed.promotion, []);
  assert.deepEqual(parsed.demote, []);
  assert.deepEqual(parsed.contradictions, []);
});

// -- end-to-end with synthetic data ----------------------------------------

async function seedScenario(root) {
  // cerebrum-v2: one store (cerebrum.md). The promotion candidate is a [kw:] rule
  // — promotion is kw-only (T6). demote/contradiction rules use [global] (those
  // tiers aren't kw-filtered).
  const cerebrumDir = path.join(root, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  const promoLine = '- 2026-01-01: [kw:prettier] Always run prettier before committing';
  const demoLine = '- 2026-01-01: [global] Prefer underscore.js for utility helpers';
  const conflictA = '- 2026-01-01: [global] Always validate inputs in handlers';
  const conflictB = '- 2026-01-01: [global] Never validate inputs in handlers';
  await fs.writeFile(
    path.join(cerebrumDir, 'cerebrum.md'),
    [CEREBRUM_V2_HEADER, promoLine, demoLine, conflictA, conflictB].join('\n') + '\n',
    'utf8',
  );

  const stats = defaultStats();
  stats.ab_arm = 'B';
  stats.session_count = 100; // → opportunities = 1000
  const hPromo = lineHash(promoLine);
  const hDemo = lineHash(demoLine);
  for (let i = 0; i < 50; i++) incrementRuleFire(stats, hPromo);
  // Demote rule: 1 fire long ago.
  incrementRuleFire(stats, hDemo);
  stats.rule_fires[hDemo].last_fired =
    new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  await writeStats(path.join(root, '.sextant'), stats);
  return { hPromo, hDemo, conflictA, conflictB };
}

test('review CLI: plain output contains all three section headers', async (t) => {
  const root = await freshProjectRoot(t);
  await seedScenario(root);
  const r = runCli(['--root', root]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Sextant review summary/);
  assert.match(r.stdout, /Promotion candidates \(1\)/);
  assert.match(r.stdout, /Demote candidates \(1\)/);
  assert.match(r.stdout, /Contradictions \(1\)/);
});

test('review CLI: plain output renders the rule bodies', async (t) => {
  const root = await freshProjectRoot(t);
  await seedScenario(root);
  const r = runCli(['--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Always run prettier before committing/);
  assert.match(r.stdout, /Prefer underscore.js for utility helpers/);
  assert.match(r.stdout, /Always validate inputs in handlers/);
  assert.match(r.stdout, /Never validate inputs in handlers/);
  assert.match(r.stdout, /reason: keyword pair/);
});

test('review CLI --json: emits the structured payload', async (t) => {
  const root = await freshProjectRoot(t);
  const seeded = await seedScenario(root);
  const r = runCli(['--root', root, '--json']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.exists, true);
  assert.equal(typeof parsed.threshold, 'number');
  assert.equal(typeof parsed.session_count, 'number');

  // Promotion candidate
  assert.equal(parsed.promotion.length, 1);
  assert.equal(parsed.promotion[0].line_hash, seeded.hPromo);
  assert.equal(parsed.promotion[0].fires, 50);
  assert.equal(parsed.promotion[0].body, 'Always run prettier before committing');
  assert.deepEqual(parsed.promotion[0].current_buckets, ['kw:prettier']);

  // Demote candidate
  assert.equal(parsed.demote.length, 1);
  assert.equal(parsed.demote[0].line_hash, seeded.hDemo);
  assert.equal(parsed.demote[0].fires, 1);
  assert.ok(parsed.demote[0].ratio < 0.05);

  // Contradiction
  assert.equal(parsed.contradictions.length, 1);
  assert.ok(parsed.contradictions[0].reason.length > 0);
  assert.ok(parsed.contradictions[0].line_a.body.length > 0);
  assert.ok(parsed.contradictions[0].line_b.body.length > 0);
});

// -- threshold env override -------------------------------------------------

test('review CLI: SEXTANT_PROMOTION_THRESHOLD lowers the bar', async (t) => {
  // Lower the threshold to 10 so the demote-candidate (1 fire) is still
  // below it but a fresh rule with 20 fires would also count. Use a
  // separate scenario: one rule with 20 fires, threshold=10.
  const root = await freshProjectRoot(t);
  const cerebrumDir = path.join(root, '.sextant', 'cerebrum');
  await fs.mkdir(cerebrumDir, { recursive: true });
  const line = '- 2026-01-01: [kw:temporal] Use temporal API for new date code';
  await fs.writeFile(path.join(cerebrumDir, 'cerebrum.md'), [CEREBRUM_V2_HEADER, line].join('\n') + '\n', 'utf8');
  const stats = defaultStats();
  stats.ab_arm = 'B';
  const h = lineHash(line);
  for (let i = 0; i < 20; i++) incrementRuleFire(stats, h);
  await writeStats(path.join(root, '.sextant'), stats);

  // Default threshold (50) → no promotion.
  const r1 = runCli(['--root', root, '--json']);
  const parsed1 = JSON.parse(r1.stdout);
  assert.equal(parsed1.promotion.length, 0);

  // Lowered threshold (10) → 1 promotion.
  const r2 = runCli(['--root', root, '--json'], { env: { SEXTANT_PROMOTION_THRESHOLD: '10' } });
  const parsed2 = JSON.parse(r2.stdout);
  assert.equal(parsed2.promotion.length, 1);
  assert.equal(parsed2.threshold, 10);
});
