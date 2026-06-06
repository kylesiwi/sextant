// lib/conflicts.mjs — predecessor / hook-collision conflict detection.
//
// Pure detection. NO file writes, NO mutation of any user/plugin config.
// The policy (§ 11 R17): Sextant detects and surfaces conflicts but never
// programmatically edits another plugin's settings.json, hooks.json, or any
// user-config file. The failure mode of silent mis-edit (we wreck a config
// the user spent time tuning) is worse than the failure mode we'd be fixing
// (the user pays double-hook latency until they notice).
//
// Three surfaces consume this module:
//   - /sextant:init           — prompt before proceeding on any high-severity.
//   - /sextant:doctor         — read-only display, ongoing health.
//   - /sextant:check-conflicts — dedicated, explicit invocation.
//
// File reads are best-effort:
//   - ENOENT → silently skip (the absence IS the signal in some cases).
//   - Malformed JSON → log a warning to stderr but do NOT throw.
//
// The module never throws on user-input data; errors only surface for
// programmer errors (e.g., wrong-typed argument).

import fs from 'node:fs/promises';
import path from 'node:path';

// Regex for matching predecessor commands inside hook entries.
// Match "openwolf", "graphify", or "bridge" anywhere in a command string.
// Case-insensitive so "OpenWolf" / "Graphify" / etc. are caught too.
const PREDECESSOR_COMMAND_RE = /openwolf|graphify|bridge/i;

// Regex for plugin directory names that look like predecessors.
// Matches names starting with "openwolf" or "graphify", or ending in
// "bridge". Case-insensitive.
const PREDECESSOR_PLUGIN_RE = /^openwolf|^graphify|bridge$/i;

// --- helpers --------------------------------------------------------------

async function dirExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    // Any other error (EACCES, etc.) — treat as not-present but don't throw.
    return false;
  }
}

async function fileExists(p) {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    return false;
  }
}

// Read JSON file; return { ok: bool, value?, err? }. Never throws on
// ENOENT — that's the "absence" signal. Logs a one-line warning to stderr
// on malformed JSON so the user can see why a check appears to be silently
// passing.
async function readJson(p) {
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return { ok: false, absent: true };
    }
    process.stderr.write(`sextant conflicts: cannot read ${p}: ${err.message}\n`);
    return { ok: false, absent: false, err };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    process.stderr.write(`sextant conflicts: malformed JSON at ${p}: ${err.message}\n`);
    return { ok: false, absent: false, err };
  }
}

// Walk a hooks object (typical Claude Code shape) and yield every string
// `command` field found at the leaves. The hooks shape is:
//   { <EventName>: [ { matcher?: string, hooks: [ { type: 'command', command: '<...>' } ] } ] }
// We tolerate alternate shapes (array of command-strings, flat command
// strings) because user-edited settings can drift.
function* iterCommandStrings(hooks) {
  if (!hooks || typeof hooks !== 'object') return;
  for (const eventEntry of Object.values(hooks)) {
    if (!Array.isArray(eventEntry)) continue;
    for (const matcher of eventEntry) {
      if (!matcher || typeof matcher !== 'object') continue;
      const inner = matcher.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (h && typeof h === 'object' && typeof h.command === 'string') {
          yield h.command;
        }
      }
    }
  }
}

// --- individual detectors -------------------------------------------------

async function detectOpenwolfBridge(cwd) {
  const wolfDir = path.join(cwd, '.wolf');
  if (!(await dirExists(wolfDir))) return null;
  return {
    kind: 'openwolf-bridge',
    severity: 'high',
    location: wolfDir,
    message: '.wolf/ directory present — openwolf-graphify-bridge is active in this project.',
    action_hint:
      'Run `/sextant:import-bridge` to migrate bridge data. Then disable the bridge in `~/.claude/settings.json#hooks` and/or uninstall via `claude plugin uninstall <bridge-name>`.',
  };
}

async function detectGraphify(cwd) {
  const graphifyDir = path.join(cwd, '.graphify');
  if (!(await dirExists(graphifyDir))) return null;
  return {
    kind: 'graphify',
    severity: 'medium',
    location: graphifyDir,
    message: '.graphify/ directory present — Graphify is producing graph output here.',
    action_hint:
      "Sextant ships its own graph builder. `.graphify/` is read-only and can stay; if its hooks fire concurrently, latency compounds. To remove: `claude plugin uninstall graphify`.",
  };
}

async function detectDualBugStore(cwd) {
  const buglog = path.join(cwd, '.wolf', 'buglog.json');
  const bugsJson = path.join(cwd, '.sextant', 'bugs.json');
  if (!(await fileExists(buglog))) return null;
  if (!(await fileExists(bugsJson))) return null;

  const sextantBugs = await readJson(bugsJson);
  if (!sextantBugs.ok) return null;
  if (!Array.isArray(sextantBugs.value) || sextantBugs.value.length === 0) {
    return null;
  }
  return {
    kind: 'dual-bug-store',
    severity: 'medium',
    location: `${buglog} + ${bugsJson}`,
    message: 'Both .wolf/buglog.json and .sextant/bugs.json hold bug entries.',
    action_hint:
      "Both `.wolf/buglog.json` and `.sextant/bugs.json` are populated. `/sextant:import-bridge --force` will overwrite Sextant's copy with the bridge's; otherwise hand-merge.",
  };
}

