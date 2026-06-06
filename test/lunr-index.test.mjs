// Tests for lib/retrieval/lunr-index.mjs — Lunr BM25 retrieval over cerebrum
// + bugs.
//
// Coverage targets:
//   - buildCerebrumIndex on a synthetic parsed cerebrum returns useful search
//     results.
//   - buildBugsIndex on synthetic bugs returns useful search results.
//   - mtime cache: loadCerebrumIndex twice with no file change returns cached
//     (same index instance); bumping the mtime forces a re-read.
//   - search returns top-k results sorted descending by score.
//   - minScore filtering excludes below-threshold matches.
//   - Empty corpus → search returns [].
//   - Defensive: malformed query doesn't crash; returns [].

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  buildCerebrumIndex,
  buildBugsIndex,
  search,
  loadCerebrumIndex,
  loadBugsIndex,
  _resetCacheForTests,
} from '../lib/retrieval/lunr-index.mjs';
import { parseCerebrum } from '../lib/stores/cerebrum.mjs';

// --- helpers ---------------------------------------------------------------

function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-lunr-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tmpRoot(t) {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function ruleEntry(raw, body, buckets = []) {
  return {
    raw,
    kind: 'rule',
    date: '2026-05-10',
    buckets,
    body,
    match: null,
    bySession: null,
    markers: [],
  };
}

// --- buildCerebrumIndex ----------------------------------------------------

test('buildCerebrumIndex: indexes rule entries + ignores non-rule lines', () => {
  const parsed = {
    lines: [
      { kind: 'header', raw: '# Rules', date: null, buckets: [], body: null, match: null, bySession: null, markers: [] },
      ruleEntry(
        '- 2026-05-10: [!global] validateToken should return a boolean',
        'validateToken should return a boolean',
        ['!global'],
      ),
      ruleEntry(
        '- 2026-05-10: [node:src/auth.ts] refreshToken needs await before returning',
        'refreshToken needs await before returning',
        ['node:src/auth.ts'],
      ),
      ruleEntry(
        '- 2026-05-10: [node:src/api.ts] always send Content-Type header',
        'always send Content-Type header',
        ['node:src/api.ts'],
      ),
      { kind: 'blank', raw: '', date: null, buckets: [], body: null, match: null, bySession: null, markers: [] },
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  assert.equal(docs.size, 3);
  const hits = search(index, docs, 'validateToken');
  assert.ok(hits.length >= 1, `expected at least one hit for validateToken; got ${hits.length}`);
  assert.match(hits[0].doc.body, /validateToken/);
});

test('buildCerebrumIndex: [kw:] terms are indexed in the high-boost keywords field (T3)', () => {
  const parsed = {
    lines: [
      ruleEntry(
        '- 2026-05-10: [kw:deploy, rollback] coordinate the release runbook',
        'coordinate the release runbook',
        ['kw:deploy, rollback'],
      ),
      ruleEntry(
        '- 2026-05-10: [node:src/x.ts] some unrelated note that mentions deploy in passing',
        'some unrelated note that mentions deploy in passing',
        ['node:src/x.ts'],
      ),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  // 'rollback' lives ONLY in the kw tag (not in any body) → matchable proves the
  // keywords field is indexed. (Score *ordering* is a 3b tuning concern, not a 3a
  // correctness invariant — Lunr's length-norm makes strict ordering brittle.)
  const rb = search(index, docs, 'rollback');
  assert.ok(rb.some((h) => h.doc.keywords.includes('rollback')), 'kw rule matched on its tagged term');
  // The kw rule matches 'deploy' via its keywords field even though its OWN body
  // ('coordinate the release runbook') never contains the word.
  const dep = search(index, docs, 'deploy');
  const kwHit = dep.find((h) => h.doc.keywords.includes('deploy'));
  assert.ok(kwHit, 'kw-tagged rule is a hit for its tagged term via the keywords field');
  assert.ok(!/deploy/.test(kwHit.doc.body), 'and it matched on the tag, not the body');
});

test('buildCerebrumIndex: keywordsOf strips v1 scoring markers (* and ;min=) (T3)', () => {
  const parsed = {
    lines: [
      ruleEntry('- 2026-05-10: [kw:*WSL2, env ; min=2] shell note', 'shell note', ['kw:*WSL2, env ; min=2']),
      ruleEntry('- 2026-05-10: [node:a.ts] plain note', 'plain note', ['node:a.ts']),
    ],
  };
  const { docs } = buildCerebrumIndex(parsed);
  const kwDoc = [...docs.values()].find((d) => d.keywords.length > 0);
  assert.equal(kwDoc.keywords, 'WSL2 env');
});

test('buildCerebrumIndex: empty parsed → empty docs, search returns []', () => {
  const { index, docs } = buildCerebrumIndex({ lines: [] });
  assert.equal(docs.size, 0);
  assert.deepEqual(search(index, docs, 'whatever'), []);
});

test('buildCerebrumIndex: skips rules with empty body', () => {
  const parsed = {
    lines: [
      ruleEntry('- 2026-05-10: [!global]', '', ['!global']),
      ruleEntry(
        '- 2026-05-10: [!global] keep this rule',
        'keep this rule',
        ['!global'],
      ),
    ],
  };
  const { docs } = buildCerebrumIndex(parsed);
  assert.equal(docs.size, 1);
});

test('buildCerebrumIndex: sources tag is node:<path> when present, else global', () => {
  const parsed = {
    lines: [
      ruleEntry('- 2026-05-10: [!global] rule a', 'alpha rule body', ['!global']),
      ruleEntry('- 2026-05-10: [node:src/auth.ts] rule b', 'beta rule body', ['node:src/auth.ts']),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  const a = Array.from(docs.values()).find((d) => d.body.startsWith('alpha'));
  const b = Array.from(docs.values()).find((d) => d.body.startsWith('beta'));
  assert.equal(a.source, 'global');
  assert.equal(b.source, 'node:src/auth.ts');
  // sanity: index is queryable
  const hits = search(index, docs, 'beta');
  assert.ok(hits.length >= 1);
});

// --- buildBugsIndex --------------------------------------------------------

test('buildBugsIndex: indexes bugs + search by error_message', () => {
  const bugs = [
    {
      id: 'bug-1',
      file: 'src/api/auth.ts',
      graph_node: 'validateToken',
      error_message: 'TypeError on validateToken response',
      root_cause: 'response was undefined',
      fix: 'optional chaining',
      tags: ['null-check'],
    },
    {
      id: 'bug-2',
      file: 'src/api/auth.ts',
      graph_node: 'refreshToken',
      error_message: 'NetworkError: ECONNRESET',
      root_cause: 'upstream flake',
      fix: 'added retry',
      tags: ['network'],
    },
  ];
  const { index, docs } = buildBugsIndex(bugs);
  assert.equal(docs.size, 2);
  const hits = search(index, docs, 'validateToken');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'bug-1');
});

test('buildBugsIndex: empty corpus → search returns []', () => {
  const { index, docs } = buildBugsIndex([]);
  assert.equal(docs.size, 0);
  assert.deepEqual(search(index, docs, 'anything'), []);
});

// --- search semantics ------------------------------------------------------

test('search: results sorted descending by score', () => {
  // Build a corpus where one rule mentions 'validateToken' a lot, the other
  // mentions it once. The first should rank higher.
  const parsed = {
    lines: [
      ruleEntry(
        '- 2026-05-10: [!global] validateToken validateToken validateToken — core check',
        'validateToken validateToken validateToken — core check',
        ['!global'],
      ),
      ruleEntry(
        '- 2026-05-10: [node:src/auth.ts] validateToken only mentioned once here',
        'validateToken only mentioned once here',
        ['node:src/auth.ts'],
      ),
      ruleEntry(
        '- 2026-05-10: [!global] unrelated rule about disk caching',
        'unrelated rule about disk caching',
        ['!global'],
      ),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  const hits = search(index, docs, 'validateToken', 5, 0);
  assert.ok(hits.length >= 2, `expected ≥2 hits; got ${hits.length}`);
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score,
      `result ${i - 1} score=${hits[i - 1].score} should be >= ${i} score=${hits[i].score}`);
  }
});

test('search: minScore filters out below-threshold matches', () => {
  const parsed = {
    lines: [
      ruleEntry(
        '- 2026-05-10: [!global] validateToken core rule body',
        'validateToken core rule body',
        ['!global'],
      ),
      ruleEntry(
        '- 2026-05-10: [!global] secondary rule mentions validateToken weakly',
        'secondary rule mentions validateToken weakly',
        ['!global'],
      ),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);

  // First gather raw scores so we can compute a threshold that excludes one.
  const allHits = search(index, docs, 'validateToken', 5, 0);
  assert.equal(allHits.length, 2);
  // Slice threshold between the two scores.
  const threshold = (allHits[0].score + allHits[1].score) / 2;
  const filtered = search(index, docs, 'validateToken', 5, threshold);
  assert.equal(filtered.length, 1);
  assert.ok(filtered[0].score >= threshold);
});

test('search: respects topK limit', () => {
  const lines = [];
  for (let i = 0; i < 10; i++) {
    lines.push(ruleEntry(
      `- 2026-05-10: [!global] alpha rule number ${i}`,
      `alpha rule number ${i}`,
      ['!global'],
    ));
  }
  const { index, docs } = buildCerebrumIndex({ lines });
  const hits = search(index, docs, 'alpha', 3, 0);
  assert.equal(hits.length, 3);
});

test('search: malformed query returns [] without throwing', () => {
  const parsed = {
    lines: [
      ruleEntry('- 2026-05-10: [!global] some rule', 'some rule', ['!global']),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  // Lunr throws on stray colons (no field by that name).
  assert.deepEqual(search(index, docs, ':bogus:'), []);
  // Unbalanced operators.
  assert.deepEqual(search(index, docs, 'foo +'), []);
  // Empty / whitespace.
  assert.deepEqual(search(index, docs, ''), []);
  assert.deepEqual(search(index, docs, '   '), []);
});

test('search: result shape includes id, score, doc', () => {
  const parsed = {
    lines: [
      ruleEntry(
        '- 2026-05-10: [!global] rule body for shape test',
        'rule body for shape test',
        ['!global'],
      ),
    ],
  };
  const { index, docs } = buildCerebrumIndex(parsed);
  const hits = search(index, docs, 'shape', 5, 0);
  assert.equal(hits.length, 1);
  assert.equal(typeof hits[0].id, 'string');
  assert.equal(typeof hits[0].score, 'number');
  assert.equal(typeof hits[0].doc, 'object');
  assert.match(hits[0].doc.body, /shape test/);
});

// --- mtime cache (loadCerebrumIndex / loadBugsIndex) -----------------------

test('loadCerebrumIndex: caches on second call when mtime unchanged', async (t) => {
  const root = tmpRoot(t);
  const dir = path.join(root, 'cerebrum');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'regular.md');
  await fs.writeFile(file,
    '- 2026-05-10: [!global] validateToken needs a boolean check\n',
    'utf8',
  );
  _resetCacheForTests();

  const a = await loadCerebrumIndex(root);
  const b = await loadCerebrumIndex(root);
  // Same instance (since the cache key is the file path and mtime is identical).
  assert.equal(a.index, b.index);
  assert.equal(a.docs, b.docs);
  // And the index is queryable.
  const hits = search(a.index, a.docs, 'validateToken', 5, 0);
  assert.ok(hits.length >= 1);
});

test('loadCerebrumIndex: re-reads when mtime advances', async (t) => {
  const root = tmpRoot(t);
  const dir = path.join(root, 'cerebrum');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'regular.md');
  await fs.writeFile(file, '- 2026-05-10: [!global] first rule body\n', 'utf8');
  _resetCacheForTests();

  const a = await loadCerebrumIndex(root);
  const hitsA = search(a.index, a.docs, 'first', 5, 0);
  assert.ok(hitsA.length >= 1);

  // Mutate. We bump mtime explicitly to avoid sub-millisecond stat collisions
  // on some filesystems (test runners can be fast enough to land on the same
  // mtimeMs as the original write).
  await fs.writeFile(file,
    '- 2026-05-10: [!global] second rule appears now\n',
    'utf8',
  );
  // Bump mtime forward to ensure stat sees it as fresh.
  const future = new Date(Date.now() + 2000);
  await fs.utimes(file, future, future);

  const b = await loadCerebrumIndex(root);
  assert.notEqual(a.index, b.index, 'index must be rebuilt after mtime advance');
  const hitsB = search(b.index, b.docs, 'second', 5, 0);
  assert.ok(hitsB.length >= 1);
});

test('loadCerebrumIndex: missing file returns empty index, search returns []', async (t) => {
  const root = tmpRoot(t);
  _resetCacheForTests();
  const { index, docs } = await loadCerebrumIndex(root);
  assert.deepEqual(search(index, docs, 'anything'), []);
});

test('loadBugsIndex: caches on second call when mtime unchanged', async (t) => {
  const root = tmpRoot(t);
  await fs.mkdir(root, { recursive: true });
  const bugsPath = path.join(root, 'bugs.json');
  await fs.writeFile(bugsPath, JSON.stringify([
    {
      id: 'bug-1',
      file: 'src/api.ts',
      graph_node: 'validateToken',
      error_message: 'TypeError: validateToken returned undefined',
      root_cause: 'r',
      fix: 'f',
      tags: ['null'],
    },
  ]), 'utf8');
  _resetCacheForTests();

  const a = await loadBugsIndex(root);
  const b = await loadBugsIndex(root);
  assert.equal(a.index, b.index);
  const hits = search(a.index, a.docs, 'validateToken', 5, 0);
  assert.equal(hits[0].id, 'bug-1');
});

test('loadBugsIndex: missing bugs.json returns empty', async (t) => {
  const root = tmpRoot(t);
  _resetCacheForTests();
  const { index, docs } = await loadBugsIndex(root);
  assert.equal(docs.size, 0);
  assert.deepEqual(search(index, docs, 'anything'), []);
});

// --- Sanity: end-to-end with real cerebrum.parse ---------------------------

test('parseCerebrum → buildCerebrumIndex: round trip indexes parsed rules', () => {
  const text = [
    '# Rules',
    '',
    '- 2026-05-10: [!global] always use prettier',
    '- 2026-05-10: [node:src/auth.ts] refreshToken should await response.json()',
    '- 2026-05-10: [node:src/db.ts] use parameterized queries (no string concat)',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const { index, docs } = buildCerebrumIndex(parsed);
  assert.equal(docs.size, 3);
  const hits = search(index, docs, 'refreshToken', 5, 0);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].doc.body, /refreshToken/);
});
