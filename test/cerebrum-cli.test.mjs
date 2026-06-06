// Tests for bin/cerebrum.mjs — the five-subcommand multiplexer behind the
// /sextant:remember | promote | forget | audit | reconcile slash commands.
//
// We spawn the CLI as a subprocess (matching production usage) against a
// synthetic .sextant/cerebrum/ tree, then assert on stdout + on-disk state.
// In-process unit coverage of the helpers (hashLine / appendBucketToPrefix /
// parseArgs) is exercised via direct import.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { hashLine, appendBucketToPrefix, parseArgs } from '../bin/cerebrum.mjs';
import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
import { defaultStats, readStats, writeStats, incrementRuleFire } from '../lib/stores/stats.mjs';

const sextantBase = (root) => path.join(root, '.sextant');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'bin', 'cerebrum.mjs');

function freshProjectRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-cer-cli-' + crypto.randomUUID());
  fsSync.mkdirSync(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    ...opts,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// -- helpers (unit) --------------------------------------------------------

test('hashLine: produces a 16-hex prefix of SHA1', () => {
  const h = hashLine('hello world');
  assert.match(h, /^[0-9a-f]{16}$/);
  // Same input → same hash.
  assert.equal(hashLine('hello world'), h);
});

test('hashLine: distinct strings hash distinctly', () => {
  assert.notEqual(hashLine('a'), hashLine('b'));
});

test('appendBucketToPrefix: adds the token after existing buckets (canonical: [!] last)', () => {
  const out = appendBucketToPrefix('- 2026-05-10: [node:src/x.ts] body', '[!]');
  assert.equal(out, '- 2026-05-10: [node:src/x.ts] [!] body');
});

test('appendBucketToPrefix: no existing buckets → token sits right after the date', () => {
  const out = appendBucketToPrefix('  - 2026-05-10: body', '[!review]');
  assert.equal(out, '  - 2026-05-10: [!review] body');
});

test('appendBucketToPrefix: non-rule line returns unchanged', () => {
  assert.equal(appendBucketToPrefix('## header', '[!]'), '## header');
});

test('parseArgs: collects flag values', () => {
  const r = parseArgs(['--text', 'hi', '--node', 'src/x.ts', '--root', '/r']);
  assert.equal(r.text, 'hi');
  assert.equal(r.node, 'src/x.ts');
  assert.equal(r.root, '/r');
  assert.equal(r.global, false);
  assert.equal(r.mandatory, false);
});

test('parseArgs: boolean flags', () => {
  const r = parseArgs(['--mandatory', '--global']);
  assert.equal(r.mandatory, true);
  assert.equal(r.global, true);
});

// -- subcommand: remember --------------------------------------------------

// cerebrum-v2 / T3.5: all writes target the single cerebrum.md (header-prefixed),
// in v2 grammar (scope tokens then [!]; --global → [global], not [!global]).
const onePath = (root) => path.join(root, '.sextant', 'cerebrum', 'cerebrum.md');

test('cli remember: appends a global rule to cerebrum.md ([global])', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'always run prettier', '--global']);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.ok(text.startsWith(CEREBRUM_V2_HEADER), 'v2 header present');
  assert.match(text, /^- \d{4}-\d{2}-\d{2}: \[global\] always run prettier$/m);
});

test('cli remember: --node sets [node:<path>]', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'cache invalidation', '--node', 'src/cache.ts']);
  assert.equal(r.code, 0);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.match(text, /\[node:src\/cache\.ts\] cache invalidation/);
});

test('cli remember: --mandatory with no scope is REJECTED (a bare [!] fires nowhere)', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'never log secrets', '--mandatory']);
  // [!] is the importance flag; without a scope (--global/--node/--keywords) it
  // fires in no channel. The shared linter rejects it at author time.
  assert.equal(r.code, 1, `should reject (stderr: ${r.stderr})`);
  assert.match(r.stderr, /fires nowhere/);
  // Nothing was written.
  const exists = await fs.access(onePath(root)).then(() => true, () => false);
  if (exists) {
    const text = await fs.readFile(onePath(root), 'utf8');
    assert.doesNotMatch(text, /never log secrets/);
  }
});

