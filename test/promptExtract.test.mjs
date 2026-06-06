// Tests for lib/inject/promptExtract.mjs — pure helpers used by the Phase 6
// UserPromptSubmit preload step.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPaths,
  extractSymbols,
  filterToGraph,
} from '../lib/inject/promptExtract.mjs';

import {
  SCHEMA_VERSION,
  NODE_TYPES,
  GRAPH,
  NODE,
  fileNodeId,
} from '../lib/graph/schema.mjs';

// ---- extractPaths --------------------------------------------------------

test('extractPaths: finds a single typescript path', () => {
  assert.deepEqual(extractPaths('check src/api/auth.ts'), ['src/api/auth.ts']);
});

test('extractPaths: handles multiple paths', () => {
  const out = extractPaths('see src/a.ts and src/b.js and config.yaml');
  assert.deepEqual(out, ['src/a.ts', 'src/b.js', 'config.yaml']);
});

test('extractPaths: deduplicates exact repeats', () => {
  const out = extractPaths('look at src/a.ts then src/a.ts again');
  assert.deepEqual(out, ['src/a.ts']);
});

test('extractPaths: ignores unknown extensions', () => {
  // .example is NOT in the known extension list — should be skipped.
  const out = extractPaths('open foo.example and skip');
  assert.deepEqual(out, []);
});

test('extractPaths: handles all known extensions', () => {
  const prompt = [
    'a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.mjs', 'f.cjs',
    'g.py', 'h.go', 'i.rs', 'j.md', 'k.json',
    'l.yml', 'm.yaml', 'n.toml',
  ].join(' ');
  const out = extractPaths(prompt);
  assert.equal(out.length, 14);
  assert.ok(out.includes('a.ts'));
  assert.ok(out.includes('n.toml'));
  assert.ok(out.includes('m.yaml'));
});

test('extractPaths: returns empty for empty / null / non-string input', () => {
  assert.deepEqual(extractPaths(''), []);
  assert.deepEqual(extractPaths(null), []);
  assert.deepEqual(extractPaths(undefined), []);
  assert.deepEqual(extractPaths(42), []);
});

test('extractPaths: strips leading ./', () => {
  const out = extractPaths('see ./src/a.ts and ./src/a.ts again');
  assert.deepEqual(out, ['src/a.ts']);
});

test('extractPaths: handles paths embedded in prose', () => {
  const out = extractPaths('The file src/foo.ts has a bug in package.json maybe');
  assert.deepEqual(out, ['src/foo.ts', 'package.json']);
});

// ---- extractSymbols ------------------------------------------------------

test('extractSymbols: extracts a capitalized identifier', () => {
  assert.deepEqual(extractSymbols('Use The ValidateToken function'), ['ValidateToken']);
});

test('extractSymbols: filters common stoplist words', () => {
  const out = extractSymbols('The And For But Or Not You This');
  // All in stoplist — nothing should survive.
  assert.deepEqual(out, []);
});

test('extractSymbols: requires >=3 chars after the leading uppercase', () => {
  // 'AB' is 2 chars total — should NOT match. 'ABC' is 3 chars and SHOULD.
  const out = extractSymbols('AB ABC Abcd');
  assert.ok(out.includes('ABC'));
  assert.ok(out.includes('Abcd'));
  assert.ok(!out.includes('AB'));
});

test('extractSymbols: deduplicates identical symbols', () => {
  const out = extractSymbols('ValidateToken and ValidateToken again');
  assert.deepEqual(out, ['ValidateToken']);
});

test('extractSymbols: preserves source order on first occurrence', () => {
  const out = extractSymbols('Foo then Bar then Baz');
  assert.deepEqual(out, ['Foo', 'Bar', 'Baz']);
});

test('extractSymbols: returns empty for empty / null / non-string input', () => {
  assert.deepEqual(extractSymbols(''), []);
  assert.deepEqual(extractSymbols(null), []);
  assert.deepEqual(extractSymbols(undefined), []);
  assert.deepEqual(extractSymbols(123), []);
});

