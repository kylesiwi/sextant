// lib/graph/extractors/rust.mjs — per-file Rust extractor (Phase 1b).
//
// Given a Rust file's source + relative path, produce the same shape as the
// TS / JS / Python / Go extractors:
//   - ONE file node (id, type='file', label=basename, path=relPath,
//     symbols=<exported names>, community=null)
//   - intra-file-visible edges:
//       * imports edges — one per `use` declaration. Rust `use` paths can have
//         many shapes (scoped_identifier, scoped_use_list, use_wildcard,
//         use_as_clause, bare identifier). We extract the FIRST segment of the
//         path. Three cases:
//           - `use foo::bar;` / `use foo;` / `use foo::{a, b}` → first segment
//             is `foo`. Emit `unresolved:foo` with confidence `unverified`.
//             Phase 1c may add crate-aware resolution.
//           - `use crate::foo::bar;` / `use crate;` → starts with `crate`. We
//             emit `node:crate::foo::bar` (the full path text) with confidence
//             `intra-file-only`. Phase 1c can resolve crate-relative paths.
//           - `use super::foo;` / `use self::foo;` → relative-style. Emit
//             `node:super::foo` / `node:self::foo` with `intra-file-only`.
//         Grouped imports (`use foo::{a, b};`) still emit ONE edge per
//         declaration (the first segment is shared).
//       * declares edges — one per top-level `pub`-visible item:
//           - `pub fn foo() {}` → symbol foo
//           - `pub struct Foo {…}` / tuple struct → symbol Foo
//           - `pub enum Bar { … }` → symbol Bar (variants are NOT extracted)
//           - `pub trait Baz {…}` → symbol Baz
//           - `pub union U {…}` → symbol U
//           - `pub const X: T = …` → symbol X
//           - `pub static Y: T = …` (incl. `static mut`) → symbol Y
//           - `pub type Z = T;` → symbol Z
//           - `pub mod m;` / `pub mod m { … }` → symbol m
//           - `pub use foo::bar;` → bar (the LAST path segment is the imported
//             name; the file re-exports it). For `pub use foo::bar as baz` →
//             `baz` (the alias). For `pub use foo::{a, b}` → each of a, b.
//             For `pub use foo::*;` → no symbol (glob — we don't enumerate the
//             re-exported names).
//   - the list of "exported" symbol names (deduped, source order, capped).
//   - a list of warning strings (parse-error notices, etc.).
//
// Visibility-restricted decls (`pub(crate)`, `pub(super)`, `pub(in path)`)
// also count as exported for Phase 1b. The per-Read context block is about
// what's visible to consumers in the same project; intra-crate visibility
// is still "exported" by that standard. (`pub(self)` is equivalent to
// "no `pub`" — same module only — so it does NOT count.)
//
// What we DON'T do here:
//   - We don't descend into impl_item bodies for methods. `impl Foo { pub fn
//     method() {} }` does NOT surface `method` as a top-level file symbol —
//     same as TS/JS not extracting class methods. Phase 1c+ may add this.
//   - We don't follow `mod m;` to a sibling file. Phase 1c will do that
//     resolution.
//   - We don't extract `extern crate foo;` as an import (legacy 2015 edition;
//     modern Rust just uses Cargo.toml + `use`). Could be added in Phase 1c.
//
// Tree-sitter queries are compiled lazily and cached on the Language object.
// We use a query for top-level items (where visibility is a child); for
// use_declarations, we walk the AST directly because the path shape is too
// varied to express cleanly in S-expression patterns.

import path from 'node:path';
import { Query } from 'web-tree-sitter';

