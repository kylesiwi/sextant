// Tests for lib/stores/cerebrum.mjs — parse/serialize + query helpers.
//
// Coverage targets:
//   - parseCerebrum: rule shape, multi-bucket, (by:), preceding and trailing
//     HTML markers, non-rule classification ([match:] deleted in T4).
//   - serializeCerebrum: round-trip (parse → serialize → parse equivalence).
//   - readCerebrumFile: ENOENT → { lines: [] }.
//   - writeCerebrumFile: atomic write (tmp file cleaned up, no torn read).
//   - listMandatoryFor: [!global] match, [!] [node:path] exact match, non-
//     matching paths filtered.
//   - listReviewQueue: [!review] and [ai-provisional] surfaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  parseCerebrum,
  serializeCerebrum,
  readCerebrumFile,
  writeCerebrumFile,
  listMandatoryFor,
  listReviewQueue,
  parseKeywordBucket,
} from '../lib/stores/cerebrum.mjs';

function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-cerebrum-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tmpFile(t, name = 'cerebrum.md') {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

// -- parseCerebrum: shape -------------------------------------------------

test('parseCerebrum: empty string yields empty lines array', () => {
  const p = parseCerebrum('');
  assert.deepEqual(p.lines, []);
});

test('parseCerebrum: blank lines classified as blank', () => {
  const p = parseCerebrum('\n\n');
  assert.equal(p.lines.length, 3); // "", "", ""
  for (const e of p.lines) assert.equal(e.kind, 'blank');
});

test('parseCerebrum: markdown headers classified as header', () => {
  const p = parseCerebrum('# Rules\n## Regular\n');
  assert.equal(p.lines[0].kind, 'header');
  assert.equal(p.lines[1].kind, 'header');
});

test('parseCerebrum: simple rule line — single [node:] bucket', () => {
  const text = '- 2026-05-10: [node:src/api/auth.ts] Reads from env.JWT_SECRET, never config file';
  const p = parseCerebrum(text);
  assert.equal(p.lines.length, 1);
  const e = p.lines[0];
  assert.equal(e.kind, 'rule');
  assert.equal(e.date, '2026-05-10');
  assert.deepEqual(e.buckets, ['node:src/api/auth.ts']);
  assert.equal(e.body, 'Reads from env.JWT_SECRET, never config file');
  assert.equal(e.bySession, null);
});

test('parseCerebrum: [!global] bucket', () => {
  const text = '- 2026-05-10: [!global] Always run prettier before committing';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.equal(e.kind, 'rule');
  assert.deepEqual(e.buckets, ['!global']);
  assert.equal(e.body, 'Always run prettier before committing');
});

test('parseCerebrum: multi-bucket — [!] [node:path] together', () => {
  const text = '- 2026-05-10: [!] [node:src/auth/login.ts] Never log raw passwords';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.equal(e.kind, 'rule');
  assert.deepEqual(e.buckets, ['!', 'node:src/auth/login.ts']);
  assert.equal(e.body, 'Never log raw passwords');
});

test('parseCerebrum: [ai-provisional] + [node:path]', () => {
  const text = '- 2026-05-10: [ai-provisional] [node:src/utils/date.ts] Prefer Temporal API';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.deepEqual(e.buckets, ['ai-provisional', 'node:src/utils/date.ts']);
});

test('parseCerebrum: (by: session) extracted to bySession', () => {
  const text = '- 2026-05-10: [!] [node:src/auth/login.ts] Never log passwords (by: sess-abc)';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.equal(e.bySession, 'sess-abc');
  assert.equal(e.body, 'Never log passwords');
});

// cerebrum-v2 T4: the [match: <regex>] field was deleted (charter anchor #8).
// It is no longer parsed or snipped — there is no `match` property, and the
// text rides along inside the body as inert content. (by:) is still extracted.
test('parseCerebrum: [match:] field is no longer extracted (deleted in T4)', () => {
  const text = '- 2026-05-10: [!] [node:src/auth/login.ts] Never log passwords (by: sess-abc) [match: /password.*log/i]';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.equal(e.match, undefined);
  assert.equal(e.bySession, 'sess-abc');
  assert.match(e.body, /\[match: \/password\.\*log\/i\]/);
});

test('parseCerebrum: trailing HTML marker — same line', () => {
  const text = '- 2026-05-10: [node:src/x.ts] body text <!-- sextant:auto-tag confidence=high -->';
  const p = parseCerebrum(text);
  const e = p.lines[0];
  assert.equal(e.kind, 'rule');
  assert.equal(e.body, 'body text');
  assert.deepEqual(e.markers, ['<!-- sextant:auto-tag confidence=high -->']);
});

test('parseCerebrum: preceding HTML marker attached to next rule', () => {
  const text = [
    '<!-- sextant:auto-tag confidence=low needs-review -->',
    '- 2026-05-10: [!review] body text',
  ].join('\n');
  const p = parseCerebrum(text);
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[0].kind, 'comment');
  assert.equal(p.lines[1].kind, 'rule');
  // Marker should be in next rule's markers[].
  assert.deepEqual(
    p.lines[1].markers,
    ['<!-- sextant:auto-tag confidence=low needs-review -->'],
  );
});

