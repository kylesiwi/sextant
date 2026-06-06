// lib/graph/extractors/javascript.mjs — per-file JavaScript extractor (Phase 1b).
//
// Given a JS file's source + relative path, produce the same shape as the
// TypeScript extractor:
//   - ONE file node (id, type='file', label=basename, path=relPath,
//     symbols=<exported names>, community=null)
//   - intra-file-visible edges:
//       * imports edges — one per `import` statement, one per re-export with
//         `from`, AND one per CommonJS `require('./x')` call. Cross-file
//         targets are NOT resolved here — Phase 1c's job. We emit
//         fileNodeId(<importSpec>) for relative imports and
//         `unresolved:<spec>` placeholders for package imports.
//       * declares edges — one per top-level exported symbol (ESM or CJS).
//   - the list of exported symbol names (deduped, source order, capped).
//   - a list of warning strings (e.g., parse-error notices).
//
// JavaScript-specific extraction (above what TS already does):
//   1. `const x = require('./foo')` — emit an imports edge with the same shape
//      as the ESM `import { x } from './foo'` edge. We don't care about the
//      LHS pattern (destructure / single ident / etc.); the spec string alone
//      drives the edge.
//   2. `module.exports = foo` / `module.exports = function() {...}` —
//      Phase 1b convention: when the RHS is a plain identifier, we treat that
//      identifier as the "default" exported symbol. Symbol name in that case
//      is the literal identifier (e.g., `foo`); we do NOT synthesize a
//      `default` placeholder. This mirrors TS's "export default function foo()"
//      handling (symbol = foo, not default).
//   3. `module.exports = { foo, bar }` — shorthand object, each shorthand
//      property becomes an exported symbol.
//   4. `module.exports.foo = ...` and `exports.foo = ...` — emit `foo` as
//      an exported symbol.
//
// What we DON'T do here:
//   - We don't resolve `module.exports = foo` to the actual function/class
//     declaration of `foo` elsewhere in the file. We just record `foo` as
//     the exported name; Phase 1c+ can cross-reference if it cares.
//   - We don't try to extract symbols for non-exported top-level
//     functions/classes/consts. Same as TS — Phase 1a only surfaces what's
//     exported.
//
// Tree-sitter queries are compiled lazily and cached on the Language object.

import path from 'node:path';
import { Query } from 'web-tree-sitter';

import { loadJavascriptParser } from '../parser.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../schema.mjs';

// Maximum number of symbol names stored on a file node. Same cap as TS.
const SYMBOLS_CAP = 200;

// Compiled query cache keyed by Language instance.
const _queryCache = new WeakMap();

// Capture-name constants. Predicate-helper captures (those starting with `_`)
// only exist to anchor `(#eq? ...)` predicates and are filtered out before
// the match loop runs.
const CAP = Object.freeze({
  IMPORT_STRING: 'import.string',

  // CommonJS require('./x')
  CJS_REQUIRE_STRING: 'cjs.require.string',

  // ESM exports
  EXPORT_FUNCTION: 'export.function.name',
  EXPORT_CLASS: 'export.class.name',
  EXPORT_CONST: 'export.const.name',

  // ESM re-export with `from`
  EXPORT_SPEC_NAME: 'export.specifier.name',
  EXPORT_SPEC_ALIAS: 'export.specifier.alias',
  EXPORT_SPEC_SOURCE: 'export.specifier.source',

  // CJS module.exports = <identifier>
  CJS_MODULE_DEFAULT_NAME: 'cjs.module.default.name',
  // CJS module.exports = { foo, bar }  (shorthand property identifier per element)
  CJS_MODULE_OBJECT_NAME: 'cjs.module.object.name',
  // CJS module.exports.NAME = ...
  CJS_MODULE_NAMED_NAME: 'cjs.module.named.name',
  // CJS exports.NAME = ...
  CJS_EXPORTS_NAMED_NAME: 'cjs.exports.named.name',
});

