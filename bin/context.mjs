#!/usr/bin/env node
// bin/context.mjs — Sextant context CLI (Phase 9 § 8).
//
// Backs /sextant:project-context (skills/project-context/SKILL.md). Surfaces
// the current state of a Sextant-managed project: recent files, open bugs,
// recent commits, and mandatory rules. Designed to be runnable both from the
// /sextant:project-context skill (during a Claude Code session) and from a normal
// shell (post-compaction "what was I working on?" recovery).
//
// Data sources (all under <root>/.sextant/ or the per-session runtime dir):
//   - runtime/edits.json                    (Phase 5 — project edits in-flight)
//   - .sextant/bugs.json                    (Phase 3 — durable bug store)
//   - .sextant/session/<sid>/commits/*.json (Phase 5 — per-commit snapshots)
//   - .sextant/cerebrum/mandatory.md        (Phase 2 — durable rules)
//
// Sessions: this CLI runs outside hook context, so we need a way to find the
// session id for the runtime-base reads (edits.json + commits/*.json). The
// strategy:
//   --sid <id>      explicit session id (preferred)
//   <no flag>       scan the runtime base for the most recently active
//                   sextant-* directory and use that session id.
// If no session is resolvable, the session-dependent sections render as
// empty (or with a friendly "(no active session)" placeholder). The
// mandatory-rules section is always reachable since it's durable under
// .sextant/cerebrum/.
//
// Options:
//   --root <path>   Project root containing .sextant/ (default: $PWD).
//   --sid <id>      Session id (default: auto-detect via runtime base).
//   --json          Emit JSON to stdout instead of human-readable text.
//   -h, --help      Print this message.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableBase, editsPath, runtimeRoot } from '../lib/paths.mjs';
import { readJson } from '../lib/io.mjs';
import { readBugs } from '../lib/stores/bugs.mjs';
import { commitsDir } from '../lib/capture/commit-snapshot.mjs';
import { readResolvedCerebrum } from '../lib/stores/cerebrum.mjs';

const USAGE = `Usage: context [options]

Print Sextant's current-state summary for the project at --root.

Options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  --sid <id>      Session id (default: auto-detect via runtime base).
  --json          Emit JSON instead of human-readable text.
  -h, --help      Print this message.`;