test('cli remember: --mandatory + --global stacks both tokens (v2 order: [global] … [!])', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'top-of-tree rule', '--mandatory', '--global']);
  assert.equal(r.code, 0);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.match(text, /\[global\] \[!\] top-of-tree rule/);
});

test('cli explain: prints the two-tier rule model (cerebrum-v2 T5.6)', () => {
  const r = runCli(['explain']);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  assert.match(r.stdout, /How cerebrum evaluates rules/);
  assert.match(r.stdout, /DETERMINISTIC \/ ADDRESSED tier/);
  assert.match(r.stdout, /IMPORTANCE — the \[!\] flag — is KW-ONLY/);
});

test('cli remember: no scope flag yields an untagged line for the auto-tagger', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'just a thought']);
  assert.equal(r.code, 0);
  const text = await fs.readFile(onePath(root), 'utf8');
  // No bucket prefix between "date: " and the body.
  assert.match(text, /^- \d{4}-\d{2}-\d{2}: just a thought$/m);
});

test('cli remember: missing --text exits non-zero with stderr diagnostic', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--text is required/);
});

test('cli remember: appends on its own line when the file lacks a trailing newline', async (t) => {
  // Regression: a raw appendFile fused the new rule onto the last line when the
  // existing file did not end in "\n", merging their [kw:...] bucket tags.
  const root = freshProjectRoot(t);
  // Seed an existing cerebrum.md (header + one rule) with NO trailing newline.
  await writeFile(onePath(root), `${CEREBRUM_V2_HEADER}\n- 2026-05-12: [kw:alpha] [!] first rule`);

  const r = runCli(['remember', '--root', root, '--text', 'second rule', '--keywords', 'beta']);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);

  const text = await fs.readFile(onePath(root), 'utf8');
  // Both rules must be intact on their own lines — not fused into one.
  assert.match(text, /^- 2026-05-12: \[kw:alpha\] \[!\] first rule$/m);
  // --keywords no longer implies [!] in v2 (importance is orthogonal).
  assert.match(text, /^- \d{4}-\d{2}-\d{2}: \[kw:beta\] second rule$/m);
  assert.doesNotMatch(text, /first rule- \d{4}/);
  assert.ok(text.includes('first rule\n- '), 'rules separated by a single newline');
});

test('cli remember: does not insert a blank line when the file already ends in a newline', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(onePath(root), `${CEREBRUM_V2_HEADER}\n- 2026-05-12: [kw:alpha] [!] first rule\n`);

  const r = runCli(['remember', '--root', root, '--text', 'second rule', '--keywords', 'beta']);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);

  const text = await fs.readFile(onePath(root), 'utf8');
  assert.ok(text.includes('first rule\n- '), 'single newline between rules');
  assert.doesNotMatch(text, /first rule\n\n- /, 'no blank line inserted');
});

test('cli remember: deprecated kw flags alias into one plain [kw:] bucket (v2 — no */;min scoring)', async (t) => {
  // cerebrum-v2 (T5): --critical-keywords is a DEPRECATED ALIAS that folds its
  // terms into the plain [kw:] bucket (terms preserved, not dropped); --kw-min is
  // accepted-and-ignored. Both warn to stderr. Kept as aliases (not hard errors)
  // because commands/remember.md + audit.md still emit them until T6. Keyword
  // rules are NOT auto-mandatory (importance is set via --mandatory).
  const root = freshProjectRoot(t);
  const r = runCli([
    'remember', '--root', root,
    '--text', 'WSL2 paths are bidirectionally mounted into Windows',
    '--critical-keywords', 'WSL2,pwsh',
    '--keywords', 'env,port',
    '--kw-min', '2',
  ]);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);
  // Deprecation warnings surface (the alias contract), but terms are preserved.
  assert.match(r.stderr, /--critical-keywords is deprecated/);
  assert.match(r.stderr, /--kw-min is deprecated/);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.match(text, /\[kw:WSL2, pwsh, env, port\]/);
  assert.doesNotMatch(text, /\*/, 'no critical * markers');
  assert.doesNotMatch(text, /;min=/, 'no min override');
});

