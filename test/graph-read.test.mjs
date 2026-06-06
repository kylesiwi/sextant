// Tests for lib/graph/read.mjs — the hot-path graph read API.
//
// These tests don't load the tree-sitter parser. They construct synthetic
// graph.json files directly so we can exercise the reader's path logic,
// caching, and ranking heuristic in isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  loadGraph,
  findFileNode,
  topConnections,
  topUsedBy,
  listSymbols,
  communityOf,
  graphStats,
  _resetCacheForTests,
} from '../lib/graph/read.mjs';
import {
  SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  CONFIDENCE,
  GRAPH,
  NODE,
  EDGE,
  fileNodeId,
  emptyGraph,
} from '../lib/graph/schema.mjs';

function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-read-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tempProject(t) {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeGraph(root, graph) {
  const dir = path.join(root, '.sextant', 'graph');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'graph.json');
  await fs.writeFile(file, JSON.stringify(graph), 'utf8');
  return file;
}

function makeFileNode(rel, symbols = []) {
  return {
    [NODE.ID]: fileNodeId(rel),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: path.basename(rel),
    [NODE.PATH]: rel,
    [NODE.SYMBOLS]: symbols,
    [NODE.COMMUNITY]: null,
  };
}

function makeEdge(from, to, type = EDGE_TYPES.IMPORTS, conf = CONFIDENCE.INTRA_FILE_ONLY) {
  return {
    [EDGE.FROM]: from,
    [EDGE.TO]: to,
    [EDGE.TYPE]: type,
    [EDGE.CONFIDENCE]: conf,
  };
}

test.beforeEach(() => {
  // Each test starts with a clean cache so leftover entries from a prior
  // test don't mask a re-read bug.
  _resetCacheForTests();
});

// --- 1. loadGraph: ENOENT --------------------------------------------------

test('loadGraph: returns null when graph.json is missing', async (t) => {
  const root = tempProject(t);
  const g = await loadGraph(root);
  assert.equal(g, null);
});

// --- 2. loadGraph: schema_version mismatch ---------------------------------

test('loadGraph: returns null when schema_version is wrong', async (t) => {
  const root = tempProject(t);
  await writeGraph(root, {
    [GRAPH.SCHEMA_VERSION]: 999,
    [GRAPH.NODES]: [],
    [GRAPH.EDGES]: [],
  });
  // Capture stderr to confirm the one-time warning fires.
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    const g = await loadGraph(root);
    assert.equal(g, null);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(captured.some((s) => s.includes('schema_version mismatch')),
    `expected schema_version warning, got: ${captured.join('')}`);
});

// --- 3. loadGraph: valid graph --------------------------------------------

test('loadGraph: returns the parsed object for a valid graph', async (t) => {
  const root = tempProject(t);
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts', ['A']));
  g[GRAPH.NODES].push(makeFileNode('b.ts', ['B']));
  g[GRAPH.STATS] = { files: 2, edges: 0 };
  await writeGraph(root, g);
  const loaded = await loadGraph(root);
  assert.equal(loaded[GRAPH.NODES].length, 2);
  assert.equal(loaded[GRAPH.SCHEMA_VERSION], SCHEMA_VERSION);
});

// --- 4. loadGraph: cache hit on second call --------------------------------

test('loadGraph: cache hit avoids re-reading when mtime is unchanged', async (t) => {
  const root = tempProject(t);
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));
  await writeGraph(root, g);

  // Two successive loads against a static file should return the *same*
  // object identity, proving we didn't re-parse the JSON. (A fresh parse
  // would yield a different object even though the structural content is
  // equal.)
  const loaded1 = await loadGraph(root);
  assert.ok(loaded1, 'first load failed');
  const loaded2 = await loadGraph(root);
  assert.equal(loaded2, loaded1, 'second call should return cached identity');
});

// --- 5. cache invalidation on mtime change ---------------------------------

