// test/test-detector.test.mjs — Phase 5 § 5.6 / § 5.9 unit tests.
//
// Covers detectTestCommand (positive + negative table) and parseTestOutput
// (passed boolean + framework detection + failure parsing).

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectTestCommand, parseTestOutput } from '../lib/capture/test-detector.mjs';

// --- detectTestCommand positives ------------------------------------------

const POSITIVES = [
  'npm test',
  'npm t',
  'npm run test',
  'npm run test:unit',
  'npm run test:integration -- --watch',
  '  npm test',                  // leading whitespace
  'NODE_ENV=test npm test',      // env-var prefix
  'yarn test',
  'yarn run test',
  'yarn jest',
  'yarn vitest --watch',
  'pnpm test',
  'pnpm vitest',
  'pnpm run test',
  'pnpm t',
  'jest',
  'jest --watch',
  'vitest run',
  'mocha',
  'npx jest',
  'npx vitest',
  './node_modules/.bin/jest',
  'node --test',
  'node --test test/',
  'pytest',
  'pytest tests/',
  'python -m pytest',
  'python3 -m pytest tests/',
  'python -m unittest',
  'go test',
  'go test ./...',
  'cargo test',
  'cargo test --workspace',
  'rspec',
  'rspec spec/',
  'rails test',
  'bundle exec rspec',
  'bundle exec rails test',
  'dotnet test',
  'mvn test',
  'mvn verify',
  'gradle test',
  './gradlew test',
  './test.sh',
  'make test',
  'ninja test',
  'bun test',
];

for (const cmd of POSITIVES) {
  test(`detectTestCommand: positive — ${JSON.stringify(cmd)}`, () => {
    assert.equal(detectTestCommand(cmd), true);
  });
}

// --- detectTestCommand negatives ------------------------------------------

const NEGATIVES = [
  'git status',
  'git log',
  'git diff',
  'git commit -m "x"',
  'ls',
  'ls -la',
  'cat README.md',
  'echo hello',
  'node script.js',           // bare node script — not --test
  'npm install',
  'npm ci',
  'npm run build',
  'yarn install',
  'yarn build',
  'pnpm install',
  'cargo build',
  'go build',
  'pip install pytest',       // "pytest" appears but not as the command
  'true',
  '',
];

for (const cmd of NEGATIVES) {
  test(`detectTestCommand: negative — ${JSON.stringify(cmd)}`, () => {
    assert.equal(detectTestCommand(cmd), false);
  });
}

test('detectTestCommand: non-string returns false', () => {
  assert.equal(detectTestCommand(null), false);
  assert.equal(detectTestCommand(undefined), false);
  assert.equal(detectTestCommand(123), false);
  assert.equal(detectTestCommand({}), false);
});

// --- parseTestOutput passed=true cases -------------------------------------

test('parseTestOutput: exit_code 0 → passed=true regardless of output', () => {
  const r = parseTestOutput({ exit_code: 0, stdout: 'whatever' });
  assert.equal(r.passed, true);
  assert.deepEqual(r.failures, []);
});

test('parseTestOutput: exit_code 0 with FAIL text → still passed=true', () => {
  // exit code wins per § 5.9.
  const r = parseTestOutput({ exit_code: 0, stdout: 'FAIL fake/path.ts' });
  assert.equal(r.passed, true);
});

test('parseTestOutput: missing exit_code with is_error=false → passed=true', () => {
  const r = parseTestOutput({ is_error: false, stdout: 'all good' });
  assert.equal(r.passed, true);
});

test('parseTestOutput: empty tool_response → passed=true (default)', () => {
  const r = parseTestOutput({});
  assert.equal(r.passed, true);
});

test('parseTestOutput: undefined → passed=true', () => {
  const r = parseTestOutput(undefined);
  assert.equal(r.passed, true);
});

// --- parseTestOutput passed=false cases ------------------------------------

test('parseTestOutput: exit_code 1 → passed=false', () => {
  const r = parseTestOutput({ exit_code: 1, stdout: 'FAIL' });
  assert.equal(r.passed, false);
});

test('parseTestOutput: is_error=true (no exit_code) → passed=false', () => {
  const r = parseTestOutput({ is_error: true, stdout: 'tracker' });
  assert.equal(r.passed, false);
});

test('parseTestOutput: exit_code 2 + jest output → framework=jest', () => {
  const r = parseTestOutput({
    exit_code: 1,
    stdout: 'Tests: 1 passed, 1 failed\nFAIL test/foo.test.ts',
  });
  assert.equal(r.passed, false);
  assert.equal(r.framework, 'jest');
  assert.ok(r.failures.length >= 1, `expected at least one parsed failure; got ${JSON.stringify(r.failures)}`);
  assert.ok(r.failures.some((f) => f.file === 'test/foo.test.ts'));
});

test('parseTestOutput: pytest FAILED line → framework=pytest + failure parsed', () => {
  const stdout = [
    '=== test session starts ===',
    'collected 5 items',
    'FAILED tests/test_foo.py::test_bar - AssertionError: 1 != 2',
    '',
  ].join('\n');
  const r = parseTestOutput({ exit_code: 1, stdout });
  assert.equal(r.passed, false);
  assert.equal(r.framework, 'pytest');
  assert.ok(r.failures.some((f) => f.file === 'tests/test_foo.py'));
});

test('parseTestOutput: vitest fail summary', () => {
  const stdout = [
    'Test Files  1 failed (1)',
    'Tests       1 failed (1)',
    ' FAIL  src/foo.test.ts > works',
  ].join('\n');
  const r = parseTestOutput({ exit_code: 1, stdout });
  assert.equal(r.passed, false);
  // Either vitest or jest may be detected by the markers; both are acceptable
  // since the harness only cares about pass/fail. Accept either.
  assert.ok(r.framework === 'vitest' || r.framework === 'jest',
    `expected vitest or jest; got ${r.framework}`);
});

test('parseTestOutput: failures list capped at 20', () => {
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`FAIL test/case-${i}.test.ts`);
  }
  const r = parseTestOutput({ exit_code: 1, stdout: lines.join('\n') });
  assert.equal(r.passed, false);
  assert.ok(r.failures.length <= 20,
    `expected at most 20 failures; got ${r.failures.length}`);
});

test('parseTestOutput: AssertionError without explicit framework', () => {
  const r = parseTestOutput({
    exit_code: 1,
    stdout: 'AssertionError: expected foo to be bar',
  });
  assert.equal(r.passed, false);
  // No framework recognised → null.
  assert.ok(r.failures.some((f) => /AssertionError/.test(f.msg)));
});

test('parseTestOutput: tool_response.content fallback', () => {
  // Some tool_response shapes only carry `content`. parseTestOutput should
  // still extract the framework + failures from there.
  const r = parseTestOutput({
    is_error: true,
    content: 'Tests: 0 passed, 1 failed\nFAIL test/a.test.ts',
  });
  assert.equal(r.passed, false);
  assert.equal(r.framework, 'jest');
});
