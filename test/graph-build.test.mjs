// Tests for lib/graph/build.mjs — the Phase 1a graph builder.
//
// Tests use temp directories created per-test and torn down via t.after().
// We pay one parser-load cost at module top (top-level await), which the
// builder itself uses through loadTypescriptParser() — that call is cached,
// so subsequent buildGraph() invocations don't re-pay it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  buildGraph,
  listSourceFiles,
  readSourceFiles,
} from '../lib/graph/build.mjs';
import {
  loadTypescriptParser,
  __resetCacheForTests as resetParserCache,
} from '../lib/graph/parser.mjs';
import {
  SCHEMA_VERSION,
  EDGE,
  EDGE_TYPES,
  NODE,
  GRAPH,
  validateGraph,
  fileNodeId,
} from '../lib/graph/schema.mjs';

resetParserCache();
const PARSER = await loadTypescriptParser();
assert.ok(PARSER, 'parser load must succeed for graph-build tests');

function freshTempDir(prefix = 'sextant-build-') {
  const p = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tempProject(t, prefix = 'sextant-build-') {
  const dir = freshTempDir(prefix);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// --- 1. empty project ------------------------------------------------------

test('buildGraph: empty project yields 0 files / 0 edges and a valid graph', async (t) => {
  const root = tempProject(t);
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 0);
  assert.equal(r.edges, 0);
  const raw = await fs.readFile(r.graphPath, 'utf8');
  const g = JSON.parse(raw);
  assert.equal(g[GRAPH.SCHEMA_VERSION], SCHEMA_VERSION);
  assert.deepEqual(g[GRAPH.NODES], []);
  assert.deepEqual(g[GRAPH.EDGES], []);
  assert.equal(validateGraph(g).ok, true);
});

// --- 2. single file --------------------------------------------------------

test('buildGraph: single-file project yields 1 node + 1 declares edge', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'foo.ts'), 'export const X = 1;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1);
  assert.equal(r.edges, 1);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  assert.equal(g[GRAPH.NODES][0][NODE.ID], fileNodeId('foo.ts'));
  assert.deepEqual(g[GRAPH.NODES][0][NODE.SYMBOLS], ['X']);
  assert.equal(g[GRAPH.EDGES][0][EDGE.TYPE], EDGE_TYPES.DECLARES);
});

// --- 3. multi-file project with imports ------------------------------------

test('buildGraph: 3 files with imports yields correct file nodes + import edges', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'import { b } from "./b";\nexport const A = 1;\n');
  await write(path.join(root, 'b.ts'), 'import { c } from "./c";\nexport const B = 2;\n');
  await write(path.join(root, 'c.ts'), 'export const C = 3;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 3);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 2);
  const declares = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.DECLARES);
  assert.equal(declares.length, 3);
});

// --- 3b. Phase 1c: cross-file imports resolve to verified -----------------

test('buildGraph: Phase 1c resolves cross-file imports to verified', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'import { b } from "./b";\nexport const A = 1;\n');
  await write(path.join(root, 'b.ts'), 'export const B = 2;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 2);
  // Resolution counters present and reflect the one cross-file import.
  assert.equal(r.resolved_count, 1, 'a.ts → b.ts should resolve');
  assert.equal(r.unresolved_count, 0);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  const imp = imports[0];
  // The resolved target must be the canonical file-node id, not a node:./b placeholder.
  assert.equal(imp[EDGE.TO], fileNodeId('b.ts'),
    `expected to=node:b.ts, got ${imp[EDGE.TO]}`);
  // And the confidence must be verified.
  assert.equal(imp[EDGE.CONFIDENCE], 'verified',
    `expected verified confidence, got ${imp[EDGE.CONFIDENCE]}`);
});

test('buildGraph: skipResolve=true bypasses Phase 1c', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'import { b } from "./b";\nexport const A = 1;\n');
  await write(path.join(root, 'b.ts'), 'export const B = 2;\n');
  const r = await buildGraph({ root, quiet: true, skipResolve: true });
  // No resolution performed.
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 0);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  // Edge target stays in raw form.
  assert.equal(imports[0][EDGE.TO], 'node:./b');
  assert.equal(imports[0][EDGE.CONFIDENCE], 'intra-file-only');
});

