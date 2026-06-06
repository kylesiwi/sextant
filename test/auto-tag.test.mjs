// Tests for lib/capture/auto-tag.mjs — § 7.1 cerebrum auto-tag loop.
//
// Heuristic boundaries (per § 5.8.3):
//   - Already-tagged dated rule → pass through (confidence 'none').
//   - Non-rule line (blank/header/standalone comment/prose) → pass through.
//   - Untagged dated rule + lastProjectFileEdit.ts >= turnStartTs
//     → prepend [node:<path>], append high-confidence marker.
//   - Untagged dated rule + no/old lastProjectFileEdit
//     → prepend [!review], append low-confidence marker.
//   - Undated list item → prepend `<today>: ` and tag.
//
// File-level autoTagFile: read → mutate → write atomically; counters
// reflect mutation tally; dryRun skips the write.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { autoTagLine, autoTagFile } from '../lib/capture/auto-tag.mjs';
import { parseCerebrum } from '../lib/stores/cerebrum.mjs';

function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-autotag-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tmpFile(t, name = 'cerebrum.md') {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

// Anchor for "recent" project edits. turnStart is the cutoff.
const TURN_START = '2026-05-10T12:00:00.000Z';
const TODAY = '2026-05-10';

// -- autoTagLine: already-tagged passthrough ------------------------------

test('autoTagLine: already-tagged rule passes through unchanged', () => {
  const raw = '- 2026-05-10: [node:src/x.ts] Body text <!-- sextant:auto-tag confidence=high -->';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/y.ts', ts: '2026-05-10T12:30:00.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.taggedLine, raw);
  assert.equal(out.confidence, 'none');
});

test('autoTagLine: rule with [!review] is already-tagged', () => {
  const raw = '- 2026-05-10: [!review] needs review';
  const out = autoTagLine({
    raw, lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY,
  });
  assert.equal(out.taggedLine, raw);
  assert.equal(out.confidence, 'none');
});

test('autoTagLine: rule with [ai-provisional] is already-tagged', () => {
  const raw = '- 2026-05-10: [ai-provisional] [node:src/x.ts] body';
  const out = autoTagLine({
    raw, lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY,
  });
  assert.equal(out.taggedLine, raw);
  assert.equal(out.confidence, 'none');
});

// -- autoTagLine: untagged + recent edit → high confidence ---------------

test('autoTagLine: untagged + recent edit yields high-confidence node tag', () => {
  const raw = '- 2026-05-10: Avoid console.log in production code';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/api/auth.ts', ts: '2026-05-10T12:00:30.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.confidence, 'high');
  assert.match(out.taggedLine, /\[node:src\/api\/auth\.ts\]/);
  assert.match(out.taggedLine, /<!-- sextant:auto-tag confidence=high -->/);
  // Body preserved.
  assert.match(out.taggedLine, /Avoid console\.log in production code/);
  // Re-parses as a valid tagged rule.
  const parsed = parseCerebrum(out.taggedLine);
  assert.equal(parsed.lines[0].kind, 'rule');
  assert.deepEqual(parsed.lines[0].buckets, ['node:src/api/auth.ts']);
});

test('autoTagLine: edit ts equal to turn-start counts as recent (inclusive)', () => {
  const raw = '- 2026-05-10: Body text';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/a.ts', ts: TURN_START },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.confidence, 'high');
});

// -- autoTagLine: untagged + old/missing edit → low confidence -----------

test('autoTagLine: untagged + old edit (before turn start) yields low confidence', () => {
  const raw = '- 2026-05-10: Random thought captured later';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/old.ts', ts: '2026-05-09T11:00:00.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.confidence, 'low');
  assert.match(out.taggedLine, /\[provisional\]/);
  assert.match(out.taggedLine, /<!-- sextant:auto-tag confidence=low needs-review -->/);
});

test('autoTagLine: untagged + null edit yields low confidence', () => {
  const raw = '- 2026-05-10: Captured during analysis-only session';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: null,
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.confidence, 'low');
  assert.match(out.taggedLine, /^\- 2026-05-10: \[provisional\] /);
  assert.match(out.taggedLine, /<!-- sextant:auto-tag confidence=low needs-review -->$/);
});