// The single S-expression query covering both ESM and CJS.
//
// Notes on the CJS patterns:
//   - We use predicate captures starting with `_` to assert "this identifier
//     equals 'module' / 'exports' / 'require'". Tree-sitter queries don't have
//     an "equals literal" matcher inside the s-expression syntax itself, so
//     the predicate dance is the canonical pattern.
//   - The CJS `module.exports = identifier` pattern emits the RHS identifier
//     name as a symbol. Phase 1b convention: that name IS the exported
//     symbol's name (not `default`). For `module.exports = function() {}`
//     (anonymous), no symbol is emitted — same as `export default function() {}`
//     in TS.
//
// Source-order matters: the file node's symbols array is in source order.
// query.matches() returns matches in source order, so the iteration below
// preserves that.
const QUERY_TEXT = `
; --- ESM imports ---------------------------------------------------------
(import_statement source: (string) @${CAP.IMPORT_STRING})

; --- CJS require() -------------------------------------------------------
(call_expression
  function: (identifier) @_req
  arguments: (arguments (string) @${CAP.CJS_REQUIRE_STRING})
  (#eq? @_req "require"))

; --- ESM export-from re-exports (count as imports + a symbol) ------------
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @${CAP.EXPORT_SPEC_NAME}
      alias: (identifier)? @${CAP.EXPORT_SPEC_ALIAS}))
  source: (string) @${CAP.EXPORT_SPEC_SOURCE})

; --- ESM top-level export declarations -----------------------------------
; The "declaration:" field is also populated for "export default function
; named() {}" and "export default class Named {}", so these rules cover
; default-with-name too.
(export_statement
  declaration: (function_declaration
    name: (identifier) @${CAP.EXPORT_FUNCTION}))

(export_statement
  declaration: (class_declaration
    name: (identifier) @${CAP.EXPORT_CLASS}))

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @${CAP.EXPORT_CONST})))

; --- CJS module.exports = <identifier> ----------------------------------
; e.g. module.exports = foo;
(assignment_expression
  left: (member_expression
    object: (identifier) @_modObj1
    property: (property_identifier) @_modProp1)
  right: (identifier) @${CAP.CJS_MODULE_DEFAULT_NAME}
  (#eq? @_modObj1 "module")
  (#eq? @_modProp1 "exports"))

; --- CJS module.exports = { foo, bar } shorthand ------------------------
(assignment_expression
  left: (member_expression
    object: (identifier) @_modObj2
    property: (property_identifier) @_modProp2)
  right: (object
    (shorthand_property_identifier) @${CAP.CJS_MODULE_OBJECT_NAME})
  (#eq? @_modObj2 "module")
  (#eq? @_modProp2 "exports"))

; --- CJS module.exports.NAME = ... --------------------------------------
(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @_modObj3
      property: (property_identifier) @_modProp3)
    property: (property_identifier) @${CAP.CJS_MODULE_NAMED_NAME})
  (#eq? @_modObj3 "module")
  (#eq? @_modProp3 "exports"))

; --- CJS exports.NAME = ... ---------------------------------------------
; Distinct from module.exports.NAME — uses bare \`exports\` (it's a Node.js
; convention that exports is an alias of module.exports, though that breaks
; once you re-assign module.exports).
(assignment_expression
  left: (member_expression
    object: (identifier) @_exportsObj
    property: (property_identifier) @${CAP.CJS_EXPORTS_NAMED_NAME})
  (#eq? @_exportsObj "exports"))
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
 * Same helper as the TS extractor.
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
 * Same logic as the TS extractor.
 */
function classifyImport(spec) {
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    return { to: fileNodeId(spec), confidence: CONFIDENCE.INTRA_FILE_ONLY };
  }
  return { to: `unresolved:${spec}`, confidence: CONFIDENCE.UNVERIFIED };
}

/**
 * Walk a tree-sitter tree and detect parse errors. Same as TS extractor.
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
  const edges = [];

  // matches come back in source order; preserve.
  for (const m of matches) {
    // Build a name→node lookup, skipping predicate-helper captures (those
    // starting with `_`) since those are only there to anchor `#eq?` checks.
    const byName = new Map();
    for (const c of m.captures) {
      if (c.name.startsWith('_')) continue;
      byName.set(c.name, c.node);
    }
    if (byName.size === 0) continue;

    // --- ESM imports
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

    // --- CJS require()
    if (byName.has(CAP.CJS_REQUIRE_STRING)) {
      const spec = unquote(byName.get(CAP.CJS_REQUIRE_STRING).text);
      const { to, confidence } = classifyImport(spec);
      edges.push({
        [EDGE.FROM]: fileNodeId(relPath),
        [EDGE.TO]: to,
        [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
        [EDGE.CONFIDENCE]: confidence,
      });
      continue;
    }

    // --- ESM re-export with `from`
    if (byName.has(CAP.EXPORT_SPEC_SOURCE)) {
      const srcSpec = unquote(byName.get(CAP.EXPORT_SPEC_SOURCE).text);
      const { to, confidence } = classifyImport(srcSpec);
      edges.push({
        [EDGE.FROM]: fileNodeId(relPath),
        [EDGE.TO]: to,
        [EDGE.TYPE]: EDGE_TYPES.IMPORTS,
        [EDGE.CONFIDENCE]: confidence,
      });
      const aliasNode = byName.get(CAP.EXPORT_SPEC_ALIAS);
      const nameNode = byName.get(CAP.EXPORT_SPEC_NAME);
      const exportedName = aliasNode ? aliasNode.text : (nameNode ? nameNode.text : null);
      if (exportedName) addSymbol(symbols, seenSymbols, edges, relPath, exportedName);
      continue;
    }

    // --- ESM top-level export declarations
    for (const capName of [
      CAP.EXPORT_FUNCTION,
      CAP.EXPORT_CLASS,
      CAP.EXPORT_CONST,
    ]) {
      if (byName.has(capName)) {
        addSymbol(symbols, seenSymbols, edges, relPath, byName.get(capName).text);
      }
    }

    // --- CJS module.exports = <ident>  →  treat ident as the exported name
    if (byName.has(CAP.CJS_MODULE_DEFAULT_NAME)) {
      addSymbol(symbols, seenSymbols, edges, relPath, byName.get(CAP.CJS_MODULE_DEFAULT_NAME).text);
    }

    // --- CJS module.exports = { foo, bar }
    if (byName.has(CAP.CJS_MODULE_OBJECT_NAME)) {
      addSymbol(symbols, seenSymbols, edges, relPath, byName.get(CAP.CJS_MODULE_OBJECT_NAME).text);
    }

    // --- CJS module.exports.NAME = ...
    if (byName.has(CAP.CJS_MODULE_NAMED_NAME)) {
      addSymbol(symbols, seenSymbols, edges, relPath, byName.get(CAP.CJS_MODULE_NAMED_NAME).text);
    }

    // --- CJS exports.NAME = ...
    if (byName.has(CAP.CJS_EXPORTS_NAMED_NAME)) {
      addSymbol(symbols, seenSymbols, edges, relPath, byName.get(CAP.CJS_EXPORTS_NAMED_NAME).text);
    }
  }

  // Defensive truncation, same logic as TS extractor.
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
 * extractJavascript({ relPath, source }) — async front door.
 *
 * Loads (or reuses cached) parser, parses, hands off to extractFromTree.
 *
 * @param {{ relPath: string, source: string }} args
 * @returns {Promise<{ node, edges, symbols, errors }>}
 */
export async function extractJavascript({ relPath, source }) {
  let parser;
  try {
    parser = await loadJavascriptParser();
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
