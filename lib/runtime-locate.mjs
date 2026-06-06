// lib/runtime-locate.mjs — single source of truth for WHERE per-session runtime
// ("hot") state lives. See docs/hot-state-relocation-design.md.
//
// Hot state (statusline-state.json, turn-state.json, hooks.log, edits.json, …)
// is ephemeral, per-session, single-writer, single-host. It belongs on FAST
// NATIVE FS — never the project tree, which on WSL2/Windows-mount setups is v9fs,
// where every locked read-modify-write paid a ~9P round-trip (the cause of the
// per-hook latency AND the concurrency fail-open cliff measured at 186 rules).
//
// Durable state (cerebrum, bugs, graph) is the opposite — per-project, genuinely
// cross-host — and stays under <cwd>/.sextant via lib/paths.mjs. This module only
// governs the hot tier.
//
// Resolution of the per-project runtime ROOT (first match wins):
//   1. SEXTANT_RUNTIME_BASE  — explicit override (tests, power users, and the
//        cross-host opt-in: set it to <cwd>/.sextant/runtime to restore the old
//        project-tree behaviour for a dashboard on a different host).
//   2. $XDG_RUNTIME_DIR/sextant/<projectHash>   (Linux: per-user, 0700, tmpfs)
//   3. os.tmpdir()/sextant-<uid>/<projectHash>  (macOS / no-XDG fallback)
//
// Two processes agree on the root ONLY if they share env (both CC-spawned: the
// hooks and the statusline do, so they agree), because nativeRuntimeRoot() reads
// XDG_RUNTIME_DIR from the *calling* process's environment.
//
// Dependencies: node builtins only (path/os/crypto) so it is cheap to import on
// the statusline's hot render path.

import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Stable per-project key. path.resolve normalises relative paths + trailing slash.
export function projectHash(cwd) {
  return crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

// The native runtime parent shared by all of a user's projects (each project gets
// a <projectHash> subdir under it).
export function nativeRuntimeRoot() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return path.join(xdg, 'sextant');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
  return path.join(os.tmpdir(), `sextant-${uid}`);
}

// runtimeRootFor(cwd): the per-project root holding every sextant-<sid>/ dir.
export function runtimeRootFor(cwd) {
  const override = process.env.SEXTANT_RUNTIME_BASE;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(nativeRuntimeRoot(), projectHash(cwd));
}
