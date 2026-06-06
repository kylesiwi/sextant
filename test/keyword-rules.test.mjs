// cerebrum-v2 / tranche T3 (3b): the v1/v2 keyword-rule resolver
// (lib/retrieval/keywordRules.mjs).
//
// Covers the 3b verification gates:
//   - cold-start: a 0/1-rule store fires [!] exact-floor rules with no BM25 IDF
//     dependence;
//   - exact-floor invariant: the 4 pinned sextant safety rules always surface on
//     an exact word-boundary keyword match, regardless of BM25 score/cache;
//   - BM25 ranked tier at READ minScore; WRITE minScore surfaces strictly more;
//   - [provisional] rules surface ONLY above the high PROVISIONAL floor (never via
//     the word-boundary passes; never at READ/WRITE);
//   - Bash = exact word-boundary only (no BM25), provisional excluded there too;
//   - field-scoped query is robust to path/command corpora (colons/slashes) and
//     never bleeds non-kw rules in;
//   - v1 fallback keeps the legacy critical/general/legacy engine unchanged.
//
// Score note: BM25 over the boost-12 `keywords` field scores a direct single-term
// match very high (~4). To exercise the thresholds we use a fixture of N rules
// sharing one common term (low IDF) which drives that term's score into the
// (WRITE 0.15, READ 0.3) band — see WRITE-vs-READ / provisional tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';
import { resolveKeywordMatches, passesKeywordFloor } from '../lib/retrieval/keywordRules.mjs';
import { _resetCacheForTests, KW_MINSCORE } from '../lib/retrieval/lunr-index.mjs';

function freshDir(t) {
  const dir = path.join(os.tmpdir(), 'sextant-kwrules-' + crypto.randomUUID());
  fsSync.mkdirSync(path.join(dir, 'cerebrum'), { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  _resetCacheForTests();
  return dir;            // durableBase; cerebrum dir is <dir>/cerebrum
}

// Seed a v2 one store directly (header + raw v2 rule lines), no migration needed.
async function seedV2(dir, body) {
  await fs.writeFile(
    path.join(dir, 'cerebrum', 'cerebrum.md'),
    CEREBRUM_V2_HEADER + '\n' + body,
    'utf8',
  );
}
const cerebrumDirOf = (dir) => path.join(dir, 'cerebrum');

function bodies(matches) {
  return matches.map((m) => m.rule.body);
}
async function resolve(dir, corpus, mode = 'READ', env) {
  return resolveKeywordMatches({
    cerebrumDir: cerebrumDirOf(dir), durableBase: dir, corpus, mode, env,
  });
}

// -- passesKeywordFloor (pure threshold policy) -----------------------------

test('passesKeywordFloor: normal rule clears READ/WRITE base; provisional needs the high floor', () => {
  const { READ, WRITE, PROVISIONAL } = KW_MINSCORE;
  // normal rule, READ base
  assert.equal(passesKeywordFloor(0.31, false, READ, PROVISIONAL), true);
  assert.equal(passesKeywordFloor(0.29, false, READ, PROVISIONAL), false);
  // normal rule, WRITE base (more permissive)
  assert.equal(passesKeywordFloor(0.2, false, WRITE, PROVISIONAL), true);
  assert.equal(passesKeywordFloor(0.1, false, WRITE, PROVISIONAL), false);
  // provisional rule: must clear PROVISIONAL regardless of base
  assert.equal(passesKeywordFloor(0.5, true, READ, PROVISIONAL), false, 'mid score below provisional floor is dropped');
  assert.equal(passesKeywordFloor(0.85, true, READ, PROVISIONAL), true);
  assert.equal(passesKeywordFloor(0.85, true, WRITE, PROVISIONAL), true);
});

// -- cold start (exact-floor, no BM25 dependence) ---------------------------

test('cold start: a 1-rule store fires its [!] kw rule via the exact word-boundary floor', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, '- 2026-05-01: [kw:rollback] [!] never rollback prod\n');
  const m = await resolve(dir, 'I am about to rollback the prod database', 'READ');
  assert.deepEqual(bodies(m), ['never rollback prod']);
  assert.equal(m[0].trigger, 'critical', '[!] floor fires always (critical)');
});

test('cold start: an empty store returns no matches and does not throw', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, '');
  assert.deepEqual(await resolve(dir, 'anything at all', 'READ'), []);
  assert.deepEqual(await resolve(dir, 'anything at all', 'BASH'), []);
});

// -- exact-floor invariant: the 4 pinned sextant safety rules ----------------

// Single-word (comma-separated) keywords: kw buckets split on comma, so a
// space-separated entry is one phrase term — these mirror the real pinned set as
// individual word-boundary keywords. ('dev/null', not '/dev/null': a leading
// slash defeats the leading \b — see spec § caveat.)
const SAFETY = [
  { kw: 'kw:dev/null, sandbox', body: 'write only inside the sandbox or dev/null', probe: 'cp secrets /dev/null' },
  { kw: 'kw:installed', body: 'do not edit the installed copy', probe: 'editing the installed copy of the plugin' },
  { kw: 'kw:bump', body: 'bump versions on every change', probe: 'remember to bump the version field' },
  { kw: 'kw:overwrite, plugin', body: 'do not overwrite plugin source', probe: 'about to overwrite the plugin source tree' },
];

test('exact-floor invariant: every pinned [!] safety rule surfaces on its keyword (READ + BASH)', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, SAFETY.map((r, i) => `- 2026-05-0${i + 1}: [${r.kw}] [!] ${r.body}\n`).join(''));
  for (const r of SAFETY) {
    for (const mode of ['READ', 'BASH']) {
      const m = await resolve(dir, r.probe, mode);
      assert.ok(bodies(m).includes(r.body), `${r.body} surfaces in ${mode} mode`);
      const hit = m.find((x) => x.rule.body === r.body);
      assert.equal(hit.trigger, 'critical', `${r.body} is an always-emit (critical) [!] fire`);
    }
  }
});