test('cli remember: --keywords "" is rejected (not silently written as an untagged rule)', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'empty keyword list should fail', '--keywords', '']);
  assert.equal(r.code, 1, `should reject (stderr: ${r.stderr})`);
  assert.match(r.stderr, /at least one non-empty keyword/);
  const exists = await fs.access(onePath(root)).then(() => true, () => false);
  if (exists) {
    const text = await fs.readFile(onePath(root), 'utf8');
    assert.doesNotMatch(text, /empty keyword list should fail/);
  }
});

test('cli remember --text-stdin: stores backticks/quotes/$ verbatim (no bash mangling)', async (t) => {
  const root = freshProjectRoot(t);
  const body = 'Use `node -e "fetch(url)"` not curl; PowerShell needs $env:VAR="value" and it\'s the only form.';
  const r = runCli(['remember', '--root', root, '--global', '--text-stdin'], { input: body + '\n' });
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.ok(text.includes(body), `body must be stored verbatim; got: ${text}`);
});

test('cli remember --text-stdin: collapses internal newlines to one line', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--global', '--text-stdin'], { input: 'line one\nline two\n' });
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  const text = await fs.readFile(onePath(root), 'utf8');
  assert.match(text, /^- \d{4}-\d{2}-\d{2}: \[global\] line one line two$/m);
});

test('cli remember --text-stdin: empty input errors', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--global', '--text-stdin'], { input: '   \n  \n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /empty input/);
});

test('cli audit --legacy-keywords: accepted-and-ignored (deprecated in v2; scan removed)', async (t) => {
  // cerebrum-v2 (T5): the legacy-keyword re-scoping scan is gone (the critical-*/
  // general/;min model it surfaced is retired). The flag is now a no-op alias that
  // warns to stderr; audit prints only the [provisional] review queue.
  const root = freshProjectRoot(t);
  await writeFile(
    path.join(root, '.sextant', 'cerebrum', 'cerebrum.md'),
    [CEREBRUM_V2_HEADER, '- 2026-05-12: [provisional] some uncertain rule body long enough here'].join('\n') + '\n',
  );

  const r = runCli(['audit', '--root', root, '--legacy-keywords']);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  assert.match(r.stderr, /--legacy-keywords is deprecated/);
  assert.doesNotMatch(r.stdout, /Legacy keyword rules/);   // scan removed entirely
});

test('cli audit (no flag): omits the legacy-keyword section', async (t) => {
  const root = freshProjectRoot(t);
  const manPath = path.join(root, '.sextant', 'cerebrum', 'mandatory.md');
  await writeFile(manPath, '- 2026-05-12: [!] [kw:WSL2,env,port] legacy rule body here is long enough\n');
  const r = runCli(['audit', '--root', root]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.stdout, /Legacy keyword rules/);
});

test('cli remember: --node and --global are mutually exclusive', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--text', 'x', '--node', 'src/a.ts', '--global']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /mutually exclusive/);
});

// -- subcommand: promote ---------------------------------------------------

