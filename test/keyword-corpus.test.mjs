// Tests for the per-tool keyword corpus map (cerebrum-v2 T4 — spec §13.2).
//
// buildKeywordCorpus replaces the old `JSON.stringify(toolInput)` fallback with
// a per-tool field selection so each broadened surface contributes only its
// signal-bearing text (never JSON keys/punctuation). MCP + AskUserQuestion
// recursively harvest string-valued args, capped at ~4 KB.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildKeywordCorpus } from '../lib/hooks/preToolUse.mjs';

test('Bash → command', () => {
  assert.equal(buildKeywordCorpus('Bash', { command: 'rm -rf foo' }), 'rm -rf foo');
});

test('Read → file_path', () => {
  assert.equal(buildKeywordCorpus('Read', { file_path: 'src/auth/login.ts' }), 'src/auth/login.ts');
});

test('Grep/Glob → pattern (+ path)', () => {
  assert.equal(buildKeywordCorpus('Grep', { pattern: 'API_KEY', path: 'lib/' }), 'API_KEY lib/');
  assert.equal(buildKeywordCorpus('Glob', { pattern: '**/*.ts' }), '**/*.ts');
});

test('Edit → file_path + new_string', () => {
  const corpus = buildKeywordCorpus('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'log(password)' });
  assert.match(corpus, /a\.ts/);
  assert.match(corpus, /log\(password\)/);
  assert.ok(!corpus.includes('old_string'), 'must not include JSON keys');
});

test('Write → file_path + content', () => {
  const corpus = buildKeywordCorpus('Write', { file_path: 'b.ts', content: 'secret = 1' });
  assert.match(corpus, /b\.ts/);
  assert.match(corpus, /secret = 1/);
});

test('MultiEdit → file_path + joined edits[].new_string', () => {
  const corpus = buildKeywordCorpus('MultiEdit', {
    file_path: 'c.ts',
    edits: [{ old_string: 'a', new_string: 'first change' }, { old_string: 'b', new_string: 'second change' }],
  });
  assert.match(corpus, /c\.ts/);
  assert.match(corpus, /first change/);
  assert.match(corpus, /second change/);
});

test('Task → description + prompt + subagent_type', () => {
  const corpus = buildKeywordCorpus('Task', {
    description: 'audit hooks',
    prompt: 'Review the plugin install flow',
    subagent_type: 'Explore',
  });
  assert.match(corpus, /audit hooks/);
  assert.match(corpus, /Review the plugin install flow/);
  assert.match(corpus, /Explore/);
});

test('WebFetch → url + prompt', () => {
  const corpus = buildKeywordCorpus('WebFetch', { url: 'https://example.com/x', prompt: 'extract the table' });
  assert.match(corpus, /example\.com/);
  assert.match(corpus, /extract the table/);
});

test('WebSearch → query', () => {
  assert.equal(buildKeywordCorpus('WebSearch', { query: 'node worker_threads ReDoS' }), 'node worker_threads ReDoS');
});

test('NotebookEdit → notebook_path + new_source', () => {
  const corpus = buildKeywordCorpus('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'import os' });
  assert.match(corpus, /nb\.ipynb/);
  assert.match(corpus, /import os/);
});

test('AskUserQuestion → question + option texts', () => {
  const corpus = buildKeywordCorpus('AskUserQuestion', {
    questions: [{
      question: 'Which auth method?',
      header: 'Auth',
      options: [{ label: 'OAuth', description: 'use OAuth2' }, { label: 'API key', description: 'static key' }],
      multiSelect: false,
    }],
  });
  assert.match(corpus, /Which auth method/);
  assert.match(corpus, /OAuth/);
  assert.match(corpus, /static key/);
});

test('MCP (mcp__*) → recursive string harvest', () => {
  const corpus = buildKeywordCorpus('mcp__github__create_issue', {
    title: 'Fix the deploy',
    body: 'production is down',
    labels: ['bug', 'urgent'],
    count: 3,           // non-string → skipped
    nested: { note: 'check the secrets' },
  });
  assert.match(corpus, /Fix the deploy/);
  assert.match(corpus, /production is down/);
  assert.match(corpus, /bug/);
  assert.match(corpus, /check the secrets/);   // nested strings harvested
  assert.ok(!corpus.includes('count'), 'non-string keys not surfaced');
});

test('MCP harvest is capped at ~4 KB', () => {
  const huge = 'x'.repeat(10000);
  const corpus = buildKeywordCorpus('mcp__server__tool', { a: huge, b: huge });
  assert.ok(corpus.length <= 4096, `corpus must be capped; got ${corpus.length}`);
});

test('unknown/unmapped tool → file_path, never a JSON dump', () => {
  assert.equal(buildKeywordCorpus('SomethingNew', { file_path: 'z.ts', extra: 'noise' }), 'z.ts');
  assert.equal(buildKeywordCorpus('SomethingNew', { extra: 'noise' }), '');
});

test('null / non-object toolInput → empty string', () => {
  assert.equal(buildKeywordCorpus('Task', null), '');
  assert.equal(buildKeywordCorpus('Bash', undefined), '');
});
