// lib/promotion/mergeCandidates.mjs — merge-candidate generator for /sextant:review.
//
// Surfaces pairs of cerebrum rules that MIGHT be redundant, for the
// sextant-reviewer subagent to judge. This is a RECALL-oriented candidate
// generator, NOT a redundancy verdict:
//
//   BM25 alone cannot separate "redundant" from "complementary" at cerebrum
//   corpus sizes (lean-interventions T6, measured: complementary same-file rules
//   score as high as genuinely-related ones). So we never gate on a precise
//   threshold and never auto-merge. We hand the top few highest-scoring pairs to
//   the reviewer, which reads both bodies and makes the redundant-vs-complementary
//   call BM25 can't — the LLM is the filter, BM25 is only the funnel.
//
// To avoid flooding the reviewer we cap the output (MERGE_TOP_N) and drop pure
// noise below a LOW floor (MERGE_MIN_SCORE — incidental single-term overlap),
// not a redundancy boundary.

import { buildSingleLineIndex } from '../capture/structural-gate.mjs';
import { lineHash } from '../stores/cerebrum.mjs';

export const MERGE_TOP_N = 6;
// Low noise floor, NOT a redundancy threshold. Drops pairs whose only link is an
// incidental shared token; the reviewer decides everything above it.
export const MERGE_MIN_SCORE = 1.0;

// findMergeCandidates(ruleEntries, opts): given parsed cerebrum entries, return
// up to `topN` highest-scoring DISTINCT rule pairs above `minScore`, each as
// { score, rules: [{ line_hash, body }, { line_hash, body }] }. Pure; no I/O.
// Pairs are symmetric-deduped and each rule contributes at most its single
// strongest partner, so the funnel stays small. line_hash is the value
// /sextant:forget consumes, so a confirmed merge is directly actionable.
export function findMergeCandidates(ruleEntries, opts = {}) {
  const topN = Number.isFinite(opts.topN) ? opts.topN : MERGE_TOP_N;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : MERGE_MIN_SCORE;

  const live = (Array.isArray(ruleEntries) ? ruleEntries : []).filter(
    (e) => e && e.kind === 'rule' && typeof e.body === 'string' && e.body.length > 0,
  );
  if (live.length < 2) return [];

  // id = lineHash(raw) so a candidate carries the hash /forget consumes.
  const entries = live.map((e) => ({ id: lineHash(e.raw), body: e.body }));
  const env = buildSingleLineIndex(entries);
  if (!env || !env.index) return [];
  const bodyById = new Map(entries.map((e) => [e.id, e.body]));

  const seen = new Set();
  const pairs = [];
  for (const e of entries) {
    // Mirror checkRedundancy's query sanitization (strip Lunr-meaningful chars).
    const safe = e.body.replace(/[+\-:~^*?"()[\]{}\\]/g, ' ').trim();
    if (safe.length === 0) continue;
    let hits = [];
    try { hits = env.index.search(safe); } catch { hits = []; }
    for (const h of hits) {
      if (!h || h.ref === e.id) continue;                 // skip self
      if (typeof h.score !== 'number' || h.score < minScore) break; // hits are sorted desc
      const key = [e.id, h.ref].sort().join('::');         // symmetric dedup
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        score: h.score,
        rules: [
          { line_hash: e.id, body: e.body },
          { line_hash: h.ref, body: bodyById.get(h.ref) ?? '' },
        ],
      });
      break; // one (strongest) partner per rule is enough for candidate-gen
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  return pairs.slice(0, topN);
}
