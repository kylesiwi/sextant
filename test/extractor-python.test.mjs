// Tests for lib/graph/extractors/python.mjs — per-file Python extractor.
//
// Strategy: same as the TS/JS extractor tests.
//   - Use loadPythonParser() once at module scope so we pay the WASM cost
//     a single time across all tests in this file.
//   - Most cases call extractFromTree() with a pre-parsed tree (sync, fast).
//   - A couple call extractPython() to exercise the async front door.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPython,
  extractFromTree,
} from '../lib/graph/extractors/python.mjs';
import {
  loadPythonParser,
  parsePython,
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
const PARSER = await loadPythonParser();
assert.ok(PARSER, 'failed to load Python parser at module top — abort');

function parse(src) {
  return parsePython(PARSER, src);
}

// --- 1. empty source -------------------------------------------------------

test('PY: empty source yields a node with no symbols and no edges', () => {
  const out = extractFromTree(parse(''), 'empty.py');
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.equal(out.node[NODE.ID], fileNodeId('empty.py'));
  assert.equal(out.node[NODE.LABEL], 'empty.py');
  assert.equal(out.node[NODE.PATH], 'empty.py');
  assert.deepEqual(out.node[NODE.SYMBOLS], []);
  assert.equal(out.node[NODE.COMMUNITY], null);
  assert.deepEqual(out.edges, []);
  assert.deepEqual(out.symbols, []);
  assert.deepEqual(out.errors, []);
});

// --- 2. plain imports ------------------------------------------------------

test('PY: `import foo` → unresolved package edge', () => {
  const out = extractFromTree(parse('import foo'), 'a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('a.py'));
  assert.equal(e[EDGE.TO], 'unresolved:foo');
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('PY: `import os.path` → unresolved dotted edge', () => {
  const out = extractFromTree(parse('import os.path'), 'a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], 'unresolved:os.path');
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('PY: `import foo as bar` → edge targets underlying module name', () => {
  // Aliased imports still emit a single edge to the actual module ("foo"),
  // not to the local alias.
  const out = extractFromTree(parse('import foo as bar'), 'a.py');
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0][EDGE.TO], 'unresolved:foo');
});

test('PY: `import a, b` → two import edges, one per name', () => {
  const out = extractFromTree(parse('import a, b'), 'a.py');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 2);
  const tos = imports.map((e) => e[EDGE.TO]).sort();
  assert.deepEqual(tos, ['unresolved:a', 'unresolved:b']);
});

// --- 3. from-imports -------------------------------------------------------

test('PY: `from foo.bar import baz` → one import edge to unresolved:foo.bar', () => {
  const out = extractFromTree(parse('from foo.bar import baz'), 'a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], 'unresolved:foo.bar');
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.UNVERIFIED);
});

test('PY: `from .foo import x` → relative edge to ./foo, intra-file-only', () => {
  const out = extractFromTree(parse('from .foo import x'), 'pkg/a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.FROM], fileNodeId('pkg/a.py'));
  assert.equal(e[EDGE.TO], fileNodeId('./foo'));
  assert.equal(e[EDGE.TYPE], EDGE_TYPES.IMPORTS);
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('PY: `from ..foo import x` → relative edge to ../foo', () => {
  const out = extractFromTree(parse('from ..foo import x'), 'pkg/sub/a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  assert.equal(e[EDGE.TO], fileNodeId('../foo'));
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('PY: `from . import x` (bare dot) → relative edge', () => {
  const out = extractFromTree(parse('from . import x'), 'pkg/a.py');
  assert.equal(out.edges.length, 1);
  const e = out.edges[0];
  // Bare current-package — we translate to "." (no name suffix).
  assert.equal(e[EDGE.TO], fileNodeId('.'));
  assert.equal(e[EDGE.CONFIDENCE], CONFIDENCE.INTRA_FILE_ONLY);
});

test('PY: wildcard `from foo import *` → one import edge, no symbols extracted', () => {
  const out = extractFromTree(parse('from foo import *'), 'a.py');
  assert.equal(out.edges.length, 1);
  assert.deepEqual(out.symbols, []);
});

// --- 4. top-level definitions -> symbols ----------------------------------

test('PY: top-level `def foo(): pass` → symbol foo + declares edge', () => {
  const out = extractFromTree(parse('def foo(): pass'), 'f.py');
  assert.deepEqual(out.symbols, ['foo']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
  assert.equal(decs[0][EDGE.TO], symbolNodeId('f.py', 'foo'));
  assert.equal(decs[0][EDGE.CONFIDENCE], CONFIDENCE.VERIFIED);
});

test('PY: top-level `class Bar: pass` → symbol Bar + declares edge', () => {
  const out = extractFromTree(parse('class Bar: pass'), 'b.py');
  assert.deepEqual(out.symbols, ['Bar']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
  assert.equal(decs[0][EDGE.TO], symbolNodeId('b.py', 'Bar'));
});

test('PY: top-level uppercase `MAX = 1` → symbol MAX', () => {
  const out = extractFromTree(parse('MAX = 1'), 'c.py');
  assert.deepEqual(out.symbols, ['MAX']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 1);
});

test('PY: top-level uppercase `MAX_RETRIES = 3` → symbol MAX_RETRIES', () => {
  const out = extractFromTree(parse('MAX_RETRIES = 3'), 'c.py');
  assert.deepEqual(out.symbols, ['MAX_RETRIES']);
});

test('PY: top-level lowercase `x = 1` is NOT a symbol', () => {
  const out = extractFromTree(parse('x = 1'), 'c.py');
  assert.deepEqual(out.symbols, []);
});

test('PY: top-level mixed-case `Foo = 1` is NOT a symbol (must be ALL CAPS)', () => {
  // Only the UPPERCASE_CONST regex matches — `Foo` doesn't qualify.
  const out = extractFromTree(parse('Foo = 1'), 'c.py');
  assert.deepEqual(out.symbols, []);
});

// --- 5. private convention -------------------------------------------------

test('PY: `_private = 1` (top-level) → NOT in symbols', () => {
  const out = extractFromTree(parse('_PRIVATE_CONST = 1\n_private = 2'), 'p.py');
  assert.deepEqual(out.symbols, []);
});

test('PY: `def _hidden(): pass` → NOT in symbols', () => {
  const out = extractFromTree(parse('def _hidden(): pass'), 'p.py');
  assert.deepEqual(out.symbols, []);
});

test('PY: `class _PrivateClass: pass` → NOT in symbols', () => {
  const out = extractFromTree(parse('class _PrivateClass: pass'), 'p.py');
  assert.deepEqual(out.symbols, []);
});

test('PY: dunder names `__init__`, `__all__` are skipped (leading underscore rule)', () => {
  const src = `
def __init__(): pass
__all__ = ['foo']
`;
  const out = extractFromTree(parse(src), 'm.py');
  assert.deepEqual(out.symbols, []);
});

// --- 6. nested defs / class methods NOT counted ----------------------------

test('PY: methods inside a class are NOT top-level symbols', () => {
  const src = `
class Bar:
    def method(self): pass
    def other(self): pass
`;
  const out = extractFromTree(parse(src), 'b.py');
  assert.deepEqual(out.symbols, ['Bar']);
});

test('PY: nested defs inside conditionals are NOT top-level symbols', () => {
  const src = `
if True:
    def nested(): pass
    class Nested: pass

try:
    def in_try(): pass
except:
    pass
`;
  const out = extractFromTree(parse(src), 'n.py');
  // Nothing at the module level => no symbols.
  assert.deepEqual(out.symbols, []);
});

test('PY: nested defs inside another def are NOT top-level symbols', () => {
  const src = `
def outer():
    def inner(): pass
    class InnerClass: pass
    return inner
`;
  const out = extractFromTree(parse(src), 'o.py');
  assert.deepEqual(out.symbols, ['outer']);
});

// --- 7. decorated definitions ---------------------------------------------

test('PY: decorated top-level def → still a symbol', () => {
  const src = `
@decorator
def alpha(): pass
`;
  const out = extractFromTree(parse(src), 'd.py');
  assert.deepEqual(out.symbols, ['alpha']);
});

test('PY: decorated top-level class → still a symbol', () => {
  const src = `
@register
class Beta:
    pass
`;
  const out = extractFromTree(parse(src), 'd.py');
  assert.deepEqual(out.symbols, ['Beta']);
});

test('PY: decorated private def → NOT a symbol', () => {
  const out = extractFromTree(parse('@dec\ndef _hidden(): pass'), 'd.py');
  assert.deepEqual(out.symbols, []);
});

// --- 8. combined --------------------------------------------------------

test('PY: smoke-test mix of imports + exports + private', () => {
  const src = `
from .bar import helper
import os
import requests

MAX_RETRIES = 3

def alpha():
    return helper()

class Foo:
    def method(self): pass

_private_var = 0
`;
  const out = extractFromTree(parse(src), 'm.py');
  assert.deepEqual(out.symbols, ['MAX_RETRIES', 'alpha', 'Foo']);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 3, `expected 3 imports, got ${JSON.stringify(imports)}`);
  const importTos = imports.map((e) => e[EDGE.TO]).sort();
  assert.deepEqual(importTos, [fileNodeId('./bar'), 'unresolved:os', 'unresolved:requests']);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(decs.length, 3);
});

// --- 9. source-order preservation ------------------------------------------

test('PY: multiple top-level names are emitted in source order', () => {
  const src = `
def a(): pass
class B: pass
C = 1
def d(): pass
class E: pass
`;
  const out = extractFromTree(parse(src), 'o.py');
  assert.deepEqual(out.symbols, ['a', 'B', 'C', 'd', 'E']);
});

// --- 10. dedup -------------------------------------------------------------

test('PY: same import declared twice surfaces once as an edge', () => {
  // "import os" + "from os import path" both reference the os package; we
  // dedupe by the resolved target.
  const out = extractFromTree(parse('import os\nfrom os import path'), 'd.py');
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  // Both forms map to `unresolved:os` — they should dedupe to one edge.
  assert.equal(imports.length, 1, `expected 1 deduped edge, got ${JSON.stringify(imports)}`);
});

test('PY: same name declared twice (def + reassignment) → 1 symbol', () => {
  // Strictly speaking the second `def foo` redefines the first, but Python
  // tooling typically treats them as the same name. Our dedup handles this.
  const src = `
def foo(): pass
def foo(): pass
`;
  const out = extractFromTree(parse(src), 'd.py');
  assert.deepEqual(out.symbols, ['foo']);
});

// --- 11. parse-error tolerance --------------------------------------------

test('PY: malformed source returns a node + warning, no crash', () => {
  // Unterminated string is the classic "ERROR node ahead" trigger.
  const out = extractFromTree(parse('def foo(:\n  pass'), 'bad.py');
  assert.notEqual(out.node, null);
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.ok(out.errors.length > 0);
  assert.match(out.errors[0], /parse tree had error/);
});

// --- 12. async front door --------------------------------------------------

test('extractPython() async API: parses + extracts a typical file', async () => {
  const out = await extractPython({
    relPath: 'demo.py',
    source: 'import os\n\ndef alpha():\n    return 1\n',
  });
  assert.notEqual(out.node, null);
  assert.deepEqual(out.symbols, ['alpha']);
  const imports = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  const decs = out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(imports.length, 1);
  assert.equal(decs.length, 1);
});

test('extractPython() with empty source returns a valid empty file node', async () => {
  const out = await extractPython({ relPath: 'empty.py', source: '' });
  assert.equal(out.node[NODE.TYPE], NODE_TYPES.FILE);
  assert.deepEqual(out.edges, []);
});

// --- 13. performance smoke -------------------------------------------------

test('PY: ~200-line synthetic file extracts in < 200 ms', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`from .mod${i} import thing${i}`);
  for (let i = 0; i < 50; i++) lines.push(`def fn${i}():\n    return ${i}`);
  for (let i = 0; i < 100; i++) lines.push(`# filler line ${i}`);
  const src = lines.join('\n');

  const t0 = process.hrtime.bigint();
  const tree = parse(src);
  const out = extractFromTree(tree, 'big.py');
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  process.stdout.write(`# PY extractor 200-line perf: ${ms.toFixed(2)} ms (target < 50 ms)\n`);
  assert.ok(ms < 200, `extraction took ${ms.toFixed(2)} ms (> 200 ms hard ceiling)`);
  assert.equal(out.symbols.length, 50);
  assert.equal(out.edges.filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS).length, 50);
});
