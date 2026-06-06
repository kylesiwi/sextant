// Tests for lib/stores/bugs.mjs — pure I/O + index helpers over bugs.json.
//
// All file-touching tests use an isolated tmp directory as the durable base
// so the project's .sextant/ is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  readBugs,
  writeBugs,
  addBug,
  findBugsForFile,
  findBugsForSymbol,
  countOpenBugs,
  mostRecentUnfixedFor,
  tagBugSymbol,
  BUGS_FILE,
} from '../lib/stores/bugs.mjs';

import {
  SCHEMA_VERSION,
  NODE_TYPES,
  GRAPH,
  NODE,
  fileNodeId,
} from '../lib/graph/schema.mjs';

function freshTmpDir(t) {
  const d = path.join(os.tmpdir(), 'sextant-bugs-' + crypto.randomUUID());
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function makeBug(overrides) {
  return {
    ts: '2026-05-10T14:33:00Z',
    session_id: 'sess-1',
    file: 'src/api/auth.ts',
    error_message: 'TypeError: Cannot read properties of undefined',
    root_cause: 'API response was null',
    fix: 'Added optional chaining',
    fix_verified: false,
    verified_ts: null,
    verified_by: null,
    tags: [],
    ...overrides,
  };
}

// ---- readBugs --------------------------------------------------------------

test('readBugs: ENOENT → []', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  const bugs = await readBugs(dir);
  assert.deepEqual(bugs, []);
});

test('readBugs: malformed JSON → []', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, BUGS_FILE), '{not-json', 'utf8');
  const bugs = await readBugs(dir);
  assert.deepEqual(bugs, []);
});

test('readBugs: returns parsed array', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  const data = [makeBug({ id: 'bug-1' })];
  await fs.writeFile(path.join(dir, BUGS_FILE), JSON.stringify(data), 'utf8');
  const bugs = await readBugs(dir);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].id, 'bug-1');
});

test('readBugs: non-array shape → []', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, BUGS_FILE), JSON.stringify({ id: 'bug-1' }), 'utf8');
  const bugs = await readBugs(dir);
  assert.deepEqual(bugs, []);
});

// ---- writeBugs round-trip --------------------------------------------------

test('writeBugs: round-trips an array', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  const data = [makeBug({ id: 'bug-1' }), makeBug({ id: 'bug-2' })];
  await writeBugs(dir, data);
  const back = await readBugs(dir);
  assert.deepEqual(back, data);
});

test('writeBugs: rejects non-array input', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  await assert.rejects(() => writeBugs(dir, { id: 'bug-1' }), /must be an array/);
});

// ---- addBug ----------------------------------------------------------------

test('addBug: allocates incrementing ids starting at bug-1', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  const a = await addBug(dir, makeBug({ error_message: 'a' }));
  const b = await addBug(dir, makeBug({ error_message: 'b' }));
  const c = await addBug(dir, makeBug({ error_message: 'c' }));
  assert.equal(a.id, 'bug-1');
  assert.equal(b.id, 'bug-2');
  assert.equal(c.id, 'bug-3');

  const persisted = await readBugs(dir);
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.map((x) => x.id), ['bug-1', 'bug-2', 'bug-3']);
});

test('addBug: preserves caller-provided fields', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  const r = await addBug(dir, makeBug({ tags: ['t1', 't2'], error_message: 'X' }));
  assert.equal(r.error_message, 'X');
  assert.deepEqual(r.tags, ['t1', 't2']);
  assert.equal(r.id, 'bug-1');
});

test('addBug: rejects non-object entry', async (t) => {
  const dir = freshTmpDir(t);
  await ensureDir(dir);
  await assert.rejects(() => addBug(dir, null), /must be an object/);
});

// ---- findBugsForFile -------------------------------------------------------

test('findBugsForFile: filters to entries matching file', () => {
  const bugs = [
    makeBug({ id: 'bug-1', file: 'src/a.ts' }),
    makeBug({ id: 'bug-2', file: 'src/b.ts' }),
    makeBug({ id: 'bug-3', file: 'src/a.ts' }),
  ];
  const r = findBugsForFile(bugs, 'src/a.ts');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.id), ['bug-1', 'bug-3']);
});

