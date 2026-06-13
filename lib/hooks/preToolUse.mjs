// lib/hooks/preToolUse.mjs — PreToolUse handler.
//
// Phase 0 (PRESERVED):
//   - Log the fire including tool_name (the matcher already filtered
//     down to Read|Grep|Glob|Edit|Write|MultiEdit|Bash per plugin.json).
//   - On `Read`, increment reads.total. This is the simplest hot-path
//     statusline counter and a useful Phase 0 smoke signal: if you Read
//     three files, the counter increments by three.
//
// Phase 1a (§ 5.3 — the headline feature):
//   - On `Read`, attempt to load the project graph from `payload.cwd`.
//     If a graph exists AND the read target is a known file node, compose
//     a marker-fenced context block via lib/inject/compose.mjs and return
//     it as additionalContext under hookSpecificOutput.
//   - Failure modes (no cwd, missing graph, file not in graph, compose
//     returns empty) all degrade gracefully to "no additionalContext".
//     Other tools (Edit/Write/Bash/...) remain pass-through.
//
// Phase 2c (§ 5.3 priority 1 — mandatory rules injection):
//   - On `Read`, resolve `.sextant/cerebrum/cerebrum.md` via readResolvedCerebrum
//     and select rules that apply to the touched file's relative path via
//     listMandatoryFor. Pass the matched rule objects to the composer's
//     `includeMandatoryRules` option so they render at priority 1.
//   - When at least one mandatory rule fires, bump
//     `state.rules.fires_this_turn` and `state.rules.mandatory_fires` on
//     the statusline state. Both counters are zeroed at Stop/SessionEnd.
//
// Phase 2.5 (§ 5.15.b — post-compact restoration fallback + rule-fire log):
//   - On every Read (regardless of graph/cerebrum state), check
//     turn-state.json#pending_restore. If true, read precompact.json and
//     emit the restoration block ahead of any per-Read additionalContext.
//     Clear the flag + rotate precompact.json afterwards. This is the
//     "first PreToolUse before next UserPromptSubmit" failsafe.
//   - When a mandatory rule actually fires (one or more rules matched the
//     touched file), append one JSONL line per fire to rules-fired.jsonl.
//     PreCompact reads the tail of this file when building precompact.json's
//     payload.rules.
//
// Phase 4 (§ 8 Phase 4 — Lunr retrieval over cerebrum):
//   - Load the cerebrum.md Lunr index (mtime-cached).
//   - Build a query from the touched file's relPath + the file node's top
//     symbols. Search top-5 above minScore=0.3.
//   - Filter out any results whose bucket reads as mandatory — the one store
//     is indexed, so mandatory/provisional/node rules CAN appear in the index
//     and must be skipped to avoid double-rendering the priority-1 floor.
//   - Hand the surviving hits to the composer as opts.includeLunrRules
//     where they render at priority 8.
//
// Phase 6 (§ 5.2 + § 8 Phase 6 — cross-turn dedup):
//   - Before composing the per-Read block, check turn-state.json#injected_nodes.
//     If the touched file's nodeId is already in that list, the agent saw the
//     context this turn (via UserPromptSubmit preload or an earlier Read) —
//     skip the graph identity / connections / symbols / Lunr block, bump
//     reads.redundant_blocked, but still surface priority-1 mandatory rules
//     (small + per-file, never deduped).
//   - On a fresh Read, the nodeId is appended to injected_nodes so subsequent
//     Reads of the same file in the same turn hit the dedup path.
//
// Phase 7 (§ 5.7 + § 8 Phase 7 — structural gate at cerebrum write):
//   - On Edit/Write/MultiEdit targeting .sextant/cerebrum/{regular,mandatory}.md,
//     compute the proposed-new content, diff against the on-disk file, and
//     run the 4-check (+1 provisional) gate over each newly-added line. Any
//     failure surfaces as `permissionDecision: "deny"` with itemized reasons
//     so Claude can fix-and-retry (v0.44.0: was `ask` — switched to `deny`
//     because it's agent-facing, never a user permission card, and the gate's
//     reason loop is something Claude resolves on its own). Statusline
//     `rules.deny_red` is bumped to signal the deny visually. Kill-switch:
//     SEXTANT_CEREBRUM_GATE=off disables it (escape hatch for false positives,
//     since a deny has no user override).
//   - A clean write falls through to the rest of PreToolUse, which is a
//     no-op for Edit/Write (the Read injection logic is the only other
//     branch). PostToolUse's auto-tagger handles bucket prefixes after.
//
// Phase 8 (§ 6.4 + § 8 Phase 8 — token ledger + A/B measurement):
//   - On the treatment arm (statusline-state.ab_arm === 'B'), every emitted
//     additionalContext block contributes its estimated token size to
//     .sextant/stats.json#tokens_paid_extra; every mandatory rule fire bumps
//     .sextant/stats.json#rule_fires[<line_hash>]; every dedup hit bumps
//     .sextant/stats.json#redundant_reads_blocked. Control-arm sessions
//     (ab_arm === 'A') skip all ledger writes to protect the promotion
//     ladder per § 10.5 composition risk.
//   - tokens_saved_estimate is left at 0 in v1 — measuring "did the agent
//     re-Read" requires telemetry we don't have. See § 10.10 disclosure.
//   - All ledger I/O is best-effort: failures log to stderr but never break
//     the per-Read additionalContext.

import path from 'node:path';
import fs from 'node:fs/promises';

import { withState, readState } from '../state.mjs';
// NOTE (cerebrum-v2 §10.1, PROVISIONAL / for-testing): graph/read, inject/compose,
// stores/bugs, and retrieval/lunr-index are NOT imported at top level — they cost
// ~100ms to load and are used ONLY on the Read path. They are lazy-imported via
// dynamic import() inside the Read branch below so non-Read hooks (Bash/Grep/Glob/
// Edit, and future Task/WebFetch/MCP) never pay for them. Subject to change.
import {
  readResolvedCerebrum,
  listMandatoryFor,
  parseCerebrum,
  lineHash,
} from '../stores/cerebrum.mjs';
import { dedupKeywordMatches } from './keywordDedup.mjs';
// resolveKeywordMatches (cerebrum-v2 T3) is the v2 keyword-rule resolver. It is
// safe to static-import on the Bash hot path: it pulls in only cerebrum.mjs, and
// dynamic-imports lunr-index ONLY inside its BM25 pass (skipped for Bash).
// (v0.44.0: kwTermsOf/keywordPresent dropped — the [!] write-gate that used them
// for word-boundary hunk matching was removed; matched kw rules now inject via
// the normal WRITE keyword block, not a permission ask.)
import { resolveKeywordMatches } from '../retrieval/keywordRules.mjs';
// (stores/bugs lazy-imported in the Read branch — see §10.1 note above)
import {
  readStats,
  writeStats,
  incrementRuleFire,
  addTokensPaid,
  bumpRedundantRead,
  bumpGlobalsDeduped,
} from '../stores/stats.mjs';
import {
  partitionGlobals,
  digestGlobals,
  globalsDedupDisabled,
  shouldEmitFullGlobals,
  GLOBALS_DIGEST_FIELD,
  READ_NODES_SEEN_FIELD,
} from './mandatoryGlobals.mjs';
import { estimateTokens } from '../ledger/tokens.mjs';
import {
  durableBase,
  durableFile,
  rulesFiredPath,
  ensureRuntimeDir,
  testRunPendingFlagPath,
  commitPendingFlagPath,
  turnStatePath,
} from '../paths.mjs';
import { readJson, readModifyJson } from '../io.mjs';
// (retrieval/lunr-index lazy-imported in the Read branch — see §10.1 note above)
import { NODE } from '../graph/schema.mjs';
import { buildRestorationBlock, readPrecompactSnapshot, clearPendingRestore } from './restore.mjs';
import { detectTestCommand } from '../capture/test-detector.mjs';
import { detectCommitCommand } from '../capture/commit-snapshot.mjs';
import { writeFlagFile } from './flags.mjs';
import { runAllChecks, buildSingleLineIndex } from '../capture/structural-gate.mjs';
import { readTranches, writeTranches, activeTranche } from '../stores/tranches.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';

