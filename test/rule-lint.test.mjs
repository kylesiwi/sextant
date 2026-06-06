// Tests for lib/capture/ruleLint.mjs — the shared deterministic rule linter
// (cerebrum-v2 T5.5). Errors block (Stop gate + remember); warns are advisory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { lintCerebrumRule } from '../lib/capture/ruleLint.mjs';
import { parseCerebrum } from '../lib/stores/cerebrum.mjs';

function ruleOf(line) {
  return parseCerebrum(line).lines.find((e) => e.kind === 'rule');
}

test('clean rule → no errors, no warns', () => {
  const r = lintCerebrumRule(ruleOf('- 2026-05-12: [kw:deploy] [!] never deploy on a friday (by: s)'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warns, []);
});

test('ERROR: bucket-shaped tag left in the body', () => {
  const r = lintCerebrumRule(ruleOf('- 2026-05-12: [!] [build][wsl] repo is on windows ntfs build there (by: s)'));
  // [build]/[wsl] are not recognized buckets → they stay at the head of body.
  assert.ok(r.errors.some((m) => /bucket-shaped tag/.test(m) && /\[build\]/.test(m)), JSON.stringify(r));
});

test('ERROR: body-bracket detector is robust to an auto-tag prefix (advisor #3)', () => {
  // [provisional] is a real bucket → stripped into buckets; [todo] still leads body.
  const e = ruleOf('- 2026-05-12: [provisional] [todo] read the design doc and write a plan');
  assert.ok(Array.isArray(e.buckets) && e.buckets.includes('provisional'), 'provisional parsed as bucket');
  const r = lintCerebrumRule(e);
  assert.ok(r.errors.some((m) => /bucket-shaped tag/.test(m) && /\[todo\]/.test(m)), JSON.stringify(r));
});

test('ERROR: [kw:] bucket with no terms', () => {
  const r = lintCerebrumRule(ruleOf('- 2026-05-12: [kw:,] [!] comma-only keyword bucket has no real terms (by: s)'));
  assert.ok(r.errors.some((m) => /no keyword terms/.test(m)), JSON.stringify(r));
});

test('ERROR: empty [node:] path', () => {
  const r = lintCerebrumRule({ kind: 'rule', buckets: ['node:'], body: 'some body text here' });
  assert.ok(r.errors.some((m) => /empty \[node:\] path/.test(m)), JSON.stringify(r));
});

test('ERROR: [!] importance with no scope → fires nowhere', () => {
  const r = lintCerebrumRule({ kind: 'rule', buckets: ['!'], body: 'mandatory but unscoped' });
  assert.ok(r.errors.some((m) => /no scope/.test(m) && /fires nowhere/.test(m)), JSON.stringify(r));
});

test('[global][!] and [!global][!] are NOT scope-less (global is a scope)', () => {
  assert.deepEqual(lintCerebrumRule({ kind: 'rule', buckets: ['global', '!'], body: 'x'.repeat(10) }).errors, []);
  assert.deepEqual(lintCerebrumRule({ kind: 'rule', buckets: ['!global', '!'], body: 'x'.repeat(10) }).errors, []);
});

// cerebrum-v2 T5.6: [!] is a kw-only modifier; on node:/global it's redundant (WARN, not error).
test('WARN: [!] is redundant on a [node:] rule (T5.6)', () => {
  const r = lintCerebrumRule({ kind: 'rule', buckets: ['node:src/a.ts', '!'], body: 'x'.repeat(10) });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warns.some((m) => /redundant/.test(m) && /kw:/.test(m)), JSON.stringify(r));
});

test('WARN: [!] is redundant on a [global] rule (T5.6)', () => {
  assert.ok(lintCerebrumRule({ kind: 'rule', buckets: ['global', '!'], body: 'x'.repeat(10) })
    .warns.some((m) => /redundant/.test(m)));
  assert.ok(lintCerebrumRule({ kind: 'rule', buckets: ['!global', '!'], body: 'x'.repeat(10) })
    .warns.some((m) => /redundant/.test(m)));
});

test('NO redundant warn: bare [node:] (no [!]) and [kw:][!] are clean (T5.6)', () => {
  // bare node = the canonical clean form under the new model
  assert.deepEqual(lintCerebrumRule({ kind: 'rule', buckets: ['node:src/a.ts'], body: 'x'.repeat(10) }).warns, []);
  // [!] on a kw rule is meaningful (floor + write-gate), not redundant
  assert.deepEqual(lintCerebrumRule({ kind: 'rule', buckets: ['kw:deploy', '!'], body: 'x'.repeat(10) }).warns, []);
});

test('WARN (not error): stale [node:] path under root', (t) => {
  const root = path.join(os.tmpdir(), 'sextant-lint-' + crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = lintCerebrumRule({ kind: 'rule', buckets: ['node:does/not/exist.ts'], body: 'body' }, { root });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warns.some((m) => /does not exist/.test(m)), JSON.stringify(r));
});

test('existing [node:] path under root → no warn', (t) => {
  const root = path.join(os.tmpdir(), 'sextant-lint-' + crypto.randomUUID());
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// x\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = lintCerebrumRule({ kind: 'rule', buckets: ['node:src/a.ts'], body: 'body' }, { root });
  assert.deepEqual(r.warns, []);
});

test('non-rule entry lints clean', () => {
  const r = lintCerebrumRule({ kind: 'comment', buckets: [], body: null });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warns, []);
});
