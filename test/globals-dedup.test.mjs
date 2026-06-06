// Tests for session-scoped [!global] mandatory rule dedup (v0.8.4).
//
// Covers: lib/hooks/mandatoryGlobals.mjs (unit), preToolUse Bash/Read paths
// (integration), clearPendingRestore digest wipe, and stats instrumentation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  partitionGlobals,
  digestGlobals,
  globalsDedupDisabled,
  shouldEmitFullGlobals,
  GLOBALS_DIGEST_FIELD,
} from '../lib/hooks/mandatoryGlobals.mjs';
import { clearPendingRestore } from '../lib/hooks/restore.mjs';
import preToolUse from '../lib/hooks/preToolUse.mjs';
import { withState } from '../lib/state.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';
import { readJson, writeJsonAtomic, readModifyJson } from '../lib/io.mjs';
import { durableBase, durableFile, runtimeBase, turnStatePath } from '../lib/paths.mjs';
import { statsPath } from '../lib/stores/stats.mjs';
import { _resetCacheForTests as _resetGraphCache } from '../lib/graph/read.mjs';

// ---------------------------------------------------------------------------
// Local helpers (mirrors hooks.test.mjs — kept inline for isolation)
// ---------------------------------------------------------------------------

function freshTempBase() {
  return path.join(os.tmpdir(), 'sextant-dedup-test-' + crypto.randomUUID());
}

function withEnv(t, overrides) {
  const before = {};
  for (const [k, v] of Object.entries(overrides)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function setupEnv(t) {
  const base = freshTempBase();
  withEnv(t, { SEXTANT_RUNTIME_BASE: base });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

function makeCtx(sid) {
  return {
    eventName: 'PreToolUse',
    runtimeBase,
    durableBase,
    log: (entry) => appendLog(sid, entry, null),
    nowIso: () => new Date().toISOString(),
  };
}

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

async function freshProjectCwd(t) {
  const cwd = path.join(os.tmpdir(), 'sextant-proj-' + crypto.randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

// ---------------------------------------------------------------------------
// Synthetic rule builder helpers
// ---------------------------------------------------------------------------

/** Build a [!global] rule object shaped like the mandatory parser output. */
function makeGlobalRule(body, rawOverride) {
  const raw = rawOverride ?? `- 2026-05-12: [!] [!global] ${body}`;
  return { raw, body, buckets: ['!', '!global'] };
}

/** Build a [node:] rule object. */
function makeNodeRule(nodePath, body) {
  const raw = `- 2026-05-12: [!] [node:${nodePath}] ${body}`;
  return { raw, body, buckets: ['!', `node:${nodePath}`] };
}

// ---------------------------------------------------------------------------
// (a) partitionGlobals: splits a mixed rule array correctly
// ---------------------------------------------------------------------------

test('partitionGlobals: splits mixed rules into globals and nonGlobals', () => {
  const g1 = makeGlobalRule('Always check sandbox rules.');
  const g2 = makeGlobalRule('Never write secrets to disk.');
  const n1 = makeNodeRule('src/a.ts', 'Keep exports minimal.');
  const n2 = { raw: '- 2026-05-12: [!] [kw:rm] Be careful.', body: 'Be careful.', buckets: ['!', 'kw:rm'] };

  const { globals, nonGlobals } = partitionGlobals([g1, n1, g2, n2]);

  assert.deepEqual(globals, [g1, g2]);
  assert.deepEqual(nonGlobals, [n1, n2]);
});

test('partitionGlobals: handles empty input', () => {
  const { globals, nonGlobals } = partitionGlobals([]);
  assert.deepEqual(globals, []);
  assert.deepEqual(nonGlobals, []);
});

test('partitionGlobals: handles non-array input gracefully', () => {
  const { globals, nonGlobals } = partitionGlobals(null);
  assert.deepEqual(globals, []);
  assert.deepEqual(nonGlobals, []);
});

// ---------------------------------------------------------------------------
// (b) digestGlobals: stable across rule order
// ---------------------------------------------------------------------------

test('digestGlobals: stable across rule order (same globals, different order → same digest)', () => {
  const r1 = makeGlobalRule('Rule alpha.');
  const r2 = makeGlobalRule('Rule beta.');

  const d1 = digestGlobals([r1, r2]);
  const d2 = digestGlobals([r2, r1]);

  assert.equal(typeof d1, 'string');
  assert.ok(d1.length > 0);
  assert.equal(d1, d2, 'digest must be order-independent');
});

// ---------------------------------------------------------------------------
// (c) digestGlobals: returns '' for empty / non-global arrays
// ---------------------------------------------------------------------------

test('digestGlobals: returns empty string for empty array', () => {
  assert.equal(digestGlobals([]), '');
});

test('digestGlobals: returns empty string when only non-global rules present', () => {
  const n1 = makeNodeRule('src/a.ts', 'Keep exports minimal.');
  assert.equal(digestGlobals([n1]), '');
});

test('digestGlobals: returns empty string for null/undefined input', () => {
  assert.equal(digestGlobals(null), '');
  assert.equal(digestGlobals(undefined), '');
});

// ---------------------------------------------------------------------------
// (d) shouldEmitFullGlobals
// ---------------------------------------------------------------------------

test('shouldEmitFullGlobals: returns true when turnState is null', () => {
  assert.equal(shouldEmitFullGlobals(null, 'abc123'), true);
});

test('shouldEmitFullGlobals: returns true when turnState is undefined', () => {
  assert.equal(shouldEmitFullGlobals(undefined, 'abc123'), true);
});

test('shouldEmitFullGlobals: returns true when digest field mismatches', () => {
  const ts = { [GLOBALS_DIGEST_FIELD]: 'old-digest' };
  assert.equal(shouldEmitFullGlobals(ts, 'new-digest'), true);
});

test('shouldEmitFullGlobals: returns false when digest matches', () => {
  const digest = 'abc123def456abcd';
  const ts = { [GLOBALS_DIGEST_FIELD]: digest };
  assert.equal(shouldEmitFullGlobals(ts, digest), false);
});

test('shouldEmitFullGlobals: returns true (vacuous) when currentDigest is empty', () => {
  // No globals to emit; shouldEmitFullGlobals is vacuously true.
  const ts = { [GLOBALS_DIGEST_FIELD]: '' };
  assert.equal(shouldEmitFullGlobals(ts, ''), true);
});

// ---------------------------------------------------------------------------
// (e) globalsDedupDisabled: responds to SEXTANT_GLOBALS_DEDUP env var
// ---------------------------------------------------------------------------

test('globalsDedupDisabled: returns true for "off"', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'off' });
  assert.equal(globalsDedupDisabled(), true);
});

test('globalsDedupDisabled: returns true for "0"', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: '0' });
  assert.equal(globalsDedupDisabled(), true);
});

