// Tests for lib/graph/parser.mjs — tree-sitter parser bootstrap smoke tests.
//
// Goals:
//   1. The vendored TypeScript grammar loads.
//   2. The parser produces a syntax tree whose root is `program`.
//   3. Real syntactic constructs (function_declaration) are present in the
//      tree, so we know we got a real grammar and not just an error recovery
//      stub.
//   4. The cached-instance contract holds: loadTypescriptParser() returns the
//      same Parser across calls.
//
// These are smoke tests, not exhaustive grammar tests — exercising every node
// type is the upstream tree-sitter-typescript repo's job, not ours.
//
// Test isolation: each test uses __resetCacheForTests() in a `t.before()`
// hook so order doesn't matter. The fourth test ALSO calls reset, but then
// asserts that two calls AFTER the reset hand back the same instance.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadTypescriptParser,
  parseTypescript,
  __resetCacheForTests,
  __getCachedParserForTests,
} from '../lib/graph/parser.mjs';

// Walk a tree-sitter tree depth-first and collect every node type. Used to
// assert that a particular node type appears anywhere in the parse, without
// hard-coding the parser's child-index layout (which may shift between
// grammar versions).
function collectTypes(rootNode) {
  const types = new Set();
  const stack = [rootNode];
  while (stack.length) {
    const n = stack.pop();
    types.add(n.type);
    for (let i = 0; i < n.childCount; i++) {
      stack.push(n.child(i));
    }
  }
  return types;
}

test('loadTypescriptParser returns a non-null parser instance', async (t) => {
  __resetCacheForTests();
  t.after(() => __resetCacheForTests());

  const parser = await loadTypescriptParser();
  assert.ok(parser, 'expected a Parser instance');
  // Sanity: the parser should have a `parse` method.
  assert.equal(typeof parser.parse, 'function', 'parser.parse should be a function');
});

test('parseTypescript produces a tree rooted at "program" for a simple decl', async (t) => {
  __resetCacheForTests();
  t.after(() => __resetCacheForTests());

  const parser = await loadTypescriptParser();
  assert.ok(parser, 'parser failed to load');
  const tree = parseTypescript(parser, 'const x = 1;');
  assert.ok(tree, 'expected a Tree');
  assert.equal(tree.rootNode.type, 'program', 'root node type should be "program"');
});

test('parseTypescript surfaces a function_declaration node', async (t) => {
  __resetCacheForTests();
  t.after(() => __resetCacheForTests());

  const parser = await loadTypescriptParser();
  assert.ok(parser, 'parser failed to load');
  const tree = parseTypescript(parser, 'function foo() {}');
  assert.ok(tree, 'expected a Tree');
  const types = collectTypes(tree.rootNode);
  assert.ok(
    types.has('function_declaration'),
    `expected "function_declaration" in tree types; got: ${[...types].sort().join(', ')}`,
  );
});

test('loadTypescriptParser caches the parser across calls', async (t) => {
  __resetCacheForTests();
  t.after(() => __resetCacheForTests());

  const a = await loadTypescriptParser();
  const b = await loadTypescriptParser();
  assert.ok(a, 'first call returned null');
  assert.equal(a, b, 'second call should return the cached instance');
  assert.equal(__getCachedParserForTests(), a, 'internal cache should match returned parser');
});

test('parseTypescript on a null parser returns null (graceful degradation)', () => {
  // Don't reset the cache here — we're not interacting with module state.
  const result = parseTypescript(null, 'const x = 1;');
  assert.equal(result, null, 'parseTypescript(null, ...) should return null');
});

test('parseTypescript handles empty source without crashing', async (t) => {
  __resetCacheForTests();
  t.after(() => __resetCacheForTests());

  const parser = await loadTypescriptParser();
  assert.ok(parser, 'parser failed to load');
  const tree = parseTypescript(parser, '');
  assert.ok(tree, 'tree-sitter should still produce a Tree for empty input');
  assert.equal(tree.rootNode.type, 'program', 'empty input should still yield a program node');
});
