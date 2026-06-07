// lib/hooks/postToolUse.mjs — PostToolUse handler.
//
// Phase 0: log only. We try to infer success from tool_response.is_error;
// this is best-effort because the schema of tool_response varies per tool
// (Read/Edit/Write have different shapes). The flag is just a JSONL
// observation, not load-bearing for any state mutation.
//
// Phase 2b additions (§ 5.8 + § 5.8.3):
//   - On Edit/Write/MultiEdit to a project file (not under .sextant/), write
//     { path: <relpath-from-cwd>, ts: <iso-now> } to
//     last_project_file_edit.json. This feeds the auto-tagger when a cerebrum
//     write follows in the same turn.
//   - On Edit/Write/MultiEdit to a cerebrum file
//     (.sextant/cerebrum/{regular,mandatory}.md): run autoTagFile with the
//     current turn's start timestamp + lastProjectFileEdit, update statusline
//     auto_tag counters + review_queue_depth, and emit a one-shot
//     systemMessage on low-confidence outcomes (suppression key
//     'auto_tag_low_conf' per § 4.5.1).
//
// All Phase 2b paths are best-effort: any failure is logged to stderr but
// must NOT crash the dispatcher. The base log line is always emitted first.

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { withState, readState } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { writeJsonAtomic, readJson } from '../io.mjs';
import {
  lastProjectFileEditPath,
  turnStatePath,
  durableFile,
  durableBase,
  testRunPendingFlagPath,
  commitPendingFlagPath,
  rulesAuthoredPath,
  ensureRuntimeDir,
} from '../paths.mjs';
import { autoTagFile } from '../capture/auto-tag.mjs';
import { readCerebrumFile, readResolvedCerebrum, listReviewQueue } from '../stores/cerebrum.mjs';
import { readBugs, writeBugs, tagBugSymbol, countOpenBugs } from '../stores/bugs.mjs';
import { loadGraph } from '../graph/read.mjs';
import { parseTestOutput } from '../capture/test-detector.mjs';
import { snapshotEdits } from '../capture/commit-snapshot.mjs';
import { appendEdit, readEdits, resetEdits } from '../capture/edits.mjs';
import { flagExists, rmFlag } from './flags.mjs';
import { readStats, writeStats, migrateRuleFires } from '../stores/stats.mjs';
import { markContradicted } from '../promotion/contradictions.mjs';
import { readTranches, writeTranches, activeTranche, recordCapture } from '../stores/tranches.mjs';

// Tools whose edits we track. MultiEdit also lands here (one event per call).
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// Cerebrum file basenames we watch. cerebrum-v2 (T3.5): cerebrum.md is the live
// store; regular/mandatory are retired but still watched (frozen backups).
const CEREBRUM_BASENAMES = new Set(['cerebrum.md', 'regular.md', 'mandatory.md']);

// Decide whether an absolute path looks like one of the cerebrum files. We
// compare against <cwd>/.sextant/cerebrum/<basename> so a project that happens
// to have a "cerebrum.md" elsewhere is unaffected.
function isCerebrumFile(absFilePath, cwd) {
  if (!cwd || typeof absFilePath !== 'string') return null;
  for (const [name, kind] of [['cerebrum.md', 'cerebrum'], ['regular.md', 'regular'], ['mandatory.md', 'mandatory']]) {
    if (absFilePath === durableFile(cwd, path.join('cerebrum', name))) return kind;
  }
  return null;
}

// Project files = anything NOT under <cwd>/.sextant/. Returns the relative
// path from cwd, or null if the file is outside cwd or under .sextant/.
function projectRelpath(absFilePath, cwd) {
  if (!cwd || typeof absFilePath !== 'string') return null;
  const resolved = path.resolve(absFilePath);
  const cwdResolved = path.resolve(cwd);
  if (!resolved.startsWith(cwdResolved + path.sep) && resolved !== cwdResolved) {
    return null; // outside cwd
  }
  const rel = path.relative(cwdResolved, resolved);
  if (rel.startsWith('.sextant/') || rel === '.sextant' || rel.startsWith('.sextant' + path.sep)) {
    return null; // under .sextant/
  }
  if (rel.startsWith('..')) return null;
  return rel;
}

// 8-char SHA1 prefix — matches the suppression-key shape that
// postToolUseFailure.mjs uses so they share keys. Duplicated here rather
// than imported to keep handler files self-contained (each is small).
function sha1Short(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 8);
}

// Clear the stuck-counter (and its one-shot suppression key) if the (tool,
// file) the user just successfully ran matches the one we were tracking.
// Different (tool, file) successes leave state.stuck alone — a stuck burst
// on file_a shouldn't be cleared just because the agent successfully
// edited file_b. Mutator-only function; lock acquired inside withState.
async function maybeClearStuckOnSuccess({ sid, tool, filePath, cwd }) {
  if (!tool || !filePath) return;
  await withState(sid, cwd, (s) => {
    const stuck = s.stuck;
    if (!stuck || stuck.tool !== tool || stuck.file !== filePath) return;
    s.stuck = { tool: null, file: null, count: 0 };
    const key = `stuck_${tool}_${sha1Short(filePath)}`;
    if (s.systemmessage_fired && Object.prototype.hasOwnProperty.call(s.systemmessage_fired, key)) {
      const next = { ...s.systemmessage_fired };
      delete next[key];
      s.systemmessage_fired = next;
    }
  });
}