export default async function preToolUse(payload, ctx) {
  const sid = payload.session_id;
  const sidCwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const tool = payload.tool_name ?? null;

  await ctx.log({ ts: ctx.nowIso(), event: 'PreToolUse', sid, tool });

  // Phase 7 § 5.7: structural gate on Edit/Write/MultiEdit targeting cerebrum
  // files. Runs BEFORE the Bash / Read branches because it short-circuits to
  // a permissionDecision and bypasses the rest of the hook. Best-effort:
  // a parse / IO error during gate evaluation surfaces stderr but never
  // crashes the hook — the write is allowed through (fail-open per § 5.7).
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    // Classify once: cerebrum file → run write-time structural gate;
    // anything else → enforce mandatory rule [match:] directives against the
    // proposed new content (§ 5.5).
    const toolInputForEdit = payload.tool_input ?? null;
    const cwdForEdit = typeof payload.cwd === 'string' ? payload.cwd : null;
    const filePathForEdit = (toolInputForEdit && typeof toolInputForEdit.file_path === 'string')
      ? toolInputForEdit.file_path
      : null;
    const cerebrumKind = (cwdForEdit && filePathForEdit)
      ? classifyCerebrumPath(filePathForEdit, cwdForEdit)
      : null;

    // Tranche enforcement: deny edits to frozen charter / shipped scope,
    // ask on checklist-incomplete scope files. Runs before cerebrum gate.
    if (!cerebrumKind && cwdForEdit && filePathForEdit) {
      try {
        const trancheGuard = await enforceTrancheDocProtection(filePathForEdit, cwdForEdit);
        if (trancheGuard) return trancheGuard;
      } catch (err) {
        process.stderr.write(`sextant: preToolUse tranche-guard err=${err.message}\n`);
      }
    }

    if (cerebrumKind) {
      try {
        const gateResult = await runCerebrumGate({ payload, sid, cwd: sidCwd, ctx });
        if (gateResult) return gateResult; // deny envelope (fix-and-retry)
      } catch (err) {
        process.stderr.write(`sextant: preToolUse cerebrum-gate err=${err.message}\n`);
      }
    }
    // v0.44.0: the [!] write-gate's `ask` escalation was REMOVED. CC discards a
    // PreToolUse hook's permissionDecisionReason for file tools (verified live —
    // see the [node:lib/hooks/preToolUse.mjs] cerebrum rule), so a write-gate
    // `ask` could never explain itself at the card, and word-boundary keyword
    // matching over-fired on ordinary edits (~50% in dogfooding). A matched
    // [kw:…][!] rule now surfaces via the normal WRITE keyword-injection block
    // below (the non-Read else-branch), as context on the result — never a wall.
    //
    // Fall through. Edit/Write don't have any other early-return PreToolUse
    // handling (the Read injection logic below short-circuits on tool !== 'Read'),
    // but we don't return early — that keeps the Phase 0 log invariant and lets
    // the keyword-injection branch run.
  }

  // Phase 5 § 5.6: Bash → set test-run-pending / commit-pending sentinel
  // flags so PostToolUse Bash can run the verification / snapshot loop.
  // Best-effort; any IO failure must NOT crash the hook (we still need to
  // pass the Bash through).
  if (tool === 'Bash') {
    try {
      const cmdStr = (payload.tool_input && typeof payload.tool_input.command === 'string')
        ? payload.tool_input.command
        : '';
      if (cmdStr.length > 0) {
        await ensureRuntimeDir(sid, sidCwd);
        const isTest = detectTestCommand(cmdStr);
        const isCommit = detectCommitCommand(cmdStr);
        if (isTest) {
          await writeFlagFile(testRunPendingFlagPath(sid, sidCwd), '1');
        }
        if (isCommit) {
          await writeFlagFile(commitPendingFlagPath(sid, sidCwd), '1');
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: preToolUse Bash-flag err=${err.message}\n`);
    }
  }

  if (tool !== 'Read') {
    const detail = buildActionDetail(tool, payload.tool_input);
    try {
      await withState(sid, sidCwd, (state) => {
        state.last_event = { tag: `PreToolUse:${tool}`, ts: ctx.nowIso(), detail };
      });
    } catch {}

    // Mandatory rules for non-Read tools:
    //   - Bash + the broadened AC-only surfaces (Task/WebFetch/WebSearch/
    //     AskUserQuestion/NotebookEdit/MCP, per toolEmitsGlobals): surface
    //     [!global] rules (digest-deduped — they apply everywhere) plus [kw:]
    //     rules that match the action. This is what fires the /dev/null /
    //     sandbox-write warning ahead of a Bash cp, and now surfaces kw rules
    //     on a Task prompt / WebFetch / MCP call too.
    //   - Other non-Read tools (Edit/Write/MultiEdit/Grep/Glob): only [kw:]
    //     matches. Edit/Write/MultiEdit have their own dedicated paths
    //     (structural gate, the [!] write-gate) and Read already surfaces
    //     [!global] rules before the agent edits a file — surfacing them on
    //     Edit too would be redundant and noisy.
    try {
      const kwCwd = typeof payload.cwd === 'string' ? payload.cwd : null;
      if (kwCwd) {
        const cerebrumDir = path.dirname(durableFile(kwCwd, path.join('cerebrum', 'cerebrum.md')));
        // cerebrum-v2: resolve the one store (cerebrum.md) ONCE. This freshens
        // the store and gives the globals filter and the kw resolver the same
        // normalized snapshot.
        const resolved = await readResolvedCerebrum(cerebrumDir);
        const parsed = resolved.parsed;

        const corpus = buildKeywordCorpus(tool, payload.tool_input);
        // mode: Bash = exact word-boundary only (no BM25 on this hot path —
        // spec § integration grid); Edit/Write/MultiEdit = WRITE minScore;
        // the broadened AC tools + Grep/Glob (and any other) = READ minScore.
        // The v2 resolver lays the [!] exact-floor beneath BM25. Result is
        // windowed-deduped exactly as before.
        const kwMode = tool === 'Bash' ? 'BASH'
          : (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') ? 'WRITE'
          : 'READ';
        const kwMatches = corpus.length > 0
          ? await resolveKeywordMatches({
            cerebrumDir, durableBase: durableBase(kwCwd), corpus, mode: kwMode, resolved,
          })
          : [];
        const kwRules = await dedupKeywordMatches(kwMatches, sid, kwCwd);

        if (toolEmitsGlobals(tool)) {
          // [!global] rules — sentinel path forces listMandatoryFor to return
          // only global entries (node: matches require exact equality).
          const globalRules = listMandatoryFor(parsed, '/__sextant_no_match__');

          // Session-scoped dedup: SessionStart already injected the full
          // [!global] set; per-action re-emission is the wasteful path the
          // urgent fix targets. Compute the digest of the active globals;
          // if the agent has already seen this digest in the session,
          // suppress globals entirely and emit only kw matches (which are
          // value-dense per command).
          const fullDigest = digestGlobals(globalRules);
          const dedupOff = globalsDedupDisabled();
          let emitGlobals = true;
          if (!dedupOff && fullDigest.length > 0) {
            try {
              const ts = await readJson(turnStatePath(sid, kwCwd));
              emitGlobals = shouldEmitFullGlobals(ts, fullDigest);
            } catch {
              emitGlobals = true; // fail-open: emit on read failure
            }
          }
          const effectiveGlobals = emitGlobals ? globalRules : [];
          const merged = [...effectiveGlobals];
          for (const r of kwRules) {
            if (!merged.some((m) => m.raw === r.raw)) merged.push(r);
          }
          // Bump the dedup stats counter when we actually suppressed
          // globals (regardless of whether kw rules end up emitting a
          // block). Best-effort, treatment-arm-only.
          if (!emitGlobals && globalRules.length > 0) {
            await recordGlobalsDeduped({ sid, cwd: kwCwd });
          }
          if (merged.length > 0) {
            await bumpKeywordFires(sid, merged, kwCwd);
            const block = tool === 'Bash'
              ? formatBashGlobalBlock(merged)
              : formatActionGlobalBlock(merged, tool);
            if (emitGlobals && fullDigest.length > 0) {
              // Persist the digest so future Bash/Read calls in this
              // session can suppress. Best-effort.
              try {
                await readModifyJson(turnStatePath(sid, kwCwd), (o) => {
                  o[GLOBALS_DIGEST_FIELD] = fullDigest;
                });
              } catch (err) {
                process.stderr.write(`sextant: preToolUse globals-digest write err=${err.message}\n`);
              }
            }
            return finalize({ sid, cwd: kwCwd, additionalBlock: block, mandatoryRules: merged, wasDedupedRead: false });
          }
          // Globals suppressed AND no kw rules → no block to emit.
          if (!emitGlobals && globalRules.length > 0) return undefined;
        } else {
          // Non-global, non-Read tools. Edit/Write/MultiEdit ALSO surface the
          // node-scoped rules for the file being written (cerebrum-v2 T5.6: node:
          // fires on writes, 100%, no dedup — the write is the moment a per-file
          // rule most needs to assert). Globals are NOT re-surfaced on write
          // (SessionStart / the read floor already showed them).
          let nodeWriteRules = [];
          let filePathForWrite = null;
          let relPathForWrite = null;
          if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
            filePathForWrite = (payload.tool_input && typeof payload.tool_input.file_path === 'string')
              ? payload.tool_input.file_path : null;
            // Reuse the Read path's EXACT relPath derivation — listMandatoryFor
            // exact-matches node:<path>, so any ./-or-sep mismatch silently no-ops.
            relPathForWrite = computeRelPath(filePathForWrite, kwCwd);
            if (relPathForWrite !== null) {
              nodeWriteRules = partitionGlobals(listMandatoryFor(parsed, relPathForWrite)).nonGlobals;
            }
          }
          const blocks = [];
          if (nodeWriteRules.length > 0) blocks.push(formatNodeWriteBlock(nodeWriteRules));
          if (kwRules.length > 0) blocks.push(formatKeywordBlock(kwRules));

          // Read-context hygiene: the advisory wallpaper (bug summary + graph
          // context + Lunr related rules) rides on the EDIT, deduped per turn.
          // Fires on Edit/Write/MultiEdit regardless of whether any node/keyword
          // rule matched — the dependency/bug context is the point. Best-effort.
          // wpSignals carries the verbose-only user-facing lines (risk/impact/
          // orientation) for this fresh injection — emitted on the result below.
          let wpSignals = [];
          if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && filePathForWrite) {
            try {
              const wp = await composeWallpaperBlock({
                sid, sidCwd, cwd: kwCwd,
                filePath: filePathForWrite, relPath: relPathForWrite,
                mandatoryRules: [...nodeWriteRules, ...kwRules],
              });
              if (wp.content) blocks.push(wp.content);
              wpSignals = Array.isArray(wp.signals) ? wp.signals : [];
            } catch (err) {
              process.stderr.write(`sextant: preToolUse write-wallpaper err=${err.message}\n`);
            }
          }

          if (blocks.length > 0) {
            const emitted = [...nodeWriteRules, ...kwRules];
            await bumpKeywordFires(sid, emitted, kwCwd);
            // T3-A: node rules fire on Edit/Write (injected above via
            // formatNodeWriteBlock) but were never logged to rules-fired.jsonl —
            // finalize() doesn't log, and only the Read path + write-gate do. Log
            // the node-write fires here (bucket `[node:<path>]`) so the Stop
            // turn-summary's "path" count includes edit-fired node rules. Only
            // nodeWriteRules (the gap) — keyword fires are handled elsewhere.
            // Best-effort: a write failure must never disturb the hook.
            if (nodeWriteRules.length > 0) {
              try {
                await ensureRuntimeDir(sid, sidCwd);
                const cerebrumRel = path
                  .relative(kwCwd, durableFile(kwCwd, path.join('cerebrum', 'cerebrum.md')))
                  .split(path.sep).join('/');
                const firedTs = ctx.nowIso();
                const lines = nodeWriteRules.map((r) => {
                  const buckets = Array.isArray(r && r.buckets) ? r.buckets : [];
                  const nodeBucket = buckets.find((b) => typeof b === 'string' && b.startsWith('node:'));
                  return JSON.stringify({
                    ts: firedTs,
                    body: typeof r.body === 'string' ? r.body : '',
                    source_file: cerebrumRel,
                    bucket: nodeBucket ? `[${nodeBucket}]` : '',
                  });
                });
                await fs.appendFile(rulesFiredPath(sid, sidCwd), lines.map((l) => l + '\n').join(''), 'utf8');
              } catch { /* best-effort */ }
            }
            let r = await finalize({ sid, cwd: kwCwd, additionalBlock: blocks.join('\n'), mandatoryRules: emitted, wasDedupedRead: false });
            // Verbose-only per-tool signals (no suppression key → no withState
            // lock contention; routine level → suppressed unless output=verbose).
            for (const s of wpSignals) {
              r = await mergeSystemMessage(r, s.text, { category: s.category, level: 'routine', sid, cwd: kwCwd });
            }
            return r;
          }
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: preToolUse keyword-match err=${err.message}\n`);
    }
    return undefined;
  }

  // Phase 0 contract: bump the cumulative reads counter.
  const readPath = payload.tool_input?.file_path;
  const readDetail = typeof readPath === 'string' ? readPath.split('/').pop() : 'file';
  await withState(sid, sidCwd, (state) => {
    state.reads.total += 1;
    state.last_event = { tag: 'PreToolUse:Read', ts: ctx.nowIso(), detail: `read ${readDetail}` };
  });

  // Phase 2.5 § 5.15.b fallback: if a compaction set pending_restore and
  // the agent's next action is a tool call (not a user prompt), this is the
  // hook that has to drive the restoration. Read the snapshot up front so
  // we can concatenate it before any per-Read block we render below.
  let restoreBlock = null;
  try {
    const snapshot = await readPrecompactSnapshot(sid, sidCwd);
    if (snapshot) {
      restoreBlock = buildRestorationBlock(snapshot.payload || {});
      await clearPendingRestore(sid, snapshot.ts, sidCwd);
    }
  } catch (err) {
    process.stderr.write(`sextant: preToolUse restore err=${err.message}\n`);
  }

  // Phase 1a + 2c injection. All steps are best-effort; any failure (missing
  // graph, missing node, missing cerebrum, compose error) degrades to "no
  // additionalContext" — we never want PreToolUse to crash the user's read.
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const toolInput = payload.tool_input ?? null;
  const filePath = (toolInput && typeof toolInput.file_path === 'string')
    ? toolInput.file_path
    : null;

  if (!cwd || !filePath) {
    // No file path to compose against, but a restore block may still be
    // pending from above.
    return await finalize({
      sid, cwd: cwd ?? null,
      additionalBlock: restoreBlock,
      mandatoryRules: [], wasDedupedRead: false,
    });
  }

  // Compute the project-relative path. We accept absolute paths under cwd
  // (the common case for tool_input.file_path) and pre-normalised relative
  // paths. Anything outside cwd → null (we still try the graph hit by
  // absolute id below).
  const relPath = computeRelPath(filePath, cwd);

  // Phase 2c: gather mandatory rules that apply to this file. Reads the one
  // store (cerebrum.md) via readResolvedCerebrum — deterministic read path only.
  let mandatoryRules = [];
  // Captured for reuse by the kw block and the priority-8 Lunr block below, so
  // the store is resolved exactly once per Read.
  const cerebrumDir = path.dirname(durableFile(cwd, path.join('cerebrum', 'cerebrum.md')));
  let resolvedCerebrum = null;
  try {
    resolvedCerebrum = await readResolvedCerebrum(cerebrumDir);
    const { parsed } = resolvedCerebrum;
    if (relPath !== null) {
      mandatoryRules = listMandatoryFor(parsed, relPath);
    } else {
      // Without a relPath we still surface [!global] rules — they apply
      // regardless of file scope.
      mandatoryRules = listMandatoryFor(parsed, '/__sextant_no_match__');
    }
  } catch {
    mandatoryRules = [];
  }

  // Session-scoped [!global] dedup on the Read path. Partition the rule
  // set; if the active [!global] digest already matches what's been
  // emitted this session, drop those entries from the priority-1 block.
  // Node-scoped ([node:<path>]) rules ALWAYS fire — they're per-file and
  // value-dense.
  if (!globalsDedupDisabled() && mandatoryRules.length > 0) {
    const { globals, nonGlobals } = partitionGlobals(mandatoryRules);
    if (globals.length > 0) {
      const fullDigest = digestGlobals(globals);
      let emitGlobals = true;
      try {
        const ts = await readJson(turnStatePath(sid, sidCwd));
        emitGlobals = shouldEmitFullGlobals(ts, fullDigest);
      } catch {
        emitGlobals = true; // fail-open
      }
      if (emitGlobals) {
        // Persist the digest so subsequent calls in the session suppress.
        try {
          await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
            o[GLOBALS_DIGEST_FIELD] = fullDigest;
          });
        } catch (err) {
          process.stderr.write(`sextant: preToolUse globals-digest write err=${err.message}\n`);
        }
      } else {
        mandatoryRules = nonGlobals;
        await recordGlobalsDeduped({ sid, cwd });
      }
    }
  }

  // cerebrum-v2 T5.6: per-TURN dedup for node-scoped rules on Read. node: rules
  // fire on every WRITE (100%, the write path below) and on the FIRST read of a
  // file each turn, but a re-read of the same file within the turn is suppressed
  // — re-reading shouldn't re-inject the same [node:F] rule every time. Keyed by
  // lineHash; the seen-set lives in turn-state (cleared each turn by
  // UserPromptSubmit, the same lifetime as injected_nodes). Globals are handled
  // by the digest dedup above; here we only touch node rules. The write track is
  // independent (writes never consult or populate this set).
  if (relPath !== null && mandatoryRules.length > 0) {
    try {
      const ts = await readJson(turnStatePath(sid, sidCwd));
      const seen = (ts && Array.isArray(ts[READ_NODES_SEEN_FIELD])) ? ts[READ_NODES_SEEN_FIELD] : [];
      const seenSet = new Set(seen);
      const isNodeRule = (r) => Array.isArray(r.buckets)
        && !r.buckets.includes('!global')
        && r.buckets.some((b) => typeof b === 'string' && b.startsWith('node:'));
      const firedHashes = [];
      mandatoryRules = mandatoryRules.filter((r) => {
        if (!isNodeRule(r)) return true;            // globals/other handled elsewhere
        const h = (typeof r.raw === 'string') ? lineHash(r.raw) : null;
        if (h && seenSet.has(h)) return false;       // already shown this turn → drop
        if (h) firedHashes.push(h);
        return true;
      });
      if (firedHashes.length > 0) {
        await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
          const cur = Array.isArray(o[READ_NODES_SEEN_FIELD]) ? o[READ_NODES_SEEN_FIELD] : [];
          o[READ_NODES_SEEN_FIELD] = [...new Set([...cur, ...firedHashes])];
        });
      }
    } catch (err) {
      process.stderr.write(`sextant: preToolUse node-read-dedup err=${err.message}\n`);
    }
  }

  // Keyword-triggered rules for Read: match file path against [kw:] buckets.
  // BM25 over the `keywords` field at READ minScore ∪ the [!] exact-floor.
  // Reuses the resolved store captured above (no second read/parse). Merged into
  // mandatoryRules here so the priority-8 dedup sets below catch any rule that
  // also body-matches.
  try {
    const corpus = buildKeywordCorpus('Read', payload.tool_input);
    if (corpus.length > 0) {
      const kwMatches = await resolveKeywordMatches({
        cerebrumDir, durableBase: durableBase(cwd), corpus, mode: 'READ', resolved: resolvedCerebrum,
      });
      // Windowed-dedup (criticals every turn, generals throttled).
      const kwRules = await dedupKeywordMatches(kwMatches, sid, cwd);
      for (const r of kwRules) {
        if (!mandatoryRules.some((m) => m.raw === r.raw)) mandatoryRules.push(r);
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: preToolUse keyword-read err=${err.message}\n`);
  }

  // Bump rule-fire counters when we actually have mandatory rules to inject,
  // and Phase 2.5: append one JSONL entry per fire to rules-fired.jsonl.
  if (mandatoryRules.length > 0) {
    await withState(sid, sidCwd, (state) => {
      state.rules.fires_this_turn = (state.rules.fires_this_turn ?? 0) + mandatoryRules.length;
      state.rules.mandatory_fires = (state.rules.mandatory_fires ?? 0) + mandatoryRules.length;
    });
    // Append to rules-fired.jsonl. Best-effort: a write failure must not
    // crash the read. The path lives in the runtime dir which may not exist
    // yet on first fire, so ensure it first.
    try {
      await ensureRuntimeDir(sid, sidCwd);
      const cerebrumPath = durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
      const ts = ctx.nowIso();
      const lines = [];
      for (const r of mandatoryRules) {
        // Pick the most specific bucket label for the JSONL entry. Mirrors
        // formatMandatoryBullet's logic but as a JSON-friendly token.
        const buckets = Array.isArray(r && r.buckets) ? r.buckets : [];
        const nodeBucket = buckets.find((b) => typeof b === 'string' && b.startsWith('node:'));
        let bucketLabel;
        if (nodeBucket) bucketLabel = `[${nodeBucket}]`;
        else if (buckets.includes('!global')) bucketLabel = '[!global]';
        else if (buckets.includes('!')) bucketLabel = '[!]';
        else bucketLabel = '';
        const entry = {
          ts,
          body: (typeof r.body === 'string' ? r.body : ''),
          source_file: path.relative(cwd, cerebrumPath).split(path.sep).join('/'),
          bucket: bucketLabel,
        };
        lines.push(JSON.stringify(entry));
      }
      // Single fs.appendFile call — atomic per line on POSIX for small writes.
      await fs.appendFile(rulesFiredPath(sid, sidCwd), lines.map((l) => l + '\n').join(''), 'utf8');
    } catch (err) {
      process.stderr.write(`sextant: preToolUse rules-fired append err=${err.message}\n`);
    }
  }

  // Read now emits ONLY the mandatory rule floor (node + [!global] + matched
  // keyword rules), composed below. The advisory wallpaper (bug summary, graph
  // identity/connections/used_by/symbols, Lunr-ranked related rules) moved to the
  // Edit/Write path (composeWallpaperBlock) where it is actionable at the change
  // moment — read-context hygiene. The composer is the only Read-path-only lazy
  // import that remains; graph/bugs/Lunr now load on the write path instead.
  let composeReadBlock;
  try {
    ({ composeReadBlock } = await import('../inject/compose.mjs'));
  } catch (err) {
    process.stderr.write(`sextant: preToolUse lazy-import err=${err.message}\n`);
  }

  // No mandatory rules → no per-Read block; still emit a pending restore block.
  // (Read no longer composes graph/bug/Lunr wallpaper — that rides on Write.)
  if (mandatoryRules.length === 0 || typeof composeReadBlock !== 'function') {
    return await finalize({
      sid, cwd,
      additionalBlock: restoreBlock,
      mandatoryRules, wasDedupedRead: false,
    });
  }

  let composed;
  try {
    composed = composeReadBlock({
      opts: { includeMandatoryRules: mandatoryRules },
    });
  } catch (err) {
    // A composer crash shouldn't break the read. Surface a stderr line so
    // `claude --debug` shows it, but emit no additionalContext (modulo the
    // restore block which is independent).
    process.stderr.write(`sextant: compose error sid=${sid} err=${err.message}\n`);
    return await finalize({
      sid, cwd,
      additionalBlock: restoreBlock,
      mandatoryRules, wasDedupedRead: false,
    });
  }

  if (!composed || typeof composed.content !== 'string' || composed.content.length === 0) {
    return await finalize({
      sid, cwd,
      additionalBlock: restoreBlock,
      mandatoryRules, wasDedupedRead: false,
    });
  }

  // Phase 2.5: when both blocks exist, restoration goes FIRST (separated by a
  // newline) so the agent reads the post-compact state before the per-Read rule
  // floor. Cap the combined size at 10K chars. If it would overflow, drop the
  // per-Read block WHOLE — a naive mid-string slice can cut an opening
  // `<!-- sextant:read-context -->` marker off from its close, leaving the agent
  // an unbalanced fence (the old slice-to-headroom bug).
  let combined;
  if (restoreBlock) {
    const sep = '\n';
    const totalBudget = 10_000;
    combined = (restoreBlock.length + sep.length + composed.content.length) <= totalBudget
      ? `${restoreBlock}${sep}${composed.content}`
      : restoreBlock;
  } else {
    combined = composed.content;
  }

  return await finalize({
    sid, cwd,
    additionalBlock: combined,
    mandatoryRules, wasDedupedRead: false,
  });
}

// composeWallpaperBlock — the advisory "wallpaper" (open-bug summary + graph
// identity/connections/used_by/symbols + Lunr-ranked related rules) for a file,
// deduped per TURN via turn-state injected_nodes. Read now emits only the
// mandatory rule floor; the wallpaper rides on Edit/Write/MultiEdit, where the
// dependency + bug context is actionable at the change moment (read-context
// hygiene — docs/feature-plans/injection-signal/tranches/tranche-1-...md). The
// graph/bugs/Lunr lazy imports live here now (the write path is less hot than
// Read). Returns '' when there is nothing to show: a dedup hit this turn, no
// graph node + no open bugs + no Lunr hits, or any load/compose failure. Best-
// effort throughout — a wallpaper failure must never disturb the edit.
//
// NOTE on dedup semantics vs the old Read path: here the WHOLE block (bug
// summary included) is suppressed on a dedup hit. The old Read path kept the bug
// summary firing even on a dedup hit; re-showing the wallpaper on every
// MultiEdit of one file is exactly the noise this relocation fights, so the
// write-path block dedups as a unit.
async function composeWallpaperBlock({ sid, sidCwd, cwd, filePath, relPath, mandatoryRules }) {
  const EMPTY = { content: '', signals: [] };
  if (!cwd || !filePath) return EMPTY;

  let loadGraph, findFileNode, topConnections, topUsedBy, composeReadBlock,
    readBugs, countOpenBugs, mostRecentUnfixedFor,
    loadCerebrumIndex, lunrSearch;
  try {
    ({ loadGraph, findFileNode, topConnections, topUsedBy } = await import('../graph/read.mjs'));
    ({ composeReadBlock } = await import('../inject/compose.mjs'));
    ({ readBugs, countOpenBugs, mostRecentUnfixedFor } = await import('../stores/bugs.mjs'));
    ({ loadCerebrumIndex, search: lunrSearch } = await import('../retrieval/lunr-index.mjs'));
  } catch (err) {
    process.stderr.write(`sextant: preToolUse wallpaper lazy-import err=${err.message}\n`);
    return EMPTY;
  }

  let graph = null;
  try { graph = await loadGraph(cwd); } catch { graph = null; }
  const node = graph ? findFileNode(graph, filePath, { root: cwd }) : null;
  const nodeId = (node && typeof node[NODE.ID] === 'string') ? node[NODE.ID] : null;

  // Per-turn dedup: if this file's wallpaper already showed this turn (the
  // UserPromptSubmit preload, or an earlier edit of the same file), suppress the
  // whole block and bump the redundant-injection counter.
  if (nodeId) {
    let isDedupHit = false;
    try {
      const ts = await readJson(turnStatePath(sid, sidCwd));
      const injected = (ts && Array.isArray(ts.injected_nodes)) ? ts.injected_nodes : [];
      if (injected.includes(nodeId)) isDedupHit = true;
    } catch (err) {
      process.stderr.write(`sextant: preToolUse wallpaper dedup-read err=${err.message}\n`);
    }
    if (isDedupHit) {
      await withState(sid, sidCwd, (state) => {
        state.reads.redundant_blocked = (state.reads.redundant_blocked ?? 0) + 1;
      });
      return EMPTY;
    }
  }

  // Import-edge degree — computed ONCE here as the single source of truth for
  // (a) whether the graph wallpaper is worth showing and (b) the impact signal,
  // so the two can never desync. Reuses topConnections/topUsedBy (filtered to
  // import edges so intra-file `declares` don't inflate the count).
  let deps = 0;
  let fanIn = 0;
  if (node && nodeId && typeof topConnections === 'function' && typeof topUsedBy === 'function') {
    try { deps = topConnections(graph, nodeId, 9999).filter((e) => e && e.edge && e.edge.type === 'imports').length; } catch {}
    try { fanIn = topUsedBy(graph, nodeId, 9999).filter((e) => e && e.edge && e.edge.type === 'imports').length; } catch {}
  }
  const hasGraphContext = deps > 0 || fanIn > 0;
  // Suppress the graph wallpaper for a disconnected, UNannotated file: a leaf
  // with no import edges AND no node rule contributes only its own filename +
  // symbols — noise. A node-ruled file keeps its block (the team flagged it as
  // interesting). Passing node:null makes composeReadBlock emit no graph
  // sections — the same opts lever the Read path uses, not a separate path.
  const nodeRuleCount = (Array.isArray(mandatoryRules) ? mandatoryRules : [])
    .filter((r) => Array.isArray(r && r.buckets) && r.buckets.some((b) => typeof b === 'string' && b.startsWith('node:')))
    .length;
  const showGraph = hasGraphContext || nodeRuleCount > 0;
  const effNode = showGraph ? node : null;
  const effGraph = showGraph ? graph : null;

  // priority-2: open bug count + most-recent unfixed for this file.
  let bugSummary = null;
  try {
    const bugs = await readBugs(durableBase(cwd));
    const openCount = countOpenBugs(bugs);
    if (openCount > 0) {
      const mostRecent = relPath !== null ? mostRecentUnfixedFor(bugs, relPath) : null;
      bugSummary = { open_count: openCount, most_recent: mostRecent };
    }
  } catch {
    bugSummary = null;
  }

  // priority-8: top-K Lunr-ranked regular rules. Query = relPath + top symbols.
  // The mandatory/provisional/node bucket filter is load-bearing in v2 (the one
  // store is indexed, so mandatory rules CAN appear in the index and must be
  // skipped to avoid double-render); the body-set guards against a rule that
  // also fired in the caller's mandatory block this edit.
  let lunrRulesForCompose = [];
  try {
    const { index, docs } = await loadCerebrumIndex(
      durableBase(cwd),
      { sourceFile: 'cerebrum.md' },
    );
    if (docs && docs.size > 0) {
      const query = buildLunrQuery(relPath, node);
      if (query.length > 0) {
        const hits = lunrSearch(index, docs, query, 5, 0.3);
        const mandatoryRawSet = new Set(
          (mandatoryRules || [])
            .map((r) => (r && typeof r.raw === 'string') ? r.raw : null)
            .filter(Boolean),
        );
        const mandatoryBodySet = new Set(
          (mandatoryRules || [])
            .map((r) => (r && typeof r.body === 'string') ? r.body : null)
            .filter(Boolean),
        );
        for (const h of hits) {
          if (!h || !h.doc) continue;
          const buckets = typeof h.doc.buckets === 'string' ? h.doc.buckets : '';
          const isMandatory =
            buckets.split(/\s+/).some((b) =>
              b === '!' || b === '!global' || b === '!review' || b === 'provisional' || b === 'global'
              || b.startsWith('node:'));
          if (isMandatory) continue;
          if (mandatoryBodySet.has(h.doc.body)) continue;
          if (mandatoryRawSet.has(h.doc.body)) continue;
          lunrRulesForCompose.push({ body: h.doc.body, score: h.score, source: h.doc.source });
        }
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: preToolUse wallpaper lunr err=${err.message}\n`);
    lunrRulesForCompose = [];
  }

  if (!effNode && !bugSummary && lunrRulesForCompose.length === 0) return EMPTY;

  let composed;
  try {
    composed = composeReadBlock({
      node: effNode,
      graph: effGraph,
      opts: {
        includeBugSummary: bugSummary,
        includeLunrRules: lunrRulesForCompose,
      },
    });
  } catch (err) {
    process.stderr.write(`sextant: preToolUse wallpaper compose err=${err.message}\n`);
    return EMPTY;
  }
  if (!composed || typeof composed.content !== 'string' || composed.content.length === 0) return EMPTY;

  // Fresh injection: record the nodeId so later edits/reads of this file this
  // turn dedup against it. Best-effort.
  if (nodeId) {
    try {
      await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
        o.injected_nodes = Array.isArray(o.injected_nodes) ? o.injected_nodes : [];
        if (!o.injected_nodes.includes(nodeId)) o.injected_nodes.push(nodeId);
      });
    } catch (err) {
      process.stderr.write(`sextant: preToolUse wallpaper injected_nodes write err=${err.message}\n`);
    }
  }

  // Verbose-only, user-facing signals (emitted by the caller via
  // mergeSystemMessage). Computed only on a FRESH injection (a dedup hit already
  // returned EMPTY above), so they never repeat within a turn. No emoji — color
  // comes from the category (error=risk, info=orientation/impact).
  const relName = (typeof relPath === 'string' && relPath.length > 0)
    ? relPath
    : (typeof filePath === 'string' ? filePath.split(/[\\/]/).pop() : 'file');
  const signals = [];
  // Risk: an open, unfixed bug in this very file.
  if (bugSummary && bugSummary.most_recent) {
    const b = bugSummary.most_recent;
    signals.push({ category: 'error', text: `editing ${relName} — open bug: ${b.error_message} (${b.id})` });
  }
  // Risk: safety ([!]) rules govern this edit; else a plain count for orientation.
  const rules = Array.isArray(mandatoryRules) ? mandatoryRules : [];
  const safetyN = rules.filter((r) => Array.isArray(r && r.buckets)
    && r.buckets.some((x) => x === '!' || x === '!global')).length;
  if (safetyN > 0) {
    signals.push({ category: 'error', text: `${safetyN} safety rule${safetyN === 1 ? ' governs' : 's govern'} ${relName}` });
  } else if (rules.length > 0) {
    signals.push({ category: 'info', text: `${rules.length} rule${rules.length === 1 ? '' : 's'} apply to ${relName}` });
  }
  // Impact + orientation: reuse the import-edge degree computed above (single
  // source of truth — never recomputed, so the signal and the graph-block
  // suppression can't disagree). Emitted only when there IS graph context, so a
  // disconnected leaf never gets a "0 deps · used by 0" noise line.
  if (hasGraphContext) {
    signals.push({ category: 'info', text: `${relName} — ${deps} dep${deps === 1 ? '' : 's'} · used by ${fanIn}` });
  }

  return { content: composed.content, signals };
}

