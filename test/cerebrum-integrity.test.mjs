// Phase 0 (cerebrum-v2): tests for the corruption guard + locked mutation API.
//
// Coverage targets:
//   - assertCerebrumIntegrity: clean round-trip passes; stale in-memory
//     `.buckets` (the auto-tagger rewrites `.raw` without syncing) does NOT
//     false-positive; a fused/embedded-newline raw is rejected with rule-count
//     drift.
//   - appendEntries: lands a new rule on its own line BEFORE a trailing blank
//     (no spurious blank line — the cerebrum-cli:171 regression class).
//   - updateCerebrumFile: writes under the lock; returns null on a contended
//     lock (and writes nothing); aborts the write on integrity failure leaving
//     the on-disk file byte-for-byte intact; serializes concurrent writers so
//     neither update is lost.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseCerebrum,
  readCerebrumFile,
  assertCerebrumIntegrity,
  appendEntries,
  updateCerebrumFile,
} from '../lib/stores/cerebrum.mjs';

function tmpFile(t, name = 'cerebrum.md') {
  const dir = path.join(os.tmpdir(), 'sextant-integrity-' + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

// Parse text and return only its rule entries (the shape appendEntries wants).
const ruleEntries = (text) => parseCerebrum(text).lines.filter((e) => e.kind === 'rule');

// -- assertCerebrumIntegrity ------------------------------------------------

test('assertCerebrumIntegrity: clean parsed round-trips and returns the text', () => {
  const parsed = parseCerebrum('- 2026-01-01: [!] [node:a.ts] one\n- 2026-01-02: [kw:foo,bar] two\n');
  const text = assertCerebrumIntegrity(parsed);
  assert.ok(text.includes('one') && text.includes('two'));
});

test('assertCerebrumIntegrity: tolerates stale .buckets (auto-tagger rewrites .raw, not .buckets)', () => {
  // Simulate the auto-tagger: parse an untagged rule (buckets === []), then
  // rewrite .raw to add a tag WITHOUT syncing .buckets. The guard must derive
  // expected buckets from .raw, so this is a no-op, not a false positive.
  const parsed = parseCerebrum('- 2026-01-01: an untagged rule');
  const rule = parsed.lines.find((e) => e.kind === 'rule');
  assert.deepEqual(rule.buckets, []); // stale baseline
  rule.raw = '- 2026-01-01: [!review] an untagged rule';
  const text = assertCerebrumIntegrity(parsed); // must NOT throw
  assert.ok(text.includes('[!review]'));
});

test('assertCerebrumIntegrity: rejects a fused entry (embedded newline => rule-count drift)', () => {
  const parsed = parseCerebrum('- 2026-01-01: [kw:a] first');
  const rule = parsed.lines.find((e) => e.kind === 'rule');
  // A single entry whose raw now carries a SECOND rule line. The solo parse of
  // this entry yields one rule, but serialize+reparse yields two — count drift,
  // exactly the bug-1 fusion fingerprint.
  rule.raw = '- 2026-01-01: [kw:a] first\n- 2026-01-02: [kw:b] second';
  assert.throws(() => assertCerebrumIntegrity(parsed), /rule count drift|corruption guard/);
});

// -- appendEntries ----------------------------------------------------------

test('appendEntries: appends before a trailing blank — no spurious blank line', () => {
  // A file ending in '\n' parses to a trailing blank entry; a naive push would
  // serialize "first\n\n- second". appendEntries must land it on its own line.
  const parsed = parseCerebrum('- 2026-01-01: first\n');
  appendEntries(parsed, ruleEntries('- 2026-01-02: second'));
  const text = assertCerebrumIntegrity(parsed);
  assert.ok(text.includes('first\n- 2026-01-02: second'), 'rules separated by a single newline');
  assert.doesNotMatch(text, /first\n\n- /, 'no blank line inserted');
});

test('appendEntries: appends to an empty store', () => {
  const parsed = { lines: [] };
  appendEntries(parsed, ruleEntries('- 2026-01-01: only'));
  assert.equal(parsed.lines.filter((e) => e.kind === 'rule').length, 1);
});

// -- updateCerebrumFile: write + lock ---------------------------------------

test('updateCerebrumFile: writes through the lock and persists', async (t) => {
  const file = tmpFile(t);
  const res = await updateCerebrumFile(file, (p) => appendEntries(p, ruleEntries('- 2026-01-01: [!] hello')));
  assert.notEqual(res, null);
  const onDisk = await fs.readFile(file, 'utf8');
  assert.ok(onDisk.includes('[!] hello'));
});

test('updateCerebrumFile: returns null on a contended lock and writes nothing', async (t) => {
  const file = tmpFile(t);
  await fs.writeFile(file, '- 2026-01-01: pre-existing\n', 'utf8');
  // Hold the lockfile so acquisition times out.
  const lockPath = `${file}.lock`;
  const fd = fsSync.openSync(lockPath, 'wx');
  try {
    const res = await updateCerebrumFile(
      file,
      (p) => appendEntries(p, ruleEntries('- 2026-01-02: should-not-land')),
      { lockTimeoutMs: 30, pollIntervalMs: 5 },
    );
    assert.equal(res, null, 'contended lock returns null');
  } finally {
    fsSync.closeSync(fd);
    fsSync.unlinkSync(lockPath);
  }
  const onDisk = await fs.readFile(file, 'utf8');
  assert.ok(!onDisk.includes('should-not-land'), 'nothing written under contention');
  assert.ok(onDisk.includes('pre-existing'), 'original intact');
});

test('updateCerebrumFile: aborts the write on integrity failure, file left intact', async (t) => {
  const file = tmpFile(t);
  const seed = '- 2026-01-01: [kw:a] alpha\n- 2026-01-02: [kw:b] beta\n';
  await fs.writeFile(file, seed, 'utf8');
  await assert.rejects(
    () => updateCerebrumFile(file, (p) => {
      // Corrupt: fuse a second rule into an existing entry's raw.
      const r = p.lines.find((e) => e.kind === 'rule');
      r.raw = `${r.raw}\n- 2026-01-03: [kw:c] injected`;
      return p;
    }),
    /corruption guard|drift/,
  );
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk, seed, 'on-disk file is byte-for-byte unchanged after aborted write');
});

test('updateCerebrumFile: serializes concurrent writers — no lost update', async (t) => {
  const file = tmpFile(t);
  await updateCerebrumFile(file, (p) => appendEntries(p, ruleEntries('- 2026-01-01: one')));
  // Two appends fired concurrently; the OS lockfile must serialize them so
  // neither read-modify-write clobbers the other.
  await Promise.all([
    updateCerebrumFile(file, (p) => appendEntries(p, ruleEntries('- 2026-01-02: two')), { lockTimeoutMs: 2000 }),
    updateCerebrumFile(file, (p) => appendEntries(p, ruleEntries('- 2026-01-03: three')), { lockTimeoutMs: 2000 }),
  ]);
  const parsed = await readCerebrumFile(file);
  const bodies = parsed.lines.filter((e) => e.kind === 'rule').map((e) => e.body);
  assert.equal(bodies.length, 3, 'all three rules present (no lost update)');
  assert.ok(bodies.includes('one') && bodies.includes('two') && bodies.includes('three'));
});
