// lib/retrieval/keywordRules.mjs — the cerebrum-v2 keyword-rule resolver (T3 / 3b).
//
// One entry point, `resolveKeywordMatches`, replaces the three in-hook copies of
// `listKeywordMatches(parsed, corpus)` (preToolUse Read, preToolUse Bash/Edit,
// userPromptSubmit). It returns the legacy `[{ rule, trigger }]` shape so the
// downstream `dedupKeywordMatches` / formatting / fire-counting machinery is
// untouched. Only the *production* of matches changes.
//
// Resolution (the one store, cerebrum.md — v1 retired in T3.5): TWO passes —
//       pass 1  exact word-boundary recall floor (no BM25 / IDF dependence)
//       pass 2  BM25 over the high-boost `keywords` field at READ/WRITE minScore
//     Bash is word-boundary ONLY (no BM25 on the hottest path — spec). Provisional
//     rules surface ONLY via BM25 above the high PROVISIONAL floor, never via the
//     word-boundary passes.
//
// IMPORTANT: this module must NOT statically import lib/retrieval/lunr-index.mjs.
// That module pulls in the `lunr` library (~heavy). The Bash branch needs no BM25,
// so lunr is dynamically imported inside the pass-2 block only — keeping the Bash
// hot path free of the lunr load cost (preserves the landed lazy-import win).

import {
  readResolvedCerebrum,
  parseKeywordBucket,
  keywordPresent,
  lineHash,
} from '../stores/cerebrum.mjs';

// Top-K for the keywords-field BM25 query. Generous: kw rules are few and the
// per-rule floor (and the field-scoped query) does the real gating; we just don't
// want to silently truncate a store with many matching kw rules.
const KW_QUERY_K = 25;

// passesKeywordFloor(score, isProvisional, baseMin, provisionalMin): PURE. A hit
// clears its floor — the HIGH provisional floor for [provisional] rules, else the
// READ/WRITE base. Extracted so the threshold policy is unit-testable without an
// index. (anchor #6: provisional surfaces only on strong matches.)
export function passesKeywordFloor(score, isProvisional, baseMin, provisionalMin) {
  if (typeof score !== 'number') return false;
  return score >= (isProvisional ? provisionalMin : baseMin);
}

// All bare keyword terms across a rule's kw buckets (strips the deleted v1 scoring
// markers via parseKeywordBucket). Used by the word-boundary passes here and by
// the [!] write-gate (preToolUse) — exported in cerebrum-v2 T4.
export function kwTermsOf(buckets) {
  const terms = [];
  for (const b of (Array.isArray(buckets) ? buckets : [])) {
    if (typeof b !== 'string' || !b.startsWith('kw:')) continue;
    const { critical, general } = parseKeywordBucket(b.slice(3));
    terms.push(...critical, ...general);
  }
  return terms;
}

// Build a field-scoped Lunr query (`keywords:tok keywords:tok …`) from a corpus.
// We tokenize to bare word terms FIRST: a raw corpus is a file path / shell
// command / prompt whose colons & slashes are Lunr query syntax and would make
// index.search() throw → silently return []. Stemming is applied by Lunr's query
// parser, so `keywords:rollbacks` still matches a rule tagged `rollback`.
function keywordFieldQuery(corpus) {
  if (typeof corpus !== 'string') return '';
  const toks = corpus.toLowerCase().match(/[a-z0-9_]+/g) || [];
  const seen = new Set();
  const clauses = [];
  for (const t of toks) {
    if (t.length < 2) continue;        // single chars are tokenizer noise
    if (seen.has(t)) continue;
    seen.add(t);
    clauses.push(`keywords:${t}`);
    if (clauses.length >= 40) break;   // cap query size on huge write corpora
  }
  return clauses.join(' ');
}

