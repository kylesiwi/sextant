// lib/capture/test-detector.mjs — Phase 5 § 5.6 / § 5.9 helpers.
//
// Two responsibilities, deliberately permissive:
//
//   1. detectTestCommand(cmdStr): is the Bash command an invocation of a
//      test runner we recognise? We err on the side of false positives —
//      the only consequence of a stray match is that PostToolUse Bash
//      tries (and likely no-ops) the verification path. We MUST NOT
//      mistakenly mark a read-only command (git status, ls, ...) as a
//      test, since the failure path emits a systemMessage.
//
//   2. parseTestOutput({ stdout, stderr, exit_code, is_error }): given a
//      tool_response shape from Claude Code, decide whether the test
//      passed and (best-effort) identify the framework + parse out
//      individual failures. Phase 5's verification logic only consumes
//      `passed`; `framework` + `failures` are exposed for diagnostics
//      and future bug-capture flows.
//
// The matchers below are anchored at the start of the command (with
// leading whitespace allowed) and use lookaheads for word boundaries.
// They tolerate compound shells (`bash -c 'cmd'`, etc.) by accepting the
// first runner-shaped token. Anything else (env-var prefixes, multi-
// command pipelines, etc.) defers to the FRAMEWORK_PATTERNS table below
// which scans the full command string for runner names.