export function parseArgs(argv) {
  const out = { root: null, sid: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--sid') out.sid = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`context: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

// Resolve the runtime base directory (without the per-session suffix).
//
// v0.20.0: runtime (hot) state lives on native FS resolved by
// lib/runtime-locate.mjs (off the v9fs project tree). SEXTANT_RUNTIME_BASE still
// wins. When neither override nor projectRoot is provided we can't auto-detect
// anything; the caller must pass a project root. Delegates to
// lib/paths.mjs::runtimeRoot so the path layout stays in one place.
function runtimeBaseRoot(projectRoot) {
  const testOverride = process.env.SEXTANT_RUNTIME_BASE;
  if (testOverride && testOverride.length > 0) return path.resolve(testOverride);
  if (projectRoot && typeof projectRoot === 'string') {
    return runtimeRoot(path.resolve(projectRoot));
  }
  return null;
}

// Auto-detect the most-recent sextant-<sid> directory under the runtime base.
// Returns the bare sid string or null if none is found. We pick most-recent by
// mtime of the directory itself (Node mtime tracks last child rename, which is
// good enough for "active session" purposes).
export async function detectLatestSessionId(projectRoot) {
  const root = runtimeBaseRoot(projectRoot);
  if (!root) return null;
  let entries;
  try {
    entries = await fsp.readdir(root);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith('sextant-')) continue;
    const full = path.join(root, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isDirectory()) continue;
      candidates.push({ sid: name.slice('sextant-'.length), mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].sid;
}

// Collect recent files from runtime/edits.json. Sorted by ts desc, unique by
// path, capped at 5. Returns [] if no sid or no edits.
export async function collectRecentFiles(sid, cwd) {
  if (!sid) return [];
  const raw = await readJson(editsPath(sid, cwd));
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const e = raw[i];
    if (!e || typeof e !== 'object') continue;
    const p = typeof e.path === 'string' ? e.path : null;
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({
      path: p,
      ts: typeof e.ts === 'string' ? e.ts : null,
      kind: typeof e.kind === 'string' ? e.kind : null,
    });
    if (out.length >= 5) break;
  }
  return out;
}

// Collect open bugs (!fix_verified) optionally filtered to a session.
// Returns the raw bug objects (caller renders).
export async function collectOpenBugs(root, sid) {
  let bugs;
  try {
    bugs = await readBugs(durableBase(root));
  } catch {
    return [];
  }
  if (!Array.isArray(bugs)) return [];
  const out = [];
  for (const b of bugs) {
    if (!b || typeof b !== 'object') continue;
    if (b.fix_verified) continue;
    if (sid && b.session_id !== sid) continue;
    out.push(b);
  }
  return out;
}

// Collect the 3 most-recent commit snapshots for this session. Mirrors the
// shape that PreCompact's commits section emits.
export async function collectRecentCommits(root, sid) {
  if (!sid) return [];
  const dir = commitsDir(root, sid);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const jsonFiles = entries.filter((n) => n.endsWith('.json'));
  if (jsonFiles.length === 0) return [];
  const stated = [];
  for (const name of jsonFiles) {
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      stated.push({ full, mtimeMs: st.mtimeMs });
    } catch {
      // skip
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = stated.slice(0, 3);

  const out = [];
  for (const { full } of top) {
    let parsed;
    try {
      parsed = await readJson(full);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
    const seen = new Set();
    const filePaths = [];
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue;
      const p = typeof e.path === 'string' ? e.path : null;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      filePaths.push(p);
      if (filePaths.length >= 5) break;
    }
    out.push({
      ts: typeof parsed.ts === 'string' ? parsed.ts : null,
      edit_count: edits.length,
      file_paths: filePaths,
    });
  }
  return out;
}

// Return the deterministic rules from the cerebrum store — the ones that fire
// by scope: [global] (always-on) and [node:<path>] (file-scoped). Keyword and
// review-queue rules are excluded (they're the ranked / not-yet-scoped tiers).
// Always safe to call — a missing store returns []. Entries are parsed rule
// objects (kind === 'rule') with normalized buckets.
export async function collectMandatoryRules(root) {
  const cerebrumDir = path.join(durableBase(root), 'cerebrum');
  const resolved = await readResolvedCerebrum(cerebrumDir);
  const parsed = resolved && resolved.parsed;
  if (!parsed || !Array.isArray(parsed.lines)) return [];
  const out = [];
  for (const e of parsed.lines) {
    if (e.kind !== 'rule') continue;
    const b = Array.isArray(e.buckets) ? e.buckets : [];
    if (b.some((x) => typeof x === 'string' && x.startsWith('kw:'))) continue;
    if (b.includes('!review')) continue;
    const isGlobal = b.includes('!global');
    const isNode = b.some((x) => typeof x === 'string' && x.startsWith('node:'));
    if (isGlobal || isNode) out.push(e);
  }
  return out;
}

// Compact relative-time helper. Same shape used by lib/hooks/restore.mjs:
// "5s ago", "3m ago", "2h ago", "4d ago"; "just now" for very-recent. Falls
// back to the input string when parsing fails.
function relativeTimeShort(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - t;
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Format a single mandatory rule line for display. Mirrors the per-Read context
// block (lib/inject/compose.mjs): the rule is labeled by its scope —
//   [!global] <body>   or   [node:<path>] <body> (by: <session>)
function formatRuleLine(rule) {
  const buckets = Array.isArray(rule.buckets) ? rule.buckets : [];
  let bucketStr = '';
  if (buckets.includes('!global')) {
    bucketStr = '[!global]';
  } else {
    const nodeBucket = buckets.find((b) => b.startsWith('node:'));
    if (nodeBucket) bucketStr = `[${nodeBucket}]`;
  }
  const body = (typeof rule.body === 'string' && rule.body.length > 0) ? rule.body : '(empty)';
  const by = (typeof rule.bySession === 'string' && rule.bySession.length > 0)
    ? ` (by: ${rule.bySession})`
    : '';
  const prefix = bucketStr ? `${bucketStr} ` : '';
  return `- ${prefix}${body}${by}`;
}

// Render the JSON shape — same as the structured input the human renderer
// also uses. Keeps the contract simple for downstream tooling.
function buildJson(state) {
  return {
    root: state.root,
    sid: state.sid,
    recent_files: state.recentFiles,
    open_bugs: state.openBugs,
    recent_commits: state.recentCommits,
    mandatory_rules: state.mandatoryRules.map((r) => ({
      raw: r.raw,
      body: r.body,
      buckets: r.buckets,
      bySession: r.bySession,
      date: r.date,
    })),
  };
}

// Render the human-readable text view. Mirrors the section ordering that the
// post-compact restoration block uses — files / bugs / commits — followed by
// mandatory rules (always durable).
function renderText(state) {
  const lines = [];

  // -- Recent files
  lines.push('## Recent files');
  if (state.recentFiles.length === 0) {
    lines.push('(none)');
  } else {
    const nowMs = Date.now();
    for (const f of state.recentFiles) {
      const rel = f.ts ? relativeTimeShort(f.ts, nowMs) : null;
      const parts = [];
      if (rel) parts.push(rel);
      if (f.kind) parts.push(f.kind);
      lines.push(parts.length > 0 ? `- ${f.path} (${parts.join(', ')})` : `- ${f.path}`);
    }
  }
  lines.push('');

  // -- Open bugs
  lines.push('## Open bugs');
  if (state.openBugs.length === 0) {
    lines.push('(none)');
  } else {
    for (const b of state.openBugs) {
      const id = typeof b.id === 'string' ? b.id : '(no-id)';
      const file = typeof b.file === 'string' ? b.file : '(no-file)';
      const err = typeof b.error_message === 'string' ? b.error_message : '';
      lines.push(`- ${id} [${file}] ${err}`);
    }
  }
  lines.push('');

  // -- Recent commits
  lines.push('## Recent commits');
  if (state.recentCommits.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of state.recentCommits) {
      const ts = typeof c.ts === 'string' ? c.ts : '(no-ts)';
      const editCount = typeof c.edit_count === 'number' ? c.edit_count : 0;
      const filePathsCount = Array.isArray(c.file_paths) ? c.file_paths.length : 0;
      lines.push(`- ${ts}: ${editCount} edits across ${filePathsCount} files`);
    }
  }
  lines.push('');

  // -- Mandatory rules
  lines.push('## Mandatory rules');
  if (state.mandatoryRules.length === 0) {
    lines.push('(none)');
  } else {
    for (const r of state.mandatoryRules) {
      lines.push(formatRuleLine(r));
    }
  }
  lines.push('');

  // -- Runtime location (hot state + logs now live on native FS, off the
  // project tree — surface it so logs stay discoverable).
  lines.push('## Runtime');
  const rtRoot = runtimeBaseRoot(state.root);
  if (rtRoot) {
    lines.push(`- root: ${rtRoot}`);
    if (state.sid) lines.push(`- session: ${path.join(rtRoot, `sextant-${state.sid}`)}`);
  } else {
    lines.push('(unresolved — pass --root)');
  }

  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : process.cwd();

  // Resolve session id: explicit flag wins; otherwise auto-detect from
  // runtime base. If still null, we skip session-scoped sections (still
  // print durable mandatory rules).
  let sid = args.sid;
  if (!sid) sid = await detectLatestSessionId(root);

  const [recentFiles, openBugs, recentCommits, mandatoryRules] = await Promise.all([
    collectRecentFiles(sid, root),
    collectOpenBugs(root, sid),
    collectRecentCommits(root, sid),
    collectMandatoryRules(root),
  ]);

  const state = { root, sid, recentFiles, openBugs, recentCommits, mandatoryRules };

  if (args.json) {
    process.stdout.write(JSON.stringify(buildJson(state)) + '\n');
    return 0;
  }
  process.stdout.write(renderText(state));
  return 0;
}

function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`context: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

// Re-exports for tests + downstream tooling.
export { runtimeBaseRoot };
