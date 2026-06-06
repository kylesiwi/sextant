// Tests for lib/graph/extractors/rust.mjs — per-file Rust extractor.
//
// Strategy: same as the TS/JS/Py/Go extractor tests.
//   - Use loadRustParser() once at module scope so we pay the WASM cost a
//     single time across all tests in this file.
//   - Most cases call extractFromTree() with a pre-parsed tree (sync, fast).
//   - A couple call extractRust() to exercise the async front door.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRust,
  extractFromTree,
} from '../lib/graph/extractors/rust.mjs';
import {
  loadRustParser,
  parseRust,
  __resetCacheForTests,
} from '../lib/graph/parser.mjs';
import {
  EDGE,
  EDGE_TYPES,
  NODE,
  NODE_TYPES,
  CONFIDENCE,
  fileNodeId,
  symbolNodeId,
} from '../lib/graph/schema.mjs';

__resetCacheForTests();
const PARSER = await loadRustParser();
assert.ok(PARSER, 'failed to load Rust parser at module top — abort');

function parse(src) {
  return parseRust(PARSER, src);
}

// --- 1. empty / trivial source --------------------------------------------

test('RS: empty source yields a node with no symbols and no edges', () => {
  const out = extractFromTree(parse(''), 'lib.rs');
  // Empty source is valid Rust (it parses to an empty source_file).
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.equal(out.node[NODE.ID], fileNodeId('lib.rs'));
  assert.equal(out.node[NODE.LABEL], 'lib.rs');
  assert.equal(out.node[NODE.PATH], 'lib.rs');
  assert.deepEqual(out.node[NODE.SYMBOLS], []);
  assert.equal(out.node[NODE.COMMUNITY], null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.errors, []);
});

// --- 2. use declarations (imports) ----------------------------------------