test('parseCerebrum: blank line between comment and rule breaks attachment', () => {
  const text = [
    '<!-- standalone marker -->',
    '',
    '- 2026-05-10: [node:x.ts] body',
  ].join('\n');
  const p = parseCerebrum(text);
  const rule = p.lines.find((e) => e.kind === 'rule');
  assert.deepEqual(rule.markers, []);
});

// -- parseCerebrum: anchor strictness --------------------------------------

test('parseCerebrum: [!] and [!global] are unambiguous (not prefix substrings)', () => {
  // From § 6.2: "[!]" must not be parsed as a prefix of "[!global]".
  const text = '- 2026-05-10: [!global] [!] body';
  const p = parseCerebrum(text);
  // Tokenisation order matters: prefer longer alternatives in the regex.
  // We accept either order as long as both tokens are present once each.
  const e = p.lines[0];
  assert.deepEqual([...e.buckets].sort(), ['!', '!global']);
});

test('parseCerebrum: non-rule list item (no date) is "other"', () => {
  const text = '- some untagged note';
  const p = parseCerebrum(text);
  assert.equal(p.lines[0].kind, 'other');
});

// -- serializeCerebrum: round-trip ----------------------------------------

test('serializeCerebrum: parse → serialize → parse is structurally equivalent', () => {
  const text = [
    '# Rules',
    '',
    '- 2026-05-10: [node:src/api/auth.ts] Reads from env.JWT_SECRET, never config file',
    '- 2026-05-10: [!global] Always run prettier before committing',
    '- 2026-05-10: [!] [node:src/auth/login.ts] Never log raw passwords (by: sess-abc) [match: /password.*log/i]',
    '- 2026-05-10: [ai-provisional] [node:src/utils/date.ts] Prefer Temporal API',
    '',
    '<!-- sextant:auto-tag confidence=low needs-review -->',
    '- 2026-05-11: [!review] Untagged rule from prior session',
  ].join('\n');

  const p1 = parseCerebrum(text);
  const s1 = serializeCerebrum(p1);
  const p2 = parseCerebrum(s1);

  // Structural equivalence: same length, same kinds, same date/buckets/body
  // per rule entry, same markers attachment.
  assert.equal(p1.lines.length, p2.lines.length);
  for (let i = 0; i < p1.lines.length; i++) {
    const a = p1.lines[i];
    const b = p2.lines[i];
    assert.equal(b.kind, a.kind, `kind mismatch at line ${i}`);
    assert.equal(b.date, a.date, `date mismatch at line ${i}`);
    assert.deepEqual(b.buckets, a.buckets, `buckets mismatch at line ${i}`);
    assert.equal(b.body, a.body, `body mismatch at line ${i}`);
    assert.equal(b.bySession, a.bySession, `bySession mismatch at line ${i}`);
    assert.deepEqual(b.markers, a.markers, `markers mismatch at line ${i}`);
  }
});

test('serializeCerebrum: empty parsed → empty string', () => {
  assert.equal(serializeCerebrum({ lines: [] }), '');
  assert.equal(serializeCerebrum(null), '');
  assert.equal(serializeCerebrum({}), '');
});

// -- readCerebrumFile -----------------------------------------------------