test('globalsDedupDisabled: returns true for "false"', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'false' });
  assert.equal(globalsDedupDisabled(), true);
});

test('globalsDedupDisabled: returns true for "no"', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'no' });
  assert.equal(globalsDedupDisabled(), true);
});

test('globalsDedupDisabled: returns false when unset', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });
  assert.equal(globalsDedupDisabled(), false);
});

test('globalsDedupDisabled: returns false for "on"', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'on' });
  assert.equal(globalsDedupDisabled(), false);
});

test('globalsDedupDisabled: returns false for arbitrary value', (t) => {
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'yes-please' });
  assert.equal(globalsDedupDisabled(), false);
});

// ---------------------------------------------------------------------------
// (f) preToolUse Bash: first call emits full block + persists digest
// ---------------------------------------------------------------------------

test('preToolUse Bash: first call with [!global] rule emits block and persists digest', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined }); // ensure dedup is on

  const sid = 'dedup-bash-first-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Never overwrite production configs.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );

  // Must emit a block.
  assert.ok(result && result.hookSpecificOutput, `expected hookSpecificOutput; got ${JSON.stringify(result)}`);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes('<!-- sextant:bash-global-rules -->'), 'must have bash-global-rules marker');
  assert.ok(ctx.includes(globalBody), 'must include global rule body');

  // Digest must be persisted in turn-state.json.
  const ts = await readJson(turnStatePath(sid, cwd));
  assert.ok(ts && typeof ts[GLOBALS_DIGEST_FIELD] === 'string', 'turn-state should have digest field');
  assert.ok(ts[GLOBALS_DIGEST_FIELD].length > 0, 'digest must be non-empty');

  // The persisted digest should match what digestGlobals computes for the rule.
  const rule = makeGlobalRule(globalBody, rawLine);
  const expectedDigest = digestGlobals([rule]);
  assert.equal(ts[GLOBALS_DIGEST_FIELD], expectedDigest, 'persisted digest must match computed digest');
});

