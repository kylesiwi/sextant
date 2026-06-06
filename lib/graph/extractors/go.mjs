// lib/graph/extractors/go.mjs — per-file Go extractor (Phase 1b).
//
// Given a Go file's source + relative path, produce the same shape as the
// TS / JS / Python extractors:
//   - ONE file node (id, type='file', label=basename, path=relPath,
//     symbols=<exported names>, community=null)
//   - intra-file-visible edges:
//       * imports edges — one per `import "X"` clause. Grouped imports
//         (`import ( "a" "b" )`) emit one edge per `import_spec`. Aliased
//         imports (`import alias "foo"`) still target the literal path "foo"
//         (the alias only renames the binding inside this file).
//         Go modules use absolute import paths; we treat ALL Go imports as
//         `unresolved:<spec>` with confidence `unverified`. Phase 1c may
//         add module-aware resolution.
//       * declares edges — one per top-level "exported" name. Go's convention:
//         identifiers beginning with an uppercase letter are exported, lower-
//         case are package-private. We surface uppercase names from:
//           - `func Foo()`
//           - `func (r Recv) Foo()` (method on a type — surfaced as `Foo`,
//             qualified-name handling is intentionally out of scope here)
//           - `type Foo struct {…}` / `type Foo interface {…}` / `type Foo = X`
//           - top-level `var Foo = …` (single OR grouped)
//           - top-level `const Foo = …` (single OR grouped)
//   - the list of "exported" symbol names (deduped, source order, capped).
//   - a list of warning strings (parse-error notices, etc.).
//
// What we DON'T do here:
//   - We don't record the package name. The basename is on `node.label`; the
//     package name is informational only at Phase 1a/b. Phase 1c may add a
//     dedicated field if cross-package resolution wants it.
//   - We don't qualify method names by their receiver type. `func (r *Foo) Bar()`
//     surfaces as `Bar`, not `Foo.Bar`. That's a deliberate choice — symbols
//     in this list are read by the per-Read context block, which just wants
//     names. Phase 1c+ may revisit if reference resolution needs it.
//   - We don't descend into function bodies for nested decls.
//
// Tree-sitter queries are compiled lazily and cached on the Language object.

import path from 'node:path';
import { Query } from 'web-tree-sitter';

import { loadGoParser } from '../parser.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../schema.mjs';

// Maximum number of symbol names stored on a file node. Same cap as TS/JS/Py.
const SYMBOLS_CAP = 200;

// Compiled query cache keyed by Language instance.
const _queryCache = new WeakMap();

// Capture-name constants. Pair with the query S-expression below.
const CAP = Object.freeze({
  // Import path (the quoted string in `import "foo"` / `import alias "foo"`).
  // Captured at the interpreted_string_literal level; we strip the quotes.
  IMPORT_PATH: 'import.path',
  // Raw string literal alternative (`import `+"`foo`"+`` — rare but legal).
  IMPORT_PATH_RAW: 'import.path.raw',

  // Top-level `func Foo() {}` — capture is the identifier (the func name).
  TOP_FUNCTION_NAME: 'top.function.name',
  // Top-level `func (r *Recv) Foo() {}` — capture is the field_identifier.
  TOP_METHOD_NAME: 'top.method.name',

  // Top-level `type Foo struct {…}` etc. — capture is the type_identifier.
  TOP_TYPE_SPEC_NAME: 'top.type.spec.name',
  // Top-level `type Foo = Bar` (type alias) — capture is the type_identifier.
  TOP_TYPE_ALIAS_NAME: 'top.type.alias.name',

  // Top-level `var X = …` (single form) — capture is the identifier.
  TOP_VAR_NAME: 'top.var.name',
  // Top-level grouped `var ( X = …; Y = … )` — capture is each identifier.
  TOP_VAR_GROUP_NAME: 'top.var.group.name',

  // Top-level `const X = …` (single OR grouped — both go through `const_spec`
  // children of `const_declaration` with no extra wrapper).
  TOP_CONST_NAME: 'top.const.name',
});

