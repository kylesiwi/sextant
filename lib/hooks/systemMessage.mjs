// lib/hooks/systemMessage.mjs — the single path for user-facing status lines.
//
// Every Sextant `systemMessage` flows through mergeSystemMessage(). The merge is
// GUARDED (charter anchor 1): a hook returns one result object that bin/cli.mjs
// serializes in a single write, and `systemMessage` shares that object with the
// authoritative `hookSpecificOutput.additionalContext`. So this helper must
// NEVER throw and never yield a non-serializable value — on any failure it
// returns the caller's `result` untouched, so a broken message can never drop or
// corrupt rule injection.
//
// Rendering reality (verified 2026-06-02): CC shows `systemMessage` as
// `<HookEvent> says: <text>`. The prefix is fixed/unstyleable; OUR text after a
// leading newline carries 16-color ANSI. Embedded newlines render, so multiple
// lines compose under one `says:` block. No emoji, no truecolor, no attributes;
// the line must read correctly with all escapes stripped.

import { withState } from '../state.mjs';
import { readOutputMode } from '../config.mjs';

// 16-color floor. Body color is chosen by category; the `sextant: ` prefix is
// always bright white. Always reset so color can't bleed into later output.
const RESET = '\x1b[0m';
const PREFIX_COLOR = '\x1b[97m'; // bright white
const CATEGORY_COLOR = {
  error: '\x1b[33m', // yellow  — errors / warnings
  rules: '\x1b[32m', // green   — rules injected / captured
  info: '\x1b[34m', // blue    — informational
  transition: '\x1b[36m', // cyan    — tranche / lifecycle changes
};
const PREFIX = 'sextant: ';
const MAX_TEXT_LEN = 300;

// formatMessage: one styled line. Leading newline drops the text below CC's
// fixed `<HookEvent> says:` prefix; internal whitespace is collapsed to a single
// line; length is capped. Returns '' for empty input (caller emits nothing).
//
// `bare`: omit the `sextant: ` prefix. Used for CONTINUATION lines (the verbose
// `·` per-rule details under a headline) so a multi-line block reads as one unit
// — the prefixed headline followed by bare detail lines — instead of every line
// looking like a separate `sextant:` message.
export function formatMessage(text, { category = 'info', bare = false } = {}) {
  const bodyColor = CATEGORY_COLOR[category] ?? CATEGORY_COLOR.info;
  let t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length > MAX_TEXT_LEN) t = `${t.slice(0, MAX_TEXT_LEN - 1)}…`;
  if (bare) return `\n${bodyColor}${t}${RESET}`;
  return `\n${PREFIX_COLOR}${PREFIX}${RESET}${bodyColor}${t}${RESET}`;
}

// messageMode: resolve the durable output mode (off | quiet | verbose). Single
// source of truth — reads .sextant/config.json, defaults to quiet. No env vars.
export async function messageMode(cwd) {
  return readOutputMode(cwd);
}

// claimSuppressionKey: atomic check-and-set of a one-shot key in the firing
// map. scope 'session' uses systemmessage_fired_session (survives Stop — once
// per session); 'turn' (default) uses systemmessage_fired (cleared every Stop —
// re-arms each turn). Returns true if THIS call claimed the key (i.e. should
// emit). On any uncertainty (no state context, lock timeout, error) it returns
// true — we'd rather occasionally double a line than silently drop one;
// suppression is best-effort, emission is the point.
async function claimSuppressionKey({ sid, cwd, key, scope }) {
  if (!sid || !cwd) return true;
  const field = scope === 'session' ? 'systemmessage_fired_session' : 'systemmessage_fired';
  let claimed = false;
  try {
    const state = await withState(sid, cwd, (s) => {
      const fired = s[field] ?? {};
      if (!fired[key]) {
        claimed = true;
        s[field] = { ...fired, [key]: true };
      }
    });
    if (state === null) return true; // lock timeout — emit rather than drop
    return claimed;
  } catch {
    return true;
  }
}

// mergeSystemMessage(result, line, opts) -> result
//   result : the hook's in-progress result object, or null/undefined for a
//            message-only result. Returned (possibly unchanged).
//   line   : a string, or a () => string|null producer (run in try/catch).
//   opts   : { category, level, key, scope, sid, cwd }
//     category: 'error'|'rules'|'info'|'transition'  (body color)   default 'info'
//     level   : 'transition' (quiet-visible) | 'routine' (verbose-only)  default 'routine'
//     key     : one-shot suppression key (optional)
//     scope   : 'turn' (re-arms each Stop) | 'session' (once per session)  default 'turn'
//     sid,cwd : needed to resolve mode + suppression state
//
// Never throws. Appends one formatted line to result.systemMessage, composing
// multi-line (newline-joined) across repeated calls on the same result.
//
// CONTRACT — do NOT call this from inside a withState() block on the same
// (sid, cwd). When a `key` is given it acquires its OWN withState lock to
// check-and-set suppression; nested on a held lock it would spin to the 50ms
// timeout, return null, and silently disable suppression (and stall the fire).
// Compute your message data inside withState if you must, then call this AFTER
// the lock is released — mirroring the existing `shouldEmit`-outside-lock idiom.
export async function mergeSystemMessage(result, line, opts = {}) {
  try {
    const { category = 'info', level = 'routine', key, scope = 'turn', sid, cwd, bare = false } = opts;

    // 1. Mode gate.
    const mode = await messageMode(cwd);
    if (mode === 'off') return result;

    // 2. Produce the text (guarded — a throwing producer means "no line").
    let text;
    try {
      text = typeof line === 'function' ? line() : line;
    } catch {
      return result;
    }
    if (typeof text !== 'string' && typeof text !== 'number') return result;
    text = String(text);
    if (text.trim() === '') return result;

    // 3. Level gate: routine lines are suppressed under quiet.
    if (level === 'routine' && mode === 'quiet') return result;

    // 4. One-shot suppression (bypassed under verbose).
    if (key && mode !== 'verbose') {
      const allow = await claimSuppressionKey({ sid, cwd, key, scope });
      if (!allow) return result;
    }

    // 5. Format + merge. Always a String; never clobbers additionalContext.
    const formatted = formatMessage(text, { category, bare });
    if (!formatted) return result;
    const target = (result && typeof result === 'object') ? result : {};
    const existing = typeof target.systemMessage === 'string' ? target.systemMessage : '';
    target.systemMessage = existing + formatted;
    return target;
  } catch {
    // Last-ditch: a message failure must never harm the hook's real output.
    return result;
  }
}
