// Tests for lib/conflicts.mjs — pure detection module.
//
// Builds synthetic cwd + home trees in tmp dirs and exercises each detector
// independently, plus the malformed-JSON resilience requirement.
//
// HOME is overridden explicitly on every detectConflicts call to keep the
// tests hermetic (the module defaults to process.env.HOME otherwise).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { detectConflicts, highestSeverity } from '../lib/conflicts.mjs';

function freshDir(t, prefix = 'sextant-conflicts-') {
  const dir = path.join(os.tmpdir(), prefix + crypto.randomUUID());
  fsSync.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeDirs(...parts) {
  const p = path.join(...parts);
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

function writeJson(p, value) {
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// --- clean tree -----------------------------------------------------------

test('clean tree → zero findings', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  const findings = await detectConflicts({ cwd, home });
  assert.deepEqual(findings, []);
  assert.equal(highestSeverity(findings), null);
});

// --- per-detector tests ---------------------------------------------------

test('openwolf-bridge: .wolf/ directory triggers high-severity finding', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.wolf');

  const findings = await detectConflicts({ cwd, home });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'openwolf-bridge');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].action_hint, /\/sextant:import-bridge/);
  assert.ok(findings[0].location.endsWith('.wolf'));
});

test('graphify: .graphify/ directory triggers medium-severity finding', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.graphify');

  const findings = await detectConflicts({ cwd, home });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'graphify');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].action_hint, /claude plugin uninstall graphify/);
});

test('dual-bug-store: both stores populated triggers medium finding', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.wolf');
  fsSync.writeFileSync(path.join(cwd, '.wolf', 'buglog.json'), '[]', 'utf8');
  makeDirs(cwd, '.sextant');
  writeJson(path.join(cwd, '.sextant', 'bugs.json'), [{ id: 'b1' }]);

  const findings = await detectConflicts({ cwd, home });
  // We'll get openwolf-bridge AND dual-bug-store.
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['dual-bug-store', 'openwolf-bridge']);
  const dual = findings.find((f) => f.kind === 'dual-bug-store');
  assert.equal(dual.severity, 'medium');
});

test('dual-bug-store: empty bugs.json does NOT trigger', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.wolf');
  fsSync.writeFileSync(path.join(cwd, '.wolf', 'buglog.json'), '[]', 'utf8');
  makeDirs(cwd, '.sextant');
  writeJson(path.join(cwd, '.sextant', 'bugs.json'), []);

  const findings = await detectConflicts({ cwd, home });
  // openwolf-bridge yes, dual-bug-store no.
  assert.ok(findings.some((f) => f.kind === 'openwolf-bridge'));
  assert.ok(!findings.some((f) => f.kind === 'dual-bug-store'));
});

test('dual-bug-store: missing .sextant/bugs.json does NOT trigger', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.wolf');
  fsSync.writeFileSync(path.join(cwd, '.wolf', 'buglog.json'), '[]', 'utf8');
  // Don't create .sextant/bugs.json.

  const findings = await detectConflicts({ cwd, home });
  assert.ok(!findings.some((f) => f.kind === 'dual-bug-store'));
});

test('predecessor-hooks-user: openwolf path in user hooks triggers high', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  writeJson(path.join(home, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [
            { type: 'command', command: 'node ~/.claude/plugins/openwolf/bin/hook.mjs' },
          ],
        },
      ],
    },
  });

  const findings = await detectConflicts({ cwd, home });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'predecessor-hooks-user');
  assert.equal(findings[0].severity, 'high');
  assert.match(findings[0].message, /openwolf/);
});

test('predecessor-hooks-user: graphify and bridge keywords also match', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  writeJson(path.join(home, '.claude', 'settings.json'), {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit',
          hooks: [
            { type: 'command', command: 'bash ~/.claude/graphify/post.sh' },
            { type: 'command', command: 'node ~/.bridge/relay.js' },
          ],
        },
      ],
    },
  });

  const findings = await detectConflicts({ cwd, home });
  const userHook = findings.find((f) => f.kind === 'predecessor-hooks-user');
  assert.ok(userHook);
  assert.match(userHook.message, /2 hook command\(s\)/);
});

test('predecessor-hooks-user: no predecessor hooks → no finding', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  writeJson(path.join(home, '.claude', 'settings.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read',
          hooks: [
            { type: 'command', command: 'node /opt/some-other-plugin/hook.mjs' },
          ],
        },
      ],
    },
  });

  const findings = await detectConflicts({ cwd, home });
  assert.deepEqual(findings, []);
});