// ---------------------------------------------------------------------------
// (g) preToolUse Bash: second call with matching digest suppresses globals
// ---------------------------------------------------------------------------

test('preToolUse Bash: second call with matching digest returns undefined (globals suppressed)', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-bash-second-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Always use --dry-run first.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Pre-seed turn-state with the matching digest.
  const rule = makeGlobalRule(globalBody, rawLine);
  const digest = digestGlobals([rule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );

  assert.equal(result, undefined, 'second call with matching digest must return undefined (no block)');
});

// ---------------------------------------------------------------------------
// (h) preToolUse Bash: suppressed globals + kw match → kw rule only, correct marker
// ---------------------------------------------------------------------------

test('preToolUse Bash: suppressed globals + kw match → only kw rule emitted, correct marker', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-bash-kw-only-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Never commit .env files.';
  const kwBody = 'Be careful when deleting files.';
  const globalRaw = `- 2026-05-12: [!] [!global] ${globalBody}`;
  const kwRaw = `- 2026-05-12: [!] [kw:rm] ${kwBody}`;

  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    [globalRaw, kwRaw, ''].join('\n'),
  );

  // Pre-seed with matching digest so globals are suppressed.
  const globalRule = makeGlobalRule(globalBody, globalRaw);
  const digest = digestGlobals([globalRule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'rm -rf foo' } },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, 'expected a result for kw match');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes(kwBody), 'kw rule body must appear');
  assert.ok(!ctx.includes(globalBody), 'global rule body must NOT appear (suppressed)');
  // The bash path uses the bash-global-rules marker even when only kw rules are emitted.
  assert.ok(ctx.includes('<!-- sextant:bash-global-rules -->'), 'bash-global-rules marker must appear');
});

// ---------------------------------------------------------------------------
// (i) preToolUse Bash: mandatory.md edited mid-session → digest mismatch → re-emit
// ---------------------------------------------------------------------------

