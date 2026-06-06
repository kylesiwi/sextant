// lib/hooks/sessionStart.mjs — SessionStart handler.
//
// Phase 0 responsibilities (PRESERVED):
//   - Log the fire to runtime/hooks.log.
//   - Initialize / refresh statusline-state.json. We pick an A/B arm
//     deterministically from the session_id so a given session always lands
//     on the same arm (reproducibility for Phase 8 measurements).
//   - Do NOT reset cumulative counters here; SessionStart can re-fire after
//     /clear and we want longitudinal totals to survive that.
//
// Phase 1a additions (§ 5.1):
//   - Read .sextant/project.md (if present) and surface verbatim as the
//     additionalContext preamble.
//   - Read .sextant/session/last.json (if present) and render "where we left
//     off" line. Minimal accepted shape: { ended_at, focus, open_todos: [] }.
//   - Stat .sextant/graph/graph.json: if older than staleness_threshold_hours
//     (default 24), mark state.graph.state = 'stale' and emit a one-shot
//     systemMessage subject to § 4.5.1's suppression policy
//     (key `graph_stale`).
//   - Return SessionStart's documented JSON shape:
//       { hookSpecificOutput: { hookEventName: 'SessionStart',
//                               additionalContext: '<marker-fenced block>' },
//         systemMessage?: '...' }
//     Per Anthropic's hooks docs, additionalContext on SessionStart goes
//     inside hookSpecificOutput (verified via the hooks reference page
//     before this implementation landed).
//
// Future phases will add: runtime-dir sweep (§ 5.1.5), cerebrum preload,
// background graph rebuild, etc. None of that lands here.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { withState, withPathLock } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { durableBase, durableFile, runtimeBase, turnStatePath, lastJsonPath } from '../paths.mjs';
import { readJson, readModifyJson } from '../io.mjs';
import { loadGraph, graphStats as computeGraphStats } from '../graph/read.mjs';
import { composeSessionStartBlock, relativeTime } from './composeSessionStart.mjs';
import { readResolvedCerebrum, autoMigrateIfNeeded, lineHash } from '../stores/cerebrum.mjs';
import { bumpSessionCount, defaultStats } from '../stores/stats.mjs';
import { readBugs, countOpenBugs } from '../stores/bugs.mjs';
import { readTranches, activeTranche, readTrancheDoc, resetSessionCaptures } from '../stores/tranches.mjs';
import { readCaptureNudgeMode } from '../config.mjs';

// Default staleness threshold for the AST graph in hours. § 5.1 says
// "default 24"; keep it tunable via SEXTANT_STALENESS_HOURS for testing /
// debugging without a config-file round trip.
const DEFAULT_STALENESS_HOURS = 24;

// Default age threshold (hours) for sweeping orphaned per-session runtime
// dirs left behind by crashed hooks. § 5.1.5 sketches a SessionStart sweep;
// state.mjs:7-8 calls it out as the recovery mechanism for leaked lockfiles.
// Tunable via SEXTANT_SWEEP_AGE_HOURS so tests can force-delete recent dirs.
const DEFAULT_SWEEP_AGE_HOURS = 24;

function getStalenessHours() {
  const raw = process.env.SEXTANT_STALENESS_HOURS;
  if (raw === undefined || raw === '') return DEFAULT_STALENESS_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STALENESS_HOURS;
  return n;
}

function getSweepAgeHours() {
  const raw = process.env.SEXTANT_SWEEP_AGE_HOURS;
  if (raw === undefined || raw === '') return DEFAULT_SWEEP_AGE_HOURS;
  const n = Number(raw);
  // Allow fractional hours (tests use 0.0001) but reject non-finite / negative.
  // Zero is allowed: cutoff = now, so dirs with mtime < now (i.e. essentially
  // every existing dir) become eligible.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SWEEP_AGE_HOURS;
  return n;
}