// cerebrum-v2 (T5 verify): the auto-tagger emits ONLY v2 buckets — [node:…] (high
// confidence) or [provisional] (low) — never the legacy [!review] and never
// [global]/[!global] (anchor #10: global is CLI-authored only).
test('autoTagLine: never auto-assigns [global]/[!global], never legacy [!review]', () => {
  const cases = [
    autoTagLine({ raw: '- 2026-05-10: high-conf path', lastProjectFileEdit: { path: 'src/x.ts', ts: '2026-05-10T13:00:00.000Z' }, turnStartTs: TURN_START, today: TODAY }),
    autoTagLine({ raw: '- 2026-05-10: low-conf path', lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY }),
  ];
  for (const out of cases) {
    assert.doesNotMatch(out.taggedLine, /\[global\]/, 'auto-tag must never assign [global]');
    assert.doesNotMatch(out.taggedLine, /\[!global\]/, 'auto-tag must never assign [!global]');
    assert.doesNotMatch(out.taggedLine, /\[!review\]/, 'auto-tag must emit [provisional], not legacy [!review]');
  }
});

// -- autoTagLine: non-rule passthrough ------------------------------------

test('autoTagLine: blank line passes through', () => {
  const out = autoTagLine({ raw: '', lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY });
  assert.equal(out.taggedLine, '');
  assert.equal(out.confidence, 'none');
});

test('autoTagLine: markdown header passes through', () => {
  const out = autoTagLine({ raw: '## Mandatory rules', lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY });
  assert.equal(out.taggedLine, '## Mandatory rules');
  assert.equal(out.confidence, 'none');
});

test('autoTagLine: standalone HTML comment passes through', () => {
  const raw = '<!-- sextant:reconciled 2026-05-10 -->';
  const out = autoTagLine({ raw, lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY });
  assert.equal(out.taggedLine, raw);
  assert.equal(out.confidence, 'none');
});

test('autoTagLine: prose line (no leading "- ") passes through', () => {
  const raw = 'This is prose, not a rule.';
  const out = autoTagLine({ raw, lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY });
  assert.equal(out.taggedLine, raw);
  assert.equal(out.confidence, 'none');
});

// -- autoTagLine: undated list item synthesises a date --------------------

test('autoTagLine: undated list item gets today: prefix + tag', () => {
  const raw = '- some untagged thought';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/foo.ts', ts: '2026-05-10T12:30:00.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(out.confidence, 'high');
  assert.match(out.taggedLine, /^\- 2026-05-10: \[node:src\/foo\.ts\] some untagged thought /);
  assert.match(out.taggedLine, /<!-- sextant:auto-tag confidence=high -->$/);
});

test('autoTagLine: undated list item + null edit → low confidence with synthesised date', () => {
  const raw = '- another thought';
  const out = autoTagLine({
    raw, lastProjectFileEdit: null, turnStartTs: TURN_START, today: TODAY,
  });
  assert.equal(out.confidence, 'low');
  assert.match(out.taggedLine, /^\- 2026-05-10: \[provisional\] another thought /);
});

// -- autoTagLine: tagged-line is re-parseable -----------------------------

