// lib/hooks/userPromptSubmit.mjs — UserPromptSubmit handler.
//
// Phase 0: log only. Phase 6 wires in preload + cross-turn dedup.
//
// Phase 2b additions (§ 5.8.3):
//   - Increment turn_id + reset started_at on turn-state.json. PostToolUse
//     uses started_at as the cutoff for "this turn" when deciding whether
//     to attribute a cerebrum write to a recent project-file edit.
//   - Read-modify-write preserves any other fields (pending_restore from
//     PreCompact, etc.).
//
// Phase 2.5 additions (§ 5.15.b):
//   - At the top: if turn-state.json#pending_restore is true, read
//     precompact.json, build the restoration block, emit as
//     additionalContext. Clear pending_restore + rotate precompact.json
//     to precompact-<ts>.json for diagnostics retention.
//   - The turn-id bump happens AFTER the restore-block emit so a fresh
//     pending_restore that lands inside the same UserPromptSubmit fires
//     once (and not again on the next prompt).
//
// Phase 6 additions (§ 5.2 + § 8 Phase 6):
//   - Clear injected_nodes at the very start (each turn begins fresh).
//   - After the restoration drain + turn-id bump, parse `payload.prompt`
//     for file paths + capitalized identifiers. If the project's graph has
//     matching nodes, emit a tiny "preload" block per node so the agent's
//     prompt mention gets a hint card before any subsequent Read.
//   - Record the injected node ids in turn-state.json#injected_nodes so
//     the per-Read block at PreToolUse can dedup against them this turn.

import path from 'node:path';
import fs from 'node:fs/promises';

import { readModifyJson } from '../io.mjs';
import { withState } from '../state.mjs';
import { turnStatePath, durableBase, rulesFiredPath, ensureRuntimeDir } from '../paths.mjs';
import { READ_NODES_SEEN_FIELD } from './mandatoryGlobals.mjs';
import { dedupKeywordMatches } from './keywordDedup.mjs';
import { resolveKeywordMatches } from '../retrieval/keywordRules.mjs';
import { readTranches, activeTranche, resetSessionCaptures, readTrancheDeliverables, readTrancheUnchecked } from '../stores/tranches.mjs';
import { composeTrancheNudge } from './tranchesInject.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { composeCaptureNudge } from './captureNudge.mjs';
import { readCaptureNudgeMode } from '../config.mjs';
import { buildRestorationBlock, readPrecompactSnapshot, clearPendingRestore } from './restore.mjs';
import { loadGraph, findFileNode } from '../graph/read.mjs';
import { GRAPH, NODE, EDGE } from '../graph/schema.mjs';
import { extractPaths, extractSymbols, filterToGraph } from '../inject/promptExtract.mjs';

// Cap on how many nodes we surface in a single preload. The block is
// "hints" not full briefings, so 10 is comfortably more than any prompt
// actually needs.
const PRELOAD_MAX_NODES = 10;

// Combined cap on restoration + preload concatenated body. The composer
// owns its own per-Read cap; this is the UserPromptSubmit budget.
const TOTAL_BUDGET_CHARS = 10_000;

// Preload block markers (per task spec § 5.2).
const PRELOAD_OPEN = '<!-- sextant:prompt-preload -->';
const PRELOAD_CLOSE = '<!-- /sextant:prompt-preload -->';