test('predecessor-hooks-project: bridge hooks in .claude/settings.local.json', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  writeJson(path.join(cwd, '.claude', 'settings.local.json'), {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: '/usr/bin/env node /opt/openwolf-graphify-bridge/start.mjs' },
          ],
        },
      ],
    },
  });

  const findings = await detectConflicts({ cwd, home });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'predecessor-hooks-project');
  assert.equal(findings[0].severity, 'high');
});

test('predecessor-plugin-installed: openwolf-x dir under ~/.claude/plugins/', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(home, '.claude', 'plugins', 'openwolf-something');
  makeDirs(home, '.claude', 'plugins', 'unrelated-plugin');

  const findings = await detectConflicts({ cwd, home });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'predecessor-plugin-installed');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].message, /openwolf-something/);
});

test('predecessor-plugin-installed: graphify and *-bridge directories match', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(home, '.claude', 'plugins', 'graphify');
  makeDirs(home, '.claude', 'plugins', 'openwolf-graphify-bridge');
  makeDirs(home, '.claude', 'plugins', 'random-thing');

  const findings = await detectConflicts({ cwd, home });
  const kinds = findings.filter((f) => f.kind === 'predecessor-plugin-installed').map((f) => f.message);
  // graphify (starts with "graphify"), openwolf-graphify-bridge (starts with "openwolf").
  assert.equal(kinds.length, 2);
});

test('predecessor-plugin-installed: missing plugins dir → no error, no findings', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  // No ~/.claude/plugins/ at all.

  const findings = await detectConflicts({ cwd, home });
  assert.deepEqual(findings, []);
});

// --- malformed JSON resilience -------------------------------------------

test('malformed ~/.claude/settings.json → no throw; warning to stderr; other findings still surface', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  // Bad JSON in user settings — should warn but not throw.
  makeDirs(home, '.claude');
  fsSync.writeFileSync(path.join(home, '.claude', 'settings.json'), '{not json', 'utf8');
  // Add a .wolf/ to confirm other findings still surface.
  makeDirs(cwd, '.wolf');

  // Capture stderr to confirm we warn.
  const origWrite = process.stderr.write.bind(process.stderr);
  const stderrCaptured = [];
  process.stderr.write = (chunk, ...rest) => {
    stderrCaptured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  t.after(() => { process.stderr.write = origWrite; });

  const findings = await detectConflicts({ cwd, home });

  // The wolf finding still arrives.
  assert.ok(findings.some((f) => f.kind === 'openwolf-bridge'));
  // The malformed-JSON path should NOT have produced a hooks finding.
  assert.ok(!findings.some((f) => f.kind === 'predecessor-hooks-user'));
  // Stderr captured at least one warning line about malformed JSON.
  const all = stderrCaptured.join('');
  assert.match(all, /malformed JSON/);
});

test('malformed .claude/settings.local.json in project → same behavior', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.claude');
  fsSync.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '@@', 'utf8');

  const origWrite = process.stderr.write.bind(process.stderr);
  const stderrCaptured = [];
  process.stderr.write = (chunk, ...rest) => {
    stderrCaptured.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  t.after(() => { process.stderr.write = origWrite; });

  const findings = await detectConflicts({ cwd, home });
  assert.ok(!findings.some((f) => f.kind === 'predecessor-hooks-project'));
  assert.match(stderrCaptured.join(''), /malformed JSON/);
});

// --- combined high+medium ------------------------------------------------

test('multiple findings → highestSeverity reports high', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.wolf');          // high
  makeDirs(cwd, '.graphify');      // medium
  makeDirs(home, '.claude', 'plugins', 'openwolf-x'); // medium

  const findings = await detectConflicts({ cwd, home });
  assert.equal(highestSeverity(findings), 'high');
  // All three present.
  const kinds = findings.map((f) => f.kind).sort();
  assert.ok(kinds.includes('openwolf-bridge'));
  assert.ok(kinds.includes('graphify'));
  assert.ok(kinds.includes('predecessor-plugin-installed'));
});

test('only medium findings → highestSeverity reports medium', async (t) => {
  const cwd = freshDir(t);
  const home = freshDir(t);
  makeDirs(cwd, '.graphify');

  const findings = await detectConflicts({ cwd, home });
  assert.equal(highestSeverity(findings), 'medium');
});

// --- HOME explicitly empty ------------------------------------------------

test('home="" → user-scope detectors skip, project-scope still runs', async (t) => {
  const cwd = freshDir(t);
  makeDirs(cwd, '.wolf');

  const findings = await detectConflicts({ cwd, home: '' });
  // Only the project-scope .wolf finding fires; no user-side checks attempted.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'openwolf-bridge');
});