test('buildGraph: Python cross-file relative imports resolve', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'pkg', '__init__.py'), 'from .foo import bar\n');
  await write(path.join(root, 'pkg', 'foo.py'), 'def bar():\n    return 1\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 2);
  assert.equal(r.resolved_count, 1, 'pkg/__init__.py → pkg/foo.py');
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.TO], fileNodeId('pkg/foo.py'));
  assert.equal(imports[0][EDGE.CONFIDENCE], 'verified');
});

test('buildGraph: TS imports of missing files stay unresolved', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'import { x } from "./missing";\nexport const A = 1;\n');
  const r = await buildGraph({ root, quiet: true });
  // ./missing has no file; one unresolved edge stays as intra-file-only.
  assert.equal(r.resolved_count, 0);
  assert.equal(r.unresolved_count, 1);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.equal(imports.length, 1);
  assert.equal(imports[0][EDGE.CONFIDENCE], 'intra-file-only');
});

// --- 4. excludes -----------------------------------------------------------

test('buildGraph: files under node_modules/ are skipped', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'keep.ts'), 'export const K = 1;\n');
  await write(path.join(root, 'node_modules', 'pkg', 'index.ts'), 'export const NM = 1;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1, 'only the root-level file should be processed');
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  assert.equal(g[GRAPH.NODES][0][NODE.PATH], 'keep.ts');
});

test('buildGraph: files under .git/ are skipped (dotfile rule)', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'keep.ts'), 'export const K = 1;\n');
  await write(path.join(root, '.git', 'hooks', 'pre-commit.ts'), 'export const G = 1;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1);
});

test('buildGraph: files under dist/ are skipped', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'src.ts'), 'export const K = 1;\n');
  await write(path.join(root, 'dist', 'out.ts'), 'export const D = 1;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1);
});

// --- 5. output validates ---------------------------------------------------

test('buildGraph: emitted graph.json passes validateGraph', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'export const A = 1;\n');
  await write(path.join(root, 'b.ts'), 'import { A } from "./a";\nexport class B {}\n');
  const r = await buildGraph({ root, quiet: true });
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  assert.deepEqual(validateGraph(g), { ok: true });
});

// --- 6. .sextant-version sidecar ------------------------------------------

test('buildGraph: writes .sextant-version if missing', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');
  await buildGraph({ root, quiet: true });
  const v = (await fs.readFile(path.join(root, '.sextant', '.sextant-version'), 'utf8')).trim();
  assert.equal(v, String(SCHEMA_VERSION));
});

test('buildGraph: preserves correct existing .sextant-version', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');
  await fs.mkdir(path.join(root, '.sextant'), { recursive: true });
  await fs.writeFile(path.join(root, '.sextant', '.sextant-version'), '1\n', 'utf8');
  const beforeStat = await fs.stat(path.join(root, '.sextant', '.sextant-version'));
  await buildGraph({ root, quiet: true });
  const afterStat = await fs.stat(path.join(root, '.sextant', '.sextant-version'));
  // mtime should match — we didn't rewrite the file.
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('buildGraph: overwrites wrong .sextant-version', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'x.ts'), 'export const X = 1;\n');
  await fs.mkdir(path.join(root, '.sextant'), { recursive: true });
  await fs.writeFile(path.join(root, '.sextant', '.sextant-version'), '999\n', 'utf8');
  await buildGraph({ root, quiet: true });
  const v = (await fs.readFile(path.join(root, '.sextant', '.sextant-version'), 'utf8')).trim();
  assert.equal(v, String(SCHEMA_VERSION));
});

// --- 7. atomic write -------------------------------------------------------

test('buildGraph: never leaves a corrupted graph.json on partial write', async (t) => {
  // We exercise the writeJsonAtomic guarantee indirectly: build a graph,
  // then build it again. The first build's file should never be partially
  // written. We also assert no leftover .tmp.* files in the graph dir.
  const root = tempProject(t);
  await write(path.join(root, 'a.ts'), 'export const A = 1;\n');
  await buildGraph({ root, quiet: true });
  await buildGraph({ root, quiet: true });
  const graphDir = path.join(root, '.sextant', 'graph');
  const entries = await fs.readdir(graphDir);
  const tmpLeftovers = entries.filter((n) => n.includes('.tmp.'));
  assert.deepEqual(tmpLeftovers, []);
  // graph.json is well-formed JSON
  const g = JSON.parse(await fs.readFile(path.join(graphDir, 'graph.json'), 'utf8'));
  assert.equal(validateGraph(g).ok, true);
});

