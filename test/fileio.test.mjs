// Tests for the atomic-JSON helpers.
//
// Source-of-truth lives in lib/io.mjs; lib/hooks/fileio.mjs is a thin
// re-export shim for legacy hook imports. This test file exercises BOTH
// import surfaces:
//   1. The behavioural tests below import from lib/hooks/fileio.mjs so we
//      keep the legacy module covered.
//   2. A small re-export contract test asserts that the two surfaces export
//      the *same* function references (no accidental wrapping that would
//      break sharing module state, etc.).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeJsonAtomic, readJson, readModifyJson } from '../lib/hooks/fileio.mjs';
import * as ioMod from '../lib/io.mjs';
import * as fileioMod from '../lib/hooks/fileio.mjs';

function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-fileio-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tmpFile(t) {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'data.json');
}

// -- writeJsonAtomic --------------------------------------------------------

test('writeJsonAtomic: creates parent dir + writes parseable JSON', async (t) => {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'sub', 'out.json');
  await writeJsonAtomic(file, { a: 1, b: 'x' });
  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { a: 1, b: 'x' });
});

test('writeJsonAtomic: overwrites existing file', async (t) => {
  const file = tmpFile(t);
  await writeJsonAtomic(file, { v: 1 });
  await writeJsonAtomic(file, { v: 2 });
  const raw = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), { v: 2 });
});

// -- readJson ---------------------------------------------------------------

test('readJson: returns null on ENOENT', async (t) => {
  const file = tmpFile(t);
  const v = await readJson(file);
  assert.equal(v, null);
});

test('readJson: parses normal JSON', async (t) => {
  const file = tmpFile(t);
  await writeJsonAtomic(file, { x: 7 });
  const v = await readJson(file);
  assert.deepEqual(v, { x: 7 });
});

test('readJson: returns null on malformed JSON', async (t) => {
  const file = tmpFile(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'not-json{{{', 'utf8');
  const v = await readJson(file);
  assert.equal(v, null);
});

// -- readModifyJson ---------------------------------------------------------

test('readModifyJson: ENOENT => mutator gets {}, result written', async (t) => {
  const file = tmpFile(t);
  let mutatorReceived;
  await readModifyJson(file, (o) => {
    mutatorReceived = { ...o };
    o.created = true;
  });
  assert.deepEqual(mutatorReceived, {});
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written, { created: true });
});

test('readModifyJson: existing file preserves untouched fields', async (t) => {
  const file = tmpFile(t);
  await writeJsonAtomic(file, { foo: 1 });
  await readModifyJson(file, (o) => {
    o.bar = 2;
  });
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written, { foo: 1, bar: 2 });
});

test('readModifyJson: mutator throw leaves original file untouched', async (t) => {
  const file = tmpFile(t);
  await writeJsonAtomic(file, { foo: 1 });
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(
    readModifyJson(file, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, before, 'file content must be unchanged after thrown mutator');
});

test('readModifyJson: async mutator is awaited', async (t) => {
  const file = tmpFile(t);
  await readModifyJson(file, async (o) => {
    await new Promise((r) => setTimeout(r, 5));
    o.async = 'ok';
  });
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written, { async: 'ok' });
});

test('readModifyJson: malformed JSON on disk treated as empty {}', async (t) => {
  const file = tmpFile(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'totally not json', 'utf8');
  await readModifyJson(file, (o) => {
    o.k = 'v';
  });
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written, { k: 'v' });
});

test('readModifyJson: array on disk is treated as empty {} (not an object we want to spread)', async (t) => {
  const file = tmpFile(t);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '[1,2,3]', 'utf8');
  await readModifyJson(file, (o) => {
    o.x = 1;
  });
  const written = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(written, { x: 1 });
});

// -- re-export contract -----------------------------------------------------
//
// lib/hooks/fileio.mjs is a re-export shim over lib/io.mjs. The shim MUST
// expose the same function identities so hook code and graph-builder code
// share one module state (closures over Set caches, etc., should they grow).

test('re-export contract: lib/hooks/fileio.mjs reexports identical functions from lib/io.mjs', () => {
  assert.equal(fileioMod.writeJsonAtomic, ioMod.writeJsonAtomic, 'writeJsonAtomic identity should match');
  assert.equal(fileioMod.readJson, ioMod.readJson, 'readJson identity should match');
  assert.equal(fileioMod.readModifyJson, ioMod.readModifyJson, 'readModifyJson identity should match');
});

test('re-export contract: lib/io.mjs functions behave end-to-end (smoke)', async (t) => {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'io-smoke.json');
  await ioMod.writeJsonAtomic(file, { hello: 'world' });
  assert.deepEqual(await ioMod.readJson(file), { hello: 'world' });
  await ioMod.readModifyJson(file, (o) => { o.added = true; });
  assert.deepEqual(await ioMod.readJson(file), { hello: 'world', added: true });
});

test('re-export contract: writeJsonAtomic cleans up tmp on rename failure', async (t) => {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Make the target a directory (not a file) — rename onto a non-empty dir
  // fails on linux. The catch path should unlink the .tmp.* file.
  const target = path.join(dir, 'target');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'blocker'), 'x');
  await assert.rejects(() => ioMod.writeJsonAtomic(target, { v: 1 }));
  // No leftover tmp files in `dir`.
  const entries = await fs.readdir(dir);
  const leftover = entries.filter((n) => n.startsWith('target.tmp.'));
  assert.deepEqual(leftover, [], `expected no leftover tmp files, found: ${leftover.join(',')}`);
});