test('findBugsForFile: empty input returns []', () => {
  assert.deepEqual(findBugsForFile([], 'src/x.ts'), []);
  assert.deepEqual(findBugsForFile(null, 'src/x.ts'), []);
});

// ---- findBugsForSymbol -----------------------------------------------------

test('findBugsForSymbol: filters by file AND graph_node', () => {
  const bugs = [
    makeBug({ id: 'bug-1', file: 'src/a.ts', graph_node: 'foo' }),
    makeBug({ id: 'bug-2', file: 'src/a.ts', graph_node: 'bar' }),
    makeBug({ id: 'bug-3', file: 'src/b.ts', graph_node: 'foo' }),
  ];
  const r = findBugsForSymbol(bugs, 'src/a.ts', 'foo');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'bug-1');
});

test('findBugsForSymbol: no match returns []', () => {
  const bugs = [makeBug({ id: 'bug-1', file: 'src/a.ts', graph_node: 'foo' })];
  assert.deepEqual(findBugsForSymbol(bugs, 'src/a.ts', 'baz'), []);
});

// ---- countOpenBugs ---------------------------------------------------------

test('countOpenBugs: ignores fix_verified', () => {
  const bugs = [
    makeBug({ id: 'bug-1', fix_verified: false }),
    makeBug({ id: 'bug-2', fix_verified: true }),
    makeBug({ id: 'bug-3', fix_verified: false }),
    makeBug({ id: 'bug-4', fix_verified: true }),
  ];
  assert.equal(countOpenBugs(bugs), 2);
});

test('countOpenBugs: empty / invalid input returns 0', () => {
  assert.equal(countOpenBugs([]), 0);
  assert.equal(countOpenBugs(null), 0);
  assert.equal(countOpenBugs(undefined), 0);
});

// ---- mostRecentUnfixedFor --------------------------------------------------

test('mostRecentUnfixedFor: picks the entry with the latest ts', () => {
  const bugs = [
    makeBug({ id: 'bug-1', ts: '2026-05-10T10:00:00Z' }),
    makeBug({ id: 'bug-2', ts: '2026-05-10T15:00:00Z' }),
    makeBug({ id: 'bug-3', ts: '2026-05-10T12:00:00Z' }),
  ];
  const r = mostRecentUnfixedFor(bugs, 'src/api/auth.ts');
  assert.ok(r);
  assert.equal(r.id, 'bug-2');
});

test('mostRecentUnfixedFor: skips fix_verified entries', () => {
  const bugs = [
    makeBug({ id: 'bug-1', ts: '2026-05-10T15:00:00Z', fix_verified: true }),
    makeBug({ id: 'bug-2', ts: '2026-05-10T10:00:00Z', fix_verified: false }),
  ];
  const r = mostRecentUnfixedFor(bugs, 'src/api/auth.ts');
  assert.ok(r);
  assert.equal(r.id, 'bug-2');
});

test('mostRecentUnfixedFor: no match returns null', () => {
  const bugs = [makeBug({ id: 'bug-1', file: 'src/x.ts' })];
  assert.equal(mostRecentUnfixedFor(bugs, 'src/y.ts'), null);
});

test('mostRecentUnfixedFor: all verified returns null', () => {
  const bugs = [makeBug({ id: 'bug-1', fix_verified: true })];
  assert.equal(mostRecentUnfixedFor(bugs, 'src/api/auth.ts'), null);
});

// ---- tagBugSymbol ----------------------------------------------------------

function makeGraph(nodes) {
  return {
    [GRAPH.SCHEMA_VERSION]: SCHEMA_VERSION,
    [GRAPH.NODES]: nodes,
    [GRAPH.EDGES]: [],
    [GRAPH.BUILT_AT]: '2026-05-10T00:00:00Z',
    [GRAPH.STATS]: { files: nodes.length, edges: 0 },
  };
}

function makeFileNode(rel, symbols) {
  return {
    [NODE.ID]: fileNodeId(rel),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: rel.split('/').pop(),
    [NODE.PATH]: rel,
    [NODE.SYMBOLS]: symbols,
    [NODE.COMMUNITY]: null,
  };
}

