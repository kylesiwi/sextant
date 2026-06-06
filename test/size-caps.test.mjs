// Tests for the two size-cap defences against unbounded inputs:
//
//   1. project.md SessionStart injection — cap by character count, with a
//      visible HTML-comment marker when truncation occurs.
//   2. graph build — per-file byte cap (skip oversized) and total file-count
//      cap (process only the first N candidates).
//
// All tests construct synthetic on-disk fixtures in os.tmpdir() and tear
// them down via t.after(). Env-var overrides are applied per-test with
// before/after restore so tests don't bleed configuration into each other.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { composeSessionStartBlock } from '../lib/hooks/composeSessionStart.mjs';
import { buildGraph } from '../lib/graph/build.mjs';
import { NODE, GRAPH } from '../lib/graph/schema.mjs';

// ---- fixture helpers -------------------------------------------------------

function freshTempDir(prefix = 'sextant-sizecaps-') {
  const p = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tempProject(t, prefix = 'sextant-sizecaps-') {
  const dir = freshTempDir(prefix);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

// Save / restore an env var inside a single test. We restore the exact
// prior state, including the "was undefined" case — setting to '' is NOT
// the same as deleting.
function withEnv(t, key, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  });
}

// ---- 1. project.md cap: oversize → truncated with marker ------------------

test('composeSessionStartBlock: oversized project.md is truncated with marker', (t) => {
  withEnv(t, 'SEXTANT_PROJECTMD_MAX_CHARS', '4000');
  const projectMd = 'A'.repeat(10000);
  const out = composeSessionStartBlock({
    projectMd,
    lastJson: null,
    graphStats: null,
    isStale: false,
    // Isolate the project.md truncation cap; the capture-steering footer is an
    // unrelated fixed-size section that would otherwise pad the total length.
    captureNudge: false,
    now: () => 0,
  });
  assert.ok(out, 'expected a non-null block when projectMd is present');
  assert.ok(out.includes('<!-- sextant:truncated'),
    `expected truncation marker; got:\n${out.slice(0, 200)}`);
  // The marker should mention the original size and the cap.
  assert.ok(out.includes('10000'),
    `expected marker to reference original 10000 chars`);
  assert.ok(out.includes('4000'),
    `expected marker to reference 4000-char cap`);
  // Per the strict-cap fix: the truncation marker is reserved INSIDE the
  // cap, so the emitted project.md section (content + marker) is bounded
  // by the cap. The block also includes section headers (a few lines)
  // separate from the project.md section. Total block length stays under
  // a small headroom of the cap.
  assert.ok(out.length < 4200,
    `expected truncated block under 4200 chars (cap + section header); got ${out.length}`);
  // The 'A's payload should be clipped to make room for the marker inside
  // the 4000-char cap. Marker length is ~75 chars, so we expect roughly
  // 3920-3930 A's — not exactly 4000, not anywhere near 10000.
  const aCount = (out.match(/A/g) || []).length;
  assert.ok(
    aCount > 0 && aCount <= 4000,
    `expected 1..4000 'A' chars (clipped to fit cap with marker); got ${aCount}`,
  );
  // Sanity bound: should NOT be way fewer than the cap minus marker length.
  assert.ok(
    aCount >= 3800,
    `expected at least 3800 'A' chars (cap minus marker); got ${aCount}`,
  );
});

// ---- 2. project.md cap: under threshold → no marker ----------------------

test('composeSessionStartBlock: under-cap project.md has no truncation marker', (t) => {
  withEnv(t, 'SEXTANT_PROJECTMD_MAX_CHARS', '4000');
  const projectMd = 'Z'.repeat(100);
  const out = composeSessionStartBlock({
    projectMd,
    lastJson: null,
    graphStats: null,
    isStale: false,
    now: () => 0,
  });
  assert.ok(out, 'expected a non-null block');
  assert.ok(!out.includes('<!-- sextant:truncated'),
    `expected no truncation marker; got:\n${out}`);
  // Full 100-char payload survives.
  assert.equal((out.match(/Z/g) || []).length, 100);
});

// ---- 3. project.md cap: default applies when env is unset ----------------