// The single S-expression query. Each pattern is anchored at `(source_file …)`
// so we only collect top-level names — declarations inside function bodies
// (Go allows `func F() { var x = 1; … }`) don't qualify as file-level
// exports. Function-local types/vars are scoped to their function anyway.
const QUERY_TEXT = `
; --- imports ----------------------------------------------------------------
; Single import: import "fmt"
; Grouped imports: import ( "a" "b" ) — each import_spec yields one match.
; Aliased: import alias "foo" — still capture the path "foo".
(import_spec
  path: (interpreted_string_literal) @${CAP.IMPORT_PATH})

; Raw-string-literal imports: import \`fmt\` (rare; tree-sitter-go supports it).
(import_spec
  path: (raw_string_literal) @${CAP.IMPORT_PATH_RAW})

; --- top-level function declarations ---------------------------------------
(source_file
  (function_declaration
    name: (identifier) @${CAP.TOP_FUNCTION_NAME}))

; --- top-level method declarations -----------------------------------------
(source_file
  (method_declaration
    name: (field_identifier) @${CAP.TOP_METHOD_NAME}))

; --- top-level type declarations -------------------------------------------
; Both single (type Foo struct {}) and grouped (type ( Foo struct{}; Bar struct{} ))
; use direct (type_spec) children of (type_declaration) — the grouped form
; just has more of them, no wrapper node.
(source_file
  (type_declaration
    (type_spec
      name: (type_identifier) @${CAP.TOP_TYPE_SPEC_NAME})))

; Type aliases: type Foo = Bar (and the grouped equivalent).
(source_file
  (type_declaration
    (type_alias
      name: (type_identifier) @${CAP.TOP_TYPE_ALIAS_NAME})))

; --- top-level var declarations --------------------------------------------
; Single form: var X = 1 / var X, Y = 1, 2  — direct var_spec child.
(source_file
  (var_declaration
    (var_spec
      name: (identifier) @${CAP.TOP_VAR_NAME})))

; Grouped form: var ( X = 1; Y = 2 ) — wrapped in var_spec_list.
(source_file
  (var_declaration
    (var_spec_list
      (var_spec
        name: (identifier) @${CAP.TOP_VAR_GROUP_NAME}))))

; --- top-level const declarations ------------------------------------------
; Both single (const X = 1) and grouped (const ( X = 1; Y = 2 )) use direct
; (const_spec) children — same structure as type_declaration.
(source_file
  (const_declaration
    (const_spec
      name: (identifier) @${CAP.TOP_CONST_NAME})))
`;

function getQuery(language) {
  let q = _queryCache.get(language);
  if (q) return q;
  q = new Query(language, QUERY_TEXT);
  _queryCache.set(language, q);
  return q;
}

/**
 * Strip surrounding quote characters from a Go string-literal node's `.text`.
 *
 * Go has two string literal forms:
 *   - interpreted_string_literal: "foo" (double-quoted, supports escapes)
 *   - raw_string_literal: `foo` (backtick-delimited, no escapes)
 *
 * tree-sitter-go nests the literal contents inside the literal node, and the
 * node's `.text` includes the surrounding delimiters. We strip them.
 */
function unquoteGoString(text) {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Decide the imports-edge target + confidence for a Go import.
 *
 * Go module paths are always absolute (e.g., "fmt", "github.com/x/y",
 * "example.com/mod/sub"). There's no relative-import convention at the source
 * level, so every Go import gets `unresolved:<spec>` with confidence
 * `unverified`. Phase 1c may add module-aware resolution.
 */
function classifyImport(spec) {
  return { to: `unresolved:${spec}`, confidence: CONFIDENCE.UNVERIFIED };
}

/**
 * Is `name` an exported Go identifier? Go's convention: leading uppercase
 * letter (A-Z) makes a symbol exported. Anything else (lowercase, underscore,
 * digit) is package-private. Unicode uppercase letters also count per the
 * spec, but we keep it ASCII for now — the existing extractors all use ASCII
 * conventions too.
 */
function isExportedName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const c = name.charCodeAt(0);
  return c >= 0x41 && c <= 0x5a; // 'A'..'Z'
}

/**
 * Walk a tree-sitter tree and detect parse errors. Same shape as TS/JS/Py.
 */
