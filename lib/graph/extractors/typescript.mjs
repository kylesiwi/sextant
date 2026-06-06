// lib/graph/extractors/typescript.mjs — per-file TypeScript extractor (Phase 1a).
//
// Given a TS file's source + relative path, produce:
//   - ONE file node (id, type='file', label=basename, path=relPath,
//     symbols=<exported names>, community=null)
//   - intra-file-visible edges:
//       * imports edges (one per `import` statement; one per re-export with
//         `from`). Cross-file targets are NOT resolved here — that's Phase 1c's
//         job. We emit fileNodeId(<importSpec>) for relative imports and
//         `unresolved:<spec>` placeholders for package imports.
//       * declares edges (one per top-level exported symbol).
//   - the list of exported symbol names (deduped, source order, capped).
//   - a list of warning strings (e.g., parse-error notices).
//
// Cross-file edge resolution (resolving `./foo` → `src/foo.ts`, `extends`,
// `implements`, references) is OUT OF SCOPE here. Phase 1c's graph builder
// reads these unresolved edges and walks them.
//
// Tree-sitter queries are compiled lazily and cached on the language object
// so we don't pay query-compilation cost per file. The same query runs against
// every TS file in a project, regardless of size.

import path from 'node:path';
import { Query } from 'web-tree-sitter';

import { loadTypescriptParser } from '../parser.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../schema.mjs';

// Maximum number of symbol names stored on a file node. Defensive cap —
// pathological generated files might have thousands of exports; the design
// only needs the names for context summaries, so truncation is acceptable.
const SYMBOLS_CAP = 200;

// Compiled query cache keyed by Language instance. Tree-sitter queries are
// language-specific; a new Language → new compilation. In practice we only ever
// see the one TS Language, but keying by language is the correct contract.
const _queryCache = new WeakMap();

// Capture-name constants. These pair with the query S-expression below. If you
// change one side, change the other.
const CAP = Object.freeze({
  IMPORT_STRING: 'import.string',
  EXPORT_FUNCTION: 'export.function.name',
  EXPORT_CLASS: 'export.class.name',
  EXPORT_INTERFACE: 'export.interface.name',
  EXPORT_TYPE: 'export.type.name',
  EXPORT_CONST: 'export.const.name',
  EXPORT_SPEC_NAME: 'export.specifier.name',
  EXPORT_SPEC_ALIAS: 'export.specifier.alias',
  EXPORT_SPEC_SOURCE: 'export.specifier.source',
});

// The single S-expression query. Comments explain non-obvious bits.
//
// Note on re-exports without `from`: `export { x };` (no source) is a way to
// expose an in-scope identifier. We DO want to count `x` as exported, but
// it's already declared elsewhere (in this file or via an import). Phase 1a
// recommendation: include it in symbols ONLY when paired with `from`. The
// reason: when paired with `from`, the declaration originates here from the
// file's perspective — anything else risks double-counting symbols already
// captured by their `function_declaration` / `class_declaration` / etc.
//
// `source: (string)` in the query pattern requires the source field to be
// present, so the bare `export { x };` form won't match.
const QUERY_TEXT = `
; --- imports ---------------------------------------------------------------
(import_statement source: (string) @${CAP.IMPORT_STRING})

; --- export-from re-exports (also count as imports) ------------------------
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @${CAP.EXPORT_SPEC_NAME}
      alias: (identifier)? @${CAP.EXPORT_SPEC_ALIAS}))
  source: (string) @${CAP.EXPORT_SPEC_SOURCE})

; --- export declarations ---------------------------------------------------
(export_statement
  declaration: (function_declaration
    name: (identifier) @${CAP.EXPORT_FUNCTION}))

(export_statement
  declaration: (class_declaration
    name: (type_identifier) @${CAP.EXPORT_CLASS}))

(export_statement
  declaration: (interface_declaration
    name: (type_identifier) @${CAP.EXPORT_INTERFACE}))

(export_statement
  declaration: (type_alias_declaration
    name: (type_identifier) @${CAP.EXPORT_TYPE}))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @${CAP.EXPORT_CONST})))
`;

function getQuery(language) {
  let q = _queryCache.get(language);
  if (q) return q;
  q = new Query(language, QUERY_TEXT);
  _queryCache.set(language, q);
  return q;
}

/**
 * Strip surrounding quotes from a tree-sitter string node's `.text`.
 *
 * tree-sitter's `string` node includes the quote characters in its text
 * (it's a literal node spanning the full token). We want just the inner
 * import specifier. Handles both single and double quotes; falls back to
 * returning the raw text if neither matches (shouldn't happen for valid TS).
 */