// SessionStart-time recovery sweep. The runtime dir layout is
// <cwd>/.sextant/runtime/sextant-<sid>/; if a hook crashes while holding
// state.mjs's O_EXCL lockfile, the whole subtree leaks. This walks the parent
// dir, finds sibling sextant-* directories whose mtime is older than the
// cutoff, and removes them recursively. Best-effort: every error is swallowed
// after a stderr log line. The current session's directory is always skipped.
//
// Exported so the test suite can exercise the directory-pruning logic without
// driving a full SessionStart payload through the dispatcher.
export async function sweepStaleRuntimeDirs(currentSessionId, cwd) {
  try {
    const parent = path.dirname(runtimeBase(currentSessionId, cwd));
    const selfDir = `sextant-${currentSessionId}`;
    const ageHours = getSweepAgeHours();
    const cutoff = Date.now() - ageHours * 60 * 60 * 1000;

    let entries;
    try {
      entries = await fs.readdir(parent, { withFileTypes: true });
    } catch (err) {
      // Parent missing (e.g. brand-new project tree with no prior runtime
      // dir) is the common case on a fresh boot; not worth logging at ENOENT.
      if (err.code !== 'ENOENT') {
        process.stderr.write(`sextant: sessionStart sweep readdir err=${err.message}\n`);
      }
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!ent.name.startsWith('sextant-')) continue;
      if (ent.name === selfDir) continue;

      const dirPath = path.join(parent, ent.name);
      try {
        const st = await fs.stat(dirPath);
        if (st.mtimeMs >= cutoff) continue;
      } catch (err) {
        process.stderr.write(`sextant: sessionStart sweep stat ${dirPath} err=${err.message}\n`);
        continue;
      }

      try {
        await fs.rm(dirPath, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`sextant: sessionStart sweep rm ${dirPath} err=${err.message}\n`);
      }
    }
  } catch (err) {
    // Outer guard: nothing inside the try should bubble, but if it does we
    // must NOT let SessionStart fail — sessionStart is the entry point for
    // every other hook's state.
    process.stderr.write(`sextant: sessionStart sweep err=${err.message}\n`);
  }
}

// Deterministic A/B selection from session_id. First byte of sha256 % 2.
// SHA-256 spreads small input variation uniformly across the output, so
// using byte[0] mod 2 gives a 50/50 split that is reproducible across
// restarts of the same session.
export function pickArm(sessionId) {
  const digest = crypto.createHash('sha256').update(sessionId).digest();
  return (digest[0] % 2 === 0) ? 'A' : 'B';
}