// finalize: wrap the (possibly empty) additionalContext block in the
// hookSpecificOutput envelope AND, when the session is on the treatment arm,
// instrument the durable ledger (§ 6.4):
//
//   - tokens_paid_extra grows by estimateTokens(additionalBlock).
//   - rule_fires[<line_hash>] gets one increment per fired mandatory rule.
//   - redundant_reads_blocked grows on dedup hits.
//   - tokens_saved_estimate stays at 0 in v1 (see § 10.10 disclosure —
//     measuring "did the agent re-Read" requires a feedback loop we
//     don't have yet).
//
// Control arm sessions skip ALL ledger writes per § 10.5 (suppression bias
// would corrupt the promotion ladder if we counted fires in suppressed
// sessions). The arm is read from statusline-state.json#ab_arm.
//
// Best-effort: any ledger I/O failure logs to stderr but never breaks the
// hook's return value.
async function finalize({ sid, cwd, additionalBlock, mandatoryRules, wasDedupedRead }) {
  await instrumentTreatmentArm({ sid, cwd, additionalBlock, mandatoryRules, wasDedupedRead });
  if (!additionalBlock || additionalBlock.length === 0) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: additionalBlock,
    },
  };
}

async function instrumentTreatmentArm({ sid, cwd, additionalBlock, mandatoryRules, wasDedupedRead }) {
  // No cwd → no durable base to write into. The runtime statusline-state
  // is per-session; cwd is per-project. The ledger is durable, so cwd is
  // load-bearing.
  if (!cwd || typeof cwd !== 'string') return;

  let arm = 'A';
  try {
    const state = await readState(sid, cwd);
    arm = state && typeof state.ab_arm === 'string' ? state.ab_arm : 'A';
  } catch {
    // Default to control on read failure — never accidentally pollute the
    // ledger from a session whose arm we couldn't determine.
    arm = 'A';
  }
  if (arm !== 'B') return;

  try {
    const base = durableBase(cwd);
    const stats = await readStats(base);
    // Stamp the arm we're observing under. The ledger's ab_arm field is
    // informational (the actual gating uses statusline-state.json), but we
    // surface it here so /sextant:stats reports "the arm that produced
    // these numbers" rather than the default.
    stats.ab_arm = 'B';
    if (typeof additionalBlock === 'string' && additionalBlock.length > 0) {
      addTokensPaid(stats, estimateTokens(additionalBlock));
    }
    if (Array.isArray(mandatoryRules)) {
      for (const r of mandatoryRules) {
        const raw = r && typeof r.raw === 'string' ? r.raw : null;
        if (raw === null) continue;
        incrementRuleFire(stats, lineHash(raw));
      }
    }
    if (wasDedupedRead) bumpRedundantRead(stats);
    await writeStats(base, stats);
  } catch (err) {
    process.stderr.write(`sextant: preToolUse stats-write err=${err.message}\n`);
  }
}

