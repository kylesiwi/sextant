// test/sanitize.test.mjs — control-byte sanitizer + its wiring into the
// systemMessage sink. Guards against terminal-escape injection from
// attacker-controlled .sextant/ data (e.g. a bug error_message in bugs.json).
//
// Control bytes are constructed via String.fromCharCode so THIS file's source
// stays pure ASCII — embedding raw ESC/BEL here would be the same fragility the
// sanitizer exists to avoid.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stripControlBytes, cleanField } from '../lib/sanitize.mjs';
import { formatMessage } from '../lib/hooks/systemMessage.mjs';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
// A representative malicious payload: OSC 52 clipboard write wrapped in ESC/BEL.
const OSC52 = `${ESC}]52;c;bWFsaWNpb3Vz${BEL}`;

test('stripControlBytes removes ESC, BEL, and C1 bytes', () => {
  const out = stripControlBytes(`ok${OSC52}${C1_CSI} end`);
  assert.ok(!out.includes(ESC), 'ESC gone');
  assert.ok(!out.includes(BEL), 'BEL gone');
  assert.ok(!out.includes(C1_CSI), 'C1 CSI gone');
  assert.equal(out, 'ok]52;c;bWFsaWNpb3Vz end');
});

test('stripControlBytes is lossless for printable text + coerces non-strings', () => {
  assert.equal(stripControlBytes('regular text 123 ./a-b_c'), 'regular text 123 ./a-b_c');
  assert.equal(stripControlBytes(12345), '12345');
  assert.equal(stripControlBytes(null), 'null');
});

test('cleanField caps length', () => {
  assert.equal(cleanField('A'.repeat(500), 10).length, 10);
  assert.equal(cleanField('short', 10), 'short');
});

test('sanitizer source carries no raw control bytes (escaped construction only)', () => {
  // The sanitizer must not rely on raw control bytes baked into its source —
  // those are fragile and could be silently mangled by any tool that re-saves it.
  const src = fs.readFileSync(new URL('../lib/sanitize.mjs', import.meta.url), 'utf8');
  const hasRawControl = [...src].some((ch) => {
    const c = ch.charCodeAt(0);
    return c <= 0x08 || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
  });
  assert.ok(!hasRawControl, 'no raw control bytes in lib/sanitize.mjs source');
});

test('formatMessage strips terminal escapes from message text', () => {
  // text can carry repo-sourced content (e.g. a bug error_message from bugs.json).
  const out = formatMessage(`open bug: ${OSC52}boom`, { category: 'error' });
  assert.ok(!out.includes(ESC + ']'), 'injected OSC introducer (ESC ]) gone');
  assert.ok(!out.includes(BEL), 'injected BEL gone');
  assert.ok(out.includes('boom'), 'legitimate text preserved');
});

test('formatMessage collapses whitespace to a single line while stripping escapes', () => {
  // Whitespace-collapse must happen BEFORE control-byte strip so newlines/tabs
  // survive as separating spaces (regression guard for the ordering fix).
  const out = formatMessage('line1\n  line2\tline3', { category: 'info' });
  assert.match(out, /line1 line2 line3/);
});
