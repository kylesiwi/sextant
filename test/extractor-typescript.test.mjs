// Tests for lib/graph/extractors/typescript.mjs — per-file TS extractor.
//
// Strategy:
//   - Use loadTypescriptParser() once at module scope (top-level await) so we
//     pay the WASM cost a single time across all tests in this file.
//   - Most cases call extractFromTree() with a pre-parsed tree (sync, fast).
//   - A couple call extractTypescript() to exercise the async front door.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTypescript,
  extractFromTree,
} from '../lib/graph/extractors/typescript.mjs';
import {
  loadTypescriptParser,
  parseTypescript,
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

// One shared parser across all tests in this file. Tree-sitter Parser instances
// are reusable per the upstream contract; we exercise that contract here.
// We reset the cache first so a previous test file's state doesn't leak in.
__resetCacheForTests();
const PARSER = await loadTypescriptParser();
assert.ok(PARSER, 'failed to load TS parser at module top — abort');

function parse(src) {
  return parseTypescript(PARSER, src);
}

// --- 1. empty source -------------------------------------------------------

test('empty source: returns a node with empty symbols and no edges', () => {
  const out = extractFromTree(parse(''), 'empty.ts');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.equal(out.node[NODE.ID], fileNodeId('empty.ts'));
  assert.equal(out.node[NODE.LABEL], 'empty.ts');
  assert.equal(out.node[NODE.PATH], 'empty.ts');
  assert.deepEqual(out.node[NODE.SYMBOLS], []);
  assert.equal(out.node[NODE.COMMUNITY], null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.errors, []);
});

// --- 2. single export const ------------------------------------------------

test('single export const: symbols includes FOO and one declares edge emitted', () => {
  const out = extractFromTree(parse('export const FOO = 1;'), 'foo.ts');
  assert.deepEqual(out.symbols, ['FOO']);
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('foo.ts'));
  assert.equal(e[EDGE.TO], symbolNodeId('foo.ts', 'FOO'));
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.DECLARES);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

// --- 3. multiple export kinds, source order --------------------------------

test('multiple exports: function/class/interface/type/const all captured in source order', () => {
  const src = `
export function a() {}
export class B {}
export interface C {}
export type D = number;
export const E = 1;
`;
  const out = extractFromTree(parse(src), 'multi.ts');
  assert.deepEqual(out.symbols, ['a', 'B', 'C', 'D', 'E']);
  const declares = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(declares.length, 5);
  // All declares edges originate at the file node.
  for (const e of declares) {
    assert.equal(e[EDGE.FROM], fileNodeId('multi.ts'));
    assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
  }
});

// --- 4. non-exported declarations are ignored ------------------------------

test('non-exported declarations: only exported symbols make it into symbols[]', () => {
  const src = `
function hidden() {}
class NotExported {}
export function shown() {}
`;
  const out = extractFromTree(parse(src), 'hidden.ts');
  assert.deepEqual(out.symbols, ['shown']);
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TYPE], EDGE_TYPES.DECLARES);
});

// --- 5. relative import → intra-file-only edge ----------------------------