// Build the Lunr query string from the touched file's relative path + the
// top symbols on its graph node. We strip path separators + extensions from
// the relPath so identifiers stand alone (e.g., `src/api/auth.ts` →
// `src api auth`). Symbols are appended verbatim. Up to 5 symbols are used
// to keep the query short — Lunr's stemmer dilutes longer queries quickly.
//
// Returns '' if no usable terms could be derived (e.g., no relPath + no node).
function buildLunrQuery(relPath, node) {
  const parts = [];
  if (typeof relPath === 'string' && relPath.length > 0) {
    // Split on path sep + extension dot. Filter empties + collapse to a single
    // space-joined string. We keep raw identifier tokens because the default
    // Lunr tokenizer handles them cleanly.
    for (const tok of relPath.split(/[\/.\\]+/)) {
      if (tok.length > 0) parts.push(tok);
    }
  }
  if (node && Array.isArray(node[NODE.SYMBOLS])) {
    const syms = node[NODE.SYMBOLS].slice(0, 5);
    for (const s of syms) {
      if (typeof s === 'string' && s.length > 0) parts.push(s);
    }
  }
  if (parts.length === 0) return '';
  // Lunr's parser dislikes a couple of operator chars (`+`, `-`, `:`, `~`,
  // `^`). They'll only ever appear in symbol names in pathological cases (and
  // tree-sitter normalises most names anyway), but we drop them defensively
  // so we never throw mid-query.
  return parts.map((p) => p.replace(/[+\-:~^]/g, ' ')).join(' ').trim();
}