// Patterns we treat as a test invocation, anchored to the command start
// after optional leading whitespace + optional env-var assignments
// (e.g., `NODE_ENV=test npm test`). Each entry is a regex that, when it
// matches the cmdStr, returns true.
//
// Permissive list — see § 5.6 of GROUND_UP_DESIGN.md. Easy to add to
// when a new framework lands.
const TEST_COMMAND_PATTERNS = [
  // npm / yarn / pnpm
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*npm\s+(?:run\s+)?t(?:est)?(?:\s|$|:)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*npm\s+run\s+test(?:[:-]\S+)?(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*yarn\s+(?:run\s+)?test(?:[:-]\S+)?(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*yarn\s+(?:run\s+)?jest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*yarn\s+(?:run\s+)?vitest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*pnpm\s+(?:run\s+)?test(?:[:-]\S+)?(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*pnpm\s+(?:run\s+)?jest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*pnpm\s+(?:run\s+)?vitest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*pnpm\s+t(?:est)?(?:\s|$|:)/,

  // Direct JS-runner invocations (npx / direct binary / node_modules/.bin/x)
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?jest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?vitest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+)?mocha(?:\s|$)/,
  /^\s*\.\/node_modules\/\.bin\/(?:jest|vitest|mocha)(?:\s|$)/,

  // Node's own runner: `node --test`
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*node\s+--test(?:\s|$|=)/,

  // Python
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*pytest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*python3?(?:\.\d+)?\s+-m\s+pytest(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*python3?(?:\.\d+)?\s+-m\s+unittest(?:\s|$)/,

  // Go / Rust
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*go\s+test(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*cargo\s+test(?:\s|$)/,

  // Ruby
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*rspec(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*rails\s+test(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*bundle\s+exec\s+(?:rspec|rake\s+test|rails\s+test)(?:\s|$)/,

  // .NET
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*dotnet\s+test(?:\s|$)/,

  // JVM
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*mvn\s+(?:test|verify)(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*gradle\s+test(?:\s|$)/,
  /^\s*\.\/gradlew\s+test(?:\s|$)/,

  // Make / Ninja / shell-scripted test entrypoints
  /^\s*\.\/test\.sh(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*make\s+test(?:\s|$)/,
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*ninja\s+test(?:\s|$)/,

  // bun
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*bun\s+test(?:\s|$)/,
];

/**
 * detectTestCommand(cmdStr): true if `cmdStr` looks like a test runner.
 * Permissive — see § 5.6.
 */
export function detectTestCommand(cmdStr) {
  if (typeof cmdStr !== 'string' || cmdStr.length === 0) return false;
  for (const re of TEST_COMMAND_PATTERNS) {
    if (re.test(cmdStr)) return true;
  }
  return false;
}

// Framework markers used by parseTestOutput. Order matters: pytest output
// also contains the word 'PASSED', so we check explicit framework strings
// before falling back to generic 'PASS'/'FAIL'/'AssertionError' markers.
const FRAMEWORK_MARKERS = [
  { name: 'jest',     re: /jest|Tests:\s+\d+\s+(?:passed|failed)/i },
  { name: 'vitest',   re: /vitest|Test Files\s+\d+\s+(?:passed|failed)/i },
  { name: 'mocha',    re: /mocha|\d+\s+passing\b/i },
  { name: 'pytest',   re: /pytest|=+\s*(?:test session starts|FAILURES)/i },
  { name: 'unittest', re: /Ran\s+\d+\s+test/i },
  { name: 'go-test',  re: /^---\s+FAIL:|^---\s+PASS:|^PASS\nok\b|^FAIL\b/m },
  { name: 'cargo',    re: /running\s+\d+\s+tests?|test result:\s+(?:ok|FAILED)/i },
  { name: 'rspec',    re: /\d+\s+examples?,\s+\d+\s+failures?/i },
  { name: 'node-test',re: /^# tests \d+/m },
];

function detectFramework(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { name, re } of FRAMEWORK_MARKERS) {
    if (re.test(text)) return name;
  }
  return null;
}

// Heuristic failure parser. Each entry takes (text, framework) and returns
// an array of { file, line, msg } entries. Best-effort — we never throw
// from here.
function parseFailures(text, framework) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  // jest / vitest: lines like "FAIL test/foo.test.ts" or "  ✕ name (123 ms)"
  // We grab a handful of FAIL-prefixed paths as the spine.
  const failRe = /^\s*(?:FAIL|✗|✘|✕|×)\s+(\S+)/gm;
  let m;
  while ((m = failRe.exec(text)) !== null) {
    const key = `fail|${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: m[1], line: null, msg: m[0].trim() });
    if (out.length >= 20) break;
  }
  // pytest: "FAILED tests/test_foo.py::test_bar - AssertionError: ..."
  const pytestRe = /^FAILED\s+([^:\s]+)(?:::(\S+))?(?:\s*-\s*(.+))?$/gm;
  while ((m = pytestRe.exec(text)) !== null) {
    const key = `pyt|${m[1]}|${m[2] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: m[1], line: null, msg: (m[3] ?? m[0]).trim() });
    if (out.length >= 20) break;
  }
  // Generic AssertionError + file:line:col matches.
  const assertRe = /AssertionError[^\n]*(?:\n\s+at\s+\S+:(\d+):\d+)?/g;
  while ((m = assertRe.exec(text)) !== null) {
    const key = `assert|${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file: null, line: m[1] ? Number(m[1]) : null, msg: m[0].split('\n')[0] });
    if (out.length >= 20) break;
  }
  void framework;
  return out;
}

/**
 * parseTestOutput(toolResponse): translate a Claude Code tool_response
 * into a structured pass/fail summary.
 *
 * Inputs (all optional, all best-effort):
 *   stdout, stderr  - strings
 *   exit_code       - number; absence treated as success per Claude Code's
 *                     observed shape for Bash with no error.
 *   is_error        - boolean; some shapes carry this instead of exit_code.
 *
 * Output: { passed, framework, failures }
 *   - passed:    boolean. True iff exit_code === 0 AND is_error is not true.
 *                When exit_code is unavailable we fall back to !is_error,
 *                defaulting to true (Phase 0 contract).
 *   - framework: detected runner name or null.
 *   - failures:  array of { file, line, msg } when passed=false; otherwise
 *                an empty array.
 */
export function parseTestOutput(toolResponse) {
  const r = (toolResponse && typeof toolResponse === 'object') ? toolResponse : {};
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  // Some tool_response shapes carry the body in `content` instead of
  // stdout. Lower-cost to coalesce here than have every caller worry.
  const content = typeof r.content === 'string' ? r.content : '';
  const text = [stdout, stderr, content].filter(Boolean).join('\n');
  const framework = detectFramework(text);

  let passed;
  if (typeof r.exit_code === 'number' && Number.isFinite(r.exit_code)) {
    passed = r.exit_code === 0 && r.is_error !== true;
  } else if (typeof r.exitCode === 'number' && Number.isFinite(r.exitCode)) {
    // Camel-case variant for safety.
    passed = r.exitCode === 0 && r.is_error !== true;
  } else if (typeof r.is_error === 'boolean') {
    passed = !r.is_error;
  } else {
    // No signal at all → default to passing. The pass branch is idempotent
    // (marking already-verified bugs is a no-op); a false negative would
    // emit an unwanted systemMessage on the fail branch, which is worse.
    passed = true;
  }

  return {
    passed,
    framework,
    failures: passed ? [] : parseFailures(text, framework),
  };
}