test('tagBugSymbol: unique symbol in error_message → symbol-match', () => {
  const graph = makeGraph([
    makeFileNode('src/api/auth.ts', ['validateToken', 'refreshToken']),
  ]);
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'TypeError in validateToken when token is null',
      root_cause: 'no fallback',
    }),
  ];
  const r = tagBugSymbol(bugs, graph);
  assert.equal(r.tagged, 1);
  assert.equal(r.untagged, 0);
  assert.equal(r.bugs[0].graph_node, 'validateToken');
  assert.equal(r.bugs[0].graph_node_confidence, 'symbol-match');
});

test('tagBugSymbol: symbol present in root_cause also matches', () => {
  const graph = makeGraph([
    makeFileNode('src/api/auth.ts', ['validateToken']),
  ]);
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'TypeError',
      root_cause: 'validateToken returned undefined',
    }),
  ];
  const r = tagBugSymbol(bugs, graph);
  assert.equal(r.tagged, 1);
  assert.equal(r.bugs[0].graph_node, 'validateToken');
});

test('tagBugSymbol: no symbol match → file-level fallback', () => {
  const graph = makeGraph([
    makeFileNode('src/api/auth.ts', ['validateToken']),
  ]);
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'unknown error type',
      root_cause: 'something else',
    }),
  ];
  const r = tagBugSymbol(bugs, graph);
  assert.equal(r.tagged, 0);
  assert.equal(r.untagged, 1);
  assert.equal(r.bugs[0].graph_node, 'src/api/auth.ts');
  assert.equal(r.bugs[0].graph_node_confidence, 'file-level');
});

test('tagBugSymbol: whole-word match — substring should NOT match', () => {
  const graph = makeGraph([
    makeFileNode('src/api/auth.ts', ['Token']),
  ]);
  // "validateToken" contains "Token" as substring; \b boundary rejects it.
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'validateToken failed',
      root_cause: 'oops',
    }),
  ];
  const r = tagBugSymbol(bugs, graph);
  // "Token" doesn't appear as a whole word in 'validateToken' (it's part of
  // the camelCase identifier). So we fall back to file-level.
  assert.equal(r.tagged, 0);
  assert.equal(r.bugs[0].graph_node_confidence, 'file-level');
});

test('tagBugSymbol: already-tagged entries are left alone', () => {
  const graph = makeGraph([makeFileNode('src/x.ts', ['foo'])]);
  const bugs = [
    {
      ...makeBug({ file: 'src/x.ts', error_message: 'foo broke' }),
      graph_node: 'manually-set',
      graph_node_confidence: 'symbol-match',
    },
  ];
  const r = tagBugSymbol(bugs, graph);
  assert.equal(r.tagged, 0);
  assert.equal(r.untagged, 0);
  assert.equal(r.bugs[0].graph_node, 'manually-set');
});

test('tagBugSymbol: missing graph → file-level fallback', () => {
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'some error',
    }),
  ];
  const r = tagBugSymbol(bugs, null);
  assert.equal(r.tagged, 0);
  assert.equal(r.untagged, 1);
  assert.equal(r.bugs[0].graph_node, 'src/api/auth.ts');
  assert.equal(r.bugs[0].graph_node_confidence, 'file-level');
});

test('tagBugSymbol: file not in graph → file-level fallback', () => {
  const graph = makeGraph([makeFileNode('src/other.ts', ['x'])]);
  const bugs = [
    makeBug({
      file: 'src/api/auth.ts',
      error_message: 'something',
    }),
  ];
  const r = tagBugSymbol(bugs, graph);
  assert.equal(r.tagged, 0);
  assert.equal(r.untagged, 1);
  assert.equal(r.bugs[0].graph_node_confidence, 'file-level');
});

test('tagBugSymbol: returns new array; does not mutate input', () => {
  const graph = makeGraph([makeFileNode('src/x.ts', ['foo'])]);
  const bugs = [makeBug({ file: 'src/x.ts', error_message: 'foo broke' })];
  const r = tagBugSymbol(bugs, graph);
  assert.notStrictEqual(r.bugs, bugs);
  assert.equal(bugs[0].graph_node, undefined, 'original should not be mutated');
  assert.equal(r.bugs[0].graph_node, 'foo');
});

test('tagBugSymbol: empty input returns zero counts', () => {
  const r = tagBugSymbol([], makeGraph([]));
  assert.equal(r.tagged, 0);
  assert.equal(r.untagged, 0);
  assert.deepEqual(r.bugs, []);
});