test('cli promote: adds [!] in place to a [kw:] rule (the only meaningful promote, T5.6/T6)', async (t) => {
  const root = freshProjectRoot(t);
  // cerebrum-v2: promote is an in-place [!] flag-flip in the one store, and [!]
  // is KW-ONLY — so promote only applies to [kw:] rules (adds recall floor + gate).
  await writeFile(
    onePath(root),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [kw:deploy] never deploy on a friday',
      '- 2026-05-10: [node:src/y.ts] regular rule, stays put',
      '',
    ].join('\n'),
  );

  const targetRaw = '- 2026-05-10: [kw:deploy] never deploy on a friday';
  const hash = hashLine(targetRaw);

  const r = runCli(['promote', '--root', root, '--line-hash', hash]);
  assert.equal(r.code, 0, `exit code (stderr: ${r.stderr})`);
  assert.match(r.stdout, /Promoted:/);
  // promote echoes the rule's new line-hash so it can be acted on again.
  assert.match(r.stdout, /line-hash: [0-9a-f]{16}/);

  const store = await fs.readFile(onePath(root), 'utf8');
  // The kw rule gained [!] in canonical position (scope first, [!] last); the
  // unrelated node rule is untouched.
  assert.match(store, /\[kw:deploy\] \[!\] never deploy on a friday/);
  assert.match(store, /\[node:src\/y\.ts\] regular rule, stays put/);
});

test('cli promote: carries fire history across the rehash (no orphan/ghost)', async (t) => {
  const root = freshProjectRoot(t);
  const line = '- 2026-05-10: [kw:deploy] never deploy on a friday';
  await writeFile(onePath(root), [CEREBRUM_V2_HEADER, line, ''].join('\n'));
  const oldHash = hashLine(line);
  // Seed 50 fires under the pre-promote hash.
  const s = defaultStats();
  for (let i = 0; i < 50; i++) incrementRuleFire(s, oldHash);
  await writeStats(sextantBase(root), s);

  const r = runCli(['promote', '--root', root, '--line-hash', oldHash]);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  const newHash = r.stdout.match(/line-hash: ([0-9a-f]{16})/)[1];
  assert.notEqual(newHash, oldHash, 'promote rehashes the line');

  const after = await readStats(sextantBase(root));
  assert.equal(after.rule_fires[newHash]?.fires, 50, 'fires carried to the new hash');
  assert.ok(!(oldHash in after.rule_fires), 'old hash removed — no ghost entry');
  // Invariant: the surviving fire-key maps to the line actually in the store.
  const store = await fs.readFile(onePath(root), 'utf8');
  const promoted = store.split('\n').find((l) => l.includes('never deploy on a friday'));
  assert.equal(hashLine(promoted), newHash);
});

test('cli reconcile: carries fire history when it re-tags an already-fired rule', async (t) => {
  const root = freshProjectRoot(t);
  const line = '- 2026-05-10: invalidate the redis cache on every write path';
  await writeFile(onePath(root), [CEREBRUM_V2_HEADER, line, ''].join('\n'));
  const oldHash = hashLine(line);
  const s = defaultStats();
  for (let i = 0; i < 40; i++) incrementRuleFire(s, oldHash);
  await writeStats(sextantBase(root), s);

  const r = runCli(['reconcile', '--root', root]);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  const store = await fs.readFile(onePath(root), 'utf8');
  const tagged = store.split('\n').find((l) => l.includes('invalidate the redis cache'));
  const newHash = hashLine(tagged);
  assert.notEqual(newHash, oldHash, 'reconcile re-tagged (rehashed) the line');

  const after = await readStats(sextantBase(root));
  assert.equal(after.rule_fires[newHash]?.fires, 40, 'fires carried across reconcile');
  assert.ok(!(oldHash in after.rule_fires), 'old hash removed — no ghost entry');
});

test('cli promote: REFUSES a non-kw rule ([!] is kw-only; T6)', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(
    onePath(root),
    [CEREBRUM_V2_HEADER, '- 2026-05-10: [node:src/a.ts] keep this file tiny', ''].join('\n'),
  );
  const hash = hashLine('- 2026-05-10: [node:src/a.ts] keep this file tiny');
  const r = runCli(['promote', '--root', root, '--line-hash', hash]);
  assert.equal(r.code, 1, `should refuse (stderr: ${r.stderr})`);
  assert.match(r.stderr, /only affects \[kw:/);
  // The rule is unchanged — no redundant [!] stamped.
  const store = await fs.readFile(onePath(root), 'utf8');
  assert.doesNotMatch(store, /\[!\]/);
});