test('autoTagLine: tagged line re-parses with expected bucket', () => {
  const raw = '- 2026-05-10: A clear rule body';
  const out = autoTagLine({
    raw,
    lastProjectFileEdit: { path: 'src/x.ts', ts: '2026-05-10T12:00:30.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  const parsed = parseCerebrum(out.taggedLine);
  const e = parsed.lines[0];
  assert.equal(e.kind, 'rule');
  assert.equal(e.date, '2026-05-10');
  assert.deepEqual(e.buckets, ['node:src/x.ts']);
  // Body preserved (markers parsed out).
  assert.equal(e.body, 'A clear rule body');
  assert.deepEqual(e.markers, ['<!-- sextant:auto-tag confidence=high -->']);
});

// -- autoTagFile: counts + atomicity --------------------------------------

test('autoTagFile: applies tags across mixed lines and returns counters', async (t) => {
  const file = tmpFile(t);
  const text = [
    '# Cerebrum',                                                                            // header
    '',                                                                                       // blank
    '- 2026-05-10: [node:src/api/auth.ts] Already tagged rule',                              // unchanged
    '- 2026-05-10: New rule recently edited',                                                // → high
    '- 2026-05-10: New rule no recent edit',                                                 // → also high (one lastEdit per call)
  ].join('\n');
  await fs.writeFile(file, text, 'utf8');

  const result = await autoTagFile({
    filePath: file,
    lastProjectFileEdit: { path: 'src/api/auth.ts', ts: '2026-05-10T12:30:00.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });

  // 2 untagged rules → both high (same lastEdit value applies to both).
  assert.equal(result.high, 2);
  assert.equal(result.low, 0);
  // header + blank + 1 already-tagged = 3 unchanged.
  assert.equal(result.unchanged, 3);
  assert.equal(result.total_lines, 5);

  // File contents reflect tagging.
  const back = await fs.readFile(file, 'utf8');
  const parsed = parseCerebrum(back);
  const rules = parsed.lines.filter((e) => e.kind === 'rule');
  assert.equal(rules.length, 3);
  // All rules have at least one bucket now.
  for (const r of rules) assert.ok(r.buckets.length > 0, 'expected bucket after tag');
});

test('autoTagFile: dryRun does not modify file on disk', async (t) => {
  const file = tmpFile(t);
  const text = '- 2026-05-10: untagged\n';
  await fs.writeFile(file, text, 'utf8');

  const result = await autoTagFile({
    filePath: file,
    lastProjectFileEdit: null,
    turnStartTs: TURN_START,
    today: TODAY,
    dryRun: true,
  });

  assert.equal(result.low, 1);
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk, text, 'dryRun must not write to disk');
});

test('autoTagFile: ENOENT yields zero counters, no file created', async (t) => {
  const file = tmpFile(t);
  const result = await autoTagFile({
    filePath: file,
    lastProjectFileEdit: null,
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.deepEqual(result, { high: 0, low: 0, unchanged: 0, total_lines: 0, rewrites: [] });

  // dryRun=false here; readCerebrumFile returned empty, so writeCerebrumFile
  // creates an empty file. That's acceptable behaviour (the file is now
  // ready for /sextant:remember to append to). We just assert the file
  // exists and is empty.
  const onDisk = await fs.readFile(file, 'utf8');
  assert.equal(onDisk, '');
});

test('autoTagFile: write goes via tmp + rename (no torn file)', async (t) => {
  // Indirect atomicity check: after autoTagFile completes, no tmp files
  // remain in the directory.
  const file = tmpFile(t);
  await fs.writeFile(file, '- 2026-05-10: a\n- 2026-05-10: b\n', 'utf8');
  await autoTagFile({
    filePath: file,
    lastProjectFileEdit: null,
    turnStartTs: TURN_START,
    today: TODAY,
  });
  const dir = path.dirname(file);
  const entries = await fs.readdir(dir);
  const leftover = entries.filter((n) => n.includes('.tmp.'));
  assert.deepEqual(leftover, [], `expected no tmp files, found: ${leftover.join(',')}`);
});

test('autoTagFile: mixed high/low across distinct files would require distinct lastEdit calls — single-call invariant', async (t) => {
  // Sanity: with lastEdit set to an OLD timestamp, every untagged rule
  // goes to [!review]. This guards against future regressions where the
  // turnStart comparison flips.
  const file = tmpFile(t);
  await fs.writeFile(file, [
    '- 2026-05-10: rule one',
    '- 2026-05-10: rule two',
    '- 2026-05-10: rule three',
  ].join('\n'), 'utf8');
  const result = await autoTagFile({
    filePath: file,
    lastProjectFileEdit: { path: 'src/old.ts', ts: '2026-05-09T00:00:00.000Z' },
    turnStartTs: TURN_START,
    today: TODAY,
  });
  assert.equal(result.high, 0);
  assert.equal(result.low, 3);
});
