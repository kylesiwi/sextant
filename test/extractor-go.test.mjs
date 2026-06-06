// Tests for lib/graph/extractors/go.mjs — per-file Go extractor.
//
// Strategy: same as the TS/JS/Py extractor tests.
//   - Use loadGoParser() once at module scope so we pay the WASM cost a
//     single time across all tests in this file.
//   - Most cases call extractFromTree() with a pre-parsed tree (sync, fast).
//   - A couple call extractGo() to exercise the async front door.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractGo,
  extractFromTree,
} from '../lib/graph/extractors/go.mjs';
import {
  loadGoParser,
  parseGo,
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
const PARSER = await loadGoParser();
assert.ok(PARSER, 'failed to load Go parser at module top — abort');

function parse(src) {
  return parseGo(PARSER, src);
}

// --- 1. empty / package-only source ---------------------------------------

test('GO: package-only source yields a node with no symbols and no edges', () => {
  // The minimal legal Go file is `package main`. We don't surface the package
  // name as a symbol — just emit a clean file node.
  const out = extractFromTree(parse('package main\n'), 'main.go');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.equal(out.node[NODE.ID], fileNodeId('main.go'));
  assert.equal(out.node[NODE.LABEL], 'main.go');
  assert.equal(out.node[NODE.PATH], 'main.go');
  assert.deepEqual(out.node[NODE.SYMBOLS], []);
  assert.equal(out.node[NODE.COMMUNITY], null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.errors, []);
});

test('GO: empty source yields a node + parse-error warning (not crash)', () => {
  // Truly empty input isn't valid Go (every file requires `package …`), so
  // tree-sitter produces an ERROR node. We still return a usable node.
  const out = extractFromTree(parse(''), 'empty.go');
  assert.notEqual(out.node, null);
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.edges, []);
});

// --- 2. imports ------------------------------------------------------------