test('composeSessionStartBlock: default cap (4000) applies when env unset', (t) => {
  withEnv(t, 'SEXTANT_PROJECTMD_MAX_CHARS', undefined);
  const projectMd = 'B'.repeat(8000);
  const out = composeSessionStartBlock({
    projectMd,
    lastJson: null,
    graphStats: null,
    isStale: false,
    now: () => 0,
  });
  assert.ok(out.includes('<!-- sextant:truncated'),
    `expected truncation marker at default cap`);
  // 8000 in marker, 4000 cap in marker.
  assert.ok(out.includes('8000'));
  assert.ok(out.includes('4000'));
});

// ---- 4. graph per-file size cap: oversized .ts is skipped ----------------

test('buildGraph: per-file size cap skips oversized files', async (t) => {
  // Cap at 64KB for the test so we don't have to allocate 1MB. The huge
  // file is 128KB — clearly oversized by this cap.
  withEnv(t, 'SEXTANT_GRAPH_MAX_FILE_BYTES', String(64 * 1024));
  const root = tempProject(t);

  await write(path.join(root, 'small.ts'), 'export const SMALL = 1;\n');
  // Build a 128KB payload of valid TypeScript: a long comment + one export.
  // The size cap is enforced before parsing, so we don't strictly need it to
  // be valid, but valid-ish content keeps the test honest if cap is bypassed.
  const padding = 'x'.repeat(128 * 1024);
  await write(path.join(root, 'huge.ts'), `// ${padding}\nexport const HUGE = 1;\n`);

  const r = await buildGraph({ root, quiet: true });
  // Exactly one file makes it into the graph — the small one.
  assert.equal(r.files, 1, `expected exactly 1 file node; got ${r.files}`);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const paths = g[GRAPH.NODES].map((n) => n[NODE.PATH]);
  assert.deepEqual(paths, ['small.ts']);
  assert.ok(!paths.includes('huge.ts'), 'oversized huge.ts must be skipped');
});

// ---- 5. graph file-count cap: only the first N are processed -------------

test('buildGraph: file-count cap limits processed files to N', async (t) => {
  withEnv(t, 'SEXTANT_GRAPH_MAX_FILES', '2');
  const root = tempProject(t);

  // 5 tiny files. listSourceFiles sorts alphabetically; with names a..e the
  // first two (a.ts, b.ts) survive, the rest are dropped.
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
    await write(path.join(root, name), `export const X = "${name}";\n`);
  }

  const r = await buildGraph({ root, quiet: true });
  assert.equal(r.files, 2, `expected exactly 2 file nodes; got ${r.files}`);
  const g = JSON.parse(await fs.readFile(r.graphPath, 'utf8'));
  const paths = g[GRAPH.NODES].map((n) => n[NODE.PATH]).sort();
  assert.deepEqual(paths, ['a.ts', 'b.ts'],
    `expected the first 2 alphabetic files to survive; got ${JSON.stringify(paths)}`);
});

// ---- 6. graph build does not throw on either cap -------------------------

test('buildGraph: oversized + count caps degrade gracefully without throwing', async (t) => {
  // Both caps active simultaneously. The build should still complete and
  // return a valid graph stats payload.
  withEnv(t, 'SEXTANT_GRAPH_MAX_FILE_BYTES', String(64 * 1024));
  withEnv(t, 'SEXTANT_GRAPH_MAX_FILES', '3');
  const root = tempProject(t);

  // 5 small files + 1 huge file. The count cap trims to 3 in alphabetic
  // order (huge.ts comes after some smalls), the size cap then skips huge.ts
  // if it's in the surviving 3. Either way the build completes.
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
    await write(path.join(root, name), `export const X = "${name}";\n`);
  }
  await write(path.join(root, 'huge.ts'),
    `// ${'x'.repeat(128 * 1024)}\nexport const H = 1;\n`);

  // Should not throw.
  const r = await buildGraph({ root, quiet: true });
  // Count cap of 3 means at most 3 files in the graph.
  assert.ok(r.files <= 3, `expected ≤ 3 files; got ${r.files}`);
  assert.ok(Array.isArray(r.warnings), 'warnings array is present');
});