// -----------------------------------------------------------------------------
// Phase 7: cerebrum write gate
// -----------------------------------------------------------------------------

// Per § 5.7. Returns the hookSpecificOutput envelope on a gate violation, or
// null on a clean pass. The caller short-circuits the rest of PreToolUse
// when the envelope is returned.
//
// Behavior in pseudo-steps:
//   1. Determine whether tool_input.file_path targets a cerebrum file.
//   2. Read the existing file (missing → '').
//   3. Apply the proposed edit(s) to compute the new content.
//   4. Compute the diff (lines present in new, not in existing).
//   5. Build a Lunr index over the existing cerebrum rules (for redundancy).
//   6. Run runAllChecks() over the new lines.
//   7. If any failure: format the reasons, bump rules.deny_red, return deny.
async function runCerebrumGate({ payload, sid, cwd: cwdArg, ctx }) {
  // Kill-switch (v0.44.0): the gate now denies (not asks), and a deny has no
  // user override — so SEXTANT_CEREBRUM_GATE=off is the escape hatch for a
  // false-positive that would otherwise hard-block a legitimate /remember.
  if (cerebrumGateDisabled()) return null;

  const toolInput = payload.tool_input ?? null;
  if (!toolInput) return null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  if (!cwd) return null;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  if (!filePath) return null;

  const cerebrumKind = classifyCerebrumPath(filePath, cwd);
  if (!cerebrumKind) return null;

  // 1. Existing content (missing → '').
  let existing = '';
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`sextant: preToolUse cerebrum-gate read err=${err.message}\n`);
    }
    existing = '';
  }

  // 2. Proposed content per tool.
  const proposed = computeProposedContent(payload.tool_name, toolInput, existing);
  if (proposed === null) {
    // Malformed tool_input (e.g., Edit with old_string not in existing).
    // Fail-open: let the actual tool surface the same error to Claude with
    // its native messaging.
    return null;
  }

  // 3. Diff: new lines that aren't in existing.
  const newLines = computeNewLines(existing, proposed);
  if (newLines.length === 0) return null;

  // 4. Build redundancy corpus from existing parsed rules. parseCerebrum
  // gives us the rule entries; we feed body strings to buildSingleLineIndex.
  let indexEnvelope = null;
  try {
    const parsedExisting = parseCerebrum(existing);
    const entries = [];
    for (const e of (parsedExisting.lines ?? [])) {
      if (!e || e.kind !== 'rule') continue;
      if (typeof e.body !== 'string' || e.body.length === 0) continue;
      entries.push({ id: `${entries.length}`, body: e.body });
    }
    indexEnvelope = buildSingleLineIndex(entries);
  } catch (err) {
    process.stderr.write(`sextant: preToolUse cerebrum-gate index err=${err.message}\n`);
    indexEnvelope = null;
  }

  // 5. Run gate.
  const today = ctx.nowIso().slice(0, 10);
  const result = runAllChecks(newLines, { existingLunrIndex: indexEnvelope, today });
  if (result.ok) return null;

  // 6. Format failures + bump statusline.
  const reasons = result.failures.map((f) => {
    // Line preview is helpful but very long lines should be truncated so the
    // permissionDecisionReason stays under any UI render budget.
    const preview = f.line.length > 120 ? f.line.slice(0, 117) + '...' : f.line;
    return `- ${f.reason}\n    line: ${preview}`;
  }).join('\n');
  const reasonText =
    `sextant structural gate (${cerebrumKind}.md) rejected ${result.failures.length} ` +
    `issue(s):\n${reasons}\n\nFix each issue above and retry the edit.`;

  await withState(sid, cwdArg, (state) => {
    state.rules = state.rules ?? { fires_this_turn: 0, mandatory_fires: 0, blocked: 0, deny_red: false };
    state.rules.deny_red = true;
    state.rules.blocked = (state.rules.blocked ?? 0) + 1;
  });

  await ctx.log({
    ts: ctx.nowIso(),
    event: 'PreToolUse:cerebrum-gate-blocked',
    sid,
    tool: payload.tool_name,
    cerebrum_kind: cerebrumKind,
    failure_count: result.failures.length,
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonText,
    },
  };
}