export default async function userPromptSubmit(payload, ctx) {
  const sid = payload.session_id;
  const sidCwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  await ctx.log({ ts: ctx.nowIso(), event: 'UserPromptSubmit', sid });

  // Phase 6: clear cross-turn dedup state at the very start. Each turn
  // gets a fresh injected_nodes window — and (cerebrum-v2 T5.6) a fresh
  // node-read-seen window, so a [node:F] rule re-surfaces once per turn when
  // the agent returns to that file in a later prompt.
  try {
    await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
      o.injected_nodes = [];
      o[READ_NODES_SEEN_FIELD] = [];
    });
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit injected_nodes reset err=${err.message}\n`);
  }

  // Phase 2.5: pending_restore drains here. If precompact.json exists and
  // pending_restore=true, build the restoration block, clear the flag, and
  // emit additionalContext.
  let restoreBlock = null;
  try {
    const snapshot = await readPrecompactSnapshot(sid, sidCwd);
    if (snapshot) {
      restoreBlock = buildRestorationBlock(snapshot.payload || {});
      await clearPendingRestore(sid, snapshot.ts, sidCwd);
    }
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit restore err=${err.message}\n`);
  }

  // Bump turn counter + reset turn start. Failures here must not crash the
  // hook — turn-state.json is best-effort scratch.
  try {
    await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
      o.turn_id = (typeof o.turn_id === 'number' && Number.isFinite(o.turn_id))
        ? o.turn_id + 1
        : 1;
      o.started_at = new Date().toISOString();
    });
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit turn-state bump err=${err.message}\n`);
  }

  // Phase 6: build the preload block from the prompt. All steps degrade
  // gracefully to "no preload": no prompt, no graph, no matches, no work.
  let preloadBlock = null;
  let preloadNodeIds = [];
  try {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    if (prompt.length > 0 && cwd) {
      const built = await buildPreload(prompt, cwd);
      if (built) {
        preloadBlock = built.block;
        preloadNodeIds = built.nodeIds;
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit preload err=${err.message}\n`);
  }

  // Record injected nodes so PreToolUse Read dedups against them this turn.
  if (preloadNodeIds.length > 0) {
    try {
      await readModifyJson(turnStatePath(sid, sidCwd), (o) => {
        o.injected_nodes = Array.isArray(o.injected_nodes) ? o.injected_nodes : [];
        for (const id of preloadNodeIds) {
          if (!o.injected_nodes.includes(id)) o.injected_nodes.push(id);
        }
      });
    } catch (err) {
      process.stderr.write(`sextant: userPromptSubmit injected_nodes write err=${err.message}\n`);
    }
  }

  // Keyword-triggered rules: match user prompt against [kw:] buckets.
  let keywordBlock = null;
  try {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const kwCwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    if (prompt.length > 0 && kwCwd) {
      // BM25 over the `keywords` field at READ minScore ∪ the [!] exact-floor.
      // The resolver freshens cerebrum.md first, then windowed-dedup.
      const cerebrumDir = path.join(durableBase(kwCwd), 'cerebrum');
      const matches = await resolveKeywordMatches({
        cerebrumDir, durableBase: durableBase(kwCwd), corpus: prompt, mode: 'READ',
      });
      const kwRules = await dedupKeywordMatches(matches, sid, kwCwd);
      if (kwRules.length > 0) {
        const bullets = kwRules.map((r) => `  - ${r.body ?? r.raw}`).join('\n');
        keywordBlock = `<!-- sextant:keyword-rules -->\nApply these rules — they matched keywords in your prompt.\nmandatory rules (${kwRules.length}):\n${bullets}\n<!-- /sextant:keyword-rules -->`;
        try {
          await withState(sid, sidCwd, (state) => {
            state.rules = state.rules ?? { fires_this_turn: 0, mandatory_fires: 0, blocked: 0, deny_red: false };
            state.rules.fires_this_turn = (state.rules.fires_this_turn ?? 0) + kwRules.length;
            state.rules.mandatory_fires = (state.rules.mandatory_fires ?? 0) + kwRules.length;
          });
        } catch {}

        // T3-A: log prompt-fired keyword rules to rules-fired.jsonl so the Stop
        // turn-summary breakdown counts them. preToolUse only logs Read-path
        // fires, so without this the keyword count undercounts (and preCompact
        // restoration too). Bucket '[!]' is what stop.mjs maps to "keyword".
        // Best-effort: a write failure must never disturb prompt handling.
        try {
          const firedTs = ctx.nowIso();
          const cerebrumRel = path
            .relative(kwCwd, path.join(durableBase(kwCwd), 'cerebrum', 'cerebrum.md'))
            .split(path.sep).join('/');
          const entries = kwRules.map((r) => JSON.stringify({
            ts: firedTs,
            body: typeof r.body === 'string' ? r.body : (typeof r.raw === 'string' ? r.raw : ''),
            source_file: cerebrumRel,
            bucket: '[!]',
          }));
          await ensureRuntimeDir(sid, sidCwd);
          await fs.appendFile(rulesFiredPath(sid, sidCwd), entries.map((l) => l + '\n').join(''), 'utf8');
        } catch { /* best-effort */ }
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit keyword-match err=${err.message}\n`);
  }

  // Tranche nudge: inject active tranche context every turn (not deduped).
  let trancheBlock = null;
  try {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    if (cwd) {
      const tState = await readTranches(cwd);
      const active = activeTranche(tState);
      if (active) {
        // Parse the deliverables straight from the live tranche doc every turn
        // (cheap slice — see readTrancheDeliverables) rather than the stale
        // SessionStart cache, so the nudge tracks mid-session advances. Coerce
        // empty → null to keep composeTrancheNudge's "omit the line" contract.
        const summary = await readTrancheDeliverables(cwd, active.doc_path);
        const liveSummary = summary.length ? summary : null;

        // Surface the active tranche's CURRENT-PHASE open unknowns + relevant
        // open carry-forward concerns, live each turn. Pre-flight (STUB/READY)
        // → impl questions (block READY); in-flight → before-ship questions
        // (block ship / escalate). Concerns: untargeted OR aimed at this tranche.
        let unknowns = null;
        if (active.status === 'IN-FLIGHT') {
          const items = await readTrancheUnchecked(cwd, active.doc_path, 'open questions before ship');
          if (items.length) unknowns = { label: 'before ship', items };
        } else if (active.status === 'STUB' || active.status === 'READY') {
          const items = await readTrancheUnchecked(cwd, active.doc_path, 'open questions before implementation');
          if (items.length) unknowns = { label: 'before READY', items };
        }
        const concerns = (Array.isArray(tState.carry_forward) ? tState.carry_forward : [])
          .filter((c) => c && c.status === 'open' && (c.target == null || c.target === active.id));
        trancheBlock = composeTrancheNudge(tState, liveSummary, { unknowns, concerns });

        // Check for "no captures needed" acknowledgment in the prompt.
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        if (/no captures needed/i.test(prompt)) {
          try {
            await withState(sid, sidCwd, (state) => {
              state.tranche_capture_acknowledged = true;
            });
          } catch {}
        }
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit tranche-nudge err=${err.message}\n`);
  }

  // Non-tranche capture nudge: drain the pending flag the previous Stop set
  // when it detected trip-up trigger words. Consumed exactly once (cleared in
  // the same withState), injected as a soft STANDING note — the agent records
  // the lesson when the user asks (or when it fits), not preempting their
  // prompt. Never set while a tranche is active, so it can't collide with the
  // tranche nudge. Best-effort: a failure must not disturb prompt handling.
  let captureNudgeBlock = null;
  try {
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
    if (cwd && (await readCaptureNudgeMode(cwd)) !== 'off') {
      let pending = null;
      await withState(sid, sidCwd, (state) => {
        if (state.capture_nudge_pending) {
          pending = state.capture_nudge_pending;
          state.capture_nudge_pending = null;
        }
      });
      if (pending) {
        captureNudgeBlock = composeCaptureNudge(Array.isArray(pending.words) ? pending.words : []);
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: userPromptSubmit capture-nudge err=${err.message}\n`);
  }

  // Concatenate: restoration > tranche nudge > capture nudge > keyword > preload.
  const kwAndPreload = concatBlocks(keywordBlock, preloadBlock, TOTAL_BUDGET_CHARS);
  const captureAndKw = concatBlocks(captureNudgeBlock, kwAndPreload, TOTAL_BUDGET_CHARS);
  const trancheAndRest = concatBlocks(trancheBlock, captureAndKw, TOTAL_BUDGET_CHARS);
  const additionalContext = concatBlocks(restoreBlock, trancheAndRest, TOTAL_BUDGET_CHARS);
  let result = (additionalContext && additionalContext.length > 0)
    ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
    : undefined;

  // Verbose-only orientation signal: which project files this prompt primed
  // (graph matches whose wallpaper the agent now holds). routine level →
  // suppressed unless output=verbose; no suppression key (fires each priming).
  if (preloadNodeIds.length > 0) {
    const names = preloadNodeIds.map((id) => id.replace(/^node:/, ''));
    const shown = names.slice(0, 5);
    const extra = names.length > shown.length ? ` +${names.length - shown.length} more` : '';
    result = await mergeSystemMessage(result, `primed ${shown.join(', ')}${extra}`,
      { category: 'info', level: 'routine', sid, cwd: sidCwd });
  }
  return result;
}

// concatBlocks: returns either a single block, or both joined by a newline,
// honouring a total budget. Restoration goes FIRST when present; the preload
// is the lower-priority "you mentioned this file" hint.
function concatBlocks(restoration, preload, budget) {
  if (!restoration && !preload) return '';
  if (!preload) return restoration ?? '';
  if (!restoration) return preload;
  const sep = '\n';
  if (restoration.length + sep.length + preload.length <= budget) {
    return restoration + sep + preload;
  }
  // Cap exceeded: drop the preload (it's the lower-priority section). The
  // restoration block has its own internal cap and is already minimal.
  return restoration;
}

// buildPreload(prompt, cwd):
//   - Load the graph (return null if missing).
//   - Extract paths + capitalized identifiers from the prompt.
//   - For each path: resolve to a graph node via findFileNode.
//   - For each symbol: resolve to its parent file node by scanning the
//     graph's nodes (handled by filterToGraph).
//   - Dedup by nodeId. Render one tiny block per node, cap at PRELOAD_MAX_NODES.
//   - Wrap in marker fences.
//
// Returns null when there's nothing to render. Otherwise:
//   { block: <string>, nodeIds: <string[]> }
async function buildPreload(prompt, cwd) {
  let graph = null;
  try {
    graph = await loadGraph(cwd);
  } catch {
    graph = null;
  }
  if (!graph) return null;

  const paths = extractPaths(prompt);
  const symbols = extractSymbols(prompt);
  if (paths.length === 0 && symbols.length === 0) return null;

  // Resolve each into a graph node. Track first-occurrence order so the
  // rendered block is deterministic per prompt.
  const order = [];
  const seen = new Set();
  function consider(node) {
    if (!node || typeof node !== 'object') return;
    const id = node[NODE.ID];
    if (typeof id !== 'string' || id.length === 0) return;
    if (seen.has(id)) return;
    seen.add(id);
    order.push(node);
  }
  for (const p of paths) {
    const n = findFileNode(graph, p, { root: cwd });
    if (n) consider(n);
  }
  const symHits = filterToGraph(symbols, graph);
  for (const { nodeId } of symHits) {
    const n = findNodeById(graph, nodeId);
    if (n) consider(n);
  }

  if (order.length === 0) return null;

  // Render at most PRELOAD_MAX_NODES blocks. For each: a small Markdown-ish
  // section listing the file's identity + top connections + top symbols.
  // R13: action imperative for Opus 4.7.
  const lines = [PRELOAD_OPEN, 'Use the following graph context when editing or reasoning about these files.'];
  const renderedIds = [];
  for (const n of order.slice(0, PRELOAD_MAX_NODES)) {
    lines.push(renderNodePreload(graph, n));
    renderedIds.push(n[NODE.ID]);
  }
  lines.push(PRELOAD_CLOSE);
  return { block: lines.join('\n'), nodeIds: renderedIds };
}

function findNodeById(graph, id) {
  const nodes = graph && graph[GRAPH.NODES];
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n && n[NODE.ID] === id) return n;
  }
  return null;
}

// Render a single "you mentioned this file" preload block for a node.
// Intentionally smaller than the per-Read block (priority 3-6 in compose.mjs)
// — this is a hint, not the full briefing the per-Read block produces.
//
//   ## <relPath>
//   graph: <label>; community: <c>
//   connections (top 2): -> <a>, -> <b>
//   symbols (top 5): foo(), bar(), Baz
function renderNodePreload(graph, node) {
  const relPath = typeof node[NODE.PATH] === 'string' ? node[NODE.PATH] : '<unknown>';
  const label = typeof node[NODE.LABEL] === 'string' && node[NODE.LABEL].length > 0
    ? node[NODE.LABEL]
    : relPath;
  const community = node[NODE.COMMUNITY];
  const communityStr = (community === null || community === undefined) ? 'none' : `#${community}`;

  const out = [];
  out.push(`## ${relPath}`);
  out.push(`graph: ${label}; community: ${communityStr}`);

  // Top 2 outbound connections (intentionally lower than the per-Read 3).
  const conns = topConnectionsLite(graph, node, 2);
  if (conns.length > 0) {
    const items = conns.map((c) => `-> ${c}`).join(', ');
    out.push(`connections (top ${conns.length}): ${items}`);
  }

  // Top 5 symbols, lowercased ones get () suffix as in the per-Read block.
  const syms = Array.isArray(node[NODE.SYMBOLS]) ? node[NODE.SYMBOLS].slice(0, 5) : [];
  if (syms.length > 0) {
    const rendered = syms.map(renderSymbolName).join(', ');
    out.push(`symbols (top ${syms.length}): ${rendered}`);
  }
  return out.join('\n');
}

// Lite version of lib/inject/compose.mjs's connection renderer: returns up
// to k target labels (no edge-type / confidence noise — preload is supposed
// to be smaller). Order: edge insertion order, no ranking heuristic.
function topConnectionsLite(graph, node, k) {
  const nodeId = node[NODE.ID];
  const edges = Array.isArray(graph[GRAPH.EDGES]) ? graph[GRAPH.EDGES] : [];
  const nodes = Array.isArray(graph[GRAPH.NODES]) ? graph[GRAPH.NODES] : [];
  const out = [];
  for (const e of edges) {
    if (e[EDGE.FROM] !== nodeId) continue;
    const toId = e[EDGE.TO];
    const target = nodes.find((n) => n[NODE.ID] === toId);
    let label;
    if (target && typeof target[NODE.LABEL] === 'string' && target[NODE.LABEL].length > 0) {
      label = target[NODE.LABEL];
    } else if (typeof toId === 'string') {
      if (toId.startsWith('node:')) label = toId.slice(5);
      else if (toId.startsWith('unresolved:')) label = toId.slice(11);
      else label = toId;
    } else {
      label = '<unknown>';
    }
    out.push(label);
    if (out.length >= k) break;
  }
  return out;
}

function renderSymbolName(name) {
  if (typeof name !== 'string' || name.length === 0) return String(name);
  const first = name.charAt(0);
  if (first >= 'a' && first <= 'z') return `${name}()`;
  return name;
}

// Exported markers for tests + downstream tooling.
export const PROMPT_PRELOAD_OPEN_MARKER = PRELOAD_OPEN;
export const PROMPT_PRELOAD_CLOSE_MARKER = PRELOAD_CLOSE;

// Sanity probe: `path` import is here for future hook-level use (e.g.,
// resolving relative paths against cwd outside findFileNode). Keep live.
void path;