test('GO: `import "fmt"` → one unresolved imports edge', () => {
  const out = extractFromTree(parse('package main\n\nimport "fmt"\n'), 'a.go');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.go'));
  assert.equal(e[EDGE.TO], 'unresolved:fmt');
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('GO: grouped imports `import ( "a" "b" )` → two import edges', () => {
  const src = `package main

import (
  "a"
  "b"
)
`;
  const out = extractFromTree(parse(src), 'g.go');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 2, `expected 2 imports, got ${JSON.stringify(imports)}`);
  const tos = imports.map((e) => e[EDGE.TO]).sort();
  assert.deepEqual(tos, ['unresolved:a', 'unresolved:b']);
  for (const e of imports) {
    assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
  }
});

test('GO: aliased import `import alias "foo"` → edge targets "foo" (ignore alias)', () => {
  const src = `package main

import alias "foo"
`;
  const out = extractFromTree(parse(src), 'al.go');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:foo');
});

test('GO: dot-import `import . "fmt"` → edge targets "fmt"', () => {
  // The `.` import-spec name pulls package symbols into local scope; for
  // imports-edge purposes we still target the literal path.
  const src = `package main

import . "fmt"
`;
  const out = extractFromTree(parse(src), 'd.go');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:fmt');
});

test('GO: blank-import `import _ "lib"` → edge targets "lib"', () => {
  // `_` is the blank identifier; the import runs the package's init() side
  // effect. Still an import.
  const src = `package main

import _ "lib"
`;
  const out = extractFromTree(parse(src), 'b.go');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:lib');
});

test('GO: dotted module path `import "github.com/x/y"` preserved verbatim', () => {
  const src = `package main

import "github.com/x/y"
`;
  const out = extractFromTree(parse(src), 'm.go');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:github.com/x/y');
});

test('GO: duplicate imports dedupe to one edge', () => {
  // Not legal Go, but defensive — code generators can produce duplicates.
  const src = `package main

import (
  "fmt"
  "fmt"
)
`;
  const out = extractFromTree(parse(src), 'dup.go');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
});

// --- 3. function declarations → symbols (when exported) -------------------

test('GO: top-level `func Foo() {}` → symbol Foo + declares edge', () => {
  const src = `package main

func Foo() {}
`;
  const out = extractFromTree(parse(src), 'f.go');
  assert.deepEqual(out.symbols, ['Foo']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
  assert.equal(decs[0][EDGE.TO], symbolNodeId('f.go', 'Foo'));
  assert.equal(decs[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('GO: top-level lowercase `func foo() {}` → NOT a symbol', () => {
  const src = `package main

func foo() {}
`;
  const out = extractFromTree(parse(src), 'f.go');
  assert.deepEqual(out.symbols, []);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 0);
});

// --- 4. method declarations → symbols (when exported) --------------------

test('GO: `func (r *Receiver) Method()` → symbol Method', () => {
  const src = `package main

type Receiver struct{}

func (r *Receiver) Method() {}
`;
  const out = extractFromTree(parse(src), 'm.go');
  // Receiver type Receiver is uppercase → also surfaced.
  assert.ok(out.symbols.includes('Receiver'),
    `expected Receiver in symbols, got: ${JSON.stringify(out.symbols)}`);
  assert.ok(out.symbols.includes('Method'),
    `expected Method in symbols, got: ${JSON.stringify(out.symbols)}`);
});

test('GO: lowercase method `func (r *Recv) hidden()` → NOT a symbol', () => {
  const src = `package main

type Recv struct{}

func (r *Recv) hidden() {}
`;
  const out = extractFromTree(parse(src), 'h.go');
  // Recv is exported; hidden is not.
  assert.deepEqual(out.symbols, ['Recv']);
});

test('GO: value receiver `func (r Receiver) Method()` → symbol Method', () => {
  // Both `func (r *Receiver) M()` (pointer) and `func (r Receiver) M()` (value)
  // are method_declarations with the same field_identifier — confirm.
  const src = `package main

type Receiver struct{}

func (r Receiver) ValueMethod() {}
`;
  const out = extractFromTree(parse(src), 'v.go');
  assert.ok(out.symbols.includes('ValueMethod'));
});

// --- 5. type declarations → symbols (when exported) ----------------------

test('GO: `type Foo struct {}` → symbol Foo', () => {
  const src = `package main

type Foo struct {
  Port int
}
`;
  const out = extractFromTree(parse(src), 't.go');
  assert.deepEqual(out.symbols, ['Foo']);
});

test('GO: lowercase `type foo struct {}` → NOT a symbol', () => {
  const src = `package main

type foo struct{}
`;
  const out = extractFromTree(parse(src), 't.go');
  assert.deepEqual(out.symbols, []);
});

test('GO: `type Bar interface {}` → symbol Bar', () => {
  const src = `package main

type Bar interface {
  Do() error
}
`;
  const out = extractFromTree(parse(src), 'i.go');
  assert.deepEqual(out.symbols, ['Bar']);
});

test('GO: type alias `type MyInt = int` → symbol MyInt', () => {
  const src = `package main

type MyInt = int
`;
  const out = extractFromTree(parse(src), 'a.go');
  assert.deepEqual(out.symbols, ['MyInt']);
});

test('GO: grouped `type ( Foo struct{}; bar struct{} )` → only Foo', () => {
  const src = `package main

type (
  Foo struct{}
  bar struct{}
)
`;
  const out = extractFromTree(parse(src), 'g.go');
  assert.deepEqual(out.symbols, ['Foo']);
});

// --- 6. var declarations → symbols (when exported) -----------------------

test('GO: top-level `var Foo = 1` → symbol Foo', () => {
  const src = `package main

var Foo = 1
`;
  const out = extractFromTree(parse(src), 'v.go');
  assert.deepEqual(out.symbols, ['Foo']);
});

test('GO: top-level lowercase `var foo = 1` → NOT a symbol', () => {
  const src = `package main

var foo = 1
`;
  const out = extractFromTree(parse(src), 'v.go');
  assert.deepEqual(out.symbols, []);
});

test('GO: top-level `var X, Y = 1, 2` → symbols X and Y', () => {
  const src = `package main

var X, Y = 1, 2
`;
  const out = extractFromTree(parse(src), 'v.go');
  // Both names exported; both surfaced.
  assert.ok(out.symbols.includes('X'));
  assert.ok(out.symbols.includes('Y'));
});

test('GO: grouped `var ( X = 1; y = 2 )` → only X', () => {
  const src = `package main

var (
  X = 1
  y = 2
)
`;
  const out = extractFromTree(parse(src), 'g.go');
  assert.deepEqual(out.symbols, ['X']);
});

// --- 7. const declarations → symbols (when exported) ---------------------

test('GO: top-level `const Foo = 1` → symbol Foo', () => {
  const src = `package main

const Foo = 1
`;
  const out = extractFromTree(parse(src), 'c.go');
  assert.deepEqual(out.symbols, ['Foo']);
});

test('GO: top-level lowercase `const foo = 1` → NOT a symbol', () => {
  const src = `package main

const foo = 1
`;
  const out = extractFromTree(parse(src), 'c.go');
  assert.deepEqual(out.symbols, []);
});

test('GO: grouped `const ( A = 1; b = 2; C = 3 )` → only A and C', () => {
  const src = `package main

const (
  A = 1
  b = 2
  C = 3
)
`;
  const out = extractFromTree(parse(src), 'c.go');
  assert.deepEqual(out.symbols, ['A', 'C']);
});

// --- 8. nested decls inside function bodies are NOT top-level -----------

test('GO: function-local `var` declarations are NOT exported symbols', () => {
  const src = `package main

func Outer() {
  var Hidden = 1
  _ = Hidden
}
`;
  const out = extractFromTree(parse(src), 'n.go');
  // Outer is exported. Hidden is function-local — must not appear.
  assert.deepEqual(out.symbols, ['Outer']);
});

test('GO: function-local `type` declarations are NOT exported symbols', () => {
  const src = `package main

func Outer() {
  type Local struct{}
  var _ Local
}
`;
  const out = extractFromTree(parse(src), 'n.go');
  assert.deepEqual(out.symbols, ['Outer']);
});

// --- 9. source-order preservation ------------------------------------------

test('GO: top-level decls emitted in source order', () => {
  const src = `package main

func A() {}
type B struct{}
const C = 1
var D = 2

func (r *B) E() {}
`;
  const out = extractFromTree(parse(src), 'order.go');
  // A (func), B (type), C (const), D (var), E (method) in this order.
  assert.deepEqual(out.symbols, ['A', 'B', 'C', 'D', 'E']);
});

// --- 10. dedup -------------------------------------------------------------

test('GO: same name surfaced twice (defensive) → 1 symbol', () => {
  // Not legal Go, but ensures our addSymbol dedup works.
  // We synthesize the situation by having two declarations the parser
  // accepts: a method on two types sharing the same method name is fine,
  // but emits the same field_identifier text twice — that's a real case
  // (different receivers, same method name).
  const src = `package main

type A struct{}
type B struct{}

func (a *A) Run() {}
func (b *B) Run() {}
`;
  const out = extractFromTree(parse(src), 'd.go');
  // A, B both exported; Run appears twice → dedup to one entry.
  const runCount = out.symbols.filter((s) => s === 'Run').length;
  assert.equal(runCount, 1, `expected exactly 1 Run, got ${runCount}; symbols=${JSON.stringify(out.symbols)}`);
});

// --- 11. parse-error tolerance --------------------------------------------

test('GO: malformed source returns a node + warning, no crash', () => {
  // Missing closing brace — tree-sitter inserts MISSING / ERROR nodes.
  const src = `package main

func Foo() {
`;
  const out = extractFromTree(parse(src), 'bad.go');
  assert.notEqual(out.node, null);
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.ok(out.errors.length > 0);
  assert.match(out.errors[0], /parse tree had error/);
});

// --- 12. combined --------------------------------------------------------

test('GO: smoke-test mix of imports + exports + unexported', () => {
  const src = `package main

import (
  "fmt"
  "errors"
)

const MaxRetries = 3
const minTimeout = 5

type Config struct {
  Port int
}

type internal struct{}

func Run() error {
  fmt.Println("hi")
  return errors.New("x")
}

func helper() string {
  return ""
}
`;
  const out = extractFromTree(parse(src), 'main.go');
  // Symbols: MaxRetries (const), Config (type), Run (func). NOT minTimeout,
  // internal, helper.
  assert.deepEqual(out.symbols, ['MaxRetries', 'Config', 'Run']);

  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 2);
  const importTos = imports.map((e) => e[EDGE.TO]).sort();
  assert.deepEqual(importTos, ['unresolved:errors', 'unresolved:fmt']);

  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 3);
});

// --- 13. async front door --------------------------------------------------

test('extractGo() async API: parses + extracts a typical file', async () => {
  const out = await extractGo({
    relPath: 'demo.go',
    source: 'package main\n\nimport "fmt"\n\nfunc Alpha() { fmt.Println("hi") }\n',
  });
  assert.notEqual(out.node, null);
  assert.deepEqual(out.symbols, ['Alpha']);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(imports.length, 1);
  assert.equal(decs.length, 1);
});

test('extractGo() with empty source returns a valid empty file node', async () => {
  const out = await extractGo({ relPath: 'empty.go', source: '' });
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  // Empty input is not legal Go, so we expect a parse-error warning, but the
  // node is non-null and the edges/symbols are empty.
  assert.deepEqual(out.edges, []);
});

// --- 14. performance smoke -------------------------------------------------

test('GO: ~200-line synthetic file extracts in < 200 ms', () => {
  const lines = ['package main', ''];
  // 50 imports (grouped).
  lines.push('import (');
  for (let i = 0; i < 50; i++) lines.push(`  "mod${i}"`);
  lines.push(')');
  lines.push('');
  // 50 exported funcs.
  for (let i = 0; i < 50; i++) {
    lines.push(`func Fn${i}() int { return ${i} }`);
  }
  // 100 filler comment lines.
  for (let i = 0; i < 100; i++) lines.push(`// filler line ${i}`);
  const src = lines.join('\n');

  const t0 = process.hrtime.bigint();
  const tree = parse(src);
  const out = extractFromTree(tree, 'big.go');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  process.stdout.write(`# GO extractor 200-line perf: ${ms.toFixed(2)} ms (target < 50 ms)\n`);
  assert.ok(ms < 200, `extraction took ${ms.toFixed(2)} ms (> 200 ms hard ceiling)`);
  assert.equal(out.symbols.length, 50);
  assert.equal(out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS).length, 50);
});
