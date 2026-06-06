// lib/graph/resolve.mjs — Phase 1c cross-file edge resolver.
//
// After all per-file extractors complete (Phases 1a/1b), every `imports` edge
// carries a placeholder target: either `node:<spec>` (relative imports) with
// confidence `intra-file-only`, or `unresolved:<spec>` (package / stdlib /
// other bare specs) with confidence `unverified`. Phase 1c walks every such
// edge and tries to resolve its target to a real file node in the graph.
//
// On a successful resolution, the edge is rewritten:
//   - to: `node:<resolved-rel-path>` (the file-node id)
//   - confidence: `verified`
//
// On failure, the edge is left exactly as it came in — preserving the original
// confidence label so the composer can still render the edge with full honesty
// about what we know.
//
// What's in scope (Phase 1c):
//   - TypeScript / JavaScript relative imports (./foo, ../bar, with extension
//     auto-discovery + index.* lookup).
//   - Python relative imports (.foo, ..foo.bar — explicit leading dots).
//
// What's deferred:
//   - Bare-package imports for any language (`lodash`, `react`, `os`,
//     `django.db`, etc.) — third-party / stdlib code lives outside the project
//     graph by definition.
//   - Go imports — require go.mod parsing to map import paths to local files.
//   - Rust imports — require Cargo.toml parsing for crate/path resolution.
//   Both Go and Rust leave their edges untouched and surface as
//   `unresolved:<spec>` / `intra-file-only` in the rendered output, with their
//   limitations called out in § 10.10.
//
// Pure module: no I/O, no fs access, no side effects. Takes the parsed graph
// (already in memory) plus the project_root string (purely for the absolute-
// path edge case below) and returns a new edges array.

import path from 'node:path';

import {
  NODE,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
} from './schema.mjs';

// TypeScript / JavaScript candidate extensions tried when the import spec has
// no extension, in order. The literal match (spec already has extension)
// is handled in resolveTSJSImport before this list is consulted.
const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'];
// Bare-directory fallback: `<dir>/<spec>/index.<ext>`.
const TS_INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs'];

// Language detection by file extension. Conservative: only the four buckets
// Phase 1c cares about. Anything else falls through to 'unknown' and skips.
export function detectLanguage(filePath) {
  if (typeof filePath !== 'string') return 'unknown';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'ts';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rs';
  return 'unknown';
}

/**
 * Extract the raw import spec text from an edge's `to` field.
 *
 * Edges leaving the per-file extractors have one of three shapes:
 *   - `node:./foo`   — relative TS/JS imports (intra-file-only)
 *   - `node:.foo`    — Python relative imports (intra-file-only)
 *   - `unresolved:<spec>` — bare package / stdlib imports (unverified)
 *
 * Already-resolved edges (e.g. ts-a → ts-b under their canonical relative
 * paths in a project where Phase 1c has previously run) carry `node:<relpath>`
 * targets that match a real node — the caller filters those out before we get
 * here.
 */
function specFromEdge(edge) {
  const to = edge[EDGE.TO];
  if (typeof to !== 'string') return null;
  if (to.startsWith('node:')) return to.slice(5);
  if (to.startsWith('unresolved:')) return to.slice(11);
  return null;
}

/**
 * resolveTSJSImport(importerDir, spec, fileSet) — returns a relative path
 * matching an entry in fileSet, or null.
 *
 * Tries candidates in this order:
 *   1. <importerDir>/<spec>                                 (literal — only relevant if spec has extension)
 *   2. <importerDir>/<spec>.ts | .tsx | .js | .mjs | .cjs | .jsx
 *   3. <importerDir>/<spec>/index.ts | .tsx | .js | .mjs | .cjs
 *
 * All paths are POSIX-normalised; `./`, `../`, and trailing slashes are
 * collapsed via path.posix.normalize.
 *
 * Bare specs (no leading `./` or `../`) are NOT handled here — the caller
 * (resolveEdge) detects them and skips resolution.
 */
function resolveTSJSImport(importerDir, spec, fileSet) {
  // Compose the base path. path.posix.join handles `..` and `.` segments
  // cleanly. We deliberately use POSIX semantics throughout for cross-
  // platform consistency.
  const base = path.posix.normalize(path.posix.join(importerDir, spec));

  // Hide a degenerate base — `../../..` from a shallow file can escape root.
  // Such candidates won't match anything in fileSet anyway, but we guard
  // against accidental absolute-style normalisations.
  if (base.startsWith('../') || base === '..') return null;

  // 1) Literal match. Only relevant when the spec already carries an
  //    extension (e.g. `./foo.json`). For extensionless imports this will
  //    miss harmlessly and we'll fall through to the extension list.
  if (fileSet.has(base)) return base;

  // 2) `<base>.<ext>` candidates.
  for (const ext of TS_EXTENSIONS) {
    const cand = `${base}${ext}`;
    if (fileSet.has(cand)) return cand;
  }

  // 3) `<base>/index.<ext>` candidates — only when base resolves to a real
  //    package-style directory in the file set. We test each candidate
  //    directly rather than enumerating the directory.
  for (const ix of TS_INDEX_FILES) {
    const cand = base === '.' ? ix : `${base}/${ix}`;
    if (fileSet.has(cand)) return cand;
  }

  return null;
}