test('preToolUse Bash: digest mismatch after mandatory.md edit causes re-emit', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-bash-edit-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const body1 = 'First global rule.';
  const raw1 = `- 2026-05-12: [!] [!global] ${body1}`;

  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    raw1 + '\n',
  );

  // First call: emits + persists D1.
  const result1 = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );
  assert.ok(result1 && result1.hookSpecificOutput, 'first call must emit');
  const ts1 = await readJson(turnStatePath(sid, cwd));
  const d1 = ts1[GLOBALS_DIGEST_FIELD];
  assert.ok(d1 && d1.length > 0, 'D1 must be set');

  // Edit mandatory.md to add a second [!global] rule.
  const body2 = 'Second global rule added mid-session.';
  const raw2 = `- 2026-05-12: [!] [!global] ${body2}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    [raw1, raw2, ''].join('\n'),
  );

  // Verify D2 ≠ D1.
  const r1 = makeGlobalRule(body1, raw1);
  const r2 = makeGlobalRule(body2, raw2);
  const d2 = digestGlobals([r1, r2]);
  assert.notEqual(d2, d1, 'D2 must differ from D1');

  // Second call: must re-emit both globals and persist D2.
  const result2 = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );
  assert.ok(result2 && result2.hookSpecificOutput, 'second call must re-emit after digest mismatch');
  const ctx2 = result2.hookSpecificOutput.additionalContext;
  assert.ok(ctx2.includes(body1), 'first global body must appear after re-emit');
  assert.ok(ctx2.includes(body2), 'second global body must appear after re-emit');

  const ts2 = await readJson(turnStatePath(sid, cwd));
  assert.equal(ts2[GLOBALS_DIGEST_FIELD], d2, 'D2 must be persisted after re-emit');
});

// ---------------------------------------------------------------------------
// (j) preToolUse Read: first Read with global rule emits block + persists digest
// ---------------------------------------------------------------------------

test('preToolUse Read: first Read with [!global] rule in mandatory.md emits block and persists digest', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-read-first-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Always validate inputs before processing.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Use an absolute file path under cwd (file doesn't need to exist — no graph).
  const filePath = path.join(cwd, 'src', 'main.ts');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: filePath } },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, `expected hookSpecificOutput; got ${JSON.stringify(result)}`);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  // The read-context block should include the global rule body.
  assert.ok(ctx.includes(globalBody), 'global rule body must be in read-context block');

  // Digest must be persisted.
  const ts = await readJson(turnStatePath(sid, cwd));
  assert.ok(ts && typeof ts[GLOBALS_DIGEST_FIELD] === 'string', 'digest must be persisted in turn-state');
  assert.ok(ts[GLOBALS_DIGEST_FIELD].length > 0, 'digest must be non-empty');
});

// ---------------------------------------------------------------------------
// (k) preToolUse Read: pre-seeded digest → second Read of new file → undefined
// ---------------------------------------------------------------------------

test('preToolUse Read: pre-seeded matching digest, new file, no graph → returns undefined', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-read-suppress-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Rotate secrets every 90 days.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Pre-seed turn-state with the matching digest.
  const rule = makeGlobalRule(globalBody, rawLine);
  const digest = digestGlobals([rule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  // Read a NEW file (no graph, no node rule, no bug — nothing to compose).
  const filePath = path.join(cwd, 'src', 'totally-new-file.ts');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: filePath } },
    makeCtx(sid),
  );

  assert.equal(result, undefined, 'second Read with suppressed globals and no other content must return undefined');
});

// ---------------------------------------------------------------------------
// (l) preToolUse Read: [node:] + [!global] in mandatory.md, pre-seeded digest
//     → only node rule appears in composed block
// ---------------------------------------------------------------------------

test('preToolUse Read: node rule emitted, global rule suppressed (pre-seeded digest)', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-read-node-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'No secrets in source files.';
  const nodeBody = 'Keep src/a.ts exports under 10.';
  const globalRaw = `- 2026-05-12: [!] [!global] ${globalBody}`;
  const nodeRaw = `- 2026-05-12: [!] [node:src/a.ts] ${nodeBody}`;

  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    [globalRaw, nodeRaw, ''].join('\n'),
  );

  // Pre-seed matching digest so globals are suppressed.
  const globalRule = makeGlobalRule(globalBody, globalRaw);
  const digest = digestGlobals([globalRule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  // Read src/a.ts — the [node:src/a.ts] rule should fire; global should not.
  const filePath = path.join(cwd, 'src', 'a.ts');

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: filePath } },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, `expected hookSpecificOutput; got ${JSON.stringify(result)}`);
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(typeof ctx === 'string');
  assert.ok(ctx.includes(nodeBody), 'node rule body must appear');
  assert.ok(!ctx.includes(globalBody), 'global rule body must NOT appear (suppressed)');
});

// ---------------------------------------------------------------------------
// (m) SEXTANT_GLOBALS_DEDUP=off: pre-seeded digest → still emits full block
// ---------------------------------------------------------------------------

test('SEXTANT_GLOBALS_DEDUP=off: pre-seeded matching digest is ignored, full block still emitted', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: 'off' });

  const sid = 'dedup-bash-off-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Check exit codes.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Pre-seed matching digest.
  const rule = makeGlobalRule(globalBody, rawLine);
  const digest = digestGlobals([rule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );

  assert.ok(result && result.hookSpecificOutput, 'dedup=off must still emit the block');
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(globalBody), 'global rule body must appear when dedup is disabled');
  assert.ok(ctx.includes('<!-- sextant:bash-global-rules -->'), 'bash-global-rules marker must appear');
});

// ---------------------------------------------------------------------------
// (n) Treatment arm (ab_arm='B'): pre-seeded digest → stats.globals_deduped++
//     Control arm: stats file absent or globals_deduped stays 0
// ---------------------------------------------------------------------------

test('treatment arm (ab_arm=B): pre-seeded digest → globals_deduped increments to 1', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-arm-b-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Use atomic writes only.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Set arm to 'B' via withState.
  await withState(sid, cwd, (s) => { s.ab_arm = 'B'; });

  // Pre-seed matching digest so globals are suppressed.
  const rule = makeGlobalRule(globalBody, rawLine);
  const digest = digestGlobals([rule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  const result = await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );

  // Globals suppressed, no kw match → undefined.
  assert.equal(result, undefined, 'suppressed globals with no kw match must return undefined');

  // Stats must have globals_deduped = 1.
  const statsRaw = await fs.readFile(statsPath(durableBase(cwd)), 'utf8');
  const stats = JSON.parse(statsRaw);
  assert.equal(stats.globals_deduped, 1, 'globals_deduped must be 1 on treatment arm');
});

test('control arm (ab_arm=A, default): pre-seeded digest → stats file absent or globals_deduped not bumped', async (t) => {
  _resetGraphCache();
  await setupEnv(t);
  withEnv(t, { SEXTANT_GLOBALS_DEDUP: undefined });

  const sid = 'dedup-arm-a-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  const globalBody = 'Document all public APIs.';
  const rawLine = `- 2026-05-12: [!] [!global] ${globalBody}`;
  await writeFile(
    durableFile(cwd, path.join('cerebrum', 'cerebrum.md')),
    rawLine + '\n',
  );

  // Do NOT set ab_arm — defaults to 'A'.

  // Pre-seed matching digest so globals are suppressed.
  const rule = makeGlobalRule(globalBody, rawLine);
  const digest = digestGlobals([rule]);
  await writeJsonAtomic(turnStatePath(sid, cwd), { [GLOBALS_DIGEST_FIELD]: digest });

  await preToolUse(
    { session_id: sid, cwd, tool_name: 'Bash', tool_input: { command: 'ls' } },
    makeCtx(sid),
  );

  // Stats file should not exist (control arm never writes stats for dedup).
  const sp = statsPath(durableBase(cwd));
  let statsExists = false;
  try {
    await fs.access(sp);
    statsExists = true;
  } catch {
    statsExists = false;
  }

  if (statsExists) {
    const statsRaw = await fs.readFile(sp, 'utf8');
    const stats = JSON.parse(statsRaw);
    // If the file exists for some other reason, globals_deduped must be 0 or absent.
    assert.ok(
      !stats.globals_deduped || stats.globals_deduped === 0,
      `control arm must not increment globals_deduped; got ${stats.globals_deduped}`,
    );
  }
  // Either way: no assertion failure → test passes.
});

// ---------------------------------------------------------------------------
// (o) clearPendingRestore wipes mandatory_globals_digest from turn-state
// ---------------------------------------------------------------------------

test('clearPendingRestore wipes mandatory_globals_digest from turn-state', async (t) => {
  _resetGraphCache();
  await setupEnv(t);

  const sid = 'dedup-restore-clear-' + crypto.randomUUID().slice(0, 8);
  const cwd = await freshProjectCwd(t);

  // Pre-seed turn-state with both pending_restore and a digest.
  const snapshotTs = new Date().toISOString();
  await writeJsonAtomic(turnStatePath(sid, cwd), {
    pending_restore: true,
    [GLOBALS_DIGEST_FIELD]: 'abc123def456abcd',
  });

  // clearPendingRestore also tries to rename precompact.json → rotated.
  // Write a minimal precompact.json so it doesn't log a rename warning.
  const precompactPath = path.join(runtimeBase(sid, cwd), 'precompact.json');
  await writeFile(precompactPath, JSON.stringify({ ts: snapshotTs, payload: {} }));

  await clearPendingRestore(sid, snapshotTs, cwd);

  const ts = await readJson(turnStatePath(sid, cwd));
  assert.ok(ts, 'turn-state must still exist after clearPendingRestore');
  assert.equal(ts.pending_restore, false, 'pending_restore must be false');
  assert.equal(ts[GLOBALS_DIGEST_FIELD], undefined, 'mandatory_globals_digest must be wiped');
  assert.ok(!(GLOBALS_DIGEST_FIELD in ts), 'mandatory_globals_digest must be absent from turn-state object');
});