// cerebrumGateDisabled(): env escape hatch for the cerebrum structural gate,
// mirroring globalsDedupDisabled()/keywordDedupDisabled(). SEXTANT_CEREBRUM_GATE
// =off (or 0/false/no) turns the gate off so a false-positive deny can never
// hard-block a legitimate cerebrum write (the gate denies, not asks, as of
// v0.44.0 — there is no user override at the card).
function cerebrumGateDisabled() {
  const raw = process.env.SEXTANT_CEREBRUM_GATE;
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// Map a tool_input.file_path to 'regular' / 'mandatory' / null. Mirrors
// lib/hooks/postToolUse.mjs's isCerebrumFile helper but lives here to keep
// the two phase concerns decoupled (post auto-tag vs. pre gate).
function classifyCerebrumPath(filePath, cwd) {
  if (typeof filePath !== 'string' || typeof cwd !== 'string') return null;
  // cerebrum-v2 (T3.5): cerebrum.md is the one store the agent edits; the v1
  // regular/mandatory are retired (frozen backups) but still recognized so a
  // direct edit to them is gated too. Exact + suffix match (defensive against
  // path-canonicalisation mismatches).
  const posixFp = filePath.split(path.sep).join('/');
  for (const [name, kind] of [['cerebrum.md', 'cerebrum'], ['regular.md', 'regular'], ['mandatory.md', 'mandatory']]) {
    if (filePath === durableFile(cwd, path.join('cerebrum', name))) return kind;
    if (posixFp.endsWith(path.join('.sextant', 'cerebrum', name).split(path.sep).join('/'))) return kind;
  }
  return null;
}

// Compute the proposed new content per tool kind. Returns the new string,
// or null if the input was malformed in a way we couldn't reasonably handle.
//
//   Write     — tool_input.content replaces the file.
//   Edit      — tool_input.old_string -> tool_input.new_string (1 replacement
//               by default; or all if replace_all === true).
//   MultiEdit — tool_input.edits = [{old_string, new_string, replace_all?}]
//               applied sequentially.
function computeProposedContent(toolName, toolInput, existing) {
  if (toolName === 'Write') {
    return typeof toolInput.content === 'string' ? toolInput.content : null;
  }
  if (toolName === 'Edit') {
    return applyEdit(existing, toolInput);
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    let cur = existing;
    for (const ed of edits) {
      const next = applyEdit(cur, ed);
      if (next === null) return null;
      cur = next;
    }
    return cur;
  }
  return null;
}

// Substring replacement for an Edit-shaped object. Returns the new text or
// null when old_string isn't present (malformed input — let the actual tool
// surface the error to Claude with its native messaging).
function applyEdit(text, edit) {
  if (!edit || typeof edit !== 'object') return null;
  const oldStr = typeof edit.old_string === 'string' ? edit.old_string : null;
  const newStr = typeof edit.new_string === 'string' ? edit.new_string : null;
  if (oldStr === null || newStr === null) return null;
  if (oldStr.length === 0) {
    // Empty old_string is ambiguous; let the tool reject it natively.
    return null;
  }
  if (edit.replace_all === true) {
    // Manual replaceAll to avoid regex semantics.
    return text.split(oldStr).join(newStr);
  }
  const idx = text.indexOf(oldStr);
  if (idx === -1) return null; // missing — fail-open as documented.
  return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
}

// Diff helper: return all lines in `proposed` that aren't in `existing`.
// This is the "newly-added lines" set the gate inspects.
//
// We split on \r?\n and use a multiset semantics: a line added twice is
// counted twice (both are gate-checked). Same line repeated in existing
// suppresses an equal count in proposed. The order returned matches the
// order they appear in `proposed`.
function computeNewLines(existing, proposed) {
  if (typeof existing !== 'string') existing = '';
  if (typeof proposed !== 'string') proposed = '';

  const existingLines = existing.split(/\r?\n/);
  const proposedLines = proposed.split(/\r?\n/);

  // Build a multiset of existing line counts.
  const counts = new Map();
  for (const l of existingLines) {
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }

  const out = [];
  for (const l of proposedLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      counts.set(l, c - 1);
      continue;
    }
    out.push(l);
  }
  return out;
}

