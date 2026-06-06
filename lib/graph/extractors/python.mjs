// lib/graph/extractors/python.mjs — per-file Python extractor (Phase 1b).
//
// Given a Python file's source + relative path, produce the same shape as the
// TypeScript and JavaScript extractors:
//   - ONE file node (id, type='file', label=basename, path=relPath,
//     symbols=<exported names>, community=null)
//   - intra-file-visible edges:
//       * imports edges — one per top-level `import` clause and one per
//         `from X import …` statement. Cross-file targets are NOT resolved
//         here — Phase 1c's job. Relative imports get fileNodeId(<spec>);
//         absolute / package imports get `unresolved:<spec>`.
//       * declares edges — one per top-level "exported" name. Python has no
//         explicit export keyword: convention is that top-level `def`, `class`,
//         and uppercase `CONST = ...` assignments are exported, and any name
//         beginning with `_` is private.
//   - the list of "exported" symbol names (deduped, source order, capped).
//   - a list of warning strings (parse-error notices, etc.).
//
// What we DON'T do here:
//   - We don't honour `__all__` declarations. Phase 1a level: convention only.
//   - We don't descend into class bodies for method names — only top-level
//     names count as file symbols.
//   - We don't try to resolve `from .foo import bar` to a concrete file —
//     Phase 1c will do that once it knows the project layout.
//
// Tree-sitter queries are compiled lazily and cached on the Language object.

import path from 'node:path';
import { Query } from 'web-tree-sitter';

import { loadPythonParser } from '../parser.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../schema.mjs';

// Maximum number of symbol names stored on a file node. Same cap as TS/JS.
const SYMBOLS_CAP = 200;

// Uppercase-constant convention: `MAX_RETRIES`, `_FOO_BAR` etc. We treat a
// top-level assignment as a "constant export" iff its LHS identifier matches
// this pattern. The pattern also enforces a leading non-underscore letter so
// `_PRIVATE_CONST` is rejected even though it'd otherwise match the all-caps
// rule.
const UPPERCASE_CONST_RE = /^[A-Z][A-Z0-9_]*$/;

// Compiled query cache keyed by Language instance.
const _queryCache = new WeakMap();

// Capture-name constants. Pair with the query S-expression below.
const CAP = Object.freeze({
  // Plain `import foo` / `import os.path` — capture is the dotted_name.
  IMPORT_BARE_NAME: 'import.bare.name',
  // `import foo as bar` — capture is the inner dotted_name (the original module).
  IMPORT_ALIASED_NAME: 'import.aliased.name',

  // `from X import …` — capture is X (a dotted_name for absolute imports).
  IMPORT_FROM_DOTTED: 'import.from.dotted',
  // `from .X import …` / `from ..X import …` — capture is the relative_import
  // node; we read its text and translate to `./X` / `../X`.
  IMPORT_FROM_RELATIVE: 'import.from.relative',

  // Top-level `def name(): …`
  TOP_FUNCTION_NAME: 'top.function.name',
  // Top-level `class Name: …`
  TOP_CLASS_NAME: 'top.class.name',
  // Top-level `@decorator def name(): …` — wraps in decorated_definition.
  TOP_FUNCTION_DEC_NAME: 'top.function.dec.name',
  // Top-level `@decorator class Name: …` — wraps in decorated_definition.
  TOP_CLASS_DEC_NAME: 'top.class.dec.name',

  // Top-level `NAME = …` assignment where LHS is a single identifier.
  TOP_ASSIGN_NAME: 'top.assign.name',
});

