// lib/capture/auto-tag.mjs — § 7.1 cerebrum auto-tag loop.
//
// Mechanism: after a write hits the cerebrum file, every rule-shaped line
// that lacks a bucket prefix gets one tacked on, plus a confidence-graded
// HTML marker comment. The heuristic is deliberately dumb:
//
//   - "Recent" project-file edit (lastProjectFileEdit.ts >= turn start):
//     attribute the rule to that file with `[node:<path>]` + a high-
//     confidence marker. Rationale (§ 5.8.3): if the user just touched
//     auth.ts and then wrote a cerebrum line, it's almost certainly about
//     auth.ts. Empirically this is the common case — the alternative
//     (analysis-only sessions, multi-file refactors) is the failure mode.
//
//   - Anything else (no recent edit, edit too old, null): tag `[provisional]`
//     + a low-confidence marker. The line still lands in cerebrum but
//     surfaces in /sextant:triage so a human can fix the scope. This is
//     the path that replaces the old "fall back to [!global]" mistake
//     (§ 5.8.3) — globally-scoped rules pollute every Read.
//
// I/O wrapper autoTagFile reads a file, applies autoTagLine to each row,
// and writes back atomically via the store module's writer.

import { readCerebrumFile, updateCerebrumFile, lineHash } from '../stores/cerebrum.mjs';

// Same anchor as parseCerebrum but capturing date+prefix separately. A line
// that hits this anchor with a non-empty prefix group is "already tagged".
// cerebrum-v2 (T3.5): recognize the v2 scope/importance tokens ([global], [kw:…],
// [provisional], [!]) alongside the legacy ones, so an already-v2-tagged rule is
// NOT re-tagged on a re-run.
const RULE_ANCHOR_FULL =
  /^(\s*-\s+)(\d{4}-\d{2}-\d{2}):\s*((?:\[![^\]]*\]\s*|\[ai-provisional\]\s*|\[node:[^\]]+\]\s*|\[global\]\s*|\[provisional\]\s*|\[kw:[^\]]*\]\s*)*)/;

// Detects an undated list-item line like "- some note" (no date prefix).
// We use this only after RULE_ANCHOR_FULL fails — i.e. we know it's not a
// dated rule. We deliberately accept lines with leading whitespace so nested
// list items still get tagged.
const UNDATED_LIST_ITEM = /^(\s*-\s+)(?!\d{4}-\d{2}-\d{2}:)(.*)$/;