// -----------------------------------------------------------------------------

// Best-effort path normalisation: if `input` is under `cwd`, return the
// project-relative POSIX path; otherwise return null. Mirrors
// lib/graph/read.mjs `normalizePath` but exposed locally so we don't
// import a private helper.
function computeRelPath(input, cwd) {
  if (typeof input !== 'string' || typeof cwd !== 'string') return null;
  if (!path.isAbsolute(input)) {
    return input.split(path.sep).join('/');
  }
  const absRoot = path.resolve(cwd);
  if (input === absRoot) return '';
  const prefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (!input.startsWith(prefix)) return null;
  const rel = input.slice(prefix.length).split(path.sep).join('/');
  // Strip a leading './' if present (path.relative shouldn't produce one, but
  // be defensive).
  return rel.startsWith('./') ? rel.slice(2) : rel;
}

function buildActionDetail(tool, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return tool.toLowerCase();
  if (tool === 'Bash') {
    const cmd = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
    return cmd.length > 0 ? `bash: ${cmd.slice(0, 40)}` : 'bash';
  }
  if (typeof toolInput.file_path === 'string') {
    const base = toolInput.file_path.split('/').pop() || toolInput.file_path;
    return `${tool.toLowerCase()} ${base}`;
  }
  return tool.toLowerCase();
}

// MCP / AskUserQuestion corpora are harvested by recursively collecting
// string-valued args (keys are syntax, not signal). Cap the total so a huge
// MCP payload can't blow up the BM25 query or the word-boundary scan.
const CORPUS_HARVEST_CAP = 4096;

// harvestStrings: depth-first collect of every string leaf under `value`,
// pushed onto `out` until `budget.remaining` (chars, incl. join spaces) runs
// out. Pure aside from mutating `out`/`budget`.
function harvestStrings(value, out, budget) {
  if (budget.remaining <= 0) return;
  if (typeof value === 'string') {
    const take = value.slice(0, budget.remaining);
    if (take.length > 0) {
      out.push(take);
      budget.remaining -= take.length + 1; // +1 ≈ the join separator
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (budget.remaining <= 0) break;
      harvestStrings(v, out, budget);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      if (budget.remaining <= 0) break;
      harvestStrings(value[k], out, budget);
    }
  }
}

// buildKeywordCorpus: the per-tool query text fed to the kw resolver (spec
// §13.2). Each tool contributes only its signal-bearing fields — never a raw
// JSON.stringify (keys + punctuation are noise that pollute BM25). The
// broadened AC-only surfaces (Task/WebFetch/WebSearch/AskUserQuestion/
// NotebookEdit/MCP) land here via the T4 matcher. Exported for unit tests.
export function buildKeywordCorpus(tool, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const s = (v) => (typeof v === 'string' ? v : '');
  const join = (parts, sep) => parts.filter((p) => p && p.length > 0).join(sep);

  switch (tool) {
    case 'Bash':
      return s(toolInput.command);
    case 'Read':
      return s(toolInput.file_path);
    case 'Grep':
    case 'Glob':
      return join([s(toolInput.pattern), s(toolInput.path)], ' ');
    case 'Edit':
      return join([s(toolInput.file_path), s(toolInput.new_string)], '\n');
    case 'Write':
      return join([s(toolInput.file_path), s(toolInput.content)], '\n');
    case 'MultiEdit': {
      const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
      const parts = [s(toolInput.file_path)];
      for (const e of edits) {
        if (e && typeof e.new_string === 'string') parts.push(e.new_string);
      }
      return join(parts, '\n');
    }
    case 'Task':
      return join([s(toolInput.description), s(toolInput.prompt), s(toolInput.subagent_type)], ' ');
    case 'WebFetch':
      return join([s(toolInput.url), s(toolInput.prompt)], ' ');
    case 'WebSearch':
      return s(toolInput.query);
    case 'NotebookEdit':
      return join([s(toolInput.notebook_path || toolInput.file_path), s(toolInput.new_source)], '\n');
    case 'AskUserQuestion': {
      // question + option texts — harvest the `questions` array (handles the
      // single-question legacy shape too via the toolInput fallback).
      const out = [];
      harvestStrings(toolInput.questions ?? toolInput, out, { remaining: CORPUS_HARVEST_CAP });
      return out.join(' ');
    }
    default: {
      // MCP (mcp__<server>__<tool>): recursively harvest string-valued args,
      // capped at ~4 KB. Any other unmapped tool falls back to file_path —
      // never a JSON dump.
      if (typeof tool === 'string' && tool.startsWith('mcp__')) {
        const out = [];
        harvestStrings(toolInput, out, { remaining: CORPUS_HARVEST_CAP });
        return out.join(' ');
      }
      return s(toolInput.file_path);
    }
  }
}