function unquote(text) {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Decide the imports-edge target + confidence for an import specifier.
 *
 * Relative paths (start with `.` or `..`) can be resolved later by Phase 1c
 * once it knows the project root; for now we emit fileNodeId(<spec>) with
 * confidence='intra-file-only', meaning "we saw it, target not verified yet".
 *
 * Package imports (anything else) become `unresolved:<spec>` placeholder
 * targets with confidence='unverified'. The reader can choose whether to
 * surface these in any reports.
 */
function classifyImport(spec) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { to: fileNodeId(spec), confidence: CONFIDENCE.INTRA_FILE_ONLY };
  }
  return { to: `unresolved:${spec}`, confidence: CONFIDENCE.UNVERIFIED };
}

/**
 * Walk a tree-sitter tree and detect parse errors.
 *
 * tree-sitter rarely throws; instead it inserts ERROR / MISSING nodes into the
 * tree. The cheap top-level check is `tree.rootNode.hasError` — if false, no
 * recovery happened. If true, we walk to find the first ERROR node so the
 * warning can mention a useful line number.
 *
 * Returns { hasError: boolean, firstErrorLine: number | null }.
 */
function detectParseErrors(rootNode) {
  if (!rootNode || !rootNode.hasError) return { hasError: false, firstErrorLine: null };
  // Tree-sitter Node has .isError on ERROR nodes specifically; .hasError is true
  // anywhere along the path from root to such a node. DFS to find one.
  const stack = [rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.isError || n.isMissing) {
      return { hasError: true, firstErrorLine: n.startPosition.row + 1 };
    }
    // Only descend into subtrees that themselves contain errors — saves work
    // on large clean files where a tail error is the only issue.
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c.hasError) stack.push(c);
    }
  }
  // hasError true but no individual ERROR node located — still report.
  return { hasError: true, firstErrorLine: null };
}

/**
 * extractFromTree(tree, relPath) — pure transformer from a parsed tree to
 * the extractor output. Useful when the caller already holds the parsed
 * tree (the graph builder will, to avoid re-parsing).
 *
 * Synchronous because tree-sitter tree walking is sync.
 *
 * @param {import('web-tree-sitter').Tree | null} tree
 * @param {string} relPath
 * @returns {{ node, edges, symbols, errors }}
 */