test('readCerebrumFile: ENOENT yields { lines: [] }', async (t) => {
  const file = tmpFile(t);
  const p = await readCerebrumFile(file);
  assert.deepEqual(p.lines, []);
});

test('readCerebrumFile: parses existing file', async (t) => {
  const file = tmpFile(t);
  const text = '- 2026-05-10: [!global] body\n';
  await fs.writeFile(file, text, 'utf8');
  const p = await readCerebrumFile(file);
  assert.equal(p.lines.length, 2); // last entry is the trailing-newline blank
  assert.equal(p.lines[0].kind, 'rule');
  assert.deepEqual(p.lines[0].buckets, ['!global']);
});

// -- writeCerebrumFile ----------------------------------------------------

test('writeCerebrumFile: writes atomically + creates parent dir', async (t) => {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'sub', 'cerebrum.md');
  const parsed = parseCerebrum('- 2026-05-10: [!global] body\n');
  await writeCerebrumFile(file, parsed);
  const back = await fs.readFile(file, 'utf8');
  assert.equal(back, '- 2026-05-10: [!global] body\n');
});

test('writeCerebrumFile: cleans up tmp on rename failure', async (t) => {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  // Same trick as fileio test — target is a non-empty directory; rename
  // onto it fails on linux.
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'blocker'), 'x');
  await assert.rejects(() => writeCerebrumFile(target, { lines: [{ raw: 'x', kind: 'other' }] }));
  const leftover = (await fs.readdir(dir)).filter((n) => n.startsWith('target.tmp.'));
  assert.deepEqual(leftover, [], `expected no leftover tmp files, found: ${leftover.join(',')}`);
});

test('writeCerebrumFile: round-trip via fs preserves content byte-for-byte', async (t) => {
  const file = tmpFile(t);
  const text = [
    '# Rules',
    '',
    '- 2026-05-10: [node:src/x.ts] body 1',
    '- 2026-05-10: [!] [node:src/y.ts] body 2 (by: sess-abc) [match: /foo/i]',
    '',
  ].join('\n');
  const parsed = parseCerebrum(text);
  await writeCerebrumFile(file, parsed);
  const back = await fs.readFile(file, 'utf8');
  assert.equal(back, text);
});

// -- listMandatoryFor -----------------------------------------------------

test('listMandatoryFor: [!global] rule applies to any path', () => {
  const text = '- 2026-05-10: [!] [!global] Always escape user input (by: sess-1)';
  const parsed = parseCerebrum(text);
  const rules = listMandatoryFor(parsed, 'src/anywhere.ts');
  assert.equal(rules.length, 1);
  assert.deepEqual([...rules[0].buckets].sort(), ['!', '!global']);
});

test('listMandatoryFor: [!] [node:path] requires exact path match', () => {
  const text = [
    '- 2026-05-10: [!] [node:src/auth/login.ts] Never log passwords (by: sess-1)',
  ].join('\n');
  const parsed = parseCerebrum(text);

  // Exact match returns it.
  assert.equal(listMandatoryFor(parsed, 'src/auth/login.ts').length, 1);
  // Different path: filtered out.
  assert.equal(listMandatoryFor(parsed, 'src/auth/signup.ts').length, 0);
  // Substring match must NOT count (Phase 2: exact only).
  assert.equal(listMandatoryFor(parsed, 'src/auth/login').length, 0);
  assert.equal(listMandatoryFor(parsed, 'login.ts').length, 0);
});

test('listMandatoryFor: a bare [node:F] rule (no [!]) fires by scope alone (cerebrum-v2 T5.6)', () => {
  // T5.6: node: is the deterministic tier — it fires by scope, not importance.
  const text = '- 2026-05-10: [node:src/x.ts] just a regular rule';
  const parsed = parseCerebrum(text);
  assert.equal(listMandatoryFor(parsed, 'src/x.ts').length, 1);
  // …but only for its own file.
  assert.equal(listMandatoryFor(parsed, 'src/y.ts').length, 0);
});

test('listMandatoryFor: a [provisional][node:F] rule stays in the queue (NOT deterministic)', () => {
  // T5.6 blocker guard: dropping the [!] gate must NOT promote provisional
  // captures (the auto-tagger stamps [provisional]) to priority-1.
  const text = '- 2026-05-10: [provisional] [node:src/x.ts] unreviewed capture';
  const parsed = parseCerebrum(text);
  assert.equal(listMandatoryFor(parsed, 'src/x.ts').length, 0);
});