test('relative import: imports edge with to=fileNodeId(spec), confidence=intra-file-only', () => {
  const out = extractFromTree(parse('import { x } from "./foo";'), 'a.ts');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.ts'));
  assert.equal(e[EDGE.TO], fileNodeId('./foo'));
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

// --- 6. package import → unresolved placeholder ----------------------------

test('package import: imports edge with to=unresolved:<spec>, confidence=unverified', () => {
  const out = extractFromTree(parse('import _ from "lodash";'), 'a.ts');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], 'unresolved:lodash');
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

// --- 7. mix of imports + exports → correct edge counts --------------------

test('mix of 3 imports + 5 exports: emits 8 edges (3 imports, 5 declares)', () => {
  const src = `
import a from "./aaa";
import b from "../bbb";
import c from "ccc";
export function f1() {}
export class C1 {}
export interface I1 {}
export type T1 = number;
export const K1 = 1;
`;
  const out = extractFromTree(parse(src), 'mix.ts');
  assert.equal(out.edges.length, 8);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const declares = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(imports.length, 3);
  assert.equal(declares.length, 5);
  assert.deepEqual(out.symbols, ['f1', 'C1', 'I1', 'T1', 'K1']);
});

// --- 8. default export with a name ----------------------------------------

test('export default function foo(): symbols includes "foo"', () => {
  const out = extractFromTree(parse('export default function foo() {}'), 'd.ts');
  assert.deepEqual(out.symbols, ['foo']);
  const e = out.edges.find((x) => x[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.ok(e, 'expected a declares edge for the default-with-name');
  assert.equal(e[EDGE.TO], symbolNodeId('d.ts', 'foo'));
});

test('export default function() {} (anonymous): symbols stays empty', () => {
  // No name means nothing to emit. We don't synthesize "default" — the design
  // says to emit "the literal name when present"; absent name = absent symbol.
  const out = extractFromTree(parse('export default function() {}'), 'd.ts');
  assert.deepEqual(out.symbols, []);
});

// --- 9. re-export: both an import AND an export symbol --------------------

test('re-export `export { x } from "./bar"`: emits import edge + declares for x', () => {
  const out = extractFromTree(parse('export { x } from "./bar";'), 're.ts');
  // expect: 1 imports edge to ./bar + 1 declares edge for x
  assert.equal(out.edges.length, 2);
  const imp = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const dec = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.ok(imp, 'expected an imports edge');
  assert.equal(imp[EDGE.TO], fileNodeId('./bar'));
  assert.equal(imp[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
  assert.ok(dec, 'expected a declares edge');
  assert.equal(dec[EDGE.TO], symbolNodeId('re.ts', 'x'));
  assert.deepEqual(out.symbols, ['x']);
});

test('re-export with alias `export { x as y } from "./bar"`: alias wins', () => {
  const out = extractFromTree(parse('export { x as y } from "./bar";'), 're.ts');
  assert.deepEqual(out.symbols, ['y']);
  const dec = out.edges.find((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(dec[EDGE.TO], symbolNodeId('re.ts', 'y'));
});

// --- 10. parse error tolerance --------------------------------------------

test('parse error tolerance: malformed input returns a non-null node + warning', () => {
  const out = extractFromTree(parse('const x = ;'), 'bad.ts');
  assert.notEqual(out.node, null, 'node should not be null');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.ok(out.errors.length > 0, 'expected at least one warning');
  assert.match(out.errors[0], /parse tree had error/);
});

// --- 11. dedup: a name declared twice surfaces once -----------------------

test('deduplication: same name in two export forms surfaces once in symbols[]', () => {
  // TS allows overloaded function declarations and namespace + interface
  // merging. We won't fabricate a contrived double-declaration that the parser
  // would actually accept here — instead, we exercise the dedup path by
  // re-exporting a symbol that's ALSO declared inline.
  //
  // Source:
  //   export function foo() {}      → symbols=['foo']
  //   export { foo };               → IGNORED by our query (no `from`), keeps symbols=['foo']
  // → the explicit dedup path is harder to hit through real TS. Use overloaded
  //   function declarations, which tree-sitter parses as two function_declaration
  //   nodes with the same name.
  const src = `
export function foo(): number;
export function foo(): string;
export function foo() { return 1; }
`;
  const out = extractFromTree(parse(src), 'dup.ts');
  assert.deepEqual(out.symbols, ['foo']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1, 'declares edge should be deduped to one');
});

// --- 12. performance smoke -------------------------------------------------

test('performance smoke: ~200-line synthetic file extracts in < 50 ms (soft)', () => {
  // Build a synthetic file with 200 lines. 50 exports + 50 imports + filler.
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`import m${i} from "./mod${i}";`);
  for (let i = 0; i < 50; i++) lines.push(`export function fn${i}() { return ${i}; }`);
  for (let i = 0; i < 100; i++) lines.push(`// filler line ${i}`);
  const src = lines.join('\n');

  // We measure tree-sitter parse + extract together since the spec said "200-line synthetic"
  // and that's the realistic per-file budget.
  const t0 = process.hrtime.bigint();
  const tree = parse(src);
  const out = extractFromTree(tree, 'big.ts');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  // Soft assertion. Log the actual time; assert generously to avoid CI flake.
  // The spec said "< 50 ms (a soft assertion; log the actual time)".
  // Use 200ms as the hard ceiling — we'd want to know if it ever regresses 4×.
  process.stdout.write(`# extractor 200-line perf: ${ms.toFixed(2)} ms (target < 50 ms)\n`);
  assert.ok(ms < 200, `extraction took ${ms.toFixed(2)} ms (> 200 ms hard ceiling)`);
  assert.equal(out.symbols.length, 50);
  assert.equal(out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS).length, 50);
});

// --- bonus: extractTypescript() async front door works end-to-end ----------

test('extractTypescript() async API: parses + extracts a typical file', async () => {
  const out = await extractTypescript({
    relPath: 'demo.ts',
    source: 'import { foo } from "./bar";\nexport function baz() {}\nexport class Qux {}\n',
  });
  assert.notEqual(out.node, null);
  assert.deepEqual(out.symbols, ['baz', 'Qux']);
  assert.equal(out.edges.length, 3);
  assert.equal(out.errors.length, 0);
});

// --- bonus: empty input via extractTypescript() ----------------------------

test('extractTypescript() with empty source: returns valid empty file node', async () => {
  const out = await extractTypescript({ relPath: 'empty.ts', source: '' });
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.deepEqual(out.edges, []);
});