import { loadRustParser } from '../parser.mjs';
import {
  NODE,
  NODE_TYPES,
  EDGE,
  EDGE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../schema.mjs';

// Maximum number of symbol names stored on a file node. Same cap as TS/JS/Py/Go.
const SYMBOLS_CAP = 200;

// Compiled query cache keyed by Language instance.
const _queryCache = new WeakMap();

// Capture-name constants. Pair with the query S-expression below.
//
// For each item-kind we capture both the item node (so we can inspect its
// visibility_modifier child) and the name node. The item-level capture is
// necessary because the visibility_modifier is an OPTIONAL child of the item,
// and there's no clean way to express "match item only IF visibility_modifier
// is present" inside a single pattern that also picks the name — we'd need
// duplicated alternative patterns.
const CAP = Object.freeze({
  // use_declaration — captured as a whole; we walk it manually because its
  // `argument:` field can be any of several path shapes.
  USE_DECL: 'use.decl',

  // function_item — `pub fn name() {}`. Top-level only.
  TOP_FUNCTION: 'top.function',
  TOP_FUNCTION_NAME: 'top.function.name',

  // struct_item — both record-form `pub struct Foo { … }` and tuple-form
  // `pub struct Foo(T, U);` share this node type + name field.
  TOP_STRUCT: 'top.struct',
  TOP_STRUCT_NAME: 'top.struct.name',

  // enum_item — `pub enum Bar { A, B }`. Variants NOT extracted.
  TOP_ENUM: 'top.enum',
  TOP_ENUM_NAME: 'top.enum.name',

  // trait_item — `pub trait Baz {}`.
  TOP_TRAIT: 'top.trait',
  TOP_TRAIT_NAME: 'top.trait.name',

  // union_item — `pub union U { … }`.
  TOP_UNION: 'top.union',
  TOP_UNION_NAME: 'top.union.name',

  // const_item — `pub const X: T = …;`.
  TOP_CONST: 'top.const',
  TOP_CONST_NAME: 'top.const.name',

  // static_item — `pub static Y: T = …;` and `pub static mut Z: T = …;`.
  TOP_STATIC: 'top.static',
  TOP_STATIC_NAME: 'top.static.name',

  // type_item — `pub type Z = T;` (type alias).
  TOP_TYPE: 'top.type',
  TOP_TYPE_NAME: 'top.type.name',

  // mod_item — `pub mod m;` OR `pub mod m { … }`.
  TOP_MOD: 'top.mod',
  TOP_MOD_NAME: 'top.mod.name',
});

// Single S-expression query. Patterns anchored at `(source_file …)` so we
// only match top-level items. Items inside other blocks (function bodies,
// impl blocks, mod inline bodies) don't count as file-level exports.
//
// The visibility_modifier is checked in JS, not in the query. tree-sitter's
// query predicates can match a child's *text*, but anchoring "this item has
// a visibility_modifier child" inside a single pattern requires either
// duplicated patterns (one with the optional child, one without — same name
// capture) or post-filtering. We chose post-filtering for clarity.
const QUERY_TEXT = `
; --- use declarations -------------------------------------------------------
; Capture the whole use_declaration; we walk its argument field manually.
(source_file
  (use_declaration) @${CAP.USE_DECL})

; --- top-level function items -----------------------------------------------
(source_file
  (function_item
    name: (identifier) @${CAP.TOP_FUNCTION_NAME}) @${CAP.TOP_FUNCTION})

; --- top-level struct items -------------------------------------------------
(source_file
  (struct_item
    name: (type_identifier) @${CAP.TOP_STRUCT_NAME}) @${CAP.TOP_STRUCT})

; --- top-level enum items ---------------------------------------------------
(source_file
  (enum_item
    name: (type_identifier) @${CAP.TOP_ENUM_NAME}) @${CAP.TOP_ENUM})

; --- top-level trait items --------------------------------------------------
(source_file
  (trait_item
    name: (type_identifier) @${CAP.TOP_TRAIT_NAME}) @${CAP.TOP_TRAIT})

; --- top-level union items --------------------------------------------------
(source_file
  (union_item
    name: (type_identifier) @${CAP.TOP_UNION_NAME}) @${CAP.TOP_UNION})

; --- top-level const items --------------------------------------------------
(source_file
  (const_item
    name: (identifier) @${CAP.TOP_CONST_NAME}) @${CAP.TOP_CONST})

; --- top-level static items -------------------------------------------------
(source_file
  (static_item
    name: (identifier) @${CAP.TOP_STATIC_NAME}) @${CAP.TOP_STATIC})

; --- top-level type alias items ---------------------------------------------
(source_file
  (type_item
    name: (type_identifier) @${CAP.TOP_TYPE_NAME}) @${CAP.TOP_TYPE})

; --- top-level mod items ----------------------------------------------------
; Covers both \`pub mod m;\` (semicolon form) and \`pub mod m { … }\` (inline).
(source_file
  (mod_item
    name: (identifier) @${CAP.TOP_MOD_NAME}) @${CAP.TOP_MOD})
`;

function getQuery(language) {
  let q = _queryCache.get(language);
  if (q) return q;
  q = new Query(language, QUERY_TEXT);
  _queryCache.set(language, q);
  return q;
}

/**
 * Decide whether an item has any `pub` visibility (including restricted forms
 * like `pub(crate)`, `pub(super)`, `pub(in path)`). Returns false for items
 * without a visibility_modifier child OR with `pub(self)` (which is equivalent
 * to no `pub` at all).
 *
 * Phase 1b treats `pub(crate)`/`pub(super)`/`pub(in path)` as "exported" since
 * the per-Read context block describes what's reachable to consumers in the
 * same project; intra-crate visibility still satisfies that.
 */
function hasExportingVisibility(itemNode) {
  if (!itemNode) return false;
  for (let i = 0; i < itemNode.childCount; i++) {
    const c = itemNode.child(i);
    if (c.type === 'visibility_modifier') {
      // `pub(self)` is the one form that's NOT exported (it's a no-op aliased
      // for `mod`-local visibility). We detect it by scanning the modifier
      // text — it's the only case where the keyword `self` appears INSIDE the
      // visibility parens at the top level (other forms have `crate`, `super`,
      // or `in <path>`).
      const text = c.text;
      if (text === 'pub(self)') return false;
      return true;
    }
  }
  return false;
}

/**
 * Walk a use_declaration node and emit:
 *   - one imports edge (always — every use declaration is an import)
 *   - zero or more re-exported symbol names (if `pub use` is in effect)
 *
 * Rust use-path shapes (per tree-sitter-rust grammar 0.24.0):
 *
 *   identifier              — `use foo;`                      (path = "foo")
 *   scoped_identifier       — `use foo::bar;`                 (last name in path)
 *   scoped_use_list         — `use foo::{a, b};`             (each elem in list)
 *   use_wildcard            — `use foo::*;`                   (glob — no names)
 *   use_as_clause           — `use foo::bar as baz;`         (alias = "baz")
 *
 * For relative-style first segments (`crate`, `super`, `self`), the edge target
 * is the full path text (e.g. `node:crate::foo::bar`) with confidence
 * `intra-file-only`. For absolute-style (anything else), we strip to the first
 * segment and emit `unresolved:<first>` with confidence `unverified`.
 *
 * @param {object} useNode - tree-sitter use_declaration node
 * @returns {{ edge: {to:string,confidence:string}, reExports: string[] }}
 */
function processUseDeclaration(useNode) {
  const result = { edge: null, reExports: [] };

  // 1) Find the `argument` field — the bit between `use` and `;`.
  let arg = null;
  for (let i = 0; i < useNode.childCount; i++) {
    if (useNode.fieldNameForChild(i) === 'argument') {
      arg = useNode.child(i);
      break;
    }
  }
  if (!arg) return result; // malformed (parse error); caller emits a warning elsewhere.

  // 2) Compute (a) the first path segment text, and (b) the full path text
  //    starting from the root identifier. The "innermost path" is the path
  //    field of the outermost scoped_identifier/scoped_use_list/use_as_clause/
  //    use_wildcard.
  const firstSegment = getFirstPathSegment(arg);
  const fullPathText = getFullPathText(arg);

  const isRelative = firstSegment === 'crate' || firstSegment === 'super' || firstSegment === 'self';
  if (isRelative) {
    result.edge = {
      to: `node:${fullPathText}`,
      confidence: CONFIDENCE.INTRA_FILE_ONLY,
    };
  } else {
    result.edge = {
      to: `unresolved:${firstSegment}`,
      confidence: CONFIDENCE.UNVERIFIED,
    };
  }

  // 3) If the use_declaration has a `pub` (or `pub(...)`) visibility_modifier,
  //    extract the re-exported names from the argument.
  if (hasExportingVisibility(useNode)) {
    collectReExportedNames(arg, result.reExports);
  }

  return result;
}

/**
 * Get the FIRST path segment from a use-argument subtree.
 *
 * For scoped_identifier `foo::bar`, the structure is:
 *   scoped_identifier
 *     [path=]identifier "foo"          ← we want this
 *     [name=]identifier "bar"
 *
 * For deeply scoped `a::b::c`:
 *   scoped_identifier "a::b::c"
 *     [path=]scoped_identifier "a::b"
 *       [path=]identifier "a"          ← we want this
 *       [name=]identifier "b"
 *     [name=]identifier "c"
 *
 * For use_wildcard `foo::*`:
 *   use_wildcard
 *     identifier "foo"                 ← first (no field name)
 *     *
 *
 * For use_as_clause `foo::bar as baz`:
 *   use_as_clause
 *     [path=]scoped_identifier "foo::bar"
 *       ... see above
 *     [alias=]identifier "baz"
 *
 * For scoped_use_list `foo::{a, b}`:
 *   scoped_use_list
 *     [path=]identifier "foo"          ← we want this
 *     [list=]use_list "{a, b}"
 *
 * For plain identifier (`use foo;`):
 *   identifier "foo"                   ← itself is the path
 *
 * Special cases: `crate`, `super`, `self` are leaf node types in tree-sitter-rust
 * (not regular identifiers); they appear at the leftmost position of scoped
 * paths. We treat their `.type` as the segment text.
 */
function getFirstPathSegment(node) {
  if (!node) return '';
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self':
      return node.text;
    case 'scoped_identifier':
    case 'scoped_use_list': {
      // Walk into the `path` field.
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'path') {
          return getFirstPathSegment(node.child(i));
        }
      }
      // Fall back to first child if no `path` field — defensive.
      return node.childCount > 0 ? getFirstPathSegment(node.child(0)) : '';
    }
    case 'use_wildcard': {
      // No `path:` field; the first non-anonymous child is the path.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === '::' || c.type === '*') continue;
        return getFirstPathSegment(c);
      }
      return '';
    }
    case 'use_as_clause': {
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'path') {
          return getFirstPathSegment(node.child(i));
        }
      }
      return '';
    }
    default:
      // Anonymous / unexpected — return text as-is. Lets us degrade gracefully
      // if the grammar gets a new node type we don't know about yet.
      return node.text;
  }
}