// Classify non-rule lines the same way parseCerebrum does. autoTagLine
// passes these through unchanged (they're prose, headers, etc.).
function isNonRule(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return true; // blank
  if (/^#{1,6}\s/.test(trimmed)) return true; // header
  if (/^<!--[\s\S]*-->\s*$/.test(trimmed)) return true; // standalone comment
  // If the line doesn't begin a list item, it's prose. We don't auto-promote
  // arbitrary lines into rules.
  if (!/^\s*-\s+/.test(raw)) return true;
  return false;
}

// Public: tag a single line.
//
// Returns { taggedLine, confidence: 'high' | 'low' | 'none' }.
//   'none'  — line was non-rule or already tagged; taggedLine === raw.
//   'high'  — untagged rule + recent project edit; got [node:<path>] tag.
//   'low'   — untagged rule, no recent edit; got [provisional] tag.
//
// Inputs:
//   raw                  — the line, no trailing newline.
//   lastProjectFileEdit  — { path, ts } | null. ts is ISO string.
//   turnStartTs          — ISO string. Edits with ts >= turnStartTs count.
//   today                — 'YYYY-MM-DD'. Used when prepending a date to an
//                          undated list item (opinionated UX per spec).
export function autoTagLine({ raw, lastProjectFileEdit, turnStartTs, today }) {
  if (typeof raw !== 'string') return { taggedLine: raw, confidence: 'none' };

  // Non-rule shapes are inert.
  if (isNonRule(raw)) return { taggedLine: raw, confidence: 'none' };

  // Dated rule: check whether it already carries a bucket prefix.
  const datedMatch = raw.match(RULE_ANCHOR_FULL);
  if (datedMatch) {
    const prefix = datedMatch[3]; // bucket group (may be empty)
    if (prefix && prefix.trim().length > 0) {
      // Already tagged — leave it alone.
      return { taggedLine: raw, confidence: 'none' };
    }
    // Untagged dated rule. Insert tag right after "YYYY-MM-DD: ", append
    // the marker after the body. Trailing whitespace normalised to one space
    // before the marker so we don't accumulate spaces on repeat runs (the
    // already-tagged short-circuit above prevents repeat runs in practice,
    // but cheap to be defensive).
    const head = datedMatch[1] + datedMatch[2] + ': ';
    const tail = raw.slice(datedMatch[0].length).trimStart().replace(/\s+$/, '');
    const { bucket, marker, confidence } = pickTag(lastProjectFileEdit, turnStartTs);
    const taggedLine = tail.length > 0
      ? `${head}${bucket} ${tail} ${marker}`
      : `${head}${bucket} ${marker}`;
    return { taggedLine, confidence };
  }

  // Undated list item: synthesise a date prefix, then tag.
  const undated = raw.match(UNDATED_LIST_ITEM);
  if (undated) {
    const indentDash = undated[1]; // "- " incl. indentation
    const body = undated[2];       // body without leading dash
    const { bucket, marker, confidence } = pickTag(lastProjectFileEdit, turnStartTs);
    const normalisedBody = body.replace(/\s+$/, '');
    const taggedLine = `${indentDash}${today}: ${bucket} ${normalisedBody} ${marker}`;
    return { taggedLine, confidence };
  }

  // Defensive default: shouldn't reach here — isNonRule covers the gap.
  return { taggedLine: raw, confidence: 'none' };
}

// Decide which bucket + marker to attach.
function pickTag(lastProjectFileEdit, turnStartTs) {
  if (
    lastProjectFileEdit &&
    typeof lastProjectFileEdit.ts === 'string' &&
    typeof lastProjectFileEdit.path === 'string' &&
    lastProjectFileEdit.ts >= turnStartTs
  ) {
    return {
      bucket: `[node:${lastProjectFileEdit.path}]`,
      marker: '<!-- sextant:auto-tag confidence=high -->',
      confidence: 'high',
    };
  }
  return {
    // cerebrum-v2 (T3.5): low-confidence auto-tags land as [provisional] (the v2
    // review queue), indexed in Lunr and surfaced only above the high PROVISIONAL
    // floor — replacing the v1 [!review] dormant-until-approved queue.
    bucket: '[provisional]',
    marker: '<!-- sextant:auto-tag confidence=low needs-review -->',
    confidence: 'low',
  };
}

// Public: read a cerebrum file, apply autoTagLine to every line, write back.
// Returns counters so callers can update statusline auto_tag.* fields
// (§ 6.5).
//
//   high          — count of high-confidence tags applied.
//   low           — count of low-confidence tags applied.
//   unchanged     — count of lines passed through (already tagged or non-rule).
//   total_lines   — total line count after split (== before, since we only
//                   mutate in place).
//
// dryRun: if true, skip the write. Useful for tests and for /sextant:triage
// previews.
export async function autoTagFile({ filePath, lastProjectFileEdit, turnStartTs, today, dryRun = false }) {
  // Mutate every rule line in place; return the per-confidence counters. Shared
  // by the dryRun (read-only) and write paths so the tagging logic lives once.
  const apply = (parsed) => {
    let high = 0, low = 0, unchanged = 0;
    // Re-tagging rewrites a line, changing its content-derived hash. Report the
    // (oldHash → newHash) pairs so callers can carry the rule's fire history
    // across the rehash (lib/stores/stats.mjs migrateRuleFires).
    const rewrites = [];
    for (const entry of parsed.lines) {
      const before = entry.raw;
      const { taggedLine, confidence } = autoTagLine({
        raw: entry.raw,
        lastProjectFileEdit,
        turnStartTs,
        today,
      });
      entry.raw = taggedLine;
      if (taggedLine !== before && entry.kind === 'rule') {
        rewrites.push({ oldHash: lineHash(before), newHash: lineHash(taggedLine) });
      }
      if (confidence === 'high') high++;
      else if (confidence === 'low') low++;
      else unchanged++;
    }
    return { high, low, unchanged, total_lines: parsed.lines.length, rewrites };
  };

  if (dryRun) {
    return apply(await readCerebrumFile(filePath));
  }

  // Write path: locked read-modify-write through updateCerebrumFile so the
  // auto-tagger can't clobber a concurrent CLI remember / promote (and vice
  // versa). The integrity guard runs at serialize time inside the lock.
  let counters = { high: 0, low: 0, unchanged: 0, total_lines: 0, rewrites: [] };
  const written = await updateCerebrumFile(filePath, (parsed) => {
    counters = apply(parsed);
    return parsed;
  });
  // null = lock-acquisition timeout: nothing was written. autoTagLine is
  // idempotent (already-tagged lines pass through as 'unchanged'), so the next
  // PostToolUse pass re-applies. Report zeros (and no rewrites — nothing hit
  // disk, so no fire-history migration must run) so callers don't act on a
  // write that didn't happen.
  if (written === null) {
    return { high: 0, low: 0, unchanged: 0, total_lines: counters.total_lines, rewrites: [] };
  }
  return counters;
}
