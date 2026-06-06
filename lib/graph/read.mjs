// lib/graph/read.mjs — hot-path read API for the persisted project graph.
//
// Consumers:
//   - PreToolUse Read hook: composes per-Read context blocks by looking up the
//     touched file's node and its top connections.
//   - /sextant:doctor and stats commands: report counts and built-at.
//
// Caching:
//   - The parsed graph is cached per-root in module scope. A new Read in the
//     same session pays the read cost once.
//   - On each loadGraph() call we stat() the file. If mtime has advanced past
//     the cached snapshot, we re-read. This lets a /sextant:graph-build run
//     mid-session refresh the in-process cache automatically.
//
// Path normalisation:
//   - graph.json stores paths relative to project root with POSIX separators.
//   - PreToolUse hooks see absolute file paths from Claude. The reader's
//     findFileNode helper accepts either form and normalises to the on-disk
//     representation before lookup. v1 is case-sensitive (Linux semantics);
//     case-insensitive matching on macOS/Windows is a follow-up.
//
// Ranking heuristic (Phase 1a):
//   - topConnections / topUsedBy use a degree-based score: when there's no
//     graph-rank or edge weight yet (Phase 1c+), we approximate "importance"
//     by the degree of the *target* node (for outbound) or *source* node (for
//     inbound). Ties break in source order so output is deterministic.

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  SCHEMA_VERSION,
  GRAPH,
  NODE,
  EDGE,
  validateGraph,
  fileNodeId,
} from './schema.mjs';
import { durableBase } from '../paths.mjs';

// In-process cache. Key: resolved absolute root. Value: { graph, mtimeMs }.
const _cache = new Map();
// Set of resolved roots for which we've already logged a "warn: invalid
// graph" message — keeps the warning to one line per process lifetime.
const _warned = new Set();

/**
 * loadGraph(root): read .sextant/graph/graph.json from `root` and return
 * the parsed graph, or null if missing / unparseable / schema-version mismatch.
 *
 * @param {string} root project root (absolute or relative; resolved internally)
 * @returns {Promise<Object | null>}
 */
export async function loadGraph(root) {
  const absRoot = path.resolve(root);
  const graphPath = path.join(durableBase(absRoot), 'graph', 'graph.json');

  let mtimeMs;
  try {
    const stat = await fs.stat(graphPath);
    mtimeMs = stat.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }

  // Cache hit when mtime hasn't advanced.
  const cached = _cache.get(absRoot);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.graph;
  }

  // Read + parse.
  let raw;
  try {
    raw = await fs.readFile(graphPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnOnce(absRoot, 'malformed JSON');
    return null;
  }
  const v = validateGraph(parsed);
  if (!v.ok) {
    warnOnce(absRoot, v.error);
    return null;
  }

  _cache.set(absRoot, { graph: parsed, mtimeMs });
  return parsed;
}

function warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  process.stderr.write(`sextant: graph.json invalid (${msg}); pretending it doesn't exist\n`);
}

/**
 * findFileNode(graph, relOrAbsPath, [opts]): find the file node whose path
 * field matches the given path. Accepts absolute or relative input; absolute
 * paths are stripped to relative if and only if a `root` is provided in opts.
 *
 * @param {Object} graph
 * @param {string} input path (absolute or relative)
 * @param {Object} [opts]
 * @param {string} [opts.root] project root, required only when `input` is absolute.
 * @returns {Object | null} the file node or null.
 */
export function findFileNode(graph, input, opts = {}) {
  if (!graph || !Array.isArray(graph[GRAPH.NODES])) return null;
  const rel = normalizePath(input, opts.root);
  if (rel == null) return null;
  for (const node of graph[GRAPH.NODES]) {
    if (node[NODE.PATH] === rel) return node;
  }
  // Fallback: the caller may have passed an id rather than a path.
  const idMatch = graph[GRAPH.NODES].find((n) => n[NODE.ID] === input);
  if (idMatch) return idMatch;
  // Or the relative form may match the synthesized id.
  const synth = fileNodeId(rel);
  const synthMatch = graph[GRAPH.NODES].find((n) => n[NODE.ID] === synth);
  return synthMatch ?? null;
}

