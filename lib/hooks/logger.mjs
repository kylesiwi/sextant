// lib/hooks/logger.mjs — JSONL append logger for the hooks pipeline.
//
// Every hook handler logs a single JSON line per fire to runtime/hooks.log.
// This is the audit trail Phase 0 needs to prove "hooks fire and no-op";
// later phases will read it for self-introspection / debugging only.
//
// Design choices:
//   - One line per call: JSON.stringify(entry) + '\n'. JSONL keeps the file
//     trivially streamable and append-only safe (no partial-line corruption
//     under concurrent appends because the OS atomically writes <PIPE_BUF).
//   - We ensure the runtime dir exists ourselves. Callers don't need to
//     pre-mkdir. The dispatcher is the only path that calls us; centralizing
//     mkdir keeps handlers tiny.
//   - Errors are swallowed: a hook that can't log MUST NOT crash Claude
//     Code. We write the failure to stderr and return; the dispatcher's
//     outer try/catch is the next net.

import fs from 'node:fs/promises';

import { hooksLogPath, ensureRuntimeDir } from '../paths.mjs';

export async function appendLog(sessionId, entry, cwd) {
  try {
    await ensureRuntimeDir(sessionId, cwd);
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(hooksLogPath(sessionId, cwd), line, 'utf8');
  } catch (err) {
    // Best-effort: log failure to stderr but never propagate.
    try {
      process.stderr.write(`sextant: log-append failed sid=${sessionId} err=${err.message}\n`);
    } catch {
      // Even stderr write can fail (e.g., closed pipe). Give up silently.
    }
  }
}