// Record a project-file edit. Best-effort; failures are swallowed.
async function recordProjectEdit(sid, relPath, tsIso, cwd) {
  try {
    await writeJsonAtomic(lastProjectFileEditPath(sid, cwd), { path: relPath, ts: tsIso });
  } catch (err) {
    process.stderr.write(`sextant: postToolUse recordProjectEdit err=${err.message}\n`);
  }
}

// Read turn-state.started_at, falling back to now (ISO) if missing or
// unparseable. The auto-tagger only uses this to compare against
// lastProjectFileEdit.ts.
async function readTurnStartTs(sid, nowIso, cwd) {
  const obj = await readJson(turnStatePath(sid, cwd));
  if (obj && typeof obj.started_at === 'string') {
    const t = Date.parse(obj.started_at);
    if (Number.isFinite(t)) return obj.started_at;
  }
  return nowIso;
}

// Read turn_id off turn-state.json (or 0 if missing). Used for FileChanged
// suppression keys, but read here too so callers don't duplicate the lookup.
async function readTurnId(sid, cwd) {
  const obj = await readJson(turnStatePath(sid, cwd));
  if (obj && typeof obj.turn_id === 'number' && Number.isFinite(obj.turn_id)) {
    return obj.turn_id;
  }
  return 0;
}

// Compute current review-queue depth by re-parsing the cerebrum file. Counts
// rules tagged [!review] or [ai-provisional]. We re-parse the file (rather
// than incrementing on the fly) because autoTagFile may have replaced rules
// in place and we want statusline to reflect ground truth.
async function reviewQueueDepth(cerebrumPath) {
  try {
    const parsed = await readCerebrumFile(cerebrumPath);
    return listReviewQueue(parsed).length;
  } catch (err) {
    // Best-effort: missing file or parse error → 0.
    return 0;
  }
}