/**
 * Get the full path text (without the trailing list / wildcard / alias).
 *
 * For `use foo::bar;`              → "foo::bar"
 * For `use crate::foo::bar;`       → "crate::foo::bar"
 * For `use foo::{a, b};`           → "foo" (the path before the list)
 * For `use foo::*;`                → "foo" (the path before the *)
 * For `use foo::bar as baz;`       → "foo::bar"
 * For `use crate;`                 → "crate"
 *
 * We use this to construct intra-file-only edge targets for crate/super/self
 * paths. The "full path" for grouped imports is just the shared prefix (the
 * individual names are recorded as re-exports if it's a `pub use`).
 */
function getFullPathText(node) {
  if (!node) return '';
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self':
      return node.text;
    case 'scoped_identifier':
      // `path::name` — node.text is the joined form already, fine to use.
      return node.text;
    case 'scoped_use_list': {
      // Want only the `path` portion, not the `{…}` list.
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'path') {
          return getFullPathText(node.child(i));
        }
      }
      return '';
    }
    case 'use_wildcard': {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === '::' || c.type === '*') continue;
        return getFullPathText(c);
      }
      return '';
    }
    case 'use_as_clause': {
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'path') {
          return getFullPathText(node.child(i));
        }
      }
      return '';
    }
    default:
      return node.text;
  }
}