/**
 * resolvePythonImport(importerDir, spec, fileSet) — Python relative-import
 * resolver. Returns a relative path matching an entry in fileSet, or null.
 *
 * The Python extractor emits relative imports as their raw `relative_import`
 * text with leading dots (one or more), e.g. `.foo`, `..foo.bar`, or just `.`
 * for a bare `from . import …`.
 *
 * Translation rules:
 *   - The first dot is "the current package" (== importerDir).
 *   - Each additional dot is "one parent up".
 *   - After the leading dots, the remainder of the spec is dotted Python
 *     module syntax — we translate dots to slashes.
 *
 * Candidates tried, in order:
 *   - `<resolvedDir>/<modulePath>.py`
 *   - `<resolvedDir>/<modulePath>/__init__.py`
 *
 * Where `<modulePath>` may be empty (e.g. `from . import x`). In that case
 * only the `__init__.py` candidate is meaningful — we return it if present.
 */
function resolvePythonImport(importerDir, spec, fileSet) {
  // Parse leading dots and the rest. `m[1]` is the dot run, `m[2]` is the rest.
  // The extractor preserves these as the literal text from the AST. Examples:
  //   `.foo`        → dots='.', rest='foo'
  //   `..foo.bar`   → dots='..', rest='foo.bar'
  //   `.`           → dots='.', rest=''
  const m = spec.match(/^(\.+)(.*)$/);
  if (!m) return null;
  const dots = m[1];
  const rest = m[2];

  // First dot anchors at importerDir; each subsequent dot pops one parent.
  // E.g. `..` from `pkg/sub/mod.py` (importerDir='pkg/sub') means resolvedDir = 'pkg'.
  // We compute the resolved directory by joining importerDir with `..` * (dots.length - 1).
  let resolvedDir = importerDir;
  for (let i = 0; i < dots.length - 1; i++) {
    // Normalise after each step; path.posix.join collapses `..` properly only
    // when the parent has segments left to consume. If we run past the root,
    // the resolved dir will start with `..`, which will never match anything
    // in fileSet — we bail.
    resolvedDir = path.posix.normalize(path.posix.join(resolvedDir, '..'));
  }
  if (resolvedDir === '..' || resolvedDir.startsWith('../')) return null;

  // Dotted module path → slashes. `foo.bar.baz` → `foo/bar/baz`.
  const modulePath = rest.length > 0 ? rest.replace(/\./g, '/') : '';

  // Compose the lookup base.
  const base = modulePath.length > 0
    ? path.posix.normalize(path.posix.join(resolvedDir, modulePath))
    : resolvedDir;

  // Candidate 1: `<base>.py`. Only when modulePath is non-empty (the
  // resolvedDir-on-its-own form maps to __init__.py only).
  if (modulePath.length > 0) {
    const fileCand = `${base}.py`;
    if (fileSet.has(fileCand)) return fileCand;
  }

  // Candidate 2: `<base>/__init__.py`. Works for both `from . import x` (base
  // = importerDir) and `from .foo import x` (base = importerDir/foo).
  const initCand = base === '' || base === '.' ? '__init__.py' : `${base}/__init__.py`;
  if (fileSet.has(initCand)) return initCand;

  return null;
}

/**
 * resolveEdges({ nodes, edges, project_root }) — main entry point.
 *
 * Walks every `imports` edge whose confidence is `intra-file-only` or
 * `unverified` and tries to resolve its target. Edges already at `verified`
 * pass through untouched.
 *
 * @param {Object} args
 * @param {Object[]} args.nodes     graph nodes array (only `path` is read).
 * @param {Object[]} args.edges     graph edges array.
 * @param {string}   args.project_root  absolute project root (for the rare
 *                                       absolute-spec edge case).
 * @returns {{ edges: Object[], resolved_count: number, unresolved_count: number }}
 */