test('loadGraph: re-reads when mtime advances', async (t) => {
  const root = tempProject(t);
  const g1 = emptyGraph();
  g1[GRAPH.NODES].push(makeFileNode('a.ts'));
  const file = await writeGraph(root, g1);
  const loaded1 = await loadGraph(root);
  assert.equal(loaded1[GRAPH.NODES].length, 1);

  // Write a different graph and bump mtime explicitly so the change is
  // detected even on filesystems with second-resolution timestamps.
  const g2 = emptyGraph();
  g2[GRAPH.NODES].push(makeFileNode('a.ts'));
  g2[GRAPH.NODES].push(makeFileNode('b.ts'));
  await fs.writeFile(file, JSON.stringify(g2), 'utf8');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(file, future, future);

  const loaded2 = await loadGraph(root);
  assert.equal(loaded2[GRAPH.NODES].length, 2);
  assert.notEqual(loaded2, loaded1, 'expected a fresh parse after mtime advance');
});

// --- 6. malformed JSON returns null ---------------------------------------

test('loadGraph: malformed JSON returns null and warns', async (t) => {
  const root = tempProject(t);
  const dir = path.join(root, '.sextant', 'graph');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'graph.json'), '{this is not json', 'utf8');
  const originalWrite = process.stderr.write;
  const captured = [];
  process.stderr.write = (c) => { captured.push(String(c)); return true; };
  try {
    const g = await loadGraph(root);
    assert.equal(g, null);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.ok(captured.some((s) => s.includes('malformed')),
    `expected malformed warning, got: ${captured.join('')}`);
});

// --- 7. findFileNode -------------------------------------------------------

test('findFileNode: exact relative path match', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('src/foo.ts'));
  const n = findFileNode(g, 'src/foo.ts');
  assert.ok(n);
  assert.equal(n[NODE.ID], fileNodeId('src/foo.ts'));
});

test('findFileNode: non-matching path returns null', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('src/foo.ts'));
  const n = findFileNode(g, 'src/bar.ts');
  assert.equal(n, null);
});

test('findFileNode: absolute path is normalised when root is provided', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('src/foo.ts'));
  // Pick a root the test platform supports.
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const abs = path.join(root, 'src', 'foo.ts');
  const n = findFileNode(g, abs, { root });
  assert.ok(n, 'expected to find node via absolute path normalisation');
  assert.equal(n[NODE.ID], fileNodeId('src/foo.ts'));
});

test('findFileNode: absolute path outside root returns null', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('src/foo.ts'));
  const n = findFileNode(g, '/elsewhere/src/foo.ts', { root: '/proj' });
  assert.equal(n, null);
});

test('findFileNode: ./foo normalises to foo', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('foo.ts'));
  const n = findFileNode(g, './foo.ts');
  assert.ok(n);
});

test('findFileNode: also accepts a node id directly', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('src/foo.ts'));
  const n = findFileNode(g, fileNodeId('src/foo.ts'));
  assert.ok(n);
});

// --- 8. topConnections ----------------------------------------------------

test('topConnections: returns up to k outbound edges ranked by target inbound degree', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));  // source
  g[GRAPH.NODES].push(makeFileNode('b.ts'));
  g[GRAPH.NODES].push(makeFileNode('c.ts'));
  g[GRAPH.NODES].push(makeFileNode('d.ts'));
  // a imports b, c, d.
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('b.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('c.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('d.ts')));
  // c is also imported by b and d → highest inbound degree.
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('b.ts'), fileNodeId('c.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('d.ts'), fileNodeId('c.ts')));

  const top = topConnections(g, fileNodeId('a.ts'), 3);
  assert.equal(top.length, 3);
  // c is most-incoming → first.
  assert.equal(top[0].edge[EDGE.TO], fileNodeId('c.ts'));
  assert.equal(top[0].targetNode[NODE.PATH], 'c.ts');
});

test('topConnections: respects k cap', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));
  g[GRAPH.NODES].push(makeFileNode('b.ts'));
  g[GRAPH.NODES].push(makeFileNode('c.ts'));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('b.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('c.ts')));
  const top = topConnections(g, fileNodeId('a.ts'), 1);
  assert.equal(top.length, 1);
});

