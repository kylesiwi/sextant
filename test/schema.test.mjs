// Tests for lib/graph/schema.mjs — the canonical graph data model.
//
// Coverage:
//   - SCHEMA_VERSION pinning.
//   - id helpers produce the documented format.
//   - validateGraph happy path on emptyGraph().
//   - validateGraph negatives: null input, schema_version mismatch, missing
//     node id, invalid edge type.
//   - confidence='unverified' is a valid value (not a synonym for "missing").
//   - Edges pointing at unknown node ids are accepted — Phase 1a's
//     intra-file-only edges target unresolved paths and we don't fail
//     validation over it (soft-warning semantics in the design).
//   - Enums are frozen so consumers can't mutate them at runtime.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  NODE_TYPES,
  EDGE_TYPES,
  CONFIDENCE,
  NODE,
  EDGE,
  GRAPH,
  fileNodeId,
  symbolNodeId,
  validateGraph,
  emptyGraph,
} from '../lib/graph/schema.mjs';

test('SCHEMA_VERSION is 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('fileNodeId formats relpath into node:<relpath>', () => {
  assert.equal(fileNodeId('src/foo.ts'), 'node:src/foo.ts');
});

test('symbolNodeId formats into node:<relpath>#<symbol>', () => {
  assert.equal(symbolNodeId('src/foo.ts', 'bar'), 'node:src/foo.ts#bar');
});

test('validateGraph accepts a fresh emptyGraph()', () => {
  const g = emptyGraph();
  const res = validateGraph(g);
  assert.deepEqual(res, { ok: true });
});

test('validateGraph rejects null', () => {
  const res = validateGraph(null);
  assert.deepEqual(res, { ok: false, error: 'not an object' });
});

test('validateGraph rejects mismatched schema_version', () => {
  const res = validateGraph({ schema_version: 2, nodes: [], edges: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /schema_version mismatch/);
  assert.match(res.error, /expected 1/);
  assert.match(res.error, /got 2/);
});

test('validateGraph rejects a node missing id', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push({ [NODE.TYPE]: NODE_TYPES.FILE });
  const res = validateGraph(g);
  assert.equal(res.ok, false);
  assert.match(res.error, /node\[0\]\.id/);
});

test('validateGraph rejects an edge with an invalid type', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push({ [NODE.ID]: fileNodeId('a.ts'), [NODE.TYPE]: NODE_TYPES.FILE });
  g[GRAPH.NODES].push({ [NODE.ID]: fileNodeId('b.ts'), [NODE.TYPE]: NODE_TYPES.FILE });
  g[GRAPH.EDGES].push({
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: fileNodeId('b.ts'),
    [EDGE.TYPE]: 'frobnicates',
    [EDGE.CONFIDENCE]: CONFIDENCE.VERIFIED,
  });
  const res = validateGraph(g);
  assert.equal(res.ok, false);
  assert.match(res.error, /frobnicates/);
  assert.match(res.error, /not a valid edge type/);
});

test('validateGraph accepts confidence=unverified as a valid label', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push({ [NODE.ID]: fileNodeId('a.ts'), [NODE.TYPE]: NODE_TYPES.FILE });
  g[GRAPH.NODES].push({ [NODE.ID]: fileNodeId('b.ts'), [NODE.TYPE]: NODE_TYPES.FILE });
  g[GRAPH.EDGES].push({
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: fileNodeId('b.ts'),
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.UNVERIFIED,
  });
  assert.deepEqual(validateGraph(g), { ok: true });
});

test('validateGraph accepts edges pointing at unknown node ids (soft-warning semantics)', () => {
  const g = emptyGraph();
  g[GRAPH.NODES].push({ [NODE.ID]: fileNodeId('a.ts'), [NODE.TYPE]: NODE_TYPES.FILE });
  g[GRAPH.EDGES].push({
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: fileNodeId('does/not/exist.ts'),
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.INTRA_FILE_ONLY,
  });
  assert.deepEqual(validateGraph(g), { ok: true });
});

test('NODE_TYPES, EDGE_TYPES, CONFIDENCE are frozen', () => {
  assert.equal(Object.isFrozen(NODE_TYPES), true);
  assert.equal(Object.isFrozen(EDGE_TYPES), true);
  assert.equal(Object.isFrozen(CONFIDENCE), true);
});