export function resolveEdges(args) {
  const nodes = Array.isArray(args && args.nodes) ? args.nodes : [];
  const edgesIn = Array.isArray(args && args.edges) ? args.edges : [];
  const projectRoot = typeof (args && args.project_root) === 'string'
    ? args.project_root
    : null;

  // Build the file-path set (relative paths matching node.path) and a quick
  // lookup of nodes by id. Both keyed off `nodes` — the input is trusted.
  const fileSet = new Set();
  const nodeById = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (typeof n[NODE.PATH] === 'string' && n[NODE.PATH].length > 0) {
      fileSet.add(n[NODE.PATH]);
    }
    if (typeof n[NODE.ID] === 'string') {
      nodeById.set(n[NODE.ID], n);
    }
  }

  let resolvedCount = 0;
  let unresolvedCount = 0;
  const edgesOut = new Array(edgesIn.length);

  for (let i = 0; i < edgesIn.length; i++) {
    const e = edgesIn[i];
    if (!e || typeof e !== 'object') {
      edgesOut[i] = e;
      continue;
    }

    // Pass through anything that isn't an `imports` edge.
    if (e[EDGE.TYPE] !== EDGE_TYPES.IMPORTS) {
      edgesOut[i] = e;
      continue;
    }

    // Pass through already-verified edges.
    if (e[EDGE.CONFIDENCE] === CONFIDENCE.VERIFIED) {
      edgesOut[i] = e;
      continue;
    }

    // Only resolve from edges with intra-file-only or unverified confidence.
    if (e[EDGE.CONFIDENCE] !== CONFIDENCE.INTRA_FILE_ONLY &&
        e[EDGE.CONFIDENCE] !== CONFIDENCE.UNVERIFIED) {
      edgesOut[i] = e;
      continue;
    }

    // Get the source file node (where the import originates).
    const fromNode = nodeById.get(e[EDGE.FROM]);
    if (!fromNode || typeof fromNode[NODE.PATH] !== 'string') {
      // Edge from an unknown source — leave it alone. We don't push a
      // warning into a return channel here; the graph validator would have
      // caught structural integrity issues already.
      edgesOut[i] = e;
      unresolvedCount++;
      continue;
    }

    const importerPath = fromNode[NODE.PATH];
    const importerDir = path.posix.dirname(importerPath);
    // `path.posix.dirname('foo.ts')` returns `.` — keep it as-is so
    // `path.posix.join('.', './hub')` produces `hub`.

    const spec = specFromEdge(e);
    if (!spec) {
      edgesOut[i] = e;
      unresolvedCount++;
      continue;
    }

    // Edge case: absolute spec starting with `/`. Try to relativize against
    // project root; if outside root, leave the edge unchanged.
    if (spec.startsWith('/') && projectRoot) {
      const absRoot = path.posix.normalize(projectRoot.split(path.sep).join('/'));
      const prefix = absRoot.endsWith('/') ? absRoot : `${absRoot}/`;
      if (spec.startsWith(prefix)) {
        const rel = spec.slice(prefix.length);
        if (fileSet.has(rel)) {
          edgesOut[i] = makeVerifiedEdge(e, rel);
          resolvedCount++;
          continue;
        }
      }
      edgesOut[i] = e;
      unresolvedCount++;
      continue;
    }

    // Language dispatch.
    const lang = detectLanguage(importerPath);

    let resolved = null;
    if (lang === 'ts' || lang === 'js') {
      // TS/JS resolves only relative imports (./foo, ../bar). Bare specs
      // (`lodash`, `react`) target node_modules and stay unverified.
      if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
        resolved = resolveTSJSImport(importerDir, spec, fileSet);
      }
    } else if (lang === 'py') {
      // Python resolves only relative imports (`.foo`, `..bar.baz`). Absolute
      // imports (`os`, `django.db`) stay unverified.
      if (spec.startsWith('.')) {
        resolved = resolvePythonImport(importerDir, spec, fileSet);
      }
    } else if (lang === 'go' || lang === 'rs') {
      // Phase 1c does NOT resolve Go or Rust imports — see § 10.10 for the
      // disclosure. Both require module-config parsing (go.mod / Cargo.toml).
      resolved = null;
    } else {
      // Unknown source language — nothing we can do.
      resolved = null;
    }

    if (resolved) {
      edgesOut[i] = makeVerifiedEdge(e, resolved);
      resolvedCount++;
    } else {
      edgesOut[i] = e;
      unresolvedCount++;
    }
  }

  return {
    edges: edgesOut,
    resolved_count: resolvedCount,
    unresolved_count: unresolvedCount,
  };
}

/**
 * Make a new edge object representing a verified resolution. We deliberately
 * construct a fresh object rather than mutating the input — resolveEdges is
 * documented as non-mutating, and the input edges array may be the same
 * array the extractors returned (still referenced elsewhere).
 */
function makeVerifiedEdge(edge, resolvedRelPath) {
  return {
    [EDGE.FROM]: edge[EDGE.FROM],
    [EDGE.TO]: fileNodeId(resolvedRelPath),
    [EDGE.TYPE]: edge[EDGE.TYPE],
    [EDGE.CONFIDENCE]: CONFIDENCE.VERIFIED,
  };
}
