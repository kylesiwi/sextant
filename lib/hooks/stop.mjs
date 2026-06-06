// lib/hooks/stop.mjs — Stop handler.
//
// Phase 0: end-of-turn reset. Symmetric with SessionEnd.
//
// Cross-session continuity (§ 7.7): Stop fires at the end of every turn, so
// writing last.json here means a session that crashes between turns still
// leaves a checkpoint for the next SessionStart to surface. Multiple writes
// are safe — last write wins, and the snapshot is captured before reset so
// the just-finished turn's counters are recorded.

import fs from 'node:fs/promises';

import { withState, readState, resetTurnAndSession } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { readJson } from '../io.mjs';
import { rulesFiredPath, rulesAuthoredPath, turnStatePath } from '../paths.mjs';
import { snapshotLast } from './snapshotLast.mjs';
import { readTranches, activeTranche, readTrancheDoc } from '../stores/tranches.mjs';
import { composeStopCapturePrompt } from './tranchesInject.mjs';
import { scanTurnTriggers, composeCaptureNudgeUserMessage } from './captureNudge.mjs';
import { readCaptureNudgeMode } from '../config.mjs';
import { collectRuleLint, composeFormatGateReason, cerebrumStorePath } from './cerebrumFormatGate.mjs';
import { readCerebrumFile, lineHash } from '../stores/cerebrum.mjs';
import { pollUntil } from '../poll.mjs';

const STOP_BLOCK_LIMIT = 3;

// Non-tranche capture nudge: minimum turns between consecutive nudges. The nudge
// is soft and fires on a bare word match (the user chose "trigger words only"),
// so a cooldown keeps it from pinging every turn. Measured in turn-state turn_id
// (bumped each UserPromptSubmit), so ~one nudge per 3 turns at most.
const CAPTURE_NUDGE_COOLDOWN_TURNS = 3;

// Max chars of a rule body shown in a verbose digest detail line (before the
// `(×N)` / hash decoration). The whole formatted line is further capped by
// systemMessage.mjs's MAX_TEXT_LEN (300), which leaves room for the decoration.
const SUMMARY_SNIPPET_MAX = 200;

// Tail size for the transcript read. The last assistant message is at the end
// of the JSONL; we ALWAYS read only this tail (never the whole file) so a
// multi-MB transcript stays cheap. This is internal hook I/O — nothing here is
// injected into the model's context.
const TRANSCRIPT_TAIL_BYTES = 65536;

// isNoCapturesAck(text): does this message ACKNOWLEDGE "no captures needed"?
// Anchored to the START (after stripping leading quotes / markdown / punct) —
// deliberately STRICTER than userPromptSubmit's plain /no captures needed/i.
// The capture nudge itself contains the phrase ("Reply 'no captures needed'")
// but begins with "Sextant: Tranche ...", so a nudge echoed into the transcript
// can NOT match here and falsely clear the gate. A genuine reply ("No captures
// needed.") starts with the phrase and matches.
function isNoCapturesAck(text) {
  if (typeof text !== 'string') return false;
  const head = text.trim().replace(/^[^a-z]*/i, ''); // drop leading quotes/markdown/punct/space
  return /^no captures needed/i.test(head);
}