/**
 * Collect the names re-exported by a `pub use …` declaration. Mutates `out`.
 *
 * Examples:
 *   `pub use foo::bar;`             → out += ["bar"]
 *   `pub use foo::bar as baz;`      → out += ["baz"]
 *   `pub use foo::{a, b};`          → out += ["a", "b"]
 *   `pub use foo::*;`               → out unchanged (glob, no specific name)
 *   `pub use foo;`                  → out += ["foo"]
 *   `pub use foo::{a, b as renamed, c::*}` → out += ["a", "renamed"]
 *     (the c::* sub-glob produces no name)
 *   `pub use foo::{a, b::{c, d}}`   → out += ["a", "c", "d"]
 *     (nested use_list reachable; descend.)
 *
 * @param {object} node - argument subtree of a use_declaration
 * @param {string[]} out - mutated to receive re-exported names
 */
function collectReExportedNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'self': {
      // Plain `use foo;` → "foo" is the imported name.
      // Inside a use_list, `identifier` children are also direct names.
      // (`crate`/`super`/`self` as bare path are unusual but possible.)
      const t = node.text;
      if (t && t !== 'crate' && t !== 'super' && t !== 'self') {
        out.push(t);
      }
      return;
    }
    case 'scoped_identifier': {
      // The last `name` field is the imported name.
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'name') {
          const nameNode = node.child(i);
          if (nameNode.type === 'identifier' || nameNode.type === 'type_identifier') {
            out.push(nameNode.text);
          }
          return;
        }
      }
      return;
    }
    case 'use_as_clause': {
      // The `alias` field is the re-exported name.
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'alias') {
          const aliasNode = node.child(i);
          if (aliasNode.type === 'identifier' || aliasNode.type === 'type_identifier') {
            out.push(aliasNode.text);
          }
          return;
        }
      }
      return;
    }
    case 'use_wildcard':
      // Glob — no specific name to emit. Skip.
      return;
    case 'scoped_use_list': {
      // Recurse into the `list` field — it contains one or more entries.
      for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) === 'list') {
          collectReExportedNames(node.child(i), out);
          return;
        }
      }
      return;
    }
    case 'use_list': {
      // Iterate the children, skipping `{`, `,`, `}` punctuation.
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === '{' || c.type === ',' || c.type === '}') continue;
        collectReExportedNames(c, out);
      }
      return;
    }
    default:
      // Unknown shape — defensive: try descending one level so future grammar
      // additions still surface SOMETHING rather than silently dropping.
      for (let i = 0; i < node.childCount; i++) {
        collectReExportedNames(node.child(i), out);
      }
      return;
  }
}