// -- BM25 ranked tier: WRITE surfaces strictly more than READ ----------------

// N rules sharing one term → low IDF. At N=20 the shared term scores ~0.289,
// inside (WRITE 0.15, READ 0.3); kept under the KW_QUERY_K=25 cap so every
// matching rule is returned (no silent truncation in the assertion).
function sharedTermStore(term, n, extra = '') {
  let body = '';
  for (let i = 0; i < n; i++) body += `- 2026-05-01: [kw:${term}] shared rule ${i}\n`;
  return body + extra;
}

test('BM25: a weak shared-term match clears WRITE (0.15) but not READ (0.3) — WRITE surfaces strictly more', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, sharedTermStore('logger', 20));
  const read = await resolve(dir, 'add a logger call here', 'READ');
  const write = await resolve(dir, 'add a logger call here', 'WRITE');
  assert.equal(read.length, 0, 'weak match (~0.289) is below the READ floor 0.3');
  assert.equal(write.length, 20, 'the same weak match clears the WRITE floor 0.15');
});

test('BM25: a strong unique-term match surfaces at READ minScore', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, sharedTermStore('logger', 20, '- 2026-06-01: [kw:idempotency] make migrations idempotent\n'));
  const m = await resolve(dir, 'is this idempotency guaranteed', 'READ');
  assert.deepEqual(bodies(m), ['make migrations idempotent']);
});

// -- [provisional]: high floor only -----------------------------------------

test('provisional: a weak (mid-score) provisional match does NOT surface even at WRITE; normal rules do', async (t) => {
  const dir = freshDir(t);
  // 19 normal [kw:logger] rules + 1 provisional [kw:logger] rule → all score ~0.289.
  await seedV2(dir,
    sharedTermStore('logger', 19) +
    '- 2026-06-01: [provisional] [kw:logger] provisional logger note\n',
  );
  const write = await resolve(dir, 'add a logger here', 'WRITE');
  assert.equal(write.length, 19, 'normal rules clear WRITE 0.15');
  assert.ok(!bodies(write).includes('provisional logger note'),
    'provisional rule below the 0.8 floor is suppressed even when normal peers fire');
});

test('provisional: a STRONG provisional match (score ≥ 0.8) does surface', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir,
    sharedTermStore('logger', 10) +
    '- 2026-06-01: [provisional] [kw:quarkfield] provisional quark note\n',
  );
  const m = await resolve(dir, 'investigating the quarkfield subsystem', 'READ');
  assert.ok(bodies(m).includes('provisional quark note'), 'a strong unique-term provisional match clears 0.8');
});

test('provisional: never fires via the word-boundary path (Bash) even on an exact keyword hit', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir,
    '- 2026-06-01: [provisional] [kw:quarkfield] provisional quark note\n' +
    '- 2026-06-02: [kw:quarkfield] [!] safety quark rule\n',
  );
  const bash = await resolve(dir, 'touching the quarkfield module', 'BASH');
  assert.ok(bodies(bash).includes('safety quark rule'), '[!] kw rule fires on Bash word-boundary');
  assert.ok(!bodies(bash).includes('provisional quark note'), 'provisional excluded from the Bash word-boundary path');
});

// -- Bash: word-boundary only, no BM25 --------------------------------------

test('Bash: matches all non-provisional kw rules by exact word-boundary; [!] is critical, others general', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir,
    '- 2026-06-01: [kw:rm] [!] confirm before rm -rf\n' +
    '- 2026-06-02: [kw:docker] use the project compose file\n',
  );
  const m = await resolve(dir, 'rm -rf build && docker compose up', 'BASH');
  const byBody = Object.fromEntries(m.map((x) => [x.rule.body, x.trigger]));
  assert.equal(byBody['confirm before rm -rf'], 'critical', '[!] rule is always-emit');
  assert.equal(byBody['use the project compose file'], 'general', 'non-[!] rule is throttle-eligible');
});

test('Bash: a substring (no word boundary) does NOT fire', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, '- 2026-06-01: [kw:cat] [!] cat rule\n');
  // 'concatenate' contains "cat" as a substring but not on a word boundary.
  assert.deepEqual(await resolve(dir, 'concatenate the files', 'BASH'), []);
});

// -- field-scoping robustness ------------------------------------------------

test('path-shaped corpus (colons/slashes) does not crash and matches via tokenized terms', async (t) => {
  const dir = freshDir(t);
  await seedV2(dir, '- 2026-06-01: [kw:login] [!] auth rule\n- 2026-06-02: [kw:unrelated] other\n');
  const m = await resolve(dir, 'src/auth/login.ts:42', 'READ');
  assert.ok(bodies(m).includes('auth rule'), 'tokenized "login" term matches; query did not throw to []');
  assert.ok(!bodies(m).includes('other'));
});

test('BM25 keyword query does not bleed in non-kw rules that only body-match', async (t) => {
  const dir = freshDir(t);
  // A node rule whose BODY contains "authentication"; no kw bucket.
  await seedV2(dir,
    '- 2026-06-01: [node:lib/auth.mjs] handles authentication and login flow\n' +
    '- 2026-06-02: [kw:billing] billing rule\n',
  );
  const m = await resolve(dir, 'authentication login', 'READ');
  assert.deepEqual(m, [], 'field-scoped keywords query never surfaces a non-kw rule via its body');
});

// (v1 fallback tests removed — the SEXTANT_CEREBRUM_V2 kill-switch + v1 read path
// are retired in T3.5; cerebrum.md is the single authoritative store.)
