// lib/hooks/postToolUseFailure.mjs — PostToolUseFailure handler.
//
// Spec § 5.10: detect stuck loops — the same (tool, file) failing N+
// consecutive times. After the 3rd (default) consecutive failure on the same
// (tool, file), emit:
//   - additionalContext with a "stuck-loop" hint block (read the file fresh,
//     try a different tool, reconsider assumptions).
//   - One-shot systemMessage so the user/agent sees the nudge inline.
//   - Update state.last_event.tag to `stuck:<Tool>×<count>` for the statusline.
//
// State field used: state.stuck = { tool, file, count }. Different (tool,
// file) failure resets the counter via the "else" branch. Suppression key
// `stuck_<tool>_<sha1Short(file)>` ensures we fire at most once per burst.
//
// Known v1.1 limitation: this hook fires only on FAILURE, so a successful
// tool use in the middle of an Edit×2 streak cannot reset the counter (we'd
// need postToolUse.mjs to clear state.stuck on success, which is outside the
// scope of this change). The failure mode is over-suppression on a transient
// success followed by more failures on the same (tool, file); the nudge still
// fires correctly on real stuck loops.

import crypto from 'node:crypto';

import { withState } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';

const DEFAULT_STUCK_THRESHOLD = 3;
const STUCKABLE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);

function parseEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function sha1Short(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 8);
}

// Pull the file path out of the tool input where it's obvious. Bash failures
// are heterogeneous — we don't try to parse arbitrary command lines; only
// pattern-match a few clear shapes (cat/head/tail/Read-style commands with a
// single path argument). Returns null if we can't identify a single file.
function extractFilePath(toolInput, tool) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
    return typeof toolInput.file_path === 'string' && toolInput.file_path.length > 0
      ? toolInput.file_path
      : null;
  }
  if (tool === 'Bash') {
    // Heuristic: detect a stable (command-prefix, single-path-arg) signature.
    // We avoid over-aggressive parsing — anything with pipes, redirects, or
    // multiple positional args returns null so we don't false-count.
    const cmd = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
    if (!cmd) return null;
    if (/[|<>;&`$()]/.test(cmd)) return null;
    const tokens = cmd.split(/\s+/);
    if (tokens.length !== 2) return null;
    const head = tokens[0];
    // Only well-known single-path verbs.
    if (!/^(cat|head|tail|less|wc|file|stat|ls)$/.test(head)) return null;
    return `${head}:${tokens[1]}`;
  }
  return null;
}

// R13: rewritten for Opus 4.7 — imperative steps replace "Consider" suggestions.
function composeStuckBlock({ tool, file, count }) {
  return [
    '<!-- sextant:stuck-loop -->',
    `${tool} on \`${file}\` has failed ${count} consecutive times. Stop retrying the same approach.`,
    '',
    `1. Re-read \`${file}\` to get its current contents before your next edit attempt.`,
    '2. If the file changed since you last read it, base your edit on the new contents.',
    '3. If the error message is the same each time, your assumption about the file state is wrong — read related code to find the actual structure.',
    `4. If \`Edit\` keeps failing, switch to \`Write\` with the complete new file contents.`,
    '<!-- /sextant:stuck-loop -->',
  ].join('\n');
}

export default async function postToolUseFailure(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const tool = payload.tool_name ?? null;
  const filePath = extractFilePath(payload.tool_input, tool);
  const STUCK_THRESHOLD = parseEnvInt('SEXTANT_STUCK_THRESHOLD', DEFAULT_STUCK_THRESHOLD);

  await ctx.log({ ts: ctx.nowIso(), event: 'PostToolUseFailure', sid, tool, file: filePath });

  // Only track tools where "stuck" makes sense AND we have a clear file/key.
  if (!STUCKABLE_TOOLS.has(tool) || !filePath) {
    return undefined;
  }

  const suppressionKey = `stuck_${tool}_${sha1Short(filePath)}`;

  // Single critical section: bump the counter, set the tag, and gate the
  // suppression key atomically. Capture decisions in outer scope.
  let triggered = false;
  let count = 0;
  let shouldEmit = false;

  await withState(sid, cwd, (s) => {
    s.stuck = s.stuck ?? { tool: null, file: null, count: 0 };

    // Same (tool, file) as the prior failure → increment.
    if (s.stuck.tool === tool && s.stuck.file === filePath) {
      s.stuck.count = (s.stuck.count ?? 0) + 1;
    } else {
      // Different (tool, file) — reset the counter AND drop any prior
      // suppression key for this tool+file so the next burst can fire again.
      s.stuck.tool = tool;
      s.stuck.file = filePath;
      s.stuck.count = 1;
      const fired = s.systemmessage_fired ?? {};
      if (fired[suppressionKey]) {
        const next = { ...fired };
        delete next[suppressionKey];
        s.systemmessage_fired = next;
      }
    }

    count = s.stuck.count;

    if (count >= STUCK_THRESHOLD) {
      triggered = true;
      s.last_event = { tag: `stuck:${tool}×${count}`, ts: ctx.nowIso(), detail: `stuck: ${tool}×${count}` };

      // Suppress repeat nudges within the same burst — fire once. This gates
      // BOTH the additionalContext block and the user message together (a
      // suppressed fire returns undefined below), so the dedup stays here rather
      // than being delegated to the helper (which only gates the message).
      const fired = s.systemmessage_fired ?? {};
      if (!fired[suppressionKey]) {
        shouldEmit = true;
        s.systemmessage_fired = { ...fired, [suppressionKey]: true };
      }
    }
  });

  if (!triggered || !shouldEmit) return undefined;

  // additionalContext (the authoritative stuck-guidance block) is built first;
  // the user-facing nudge is merged via the helper AFTER the lock releases
  // (anchor 1 + the no-nested-lock contract). No suppression key here — the
  // once-per-burst dedup above already gated both outputs together.
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: composeStuckBlock({ tool, file: filePath, count }),
    },
  };
  return mergeSystemMessage(
    result,
    `${tool} on ${filePath} has failed ${count} times consecutively. `
      + 'Consider re-reading the file or changing approach.',
    { category: 'error', level: 'transition', sid, cwd },
  );
}