test('extractSymbols: handles identifiers with digits and underscores', () => {
  const out = extractSymbols('Use HttpClient_v2 for Http3Server');
  assert.ok(out.includes('HttpClient_v2'));
  assert.ok(out.includes('Http3Server'));
});

test('extractSymbols: does NOT pick up lowercase identifiers', () => {
  const out = extractSymbols('the function validateToken should fire');
  // No capitalized matches except potentially nothing (the/function/etc lowercase).
  assert.deepEqual(out, []);
});

// ---- filterToGraph -------------------------------------------------------

function makeGraph(nodes) {
  return {
    [GRAPH.SCHEMA_VERSION]: SCHEMA_VERSION,
    [GRAPH.NODES]: nodes,
    [GRAPH.EDGES]: [],
    [GRAPH.BUILT_AT]: new Date().toISOString(),
    [GRAPH.STATS]: { files: nodes.length, edges: 0 },
  };
}

function fileNode(rel, symbols) {
  return {
    [NODE.ID]: fileNodeId(rel),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: rel.split('/').slice(-1)[0],
    [NODE.PATH]: rel,
    [NODE.SYMBOLS]: symbols,
    [NODE.COMMUNITY]: null,
  };
}

test('filterToGraph: matches symbols against file node symbol arrays', () => {
  const graph = makeGraph([
    fileNode('foo.ts', ['foo', 'Bar']),
    fileNode('baz.ts', ['baz', 'Qux']),
  ]);
  const out = filterToGraph(['Bar', 'NotInGraph'], graph);
  assert.deepEqual(out, [{ symbol: 'Bar', nodeId: 'node:foo.ts' }]);
});

test('filterToGraph: returns multiple hits with their parent nodeIds', () => {
  const graph = makeGraph([
    fileNode('foo.ts', ['Bar']),
    fileNode('baz.ts', ['Qux']),
  ]);
  const out = filterToGraph(['Bar', 'Qux'], graph);
  assert.deepEqual(out, [
    { symbol: 'Bar', nodeId: 'node:foo.ts' },
    { symbol: 'Qux', nodeId: 'node:baz.ts' },
  ]);
});

test('filterToGraph: first-occurrence wins for duplicate symbols across nodes', () => {
  const graph = makeGraph([
    fileNode('first.ts', ['Shared']),
    fileNode('second.ts', ['Shared']),
  ]);
  const out = filterToGraph(['Shared'], graph);
  // The "first" tie-break is graph node insertion order.
  assert.deepEqual(out, [{ symbol: 'Shared', nodeId: 'node:first.ts' }]);
});

test('filterToGraph: returns [] when graph is null', () => {
  assert.deepEqual(filterToGraph(['Foo'], null), []);
});

test('filterToGraph: returns [] when graph is malformed (no nodes array)', () => {
  assert.deepEqual(filterToGraph(['Foo'], { not: 'a graph' }), []);
});

test('filterToGraph: returns [] when symbols array is empty', () => {
  const graph = makeGraph([fileNode('foo.ts', ['Bar'])]);
  assert.deepEqual(filterToGraph([], graph), []);
});

test('filterToGraph: returns [] when no symbols match any node', () => {
  const graph = makeGraph([fileNode('foo.ts', ['Bar'])]);
  assert.deepEqual(filterToGraph(['Nope'], graph), []);
});

test('filterToGraph: ignores nodes with missing/non-array symbols', () => {
  const graph = makeGraph([
    { [NODE.ID]: 'node:weird.ts', [NODE.TYPE]: NODE_TYPES.FILE, [NODE.PATH]: 'weird.ts' },
    fileNode('ok.ts', ['Real']),
  ]);
  assert.deepEqual(filterToGraph(['Real'], graph), [{ symbol: 'Real', nodeId: 'node:ok.ts' }]);
});
