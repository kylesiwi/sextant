// lib/hooks/captureNudge.mjs — non-tranche capture nudges.
//
// The tranche capture gate (stop.mjs + tranchesInject.mjs) only fires while a
// tranche is IN-FLIGHT. Outside a tranche there is no scaffolding nudging the
// agent to record durable lessons — capture is purely voluntary. This module
// adds a SOFT, non-blocking nudge for ordinary turns:
//
//   1. At Stop, scan the agent's VISIBLE output for "trip-up" trigger words
//      (the kind of word that tends to precede a gotcha worth capturing).
//   2. If matched and no rule was captured this turn, set a pending flag in hot
//      state (consumed next turn as model-facing additionalContext) and — on a
//      STRONG match — surface a user-facing systemMessage so the user can ask
//      the agent to record the rules.
//
// Why visible output only and not thinking: Claude Code does NOT persist
// thinking text to the transcript JSONL (every `thinking` block is stored with
// an empty `thinking` field and only a `signature`), so a hook can't read it.
// Visible output is also higher-precision for these words than thinking, where
// the model course-corrects constantly.
//
// Two tiers, by signal strength (advisor guidance — the user-facing claim must
// not be more confident than a bare word match warrants):
//   - WEAK triggers (the broad, high-frequency set the user named) set ONLY the
//     model-facing flag. The agent silently decides whether there's anything
//     there; a false positive costs nothing user-visible.
//   - STRONG triggers (high-precision "this is a gotcha" phrases) ALSO raise the
//     user-facing line, since a dead-end "add those rules" → "nothing to add"
//     exchange is worse than a silent model-only miss.

import fs from 'node:fs/promises';

import { pollUntil } from '../poll.mjs';

// Tail size for the transcript read. The current turn's assistant output sits
// at the end of the JSONL; we only ever read this tail so a multi-MB transcript
// stays cheap. Nothing here is injected into the model's context.
const TRANSCRIPT_TAIL_BYTES = 65536;

// Poll budget for the transcript-flush race (bug-7 sibling). At Stop the current
// turn's last assistant message may not be flushed to the JSONL yet on a slow /
// 9p mount, so a single read can miss a trigger word that lives in that tail.
//
// The cost profile is INVERTED vs stop.mjs's ack poll, so the budget is smaller
// (100 vs 250ms). For stop the negative case (no ack) is rare — most turns ack
// or capture — so the full budget is seldom paid. Here the negative case (a
// genuinely triggerless turn) is the COMMON one, and it pays the FULL budget for
// nothing: re-reading an already-flushed transcript can't conjure a trigger word
// that isn't there. The poll only helps the narrow case where a trigger sits in
// the last not-yet-flushed message — and unlike stop's ack (which IS the final
// line), trigger words are usually scattered across the turn's already-flushed
// output. So we keep the budget short: catch the tail-flush gap without taxing
// every quiet turn's end. A genuine match still returns on the first read.
const CAPTURE_NUDGE_POLL = { budgetMs: 100, intervalMs: 25 };

// WEAK triggers — high-frequency, low-precision. The user named these. They set
// the model flag but never the user-facing line.
export const WEAK_TRIGGERS = ['wait', 'problem', 'critical', 'gap'];

// STRONG triggers — high-precision phrases that strongly imply a durable lesson.
// These raise BOTH the model flag and the user-facing systemMessage.
export const STRONG_TRIGGERS = [
  'gotcha', 'footgun', 'pitfall', 'root cause', 'non-obvious',
  'easy to miss', 'watch out', 'be careful', 'turns out', 'caveat',
];

function buildRe(words) {
  // Word-boundary, case-insensitive. Phrases (with spaces / hyphens) match
  // literally; the surrounding \b anchors them to whole-word boundaries.
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`\\b(${alt})\\b`, 'gi');
}

const WEAK_RE = buildRe(WEAK_TRIGGERS);
const STRONG_RE = buildRe(STRONG_TRIGGERS);

// extractAssistantVisibleText(entry): the user-VISIBLE text of an assistant
// transcript entry — `type:'text'` blocks (and bare strings) only. Thinking and
// tool_use blocks are excluded. Deliberately SEPARATE from stop.mjs's
// extractAssistantText (whose output feeds a head-anchored ack check); widening
// that one to include thinking would silently break the tranche gate.
function extractAssistantVisibleText(entry) {
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join(' ');
}

// realUserPromptText(entry): the human-typed prompt text of a `user` entry, or
// '' if this is not a real prompt. Tool results arrive as `user` entries too,
// but their content is `tool_result` blocks (no text), so they yield '' and are
// NOT treated as a turn boundary.
function realUserPromptText(entry) {
  const role = entry?.message?.role || entry?.role || entry?.type || '';
  if (role !== 'user') return '';
  const content = entry?.message?.content ?? entry?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (typeof b === 'string') parts.push(b);
    else if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    // tool_result / tool_use / image blocks contribute nothing → not a prompt.
  }
  return parts.join(' ');
}