function normalizePath(input, root) {
  if (typeof input !== 'string' || input.length === 0) return null;
  let rel = input;
  if (path.isAbsolute(input)) {
    if (!root) {
      // Without a root we can't strip — return null rather than guess.
      return input;
    }
    const absRoot = path.resolve(root);
    if (input === absRoot) return '';
    const prefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
    if (input.startsWith(prefix)) {
      rel = input.slice(prefix.length);
    } else {
      // Not under root — pass through unchanged so the caller can see why
      // it didn't match.
      return input;
    }
  }
  // Normalise './foo' → 'foo', collapse '..', enforce POSIX separators.
  rel = rel.split(path.sep).join('/');
  rel = path.posix.normalize(rel);
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * topConnections(graph, nodeId, k=3): outbound edges from `nodeId`, ranked by
 * inbound degree of the target. Returns up to k entries shaped:
 *   { edge, targetNode | null }
 */
export function topConnections(graph, nodeId, k = 3) {
  if (!graph) return [];
  const edges = graph[GRAPH.EDGES] ?? [];
  const inbound = countInbound(graph);
  const idIndex = indexNodesById(graph);
  const outbound = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e[EDGE.FROM] === nodeId) {
      outbound.push({ edge: e, sourceIndex: i, score: inbound.get(e[EDGE.TO]) ?? 0 });
    }
  }
  outbound.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sourceIndex - b.sourceIndex;
  });
  return outbound.slice(0, k).map((x) => ({
    edge: x.edge,
    targetNode: idIndex.get(x.edge[EDGE.TO]) ?? null,
  }));
}

/**
 * topUsedBy(graph, nodeId, k=3): inbound edges to `nodeId`, ranked by outbound
 * degree of the source. Returns up to k entries shaped:
 *   { edge, sourceNode | null }
 */
export function topUsedBy(graph, nodeId, k = 3) {
  if (!graph) return [];
  const edges = graph[GRAPH.EDGES] ?? [];
  const outboundCount = countOutbound(graph);
  const idIndex = indexNodesById(graph);
  const inbound = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (e[EDGE.TO] === nodeId) {
      inbound.push({ edge: e, sourceIndex: i, score: outboundCount.get(e[EDGE.FROM]) ?? 0 });
    }
  }
  inbound.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sourceIndex - b.sourceIndex;
  });
  return inbound.slice(0, k).map((x) => ({
    edge: x.edge,
    sourceNode: idIndex.get(x.edge[EDGE.FROM]) ?? null,
  }));
}

/**
 * listSymbols(graph, nodeId, max=20): file node's symbols, capped.
 */
export function listSymbols(graph, nodeId, max = 20) {
  if (!graph) return [];
  const node = (graph[GRAPH.NODES] ?? []).find((n) => n[NODE.ID] === nodeId);
  if (!node) return [];
  const syms = node[NODE.SYMBOLS];
  if (!Array.isArray(syms)) return [];
  return syms.slice(0, max);
}

/**
 * communityOf(graph, nodeId): node's community field or null.
 *
 * Phase 1a always returns null (no community detection yet); this slot is
 * reserved for Phase 1c+.
 */
export function communityOf(graph, nodeId) {
  if (!graph) return null;
  const node = (graph[GRAPH.NODES] ?? []).find((n) => n[NODE.ID] === nodeId);
  if (!node) return null;
  return node[NODE.COMMUNITY] ?? null;
}

/**
 * graphStats(graph): { files, edges, built_at } for the doctor / status views.
 */
export function graphStats(graph) {
  if (!graph) return { files: 0, edges: 0, built_at: null };
  const stats = graph[GRAPH.STATS] ?? {};
  const builtAt = graph[GRAPH.BUILT_AT] ?? null;
  // Prefer counting from the actual arrays if stats look wrong (defensive).
  const files = typeof stats.files === 'number'
    ? stats.files
    : (Array.isArray(graph[GRAPH.NODES]) ? graph[GRAPH.NODES].length : 0);
  const edges = typeof stats.edges === 'number'
    ? stats.edges
    : (Array.isArray(graph[GRAPH.EDGES]) ? graph[GRAPH.EDGES].length : 0);
  return { files, edges, built_at: builtAt };
}

// --- internal helpers ------------------------------------------------------

function indexNodesById(graph) {
  const idx = new Map();
  for (const n of (graph[GRAPH.NODES] ?? [])) {
    idx.set(n[NODE.ID], n);
  }
  return idx;
}

function countInbound(graph) {
  const m = new Map();
  for (const e of (graph[GRAPH.EDGES] ?? [])) {
    m.set(e[EDGE.TO], (m.get(e[EDGE.TO]) ?? 0) + 1);
  }
  return m;
}

function countOutbound(graph) {
  const m = new Map();
  for (const e of (graph[GRAPH.EDGES] ?? [])) {
    m.set(e[EDGE.FROM], (m.get(e[EDGE.FROM]) ?? 0) + 1);
  }
  return m;
}

// --- test-only -------------------------------------------------------------

/** @internal — clears the per-root cache + warn-once set between tests. */
export function _resetCacheForTests() {
  _cache.clear();
  _warned.clear();
}

// Sanity probe: SCHEMA_VERSION import isn't unused — keep the symbol live
// for the rare future case where we want to expose it from the reader.
void SCHEMA_VERSION;