export default async function postToolUse(payload, ctx) {
  const sid = payload.session_id;
  const sidCwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const tool = payload.tool_name ?? null;
  // tool_response may be absent, null, an object, a string, etc. Coerce
  // safely and never throw.
  let ok = true;
  const tr = payload.tool_response;
  if (tr && typeof tr === 'object' && 'is_error' in tr) {
    ok = !tr.is_error;
  }

  await ctx.log({ ts: ctx.nowIso(), event: 'PostToolUse', sid, tool, ok });

  // Phase 5 § 5.9: Bash → consume the pending flags set by PreToolUse Bash.
  // Returns early either way; Bash never falls through into the
  // Edit/Write/MultiEdit auto-tag path below.
  if (tool === 'Bash') {
    try {
      const bashResult = await handleBashPostToolUse({ payload, sid, ctx });
      if (bashResult) return bashResult;
    } catch (err) {
      process.stderr.write(`sextant: postToolUse Bash err=${err.message}\n`);
    }
    return undefined;
  }

  // Phase 2b path: only run on successful Edit/Write/MultiEdit with a
  // file_path. Anything else is just the Phase 0 log line.
  if (!ok) return undefined;
  if (!EDIT_TOOLS.has(tool)) return undefined;

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const filePath = payload.tool_input && typeof payload.tool_input.file_path === 'string'
    ? payload.tool_input.file_path
    : null;
  if (!cwd || !filePath) return undefined;

  // Stuck-state reset (§ 5.10 companion). postToolUseFailure tracks
  // consecutive failures of the same (tool, file). When that same (tool,
  // file) finally succeeds, clear the counter so a new stuck burst can be
  // detected cleanly later. We also drop the suppression key so a future
  // burst on the same target can re-emit the nudge. Best-effort.
  try {
    await maybeClearStuckOnSuccess({ sid, tool, filePath, cwd });
  } catch (err) {
    process.stderr.write(`sextant: postToolUse stuck-reset err=${err.message}\n`);
  }

  const cerebrumKind = isCerebrumFile(filePath, cwd);

  // Phase 3: Bug-store sweep runs on every Edit/Write/MultiEdit (cwd known)
  // independent of which file we touched. Throttled to once per 5s per
  // session so we don't burn IO rewriting bugs.json on every keystroke.
  // Errors are best-effort (logged + swallowed) — never crash the hook.
  let sweepResult = null;
  try {
    sweepResult = await runBugSweep({ sid, cwd, ctx });
  } catch (err) {
    process.stderr.write(`sextant: postToolUse bug-sweep err=${err.message}\n`);
  }
  if (sweepResult && (sweepResult.tagged > 0 || sweepResult.untagged > 0)) {
    await ctx.log({
      ts: ctx.nowIso(),
      event: 'PostToolUse:bug-sweep',
      sid,
      tagged: sweepResult.tagged,
      untagged: sweepResult.untagged,
    });
  }

  // Branch 1: project file (not under .sextant/). Record the edit so a
  // subsequent cerebrum write can attribute new rules to this file.
  // Phase 5 § 5.8 (1): also append to runtime/edits.json so the next
  // commit snapshot can include it.
  if (cerebrumKind === null) {
    const rel = projectRelpath(filePath, cwd);
    if (rel !== null) {
      const ts = ctx.nowIso();
      await recordProjectEdit(sid, rel, ts, cwd);
      try {
        await appendEdit(sid, { path: rel, ts, kind: tool }, cwd);
      } catch (err) {
        process.stderr.write(`sextant: postToolUse appendEdit err=${err.message}\n`);
      }
      // § 5.8.4: increment graph.dirty_count; spawn rebuild when either the
      // dirty threshold is met or the last rebuild is older than the
      // staleness window. Best-effort: any failure is logged + swallowed
      // so this never blocks the hook.
      try {
        await maybeTriggerGraphRebuild({ sid, cwd });
      } catch (err) {
        process.stderr.write(`sextant: postToolUse graph-rebuild-trigger err=${err.message}\n`);
      }

      // Tranche scope-drift detection: if active tranche is IN-FLIGHT and
      // this file isn't in scope, emit a one-shot nudge.
      try {
        const tState = await readTranches(cwd);
        const active = activeTranche(tState);
        if (active && active.status === 'IN-FLIGHT' && Array.isArray(active.scope)) {
          if (!active.scope.includes(rel)) {
            const driftKey = `scope_drift_${crypto.createHash('md5').update(rel).digest('hex').slice(0, 8)}`;
            let shouldNudge = false;
            await withState(sid, cwd, (state) => {
              const fired = state.systemmessage_fired ?? {};
              if (!fired[driftKey]) {
                shouldNudge = true;
                state.systemmessage_fired = { ...fired, [driftKey]: true };
              }
            });
            if (shouldNudge) {
              // (Was nested under hookSpecificOutput.systemMessage — which does
              // not render; the helper emits a proper top-level systemMessage.)
              // Emitted after the lock; no key — deduped above via driftKey.
              return mergeSystemMessage(
                undefined,
                `editing ${rel} which is outside tranche T${active.id} scope (${active.scope.join(', ')}). Consider whether this belongs in a future tranche or if T${active.id} scope needs amending via /sextant:tranche-amend.`,
                { category: 'error', level: 'transition', sid, cwd },
              );
            }
          }
        }
      } catch (err) {
        process.stderr.write(`sextant: postToolUse scope-drift err=${err.message}\n`);
      }
    }
    return undefined;
  }

  // Branch 2: cerebrum write. Run the auto-tagger.
  try {
    const lastProjectFileEdit = await readJson(lastProjectFileEditPath(sid, cwd));
    const turnStartTs = await readTurnStartTs(sid, ctx.nowIso(), cwd);
    const today = new Date().toISOString().slice(0, 10);

    const result = await autoTagFile({
      filePath,
      lastProjectFileEdit,
      turnStartTs,
      today,
    });

    // Re-tagging rehashes any line it touched; carry each rule's fire history
    // across so an already-fired untagged rule doesn't orphan its counts.
    await migrateRuleFires(durableBase(cwd), result.rewrites);

    // After we wrote, remember the timestamp so FileChanged can tell apart
    // its own ripples from external edits.
    let cerebrumMtimeMs = null;
    try {
      const st = await fs.stat(filePath);
      cerebrumMtimeMs = st.mtimeMs;
    } catch { /* file just vanished; ignore */ }

    const queueDepth = await reviewQueueDepth(filePath);

    // Suppression: one-shot per turn for auto_tag_low_conf (systemmessage_fired
    // is cleared every Stop). Decided inside withState for atomicity; the helper
    // below only mode-gates + formats the message (no key — dedup is owned here).
    const suppressionKey = 'auto_tag_low_conf';
    let shouldEmit = false;

    await withState(sid, cwd, (state) => {
      state.auto_tag = state.auto_tag ?? { high_confidence: 0, low_confidence_review: 0 };
      state.auto_tag.high_confidence += result.high;
      state.auto_tag.low_confidence_review += result.low;
      state.review_queue_depth = queueDepth;
      if (cerebrumMtimeMs !== null) {
        state.cerebrum_last_write_ts = cerebrumMtimeMs;
      }

      if (result.low > 0) {
        const fired = state.systemmessage_fired ?? {};
        if (!fired[suppressionKey]) {
          shouldEmit = true;
          state.systemmessage_fired = { ...fired, [suppressionKey]: true };
        }
      }
    });

    if (shouldEmit) {
      // Phase 10: even when we're already emitting the auto-tag message, we
      // still want to refresh stats.contradicted so /sextant:review reads
      // current state on its next invocation. The contradiction surface
      // doesn't need its own systemMessage unless we discovered NEW conflicts
      // — see the contradiction-sweep block below for that path.
      try {
        await sweepContradictions({ cwd, filePath, sid });
      } catch (err) {
        process.stderr.write(`sextant: postToolUse contradictions(autotagPath) err=${err.message}\n`);
      }
      await maybeTrackRuleCapture(cwd);
      // Emit after the lock releases (helper takes its own); no key — deduped above.
      return mergeSystemMessage(
        undefined,
        'tagged a cerebrum line as [provisional] — run /sextant:triage to confirm scope.',
        { category: 'rules', level: 'transition', sid, cwd },
      );
    }

    // Phase 10 contradiction sweep — runs on every cerebrum write so the
    // stats.rule_fires[*].contradicted flag stays current. Emits a one-shot
    // systemMessage (turn-keyed) when the sweep finds NEW contradictions
    // beyond what was already recorded. Best-effort — never throws past
    // this point. See sweepContradictions() for the suppression key shape.
    try {
      const sweepOut = await sweepContradictions({ cwd, filePath, sid });
      if (sweepOut && sweepOut.newConflicts > 0) {
        const turnId = await readTurnId(sid, cwd);
        const suppKey = `contradiction_detected_${turnId}`;
        let emit = false;
        await withState(sid, cwd, (state) => {
          const fired = state.systemmessage_fired ?? {};
          if (!fired[suppKey]) {
            emit = true;
            state.systemmessage_fired = { ...fired, [suppKey]: true };
          }
        });
        if (emit) {
          return mergeSystemMessage(
            undefined,
            `cerebrum contradiction detected (${sweepOut.totalConflicts} active pair${sweepOut.totalConflicts === 1 ? '' : 's'}) — run /sextant:review.`,
            { category: 'error', level: 'transition', sid, cwd },
          );
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: postToolUse contradictions err=${err.message}\n`);
    }
  } catch (err) {
    process.stderr.write(`sextant: postToolUse auto-tag err=${err.message}\n`);
  }

  // Track cerebrum writes as rule captures for the tranche auto-capture gate.
  await maybeTrackRuleCapture(cwd);

  return undefined;
}

// Phase 10: re-run heuristic contradiction detection over BOTH cerebrum files
// (regular + mandatory) and refresh stats.rule_fires[*].contradicted. The
// auto-tagger may have changed a rule line, so we re-parse from disk rather
// than relying on the in-memory result.
//
// Returns { totalConflicts, newConflicts } so the caller can decide whether
// to emit a systemMessage (newConflicts > 0). totalConflicts is the post-
// sweep count of active pairs; newConflicts is how many pairs flipped from
// uncontradicted-or-absent → contradicted on THIS sweep.
//
// A/B-arm gating (§ 10.5):
//   The promotion ladder reads stats.rule_fires.contradicted. PreToolUse
//   only writes to stats.json on the treatment arm. To keep the ladder's
//   contradiction signal symmetric, we also restrict this hook's
//   write-through to the treatment arm — control-arm sessions skip the
//   sweep entirely. Detection itself is arm-independent, but persisting
//   the result would otherwise leak control-arm data into the durable
//   stats.json (forbidden by § 10.5).
//
// Best-effort: returns null on failure rather than throwing.
async function sweepContradictions({ cwd, filePath, sid }) {
  void filePath; // currently unused — kept for future per-file scoping
  if (!cwd) return null;

  // A/B gate. Mirror preToolUse.instrumentTreatmentArm's pattern: default
  // to control on read failure so we never accidentally pollute stats.json
  // from a session whose arm we couldn't determine.
  let arm = 'A';
  try {
    const state = await readState(sid, cwd);
    arm = state && typeof state.ab_arm === 'string' ? state.ab_arm : 'A';
  } catch {
    arm = 'A';
  }
  if (arm !== 'B') return null;

  const base = durableBase(cwd);
  // Read the one store (normalized) so cross-rule contradictions across the
  // whole cerebrum are caught.
  const cerebrumDir = path.dirname(durableFile(cwd, path.join('cerebrum', 'cerebrum.md')));
  const resolved = await readResolvedCerebrum(cerebrumDir);
  const combined = resolved.parsed;

  const stats = await readStats(base);
  // Snapshot pre-sweep contradicted flags so we can count NEW conflicts.
  const before = new Set();
  for (const [h, info] of Object.entries(stats.rule_fires || {})) {
    if (info && info.contradicted) before.add(h);
  }

  // Reset contradicted flags before we run the sweep — markContradicted only
  // sets true; if a rule was edited so its body no longer contradicts, we
  // want the flag cleared. Resetting then re-running is the simplest path.
  for (const info of Object.values(stats.rule_fires || {})) {
    if (info && typeof info === 'object') info.contradicted = false;
  }
  const totalConflicts = markContradicted(stats, combined);

  // Count rules newly-contradicted on this sweep.
  let newConflicts = 0;
  for (const [h, info] of Object.entries(stats.rule_fires || {})) {
    if (info && info.contradicted && !before.has(h)) newConflicts++;
  }
  // newConflicts counts rule HASHES not PAIRS — at least 2 hashes per pair,
  // so divide. We round up so any partial pair (e.g., a brand-new rule
  // conflicting with one previously flagged) still surfaces.
  newConflicts = Math.ceil(newConflicts / 2);

  // Stamp the arm we're observing under so /sextant:stats reports the same
  // 'B' marker preToolUse uses. (markContradicted may have allocated brand-
  // new rule_fires entries; the arm field stays consistent.)
  stats.ab_arm = 'B';
  await writeStats(base, stats);
  return { totalConflicts, newConflicts };
}

// Phase 3: sweep .sextant/bugs.json for entries missing graph_node and tag
// them via symbol-match against the project graph (or file-level fallback).
// Throttled to once per 5s per session. Returns null when skipped or
// { tagged, untagged } when it actually ran.
const BUG_SWEEP_THROTTLE_MS = 5000;

async function runBugSweep({ sid, cwd, ctx }) {
  // Throttle gate: peek the state for the last-sweep ts.
  const sinceLast = await checkAndUpdateBugSweepGate(sid, cwd);
  if (!sinceLast.shouldRun) return null;

  const base = durableBase(cwd);
  const bugs = await readBugs(base);

  // Sync open-bug count into statusline state regardless of whether the
  // (potentially expensive) symbol-tagging sweep runs below. Cheap derived
  // counter; throttled by the same 5s sweep gate so we don't hammer state.
  const openCount = Array.isArray(bugs) ? countOpenBugs(bugs) : 0;
  await withState(sid, cwd, (state) => {
    state.bugs = state.bugs ?? { open: 0 };
    state.bugs.open = openCount;
  });

  if (!Array.isArray(bugs) || bugs.length === 0) {
    return null;
  }
  // Are there any entries actually missing a graph_node? If not we can skip
  // the (potentially expensive) graph load.
  const anyMissing = bugs.some(
    (b) => b && typeof b === 'object' && (!b.graph_node || !b.graph_node_confidence),
  );
  if (!anyMissing) return null;

  let graph = null;
  try {
    graph = await loadGraph(cwd);
  } catch {
    graph = null;
  }
  const sweepResult = tagBugSymbol(bugs, graph);
  if (sweepResult.tagged === 0 && sweepResult.untagged === 0) {
    return null;
  }
  await writeBugs(base, sweepResult.bugs);
  void ctx; // ctx is used in caller for logging; nothing to do here.
  return { tagged: sweepResult.tagged, untagged: sweepResult.untagged };
}

// Returns { shouldRun: boolean }. Side-effect: if shouldRun, the gate is
// updated to "now" inside the same withState transaction so concurrent
// PostToolUse calls don't both sweep.
async function checkAndUpdateBugSweepGate(sid, cwd) {
  let shouldRun = false;
  await withState(sid, cwd, (state) => {
    const last = (state.bugs && typeof state.bugs.last_sweep_ts === 'number')
      ? state.bugs.last_sweep_ts
      : 0;
    const now = Date.now();
    if (now - last >= BUG_SWEEP_THROTTLE_MS) {
      shouldRun = true;
      state.bugs = state.bugs ?? { open: 0 };
      state.bugs.last_sweep_ts = now;
    }
  });
  return { shouldRun };
}

// Phase 5 § 5.9 — PostToolUse Bash. Two independent loops, both gated by
// sentinel flags set by PreToolUse Bash:
//
//   1. test-run-pending.flag → consume tool_response, mark recent unverified
//      bug entries as fix_verified (exit 0) OR emit a systemMessage prompt
//      (non-zero). Clear the flag either way.
//
//   2. commit-pending.flag → on a zero-exit-code commit, snapshot
//      runtime/edits.json to .sextant/session/<sid>/commits/<ts>.json and
//      reset the runtime edits list. Clear the flag.
//
// Both flags can fire on the same call (e.g., a wrapped command runs tests
// and then commits) — we honour each one. Returns either a hook envelope
// (when a systemMessage needs to surface) or null.
//
// **Notification deviation**: per § 5.9 the failure path should emit a
// `Notification` event. The verified Claude Code output schema for
// PostToolUse exposes `systemMessage` but no first-class Notification
// channel for hooks (Notification is an INPUT event, not an output one).
// Phase 5 settles for `systemMessage` per the task spec — it surfaces to
// the user in the same one-shot way the auto-tag low-confidence nudge
// does, with no statusline plumbing required.
async function handleBashPostToolUse({ payload, sid, ctx }) {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;

  // Verbose-only, user-facing capture-confirmation lines accumulated below and
  // emitted onto the envelope before any early return — so "logged bug-N" /
  // "captured N rule(s)" surface even on a plain capture turn (no test/commit
  // flag). routine level → suppressed unless output=verbose; no suppression key.
  let envelope = null;

  // Tranche bug-capture tracking: detect a real bug-log by its stdout
  // CONFIRMATION (the bare `bug-N` id the CLI prints), not the command text —
  // mirroring the rule path's bug-6 fix. A command that merely mentions
  // `bugs.mjs log` (a commit message, an echo) prints no confirmation, and a
  // failed `log` exits 1 with empty stdout, so neither falsely counts.
  try {
    await maybeTrackBugCapture(cwd, payload.tool_response);
    const bugId = bugLoggedId(payload.tool_response);
    if (bugId) {
      envelope = await mergeSystemMessage(envelope, `logged ${bugId}`,
        { category: 'rules', level: 'routine', sid, cwd });
    }
  } catch (err) {
    process.stderr.write(`sextant: postToolUse Bash/bug-capture err=${err.message}\n`);
  }

  // T3-B: log rule-authoring events so the Stop turn-summary can report
  // "authored N rule(s) this turn". Detect by the cerebrum CLI's append
  // CONFIRMATION in stdout (`Appended to cerebrum.md:`), NOT the command text —
  // matching the command string false-positives on any Bash call that merely
  // MENTIONS "cerebrum remember" (a git commit message, a `tranches amend
  // --text`, an echo/grep), which silently logged phantom authorings. The
  // confirmation line is emitted once per actually-appended rule, so count
  // occurrences. Per-session runtime log; best-effort, never throws.
  try {
    const appended = countCerebrumAppends(payload.tool_response);
    if (appended > 0) {
      await maybeTrackRuleAuthored(sid, cwd, ctx, appended);
      // bug-7: the tranche capture gate counts captures_this_session.rules, which
      // until now was bumped ONLY by a cerebrum-file Edit/Write — never by the
      // sanctioned `/sextant:remember` flow (which appends via the cerebrum CLI
      // through Bash). Wire it to the same robust stdout-confirmation signal the
      // rule-authoring counter uses, so a remember-by-CLI satisfies the gate.
      await maybeTrackRuleCapture(cwd);
      envelope = await mergeSystemMessage(envelope, `captured ${appended} rule${appended === 1 ? '' : 's'}`,
        { category: 'rules', level: 'routine', sid, cwd });
    }
  } catch (err) {
    process.stderr.write(`sextant: postToolUse Bash/rule-authored err=${err.message}\n`);
  }

  const testFlagPath = testRunPendingFlagPath(sid, cwd);
  const commitFlagPath = commitPendingFlagPath(sid, cwd);

  const [testFlag, commitFlag] = await Promise.all([
    flagExists(testFlagPath),
    flagExists(commitFlagPath),
  ]);

  if (!testFlag && !commitFlag) return envelope;

  if (testFlag) {
    try {
      const parsed = parseTestOutput(payload.tool_response);
      if (parsed.passed) {
        if (cwd) {
          const verifiedIds = await verifyRecentBugs(cwd, sid);
          if (Array.isArray(verifiedIds) && verifiedIds.length > 0) {
            envelope = await mergeSystemMessage(envelope,
              `tests passed — ${verifiedIds.length} bug${verifiedIds.length === 1 ? '' : 's'} verified (${verifiedIds.join(', ')})`,
              { category: 'rules', level: 'routine', sid, cwd });
          }
        }
        // T3-G: fail→pass recovery transition. last_test_passed is session-scoped
        // (survives resetTurnAndSession) so the flip is detected across turns.
        // Emit only on an actual flip from a known-failing state — a steady-green
        // run stays silent. Read+set inside the lock, emit AFTER it releases
        // (mergeSystemMessage takes its own lock; never nest).
        let wasFailing = false;
        try {
          await withState(sid, cwd, (s) => {
            wasFailing = s.last_test_passed === false;
            s.last_test_passed = true;
          });
        } catch {}
        if (wasFailing) {
          envelope = await mergeSystemMessage(
            null,
            'tests passing again',
            { category: 'info', level: 'transition', key: 'tests_recovered', scope: 'turn', sid, cwd },
          );
        }
      } else {
        try {
          await withState(sid, cwd, (s) => { s.last_test_passed = false; });
        } catch {}
        // Not inside a withState lock here, so the helper may own the one-shot
        // key (turn-scoped: nudge once per turn even across repeated test runs).
        envelope = await mergeSystemMessage(
          null,
          'test run failed; capture as bug? Run /sextant:bug-log to log.',
          { category: 'error', level: 'transition', key: 'test_failed', scope: 'turn', sid, cwd },
        );
      }
    } catch (err) {
      process.stderr.write(`sextant: postToolUse Bash/test err=${err.message}\n`);
    } finally {
      try { await rmFlag(testFlagPath); } catch { /* ignore */ }
    }
  }

  if (commitFlag) {
    try {
      // Per § 5.9 we only snapshot on exit_code 0. parseTestOutput's
      // pass/fail logic is identical (exit 0 + !is_error), so reuse it.
      const parsed = parseTestOutput(payload.tool_response);
      if (parsed.passed && cwd) {
        const edits = await readEdits(sid, cwd);
        if (edits.length > 0) {
          await snapshotEdits(cwd, sid, ctx.nowIso(), edits);
          await resetEdits(sid, cwd);
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: postToolUse Bash/commit err=${err.message}\n`);
    } finally {
      try { await rmFlag(commitFlagPath); } catch { /* ignore */ }
    }
  }

  return envelope;
}

// § 5.8.4 — Graph rebuild trigger.
//
// Called from the project-file branch of postToolUse on every successful
// Edit/Write/MultiEdit. Atomically increments state.graph.dirty_count and
// fires bin/graph-build.mjs as a detached subprocess when either:
//   - dirty_count >= SEXTANT_GRAPH_DIRTY_THRESHOLD (default 5), OR
//   - last_rebuild_ts is older than SEXTANT_STALENESS_HOURS hours (default 24).
//
// The trigger is best-effort: a successful spawn does NOT wait for the
// build to complete. The subprocess writes <cwd>/.sextant/graph/graph.json
// atomically; the next SessionStart re-reads it and refreshes state.graph
// (graph.json's built_at / mtime drives the staleness check there). This
// means the user won't see the "rebuilding → idle" transition reflected in
// the statusline mid-session — acceptable for v1.1 since bin/graph-build.mjs
// is a CLI that knows nothing about runtime state. (A future revision can
// pass --mark-done-sid <sid> and have the CLI update state on completion.)
//
// In-flight protection: state.graph.state === 'rebuilding' short-circuits
// re-entry. Two concurrent hooks can still race the readState outside the
// withState lock; worst case we spawn two builds and bin/graph-build.mjs's
// own write lock (per its design) makes the second a no-op overwrite.
async function maybeTriggerGraphRebuild({ sid, cwd }) {
  if (!sid || !cwd) return;

  // Peek state for currentState / lastRebuildTs (read outside the lock so
  // we can compute thresholds without holding the mutex through spawn).
  const snapshot = await readState(sid, cwd);
  const currentState = snapshot?.graph?.state ?? 'idle';
  if (currentState === 'rebuilding') return;

  const lastRebuildTs = snapshot?.graph?.last_rebuild_ts ?? null;
  const dirtyThreshold = parseEnvInt('SEXTANT_GRAPH_DIRTY_THRESHOLD', 5);
  const stalenessHours = parseEnvFloat('SEXTANT_STALENESS_HOURS', 24);
  const stalenessMs = stalenessHours * 3600 * 1000;

  // Atomic: bump dirty_count, decide, optionally claim 'rebuilding'.
  let shouldFire = false;
  await withState(sid, cwd, (s) => {
    s.graph = s.graph ?? { state: 'idle', last_rebuild_ts: null, dirty_count: 0 };
    s.graph.dirty_count = (s.graph.dirty_count ?? 0) + 1;
    const newDirty = s.graph.dirty_count;
    const staleAge = (typeof lastRebuildTs === 'number')
      ? Date.now() - lastRebuildTs
      : Infinity;
    if (newDirty >= dirtyThreshold || staleAge >= stalenessMs) {
      shouldFire = true;
      s.graph.state = 'rebuilding';
      // Reset so edits during this rebuild re-accumulate cleanly.
      s.graph.dirty_count = 0;
    }
  });

  if (!shouldFire) return;

  try {
    await spawnGraphRebuild({ cwd });
  } catch (err) {
    // Spawn failed (missing binary, permission, etc.). Roll back to 'stale'
    // so the next trigger retries instead of being permanently blocked by
    // a phantom 'rebuilding' flag.
    process.stderr.write(`sextant: postToolUse spawnGraphRebuild err=${err.message}\n`);
    try {
      await withState(sid, cwd, (s) => {
        s.graph = s.graph ?? { state: 'idle', last_rebuild_ts: null, dirty_count: 0 };
        s.graph.state = 'stale';
      });
    } catch { /* state write failed too — give up silently */ }
  }
}

// Detached subprocess spawn. The current hook MUST exit quickly because a
// graph build can take seconds; we hand it off and forget. The subprocess
// inherits process.env so SEXTANT_RUNTIME_BASE / SEXTANT_DURABLE_BASE / etc.
// (test-only overrides) propagate to bin/graph-build.mjs.
//
// Override hook for tests: SEXTANT_TEST_GRAPH_SPAWN_HOOK, when set, is the
// absolute path of a file the trigger will TOUCH instead of spawning. This
// lets test/graph-rebuild-trigger.test.mjs assert the trigger fires without
// actually starting a child process. SEXTANT_TEST_GRAPH_SPAWN_FAIL=1 forces
// a synthetic throw so the failure/rollback path is exercisable.
async function spawnGraphRebuild({ cwd }) {
  if (process.env.SEXTANT_TEST_GRAPH_SPAWN_FAIL === '1') {
    throw new Error('test-forced spawn failure');
  }
  const hookPath = process.env.SEXTANT_TEST_GRAPH_SPAWN_HOOK;
  if (hookPath) {
    // Record the call signature for the test to assert against.
    const payload = JSON.stringify({ cwd, ts: Date.now() }) + '\n';
    await fs.appendFile(hookPath, payload, 'utf8');
    return;
  }
  const { spawn } = await import('node:child_process');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.resolve(here, '..', '..', 'bin', 'graph-build.mjs');
  // bin/graph-build.mjs accepts --root (not --cwd); --quiet keeps stderr
  // clean while the orphaned process runs.
  const child = spawn(process.execPath, [cli, '--root', cwd, '--quiet'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SEXTANT_GRAPH_REBUILD_TRIGGERED: '1' },
  });
  child.unref();
}

function parseEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseEnvFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Mark every bug entry whose session_id matches `sid` and was logged
// within the last hour and lacks fix_verified as verified by the test pass.
// Best-effort: a write failure is caught + logged so the dispatcher
// doesn't propagate.
async function verifyRecentBugs(cwd, sid) {
  const base = durableBase(cwd);
  const bugs = await readBugs(base);
  if (!Array.isArray(bugs) || bugs.length === 0) return [];
  const cutoffMs = Date.now() - 60 * 60 * 1000; // 1h window
  const nowIso = new Date().toISOString();
  const verified = [];
  for (const bug of bugs) {
    if (!bug || typeof bug !== 'object') continue;
    if (bug.fix_verified) continue;
    if (bug.session_id !== sid) continue;
    const t = bug.ts ? Date.parse(bug.ts) : NaN;
    if (!Number.isFinite(t) || t < cutoffMs) continue;
    bug.fix_verified = true;
    bug.verified_ts = nowIso;
    bug.verified_by = 'test-pass';
    if (typeof bug.id === 'string') verified.push(bug.id);
  }
  if (verified.length > 0) await writeBugs(base, bugs);
  return verified;
}

// Tranche capture tracking: increment captures_this_session.rules when a
// cerebrum file is written and there's an active IN-FLIGHT tranche.
async function maybeTrackRuleCapture(cwd) {
  if (!cwd) return;
  try {
    const tState = await readTranches(cwd);
    const active = activeTranche(tState);
    if (active && active.status === 'IN-FLIGHT') {
      recordCapture(tState, 'rule');
      await writeTranches(cwd, tState);
    }
  } catch (err) {
    process.stderr.write(`sextant: postToolUse rule-capture-track err=${err.message}\n`);
  }
}

// Tranche capture tracking: increment captures_this_session.bugs when a Bash
// call's stdout carries the bug-log CONFIRMATION and there's an active IN-FLIGHT
// tranche. Detect by the CLI's OUTPUT, not the command text — bug-6's lesson
// applied to the bug path.
async function maybeTrackBugCapture(cwd, toolResponse) {
  if (!cwd) return;
  if (!bugLogConfirmed(toolResponse)) return;
  try {
    const tState = await readTranches(cwd);
    const active = activeTranche(tState);
    if (active && active.status === 'IN-FLIGHT') {
      recordCapture(tState, 'bug');
      await writeTranches(cwd, tState);
    }
  } catch (err) {
    process.stderr.write(`sextant: postToolUse bug-capture-track err=${err.message}\n`);
  }
}

// bug-7: `bugs.mjs log` prints the allocated id as a BARE `bug-N` line
// (bin/bugs.mjs:144). list/search print `bug-N [file:node] err` via
// renderEntryLine — id PLUS trailing text — so an anchored single-line match
// distinguishes a genuine log confirmation from a listing. Non-global (`/m`,
// no `/g`) so module-level `.test()` reuse is stateless. Reads stdout AND
// content, like countCerebrumAppends.
const BUG_LOG_CONFIRM_RE = /^bug-\d+\s*$/m;
function bugLogConfirmed(toolResponse) {
  const r = (toolResponse && typeof toolResponse === 'object') ? toolResponse : {};
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const content = typeof r.content === 'string' ? r.content : '';
  return BUG_LOG_CONFIRM_RE.test(stdout) || BUG_LOG_CONFIRM_RE.test(content);
}

// bugLoggedId(toolResponse): the bare `bug-N` id a successful `bugs.mjs log`
// printed, or null. Same anchored single-line match as bugLogConfirmed (a
// non-global capture this time), so it never picks an id out of a list/search
// line. Used only for the verbose "logged bug-N" confirmation.
function bugLoggedId(toolResponse) {
  const r = (toolResponse && typeof toolResponse === 'object') ? toolResponse : {};
  const text = `${typeof r.stdout === 'string' ? r.stdout : ''}\n${typeof r.content === 'string' ? r.content : ''}`;
  const m = text.match(/^(bug-\d+)\s*$/m);
  return m ? m[1] : null;
}

// The cerebrum `remember` CLI prints exactly this, anchored to the start of a
// line, once per rule it actually appends (bin/cerebrum.mjs:303). `forget`
// prints a different "Forgot (archived…" line; promote / reconcile / auto-tag
// print nothing of the sort. Matching the OUTPUT (not the command) is what makes
// this a true genuine-author signal — a command that merely mentions the phrase
// never prints this confirmation.
const CEREBRUM_APPEND_RE = /^Appended to cerebrum\.md:/gm;

// countCerebrumAppends(toolResponse): how many rules the cerebrum CLI confirmed
// it appended in this Bash call's stdout. 0 if the response carries no output or
// no confirmation line. Reads stdout/content (where Claude Code surfaces Bash
// output); deliberately ignores stderr (a rejected rule writes its error there).
function countCerebrumAppends(toolResponse) {
  const r = (toolResponse && typeof toolResponse === 'object') ? toolResponse : {};
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const content = typeof r.content === 'string' ? r.content : '';
  const text = stdout + '\n' + content;
  const m = text.match(CEREBRUM_APPEND_RE);
  return m ? m.length : 0;
}

// maybeTrackRuleAuthored(sid, cwd, ctx, count): append `count` timestamped
// entries to the per-session rules-authored.jsonl (one per appended rule). The
// Stop turn-summary counts entries with ts >= turn start to report the
// authored-rule line. Best-effort; never throws.
async function maybeTrackRuleAuthored(sid, cwd, ctx, count = 1) {
  if (!sid || !(count > 0)) return;
  await ensureRuntimeDir(sid, cwd);
  const ts = ctx.nowIso();
  const lines = Array.from({ length: count }, () => JSON.stringify({ ts })).join('\n') + '\n';
  await fs.appendFile(rulesAuthoredPath(sid, cwd), lines, 'utf8');
}