// currentTurnAssistantText(text): given the raw tail, return the concatenated
// VISIBLE assistant text of the current turn — everything the assistant emitted
// AFTER the most recent real user prompt. Walking backward and stopping at that
// prompt scopes the scan to this turn, so a "Wait" from three turns ago can't
// re-fire, while mid-turn narration (where these words actually live, not just
// the final summary) is still included.
export function currentTurnAssistantText(tail) {
  if (!tail || !tail.text) return '';
  const lines = tail.text.split(/\r?\n/);
  // A truncated first line (tail started past byte 0) can't be parsed cleanly.
  if (tail.partial && lines.length > 0) lines.shift();

  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip partial/non-JSON */ }
  }

  const chunks = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (realUserPromptText(e)) break; // start of the current turn — stop.
    const role = e?.message?.role || e?.role || e?.type || '';
    if (role === 'assistant') {
      const t = extractAssistantVisibleText(e);
      if (t) chunks.push(t);
    }
  }
  return chunks.reverse().join('\n');
}

function uniqMatches(re, text) {
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(re)) {
    const w = m[1].toLowerCase();
    if (!seen.has(w)) { seen.add(w); out.push(m[1]); }
  }
  return out;
}

// scanTurnTriggers(transcriptPath, opts?): scan the current turn's visible
// assistant output for trigger words. Returns:
//   { matched: bool, strong: bool, words: string[] }
// matched = any trigger (weak ∪ strong) hit → model flag worthwhile.
// strong  = a STRONG trigger hit → user-facing line is warranted.
// words   = the distinct matched terms (display order: strong first).
// Any read/parse failure → { matched:false, strong:false, words:[] }.
//
// Wrapped in pollUntil to beat the transcript-flush race (see CAPTURE_NUDGE_POLL
// and stop.mjs:agentRepliedNoCaptures): a genuine match returns on the first
// read; only a no-match turn pays the (short) budget. opts (budgetMs/intervalMs)
// passes straight through — { budgetMs: 0 } is a single immediate scan (used by
// the negative tests so they don't tax the suite).
export async function scanTurnTriggers(transcriptPath, opts = CAPTURE_NUDGE_POLL) {
  const none = { matched: false, strong: false, words: [] };
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return none;
  const result = await pollUntil(
    () => scanTurnTriggersOnce(transcriptPath).then((scan) => (scan.matched ? scan : null)),
    opts,
  );
  return result || none;
}

// scanTurnTriggersOnce(transcriptPath): a single tail-read + scan. The polling
// wrapper above re-runs this until a trigger appears or the budget elapses.
async function scanTurnTriggersOnce(transcriptPath) {
  const none = { matched: false, strong: false, words: [] };
  let tail;
  try {
    tail = await readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return none;
  }
  if (!tail) return none;
  const text = currentTurnAssistantText(tail);
  if (!text) return none;

  const strongWords = uniqMatches(STRONG_RE, text);
  const weakWords = uniqMatches(WEAK_RE, text);
  const matched = strongWords.length > 0 || weakWords.length > 0;
  if (!matched) return none;
  return {
    matched: true,
    strong: strongWords.length > 0,
    words: [...strongWords, ...weakWords],
  };
}

// Marker fences for the model-facing block (matches the tranche-nudge style).
const NUDGE_OPEN = '<!-- sextant:capture-nudge -->';
const NUDGE_CLOSE = '<!-- /sextant:capture-nudge -->';

// composeCaptureNudge(words): the model-facing additionalContext injected on the
// turn AFTER a trigger fired. Phrased as a STANDING NOTE, not an imperative —
// the user's own flow is "okay, do it, AND THEN do X", so capture is one item
// among others and must not preempt the actual request.
export function composeCaptureNudge(words) {
  const flagged = Array.isArray(words) && words.length > 0
    ? ` (you wrote: ${words.slice(0, 4).map((w) => `"${w}"`).join(', ')})`
    : '';
  const body = [
    `Earlier this turn you flagged something that might be a durable lesson${flagged}.`,
    'If it is — a gotcha, a non-obvious constraint, a root cause worth remembering —',
    'record it with /sextant:remember (pick --node / --keywords / --global for scope).',
    "If the user's prompt asks for other work, do that first; don't let capture preempt",
    'their request, and skip this silently if there was nothing durable to capture.',
  ].join(' ');
  return `${NUDGE_OPEN}\n${body}\n${NUDGE_CLOSE}`;
}

// composeCaptureNudgeUserMessage(): the user-facing systemMessage shown at Stop
// on a STRONG match. Wording is deliberately tentative ("might contain") — the
// mechanism detected a word, not a verified rule, and the user pays the cost of
// any over-claim (they'd tell the agent to "add those rules" and it finds none).
export function composeCaptureNudgeUserMessage() {
  return 'this turn might contain capturable lessons — the agent has been nudged; '
    + 'say "record those rules" next prompt to have it write them with /sextant:remember';
}

// readFileTail(filePath, maxBytes): read at most the last maxBytes of a file.
// Returns { text, partial } (partial = read started past byte 0). null on error.
// Mirrors stop.mjs's reader; kept local so this module is self-contained.
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
