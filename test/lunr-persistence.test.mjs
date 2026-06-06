// Tests for the on-disk persistence layer in lib/retrieval/lunr-index.mjs.
// Spec § 6.1 requires Lunr indexes to be cached at:
//   <durableBase>/lunr/cerebrum.idx
//   <durableBase>/lunr/bugs.idx
//
// These tests cover the L2 cache specifically — L1 (in-memory) behaviour is
// already covered in test/lunr-index.test.mjs. The two suites are kept
// separate so a regression on persistence doesn't muddy the older invariants.
//
// Coverage targets:
//   - First load builds + persists the on-disk envelope.
//   - Second load (with L1 cleared, e.g. fresh process) reads from disk
//     without re-parsing the source.
//   - Source mtime change invalidates the disk cache → rebuild happens.
//   - Source size mismatch invalidates the disk cache → rebuild happens.
//   - Corrupt JSON on disk falls through to a rebuild and overwrites.
//   - Old envelope version (version: 0) is silently rejected and rebuilt.
//   - Disk write failure (parent dir read-only) doesn't crash; in-memory
//     index is still returned.
//   - Bugs index follows the same pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  loadCerebrumIndex,
  loadBugsIndex,
  search,
  _resetCacheForTests,
} from '../lib/retrieval/lunr-index.mjs';

// --- helpers ---------------------------------------------------------------

// Each test gets its own tmpdir under os.tmpdir(). We never share roots
// between tests so the module-level _cerebrumCache / _bugsCache (keyed by
// absolute path) can't collide across cases; combined with _resetCacheForTests
// at the start of each test, that gives a clean L1 too.
function freshTempDir() {
  const p = path.join(os.tmpdir(), 'sextant-lunr-persist-' + crypto.randomUUID());
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function tmpRoot(t) {
  const dir = freshTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeCerebrumSource(root, body) {
  const dir = path.join(root, 'cerebrum');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'regular.md');
  await fs.writeFile(file, body, 'utf8');
  return file;
}

async function writeBugsSource(root, bugs) {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'bugs.json');
  await fs.writeFile(file, JSON.stringify(bugs), 'utf8');
  return file;
}

function cerebrumIdxPath(root) {
  return path.join(root, 'lunr', 'cerebrum.idx');
}