// The single S-expression query. Each pattern is anchored at `(module …)`
// so we only collect top-level names — definitions inside class bodies,
// conditional blocks, and function bodies don't qualify as "exports".
const QUERY_TEXT = `
; --- plain imports ----------------------------------------------------------
; "import foo", "import os.path", "import a, b" (each name yields one match)
(import_statement
  (dotted_name) @${CAP.IMPORT_BARE_NAME})

; "import foo as bar" — capture the underlying dotted_name (i.e. "foo")
(import_statement
  (aliased_import
    (dotted_name) @${CAP.IMPORT_ALIASED_NAME}))

; --- from-imports -----------------------------------------------------------
; "from foo.bar import baz" / "from foo import *" — module_name is dotted_name
(import_from_statement
  module_name: (dotted_name) @${CAP.IMPORT_FROM_DOTTED})

; "from .foo import x" / "from . import x" — module_name is relative_import
(import_from_statement
  module_name: (relative_import) @${CAP.IMPORT_FROM_RELATIVE})

; --- top-level function/class definitions -----------------------------------
; Anchored at (module ...) so nested defs (inside classes, conditionals,
; function bodies) don't qualify. The decorated_definition wrapper is matched
; separately because the decorator changes the parent node type.

(module
  (function_definition
    name: (identifier) @${CAP.TOP_FUNCTION_NAME}))

(module
  (class_definition
    name: (identifier) @${CAP.TOP_CLASS_NAME}))

(module
  (decorated_definition
    definition: (function_definition
      name: (identifier) @${CAP.TOP_FUNCTION_DEC_NAME})))

(module
  (decorated_definition
    definition: (class_definition
      name: (identifier) @${CAP.TOP_CLASS_DEC_NAME})))

; --- top-level constant assignments ----------------------------------------
; Matches "NAME = …" where the LHS is a single identifier. We accept ALL
; assignments and filter for the UPPERCASE_CONST convention in JS — the
; pattern would need a #match? predicate to filter in-query, but predicate
; support varies by web-tree-sitter version, so we keep the filter in JS.
;
; (expression_statement ...) wraps simple assignments at the module level.
(module
  (expression_statement
    (assignment
      left: (identifier) @${CAP.TOP_ASSIGN_NAME})))
`;

function getQuery(language) {
  let q = _queryCache.get(language);
  if (q) return q;
  q = new Query(language, QUERY_TEXT);
  _queryCache.set(language, q);
  return q;
}

/**
 * Decide the imports-edge target + confidence for a Python import.
 *
 * Three cases:
 *   - Absolute / package import (`os`, `requests`, `django.db`) → emit
 *     `unresolved:<spec>` with confidence `unverified`. We can't resolve
 *     third-party / stdlib package paths without project config.
 *   - Relative import as a string starting with `.` or `..` → emit
 *     `fileNodeId('./X' or '../X')` with confidence `intra-file-only`.
 *     Phase 1c will translate to a concrete file path.
 *
 * The caller passes the import-spec text in a normalised form (dotted name
 * with no `.` prefix for absolute, OR raw `relative_import` text like
 * `.foo` / `..` for relative).
 */
function classifyImportSpec(rawSpec, isRelative) {
  if (isRelative) {
    // Translate relative_import text:
    //   "."     → "./"     (or just ".") — bare current-package
    //   ".."    → "../"    — bare parent-package
    //   ".foo"  → "./foo"
    //   "..foo" → "../foo"
    //   "...foo" → "../../foo"  (each additional dot is "../")
    const m = rawSpec.match(/^(\.+)(.*)$/);
    let translated;
    if (!m) {
      translated = rawSpec; // shouldn't happen — relative_import always starts with a dot
    } else {
      const dots = m[1];
      const rest = m[2];
      // The first dot means "current package"; each additional dot means
      // "one parent up". So one dot → './', two dots → '../', three dots → '../../', etc.
      const parentCount = dots.length - 1;
      const prefix = parentCount === 0 ? './' : '../'.repeat(parentCount);
      translated = rest.length ? `${prefix}${rest}` : prefix.replace(/\/$/, '');
      // If the rest is empty and prefix is './' we'd get '.' (no trailing /).
      // For '../' alone, we'd get '..' — also fine.
    }
    return {
      to: fileNodeId(translated),
      confidence: CONFIDENCE.INTRA_FILE_ONLY,
    };
  }
  // Absolute (package / stdlib) import — placeholder until project config knows
  // where third-party code lives. Use unresolved:<dotted-spec> verbatim.
  return {
    to: `unresolved:${rawSpec}`,
    confidence: CONFIDENCE.UNVERIFIED,
  };
}

