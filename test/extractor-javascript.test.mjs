// Tests for lib/graph/extractors/javascript.mjs — per-file JS extractor.
//
// Strategy: same as the TS extractor test.
//   - Use loadJavascriptParser() once at module scope so we pay the WASM cost
//     a single time across all tests in this file.
//   - Most cases call extractFromTree() with a pre-parsed tree (sync, fast).
//   - A couple call extractJavascript() to exercise the async front door.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJavascript,
  extractFromTree,
} from '../lib/graph/extractors/javascript.mjs';
import {
  loadJavascriptParser,
  parseJavascript,
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
const PARSER = await loadJavascriptParser();
assert.ok(PARSER, 'failed to load JS parser at module top — abort');

function parse(src) {
  return parseJavascript(PARSER, src);
}

// --- 1. empty source -------------------------------------------------------

test('JS: empty source yields a node with no symbols and no edges', () => {
  const out = extractFromTree(parse(''), 'empty.js');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.equal(out.node[NODE.ID], fileNodeId('empty.js'));
  assert.equal(out.node[NODE.LABEL], 'empty.js');
  assert.equal(out.node[NODE.PATH], 'empty.js');
  assert.deepEqual(out.node[NODE.SYMBOLS], []);
  assert.equal(out.node[NODE.COMMUNITY], null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.errors, []);
});

// --- 2. ESM import → imports edge -----------------------------------------

test('JS: ESM `import { x } from "./foo"` emits an imports edge', () => {
  const out = extractFromTree(parse('import { x } from "./foo";'), 'a.js');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.js'));
  assert.equal(e[EDGE.TO], fileNodeId('./foo'));
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('JS: ESM package import → unresolved placeholder', () => {
  const out = extractFromTree(parse('import _ from "lodash";'), 'a.js');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], 'unresolved:lodash');
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

// --- 3. CommonJS require → imports edge (same shape as ESM import) --------

test('JS: `const x = require("./foo")` emits an imports edge to ./foo', () => {
  const out = extractFromTree(parse('const x = require("./foo");'), 'a.js');
  assert.equal(out.edges.length, 1, `expected 1 edge, got: ${JSON.stringify(out.edges)}`);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.js'));
  assert.equal(e[EDGE.TO], fileNodeId('./foo'));
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('JS: `const { x } = require("./foo")` (destructure) still emits the imports edge', () => {
  const out = extractFromTree(parse('const { x } = require("./foo");'), 'a.js');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.TO], fileNodeId('./foo'));
});

test('JS: require() of a package name → unresolved placeholder', () => {
  const out = extractFromTree(parse('const fs = require("fs");'), 'a.js');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.TO], 'unresolved:fs');
  assert.equal(imports[0][EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

// --- 4. CommonJS module.exports = foo → symbol -----------------------------

test('JS: `module.exports = foo` → foo becomes an exported symbol', () => {
  const out = extractFromTree(parse('function foo() {}\nmodule.exports = foo;'), 'm.js');
  assert.ok(out.symbols.includes('foo'),
    `expected foo in symbols, got: ${JSON.stringify(out.symbols)}`);
  const dec = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.ok(dec);
  assert.equal(dec[EDGE.TO], symbolNodeId('m.js', 'foo'));
});

test('JS: `module.exports = function() {}` (anonymous) emits no symbol', () => {
  // We don't fabricate a "default" name; mirror TS behaviour where
  // anonymous default exports produce no symbol entry.
  const out = extractFromTree(parse('module.exports = function() {};'), 'm.js');
  assert.deepEqual(out.symbols, [], 'expected no symbols for anonymous module.exports');
});

// --- 5. CommonJS module.exports = { a, b } → 2 symbols --------------------

test('JS: `module.exports = { a, b }` produces 2 symbols', () => {
  const out = extractFromTree(parse('const a = 1, b = 2;\nmodule.exports = { a, b };'), 'm.js');
  assert.ok(out.symbols.includes('a'), `expected 'a' in symbols, got: ${JSON.stringify(out.symbols)}`);
  assert.ok(out.symbols.includes('b'), `expected 'b' in symbols, got: ${JSON.stringify(out.symbols)}`);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 2, `expected 2 declares edges, got ${decs.length}`);
});

// --- 6. CommonJS exports.x = ... → 1 symbol --------------------------------

test('JS: `exports.x = ...` → 1 symbol named x', () => {
  const out = extractFromTree(parse('exports.x = 1;'), 'm.js');
  assert.deepEqual(out.symbols, ['x']);
  const dec = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(dec[EDGE.TO], symbolNodeId('m.js', 'x'));
});

test('JS: `module.exports.x = ...` → 1 symbol named x', () => {
  const out = extractFromTree(parse('module.exports.x = 1;'), 'm.js');
  assert.deepEqual(out.symbols, ['x']);
});

// --- 7. ESM exports --------------------------------------------------------

test('JS: `export function foo() {}` → symbol "foo" + declares edge', () => {
  const out = extractFromTree(parse('export function foo() {}'), 'f.js');
  assert.deepEqual(out.symbols, ['foo']);
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.DECLARES);
  assert.equal(e[EDGE.TO], symbolNodeId('f.js', 'foo'));
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('JS: multiple ESM exports captured in source order', () => {
  const src = `
export function a() {}
export class B {}
export const C = 1;
`;
  const out = extractFromTree(parse(src), 'multi.js');
  assert.deepEqual(out.symbols, ['a', 'B', 'C']);
});

test('JS: `export default function foo() {}` → symbol "foo"', () => {
  const out = extractFromTree(parse('export default function foo() {}'), 'd.js');
  assert.deepEqual(out.symbols, ['foo']);
});

test('JS: `export default function() {}` (anonymous) → no symbol', () => {
  const out = extractFromTree(parse('export default function() {}'), 'd.js');
  assert.deepEqual(out.symbols, []);
});

test('JS: re-export `export { x } from "./bar"` emits import + declares', () => {
  const out = extractFromTree(parse('export { x } from "./bar";'), 're.js');
  assert.equal(out.edges.length, 2);
  const imp = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const dec = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.ok(imp);
  assert.equal(imp[EDGE.TO], fileNodeId('./bar'));
  assert.ok(dec);
  assert.equal(dec[EDGE.TO], symbolNodeId('re.js', 'x'));
  assert.deepEqual(out.symbols, ['x']);
});

test('JS: re-export with alias `export { x as y } from "./bar"`: alias wins', () => {
  const out = extractFromTree(parse('export { x as y } from "./bar";'), 're.js');
  assert.deepEqual(out.symbols, ['y']);
});

// --- 8. mixed CJS + ESM in one file ----------------------------------------

test('JS: mixed CJS + ESM in one file → all import edges + symbols captured', () => {
  const src = `
import { esm } from "./esm-dep";
const cjs = require("./cjs-dep");
export function esmFn() {}
exports.cjsName = 1;
module.exports.another = 2;
`;
  const out = extractFromTree(parse(src), 'mixed.js');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const declares = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);

  // Two imports: ESM + CJS
  assert.equal(imports.length, 2, `expected 2 imports, got ${imports.length}: ${JSON.stringify(imports)}`);
  const importTos = imports.map((e) => e[EDGE.TO]).sort();
  assert.deepEqual(importTos, [fileNodeId('./cjs-dep'), fileNodeId('./esm-dep')]);

  // Three declares: esmFn, cjsName, another
  assert.equal(declares.length, 3);
  assert.ok(out.symbols.includes('esmFn'));
  assert.ok(out.symbols.includes('cjsName'));
  assert.ok(out.symbols.includes('another'));
});

// --- 9. JSX behaviour ------------------------------------------------------
//
// tree-sitter-javascript handles JSX natively in modern versions, so we
// don't expect ERROR nodes for `<div />` etc. The test asserts the symbol
// is still recovered.

test('JS: `function Comp() { return <div />; }` extracts symbols cleanly (no JSX errors expected)', () => {
  // Sextant convention: top-level functions NOT inside an export aren't
  // recorded as symbols. So we wrap in `export` to assert symbol presence.
  const src = `export function Comp() { return <div />; }`;
  const out = extractFromTree(parse(src), 'comp.jsx');
  assert.deepEqual(out.symbols, ['Comp']);
});

test('JS: complex JSX inside an export does not produce a parse-error warning', () => {
  const src = `
import React from 'react';
export function App() {
  return <div className="x">{count}<span>nested</span></div>;
}
export const VERSION = "1.0";
`;
  const out = extractFromTree(parse(src), 'app.jsx');
  // No parse-error noise — this is the happy path.
  assert.deepEqual(out.errors, [],
    `unexpected parse errors on JSX: ${JSON.stringify(out.errors)}`);
  assert.ok(out.symbols.includes('App'));
  assert.ok(out.symbols.includes('VERSION'));
});

// --- 10. dedup -------------------------------------------------------------

test('JS: same name from two CJS export forms surfaces once in symbols[]', () => {
  // Defensive — `module.exports.foo = 1; exports.foo = 2` is unusual but
  // legal; both write to the same exported property. Our dedup should
  // collapse them to a single symbol entry.
  const src = `
module.exports.foo = 1;
exports.foo = 2;
`;
  const out = extractFromTree(parse(src), 'dup.js');
  assert.deepEqual(out.symbols, ['foo']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
});

// --- 11. parse error tolerance --------------------------------------------

test('JS: malformed input returns a node + warning', () => {
  // JS-specific syntactic garbage — `const x = ;` is not valid.
  const out = extractFromTree(parse('const x = ;'), 'bad.js');
  assert.notEqual(out.node, null, 'node should not be null');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.ok(out.errors.length > 0);
  assert.match(out.errors[0], /parse tree had error/);
});

// --- 12. async front door --------------------------------------------------

test('extractJavascript() async API: parses + extracts a typical CJS file', async () => {
  const out = await extractJavascript({
    relPath: 'demo.js',
    source: 'const b = require("./b");\nfunction alpha() {}\nmodule.exports = { alpha };\n',
  });
  assert.notEqual(out.node, null);
  assert.deepEqual(out.symbols, ['alpha']);
  // Edges: 1 imports + 1 declares
  assert.equal(out.edges.length, 2);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(imports.length, 1);
  assert.equal(decs.length, 1);
});

test('extractJavascript() with empty source returns a valid empty file node', async () => {
  const out = await extractJavascript({ relPath: 'empty.js', source: '' });
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.deepEqual(out.edges, []);
});

// --- 13. performance smoke -------------------------------------------------

test('JS: ~200-line synthetic file extracts in < 200 ms', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`const m${i} = require("./mod${i}");`);
  for (let i = 0; i < 50; i++) lines.push(`exports.fn${i} = function() { return ${i}; };`);
  for (let i = 0; i < 100; i++) lines.push(`// filler line ${i}`);
  const src = lines.join('\n');

  const t0 = process.hrtime.bigint();
  const tree = parse(src);
  const out = extractFromTree(tree, 'big.js');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  process.stdout.write(`# JS extractor 200-line perf: ${ms.toFixed(2)} ms (target < 50 ms)\n`);
  assert.ok(ms < 200, `extraction took ${ms.toFixed(2)} ms (> 200 ms hard ceiling)`);
  assert.equal(out.symbols.length, 50);
  assert.equal(out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS).length, 50);
});
