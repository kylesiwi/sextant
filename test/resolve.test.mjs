// test/resolve.test.mjs — unit tests for lib/graph/resolve.mjs (Phase 1c).
//
// resolveEdges is a pure transformation: in-memory graph + project_root →
// edges with `verified` confidence where resolution succeeded, untouched
// elsewhere. These tests bypass the file system entirely.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveEdges, detectLanguage } from '../lib/graph/resolve.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
} from '../lib/graph/schema.mjs';

// --- helpers ---------------------------------------------------------------

function fileNode(relPath) {
  return {
    [NODE.ID]: fileNodeId(relPath),
    [NODE.TYPE]: NODE_TYPES.FILE,
    label: relPath.split('/').pop(),
    [NODE.PATH]: relPath,
    symbols: [],
    community: null,
  };
}

function importsEdge(fromRel, toSpec, confidence) {
  // toSpec may be a relative spec (`./foo`) — caller passes the spec string,
  // we wrap with `node:` to mimic what the extractors emit.
  const to = toSpec.startsWith('node:') || toSpec.startsWith('unresolved:')
    ? toSpec
    : (confidence === CONFIDENCE.UNVERIFIED ? `unresolved:${toSpec}` : `node:${toSpec}`);
  return {
    [EDGE.FROM]: fileNodeId(fromRel),
    [EDGE.TO]: to,
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: confidence,
  };
}

// --- 1. detectLanguage ------------------------------------------------------

test('detectLanguage: identifies all supported extensions', () => {
  assert.equal(detectLanguage('foo.ts'), 'ts');
  assert.equal(detectLanguage('foo.tsx'), 'ts');
  assert.equal(detectLanguage('foo.js'), 'js');
  assert.equal(detectLanguage('foo.mjs'), 'js');
  assert.equal(detectLanguage('foo.cjs'), 'js');
  assert.equal(detectLanguage('foo.jsx'), 'js');
  assert.equal(detectLanguage('foo.py'), 'py');
  assert.equal(detectLanguage('foo.go'), 'go');
  assert.equal(detectLanguage('foo.rs'), 'rs');
  assert.equal(detectLanguage('foo.md'), 'unknown');
  assert.equal(detectLanguage(''), 'unknown');
  assert.equal(detectLanguage(null), 'unknown');
});

// --- 2. empty input --------------------------------------------------------

test('resolveEdges: empty input returns empty', () => {
  const r = resolveEdges({ nodes: [], edges: [], project_root: '/tmp/x' });
  assert.deepEqual(r.edges, []);
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 0);
});

test('resolveEdges: nodes only, no edges', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.ts')],
    edges: [],
    project_root: '/tmp/x',
  });
  assert.deepEqual(r.edges, []);
  assert.equal(r.resolved_count, 0);
});

// --- 3. TS: 2 files, a.ts imports './b' -----------------------------------

test('resolveEdges: TS — basic relative import resolves to .ts target', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('b.ts')],
    edges: [importsEdge('a.ts', './b', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.unresolved_count, 0);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('b.ts'));
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

// --- 4. TS: .tsx target ----------------------------------------------------