function formatKeywordBlock(rules) {
  const bullets = rules.map((r) => `  - ${r.body ?? r.raw}`).join('\n');
  return `<!-- sextant:keyword-rules -->\nApply these rules — they matched keywords in your action.\nrules matching your action (${rules.length}):\n${bullets}\n<!-- /sextant:keyword-rules -->`;
}

// cerebrum-v2 T5.6: node-scoped rules surfaced on a WRITE to their file. Its own
// block — these matched by FILE SCOPE (the file being edited), not by keywords,
// so the keyword header would be a lie. Fires 100% on every write (no dedup);
// the write is the safety-critical moment a [node:F] rule most needs to assert.
// T6 owns the final prose.
function formatNodeWriteBlock(rules) {
  const bullets = rules.map((r) => `  - ${r.body ?? r.raw}`).join('\n');
  return `<!-- sextant:node-rules -->\nApply these rules — they govern the file you are editing.\nrules for this file (${rules.length}):\n${bullets}\n<!-- /sextant:node-rules -->`;
}

function formatBashGlobalBlock(rules) {
  const bullets = rules.map((r) => `  - ${r.body ?? r.raw}`).join('\n');
  return `<!-- sextant:bash-global-rules -->\nApply every rule below before running this command.\nrules (${rules.length}):\n${bullets}\n<!-- /sextant:bash-global-rules -->`;
}

// formatActionGlobalBlock: the globals+kw block for the broadened AC-only
// surfaces (Task/WebFetch/WebSearch/AskUserQuestion/NotebookEdit/MCP). Same
// shape as the Bash block with neutral, tool-agnostic wording (T6 owns prose).
function formatActionGlobalBlock(rules, tool) {
  const bullets = rules.map((r) => `  - ${r.body ?? r.raw}`).join('\n');
  const label = typeof tool === 'string' && tool.length > 0 ? tool : 'this action';
  return `<!-- sextant:action-rules -->\nApply every rule below before this ${label} action.\nrules (${rules.length}):\n${bullets}\n<!-- /sextant:action-rules -->`;
}

// toolEmitsGlobals: which non-Read tools re-assert [!global] rules (deduped)
// alongside kw matches. Bash always has; T4 adds the broadened AC-only
// surfaces. Grep/Glob/Edit/Write stay kw-only (Read already surfaced globals
// before an edit; re-emitting there is redundant noise). `mcp__*` is matched
// by prefix (the matcher admits mcp__<server>__<tool>).
const BROADENED_AC_TOOLS = new Set(['Task', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'NotebookEdit']);
function toolEmitsGlobals(tool) {
  if (tool === 'Bash') return true;
  if (typeof tool !== 'string') return false;
  return BROADENED_AC_TOOLS.has(tool) || tool.startsWith('mcp__');
}

async function bumpKeywordFires(sid, rules, cwd) {
  try {
    await withState(sid, cwd, (state) => {
      state.rules.fires_this_turn = (state.rules.fires_this_turn ?? 0) + rules.length;
      state.rules.mandatory_fires = (state.rules.mandatory_fires ?? 0) + rules.length;
    });
  } catch {}
}

// recordGlobalsDeduped: treatment-arm-only stats bump. Counts one
// suppression of the [!global] rule set (i.e., we'd have emitted the
// full block but for the session-scoped digest match). Mirrors the
// gating in instrumentTreatmentArm — control-arm sessions must not
// Tranche doc protection: deny edits to frozen charter, shipped scope files;
// ask on checklist-incomplete scope files. Returns an envelope or null.
async function enforceTrancheDocProtection(filePath, cwd) {
  const tState = await readTranches(cwd);
  if (!tState.feature || tState.workflow_state === 'IDLE') return null;

  const relPath = path.relative(cwd, filePath);

  // 1. Charter freeze: deny if past PLANNING.
  if (tState.charter_path && relPath === tState.charter_path && tState.workflow_state !== 'PLANNING') {
    if (tState.pending_amendment) {
      tState.pending_amendment = false;
      await writeTranches(cwd, tState);
      return null;
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Sextant: ${tState.charter_path} is frozen (workflow is past PLANNING). Charter edits require an amendment. Run /sextant:tranche-amend first.`,
      },
    };
  }

  // 2. Shipped scope protection: deny if file is in a SHIPPED/ARCHIVED tranche's scope.
  // Exemption: a file that is also in the scope of ANY not-yet-shipped tranche
  // (STUB / READY / IN-FLIGHT) is part of planned, in-scope work and must NOT be
  // blocked — nor consume the one-shot pending_amendment. A file that ships with an
  // early tranche but is legitimately re-touched by a later one (the common case:
  // a store/hook owned by several tranches) stays edit-free for the whole feature;
  // the freeze only protects shipped files that NO pending tranche re-claims.
  // (Previously this exempted IN-FLIGHT scope only, which re-froze files a future
  // STUB/READY tranche owned and forced a per-edit amendment dance.)
  const pendingScope = new Set(
    tState.tranches
      .filter((t) => t.status !== 'SHIPPED' && t.status !== 'ARCHIVED' && Array.isArray(t.scope))
      .flatMap((t) => t.scope),
  );
  if (!pendingScope.has(relPath)) {
    for (const t of tState.tranches) {
      if (t.status !== 'SHIPPED' && t.status !== 'ARCHIVED') continue;
      if (!Array.isArray(t.scope)) continue;
      if (t.scope.includes(relPath)) {
        if (tState.pending_amendment) {
          tState.pending_amendment = false;
          await writeTranches(cwd, tState);
          return null;
        }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Sextant: ${relPath} belongs to tranche T${t.id} "${t.title}" which is ${t.status}. Edits to shipped tranche files are blocked. Run /sextant:tranche-amend first.`,
          },
        };
      }
    }
  }

  // 3. Checklist gate: deny if scope file edited before checklist complete.
  // v0.44.0: was `ask`. The remediation is self-serve and read-only (run the
  // grep-and-read pre-step, then /sextant:tranche-advance), so `deny` keeps the
  // agent in a fix-and-retry loop it can clear on its own — and never shows the
  // user a permission card whose reason CC would discard anyway (see the
  // [node:lib/hooks/preToolUse.mjs] cerebrum rule on file-tool cards).
  const active = activeTranche(tState);
  if (active && active.status === 'READY' && !active.checklist_complete) {
    if (Array.isArray(active.scope) && active.scope.includes(relPath)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Sextant: pre-implementation checklist not complete for T${active.id}. Run the grep-and-read pre-step and then /sextant:tranche-advance to confirm readiness before editing scope files.`,
        },
      };
    }
  }

  return null;
}

// pollute the ledger per § 10.5.
async function recordGlobalsDeduped({ sid, cwd }) {
  if (!sid || !cwd || typeof cwd !== 'string') return;
  try {
    let arm = 'A';
    try {
      const state = await readState(sid, cwd);
      arm = state && typeof state.ab_arm === 'string' ? state.ab_arm : 'A';
    } catch {
      arm = 'A';
    }
    if (arm !== 'B') return;
    const base = durableBase(cwd);
    const stats = await readStats(base);
    stats.ab_arm = 'B';
    bumpGlobalsDeduped(stats);
    await writeStats(base, stats);
  } catch (err) {
    process.stderr.write(`sextant: preToolUse globals-deduped stats err=${err.message}\n`);
  }
}