test('cli promote: a hash matching an already-mandatory rule is a no-op (single [!])', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(
    onePath(root),
    `${CEREBRUM_V2_HEADER}\n- 2026-05-10: [global] [!] already mandatory\n`,
  );

  const hash = hashLine('- 2026-05-10: [global] [!] already mandatory');
  const r = runCli(['promote', '--root', root, '--line-hash', hash]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Already mandatory:/);
  const store = await fs.readFile(onePath(root), 'utf8');
  assert.match(store, /\[global\] \[!\] already mandatory/);
  assert.ok(!store.includes('[!] [!]'), 'no duplicate [!] tokens');
});

test('cli promote: unknown hash exits non-zero', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(path.join(root, '.sextant', 'cerebrum', 'regular.md'), '- 2026-05-10: [!review] body\n');
  const r = runCli(['promote', '--root', root, '--line-hash', '0123456789abcdef']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no rule found with hash/);
});

test('cli list: prints every rule with its line hash (the hash promote/forget need)', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(
    onePath(root),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [kw:deploy] never deploy on a friday',
      '- 2026-05-10: [node:src/a.ts] keep this file small',
      '',
    ].join('\n'),
  );
  const r = runCli(['list', '--root', root]);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  assert.match(r.stdout, /cerebrum\.md \(2 rules\):/);
  // Each rule prints with a 16-hex hash that round-trips to promote/forget.
  const kwHash = hashLine('- 2026-05-10: [kw:deploy] never deploy on a friday');
  assert.match(r.stdout, new RegExp(`\\[${kwHash}\\] \\[kw:deploy\\] never deploy on a friday`));
  assert.match(r.stdout, /\[node:src\/a\.ts\] keep this file small/);
});

test('cli list: empty store prints (empty)', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(onePath(root), `${CEREBRUM_V2_HEADER}\n`);
  const r = runCli(['list', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cerebrum\.md \(0 rules\):/);
  assert.match(r.stdout, /\(empty\)/);
});

test('cli remember: echoes the appended line hash', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['remember', '--root', root, '--global', '--text', 'always read the charter first']);
  assert.equal(r.code, 0, `exit (stderr: ${r.stderr})`);
  assert.match(r.stdout, /line-hash: [0-9a-f]{16}/);
});

test('cli promote: missing --line-hash exits non-zero', async (t) => {
  const root = freshProjectRoot(t);
  const r = runCli(['promote', '--root', root]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--line-hash is required/);
});

// -- subcommand: forget ----------------------------------------------------

test('cli forget: archives a cerebrum.md rule with date marker', async (t) => {
  const root = freshProjectRoot(t);
  const raw = '- 2026-05-10: [provisional] obsolete rule';
  await writeFile(
    onePath(root),
    `${CEREBRUM_V2_HEADER}\n${raw}\n- 2026-05-10: [node:src/x.ts] survives\n`,
  );
  const hash = hashLine(raw);
  const r = runCli(['forget', '--root', root, '--line-hash', hash]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Forgot \(archived from cerebrum\.md\)/);

  const archive = await fs.readFile(path.join(root, '.sextant', 'cerebrum', 'archive.md'), 'utf8');
  assert.match(archive, /<!-- sextant:archived \d{4}-\d{2}-\d{2} -->/);
  assert.match(archive, /obsolete rule/);

  const store = await fs.readFile(onePath(root), 'utf8');
  assert.ok(!store.includes('obsolete rule'));
  assert.match(store, /survives/);
});

