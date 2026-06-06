// lib/promotion/contradictions.mjs — heuristic contradiction detection over
// the cerebrum (Phase 10, § 7.8).
//
// We compare every pair of rule lines for textual opposites in their bodies,
// gated by scope so unrelated rules don't collide:
//   - Two [node:<path>] rules are compared only when they name the SAME file.
//   - A [node:] rule is compared ONLY against other rules for that same file —
//     a file-local rule is its own scope, not weighed against project-wide
//     ([global]) or topic ([kw:]) rules.
//   - Every other pairing (global/global, global/kw, kw/kw, untagged) is compared.
//
// To dampen false positives on neutral language we also require the pair to
// share at least one content keyword (>4 chars, not in a small stop-list).
// Two rules saying "always prefer X" and "never prefer Y" would still flag iff
// X and Y overlap; "always run tests" vs "never log secrets" would not.
//
// The contradiction surface is heuristic by design (§ 10.10 disclosure):
// always/never, prefer/avoid, must/must-not, required/forbidden. Subtler
// semantic conflicts ("format with prettier" vs "use 4-space indent") will
// slip past — the reviewer subagent and the human in /sextant:review are the
// safety net.

import { lineHash } from '../stores/cerebrum.mjs';

// Each entry: [pattern_a, pattern_b] regexes (case-insensitive, word-bounded).
// We deliberately order more-specific patterns (e.g. "must not") before more
// general ones ("must") so the matcher doesn't pre-empt them on the same line.
export const CONTRADICTION_PAIRS = [
  [/\bmust not\b/i, /\bmust\b/i],
  [/\brequired\b/i, /\bforbidden\b/i],
  [/\balways\b/i,    /\bnever\b/i],
  [/\bprefer\b/i,    /\bavoid\b/i],
  [/\benable\b/i,    /\bdisable\b/i],
  [/\ballow\b/i,     /\bdeny\b/i],
];

// Tiny stop-list for the keyword-overlap check. We want to require that the
// two contradictory rules talk about the same THING, but generic verbs and
// modal words shouldn't count.
const KEYWORD_STOP = new Set([
  'always','never','prefer','avoid','must','required','forbidden','enable','disable',
  'allow','deny','should','shall','will','would','could','might','rule','rules',
  'thing','things','file','files','code','codes','this','that','these','those',
  'with','from','have','having','using','about',
]);