// Read a UTF-8 file, returning null on ENOENT or any read failure. We don't
// want a missing/broken project.md to crash SessionStart — best-effort.
async function readTextOrNull(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

// Stat the graph file: returns { exists, mtimeMs } or { exists: false }.
async function statGraph(graphPath) {
  try {
    const st = await fs.stat(graphPath);
    return { exists: true, mtimeMs: st.mtimeMs };
  } catch (err) {
    return { exists: false };
  }
}

export default async function sessionStart(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;

  // Recovery sweep FIRST — before any other state I/O. A leaked lockfile from
  // a prior session would otherwise wedge withState() below until its timeout.
  // Wrapped in try/catch defensively even though sweepStaleRuntimeDirs is
  // already best-effort, because SessionStart must never crash: it's the
  // entry point for everything else.
  try {
    await sweepStaleRuntimeDirs(sid, cwd);
  } catch (err) {
    process.stderr.write(`sextant: sessionStart sweep wrapper err=${err.message}\n`);
  }

  await ctx.log({ ts: ctx.nowIso(), event: 'SessionStart', sid, cwd });

  // 1. Read project.md, last.json, and stat graph.json in parallel. All three
  //    are best-effort; a failure here must never break the hook.
  let projectMd = null;
  let lastJson = null;
  let graphInfo = { exists: false };
  let graphFiles = null;
  let graphBuiltAtMs = null;
  let globalRules = [];
  // cerebrum-v2 T5.5: the format-gate baseline. null = store not read (Stop gate
  // self-seeds + skips); [] = empty store; [hashes] = existing rules at session
  // start (so only rules ADDED during the session get gated).
  let cerebrumRuleHashes = null;
  let trancheState = null;
  let migrationMessage = null; // T3.5/R3 auto-heal banner (set below if a v1 store was migrated/failed)
  let migrationCategory = 'transition'; // 'error' for the migration-failed variant
  let trancheDocParsed = null;

  if (cwd) {
    const projectMdPath = durableFile(cwd, 'project.md');
    const graphPath = path.join(durableBase(cwd), 'graph', 'graph.json');
    const cerebrumDir = path.dirname(durableFile(cwd, path.join('cerebrum', 'cerebrum.md')));

    // cerebrum-v2 T3.5/R3 — auto-heal: with v1 reads retired, an un-migrated store
    // would resolve to a SILENTLY EMPTY cerebrum. Migrate it once (validated +
    // backed up) BEFORE the read below, and surface the outcome. Never throws; a
    // failure becomes a warning rather than a silent empty store.
    try {
      const heal = await autoMigrateIfNeeded(cerebrumDir);
      if (heal.status === 'migrated') {
        migrationMessage = `migrated ${heal.count} cerebrum rule(s) to the v2 one store (backup at .sextant/backups/cerebrum-pre-v2/). Review with /doctor.`;
        migrationCategory = 'transition';
      } else if (heal.status === 'failed') {
        migrationMessage = `a v1 cerebrum was detected but could NOT be auto-migrated (${heal.error}). Rules are NOT firing until you run \`cerebrum migrate\` from a terminal (cerebrum.md was not written).`;
        migrationCategory = 'error';
      }
    } catch (err) {
      process.stderr.write(`sextant: sessionStart auto-heal err=${err.message}\n`);
    }

    // Stat the graph alongside the project.md / last.json reads. The stat is
    // cheap and we need its mtime as a fallback when built_at is missing.
    // The cerebrum is read through the resolver: the one store (cerebrum.md,
    // buckets normalized to the canonical predicate names) — so [!global] rules
    // surface once at SessionStart. The auto-heal above already migrated any
    // un-migrated v1 store before this read.
    const [pmd, last, gInfo, graph, cerebrum] = await Promise.all([
      readTextOrNull(projectMdPath),
      readJson(lastJsonPath(cwd)),
      statGraph(graphPath),
      loadGraph(cwd),
      readResolvedCerebrum(cerebrumDir).then((r) => r.parsed).catch(() => null),
    ]);
    projectMd = pmd;
    lastJson = last;
    graphInfo = gInfo;

    if (cerebrum && Array.isArray(cerebrum.lines)) {
      cerebrumRuleHashes = [];
      for (const e of cerebrum.lines) {
        if (!e || e.kind !== 'rule') continue;
        if (typeof e.raw === 'string') cerebrumRuleHashes.push(lineHash(e.raw));
        if (!Array.isArray(e.buckets)) continue;
        if (!e.buckets.includes('!')) continue;
        if (!e.buckets.includes('!global')) continue;
        globalRules.push(e);
      }
    }

    // loadGraph returns null for missing / malformed / schema-mismatched
    // graphs (it already warns once via stderr). When we get a valid graph
    // back, computeGraphStats gives us files/edges/built_at in one call. Fall
    // back to mtime only when built_at is missing — the staleness check still
    // works in that case.
    if (graph) {
      const stats = computeGraphStats(graph);
      graphFiles = stats.files;
      if (typeof stats.built_at === 'string') {
        const t = Date.parse(stats.built_at);
        graphBuiltAtMs = Number.isFinite(t) ? t : null;
      }
      if (graphBuiltAtMs === null && typeof gInfo.mtimeMs === 'number') {
        graphBuiltAtMs = gInfo.mtimeMs;
      }
    }

    // Read tranches state + active tranche doc for session orientation.
    try {
      const tState = await readTranches(cwd);
      const active = activeTranche(tState);
      if (active) {
        resetSessionCaptures(tState);
        const { writeTranches } = await import('../stores/tranches.mjs');
        await writeTranches(cwd, tState);

        trancheState = tState;
        if (active.doc_path) {
          try {
            trancheDocParsed = await readTrancheDoc(cwd, active.doc_path);
          } catch {}
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: sessionStart tranches read err=${err.message}\n`);
    }
  }

  // 2. Staleness check (§ 5.1). The graph is "stale" if it exists AND its
  //    built_at (or mtime fallback) is older than the threshold. Missing
  //    graph is NOT "stale" — the user hasn't built one yet; that's a
  //    different surface (Phase 1b /init nudge).
  const stalenessHours = getStalenessHours();
  const now = Date.now();
  let isStale = false;
  if (graphInfo.exists && graphBuiltAtMs !== null) {
    const ageMs = now - graphBuiltAtMs;
    if (ageMs > stalenessHours * 60 * 60 * 1000) {
      isStale = true;
    }
  }

  // 3. State write: arm + last_event, and (Phase 1a) graph.state = 'stale'
  //    when applicable, plus the systemMessage suppression key when we end
  //    up emitting one. We also check the existing suppression state inside
  //    the mutator so we never emit the same message twice in one session.
  const arm = pickArm(sid);

  // We need to know AFTER state write whether the suppression bit was newly
  // set (to decide whether to emit the systemMessage). The mutator captures
  // that by mutating a closure-local flag.
  // graph-stale + migration messages are emitted via the shared helper after all
  // withState blocks (the helper owns suppression via its own lock + a
  // session-scoped key). `isStale` (computed above) is the only flag we need here.

  // Sync open-bug count so the statusline has accurate state from the very
  // first refresh, before any PostToolUse sweep runs. Best-effort: only
  // overwrite when bugs.json actually exists — a missing file must NOT
  // zero the cumulative counter (§ 6.5: bugs.open persists across
  // SessionStart re-fires, e.g. /clear). readBugs() returns [] on ENOENT
  // which is indistinguishable from a legitimately empty bugs.json, so we
  // stat first and only sync when the file is present.
  let initialOpenBugs = null;
  if (cwd) {
    try {
      const bugsPath = path.join(durableBase(cwd), 'bugs.json');
      await fs.stat(bugsPath);
      const bugs = await readBugs(durableBase(cwd));
      if (Array.isArray(bugs)) initialOpenBugs = countOpenBugs(bugs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`sextant: sessionStart bugs.open sync err=${err.message}\n`);
      }
    }
  }

  await withState(sid, cwd, (state) => {
    state.ab_arm = arm;
    state.last_event = { tag: 'SessionStart', ts: ctx.nowIso(), detail: 'idle' };

    // cerebrum-v2 T5.5: baseline the format-gate accepted-hash set to the rules
    // present at session start. Only rules ADDED during the session are then
    // gated at Stop. Skip when the store wasn't read (null) — the Stop gate will
    // self-seed on its first run. Reset the per-session gate counters.
    if (cerebrumRuleHashes !== null) {
      state.cerebrum_accepted_hashes = cerebrumRuleHashes;
      state.cerebrum_format_block_count = 0;
      state.cerebrum_last_failing = [];
    }

    state.bugs = state.bugs ?? { open: 0 };
    if (initialOpenBugs !== null) state.bugs.open = initialOpenBugs;

    state.graph = state.graph ?? { state: 'idle', last_rebuild_ts: null, dirty_count: 0 };

    // Seed last_rebuild_ts from the on-disk graph's built_at (or mtime
    // fallback). Without this, a fresh session enters with last_rebuild_ts =
    // null, which postToolUse's rebuild trigger treats as Infinity staleness
    // and fires immediately on the first project edit — wasted compute when
    // the graph is actually fresh. Only seed when we have a usable timestamp
    // AND the field isn't already populated by a prior session.
    if (graphBuiltAtMs !== null && state.graph.last_rebuild_ts === null) {
      state.graph.last_rebuild_ts = graphBuiltAtMs;
    }

    if (isStale) {
      state.graph.state = 'stale';
    }
  }, { abArm: arm });

  // Bump the cumulative session counter. Best-effort — a failure here must
  // not break SessionStart. Lives under .sextant/stats.json so it survives
  // across runtime-dir wipes. Uses withPathLock so two CC sessions in the
  // same project don't clobber each other.
  if (cwd) {
    try {
      const statsPath = durableFile(cwd, 'stats.json');
      await withPathLock(statsPath, (stats) => {
        const cur = (stats && typeof stats === 'object') ? stats : defaultStats();
        bumpSessionCount(cur);
        return cur;
      }, { defaultValue: defaultStats() });
    } catch (err) {
      process.stderr.write(`sextant: sessionStart bumpSessionCount err=${err.message}\n`);
    }
  }

  // Phase 2b § 5.8.3: seed turn-state.json with the current turn's start
  // timestamp + turn_id=1. Subsequent UserPromptSubmit fires increment
  // turn_id and reset started_at. PostToolUse reads started_at to decide
  // whether a project-file edit happened "this turn".
  //
  // Read-modify-write preserves any other fields (pending_restore from a
  // prior PreCompact, dedup keys, etc.).
  try {
    await readModifyJson(turnStatePath(sid, cwd), (o) => {
      o.started_at = new Date().toISOString();
      o.turn_id = 1;
    });
  } catch (err) {
    process.stderr.write(`sextant: sessionStart turn-state seed err=${err.message}\n`);
  }

  // Plugin root derived from THIS file's location. CLAUDE_PLUGIN_ROOT is not
  // reliably injected into every subprocess (issue #27145), so never trust the
  // env var for path resolution — import.meta.url is the installed version's
  // actual location.
  let pluginRoot = null;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    pluginRoot = path.resolve(here, '..', '..');
  } catch {}

  // Export SEXTANT_ROOT into CLAUDE_ENV_FILE so subsequent Bash-tool calls in
  // this session see a stable plugin-root handle (CLAUDE_PLUGIN_ROOT is only
  // injected into hook subprocesses, not Bash-tool invocations — issue #27145).
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile && pluginRoot) {
    try {
      await writeSessionEnvFile({ envFile, pluginRoot });
    } catch (err) {
      process.stderr.write(`sextant: sessionStart env-file err=${err.message}\n`);
    }
  }

  // 4. Compose the additionalContext block. graphStats is only meaningful
  //    if we successfully read at least the file count.
  const graphStats = (graphFiles !== null)
    ? { files: graphFiles, builtAtMs: graphBuiltAtMs }
    : null;

  const captureNudgeOn = (await readCaptureNudgeMode(cwd)) !== 'off';
  const block = composeSessionStartBlock({
    projectMd,
    lastJson,
    graphStats,
    isStale,
    globalRules,
    trancheState,
    trancheDocParsed,
    captureNudge: captureNudgeOn,
    now: () => now,
  });

  // Record the active-tranche snapshot in hot state. NOTE: deliverables_summary
  // here is now vestigial — UserPromptSubmit reads the doc live each turn (via
  // readTrancheDeliverables) so the nudge can't go stale. Kept as a hot-state
  // snapshot; no consumer reads this cached field anymore (the statusline that
  // formerly rendered it was removed pending a safety-first rebuild).
  if (trancheState && trancheDocParsed) {
    try {
      await withState(sid, cwd, (state) => {
        state.tranche = {
          feature: trancheState.feature,
          active_id: trancheState.active_tranche_id,
          status: activeTranche(trancheState)?.status || null,
          workflow_state: trancheState.workflow_state,
          doc_path: activeTranche(trancheState)?.doc_path || null,
          deliverables_summary: trancheDocParsed.deliverables_summary || null,
        };
      });
    } catch (err) {
      process.stderr.write(`sextant: sessionStart tranche hot-state cache err=${err.message}\n`);
    }
  }

  // 5. Build the result envelope per SessionStart's documented JSON shape.
  //    Per Anthropic hooks docs (verified): additionalContext for SessionStart
  //    lives under hookSpecificOutput.{hookEventName, additionalContext}.
  //    Other top-level fields (systemMessage) are universal.
  let result = {};
  if (block !== null) {
    result.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: block,
    };
  }
  // The auto-heal banner (T3.5/R3) takes precedence over the stale-graph nudge:
  // it's one-time and concerns rules not firing (data integrity), so it wins the
  // single systemMessage slot the rare session both apply. Both are session-scoped
  // (once per session) and emitted via the shared helper AFTER every withState
  // block above — the helper takes its own lock and must not run inside one.
  if (migrationMessage !== null) {
    result = await mergeSystemMessage(result, migrationMessage, {
      category: migrationCategory, level: 'transition', key: 'cerebrum_autoheal', scope: 'session', sid, cwd,
    });
  } else if (isStale) {
    result = await mergeSystemMessage(
      result,
      `graph is stale (> ${stalenessHours}h old). Run /sextant:graph-build to refresh.`,
      { category: 'info', level: 'transition', key: 'graph_stale', scope: 'session', sid, cwd },
    );
  }

  // T3-E: restored-session lifecycle line. A present last.json means a prior
  // session left a checkpoint, so this session resumes continuity — surface it
  // once (session-scoped key). A clean first session (no last.json) stays silent.
  // Independent of the migration/stale slot above: continuity is a different
  // concern, and mergeSystemMessage composes multiple lines.
  if (lastJson && typeof lastJson === 'object'
      && (typeof lastJson.ended_at === 'string' || typeof lastJson.focus === 'string')) {
    let when = null;
    if (typeof lastJson.ended_at === 'string') {
      const t = Date.parse(lastJson.ended_at);
      if (Number.isFinite(t)) when = relativeTime(now - t);
    }
    const text = when
      ? `restored session — last active ${when}`
      : 'restored session from the previous checkpoint';
    result = await mergeSystemMessage(result, text, {
      category: 'transition', level: 'transition', key: 'session_restored', scope: 'session', sid, cwd,
    });
  }

  // If we have nothing to say, return undefined so the dispatcher writes
  // nothing to stdout (avoids burning context on an empty JSON envelope).
  if (Object.keys(result).length === 0) return undefined;
  return result;
}

// Append `export SEXTANT_ROOT='<pluginRoot>'` to the env file Claude Code
// sources before each Bash-tool call. Single-quoted with embedded `'` escaped
// as `'\''` for shell safety. Throws on failure — caller wraps best-effort.
export async function writeSessionEnvFile({ envFile, pluginRoot }) {
  const escaped = pluginRoot.replace(/'/g, `'\\''`);
  const line = `export SEXTANT_ROOT='${escaped}'\n`;
  await fs.appendFile(envFile, line, 'utf8');
}
