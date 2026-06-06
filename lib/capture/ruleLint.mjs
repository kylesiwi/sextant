// lib/capture/ruleLint.mjs — the shared deterministic rule-format linter
// (cerebrum-v2 T5.5). One source of truth for "what's a malformed rule",
// consumed by THREE callers:
//   - `cerebrum doctor`  (bin/cerebrum.mjs) — reports errors + warns
//   - `cerebrum remember` (bin/cerebrum.mjs) — rejects on errors at author time
//   - the Stop-hook format gate (lib/hooks/stop.mjs) — blocks on errors for
//     rules added during the session
//
// Severity contract:
//   errors  — high-confidence format mistakes the author should fix NOW. These
//             BLOCK at the Stop gate and REJECT at remember-time. Conservative
//             by design (a false positive costs the agent one fix; the Stop gate
//             additionally fails open after 3 tries so it can never trap).
//   warns   — advisory / possibly-legitimate. Doctor-only; never block.
//
// IMPORTANT: the body-bracket detector runs on the PARSED `entry.body`, NOT a
// raw line position. The parser strips recognized buckets into `entry.buckets`,
// and the auto-tagger may prepend `[provisional]`/`[node:…]` at PostToolUse — so
// any bracket token still at the HEAD of `body` is the junk we want, regardless
// of how many real buckets precede it on the line.

import fs from 'node:fs';
import path from 'node:path';

import { parseKeywordBucket } from '../stores/cerebrum.mjs';

// A bucket-shaped token at the very start of the body (after optional space).
const BODY_LEADING_BRACKET = /^\s*(\[[^\]]+\])/;

// lintCerebrumRule(entry, { root }) → { errors: string[], warns: string[] }
// `entry` is a parsed rule entry (kind === 'rule'); non-rule entries lint clean.
// `root` (optional) enables the root-relative [node:] existence WARN.
export function lintCerebrumRule(entry, { root } = {}) {
  const errors = [];
  const warns = [];
  if (!entry || entry.kind !== 'rule') return { errors, warns };

  const buckets = Array.isArray(entry.buckets) ? entry.buckets : [];
  const body = typeof entry.body === 'string' ? entry.body : '';

  // ERROR: a bucket-shaped tag left in the body — the "tags in body" mistake
  // (e.g. `[build][wsl] …`, `[todo] …`, `[mandatory] …`). Recognized buckets
  // are already in `entry.buckets`; a leading `[token]` here is a scope/marker
  // the author meant as metadata but mis-placed.
  const lead = body.match(BODY_LEADING_BRACKET);
  if (lead) {
    errors.push(`bucket-shaped tag "${lead[1]}" left in the rule body — put scope/importance in the prefix ([node:…]/[global]/[kw:…]/[!]) or remove the brackets`);
  }

  for (const b of buckets) {
    if (typeof b !== 'string') continue;
    if (b.startsWith('node:')) {
      const np = b.slice('node:'.length).trim();
      if (np.length === 0) {
        errors.push('empty [node:] path');
      } else if (root && !fs.existsSync(path.resolve(root, np))) {
        // Root-relative; could be a not-yet-created file → advisory, not blocking.
        warns.push(`[node:${np}] path does not exist under root (stale scope?)`);
      }
    } else if (b.startsWith('kw:')) {
      const { critical, general } = parseKeywordBucket(b.slice(3));
      if (critical.length === 0 && general.length === 0) {
        errors.push('[kw:] bucket has no keyword terms');
      }
    }
  }

  // ERROR: [!] importance with no scope token. cerebrum-v2 T5.6: [!] is now a
  // KW-ONLY modifier (BM25 recall floor + the write-gate). A scope-less [!]
  // still fires in NO channel — but the fix is to give it keywords.
  const hasScope = buckets.some((b) => typeof b === 'string'
    && (b.startsWith('node:') || b.startsWith('kw:') || b === '!global' || b === 'global'));
  const hasKw = buckets.some((b) => typeof b === 'string' && b.startsWith('kw:'));
  if (buckets.includes('!') && !hasScope) {
    errors.push('[!] with no scope — [!] marks a keyword safety rule; add [kw:…] (--keywords). A bare [!] fires nowhere');
  }

  // WARN: [!] on a node:/global rule. cerebrum-v2 T5.6: node:/global fire by
  // SCOPE ALONE (deterministic tier); [!] only changes behavior on kw: rules,
  // so it's redundant here. Advisory — the rule still fires correctly.
  const hasNodeOrGlobal = buckets.some((b) => typeof b === 'string'
    && (b.startsWith('node:') || b === '!global' || b === 'global'));
  if (buckets.includes('!') && hasNodeOrGlobal && !hasKw) {
    warns.push('[!] is redundant on a node:/global rule — node:/global fire by scope alone; [!] only affects kw: rules');
  }

  // WARN: an untagged rule (no scope bucket) matches only incidentally — its body
  // has to BM25-match a file's path/symbols on a Read. Add a scope for reliable
  // firing, or let the auto-tagger scope it from a recent edit.
  if (buckets.length === 0) {
    warns.push('no scope — this rule matches only incidentally (body text vs a file on Read); add [node:]/[kw:]/[global] for reliable firing');
  }

  return { errors, warns };
}