// Body keyword set: lowercased tokens > 4 chars, stop-words stripped.
function bodyKeywords(body) {
  if (typeof body !== 'string') return new Set();
  const out = new Set();
  for (const tok of body.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (tok.length <= 4) continue;
    if (KEYWORD_STOP.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

// Return true if any keyword appears in both sets. We require >=1 overlap.
function shareKeyword(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return false;
  // Iterate the smaller set for cheaper average case.
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const k of small) if (big.has(k)) return true;
  return false;
}

// The [node:<path>] paths a rule is scoped to (empty for global / kw / untagged
// rules). A rule is "node-scoped" iff it carries at least one [node:] bucket; a
// mixed [node:F][kw:x] rule counts as node-scoped (node is the narrower scope).
function nodePathsOf(rule) {
  const buckets = Array.isArray(rule.buckets) ? rule.buckets : [];
  const out = [];
  for (const b of buckets) {
    if (typeof b === 'string' && b.startsWith('node:')) out.push(b.slice(5));
  }
  return out;
}

// Decide whether two rules' scopes can collide (see the header comment).
function scopesOverlap(a, b) {
  const na = nodePathsOf(a);
  const nb = nodePathsOf(b);
  const aNode = na.length > 0;
  const bNode = nb.length > 0;
  // Two node-scoped rules collide only on the same file.
  if (aNode && bNode) {
    for (const pa of na) {
      for (const pb of nb) {
        if (pa === pb) return true;
      }
    }
    return false;
  }
  // Exactly one node-scoped: a file-local rule is not weighed against a
  // project-wide or topic rule.
  if (aNode !== bNode) return false;
  // Neither is node-scoped (global / kw / untagged): compare. The shared-keyword
  // + opposite-verb gates downstream filter unrelated pairs.
  return true;
}

// Test a body against one CONTRADICTION_PAIRS entry. Returns:
//   { side: 'a' | 'b' | null }
// indicating which side of the pair matched (a = first pattern, b = second).
// If the body matches both patterns on the same line, prefer 'a' so we don't
// confuse callers — we'll fail the cross-rule check downstream because the
// other rule must match the OPPOSITE side.
function matchSide(body, [pa, pb]) {
  if (typeof body !== 'string' || body.length === 0) return { side: null };
  if (pa.test(body)) return { side: 'a' };
  if (pb.test(body)) return { side: 'b' };
  return { side: null };
}

// Format a one-line reason for human + agent consumption.
function reasonFor(pair, sideA, sideB) {
  const [pa, pb] = pair;
  // The "left" rule matched 'sideA' of the pair, right matched 'sideB'.
  // We surface both patterns verbatim so the reviewer (human or subagent)
  // sees the keyword opposition.
  const labelOf = (side) => side === 'a'
    ? pa.toString().replace(/\\b/g, '').replace(/\/i?$/, '').replace(/^\//, '')
    : pb.toString().replace(/\\b/g, '').replace(/\/i?$/, '').replace(/^\//, '');
  const aLabel = labelOf(sideA);
  const bLabel = labelOf(sideB);
  return `keyword pair "${aLabel}" vs "${bLabel}" with overlapping scope`;
}

// Public: scan parsed cerebrum and return conflict pairs.
//
// Each item:
//   { line_a: {raw, body, line_hash}, line_b: {raw, body, line_hash}, reason }
//
// Cost: O(N^2) where N = number of rule entries. For the small N we expect
// in a real cerebrum (tens to low hundreds) this is fine; if a project ever
// pushed it into the thousands range a better-shaped pre-pass would be the
// fix. Not optimizing prematurely.
export function detectContradictions(parsedCerebrum) {
  if (!parsedCerebrum || !Array.isArray(parsedCerebrum.lines)) return [];
  const rules = parsedCerebrum.lines.filter((e) => e && e.kind === 'rule');
  if (rules.length < 2) return [];

  // Pre-compute body keyword sets so the O(N^2) loop is cheap.
  const keywords = rules.map((r) => bodyKeywords(r.body));

  const out = [];
  for (let i = 0; i < rules.length; i++) {
    const a = rules[i];
    for (let j = i + 1; j < rules.length; j++) {
      const b = rules[j];
      if (!scopesOverlap(a, b)) continue;
      if (!shareKeyword(keywords[i], keywords[j])) continue;
      for (const pair of CONTRADICTION_PAIRS) {
        const ma = matchSide(a.body, pair);
        const mb = matchSide(b.body, pair);
        if (ma.side === null || mb.side === null) continue;
        if (ma.side === mb.side) continue; // both said "always" — agreement
        out.push({
          line_a: {
            raw: a.raw,
            body: a.body,
            line_hash: lineHash(a.raw),
          },
          line_b: {
            raw: b.raw,
            body: b.body,
            line_hash: lineHash(b.raw),
          },
          reason: reasonFor(pair, ma.side, mb.side),
        });
        break; // one reason per pair is enough; move to next (i, j)
      }
    }
  }
  return out;
}

// Public: mutate stats.rule_fires so each side of a detected contradiction
// has contradicted=true. Idempotent. Returns the number of conflict pairs
// found (NOT the number of rules touched — a rule that contradicts two
// others still contributes only 1 to the count for each pair).
export function markContradicted(stats, parsedCerebrum) {
  const conflicts = detectContradictions(parsedCerebrum);
  if (!stats || typeof stats !== 'object') return conflicts.length;
  if (!stats.rule_fires || typeof stats.rule_fires !== 'object') {
    stats.rule_fires = {};
  }
  for (const c of conflicts) {
    for (const h of [c.line_a.line_hash, c.line_b.line_hash]) {
      if (!stats.rule_fires[h]) {
        // Create a zero entry so we can flag a contradiction on a rule
        // that hasn't fired yet. The promotion ladder reads contradicted
        // even when fires === 0.
        stats.rule_fires[h] = { fires: 0, contradicted: false, last_fired: null };
      }
      stats.rule_fires[h].contradicted = true;
    }
  }
  return conflicts.length;
}
