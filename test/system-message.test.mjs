// Tests for the shared systemMessage helper (lib/hooks/systemMessage.mjs) and
// its durable mode store (lib/config.mjs). Covers the guarded-merge safety
// contract (charter anchor 1), the off/quiet/verbose gate, one-shot suppression,
// multi-line composition, and color formatting.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { mergeSystemMessage, formatMessage, messageMode } from '../lib/hooks/systemMessage.mjs';
import { setOutputMode, readOutputMode } from '../lib/config.mjs';
import { withState, resetTurnAndSession } from '../lib/state.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function freshDir(prefix) {
  const p = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

// Isolated context: a temp cwd (durable .sextant/config.json) + a temp runtime
// base (state). SEXTANT_RUNTIME_BASE makes withState() ignore cwd and write
// under the temp dir. Top-level node:test cases run sequentially, so swapping
// the env var per test is safe; t.after restores it.
function ctx(t) {
  const cwd = freshDir('sextant-sysmsg-cwd');
  const runtime = freshDir('sextant-sysmsg-rt');
  const prevRt = process.env.SEXTANT_RUNTIME_BASE;
  process.env.SEXTANT_RUNTIME_BASE = runtime;
  t.after(async () => {
    if (prevRt === undefined) delete process.env.SEXTANT_RUNTIME_BASE;
    else process.env.SEXTANT_RUNTIME_BASE = prevRt;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(runtime, { recursive: true, force: true });
  });
  const sid = 'sid-' + crypto.randomUUID().slice(0, 8);
  return { cwd, sid, setMode: (m) => setOutputMode(cwd, m) };
}

// -- formatMessage ----------------------------------------------------------

test('formatMessage: leading newline, bright-white prefix, category color, reset', () => {
  const out = formatMessage('hello world', { category: 'error' });
  assert.ok(out.startsWith('\n'), 'leads with a newline');
  assert.ok(out.includes('\x1b[97msextant: \x1b[0m'), 'bright-white prefix then reset');
  assert.ok(out.includes('\x1b[33m'), 'yellow body for error category');
  assert.ok(out.endsWith('\x1b[0m'), 'resets at end');
  assert.equal(stripAnsi(out), '\nsextant: hello world', 'legible with escapes stripped');
});

test('formatMessage: each category maps to its color', () => {
  assert.ok(formatMessage('x', { category: 'rules' }).includes('\x1b[32m'), 'green');
  assert.ok(formatMessage('x', { category: 'info' }).includes('\x1b[34m'), 'blue');
  assert.ok(formatMessage('x', { category: 'transition' }).includes('\x1b[36m'), 'cyan');
  // unknown category falls back to info/blue
  assert.ok(formatMessage('x', { category: 'bogus' }).includes('\x1b[34m'), 'fallback blue');
});

test('formatMessage: collapses internal whitespace to one line', () => {
  const out = formatMessage('line1\n  line2\tline3', { category: 'info' });
  assert.equal(stripAnsi(out), '\nsextant: line1 line2 line3');
});

test('formatMessage: caps length and ellipsizes', () => {
  const out = formatMessage('x'.repeat(500), {});
  const body = stripAnsi(out).replace('\nsextant: ', '');
  assert.ok(body.length <= 300, 'capped to <=300');
  assert.ok(body.endsWith('…'));
});

test('formatMessage: empty / whitespace input -> empty string', () => {
  assert.equal(formatMessage('', {}), '');
  assert.equal(formatMessage('   \n\t ', {}), '');
});

// -- config store -----------------------------------------------------------

test('config: default mode is quiet; setOutputMode persists; invalid rejected', async (t) => {
  const { cwd } = ctx(t);
  assert.equal(await readOutputMode(cwd), 'quiet', 'default quiet when unset');
  await setOutputMode(cwd, 'verbose');
  assert.equal(await readOutputMode(cwd), 'verbose', 'persisted');
  await assert.rejects(() => setOutputMode(cwd, 'loud'), /invalid output mode/);
});

// -- mode gate --------------------------------------------------------------

test('off mode: no systemMessage, additionalContext untouched', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('off');
  const result = { hookSpecificOutput: { additionalContext: 'RULES' } };
  const out = await mergeSystemMessage(result, 'hi', { level: 'transition', sid, cwd });
  assert.equal(out.systemMessage, undefined, 'no message in off');
  assert.equal(out.hookSpecificOutput.additionalContext, 'RULES', 'additionalContext intact');
  assert.equal(out, result, 'same object returned unchanged');
});

test('quiet: routine suppressed, transition surfaces', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('quiet');
  const dropped = await mergeSystemMessage(null, 'routine line', { level: 'routine', sid, cwd });
  assert.equal(dropped, null, 'routine dropped under quiet (null result stays null)');
  const shown = await mergeSystemMessage(null, 'transition line', { level: 'transition', sid, cwd });
  assert.equal(stripAnsi(shown.systemMessage), '\nsextant: transition line');
});