export function extractFromTree(tree, relPath) {
  const errors = [];

  if (!tree || !tree.rootNode) {
    // Empty / null tree shouldn't happen in practice (the parser produces a
    // program node even on empty input), but be defensive.
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors: ['tree was null'],
    };
  }

  const root = tree.rootNode;

  // Record parse-error warning before doing query work — the query still
  // works against an erroneous tree, and we want partial extraction.
  const parseErr = detectParseErrors(root);
  if (parseErr.hasError) {
    const loc = parseErr.firstErrorLine ? `at line ${parseErr.firstErrorLine}` : '(no line info)';
    errors.push(`parse tree had error nodes ${loc}`);
  }

  // The Language is reachable through the tree; we use it to compile the
  // query once per Language. Tree → Node → Tree → Language.
  // web-tree-sitter exposes language on the Tree itself in 0.26+.
  const language = tree.language;
  if (!language) {
    // Without the language we can't compile the query. Return what we have.
    errors.push('tree.language missing — cannot run query');
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors,
    };
  }

  let query;
  try {
    query = getQuery(language);
  } catch (err) {
    errors.push(`query compile failed: ${err.message}`);
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors,
    };
  }

  let captures;
  try {
    captures = query.captures(root);
  } catch (err) {
    errors.push(`query.captures failed: ${err.message}`);
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors,
    };
  }

  // captures` from query.captures(root) is captured above only to surface
  // a throw early; the actual work below uses query.matches(root), which
  // keeps multi-capture patterns grouped. The sorted-captures variant was
  // an earlier design that's now dead.

  // Multi-capture patterns (the re-export-with-from rule captures three
  // captures per export_specifier) need pairing. We pair by visiting captures
  // in order: when we see EXPORT_SPEC_NAME, remember it; the next
  // EXPORT_SPEC_ALIAS (if present, at higher startIndex but same parent) wins
  // as the exported name; the matching EXPORT_SPEC_SOURCE on the parent export
  // gives the import edge.
  //
  // The cleanest way to handle this is `query.matches()` instead of
  // `query.captures()` — matches keep multi-capture patterns grouped.
  let matches;
  try {
    matches = query.matches(root);
  } catch (err) {
    errors.push(`query.matches failed: ${err.message}`);
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors,
    };
  }

  const symbols = [];
  const seenSymbols = new Set();
  const edges = [];

  // matches come back in source order; preserve.
  for (const m of matches) {
    // m.captures: array of { name, node }
    const byName = new Map();
    for (const c of m.captures) {
      // For repeating captures, last write wins (we only ever have one capture
      // per name in this query design).
      byName.set(c.name, c.node);
    }

    // --- imports
    if (byName.has(CAP.IMPORT_STRING)) {
      const spec = unquote(byName.get(CAP.IMPORT_STRING).text);
      const { to, confidence } = classifyImport(spec);
      edges.push({
        [EDGE.FROM]: fileNodeId(relPath),
        [EDGE.TO]: to,
        [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
        [EDGE.CONFIDENCE]: confidence,
      });
      continue;
    }

    // --- re-export with `from`
    if (byName.has(CAP.EXPORT_SPEC_SOURCE)) {
      const srcSpec = unquote(byName.get(CAP.EXPORT_SPEC_SOURCE).text);
      // Emit the imports edge for the underlying `from` source.
      const { to, confidence } = classifyImport(srcSpec);
      edges.push({
        [EDGE.FROM]: fileNodeId(relPath),
        [EDGE.TO]: to,
        [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
        [EDGE.CONFIDENCE]: confidence,
      });
      // Determine exported name: alias if present, otherwise the original name.
      const aliasNode = byName.get(CAP.EXPORT_SPEC_ALIAS);
      const nameNode = byName.get(CAP.EXPORT_SPEC_NAME);
      const exportedName = aliasNode ? aliasNode.text : (nameNode ? nameNode.text : null);
      if (exportedName) addSymbol(symbols, seenSymbols, edges, relPath, exportedName);
      continue;
    }

    // --- top-level export declarations
    for (const capName of [
      CAP.EXPORT_FUNCTION,
      CAP.EXPORT_CLASS,
      CAP.EXPORT_INTERFACE,
      CAP.EXPORT_TYPE,
      CAP.EXPORT_CONST,
    ]) {
      if (byName.has(capName)) {
        addSymbol(symbols, seenSymbols, edges, relPath, byName.get(capName).text);
      }
    }
  }

  // Defensive truncation of the symbols list (and the corresponding edges
  // already in the array — but since we emit declares edges in the same loop
  // as we push symbols, the caller would need to trim edges too. We trim
  // declares-only edges paired with truncated symbols here).
  if (symbols.length > SYMBOLS_CAP) {
    const overflow = symbols.length - SYMBOLS_CAP;
    const trimmedSymbols = symbols.slice(0, SYMBOLS_CAP);
    // Filter out declares edges whose `to` references a symbol that got trimmed.
    const keepNames = new Set(trimmedSymbols);
    const trimmedEdges = edges.filter((e) => {
      if (e[EDGE.TYPE] !== EDGE_TYPES.DECLARES) return true;
      // Extract symbol name from the symbolNodeId 'node:<relpath>#<name>'.
      const hash = e[EDGE.TO].indexOf('#');
      if (hash < 0) return true; // shouldn't happen, but keep
      const name = e[EDGE.TO].slice(hash + 1);
      return keepNames.has(name);
    });
    errors.push(`truncated symbols list: ${overflow} entries beyond ${SYMBOLS_CAP}`);
    return {
      node: makeFileNode(relPath, trimmedSymbols),
      edges: trimmedEdges,
      symbols: trimmedSymbols,
      errors,
    };
  }

  return {
    node: makeFileNode(relPath, symbols),
    edges,
    symbols,
    errors,
  };
}

/**
 * Helper: append a symbol to the dedup-tracked list and emit its declares
 * edge in lockstep. Mutates symbols, seenSymbols, and edges in place.
 */
function addSymbol(symbols, seenSymbols, edges, relPath, name) {
  if (!name) return;
  if (seenSymbols.has(name)) return;
  seenSymbols.add(name);
  symbols.push(name);
  edges.push({
    [EDGE.FROM]: fileNodeId(relPath),
    [EDGE.TO]: symbolNodeId(relPath, name),
    [EDGE.TYPE]: EDGE_TYPES.DECLARES,
    [EDGE.CONFIDENCE]: CONFIDENCE.VERIFIED,
  });
}

/**
 * Construct a file node per the schema.
 */
function makeFileNode(relPath, symbols) {
  return {
    [NODE.ID]: fileNodeId(relPath),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: path.basename(relPath),
    [NODE.PATH]: relPath,
    [NODE.SYMBOLS]: symbols,
    [NODE.COMMUNITY]: null,
  };
}

/**
 * extractTypescript({ relPath, source }) — async front door.
 *
 * Loads (or reuses cached) parser, parses, hands off to extractFromTree.
 * Catches any synchronous throw inside the parse step and returns a soft
 * failure (the caller — typically the graph builder — should not crash on a
 * single file's parse failure).
 *
 * @param {{ relPath: string, source: string }} args
 * @returns {Promise<{ node, edges, symbols, errors }>}
 */
export async function extractTypescript({ relPath, source }) {
  let parser;
  try {
    parser = await loadTypescriptParser();
  } catch (err) {
    return {
      node: null,
      edges: [],
      symbols: [],
      errors: [`parser load failed: ${err.message}`],
    };
  }
  if (!parser) {
    return {
      node: null,
      edges: [],
      symbols: [],
      errors: ['parser unavailable'],
    };
  }
  let tree;
  try {
    tree = parser.parse(source ?? '');
  } catch (err) {
    return {
      node: null,
      edges: [],
      symbols: [],
      errors: [`parse failed: ${err.message}`],
    };
  }
  return extractFromTree(tree, relPath);
}
