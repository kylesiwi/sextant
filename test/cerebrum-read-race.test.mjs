// Concurrency proof for the mandatory-injection read path.
//
// The flush-race that bit the Stop hook (bug-7) is a read-vs-concurrent-append
// on an externally-written, NON-atomic file — and that is ONLY the Claude Code
// transcript. Sextant's OWN cold state is always written tmp+rename (POSIX
// rename is atomic), so a reader sees the whole old or whole new file, never
// empty/partial. The mandatory injection read path (preToolUse →
// readResolvedCerebrum → readTextOrNull) is therefore structurally immune to the
// torn/empty-read failure.
//
// This test turns that belief into a regression guard: hammer cerebrum.md with
// updateCerebrumFile writes (each a tmp+rename) while a fleet of concurrent
// readers drives readResolvedCerebrum. The writer and readers run TOGETHER (the
// writer is not awaited first) so the reads genuinely overlap in-flight renames.
// Every read must parse and return EXACTLY the seeded mandatory-rule count — a
// torn/empty read would surface as a parse throw or a short count.
//
// Scope note: this exercises tmpfs/ext4 (the same filesystem class as a real
// .sextant under ~/), demonstrating rename atomicity there. It does NOT exercise
// the coarse-mtime 9p / Windows-mount case flagged elsewhere — that hazard is
// about lunr-cache staleness, not torn reads, and the mandatory floor doesn't
// use that cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseCerebrum,
  appendEntries,
  ensureV2Header,
  updateCerebrumFile,
  readResolvedCerebrum,
  listMandatoryFor,
  CEREBRUM_V2_HEADER,
} from '../lib/stores/cerebrum.mjs';

function freshDir(t) {
  const dir = path.join(os.tmpdir(), 'sextant-read-race-' + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Parse text and return only its rule entries (the shape appendEntries wants).
const ruleEntries = (text) => parseCerebrum(text).lines.filter((e) => e.kind === 'rule');

const NODE_PATH = 'lib/race.mjs';

test('injection read path: concurrent reads never observe a torn/empty cerebrum during a hammered write', async (t) => {
  const dir = freshDir(t);
  const file = path.join(dir, 'cerebrum.md');

  // Seed a FIXED set of mandatory rules: 3 globals + 2 node rules on NODE_PATH.
  // These are never touched by the writer loop, so the mandatory count is an
  // invariant every read must observe.
  const seed = CEREBRUM_V2_HEADER + '\n'
    + '- 2026-01-01: [global] constitution one\n'
    + '- 2026-01-01: [global] constitution two\n'
    + '- 2026-01-01: [global] constitution three\n'
    + `- 2026-01-01: [node:${NODE_PATH}] node rule one\n`
    + `- 2026-01-01: [node:${NODE_PATH}] node rule two\n`;
  await fs.writeFile(file, seed, 'utf8');

  // Baseline: read the mandatory count once and assert it is non-vacuous. This
  // also proves [global]/[node:] survive normalizeV2Buckets → listMandatoryFor.
  const baseline = await readResolvedCerebrum(dir);
  const K = listMandatoryFor(baseline.parsed, NODE_PATH).length;
  assert.ok(K > 0, 'seed must produce mandatory rules');
  assert.equal(K, 5, 'expected 3 globals + 2 node rules');

  const ITERS = 200;
  const READERS = 8;

  // Writer: append a fresh [provisional] churn rule each iteration, varying the
  // body by index so size/mtime change every write. Provisional rules are NOT
  // mandatory (listMandatoryFor skips !review), so the mandatory count stays K
  // no matter how many churn rules land. updateCerebrumFile may return null on a
  // rare lock-timeout — harmless here; the next write still renames atomically.
  const writer = (async () => {
    for (let i = 0; i < ITERS; i++) {
      const body = `- 2026-01-01: [provisional] churn rule ${i} ${'x'.repeat(i % 40)}`;
      await updateCerebrumFile(file, (p) => {
        ensureV2Header(p);
        appendEntries(p, ruleEntries(body));
      });
    }
  })();

  // Readers: drive the production read path concurrently with the writer. A
  // torn/empty read throws in parse or returns < K — both fail the assertion.
  const readers = Array.from({ length: READERS }, () => (async () => {
    for (let i = 0; i < ITERS; i++) {
      const { parsed } = await readResolvedCerebrum(dir);
      const m = listMandatoryFor(parsed, NODE_PATH).length;
      assert.equal(m, K, `read observed ${m} mandatory rules, expected ${K} (torn/empty read?)`);
    }
  })());

  await Promise.all([writer, ...readers]);
});