async function detectPredecessorHooks(settingsPath, kind) {
  const r = await readJson(settingsPath);
  if (!r.ok) return null;
  const hooks = r.value && r.value.hooks;
  if (!hooks || typeof hooks !== 'object') return null;

  const matches = [];
  for (const cmd of iterCommandStrings(hooks)) {
    if (PREDECESSOR_COMMAND_RE.test(cmd)) matches.push(cmd);
  }
  if (matches.length === 0) return null;

  const sample = matches.slice(0, 3);
  const more = matches.length > 3 ? ` (+${matches.length - 3} more)` : '';
  const scope = kind === 'predecessor-hooks-user' ? '~/.claude/settings.json' : '<cwd>/.claude/settings.local.json';
  return {
    kind,
    severity: 'high',
    location: `${settingsPath}#hooks`,
    message: `${matches.length} hook command(s) match predecessor pattern: ${sample.join(', ')}${more}`,
    action_hint:
      `\`${scope}#hooks\` contains commands that look like predecessor hooks. ` +
      'They fire concurrently with Sextant\'s, doubling latency on every tool call and stacking ' +
      `\`additionalContext\` injection. Remove the matching \`hooks.*\` entries from \`${scope}\` ` +
      '(back up the file first).',
  };
}

async function detectPredecessorHooksUser(home) {
  if (!home) return null;
  const p = path.join(home, '.claude', 'settings.json');
  return detectPredecessorHooks(p, 'predecessor-hooks-user');
}

async function detectPredecessorHooksProject(cwd) {
  const p = path.join(cwd, '.claude', 'settings.local.json');
  return detectPredecessorHooks(p, 'predecessor-hooks-project');
}

async function detectPredecessorPlugin(home) {
  if (!home) return [];
  const pluginsDir = path.join(home, '.claude', 'plugins');
  let entries;
  try {
    entries = await fs.readdir(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      process.stderr.write(`sextant conflicts: cannot list ${pluginsDir}: ${err.message}\n`);
    }
    return [];
  }
  const findings = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!PREDECESSOR_PLUGIN_RE.test(ent.name)) continue;
    findings.push({
      kind: 'predecessor-plugin-installed',
      severity: 'medium',
      location: path.join(pluginsDir, ent.name),
      message: `Predecessor plugin "${ent.name}" installed at ~/.claude/plugins/${ent.name}.`,
      action_hint:
        `Plugin \`${ent.name}\` is installed under \`~/.claude/plugins/\`. If you want to retire it: ` +
        `\`claude plugin uninstall ${ent.name}\`. Sextant works in parallel without uninstall, but you pay ` +
        'double-hook latency.',
    });
  }
  return findings;
}

// --- public surface -------------------------------------------------------

/**
 * Detect conflicts with predecessor plugins (OpenWolf, Graphify,
 * openwolf-graphify-bridge) and generic hook collisions.
 *
 * @param {object} opts
 * @param {string} opts.cwd                Project root to scan.
 * @param {string} [opts.home=process.env.HOME ?? '']  User home for ~/.claude/ checks.
 * @returns {Promise<Array<{kind:string,severity:'high'|'medium'|'low',location:string,message:string,action_hint:string}>>}
 */
export async function detectConflicts({ cwd, home = process.env.HOME ?? '' } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('detectConflicts: cwd is required');
  }
  // Resolve once so all paths are absolute in findings.
  const resolvedCwd = path.resolve(cwd);
  const resolvedHome = home && home.length > 0 ? path.resolve(home) : '';

  // Run all detectors concurrently — they read disjoint files and the
  // total cost should stay under ~20ms on a warm cache.
  const [
    openwolfBridge,
    graphify,
    dualBugStore,
    hooksUser,
    hooksProject,
    predecessorPlugins,
  ] = await Promise.all([
    detectOpenwolfBridge(resolvedCwd),
    detectGraphify(resolvedCwd),
    detectDualBugStore(resolvedCwd),
    detectPredecessorHooksUser(resolvedHome),
    detectPredecessorHooksProject(resolvedCwd),
    detectPredecessorPlugin(resolvedHome),
  ]);

  const findings = [];
  if (openwolfBridge) findings.push(openwolfBridge);
  if (graphify) findings.push(graphify);
  if (dualBugStore) findings.push(dualBugStore);
  if (hooksUser) findings.push(hooksUser);
  if (hooksProject) findings.push(hooksProject);
  for (const p of predecessorPlugins) findings.push(p);

  return findings;
}

/**
 * Convenience: return the highest severity in a findings array, or null
 * if empty. Severity order: high > medium > low.
 */
export function highestSeverity(findings) {
  let order = -1;
  let best = null;
  for (const f of findings) {
    const rank = f.severity === 'high' ? 2 : f.severity === 'medium' ? 1 : f.severity === 'low' ? 0 : -1;
    if (rank > order) { order = rank; best = f.severity; }
  }
  return best;
}