test('topConnections: targetNode is null when target is unresolved', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), 'unresolved:lodash', EDGE_TYPES.IMPORTS, CONFIDENCE.UNVERIFIED));
  const top = topConnections(g, fileNodeId('a.ts'), 3);
  assert.equal(top.length, 1);
  assert.equal(top[0].targetNode, null);
});

// --- 9. topUsedBy ---------------------------------------------------------

test('topUsedBy: returns up to k inbound edges ranked by source outbound degree', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('hub.ts'));
  g[GRAPH.NODES].push(makeFileNode('low.ts'));
  g[GRAPH.NODES].push(makeFileNode('mid.ts'));
  g[GRAPH.NODES].push(makeFileNode('high.ts'));
  // each of low/mid/high imports hub
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('low.ts'), fileNodeId('hub.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('mid.ts'), fileNodeId('hub.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('high.ts'), fileNodeId('hub.ts')));
  // high also imports many other things → highest outbound degree
  g[GRAPH.NODES].push(makeFileNode('x.ts'));
  g[GRAPH.NODES].push(makeFileNode('y.ts'));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('high.ts'), fileNodeId('x.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('high.ts'), fileNodeId('y.ts')));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('mid.ts'), fileNodeId('x.ts')));

  const top = topUsedBy(g, fileNodeId('hub.ts'), 3);
  assert.equal(top.length, 3);
  // high has 3 outbound, mid has 2, low has 1.
  assert.equal(top[0].sourceNode[NODE.PATH], 'high.ts');
  assert.equal(top[1].sourceNode[NODE.PATH], 'mid.ts');
  assert.equal(top[2].sourceNode[NODE.PATH], 'low.ts');
});

// --- 10. listSymbols ------------------------------------------------------

test('listSymbols: returns the node symbols, capped to max', () => {
  const syms = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts', syms));
  const out = listSymbols(g, fileNodeId('a.ts'), 5);
  assert.deepEqual(out, ['s0', 's1', 's2', 's3', 's4']);
});

test('listSymbols: defaults to max=20', () => {
  const syms = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts', syms));
  const out = listSymbols(g, fileNodeId('a.ts'));
  assert.equal(out.length, 20);
});

test('listSymbols: missing node returns empty array', () => {
  const g = emptyGraph();
  const out = listSymbols(g, fileNodeId('nope.ts'));
  assert.deepEqual(out, []);
});

// --- 11. graphStats -------------------------------------------------------

test('graphStats: reads stats block', () => {
  const g = emptyGraph();
  g[GRAPH.STATS] = { files: 42, edges: 137 };
  g[GRAPH.BUILT_AT] = '2025-01-01T00:00:00Z';
  const s = graphStats(g);
  assert.deepEqual(s, { files: 42, edges: 137, built_at: '2025-01-01T00:00:00Z' });
});

test('graphStats: falls back to node/edge count when stats missing', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));
  g[GRAPH.NODES].push(makeFileNode('b.ts'));
  g[GRAPH.EDGES].push(makeEdge(fileNodeId('a.ts'), fileNodeId('b.ts')));
  delete g[GRAPH.STATS];
  const s = graphStats(g);
  assert.equal(s.files, 2);
  assert.equal(s.edges, 1);
});

test('graphStats: null graph yields zeros', () => {
  const s = graphStats(null);
  assert.deepEqual(s, { files: 0, edges: 0, built_at: null });
});

// --- 12. communityOf ------------------------------------------------------

test('communityOf: returns null for Phase 1a (no community detection yet)', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push(makeFileNode('a.ts'));
  assert.equal(communityOf(g, fileNodeId('a.ts')), null);
});

test('communityOf: returns the community value when set', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push({ ...makeFileNode('a.ts'), [NODE.COMMUNITY]: 'pkg-x' });
  assert.equal(communityOf(g, fileNodeId('a.ts')), 'pkg-x');
});