// --- 8. parse errors are non-fatal ----------------------------------------

test('buildGraph: a syntactically-bad file produces warnings but does not fail build', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'good.ts'), 'export const G = 1;\n');
  await write(path.join(root, 'bad.ts'), 'const x = ;\n');
  const r = await buildGraph({ root, quiet: true });
  // Both files become nodes (the extractor returns a node even when parse
  // has errors). The bad file just contributes a warning.
  assert.equal(r.files, 2);
  assert.ok(r.warnings.some((w) => w.includes('bad.ts') && w.includes('parse')),
    `expected a 'bad.ts' parse warning, got: ${r.warnings.join(' | ')}`);
});

// --- 9. listSourceFiles helper --------------------------------------------

test('listSourceFiles: returns relative POSIX paths, sorted', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'src', 'a.ts'), 'x');
  await write(path.join(root, 'src', 'b.ts'), 'x');
  await write(path.join(root, 'top.ts'), 'x');
  const files = await listSourceFiles(root);
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'top.ts']);
});

test('listSourceFiles: does not follow symlinks', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'real.ts'), 'x');
  // Create a symlink to a directory containing another .ts file. If the
  // walker follows it we'd see both; we want only real.ts.
  const extDir = freshTempDir('sextant-build-ext-');
  t.after(() => fs.rm(extDir, { recursive: true, force: true }));
  await write(path.join(extDir, 'sneaky.ts'), 'x');
  try {
    await fs.symlink(extDir, path.join(root, 'linked'));
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('symlink creation not permitted on this platform');
      return;
    }
    throw err;
  }
  const files = await listSourceFiles(root);
  assert.deepEqual(files, ['real.ts']);
});

// --- 10. readSourceFiles helper -------------------------------------------

test('readSourceFiles: returns source strings in input order', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, '1.ts'), 'a');
  await write(path.join(root, '2.ts'), 'bb');
  await write(path.join(root, '3.ts'), 'ccc');
  const items = ['1.ts', '2.ts', '3.ts'].map((rel) => ({ rel, abs: path.join(root, rel) }));
  const res = await readSourceFiles(items);
  assert.deepEqual(res.map((r) => r.source), ['a', 'bb', 'ccc']);
});

test('readSourceFiles: missing file becomes an error entry, not a throw', async (t) => {
  const root = tempProject(t);
  const items = [{ rel: 'nope.ts', abs: path.join(root, 'nope.ts') }];
  const warnings = [];
  const res = await readSourceFiles(items, { warnings });
  assert.equal(res.length, 1);
  assert.ok(res[0].error, 'expected an error string on the result');
  assert.equal(res[0].source, '');
  assert.ok(warnings.some((w) => w.includes('nope.ts')));
});

// --- 11. patterns / extensions --------------------------------------------

test('buildGraph: .tsx files extract through TS extractor (Phase 1b)', async (t) => {
  // Phase 1b: .tsx is routed to the TS extractor. The tree-sitter-typescript
  // grammar doesn't parse JSX cleanly, so we expect a parse-error warning,
  // but top-level export symbols are still recovered. The file node is
  // emitted, not skipped.
  const root = tempProject(t);
  await write(path.join(root, 'ok.ts'), 'export const X = 1;\n');
  await write(path.join(root, 'comp.tsx'), 'export const Y = 1;\nexport function App() { return <div />; }\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 2, 'both .ts and .tsx files should produce nodes');
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const paths = g[GRAPH.NODES].map((n) => n[NODE.PATH]).sort();
  assert.deepEqual(paths, ['comp.tsx', 'ok.ts']);
  // Top-level exports recovered despite JSX-induced parse errors.
  const tsxNode = g[GRAPH.NODES].find((n) => n[NODE.PATH] === 'comp.tsx');
  assert.ok(tsxNode[NODE.SYMBOLS].includes('Y'), 'TSX file should export Y');
});

test('buildGraph: .js files extract through JS extractor', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.js'), 'export const A = 1;\nexport function fn() {}\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  assert.deepEqual(g[GRAPH.NODES][0][NODE.SYMBOLS], ['A', 'fn']);
});