test('cli forget: removes an importance ([!]) rule too', async (t) => {
  const root = freshProjectRoot(t);
  const raw = '- 2026-05-10: [global] [!] retired rule';
  await writeFile(onePath(root), `${CEREBRUM_V2_HEADER}\n${raw}\n`);
  const hash = hashLine(raw);
  const r = runCli(['forget', '--root', root, '--line-hash', hash]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Forgot \(archived from cerebrum\.md\)/);
  const store = await fs.readFile(onePath(root), 'utf8');
  assert.ok(!store.includes('retired rule'));
});

test('cli forget: unknown hash exits non-zero', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(path.join(root, '.sextant', 'cerebrum', 'regular.md'), '- 2026-05-10: [!review] body\n');
  const r = runCli(['forget', '--root', root, '--line-hash', 'deadbeefcafef00d']);
  assert.notEqual(r.code, 0);
});

// -- subcommand: audit -----------------------------------------------------

test('cli audit: surfaces [!review] and [ai-provisional] entries from both files', async (t) => {
  const root = freshProjectRoot(t);
  // cerebrum-v2 (T3.5): the queue is surfaced from the single store.
  await writeFile(
    onePath(root),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: [provisional] needs scope review',
      '- 2026-05-10: [provisional] [node:src/x.ts] agent suggestion',
      '- 2026-05-10: [node:src/y.ts] regular rule, not queued',
      '- 2026-05-10: [ai-provisional] [node:src/z.ts] legacy flag for review',
      '- 2026-05-10: [global] [!] not queued',
    ].join('\n') + '\n',
  );

  const r = runCli(['audit', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Review queue \(3 entries\):/);
  assert.match(r.stdout, /cerebrum\.md:/);
  assert.match(r.stdout, /needs scope review/);
  assert.match(r.stdout, /agent suggestion/);
  assert.match(r.stdout, /flag for review/);
  // The non-queued rules are not surfaced.
  assert.ok(!r.stdout.includes('regular rule, not queued'));
  // Each entry has a 16-hex hash prefix.
  const hashes = r.stdout.match(/\[[0-9a-f]{16}\]/g) ?? [];
  assert.equal(hashes.length, 3);
});

test('cli audit: empty queue prints "(empty)"', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(
    path.join(root, '.sextant', 'cerebrum', 'regular.md'),
    '- 2026-05-10: [node:src/x.ts] clean rule\n',
  );
  const r = runCli(['audit', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Review queue \(0 entries\):/);
  assert.match(r.stdout, /\(empty\)/);
});

// -- subcommand: reconcile -------------------------------------------------

test('cli reconcile: tags untagged rules in cerebrum.md as [provisional]', async (t) => {
  const root = freshProjectRoot(t);
  await writeFile(
    onePath(root),
    [
      CEREBRUM_V2_HEADER,
      '- 2026-05-10: untagged rule one',
      '- 2026-05-10: [node:src/x.ts] already tagged',
      '- 2026-05-10: untagged rule two',
    ].join('\n') + '\n',
  );
  const r = runCli(['reconcile', '--root', root]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Reconciled cerebrum\.md: high=0 low=2 unchanged=\d+ lines=\d+/);
  assert.match(r.stdout, /Total: high=0 low=2/);
  const text = await fs.readFile(onePath(root), 'utf8');
  // cerebrum-v2 (T3.5): untagged rules now land as [provisional].
  const reviewMatches = text.match(/\[provisional\]/g) ?? [];
  assert.equal(reviewMatches.length, 2);
});

test('cli reconcile: handles missing cerebrum files gracefully', async (t) => {
  const root = freshProjectRoot(t);
  // No .md files exist.
  const r = runCli(['reconcile', '--root', root]);
  assert.equal(r.code, 0);
  // Total reflects no work done.
  assert.match(r.stdout, /Total: high=0 low=0/);
});

// -- top-level dispatch ----------------------------------------------------

test('cli: unknown subcommand exits code 2', () => {
  const r = runCli(['bogus']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown subcommand/);
});

test('cli: --help prints usage and exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: cerebrum/);
});