/**
 * Walk a tree-sitter tree and detect parse errors. Same shape as TS/JS.
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

    // --- plain imports ("import foo", "import a, b" — one match per name)
    if (byName.has(CAP.IMPORT_BARE_NAME)) {
      const spec = byName.get(CAP.IMPORT_BARE_NAME).text;
      pushImportEdge(edges, seenImports, relPath, spec, /*isRelative*/ false);
      continue;
    }

    // --- aliased plain imports ("import foo as bar" — capture is "foo")
    if (byName.has(CAP.IMPORT_ALIASED_NAME)) {
      const spec = byName.get(CAP.IMPORT_ALIASED_NAME).text;
      pushImportEdge(edges, seenImports, relPath, spec, /*isRelative*/ false);
      continue;
    }

    // --- from-imports, absolute
    if (byName.has(CAP.IMPORT_FROM_DOTTED)) {
      const spec = byName.get(CAP.IMPORT_FROM_DOTTED).text;
      pushImportEdge(edges, seenImports, relPath, spec, /*isRelative*/ false);
      continue;
    }

    // --- from-imports, relative
    if (byName.has(CAP.IMPORT_FROM_RELATIVE)) {
      const spec = byName.get(CAP.IMPORT_FROM_RELATIVE).text;
      pushImportEdge(edges, seenImports, relPath, spec, /*isRelative*/ true);
      continue;
    }

    // --- top-level function/class definitions (incl. decorated)
    for (const capName of [
      CAP.TOP_FUNCTION_NAME,
      CAP.TOP_CLASS_NAME,
      CAP.TOP_FUNCTION_DEC_NAME,
      CAP.TOP_CLASS_DEC_NAME,
    ]) {
      if (byName.has(capName)) {
        const name = byName.get(capName).text;
        if (!isPrivateName(name)) {
          addSymbol(symbols, seenSymbols, edges, relPath, name);
        }
      }
    }

    // --- top-level assignment — only uppercase-constant convention names
    if (byName.has(CAP.TOP_ASSIGN_NAME)) {
      const name = byName.get(CAP.TOP_ASSIGN_NAME).text;
      // Apply both the uppercase pattern AND the "starts with `_`" private rule.
      // The pattern already excludes leading-underscore names, but be explicit.
      if (UPPERCASE_CONST_RE.test(name) && !isPrivateName(name)) {
        addSymbol(symbols, seenSymbols, edges, relPath, name);
      }
    }
  }

  // Defensive truncation, same logic as TS/JS extractors.
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
 * Is `name` a Python convention-private name? Phase 1b: any leading underscore
 * counts. Dunder names like `__init__` also start with `_`, so the same rule
 * keeps them out of the exported symbol list (sensible — they're not module
 * surface).
 */
function isPrivateName(name) {
  return typeof name === 'string' && name.length > 0 && name[0] === '_';
}

/**
 * Helper: push an imports edge for a Python import-spec, deduping repeats.
 *
 * Python lets you write `import foo` and `from foo import bar` in the same
 * file; both surface the same module, but they're semantically distinct
 * statements. We dedupe by the (to, type) tuple so the same target only
 * appears once per file — that mirrors how the TS/JS extractors collapse
 * `import x from './foo'; import y from './foo'` into a single edge.
 */
function pushImportEdge(edges, seenImports, relPath, rawSpec, isRelative) {
  const { to, confidence } = classifyImportSpec(rawSpec, isRelative);
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
 * extractPython({ relPath, source }) — async front door.
 *
 * Loads (or reuses cached) parser, parses, hands off to extractFromTree.
 *
 * @param {{ relPath: string, source: string }} args
 * @returns {Promise<{ node, edges, symbols, errors }>}
 */
export async function extractPython({ relPath, source }) {
  let parser;
  try {
    parser = await loadPythonParser();
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