test('RS: `use foo::bar;` → 1 unresolved import edge to first segment "foo"', () => {
  const out = extractFromTree(parse('use foo::bar;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.rs'));
  assert.equal(e[EDGE.TO], 'unresolved:foo');
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('RS: `use foo::{a, b, c};` → 1 import edge (shared first segment)', () => {
  const out = extractFromTree(parse('use foo::{a, b, c};\n'), 'a.rs');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.TO], 'unresolved:foo');
  assert.equal(imports[0][EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('RS: `use foo;` (bare) → 1 import edge to "foo"', () => {
  const out = extractFromTree(parse('use foo;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:foo');
});

test('RS: `use foo::*;` (glob) → 1 import edge to "foo"', () => {
  const out = extractFromTree(parse('use foo::*;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:foo');
});

test('RS: `use foo::bar as baz;` (rename) → 1 import edge to "foo"', () => {
  const out = extractFromTree(parse('use foo::bar as baz;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:foo');
});

test('RS: `use crate::foo::bar;` → intra-file-only edge with full path', () => {
  const out = extractFromTree(parse('use crate::foo::bar;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], 'node:crate::foo::bar');
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('RS: `use super::foo;` → intra-file-only edge', () => {
  const out = extractFromTree(parse('use super::foo;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'node:super::foo');
  assert.equal(out.edges[0][EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('RS: `use self::foo;` → intra-file-only edge', () => {
  const out = extractFromTree(parse('use self::foo;\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'node:self::foo');
  assert.equal(out.edges[0][EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('RS: `use crate::foo::{a, b};` → intra-file-only edge for prefix path', () => {
  const out = extractFromTree(parse('use crate::foo::{a, b};\n'), 'a.rs');
  assert.equal(out.edges.length, 1);
  // Full path for a scoped_use_list is the path field (the `crate::foo` part).
  assert.equal(out.edges[0][EDGE.TO], 'node:crate::foo');
  assert.equal(out.edges[0][EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('RS: duplicate `use foo` declarations dedupe to 1 edge', () => {
  // Two separate `use foo;` lines — not strictly valid Rust (compiler warns
  // on duplicate uses), but defensive deduplication is important.
  const out = extractFromTree(parse('use foo::bar;\nuse foo::baz;\n'), 'a.rs');
  // Both target unresolved:foo since they share the first segment.
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
});

// --- 3. pub use re-exports ------------------------------------------------

test('RS: `pub use foo::bar;` → 1 import edge AND symbol "bar"', () => {
  const out = extractFromTree(parse('pub use foo::bar;\n'), 'a.rs');
  // Symbol: bar (the last name in the path).
  assert.deepEqual(out.symbols, ['bar']);
  // Edge: import to foo, unverified.
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.TO], 'unresolved:foo');
  // Also a declares edge for bar.
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
  assert.equal(decs[0][EDGE.TO], symbolNodeId('a.rs', 'bar'));
});

test('RS: `pub use foo::bar as baz;` → symbol "baz" (the alias)', () => {
  const out = extractFromTree(parse('pub use foo::bar as baz;\n'), 'a.rs');
  assert.deepEqual(out.symbols, ['baz']);
});

test('RS: `pub use foo::{a, b};` → symbols ["a", "b"]', () => {
  const out = extractFromTree(parse('pub use foo::{a, b};\n'), 'a.rs');
  assert.deepEqual(out.symbols, ['a', 'b']);
});

test('RS: `pub use foo::*;` → no specific symbol (glob)', () => {
  const out = extractFromTree(parse('pub use foo::*;\n'), 'a.rs');
  assert.deepEqual(out.symbols, []);
  // The import edge is still emitted.
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TYPE], EDGE_TYPES.IMPORTS);
});

test('RS: `pub use foo;` (bare) → symbol "foo"', () => {
  const out = extractFromTree(parse('pub use foo;\n'), 'a.rs');
  assert.deepEqual(out.symbols, ['foo']);
});

test('RS: `pub(crate) use foo::bar;` → symbol "bar" (restricted vis still counts)', () => {
  const out = extractFromTree(parse('pub(crate) use foo::bar;\n'), 'a.rs');
  assert.deepEqual(out.symbols, ['bar']);
});

// --- 4. function items ----------------------------------------------------

test('RS: `pub fn foo() {}` → symbol "foo" + declares edge', () => {
  const out = extractFromTree(parse('pub fn foo() {}\n'), 'f.rs');
  assert.deepEqual(out.symbols, ['foo']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
  assert.equal(decs[0][EDGE.TO], symbolNodeId('f.rs', 'foo'));
  assert.equal(decs[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('RS: `fn private() {}` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('fn private() {}\n'), 'f.rs');
  assert.deepEqual(out.symbols, []);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 0);
});

test('RS: `pub(crate) fn bar() {}` → symbol "bar" (restricted vis counts)', () => {
  const out = extractFromTree(parse('pub(crate) fn bar() {}\n'), 'f.rs');
  assert.deepEqual(out.symbols, ['bar']);
});

test('RS: `pub(super) fn baz() {}` → symbol "baz" (restricted vis counts)', () => {
  const out = extractFromTree(parse('pub(super) fn baz() {}\n'), 'f.rs');
  assert.deepEqual(out.symbols, ['baz']);
});

test('RS: `pub(in crate::foo) fn nested() {}` → symbol "nested"', () => {
  const out = extractFromTree(parse('pub(in crate::foo) fn nested() {}\n'), 'f.rs');
  assert.deepEqual(out.symbols, ['nested']);
});

// --- 5. struct items ------------------------------------------------------

test('RS: `pub struct Foo {}` (record) → symbol "Foo"', () => {
  const out = extractFromTree(parse('pub struct Foo { x: u32 }\n'), 's.rs');
  assert.deepEqual(out.symbols, ['Foo']);
});

test('RS: `pub struct Foo(u32, String);` (tuple) → symbol "Foo"', () => {
  const out = extractFromTree(parse('pub struct Foo(u32, String);\n'), 's.rs');
  assert.deepEqual(out.symbols, ['Foo']);
});

test('RS: `struct Foo {}` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('struct Foo {}\n'), 's.rs');
  assert.deepEqual(out.symbols, []);
});

// --- 6. enum items --------------------------------------------------------

test('RS: `pub enum Bar { A, B }` → symbol "Bar" only (variants NOT extracted)', () => {
  const out = extractFromTree(parse('pub enum Bar { A, B }\n'), 'e.rs');
  assert.deepEqual(out.symbols, ['Bar']);
});

test('RS: `enum Bar { A, B }` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('enum Bar { A, B }\n'), 'e.rs');
  assert.deepEqual(out.symbols, []);
});

// --- 7. const / static / type items ----------------------------------------

test('RS: `pub const MAX: u32 = 100;` → symbol "MAX"', () => {
  const out = extractFromTree(parse('pub const MAX: u32 = 100;\n'), 'c.rs');
  assert.deepEqual(out.symbols, ['MAX']);
});

test('RS: `const PRIVATE: u32 = 0;` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('const PRIVATE: u32 = 0;\n'), 'c.rs');
  assert.deepEqual(out.symbols, []);
});

test('RS: `pub static Y: u32 = 2;` → symbol "Y"', () => {
  const out = extractFromTree(parse('pub static Y: u32 = 2;\n'), 'st.rs');
  assert.deepEqual(out.symbols, ['Y']);
});

test('RS: `pub static mut Z: u32 = 2;` → symbol "Z"', () => {
  const out = extractFromTree(parse('pub static mut Z: u32 = 2;\n'), 'st.rs');
  assert.deepEqual(out.symbols, ['Z']);
});

test('RS: `pub type Z = u32;` → symbol "Z"', () => {
  const out = extractFromTree(parse('pub type Z = u32;\n'), 't.rs');
  assert.deepEqual(out.symbols, ['Z']);
});

test('RS: `type Z = u32;` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('type Z = u32;\n'), 't.rs');
  assert.deepEqual(out.symbols, []);
});

// --- 8. trait items -------------------------------------------------------

test('RS: `pub trait Bar {}` → symbol "Bar"', () => {
  const out = extractFromTree(parse('pub trait Bar {}\n'), 'tr.rs');
  assert.deepEqual(out.symbols, ['Bar']);
});

test('RS: `trait Bar {}` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('trait Bar {}\n'), 'tr.rs');
  assert.deepEqual(out.symbols, []);
});

// --- 9. union items -------------------------------------------------------

test('RS: `pub union U { x: u32 }` → symbol "U"', () => {
  const out = extractFromTree(parse('pub union U { x: u32 }\n'), 'u.rs');
  assert.deepEqual(out.symbols, ['U']);
});

// --- 10. mod items --------------------------------------------------------

test('RS: `pub mod foo;` (semicolon form) → symbol "foo"', () => {
  const out = extractFromTree(parse('pub mod foo;\n'), 'm.rs');
  assert.deepEqual(out.symbols, ['foo']);
});

test('RS: `pub mod m { pub fn x() {} }` (inline form) → symbol "m" only', () => {
  // Inline modules: we surface the module name, but NOT items inside.
  // (Phase 1c may revisit.)
  const out = extractFromTree(parse('pub mod m { pub fn x() {} }\n'), 'm.rs');
  // Just the top-level mod symbol — the inner `pub fn x()` is inside the mod,
  // not at file top level.
  assert.deepEqual(out.symbols, ['m']);
});

test('RS: `mod foo;` (no pub) → NOT a symbol', () => {
  const out = extractFromTree(parse('mod foo;\n'), 'm.rs');
  assert.deepEqual(out.symbols, []);
});

// --- 11. impl blocks (skipped for Phase 1b) -------------------------------

test('RS: methods inside `impl Foo { pub fn method() {} }` are NOT top-level symbols', () => {
  const src = `pub struct Foo;

impl Foo {
  pub fn method() {}
}
`;
  const out = extractFromTree(parse(src), 'i.rs');
  // Foo is exported. method is inside an impl block and is NOT surfaced.
  assert.deepEqual(out.symbols, ['Foo']);
});

test('RS: `impl SomeTrait for Foo { pub fn method() {} }` → no method symbol', () => {
  const src = `pub struct Foo;
pub trait SomeTrait { fn method(); }

impl SomeTrait for Foo {
  fn method() {}
}
`;
  const out = extractFromTree(parse(src), 'it.rs');
  // Foo and SomeTrait are exported. The impl's method is NOT surfaced.
  assert.ok(out.symbols.includes('Foo'));
  assert.ok(out.symbols.includes('SomeTrait'));
  assert.ok(!out.symbols.includes('method'),
    `'method' should NOT be in symbols; got: ${JSON.stringify(out.symbols)}`);
});

// --- 12. function bodies don't surface nested items -----------------------

test('RS: function-local items are NOT exported symbols', () => {
  const src = `pub fn outer() {
  fn inner() {}
  let _ = inner;
}
`;
  const out = extractFromTree(parse(src), 'n.rs');
  // outer is exported; inner is function-local — must not appear.
  assert.deepEqual(out.symbols, ['outer']);
});

// --- 13. source-order preservation ----------------------------------------

test('RS: top-level items emitted in source order', () => {
  const src = `pub fn a() {}
pub struct B;
pub const C: u32 = 1;
pub trait D {}
pub type E = u32;
`;
  const out = extractFromTree(parse(src), 'order.rs');
  assert.deepEqual(out.symbols, ['a', 'B', 'C', 'D', 'E']);
});

// --- 14. dedup -------------------------------------------------------------

test('RS: same name surfaced twice (defensive) → 1 symbol', () => {
  // Not legal Rust, but ensures our addSymbol dedup works.
  // We can't easily craft a legal-but-duplicate situation without impl, so we
  // use a struct + a pub use to alias-rename to the same name (compiler may
  // catch this; tree-sitter parses it).
  const src = `pub struct Foo;
pub use other::Foo;
`;
  const out = extractFromTree(parse(src), 'd.rs');
  // Foo appears in struct AND in pub use's last segment; dedup → one entry.
  const fooCount = out.symbols.filter((s) => s === 'Foo').length;
  assert.equal(fooCount, 1,
    `expected exactly 1 Foo, got ${fooCount}; symbols=${JSON.stringify(out.symbols)}`);
});

// --- 15. parse-error tolerance --------------------------------------------

test('RS: malformed source returns a node + warning, no crash', () => {
  // Missing closing brace.
  const src = `pub fn foo() {
`;
  const out = extractFromTree(parse(src), 'bad.rs');
  assert.notEqual(out.node, null);
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.ok(out.errors.length > 0);
  assert.match(out.errors[0], /parse tree had error/);
});

// --- 16. smoke-test combined ----------------------------------------------

test('RS: smoke-test mix of imports + exports + unexported', () => {
  const src = `use std::collections::HashMap;
use crate::helpers::format;

pub const MAX: u32 = 100;
const PRIVATE: u32 = 0;

pub struct Server {
    port: u16,
}

pub fn run() -> Result<(), String> {
    Ok(())
}

fn private_helper() {}

impl Server {
    pub fn new() -> Self { Server { port: 8080 } }
}
`;
  const out = extractFromTree(parse(src), 'lib.rs');
  // Symbols: MAX, Server, run — and NOT PRIVATE, private_helper, new (impl method).
  assert.deepEqual(out.symbols, ['MAX', 'Server', 'run']);

  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 2);
  // First: std (unverified), second: crate::helpers::format (intra-file-only).
  const std = imports.find((e) => e[EDGE.TO] === 'unresolved:std');
  assert.ok(std, `expected unresolved:std edge; got ${JSON.stringify(imports)}`);
  assert.equal(std[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
  const crateEdge = imports.find((e) => e[EDGE.TO] === 'node:crate::helpers::format');
  assert.ok(crateEdge, `expected node:crate::helpers::format edge; got ${JSON.stringify(imports)}`);
  assert.equal(crateEdge[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);

  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 3);
});

// --- 17. async front door --------------------------------------------------

test('extractRust() async API: parses + extracts a typical file', async () => {
  const out = await extractRust({
    relPath: 'demo.rs',
    source: 'use std::io;\n\npub fn alpha() {}\n',
  });
  assert.notEqual(out.node, null);
  assert.deepEqual(out.symbols, ['alpha']);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(imports.length, 1);
  assert.equal(decs.length, 1);
});

test('extractRust() with empty source returns a valid empty file node', async () => {
  const out = await extractRust({ relPath: 'empty.rs', source: '' });
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
});

// --- 18. performance smoke -------------------------------------------------

test('RS: ~200-line synthetic file extracts in < 200 ms', () => {
  const lines = [];
  // 50 use declarations.
  for (let i = 0; i < 50; i++) lines.push(`use mod${i}::Item${i};`);
  lines.push('');
  // 50 pub fn items.
  for (let i = 0; i < 50; i++) {
    lines.push(`pub fn fn${i}() -> i32 { ${i} }`);
  }
  // 100 filler comment lines.
  for (let i = 0; i < 100; i++) lines.push(`// filler line ${i}`);
  const src = lines.join('\n');

  const t0 = process.hrtime.bigint();
  const tree = parse(src);
  const out = extractFromTree(tree, 'big.rs');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  process.stdout.write(`# RS extractor 200-line perf: ${ms.toFixed(2)} ms (target < 50 ms)\n`);
  assert.ok(ms < 200, `extraction took ${ms.toFixed(2)} ms (> 200 ms hard ceiling)`);
  assert.equal(out.symbols.length, 50);
  assert.equal(out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS).length, 50);
});
