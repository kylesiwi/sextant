#!/usr/bin/env node
// statusline/launch.mjs — Sextant statusline launcher / render-time version resolver.
//
// WHY THIS EXISTS
//   Claude Code plugins cannot declare a main `statusLine` (only
//   `subagentStatusLine`). The main statusLine must therefore live in the
//   user's ~/.claude/settings.json — where ${CLAUDE_PLUGIN_ROOT} is NOT
//   expanded, and the plugin's install path is version-pathed
//   (…/cache/<owner>/sextant/<version>/…) and garbage-collected on update.
//   A settings.json command needs a STABLE path, but the script it must run
//   moves every version, and can even differ per project when the plugin is
//   installed at multiple scopes (user / project / local) at different
//   versions.
//
//   This launcher IS that stable path. The SessionStart hook copies it to
//   ~/.claude/sextant/statusline.mjs (the path settings.json references) and it
//   never bakes a version. On every render it resolves the plugin version
//   active for the CURRENT project — by reading
//   ~/.claude/plugins/installed_plugins.json keyed on the cwd from the stdin
//   payload — and execs that version's statusline/statusline.mjs, passing the
//   payload straight through. No staleness window, no cross-project version
//   thrash.
//
//   It relies only on the stable cross-version contract — "node statusline.mjs
//   reads a JSON payload on stdin and writes status lines to stdout" — so it can
//   safely exec ANY installed version. Every failure mode degrades to a minimal
//   status line and exits 0: the statusline must never crash the session.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEGRADED = 'sxt · ctx 0%\n● idle · rules 0 · reads 0\n';

// Collect every install entry for the sextant plugin from installed_plugins.json.
// Shape: { version, plugins: { "<name>@<marketplace>": [ {scope, installPath,
// version, projectPath?}, … ] } }. Match any key whose plugin name (before '@')
// is exactly "sextant", across marketplaces.
export function findSextantEntries(db) {
  const out = [];
  const plugins = db && typeof db === 'object' ? db.plugins : null;
  if (!plugins || typeof plugins !== 'object') return out;
  for (const key of Object.keys(plugins)) {
    if (key.split('@')[0] !== 'sextant') continue;
    const entries = plugins[key];
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (e && typeof e === 'object' && typeof e.installPath === 'string') out.push(e);
    }
  }
  return out;
}

// Pick the install entry whose scope is active for `cwd`. A project/local entry
// (one carrying a projectPath) wins when cwd is inside that projectPath; among
// several, the longest (most specific) projectPath wins. The boundary is exact —
// cwd === projectPath OR cwd starts with projectPath + separator — so
// /foo/bar-old never matches projectPath /foo/bar. With no project match, fall
// back to a scope-less entry (user/managed; managed outranks user). Null if none.
export function pickEntryForCwd(entries, cwd) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let best = null;
  let bestLen = -1;
  if (typeof cwd === 'string' && cwd.length > 0) {
    for (const e of entries) {
      const pp = typeof e.projectPath === 'string' ? e.projectPath : '';
      if (!pp) continue;
      if ((cwd === pp || cwd.startsWith(pp + path.sep)) && pp.length > bestLen) {
        best = e;
        bestLen = pp.length;
      }
    }
  }
  if (best) return best;
  const scopeless = entries.filter((e) => !e.projectPath);
  if (scopeless.length === 0) return null;
  return scopeless.find((e) => e.scope === 'managed')
    || scopeless.find((e) => e.scope === 'user')
    || scopeless[0];
}

// Resolve the absolute path to the statusline renderer for `cwd`. Tries the
// installed-plugins DB first (scope-correct, per-cwd), then a pointer file the
// SessionStart hook writes (covers DB schema drift / an unreadable DB).
// `selfPath` is the launcher's own resolved path — it is never returned, so a
// malformed DB cannot point the launcher at itself (fork-bomb guard). Returns
// null when nothing usable is found.
export function resolveTarget(cwd, home, selfPath) {
  const claude = path.join(home, '.claude');
  // 1. installed_plugins.json — per-cwd, scope-aware (the correct path).
  try {
    const db = JSON.parse(
      fs.readFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    const entry = pickEntryForCwd(findSextantEntries(db), cwd);
    if (entry) {
      const t = path.join(entry.installPath, 'statusline', 'statusline.mjs');
      if (t !== selfPath && fs.existsSync(t)) return t;
    }
  } catch {}
  // 2. Pointer written by the SessionStart hook (last known-good renderer).
  //    A single global file → not scope-aware, but only consulted when the DB
  //    is unreadable, so the primary path stays scope-correct.
  try {
    const t = fs.readFileSync(path.join(claude, 'sextant', 'statusline-target'), 'utf8').trim();
    if (t && t !== selfPath && fs.existsSync(t)) return t;
  } catch {}
  return null;
}

function readAll(stream) {
  return new Promise((resolve) => {
    if (stream.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const raw = await readAll(process.stdin);
  let cwd = '';
  try {
    const p = JSON.parse(raw.toString('utf8') || '{}');
    cwd = (p && (p.workspace?.current_dir || p.cwd)) || '';
  } catch {}

  const home = process.env.HOME || os.homedir() || '';
  let selfPath = '';
  try { selfPath = fileURLToPath(import.meta.url); } catch {}

  const target = home ? resolveTarget(cwd, home, selfPath) : null;
  if (!target) {
    process.stdout.write(DEGRADED);
    return;
  }

  // Re-exec the resolved renderer with the original payload. stdout/stderr are
  // inherited so the child writes straight to the fds Claude Code reads. We only
  // render the degraded line on a spawn 'error' (e.g. node missing) — never on a
  // non-zero exit, because statusline.mjs already prints its own degraded line
  // and exits 0 on internal failure; doubling that would emit two status blocks.
  let done = false;
  const child = spawn(process.execPath, [target], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', () => {
    if (done) return;
    done = true;
    process.stdout.write(DEGRADED);
  });
  child.on('close', (code) => {
    if (done) return;
    done = true;
    process.exit(typeof code === 'number' ? code : 0);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
}

// Name-agnostic entrypoint check (repo convention, see bin/cli.mjs): this file
// ships as launch.mjs but is installed as statusline.mjs, so a basename guard
// would be wrong. Run main() only when invoked directly (node <thisfile>) — not
// when a test imports the named exports.
function isEntrypoint() {
  if (import.meta.url === `file://${process.argv[1]}`) return true;
  try { return fileURLToPath(import.meta.url) === process.argv[1]; } catch { return false; }
}

if (isEntrypoint()) {
  main().catch(() => {
    process.stdout.write(DEGRADED);
  });
}
