#!/usr/bin/env node
// bin/cli.mjs — Sextant hook dispatcher.
//
// Invoked once per hook event by Claude Code. The plugin manifest configures
// every event to spawn:
//   ${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs <EventName>
//
// Contract with Claude Code (verified docs, see GROUND_UP_DESIGN.md § 5):
//   - argv[2] = hook event name (capitalized, e.g. "SessionStart").
//   - stdin   = single JSON object with at least:
//       session_id, cwd, hook_event_name, transcript_path,
//       permission_mode, effort
//     Tool events additionally carry tool_name + tool_input;
//     PostToolUse adds tool_response.
//   - stdout = (optional) a single JSON object Claude Code reads as the
//     hook's structured response (additionalContext, systemMessage, etc.).
//     Phase 0 returns nothing here — no-op semantics.
//   - exit code = treated by Claude Code as a hint. We always exit 0 so a
//     misbehaving hook never blocks the user.
//
// Robustness principle (§ 8 Phase 0):
//   Hooks are best-effort observability. The dispatcher MUST NOT propagate
//   exceptions to Claude Code. Every failure mode below is swallowed,
//   logged to stderr (which Claude Code surfaces in `claude --debug`), and
//   the process exits 0.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { runtimeBase, durableBase } from '../lib/paths.mjs';
import { appendLog } from '../lib/hooks/logger.mjs';

// Wall-clock budget for any single handler invocation. A misbehaving handler
// (pathological regex, runaway loop, blocking I/O on a giant file) must not
// be able to hang Claude Code. On timeout we exit 0 with no stdout — the
// hook is best-effort by contract, so silently no-op'ing is preferable to
// the user staring at a frozen agent. Configurable via SEXTANT_HOOK_TIMEOUT_MS
// for testing / debugging. Default 5s — comfortably above the 200ms target
// while still snapping back fast enough that nobody notices.
// Bumped 5s→10s (cerebrum-v2 §10.1, PROVISIONAL): the hook exits in ≪1s normally,
// so a higher ceiling is free insurance against a pathological slow path silently
// failing open (timeout → exit 0, no rules). Tune via SEXTANT_HOOK_TIMEOUT_MS.
const DEFAULT_HOOK_TIMEOUT_MS = 10000;
function getHookTimeoutMs() {
  const raw = process.env.SEXTANT_HOOK_TIMEOUT_MS;
  if (!raw) return DEFAULT_HOOK_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOOK_TIMEOUT_MS;
}

const TIMEOUT_SENTINEL = Symbol('sextant.handler.timeout');

// The full set of events the plugin manifest registers. Anything outside
// this list is logged as "unknown" and ignored — we'd rather no-op than
// dispatch to a typo'd handler that surprises us later.
const REGISTERED_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PostCompact',
  'FileChanged',
  'Stop',
  'SubagentStop',
  'Notification',
]);

// EventName → handler filename. Lowercase the first character; rest as-is.
// PascalCase → camelCase mapping is deterministic with this single rule.
export function eventToModule(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  return name.charAt(0).toLowerCase() + name.slice(1) + '.mjs';
}

// Read all of stdin into a string. Returns '' on EOF with no bytes.
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function isoNow() {
  return new Date().toISOString();
}