test('verbose: routine surfaces', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('verbose');
  const r = await mergeSystemMessage(null, 'routine line', { level: 'routine', sid, cwd });
  assert.equal(stripAnsi(r.systemMessage), '\nsextant: routine line');
});

test('mode is read from config, not from any env var', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('verbose');
  const prev = process.env.SEXTANT_VERBOSE;
  delete process.env.SEXTANT_VERBOSE;
  try {
    assert.equal(await messageMode(cwd), 'verbose');
    const r = await mergeSystemMessage(null, 'routine', { level: 'routine', sid, cwd });
    assert.ok(r && r.systemMessage, 'routine surfaces purely because config=verbose');
  } finally {
    if (prev === undefined) delete process.env.SEXTANT_VERBOSE;
    else process.env.SEXTANT_VERBOSE = prev;
  }
});

// -- guarded-merge safety (anchor 1) ---------------------------------------

test('thrown producer: no message, additionalContext intact, never throws', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('verbose');
  const result = { hookSpecificOutput: { additionalContext: 'RULES' } };
  const out = await mergeSystemMessage(result, () => { throw new Error('boom'); }, { level: 'transition', sid, cwd });
  assert.equal(out.systemMessage, undefined);
  assert.equal(out.hookSpecificOutput.additionalContext, 'RULES');
  assert.equal(out, result);
});

test('non-string/number producer output is rejected, never crashes', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('verbose');
  for (const bad of [null, undefined, {}, [], true]) {
    const out = await mergeSystemMessage(null, () => bad, { level: 'transition', sid, cwd });
    assert.equal(out, null, `dropped for ${JSON.stringify(bad)}`);
  }
  const num = await mergeSystemMessage(null, () => 42, { level: 'transition', sid, cwd });
  assert.equal(stripAnsi(num.systemMessage), '\nsextant: 42', 'number coerced');
});

// -- suppression ------------------------------------------------------------

test('suppression key: one-shot under quiet, bypassed under verbose', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('quiet');
  const opts = { level: 'transition', key: 'k1', scope: 'session', sid, cwd };
  const r1 = await mergeSystemMessage(null, 'once', opts);
  assert.ok(r1 && r1.systemMessage, 'first fires');
  const r2 = await mergeSystemMessage(null, 'twice', opts);
  assert.equal(r2, null, 'second suppressed (same key, quiet)');
  await setMode('verbose');
  const r3 = await mergeSystemMessage(null, 'thrice', opts);
  assert.ok(r3 && r3.systemMessage, 'verbose bypasses one-shot suppression');
});

test('suppression scope: turn re-arms after Stop, session survives', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('quiet');
  const turnOpts = { level: 'transition', key: 'k', scope: 'turn', sid, cwd };
  const sessOpts = { level: 'transition', key: 'k', scope: 'session', sid, cwd };
  // First fire: both surface (independent maps, same key name).
  assert.ok((await mergeSystemMessage(null, 'a', turnOpts))?.systemMessage, 'turn fires');
  assert.ok((await mergeSystemMessage(null, 'b', sessOpts))?.systemMessage, 'session fires');
  // Immediate repeat: both suppressed.
  assert.equal(await mergeSystemMessage(null, 'a2', turnOpts), null, 'turn suppressed same turn');
  assert.equal(await mergeSystemMessage(null, 'b2', sessOpts), null, 'session suppressed');
  // Simulate a Stop — resetTurnAndSession clears the turn map only.
  await withState(sid, cwd, resetTurnAndSession);
  assert.ok((await mergeSystemMessage(null, 'a3', turnOpts))?.systemMessage, 'turn re-arms after Stop');
  assert.equal(await mergeSystemMessage(null, 'b3', sessOpts), null, 'session still suppressed after Stop');
});

// -- multi-line composition -------------------------------------------------

test('multi-line: repeated merges compose newline-joined under one result', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('quiet');
  let r = { hookSpecificOutput: { additionalContext: 'RULES' } };
  r = await mergeSystemMessage(r, 'first', { level: 'transition', category: 'rules', sid, cwd });
  r = await mergeSystemMessage(r, 'second', { level: 'transition', category: 'transition', sid, cwd });
  assert.equal(stripAnsi(r.systemMessage), '\nsextant: first\nsextant: second');
  assert.equal(r.hookSpecificOutput.additionalContext, 'RULES', 'additionalContext preserved across composition');
});

test('string line (non-producer) works', async (t) => {
  const { cwd, sid, setMode } = ctx(t);
  await setMode('quiet');
  const r = await mergeSystemMessage(null, 'plain string', { level: 'transition', sid, cwd });
  assert.equal(stripAnsi(r.systemMessage), '\nsextant: plain string');
});