test('listMandatoryFor: handles empty/missing parsed gracefully', () => {
  assert.deepEqual(listMandatoryFor(null, 'src/x.ts'), []);
  assert.deepEqual(listMandatoryFor({}, 'src/x.ts'), []);
  assert.deepEqual(listMandatoryFor({ lines: [] }, 'src/x.ts'), []);
});

// -- listReviewQueue ------------------------------------------------------

test('listReviewQueue: surfaces [!review] and [ai-provisional]', () => {
  const text = [
    '- 2026-05-10: [!review] needs scope review',
    '- 2026-05-10: [ai-provisional] [node:src/x.ts] agent suggestion',
    '- 2026-05-10: [node:src/y.ts] regular rule, not queued',
    '- 2026-05-10: [!] [!global] mandatory not queued (by: sess-1)',
  ].join('\n');
  const parsed = parseCerebrum(text);
  const q = listReviewQueue(parsed);
  assert.equal(q.length, 2);
  // Order preserved as in source.
  assert.ok(q[0].buckets.includes('!review'));
  assert.ok(q[1].buckets.includes('ai-provisional'));
});

test('listReviewQueue: returns [] for empty/missing input', () => {
  assert.deepEqual(listReviewQueue(null), []);
  assert.deepEqual(listReviewQueue({}), []);
  assert.deepEqual(listReviewQueue({ lines: [] }), []);
});

// -- behavioural smoke: write then read back ------------------------------

test('round-trip via file: parse → write → read → parse yields same buckets/body', async (t) => {
  const file = tmpFile(t);
  const text = [
    '- 2026-05-10: [!] [node:src/auth.ts] Never log raw passwords (by: sess-abc) [match: /password/i]',
    '- 2026-05-10: [ai-provisional] [node:src/date.ts] Prefer Temporal',
    '- 2026-05-10: [!global] Always run prettier',
  ].join('\n');
  await fs.writeFile(file, text, 'utf8');

  const first = await readCerebrumFile(file);
  await writeCerebrumFile(file, first);
  const second = await readCerebrumFile(file);

  assert.equal(first.lines.length, second.lines.length);
  for (let i = 0; i < first.lines.length; i++) {
    assert.deepEqual(second.lines[i].buckets, first.lines[i].buckets);
    assert.equal(second.lines[i].body, first.lines[i].body);
    assert.equal(second.lines[i].bySession, first.lines[i].bySession);
  }
});

// -- keyword scoring: parseKeywordBucket -------------------------------------

test('parseKeywordBucket: legacy list → all general, no override', () => {
  const r = parseKeywordBucket('WSL2, pwsh, env');
  assert.deepEqual(r.critical, []);
  assert.deepEqual(r.general, ['wsl2', 'pwsh', 'env']);
  assert.equal(r.minOverride, null);
});

test('parseKeywordBucket: * marks criticals; rest are general', () => {
  const r = parseKeywordBucket('*WSL2, *pwsh, env, port');
  assert.deepEqual(r.critical, ['wsl2', 'pwsh']);
  assert.deepEqual(r.general, ['env', 'port']);
  assert.equal(r.minOverride, null);
});

test('parseKeywordBucket: ;min=N override is parsed and stripped from the list', () => {
  const r = parseKeywordBucket('a, b, c ; min=3');
  assert.deepEqual(r.critical, []);
  assert.deepEqual(r.general, ['a', 'b', 'c']);
  assert.equal(r.minOverride, 3);
});

test('parseKeywordBucket: criticals-only leaves general empty', () => {
  const r = parseKeywordBucket('*only');
  assert.deepEqual(r.critical, ['only']);
  assert.deepEqual(r.general, []);
});

// (cerebrum-v2 T3.5) The v1 keyword scoring-engine tests — generalKeywordThreshold
// + listKeywordMatches (critical-*/general/legacy/;min) — were removed with the
// engine (anchor #8). v2 keyword retrieval is BM25 + the [!] exact-floor, covered
// by test/keyword-rules.test.mjs.