test('buildGraph: mixed .ts + .js project routes correctly', async (t) => {
  const root = tempProject(t);
  // Two .ts files
  await write(path.join(root, 'ts-a.ts'), 'export const TS_A = 1;\nimport { x } from "./ts-b";\n');
  await write(path.join(root, 'ts-b.ts'), 'export const TS_B = 2;\n');
  // Two .js files (one ESM-style, one CJS-style)
  await write(path.join(root, 'js-esm.js'), 'export const JS_ESM = 3;\nimport { y } from "./js-cjs";\n');
  await write(path.join(root, 'js-cjs.js'), 'const z = require("./ts-b");\nmodule.exports.JS_CJS = 4;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 4, 'all four files should produce nodes');
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const paths = g[GRAPH.NODES].map((n) => n[NODE.PATH]).sort();
  assert.deepEqual(paths, ['js-cjs.js', 'js-esm.js', 'ts-a.ts', 'ts-b.ts']);
  // ts-a.ts should declare TS_A
  const tsA = g[GRAPH.NODES].find((n) => n[NODE.PATH] === 'ts-a.ts');
  assert.ok(tsA[NODE.SYMBOLS].includes('TS_A'));
  // js-cjs.js should have JS_CJS (via module.exports.JS_CJS = 4)
  const jsCjs = g[GRAPH.NODES].find((n) => n[NODE.PATH] === 'js-cjs.js');
  assert.ok(jsCjs[NODE.SYMBOLS].includes('JS_CJS'),
    `expected JS_CJS in js-cjs.js symbols, got: ${JSON.stringify(jsCjs[NODE.SYMBOLS])}`);
  // js-esm.js should have JS_ESM
  const jsEsm = g[GRAPH.NODES].find((n) => n[NODE.PATH] === 'js-esm.js');
  assert.ok(jsEsm[NODE.SYMBOLS].includes('JS_ESM'));
  // Verify imports exist across languages.
  const imports = g[GRAPH.EDGES].filter((e) => e[EDGE.TYPE] === EDGE_TYPES.IMPORTS);
  assert.ok(imports.length >= 3,
    `expected at least 3 imports (ts-a→ts-b, js-esm→js-cjs, js-cjs→ts-b), got ${imports.length}`);
});

test('buildGraph: .mjs and .cjs files are also indexed', async (t) => {
  const root = tempProject(t);
  await write(path.join(root, 'a.mjs'), 'export const M = 1;\n');
  await write(path.join(root, 'b.cjs'), 'module.exports.C = 2;\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 2);
});

test('buildGraph: .jsx files are indexed via the JS extractor', async (t) => {
  const root = tempProject(t);
  // tree-sitter-javascript handles JSX in the modern grammar, but we still
  // want the file node and symbol regardless.
  await write(path.join(root, 'app.jsx'), 'export function App() { return null; }\nexport const VERSION = "1";\n');
  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 1);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const node = g[GRAPH.NODES][0];
  assert.ok(node[NODE.SYMBOLS].includes('App'));
  assert.ok(node[NODE.SYMBOLS].includes('VERSION'));
});

// --- 12. performance smoke -------------------------------------------------

test('buildGraph: 600-file synthetic build completes in < 5s', { skip: process.env.SEXTANT_SLOW ? false : 'set SEXTANT_SLOW=1 to enable' }, async (t) => {
  const root = tempProject(t);
  for (let i = 0; i < 600; i++) {
    await write(path.join(root, `mod${i}.ts`), `import _ from "./mod${(i + 1) % 600}";\nexport const X${i} = ${i};\n`);
  }
  const t0 = process.hrtime.bigint();
  const r = await buildGraph({ root, quiet: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stdout.write(`# 600-file build: ${ms.toFixed(0)}ms (target < 5000ms)\n`);
  assert.ok(ms < 5000, `wall-clock too slow: ${ms.toFixed(0)}ms`);
  assert.equal(r.files, 600);
});