test('resolveEdges: TS — relative import resolves to .tsx target', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('Component.tsx')],
    edges: [importsEdge('a.ts', './Component', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('Component.tsx'));
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

// --- 5. TS: index resolution -----------------------------------------------

test('resolveEdges: TS — directory import resolves to <dir>/index.ts', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('utils/index.ts')],
    edges: [importsEdge('a.ts', './utils', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('utils/index.ts'));
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('resolveEdges: TS — extension priority over index when both exist', () => {
  // utils.ts AND utils/index.ts both exist — .ts wins.
  const r = resolveEdges({
    nodes: [
      fileNode('a.ts'),
      fileNode('utils.ts'),
      fileNode('utils/index.ts'),
    ],
    edges: [importsEdge('a.ts', './utils', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('utils.ts'));
});

// --- 6. JS: .js/.mjs/.cjs --------------------------------------------------

test('resolveEdges: JS — .js target', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.js'), fileNode('b.js')],
    edges: [importsEdge('a.js', './b', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('b.js'));
});

test('resolveEdges: JS — .mjs target', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.mjs'), fileNode('b.mjs')],
    edges: [importsEdge('a.mjs', './b', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('b.mjs'));
});

test('resolveEdges: JS — .cjs target', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.cjs'), fileNode('b.cjs')],
    edges: [importsEdge('a.cjs', './b', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('b.cjs'));
});

test('resolveEdges: JS — directory import resolves to <dir>/index.js', () => {
  const r = resolveEdges({
    nodes: [fileNode('a.js'), fileNode('pkg/index.js')],
    edges: [importsEdge('a.js', './pkg', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('pkg/index.js'));
});

// --- 7. Python: .foo from package __init__.py ------------------------------

test('resolveEdges: Python — from .foo import x resolves to pkg/foo.py', () => {
  const r = resolveEdges({
    nodes: [
      fileNode('pkg/__init__.py'),
      fileNode('pkg/foo.py'),
    ],
    edges: [importsEdge('pkg/__init__.py', '.foo', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('pkg/foo.py'));
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('resolveEdges: Python — multi-dot ..foo resolves to parent package', () => {
  const r = resolveEdges({
    nodes: [
      fileNode('pkg/sub/mod.py'),
      fileNode('pkg/foo.py'),
    ],
    edges: [importsEdge('pkg/sub/mod.py', '..foo', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('pkg/foo.py'));
});

test('resolveEdges: Python — .foo.bar resolves to pkg/foo/bar.py', () => {
  const r = resolveEdges({
    nodes: [
      fileNode('pkg/__init__.py'),
      fileNode('pkg/foo/bar.py'),
    ],
    edges: [importsEdge('pkg/__init__.py', '.foo.bar', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('pkg/foo/bar.py'));
});

test('resolveEdges: Python — from . import x resolves to package __init__.py when target unresolvable', () => {
  // `from . import x` (raw `.`) resolves to importerDir/__init__.py if it
  // exists — covers the bare-package case.
  const r = resolveEdges({
    nodes: [
      fileNode('pkg/__init__.py'),
      fileNode('pkg/foo.py'),
    ],
    edges: [importsEdge('pkg/foo.py', '.', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  // pkg/foo.py is in dir 'pkg', so `.` → 'pkg/__init__.py'.
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('pkg/__init__.py'));
});

// --- 8. Go and Rust are explicitly deferred --------------------------------

test('resolveEdges: Go — import "fmt" stays unresolved', () => {
  const e = {
    [EDGE.FROM]: fileNodeId('main.go'),
    [EDGE.TO]: 'unresolved:fmt',
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.UNVERIFIED,
  };
  const r = resolveEdges({
    nodes: [fileNode('main.go')],
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  // Edge passes through untouched.
  assert.deepEqual(r.edges[0], e);
});

test('resolveEdges: Rust — use crate::foo stays intra-file-only', () => {
  const e = {
    [EDGE.FROM]: fileNodeId('main.rs'),
    [EDGE.TO]: 'node:./crate::foo',  // contrived: extractor's raw spec form
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.INTRA_FILE_ONLY,
  };
  const r = resolveEdges({
    nodes: [fileNode('main.rs'), fileNode('foo.rs')],
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  // Edge passes through untouched — Rust resolution is deferred.
  assert.deepEqual(r.edges[0], e);
});

// --- 9. Unresolvable TS import: target not in fileSet ----------------------

test('resolveEdges: TS — unresolvable relative import passes through', () => {
  const e = importsEdge('a.ts', './missing', CONFIDENCE.INTRA_FILE_ONLY);
  const r = resolveEdges({
    nodes: [fileNode('a.ts')],
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  // Original edge fields preserved.
  assert.equal(r.edges[0][EDGE.TO], 'node:./missing');
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

// --- 10. Already-verified edge passes through ------------------------------

test('resolveEdges: already-verified edge is untouched', () => {
  const e = {
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: fileNodeId('b.ts'),
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.VERIFIED,
  };
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('b.ts')],
    edges: [e],
    project_root: '/tmp/x',
  });
  // No counts change for already-verified edges.
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 0);
  assert.deepEqual(r.edges[0], e);
});

// --- 11. Non-imports edges pass through ------------------------------------

test('resolveEdges: declares edges pass through untouched', () => {
  const declares = {
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: 'node:a.ts#X',
    [EDGE.TYPE]: EDGE_TYPES.DECLARES,
    [EDGE.CONFIDENCE]: CONFIDENCE.VERIFIED,
  };
  const r = resolveEdges({
    nodes: [fileNode('a.ts')],
    edges: [declares],
    project_root: '/tmp/x',
  });
  assert.deepEqual(r.edges[0], declares);
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 0);
});

// --- 12. Bare package imports stay unverified -------------------------------

test('resolveEdges: TS — bare package import (lodash) stays unverified', () => {
  const e = {
    [EDGE.FROM]: fileNodeId('a.ts'),
    [EDGE.TO]: 'unresolved:lodash',
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.UNVERIFIED,
  };
  const r = resolveEdges({
    nodes: [fileNode('a.ts')],
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  assert.deepEqual(r.edges[0], e);
});

test('resolveEdges: Python — absolute import (django.db) stays unverified', () => {
  const e = {
    [EDGE.FROM]: fileNodeId('main.py'),
    [EDGE.TO]: 'unresolved:django.db',
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: CONFIDENCE.UNVERIFIED,
  };
  const r = resolveEdges({
    nodes: [fileNode('main.py')],
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  assert.deepEqual(r.edges[0], e);
});

// --- 13. Parent-traversal resolution ---------------------------------------

test('resolveEdges: TS — ../foo resolves to a sibling-of-dir', () => {
  const r = resolveEdges({
    nodes: [
      fileNode('src/sub/a.ts'),
      fileNode('src/foo.ts'),
    ],
    edges: [importsEdge('src/sub/a.ts', '../foo', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('src/foo.ts'));
});

// --- 14. Source node missing -----------------------------------------------

test('resolveEdges: edge from unknown source node passes through unchanged', () => {
  const e = importsEdge('orphan.ts', './target', CONFIDENCE.INTRA_FILE_ONLY);
  const r = resolveEdges({
    nodes: [fileNode('target.ts')],  // no `orphan.ts` node!
    edges: [e],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  assert.deepEqual(r.edges[0], e);
});

// --- 15. Literal extension match -------------------------------------------

test('resolveEdges: TS — spec with explicit .ts extension still resolves', () => {
  // Some authors write `import x from './foo.ts'` — uncommon but legal.
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('foo.ts')],
    edges: [importsEdge('a.ts', './foo.ts', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 1);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('foo.ts'));
});

// --- 16. Returns new edge objects, not mutated input ----------------------

test('resolveEdges: does not mutate input edges array', () => {
  const e = importsEdge('a.ts', './b', CONFIDENCE.INTRA_FILE_ONLY);
  const originalTo = e[EDGE.TO];
  const originalConfidence = e[EDGE.CONFIDENCE];
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('b.ts')],
    edges: [e],
    project_root: '/tmp/x',
  });
  // Input edge unchanged.
  assert.equal(e[EDGE.TO], originalTo);
  assert.equal(e[EDGE.CONFIDENCE], originalConfidence);
  // Output edge is a fresh object.
  assert.notEqual(r.edges[0], e);
  assert.equal(r.edges[0][EDGE.TO], fileNodeId('b.ts'));
  assert.equal(r.edges[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

// --- 17. Mixed-language project --------------------------------------------

test('resolveEdges: no cross-language false positives', () => {
  // a.ts importing './b' should NOT resolve to b.py even if b.ts is missing.
  const r = resolveEdges({
    nodes: [fileNode('a.ts'), fileNode('b.py')],
    edges: [importsEdge('a.ts', './b', CONFIDENCE.INTRA_FILE_ONLY)],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
});

test('resolveEdges: mixed TS + Python project, each lang resolves only its own', () => {
  const r = resolveEdges({
    nodes: [
      fileNode('a.ts'),
      fileNode('b.ts'),
      fileNode('pkg/__init__.py'),
      fileNode('pkg/foo.py'),
    ],
    edges: [
      importsEdge('a.ts', './b', CONFIDENCE.INTRA_FILE_ONLY),
      importsEdge('pkg/__init__.py', '.foo', CONFIDENCE.INTRA_FILE_ONLY),
    ],
    project_root: '/tmp/x',
  });
  assert.equal(r.resolved_count, 2);
  assert.equal(r.unresolved_count, 0);
});