async function main() {
  const eventName = process.argv[2];

  // 1. Event-name sanity. If missing or unregistered, log to stderr + exit 0.
  if (!eventName) {
    process.stderr.write('sextant: missing event name argv[2]\n');
    return 0;
  }
  if (!REGISTERED_EVENTS.has(eventName)) {
    process.stderr.write(`sextant: unknown event "${eventName}"\n`);
    return 0;
  }

  // 2. Read + parse stdin. Malformed JSON is logged to stderr but doesn't
  // crash the hook — we still exit 0 so Claude Code keeps going.
  let raw;
  try {
    raw = await readStdin();
  } catch (err) {
    process.stderr.write(`sextant: stdin-read error event=${eventName} err=${err.message}\n`);
    return 0;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `sextant: stdin-parse error event=${eventName} err=${err.message} bytes=${raw.length}\n`,
    );
    return 0;
  }

  if (!payload || typeof payload !== 'object') {
    process.stderr.write(`sextant: stdin not an object event=${eventName}\n`);
    return 0;
  }

  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    process.stderr.write(`sextant: missing session_id event=${eventName}\n`);
    return 0;
  }

  // Resolve cwd from payload. CC sends cwd as a top-level string AND under
  // workspace.current_dir (redundant in practice). Either is acceptable; we
  // prefer the top-level. As of v0.7.0 cwd is load-bearing for runtimeBase()
  // — without it we cannot determine where to write per-session state.
  let cwd = null;
  if (typeof payload.cwd === 'string' && payload.cwd.length > 0) {
    cwd = payload.cwd;
  } else if (
    payload.workspace
    && typeof payload.workspace === 'object'
    && typeof payload.workspace.current_dir === 'string'
    && payload.workspace.current_dir.length > 0
  ) {
    cwd = payload.workspace.current_dir;
  }
  // SEXTANT_RUNTIME_BASE override lets test harnesses (and a future
  // session-bootstrapping path that has no cwd yet) bypass the cwd
  // requirement. With the override set, runtimeBase ignores cwd entirely,
  // so we can safely skip validation.
  const hasRuntimeOverride =
    typeof process.env.SEXTANT_RUNTIME_BASE === 'string'
    && process.env.SEXTANT_RUNTIME_BASE.length > 0;
  if (!hasRuntimeOverride) {
    if (!cwd) {
      process.stderr.write(
        `sextant: missing cwd event=${eventName} sid=${sessionId}\n`,
      );
      return 0;
    }
    if (!path.isAbsolute(cwd)) {
      process.stderr.write(
        `sextant: cwd not absolute event=${eventName} sid=${sessionId} cwd=${cwd}\n`,
      );
      return 0;
    }
  }

  // 3. Resolve handler module under lib/hooks/. Dynamic import keeps the
  // per-event cost to just the modules actually touched; cold-start is
  // dominated by node startup, not import.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const handlerFile = eventToModule(eventName);
  const handlerPath = path.resolve(here, '..', 'lib', 'hooks', handlerFile);

  let mod;
  try {
    mod = await import(handlerPath);
  } catch (err) {
    // ERR_MODULE_NOT_FOUND is the "phase 0 hasn't implemented this yet"
    // case; everything else is a real bug we still don't want to crash on.
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message)) {
      process.stderr.write(`sextant: handler missing event=${eventName} path=${handlerPath}\n`);
    } else {
      process.stderr.write(
        `sextant: handler-import error event=${eventName} err=${err.message}\n${err.stack}\n`,
      );
    }
    return 0;
  }

  const handler = mod && mod.default;
  if (typeof handler !== 'function') {
    process.stderr.write(`sextant: handler not a function event=${eventName}\n`);
    return 0;
  }

  // 4. Build ctx and invoke. Handler may return undefined/null (no-op) or
  // an object (serialized to stdout for Claude Code to consume).
  const ctx = {
    eventName,
    runtimeBase,
    durableBase,
    log: (entry) => appendLog(sessionId, entry, cwd),
    nowIso: isoNow,
  };

  let result;
  const timeoutMs = getHookTimeoutMs();
  try {
    result = await Promise.race([
      handler(payload, ctx),
      sleep(timeoutMs, TIMEOUT_SENTINEL),
    ]);
  } catch (err) {
    // Last-ditch net. The handler crashed — log and move on. Do NOT print
    // anything to stdout: Claude Code would try to parse it as JSON.
    process.stderr.write(
      `sextant: handler error event=${eventName} sid=${sessionId} err=${err.message}\n${err.stack}\n`,
    );
    // Fail-open observability (cerebrum-v2 §10.1, PROVISIONAL): record the
    // degradation to hooks.log so "silently injected nothing" is detectable.
    try { await appendLog(sessionId, { ts: isoNow(), event: eventName, degraded: 'handler_error', err: err.message }, cwd); } catch {}
    return 0;
  }

  if (result === TIMEOUT_SENTINEL) {
    // Handler is still running but exceeded the wall-clock budget. The
    // pending promise will be GC'd when the process exits. We swallow the
    // result and exit 0 — Claude Code sees a no-op rather than a hang.
    process.stderr.write(
      `sextant: handler timeout event=${eventName} sid=${sessionId} budget_ms=${timeoutMs}\n`,
    );
    try { await appendLog(sessionId, { ts: isoNow(), event: eventName, degraded: 'timeout', budget_ms: timeoutMs }, cwd); } catch {}
    return 0;
  }

  if (result !== undefined && result !== null) {
    try {
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      process.stderr.write(`sextant: stdout-write error event=${eventName} err=${err.message}\n`);
    }
  }

  return 0;
}

// Run only when invoked as a script (not when imported by tests).
const isEntry = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isEntry) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      // Truly catastrophic — main itself threw despite its inner guards.
      process.stderr.write(`sextant: fatal dispatcher error err=${err.message}\n${err.stack}\n`);
      process.exit(0);
    });
}
