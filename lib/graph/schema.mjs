// Canonical graph data model for Sextant.
//
// This module is the single source of truth for:
//   - Schema version (bump on incompatible changes; ship a migration).
//   - Node / edge / confidence enums.
//   - Field-name constants — referenced instead of string literals so the
//     compiler / readers can catch typos at the boundary between modules.
//   - Stable id helpers.
//   - A light-weight shape validator.
//
// Zero external dependencies. Pure ESM. Phase 1a consumers (parser →
// per-file extractor → graph builder → writer) all import from here.

// Schema version. Matches .sextant-version file content. Bump on incompatible
// changes; ship a migration alongside.
export const SCHEMA_VERSION = 1;

// Node types in the graph. Phase 1a uses 'file' only; symbols live inline.
// 'symbol' is reserved for Phase 1c+ when individual functions/classes
// become first-class nodes for cross-file edge construction.
export const NODE_TYPES = Object.freeze({
  FILE: 'file',
  SYMBOL: 'symbol',
});

// Edge types Phase 1a emits. Phase 1c will extend.
export const EDGE_TYPES = Object.freeze({
  IMPORTS: 'imports',        // file → file (when target resolves)
  EXPORTS: 'exports',        // file declares symbol that's exported
  DECLARES: 'declares',      // file → symbol (intra-file)
  REFERENCES: 'references',  // file/symbol → symbol (Phase 1c)
  EXTENDS: 'extends',        // class → class
  IMPLEMENTS: 'implements',  // class → interface
});

// Confidence labels on edges. § 5.3's confidence-labels.ts pattern in the
// design. Order is by trust descending:
//   verified         — AST-derived, target node confirmed to exist in this graph
//   intra-file-only  — Phase 1a default for cross-file edges (target not verified yet)
//   inferred-LLM     — LLM-extracted (Phase 13 post-v1)
//   unverified       — heuristic match without AST grounding
export const CONFIDENCE = Object.freeze({
  VERIFIED: 'verified',
  INTRA_FILE_ONLY: 'intra-file-only',
  INFERRED_LLM: 'inferred-LLM',
  UNVERIFIED: 'unverified',
});

// Field-name constants. Reference these instead of string literals in all
// graph-touching code. Adding a new field requires adding it here AND
// renaming the consumers — that's the friction the constants are buying.
export const NODE = Object.freeze({
  ID: 'id',
  TYPE: 'type',
  LABEL: 'label',
  PATH: 'path',
  SYMBOLS: 'symbols',
  COMMUNITY: 'community',
});

export const EDGE = Object.freeze({
  FROM: 'from',
  TO: 'to',
  TYPE: 'type',
  CONFIDENCE: 'confidence',
});

export const GRAPH = Object.freeze({
  SCHEMA_VERSION: 'schema_version',
  NODES: 'nodes',
  EDGES: 'edges',
  BUILT_AT: 'built_at',
  STATS: 'stats',
});

// Stable id helpers. Phase 1a uses 'node:<relpath>' for file nodes; symbols
// (when they land in Phase 1c+) will use 'node:<relpath>#<symbolname>'.
export function fileNodeId(relPath) {
  return `node:${relPath}`;
}

export function symbolNodeId(relPath, symbolName) {
  return `node:${relPath}#${symbolName}`;
}

// validateGraph(obj): returns { ok: true } or { ok: false, error: '<msg>' }.
// Light-weight shape check; not a JSON-Schema validator. Catches the obvious
// breakage: wrong schema_version, missing top-level fields, nodes/edges not
// arrays, individual node/edge entries missing required fields.
export function validateGraph(obj) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'not an object' };
  }
  if (obj[GRAPH.SCHEMA_VERSION] !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: `schema_version mismatch: expected ${SCHEMA_VERSION}, got ${obj[GRAPH.SCHEMA_VERSION]}`,
    };
  }
  if (!Array.isArray(obj[GRAPH.NODES])) return { ok: false, error: 'nodes is not an array' };
  if (!Array.isArray(obj[GRAPH.EDGES])) return { ok: false, error: 'edges is not an array' };

  for (const [i, n] of obj[GRAPH.NODES].entries()) {
    if (!n || typeof n !== 'object') return { ok: false, error: `node[${i}] is not an object` };
    if (typeof n[NODE.ID] !== 'string') return { ok: false, error: `node[${i}].id missing or not string` };
    if (typeof n[NODE.TYPE] !== 'string') return { ok: false, error: `node[${i}].type missing or not string` };
    if (!Object.values(NODE_TYPES).includes(n[NODE.TYPE])) {
      return { ok: false, error: `node[${i}].type='${n[NODE.TYPE]}' is not a valid node type` };
    }
  }

  const nodeIds = new Set(obj[GRAPH.NODES].map(n => n[NODE.ID]));
  for (const [i, e] of obj[GRAPH.EDGES].entries()) {
    if (!e || typeof e !== 'object') return { ok: false, error: `edge[${i}] is not an object` };
    if (typeof e[EDGE.FROM] !== 'string') return { ok: false, error: `edge[${i}].from missing` };
    if (typeof e[EDGE.TO] !== 'string') return { ok: false, error: `edge[${i}].to missing` };
    if (typeof e[EDGE.TYPE] !== 'string') return { ok: false, error: `edge[${i}].type missing` };
    if (!Object.values(EDGE_TYPES).includes(e[EDGE.TYPE])) {
      return { ok: false, error: `edge[${i}].type='${e[EDGE.TYPE]}' is not a valid edge type` };
    }
    if (typeof e[EDGE.CONFIDENCE] !== 'string') return { ok: false, error: `edge[${i}].confidence missing` };
    if (!Object.values(CONFIDENCE).includes(e[EDGE.CONFIDENCE])) {
      return { ok: false, error: `edge[${i}].confidence='${e[EDGE.CONFIDENCE]}' is not a valid confidence` };
    }
    // Edges referencing missing nodes: a soft warning, not a hard failure.
    // Phase 1a's intra-file-only edges may target unresolved paths.
    // Don't fail validation; the reader/composer should handle gracefully.
  }

  return { ok: true };
}

// emptyGraph(): a fresh empty graph object, used by the builder on init.
export function emptyGraph() {
  return {
    [GRAPH.SCHEMA_VERSION]: SCHEMA_VERSION,
    [GRAPH.NODES]: [],
    [GRAPH.EDGES]: [],
    [GRAPH.BUILT_AT]: new Date().toISOString(),
    [GRAPH.STATS]: { files: 0, edges: 0 },
  };
}