export default async function stop(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  await ctx.log({ ts: ctx.nowIso(), event: 'Stop', sid });

  // Snapshot BEFORE the reset; resetTurnAndSession would otherwise zero
  // rules.fires_this_turn / rules.mandatory_fires before we read them.
  await snapshotLast(sid, cwd, ctx.nowIso());

  // T2/T3-I: compose the end-of-turn summary up front, while this turn's
  // rules-fired data is intact, so it can be attached to EVERY return path —
  // including the capture/format `decision:block` returns below. Without this,
  // the summary only surfaced on the clean reset path, which an IN-FLIGHT
  // capture gate rarely reaches (the gate blocks most turns). attachSummary
  // merges the lines onto whatever result we return; it runs mergeSystemMessage
  // OUTSIDE any withState lock (every gate block releases its lock first).
  const summaryLines = await collectTurnSummaryLines(sid, cwd);

  // T3-C: tranche-transition line. Diff the current tranche state against the
  // snapshot from last Stop (stored in hot state, which survives the turn reset).
  // Update the snapshot on EVERY Stop — block paths included — so a transition is
  // emitted once, not re-emitted on subsequent gated turns. This withState runs
  // before attachSummary (which takes its own lock), so there's no nesting.
  if (cwd) {
    try {
      const currentTranche = await readTrancheSnapshotForSummary(cwd);
      const prevState = await readState(sid, cwd);
      const tl = diffTrancheTransition(prevState && prevState.tranche_summary_prev, currentTranche);
      if (tl) summaryLines.push(tl);
      if (currentTranche) {
        await withState(sid, cwd, (state) => { state.tranche_summary_prev = currentTranche; });
      }
    } catch (err) {
      process.stderr.write(`sextant: stop tranche-transition err=${err.message}\n`);
    }
  }

  // T3-B: authored-rule line. COUNT comes from rules-authored.jsonl — one entry
  // per `cerebrum remember` event (logged by postToolUse:Bash), filtered to this
  // turn. This is a genuine-author signal: it does NOT move when auto-tag /
  // promote / reconcile rehash an existing rule in place (those change a rule's
  // line-hash without authoring anything, so a hash set-diff would falsely count
  // them). The verbose snippet is enriched from the cerebrum tail (freshly
  // appended rules sit at the end with their correct current hash); if that read
  // fails we fall back to count-only.
  {
    const authored = await collectAuthoredRuleLines(sid, cwd);
    for (const ln of authored) summaryLines.push(ln);
  }

  const attachSummary = async (result) => {
    let r = result;
    for (const ln of summaryLines) {
      r = await mergeSystemMessage(r, ln.text, {
        category: ln.category, level: ln.level || 'transition', bare: ln.bare, sid, cwd,
      });
    }
    return r;
  };

  // Tranche auto-capture enforcement: block turn end if IN-FLIGHT and
  // no learnings captured. Blocking is signaled purely via the JSON
  // { decision: 'block', reason } shape — `reason` is the field Claude Code
  // feeds back to the model. The dispatcher always exits 0, so there is no
  // "exit code 2" path; an exitCode key in the return would only corrupt the
  // stdout JSON and fail Claude Code's Stop-hook schema validation.
  if (cwd && !payload.parent_session_id) {
    try {
      const tState = await readTranches(cwd);
      const active = activeTranche(tState);
      if (active && tState.workflow_state === 'IMPLEMENTING') {
        const captures = tState.captures_this_session || { rules: 0, bugs: 0 };
        const hasCaptured = captures.rules > 0 || captures.bugs > 0;

        let acknowledged = false;
        try {
          const state = await import('../state.mjs').then(m => m.readState(sid, cwd));
          acknowledged = !!state?.tranche_capture_acknowledged;
        } catch {}

        // Also honor the agent REPLYING "no captures needed" — what the nudge
        // literally instructs. userPromptSubmit only sees a *human* typing it;
        // an assistant reply never reaches that hook, so without this the gate
        // loops until the safety valve (the echoing the user reported). We read
        // the transcript rather than trusting stop_hook_active because capture
        // compliance is a property of hook execution, not agent memory: we
        // require a real acknowledgment, not release-on-any-continuation.
        // Fail-safe: any read error → stays blocked; the safety valve backstops.
        if (!hasCaptured && !acknowledged) {
          try {
            acknowledged = await agentRepliedNoCaptures(payload.transcript_path);
          } catch { /* stay blocked */ }
        }

        if (!hasCaptured && !acknowledged) {
          let blockCount = 0;
          try {
            await withState(sid, cwd, (state) => {
              state.tranche_stop_block_count = (state.tranche_stop_block_count ?? 0) + 1;
              blockCount = state.tranche_stop_block_count;
            });
          } catch {}

          if (blockCount <= STOP_BLOCK_LIMIT) {
            let docParsed = null;
            if (active.doc_path) {
              try { docParsed = await readTrancheDoc(cwd, active.doc_path); } catch {}
            }
            const prompt = composeStopCapturePrompt(tState, docParsed);

            await withState(sid, cwd, (state) => {
              state.last_event = { tag: 'Stop', ts: ctx.nowIso(), detail: 'capture-gate' };
            });

            // `reason` is model-facing AND surfaced to the user. The turn
            // summary rides alongside as a `systemMessage` (different text →
            // distinct render, not the double-render we avoid by never making
            // systemMessage == reason). T3-I: this is how the summary surfaces
            // during an IN-FLIGHT capture gate.
            return await attachSummary({
              decision: 'block',
              reason: prompt,
            });
          }
        } else {
          // Gate satisfied this turn (captured or acknowledged) — clear the
          // consecutive-block counter so a later turn starts with a fresh gate
          // instead of inheriting blocks toward the session-lifetime valve.
          try {
            await withState(sid, cwd, (state) => { state.tranche_stop_block_count = 0; });
          } catch {}
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: stop tranche-capture err=${err.message}\n`);
    }
  }

  // cerebrum-v2 T5.5: rule-format gate. Block end-of-turn when a rule ADDED this
  // session is mis-formatted (errors only). The accepted-hash set (seeded at
  // SessionStart) restricts checking to session-new rules; fail-open at 3 records
  // the rule as accepted so it never re-blocks; the counter advances only when no
  // progress is made. Primary sessions only — subagents log (subagentStop.mjs).
  if (cwd && !payload.parent_session_id) {
    try {
      const gate = await runCerebrumFormatGate({ sid, cwd, ctx });
      if (gate) return await attachSummary(gate); // { decision: 'block', reason } + summary
    } catch (err) {
      process.stderr.write(`sextant: stop cerebrum-format err=${err.message}\n`);
    }
  }

  await withState(sid, cwd, (state) => {
    resetTurnAndSession(state);
    state.last_event = { tag: 'Stop', ts: ctx.nowIso(), detail: 'idle' };
  });

  // Non-tranche capture nudge (soft, non-blocking). Scan THIS turn's visible
  // output for trip-up trigger words; if any matched and no rule was captured
  // this turn, set a pending flag (injected as additionalContext on the next
  // UserPromptSubmit) and — on a STRONG match only — push a user-facing line so
  // the user can ask the agent to record the rules. Skipped: inside a tranche
  // (the IN-FLIGHT gate owns capture there), under capture_nudge=off, during the
  // cooldown, and on subagent stops. The pending flag is set AFTER the reset
  // (resetTurnAndSession leaves custom fields alone) and the user line is pushed
  // to summaryLines BEFORE the return below, so attachSummary emits it. All
  // best-effort: a failure here must never disturb the clean turn end.
  if (cwd && sid && !payload.parent_session_id) {
    try {
      const mode = await readCaptureNudgeMode(cwd);
      if (mode !== 'off') {
        const tState = await readTranches(cwd);
        const inTranche = !!activeTranche(tState);
        const authoredThisTurn = await countAuthoredThisTurn(sid, cwd);
        if (inTranche || authoredThisTurn > 0) {
          // In a tranche the gate owns it; if a rule was just captured there is
          // nothing to nudge — clear any stale pending flag so the next turn
          // isn't nudged for a lesson the agent already recorded.
          if (!inTranche && authoredThisTurn > 0) {
            await withState(sid, cwd, (state) => {
              if (state.capture_nudge_pending) state.capture_nudge_pending = null;
            });
          }
        } else {
          const turnState = await readJson(turnStatePath(sid, cwd));
          const turnId = (turnState && Number.isFinite(turnState.turn_id)) ? turnState.turn_id : 0;
          const prev = await readState(sid, cwd);
          const lastNudge = (prev && Number.isFinite(prev.capture_nudge_last_turn))
            ? prev.capture_nudge_last_turn : -Infinity;
          if (turnId - lastNudge >= CAPTURE_NUDGE_COOLDOWN_TURNS) {
            const scan = await scanTurnTriggers(payload.transcript_path);
            if (scan.matched) {
              await withState(sid, cwd, (state) => {
                state.capture_nudge_pending = { words: scan.words.slice(0, 4), turn: turnId };
                state.capture_nudge_last_turn = turnId;
              });
              if (scan.strong) {
                summaryLines.push({
                  text: composeCaptureNudgeUserMessage(),
                  category: 'rules', level: 'transition',
                });
              }
            }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`sextant: stop capture-nudge err=${err.message}\n`);
    }
  }

  // Emit the summary on the clean turn-end, AFTER the reset lock releases.
  return attachSummary(undefined);
}

// collectTurnSummaryLines: the multi-line end-of-turn summary. v1 surfaces the
// rules-injected breakdown (path / global / keyword) from rules-fired.jsonl,
// scoped to THIS turn. Returns [] (→ silent) when nothing notable fired.
// NOTE (T2 scope): rules-fired.jsonl logs mandatory rule fires from preToolUse
// (Read path) only — prompt-fired keyword rules are not yet logged there; T3
// (which owns userPromptSubmit) completes the keyword count.
async function collectTurnSummaryLines(sid, cwd) {
  const lines = [];
  if (!sid) return lines;
  try {
    const bd = await readTurnRuleBreakdown(sid, cwd);
    if (bd.total > 0) {
      const parts = [];
      if (bd.node) parts.push(`${bd.node} path`);
      if (bd.global) parts.push(`${bd.global} global`);
      if (bd.kw) parts.push(`${bd.kw} keyword`);
      let text = `${bd.total} rule${bd.total === 1 ? '' : 's'} injected this turn`;
      if (parts.length) text += ` (${parts.join(', ')})`;
      lines.push({ text, category: 'rules', level: 'transition' });

      // T3-D: verbose-only per-rule expansion — one `routine` line per DISTINCT
      // fired rule (first SUMMARY_SNIPPET_MAX chars of body). routine ⇒ shown only
      // under `verbose`; quiet sees just the count line above. Identical rules
      // are collapsed to one line with a `(×N)` multiplier: a node rule fires
      // once per Read/Edit of its file, so the same rule recurs many times in a
      // turn — a digest should show it once, not N times (the headline still
      // counts every fire; per-tool flows still see each one). Capped on the
      // number of distinct rules.
      // The detail lines quote the rules' OWN text, so they render `info` (blue)
      // to set them apart from Sextant's green summary headline above.
      const MAX_EXPAND = 12;
      const groups = dedupRuleBodies(bd.entries);
      for (const g of groups.slice(0, MAX_EXPAND)) {
        const snippet = g.body.slice(0, SUMMARY_SNIPPET_MAX);
        const suffix = g.count > 1 ? ` (×${g.count})` : '';
        lines.push({ text: `· ${snippet}${suffix}`, category: 'info', level: 'routine', bare: true });
      }
      if (groups.length > MAX_EXPAND) {
        lines.push({
          text: `· …and ${groups.length - MAX_EXPAND} more`,
          category: 'info', level: 'routine', bare: true,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: stop turn-summary err=${err.message}\n`);
  }
  return lines;
}

function oneLine(s) {
  return (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();
}

// dedupRuleBodies(entries): collapse identical rule bodies to [{ body, count }]
// in first-seen order. Two fires of the same rule (e.g. a node rule re-firing on
// each Read/Edit of its file) share one group with count++. Empty bodies are
// skipped. The whole-body string is the key (not the truncated snippet) so two
// different rules with a common leading prefix never merge.
function dedupRuleBodies(entries) {
  const groups = [];
  const byBody = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    const body = oneLine(e && e.body);
    if (!body) continue;
    const existing = byBody.get(body);
    if (existing) { existing.count++; continue; }
    const g = { body, count: 1 };
    byBody.set(body, g);
    groups.push(g);
  }
  return groups;
}

// collectAuthoredRuleLines(sid, cwd): the T3-B summary lines for rules authored
// this turn. COUNT = rules-authored.jsonl entries with ts >= this turn's start
// (one entry per `cerebrum remember`, logged by postToolUse:Bash). The verbose
// per-rule snippet is enriched from the cerebrum tail — the last N rules sit at
// the end with their current hash; if that read fails we degrade to count-only.
// [] when nothing was authored. Best-effort: never throws.
async function collectAuthoredRuleLines(sid, cwd) {
  const lines = [];
  if (!sid) return lines;
  try {
    const n = await countAuthoredThisTurn(sid, cwd);
    if (n <= 0) return lines;
    lines.push({
      text: `${n} rule${n === 1 ? '' : 's'} authored this turn`,
      category: 'rules', level: 'transition',
    });

    // Detail lines quote the rules' own text → `info` (blue), distinct from the
    // green summary headline above.
    const MAX_EXPAND = 12;
    const tail = await readCerebrumTailRules(cwd, Math.min(n, MAX_EXPAND));
    for (const r of tail) {
      const snippet = oneLine(r.body).slice(0, SUMMARY_SNIPPET_MAX);
      const h = typeof r.hash === 'string' ? r.hash.slice(0, 8) : '';
      const text = snippet ? `· ${h} — ${snippet}` : (h ? `· ${h}` : null);
      if (text) lines.push({ text, category: 'info', level: 'routine', bare: true });
    }
    if (n > MAX_EXPAND) {
      lines.push({
        text: `· …and ${n - MAX_EXPAND} more`,
        category: 'info', level: 'routine', bare: true,
      });
    }
  } catch (err) {
    process.stderr.write(`sextant: stop authored-rule err=${err.message}\n`);
  }
  return lines;
}

// countAuthoredThisTurn(sid, cwd): number of rules-authored.jsonl entries whose
// ts is >= turn-state.started_at. The log accumulates across the session (never
// truncated), so the turn filter is mandatory — same discipline as the
// rules-fired breakdown. 0 on any read failure.
async function countAuthoredThisTurn(sid, cwd) {
  try {
    const turnState = await readJson(turnStatePath(sid, cwd));
    const startTs = (turnState && typeof turnState.started_at === 'string')
      ? turnState.started_at : null;
    let raw;
    try {
      raw = await fs.readFile(rulesAuthoredPath(sid, cwd), 'utf8');
    } catch {
      return 0;
    }
    let count = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (startTs && typeof e.ts === 'string' && e.ts < startTs) continue;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

// readCerebrumTailRules(cwd, n): the last n rule { hash, body } in store order.
// hash = lineHash(raw), matching the format gate and the rest of the codebase.
// Empty array on any read/parse failure (caller degrades to count-only).
async function readCerebrumTailRules(cwd, n) {
  if (!cwd || !(n > 0)) return [];
  try {
    const parsed = await readCerebrumFile(cerebrumStorePath(cwd));
    const lines = (parsed && Array.isArray(parsed.lines)) ? parsed.lines : [];
    const rules = [];
    for (const e of lines) {
      if (!e || e.kind !== 'rule' || typeof e.raw !== 'string') continue;
      rules.push({ hash: lineHash(e.raw), body: typeof e.body === 'string' ? e.body : '' });
    }
    return rules.slice(-n);
  } catch {
    return [];
  }
}

// readTurnRuleBreakdown: count this-turn rule fires by bucket from
// rules-fired.jsonl. The file accumulates across the session and is never
// truncated, so we filter by ts >= turn-state.started_at. Unknown/empty buckets
// are not counted (they don't map to a user-meaningful type).
async function readTurnRuleBreakdown(sid, cwd) {
  const out = { node: 0, global: 0, kw: 0, total: 0, entries: [] };
  try {
    const turnState = await readJson(turnStatePath(sid, cwd));
    const startTs = (turnState && typeof turnState.started_at === 'string')
      ? turnState.started_at : null;
    let raw;
    try {
      raw = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (startTs && typeof e.ts === 'string' && e.ts < startTs) continue;
      // Bucket labels vary by append site: preToolUse's per-fire logger writes a
      // single most-specific label (`[node:…]` / `[!global]` / `[!]`), while the
      // write-gate logger and the v2 store carry COMPOSITE labels like
      // `[kw:a,b][!]`. Classify by substring (priority node > global > keyword)
      // so composite labels aren't silently dropped. (Empty bucket → not counted.)
      const b = typeof e.bucket === 'string' ? e.bucket : '';
      if (b.includes('node:')) out.node++;
      else if (b.includes('global')) out.global++;
      else if (b.includes('kw:') || b.includes('!')) out.kw++;
      else continue;
      out.total++;
      out.entries.push({ bucket: b, body: typeof e.body === 'string' ? e.body : '' });
    }
  } catch { /* best-effort — no summary on read failure */ }
  return out;
}

// readTrancheSnapshotForSummary: a compact snapshot of tranche state for diffing
// — { workflow_state, active, statuses: {id: status} }. null when no active
// feature (nothing to report).
async function readTrancheSnapshotForSummary(cwd) {
  try {
    const t = await readTranches(cwd);
    if (!t || !t.feature) return null;
    const statuses = {};
    for (const tr of (t.tranches || [])) {
      if (tr && tr.id != null) statuses[String(tr.id)] = tr.status || null;
    }
    return { workflow_state: t.workflow_state || null, active: t.active_tranche_id ?? null, statuses };
  } catch {
    return null;
  }
}

// diffTrancheTransition: a `transition` summary line describing what changed
// between two snapshots, or null when nothing changed / no baseline. Status
// changes win; a bare workflow_state change is reported if no tranche moved.
function diffTrancheTransition(prev, cur) {
  if (!prev || !cur) return null;
  const changes = [];
  const ids = [...new Set([...Object.keys(prev.statuses || {}), ...Object.keys(cur.statuses || {})])].sort();
  for (const id of ids) {
    const a = (prev.statuses || {})[id];
    const b = (cur.statuses || {})[id];
    if (a !== b && b) changes.push(`T${id} ${a || '—'} → ${b}`);
  }
  if (changes.length === 0 && prev.workflow_state !== cur.workflow_state && cur.workflow_state) {
    changes.push(`workflow → ${cur.workflow_state}`);
  }
  if (changes.length === 0) return null;
  return { text: changes.join(', '), category: 'transition', level: 'transition' };
}

// runCerebrumFormatGate({ sid, cwd, ctx }): the stateful orchestration around
// collectRuleLint. Returns a { decision: 'block', reason } envelope when a
// session-new rule has format errors and the block budget isn't exhausted; null
// otherwise (clean, baseline-seed, or fail-open). All state lives at the top
// level of session state, which survives resetTurnAndSession.
async function runCerebrumFormatGate({ sid, cwd, ctx }) {
  let accepted = null;
  try {
    const st = await readState(sid, cwd);
    accepted = Array.isArray(st?.cerebrum_accepted_hashes) ? st.cerebrum_accepted_hashes : null;
  } catch { accepted = null; }

  const { allHashes, cleanHashes, failing } = await collectRuleLint(cwd, accepted || []);

  // No baseline (SessionStart didn't seed / legacy session): establish it now
  // and never gate pre-existing rules.
  if (accepted === null) {
    await withState(sid, cwd, (state) => { state.cerebrum_accepted_hashes = allHashes; });
    return null;
  }

  // Always accept the clean session-new rules so they aren't re-linted later.
  const acceptClean = (state) => {
    const set = new Set(state.cerebrum_accepted_hashes || []);
    for (const h of cleanHashes) set.add(h);
    state.cerebrum_accepted_hashes = [...set];
  };

  if (failing.length === 0) {
    await withState(sid, cwd, (state) => {
      acceptClean(state);
      state.cerebrum_format_block_count = 0;
      state.cerebrum_last_failing = [];
    });
    return null;
  }

  // Some session-new rules have errors. Advance the counter only on NO progress
  // (failing-set unchanged or grew, or a new failing hash appeared) — a pure
  // shrink means the agent is fixing, so don't burn the valve (advisor #4).
  const newFailing = failing.map((f) => f.hash);
  let blockCount = 0;
  await withState(sid, cwd, (state) => {
    acceptClean(state);
    const last = new Set(state.cerebrum_last_failing || []);
    const cur = new Set(newFailing);
    const allInLast = [...cur].every((h) => last.has(h));
    const pureShrink = allInLast && cur.size < last.size;
    if (!pureShrink) {
      state.cerebrum_format_block_count = (state.cerebrum_format_block_count ?? 0) + 1;
    }
    blockCount = state.cerebrum_format_block_count ?? 0;
    state.cerebrum_last_failing = newFailing;
  });

  if (blockCount <= STOP_BLOCK_LIMIT) {
    await withState(sid, cwd, (state) => {
      state.last_event = { tag: 'Stop', ts: ctx.nowIso(), detail: 'cerebrum-format-gate' };
    });
    return { decision: 'block', reason: composeFormatGateReason(failing) };
  }

  // Fail-open: record the offending rules as accepted (they never re-block) and
  // reset the gate. doctor re-lints the whole store, so the malformed rule is
  // still surfaced later — we just stop trapping the agent here.
  await withState(sid, cwd, (state) => {
    const set = new Set(state.cerebrum_accepted_hashes || []);
    for (const h of newFailing) set.add(h);
    state.cerebrum_accepted_hashes = [...set];
    state.cerebrum_format_block_count = 0;
    state.cerebrum_last_failing = [];
  });
  process.stderr.write(`sextant: stop cerebrum-format gate fail-open after ${STOP_BLOCK_LIMIT} tries; ${failing.length} rule(s) let through (run /sextant:doctor)\n`);
  return null;
}

// agentRepliedNoCaptures(transcriptPath, opts?): true when the most recent
// assistant message in the transcript JSONL contains the acknowledgment phrase.
//
// The reply the nudge asks for ("no captures needed") is appended to the
// transcript as the turn ends, but the write is not always visible to this hook
// the instant Stop fires — on slow / 9p (WSL2→Windows) mounts the append lags by
// tens of ms. A single read therefore MISSES a genuine ack, the gate re-blocks,
// and the nudge loops until the 3-strike valve fails open (bug-7 residual). So
// we poll via the shared pollUntil (default budget): a real ack returns on the
// first read; only a turn with NO ack pays the full wait. Pass opts (budgetMs /
// intervalMs) straight through — { budgetMs: 0 } means a single immediate read.
// Any read failure → false (caller stays blocked).
export async function agentRepliedNoCaptures(transcriptPath, opts = {}) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return false;
  return pollUntil(() => transcriptHasAck(transcriptPath), opts);
}

// transcriptHasAck(transcriptPath): single tail-read + parse. Tail-read only
// (the reply is at the end). Any failure → false.
async function transcriptHasAck(transcriptPath) {
  const tail = await readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!tail) return false;
  const lines = tail.text.split(/\r?\n/);
  // When we didn't start at byte 0 the first line is probably truncated.
  if (tail.partial && lines.length > 0) lines.shift();

  let lastAssistantText = '';
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const role = (entry && (entry.message?.role || entry.role || entry.type)) || '';
    if (role !== 'assistant') continue;
    const text = extractAssistantText(entry);
    if (text) lastAssistantText = text; // keep the most recent non-empty text
  }
  // Only the SINGLE most-recent assistant message is tested, so a "no captures
  // needed" from an earlier turn (or earlier in this turn) never clears a later
  // stop.
  return isNoCapturesAck(lastAssistantText);
}

// Pull the text out of a transcript entry, handling the content shapes the
// codebase already sees elsewhere (entry.message.content[] blocks, entry.content
// array, or a bare string).
function extractAssistantText(entry) {
  const content = (entry && entry.message && entry.message.content !== undefined)
    ? entry.message.content
    : (entry ? entry.content : undefined);
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') parts.push(b);
      else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.join(' ');
  }
  return '';
}

// readFileTail(filePath, maxBytes): read at most the last maxBytes of a file.
// Returns { text, partial } where partial indicates the read started past byte
// 0 (so the first line may be truncated). null on any error.
async function readFileTail(filePath, maxBytes) {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const st = await fh.stat();
    const size = st.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return { text: '', partial: false };
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return { text: buf.toString('utf8'), partial: start > 0 };
  } catch {
    return null;
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
}