function detectParseErrors(rootNode) {
  if (!rootNode || !rootNode.hasError) return { hasError: false, firstErrorLine: null };
  const stack = [rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (n.isError || n.isMissing) {
      return { hasError: true, firstErrorLine: n.startPosition.row + 1 };
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c.hasError) stack.push(c);
    }
  }
  return { hasError: true, firstErrorLine: null };
}

/**
 * extractFromTree(tree, relPath) — pure transformer from a parsed tree to
 * the extractor output. Synchronous; tree-sitter tree walking is sync.
 *
 * @param {import('web-tree-sitter').Tree | null} tree
 * @param {string} relPath
 * @returns {{ node, edges, symbols, errors }}
 */
export function extractFromTree(tree, relPath) {
  const errors = [];

  if (!tree || !tree.rootNode) {
    return {
      node: makeFileNode(relPath, []),
      edges: [],
      symbols: [],
      errors: ['tree was null'],
    };
  }

  const root = tree.rootNode;

  const parseErr = detectParseErrors(root);
  if (parseErr.hasError) {
    const loc = parseErr.firstErrorLine ? `at line ${parseErr.firstErrorLine}` : '(no line info)';
    errors.push(`parse tree had error nodes ${loc}`);
  }

  const language = tree.language;
  if (!language) {
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
  const seenImports = new Set();
  const edges = [];

  // matches come back in source order; preserve.
  for (const m of matches) {
    const byName = new Map();
    for (const c of m.captures) {
      byName.set(c.name, c.node);
    }
    if (byName.size === 0) continue;

    // --- imports (interpreted or raw string literal)
    if (byName.has(CAP.IMPORT_PATH)) {
      const spec = unquoteGoString(byName.get(CAP.IMPORT_PATH).text);
      pushImportEdge(edges, seenImports, relPath, spec);
      continue;
    }
    if (byName.has(CAP.IMPORT_PATH_RAW)) {
      const spec = unquoteGoString(byName.get(CAP.IMPORT_PATH_RAW).text);
      pushImportEdge(edges, seenImports, relPath, spec);
      continue;
    }

    // --- top-level decls — only emit the symbol if uppercase-exported.
    for (const capName of [
      CAP.TOP_FUNCTION_NAME,
      CAP.TOP_METHOD_NAME,
      CAP.TOP_TYPE_SPEC_NAME,
      CAP.TOP_TYPE_ALIAS_NAME,
      CAP.TOP_VAR_NAME,
      CAP.TOP_VAR_GROUP_NAME,
      CAP.TOP_CONST_NAME,
    ]) {
      if (byName.has(capName)) {
        const name = byName.get(capName).text;
        if (isExportedName(name)) {
          addSymbol(symbols, seenSymbols, edges, relPath, name);
        }
      }
    }
  }

  // Defensive truncation, same logic as TS/JS/Py extractors.
  if (symbols.length > SYMBOLS_CAP) {
    const overflow = symbols.length - SYMBOLS_CAP;
    const trimmedSymbols = symbols.slice(0, SYMBOLS_CAP);
    const keepNames = new Set(trimmedSymbols);
    const trimmedEdges = edges.filter((e) => {
      if (e[EDGE.TYPE] !== EDGE_TYPES.DECLARES) return true;
      const hash = e[EDGE.TO].indexOf('#');
      if (hash < 0) return true;
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
 * Helper: push an imports edge for a Go import-spec, deduping repeats.
 *
 * In valid Go a single file can't legally `import "foo"` twice, but if it
 * tries (or after macro-style code generation), we collapse to one edge.
 */
function pushImportEdge(edges, seenImports, relPath, rawSpec) {
  const { to, confidence } = classifyImport(rawSpec);
  if (seenImports.has(to)) return;
  seenImports.add(to);
  edges.push({
    [EDGE.FROM]: fileNodeId(relPath),
    [EDGE.TO]: to,
    [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
    [EDGE.CONFIDENCE]: confidence,
  });
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
 * extractGo({ relPath, source }) — async front door.
 *
 * Loads (or reuses cached) parser, parses, hands off to extractFromTree.
 *
 * @param {{ relPath: string, source: string }} args
 * @returns {Promise<{ node, edges, symbols, errors }>}
 */
export async function extractGo({ relPath, source }) {
  let parser;
  try {
    parser = await loadGoParser();
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