function bugsIdxPath(root) {
  return path.join(root, 'lunr', 'bugs.idx');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Bump a file's mtime explicitly. Test runners can be fast enough to land on
// the same mtimeMs as the prior write, so we offset by 2s to make stat see
// a fresh value deterministically.
async function bumpMtime(file, deltaMs = 2000) {
  const future = new Date(Date.now() + deltaMs);
  await fs.utimes(file, future, future);
}

// --- First load builds + persists -----------------------------------------

test('cerebrum: first load builds the on-disk envelope at <durableBase>/lunr/cerebrum.idx', async (t) => {
  const root = tmpRoot(t);
  await writeCerebrumSource(root,
    '- 2026-05-10: [!global] validateToken needs a boolean check\n',
  );
  _resetCacheForTests();

  const idxPath = cerebrumIdxPath(root);
  assert.equal(await exists(idxPath), false, 'precondition: no on-disk index yet');

  const { index, docs } = await loadCerebrumIndex(root);
  // The in-memory index is queryable.
  const hits = search(index, docs, 'validateToken', 5, 0);
  assert.ok(hits.length >= 1);
  // And the on-disk envelope has been written.
  assert.equal(await exists(idxPath), true, 'expected on-disk index after first load');
});

test('bugs: first load builds the on-disk envelope at <durableBase>/lunr/bugs.idx', async (t) => {
  const root = tmpRoot(t);
  await writeBugsSource(root, [
    {
      id: 'bug-1',
      file: 'src/api.ts',
      graph_node: 'validateToken',
      error_message: 'TypeError: validateToken returned undefined',
      root_cause: 'r',
      fix: 'f',
      tags: ['null'],
    },
  ]);
  _resetCacheForTests();

  const idxPath = bugsIdxPath(root);
  assert.equal(await exists(idxPath), false);

  const { index, docs } = await loadBugsIndex(root);
  assert.equal(docs.size, 1);
  const hits = search(index, docs, 'validateToken', 5, 0);
  assert.equal(hits[0].id, 'bug-1');
  assert.equal(await exists(idxPath), true, 'expected on-disk bugs index after first load');
});

// --- Second load uses disk (simulating a fresh process) ------------------

test('cerebrum: a second load with L1 cleared hydrates from the on-disk envelope', async (t) => {
  const root = tmpRoot(t);
  await writeCerebrumSource(root,
    '- 2026-05-10: [!global] refreshToken must await response.json\n'
    + '- 2026-05-10: [node:src/api.ts] always send Content-Type\n',
  );
  _resetCacheForTests();

  // First load builds + persists.
  const a = await loadCerebrumIndex(root);
  const aDocsCount = a.docs.size;
  assert.equal(aDocsCount, 2);

  // Wipe L1 to simulate a fresh process. L2 stays on disk.
  _resetCacheForTests();
  assert.equal(await exists(cerebrumIdxPath(root)), true);

  // Second load: L1 miss → L2 hit → hydrate. We can't directly observe
  // "no rebuild happened" without monkey-patching, but we CAN verify:
  //   (1) the result is functionally identical (same doc count, same hits).
  //   (2) the disk envelope was NOT rewritten — its mtime stays put.
  const beforeMtime = (await fs.stat(cerebrumIdxPath(root))).mtimeMs;
  // Sleep just enough so a hypothetical rewrite would advance mtime above
  // the FS resolution floor. 30ms is comfortably above ext4's 1ms tick.
  await new Promise((r) => setTimeout(r, 30));
  const b = await loadCerebrumIndex(root);
  const afterMtime = (await fs.stat(cerebrumIdxPath(root))).mtimeMs;

  assert.equal(b.docs.size, aDocsCount, 'doc count survives the round-trip');
  const hits = search(b.index, b.docs, 'refreshToken', 5, 0);
  assert.ok(hits.length >= 1);
  assert.equal(afterMtime, beforeMtime, 'L2-hit path must not rewrite the on-disk envelope');
});

test('bugs: a second load with L1 cleared hydrates from the on-disk envelope', async (t) => {
  const root = tmpRoot(t);
  await writeBugsSource(root, [
    {
      id: 'bug-1',
      file: 'src/api.ts',
      graph_node: 'validateToken',
      error_message: 'TypeError: validateToken returned undefined',
      root_cause: 'response was null',
      fix: 'optional chaining',
      tags: ['null'],
    },
    {
      id: 'bug-2',
      file: 'src/api.ts',
      graph_node: 'refreshToken',
      error_message: 'ECONNRESET',
      root_cause: 'upstream flake',
      fix: 'retry',
      tags: ['network'],
    },
  ]);
  _resetCacheForTests();

  const a = await loadBugsIndex(root);
  assert.equal(a.docs.size, 2);

  _resetCacheForTests();
  const beforeMtime = (await fs.stat(bugsIdxPath(root))).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  const b = await loadBugsIndex(root);
  const afterMtime = (await fs.stat(bugsIdxPath(root))).mtimeMs;

  assert.equal(b.docs.size, 2);
  const hits = search(b.index, b.docs, 'validateToken', 5, 0);
  assert.equal(hits[0].id, 'bug-1');
  assert.equal(afterMtime, beforeMtime, 'L2-hit path must not rewrite the on-disk envelope');
});

// --- Source mtime change invalidates the disk cache ----------------------

test('cerebrum: source mtime change invalidates the on-disk envelope (rebuild)', async (t) => {
  const root = tmpRoot(t);
  const sourceFile = await writeCerebrumSource(root,
    '- 2026-05-10: [!global] first rule body\n',
  );
  _resetCacheForTests();

  const a = await loadCerebrumIndex(root);
  assert.equal(a.docs.size, 1);

  // Append a rule AND bump the mtime so stat sees fresh data.
  await fs.writeFile(sourceFile,
    '- 2026-05-10: [!global] first rule body\n'
    + '- 2026-05-10: [!global] second rule appears now\n',
    'utf8',
  );
  await bumpMtime(sourceFile);

  // Clear L1 to make sure we go through the full cache cascade. L2 still
  // has the OLD envelope from `a`; the source mtime mismatch should reject
  // it and force a rebuild.
  _resetCacheForTests();
  const b = await loadCerebrumIndex(root);

  assert.equal(b.docs.size, 2, 'rebuild must reflect the new rule');
  const hits = search(b.index, b.docs, 'second', 5, 0);
  assert.ok(hits.length >= 1);

  // The on-disk envelope must now reflect the new source.
  const envelope = JSON.parse(await fs.readFile(cerebrumIdxPath(root), 'utf8'));
  const newSourceStat = await fs.stat(sourceFile);
  assert.equal(envelope.source_mtime_ms, newSourceStat.mtimeMs);
  assert.equal(envelope.source_size, newSourceStat.size);
});

// --- Source size mismatch invalidates the disk cache ---------------------

test('cerebrum: source size mismatch (with same mtime) forces rebuild', async (t) => {
  const root = tmpRoot(t);
  const sourceFile = await writeCerebrumSource(root,
    '- 2026-05-10: [!global] alpha body\n',
  );
  _resetCacheForTests();

  // First load: persist the envelope.
  const a = await loadCerebrumIndex(root);
  assert.equal(a.docs.size, 1);

  // Stat the source so we can pin the mtime exactly.
  const originalStat = await fs.stat(sourceFile);
  const pinnedTime = new Date(originalStat.mtimeMs);

  // Overwrite the on-disk envelope with a tampered source_size (e.g. 999)
  // so the stat-vs-envelope size comparison fails even though mtime matches.
  // This is a clean, deterministic way to test the size-check branch.
  const envelopeRaw = await fs.readFile(cerebrumIdxPath(root), 'utf8');
  const envelope = JSON.parse(envelopeRaw);
  envelope.source_size = envelope.source_size + 1;
  await fs.writeFile(cerebrumIdxPath(root), JSON.stringify(envelope), 'utf8');

  // Re-pin the source mtime so it matches the (still correct) envelope mtime.
  await fs.utimes(sourceFile, pinnedTime, pinnedTime);

  // Clear L1 so the load goes through the L2 check, which should reject
  // due to size mismatch and rebuild.
  _resetCacheForTests();
  const b = await loadCerebrumIndex(root);

  // Functional check: still indexes the source.
  assert.equal(b.docs.size, 1);
  // The disk envelope must have been refreshed back to the true size.
  const refreshed = JSON.parse(await fs.readFile(cerebrumIdxPath(root), 'utf8'));
  assert.equal(refreshed.source_size, originalStat.size,
    'envelope size must be restored to the actual source size after rebuild');
});

// --- Corrupt on-disk JSON falls through to rebuild + overwrites ----------

test('cerebrum: corrupt on-disk envelope is rebuilt and overwritten', async (t) => {
  const root = tmpRoot(t);
  await writeCerebrumSource(root,
    '- 2026-05-10: [!global] rule body for corrupt test\n',
  );
  // Pre-create the lunr dir and a garbage envelope so the loader sees it.
  await fs.mkdir(path.join(root, 'lunr'), { recursive: true });
  await fs.writeFile(cerebrumIdxPath(root), '{not valid json at all', 'utf8');
  _resetCacheForTests();

  const { index, docs } = await loadCerebrumIndex(root);
  // The corrupt envelope didn't crash; we built from source.
  assert.equal(docs.size, 1);
  const hits = search(index, docs, 'corrupt', 5, 0);
  assert.ok(hits.length >= 1);

  // The envelope on disk is now valid JSON that parses cleanly.
  const raw = await fs.readFile(cerebrumIdxPath(root), 'utf8');
  const env = JSON.parse(raw);
  assert.equal(env.version, 2); // INDEX_VERSION bumped to 2 in cerebrum-v2 T3 (keywords field)
  assert.equal(typeof env.source_mtime_ms, 'number');
  assert.equal(typeof env.source_size, 'number');
});

// --- Old envelope version is rejected ------------------------------------

test('cerebrum: envelope with stale version is invalidated and rebuilt', async (t) => {
  const root = tmpRoot(t);
  const sourceFile = await writeCerebrumSource(root,
    '- 2026-05-10: [!global] version-bump rule\n',
  );
  await fs.mkdir(path.join(root, 'lunr'), { recursive: true });

  // Hand-craft an old-version envelope so the loader can find it.
  const stat = await fs.stat(sourceFile);
  const oldEnvelope = {
    version: 0,                  // older than current INDEX_VERSION (1)
    source_mtime_ms: stat.mtimeMs,
    source_size: stat.size,
    index: { dummy: true },      // contents irrelevant — version check fails first
    docs: {},
  };
  await fs.writeFile(cerebrumIdxPath(root), JSON.stringify(oldEnvelope), 'utf8');
  _resetCacheForTests();

  const { index, docs } = await loadCerebrumIndex(root);
  // Rebuild produced a real, queryable index.
  assert.equal(docs.size, 1);
  const hits = search(index, docs, 'version-bump', 5, 0);
  assert.ok(hits.length >= 1);

  // The on-disk envelope was overwritten with the current version.
  const refreshed = JSON.parse(await fs.readFile(cerebrumIdxPath(root), 'utf8'));
  assert.equal(refreshed.version, 2); // INDEX_VERSION bumped to 2 in cerebrum-v2 T3
});

// --- Disk write failure does not crash the load -------------------------

test('cerebrum: disk-write failure does not throw; in-memory index still returned', async (t) => {
  // On Linux/POSIX we can chmod -w the parent dir to force EACCES on the
  // tmp + rename inside writeOnDiskIndex. The loader catches this and
  // logs to stderr — the user gets the in-memory index unscathed.
  if (process.platform === 'win32') {
    t.skip('chmod-based denial of write is unreliable on Windows');
    return;
  }
  // Skip if we're running as root — chmod has no effect.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('chmod-based denial of write has no effect when running as root');
    return;
  }

  const root = tmpRoot(t);
  await writeCerebrumSource(root,
    '- 2026-05-10: [!global] readonly-fs rule\n',
  );
  // Pre-create the lunr dir and strip write permission so the tmp file
  // can't be created. mkdir({recursive}) inside writeOnDiskIndex is a
  // no-op on an existing dir, so chmod sticks.
  const lunrDir = path.join(root, 'lunr');
  await fs.mkdir(lunrDir, { recursive: true });
  await fs.chmod(lunrDir, 0o500); // r-x only

  // Make sure we restore perms so t.after's fs.rm can clean up.
  t.after(async () => {
    try { await fs.chmod(lunrDir, 0o700); } catch {}
  });

  _resetCacheForTests();

  // Capture stderr writes so the test output stays clean while still
  // letting us assert the warning fired.
  const captured = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  let result;
  try {
    result = await loadCerebrumIndex(root);
  } finally {
    process.stderr.write = origWrite;
  }

  // In-memory index works fine.
  assert.equal(result.docs.size, 1);
  const hits = search(result.index, result.docs, 'readonly-fs', 5, 0);
  assert.ok(hits.length >= 1);
  // Stderr saw our warning.
  const joined = captured.join('');
  assert.match(joined, /lunr-index write failed/i,
    `expected stderr to mention lunr-index write failure; got:\n${joined}`);
});

// --- Missing source file: no envelope is created -------------------------

test('cerebrum: a missing source file does not create an on-disk envelope', async (t) => {
  const root = tmpRoot(t);
  // No cerebrum/regular.md written.
  _resetCacheForTests();
  const { docs } = await loadCerebrumIndex(root);
  assert.equal(docs.size, 0);
  // We MUST NOT write a stub envelope — the source is missing entirely.
  assert.equal(await exists(cerebrumIdxPath(root)), false);
});