// resolveKeywordMatches({ cerebrumDir, durableBase, corpus, mode, env, resolved })
//   cerebrumDir — absolute <root>/.sextant/cerebrum
//   durableBase — absolute durable base (for loadCerebrumIndex)
//   corpus      — the per-tool query text (buildKeywordCorpus output)
//   mode        — 'READ' | 'WRITE' | 'BASH'  (UserPromptSubmit uses 'READ')
//   env         — optional env override (kill-switch); defaults to process.env
//   resolved    — optional pre-resolved { parsed, source } to avoid a second
//                 readResolvedCerebrum (the Read path already resolved one)
// Returns [{ rule, trigger }] — `trigger` is 'critical' (always emit) for [!] /
// word-boundary safety fires, 'general' (windowed-dedup) for BM25 ranked fires.
export async function resolveKeywordMatches({ cerebrumDir, durableBase, corpus, mode = 'READ', resolved } = {}) {
  if (typeof corpus !== 'string' || corpus.length === 0) return [];

  const r = resolved ?? await readResolvedCerebrum(cerebrumDir);
  const parsed = r && r.parsed;

  // --- v2 (the only store; v1 retired in T3.5) -------------------------------
  const lines = (parsed && Array.isArray(parsed.lines)) ? parsed.lines : [];
  const kwEntries = [];
  const byId = new Map();
  for (const e of lines) {
    if (!e || e.kind !== 'rule' || !Array.isArray(e.buckets)) continue;
    if (!e.buckets.some((b) => typeof b === 'string' && b.startsWith('kw:'))) continue;
    kwEntries.push(e);
    // ruleId in lunr-index is sha1(raw)[:16] === lineHash(raw); normalization
    // mutates buckets, not raw, so the id is stable across the resolver.
    if (typeof e.raw === 'string') byId.set(lineHash(e.raw), e);
  }

  // readResolvedCerebrum normalized the buckets: [provisional]→'!review',
  // [global]→'!global'+'!', '!'/'kw:'/'node:' pass through.
  const isProvisional = (e) => e.buckets.includes('!review');
  const isBang = (e) => e.buckets.includes('!');

  const matches = [];
  const seen = new Set();
  const add = (e, trigger) => {
    if (!e || typeof e.raw !== 'string' || seen.has(e.raw)) return;
    seen.add(e.raw);
    matches.push({ rule: e, trigger });
  };

  const lower = corpus.toLowerCase();

  // Pass 1 — exact word-boundary recall floor (no BM25 / IDF dependence; covers
  // cold-start 0/1-rule stores). BM25 modes apply it ONLY to [!] kw rules; Bash
  // applies it to ALL kw rules (Bash has no BM25 pass). Provisional rules never
  // fire here — they are BM25-above-PROVISIONAL only.
  for (const e of kwEntries) {
    if (isProvisional(e)) continue;
    if (mode !== 'BASH' && !isBang(e)) continue;
    const terms = kwTermsOf(e.buckets);
    if (terms.some((t) => keywordPresent(t, lower))) {
      add(e, isBang(e) ? 'critical' : 'general');
    }
  }

  // Pass 2 — BM25 over the `keywords` field. Skipped on Bash. lunr is imported
  // here (lazily) so the Bash path never loads it.
  if (mode !== 'BASH') {
    const query = keywordFieldQuery(corpus);
    if (query.length > 0) {
      const { loadCerebrumIndex, search, KW_MINSCORE } = await import('./lunr-index.mjs');
      const base = mode === 'WRITE' ? KW_MINSCORE.WRITE : KW_MINSCORE.READ;
      const { index, docs } = await loadCerebrumIndex(durableBase, { sourceFile: 'cerebrum.md' });
      const hits = search(index, docs, query, KW_QUERY_K, base);
      for (const h of hits) {
        const e = byId.get(h.id);
        if (!e) continue;  // field-scoped query already excludes non-kw docs
        if (!passesKeywordFloor(h.score, isProvisional(e), base, KW_MINSCORE.PROVISIONAL)) continue;
        // pass-1 [!] criticals are already in `seen` and never downgraded here.
        add(e, 'general');
      }
    }
  }

  return matches;
}