/**
 * Walk a tree-sitter tree and detect parse errors. Same shape as TS/JS/Py/Go.
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

    // --- use_declaration ----------------------------------------------------
    if (byName.has(CAP.USE_DECL)) {
      const useNode = byName.get(CAP.USE_DECL);
      const { edge, reExports } = processUseDeclaration(useNode);
      if (edge) pushImportEdge(edges, seenImports, relPath, edge);
      for (const name of reExports) {
        addSymbol(symbols, seenSymbols, edges, relPath, name);
      }
      continue;
    }

    // --- top-level item declarations ----------------------------------------
    //
    // For each item kind: check whether the item-node has `pub` visibility;
    // if so, add the name capture's text as a symbol.
    const itemPairs = [
      [CAP.TOP_FUNCTION, CAP.TOP_FUNCTION_NAME],
      [CAP.TOP_STRUCT,   CAP.TOP_STRUCT_NAME],
      [CAP.TOP_ENUM,     CAP.TOP_ENUM_NAME],
      [CAP.TOP_TRAIT,    CAP.TOP_TRAIT_NAME],
      [CAP.TOP_UNION,    CAP.TOP_UNION_NAME],
      [CAP.TOP_CONST,    CAP.TOP_CONST_NAME],
      [CAP.TOP_STATIC,   CAP.TOP_STATIC_NAME],
      [CAP.TOP_TYPE,     CAP.TOP_TYPE_NAME],
      [CAP.TOP_MOD,      CAP.TOP_MOD_NAME],
    ];
    for (const [itemCap, nameCap] of itemPairs) {
      if (!byName.has(itemCap)) continue;
      const itemNode = byName.get(itemCap);
      if (!hasExportingVisibility(itemNode)) break;
      const nameNode = byName.get(nameCap);
      if (!nameNode) break;
      addSymbol(symbols, seenSymbols, edges, relPath, nameNode.text);
      break;
    }
  }

  // Defensive truncation, same logic as TS/JS/Py/Go extractors.
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
 * Helper: push an imports edge, deduping repeats by target.
 */
function pushImportEdge(edges, seenImports, relPath, { to, confidence }) {
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
 * extractRust({ relPath, source }) — async front door.
 *
 * Loads (or reuses cached) parser, parses, hands off to extractFromTree.
 *
 * @param {{ relPath: string, source: string }} args
 * @returns {Promise<{ node, edges, symbols, errors }>}
 */
export async function extractRust({ relPath, source }) {
  let parser;
  try {
    parser = await loadRustParser();
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
