// lib/capture/structural-gate.mjs — Phase 7 structural gate (four checks).
//
// Per § 5.7 + § 8 Phase 7 of GROUND_UP_DESIGN.md: every line added to
// `.sextant/cerebrum/{regular,mandatory}.md` by an agent Edit/Write/MultiEdit
// runs through this gate before the write is allowed. PreToolUse returns
// `permissionDecision: "deny"` with itemized failure reasons if any check
// fires (v0.44.0: was `ask` — switched to an agent-facing `deny` fix-and-retry
// loop; SEXTANT_CEREBRUM_GATE=off disables it). The auto-tagger (PostToolUse,
// § 5.8) handles the no-prefix case after a clean write — this gate must NOT
// reject lines that are otherwise well-formed but lack a bucket prefix.
//
// Four checks:
//   1. schema      — rule-shaped lines satisfy the anchored regex from § 6.2.
//                    No-prefix lines pass; auto-tag handles them post-write.
//                    Non-list-item lines (prose / blanks) skip the check.
//   2. specificity — body length ≥ 20 chars (rejects "be careful").
//   3. redundancy  — Lunr score against the existing cerebrum corpus < 0.85.
//                    Skipped if no corpus is provided.
//   4. provenance  — mandatory ([!]) rules must carry `(by: <session-id>)`.
//                    (cerebrum-v2 T4: the `[match: <regex>]` field was deleted
//                    — charter anchor #8 — so there is no author-supplied regex
//                    to compile or ReDoS-probe; the write-protection capability
//                    moved to the runtime [!] write-gate in preToolUse, which
//                    word-boundary-matches a rule's [kw:] terms against the
//                    changed hunk. No author regex ⇒ no ReDoS surface, so the
//                    worker-thread probe apparatus was removed with it.)
//
// The gate is line-oriented: each newly-added line is checked independently
// and its failures collected with `{line, check, reason}` tuples. Callers
// (lib/hooks/preToolUse.mjs) feed `runAllChecks(newLines, opts)` and format
// `result.failures` as the `permissionDecisionReason` body when `result.ok`
// is false.

import lunr from 'lunr';

import { parseCerebrum } from '../stores/cerebrum.mjs';

// Anchor regex from § 6.2. Group 1: bucket prefix (may be empty).
// cerebrum-v2 (T5): recognize the v2 scope/importance tokens ([global], [kw:…],
// [provisional]) alongside the legacy ones (mirrors auto-tag.mjs's anchor), so
// the captured prefix accurately reflects a v2 rule. NOTE: the prefix group is
// optional (`*`) and the regex is end-unanchored, so checkSchema already PASSED
// v2 rules via a zero-token match — this alignment fixes the capture's fidelity,
// it is not an accept/reject behavior change.
const RULE_ANCHOR =
  /^\s*-\s+\d{4}-\d{2}-\d{2}:\s*((?:\[![^\]]*\]\s*|\[ai-provisional\]\s*|\[node:[^\]]+\]\s*|\[global\]\s*|\[provisional\]\s*|\[kw:[^\]]*\]\s*)*)/;

// Detects "list item with date-like text but doesn't satisfy the strict anchor"
// — i.e., it looks like the agent tried to write a rule but the schema is off.
// We use this only when RULE_ANCHOR fails so we can distinguish "malformed
// rule" (reject) from "prose line" (skip).
const LIST_WITH_DATE_HINT = /^\s*-\s+\d{4}-\d{1,2}-\d{1,2}\b/;

// A plain list item (e.g., '- some prose'). No date. Auto-tagger will add
// one + a bucket on the PostToolUse pass.
const PLAIN_LIST_ITEM = /^\s*-\s+\S/;

// Minimum body length, per § 5.7 specificity check.
const MIN_BODY_CHARS = 20;

// Redundancy threshold, per § 5.7.
const REDUNDANCY_THRESHOLD = 0.85;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Parse a single line via the cerebrum parser. Returns the rule entry
// (kind === 'rule') or null if the line isn't rule-shaped.
function parseSingleLine(line) {
  const parsed = parseCerebrum(line);
  if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
  const entry = parsed.lines[0];
  if (!entry || entry.kind !== 'rule') return null;
  return entry;
}

// Build a failure record.
function fail(line, check, reason) {
  return { line, check, reason };
}

// Build a single-line Lunr index from already-existing rule bodies. Caller
// supplies an array of { id, body } docs (one per existing rule). We never
// re-tokenize the proposed line ourselves — Lunr does it on the search side.
//
// Returns null if `entries` is empty; callers treat null as "no corpus, skip
// redundancy check".
export function buildSingleLineIndex(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const docs = new Map();
  const index = lunr(function () {
    this.ref('id');
    this.field('body');
    for (const e of entries) {
      if (!e || typeof e.body !== 'string' || e.body.length === 0) continue;
      const id = typeof e.id === 'string' && e.id.length > 0
        ? e.id
        : `doc-${docs.size}`;
      const doc = { id, body: e.body };
      docs.set(id, doc);
      this.add(doc);
    }
  });
  return { index, docs };
}

// -----------------------------------------------------------------------------
// Individual checks
// -----------------------------------------------------------------------------

// checkSchema(line): rule-shaped lines must satisfy the strict anchor. Non-
// rule lines (prose, blanks) pass without complaint. Lines that look like
// rules but aren't well-formed (e.g., missing colon) fail with a reason.
//
// Returns { ok, reason? }.
export function checkSchema(line) {
  if (typeof line !== 'string') return { ok: true };
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: true };
  if (trimmed.startsWith('#')) return { ok: true }; // header
  if (/^<!--[\s\S]*-->\s*$/.test(trimmed)) return { ok: true }; // pure comment

  if (RULE_ANCHOR.test(line)) return { ok: true };

  // Looks like a list item with a date-ish prefix but failed the anchor:
  // diagnose the most likely cause for a useful failure reason.
  if (LIST_WITH_DATE_HINT.test(line)) {
    if (!/\d{4}-\d{2}-\d{2}/.test(line)) {
      return { ok: false, reason: 'schema: date prefix must be YYYY-MM-DD (zero-padded)' };
    }
    if (!/\d{4}-\d{2}-\d{2}:/.test(line)) {
      return { ok: false, reason: 'schema: date prefix missing trailing colon (`YYYY-MM-DD:`)' };
    }
    return { ok: false, reason: 'schema: rule line did not match the anchor regex' };
  }

  // Plain list item with no date — auto-tagger will date + tag it post-write.
  // Pass. Non-list-item prose lines also pass: not rules.
  if (PLAIN_LIST_ITEM.test(line)) return { ok: true };

  return { ok: true };
}

// checkSpecificity(line, parsed): body length ≥ 20 chars. Non-rule lines
// (parsed === null) pass — they aren't rules.
export function checkSpecificity(line, parsed) {
  if (!parsed) return { ok: true };
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  if (body.length < MIN_BODY_CHARS) {
    return {
      ok: false,
      reason: `specificity: rule body ${body.length} chars < ${MIN_BODY_CHARS}`,
    };
  }
  return { ok: true };
}

// checkRedundancy(line, parsed, indexEnvelope): looks for near-duplicate
// rules against the existing corpus. We use TWO signals:
//   1. Exact-body match (case-insensitive, whitespace-collapsed). Reliable
//      and cheap; doesn't depend on corpus size.
//   2. Lunr BM25 score > REDUNDANCY_THRESHOLD. Catches paraphrases /
//      rewordings. BM25 raw scores are unbounded and corpus-size-dependent
//      (a single-doc corpus exact match scores ~0.7 in Lunr's default
//      weighting; a 200-doc corpus exact match scores ~14), so the
//      threshold is a heuristic and should be read as "high enough that
//      a duplicate would trip it on any non-trivial corpus". For tiny
//      corpora (≤ 5 docs) the BM25 threshold may be too high to catch
//      exact dups — that's what (1) is for.
//
// `indexEnvelope` is { index, docs } from buildSingleLineIndex (or
// lib/retrieval/lunr-index.mjs's buildCerebrumIndex — either shape works
// since we only call `.search()` and consult `.docs`).
//
// If `indexEnvelope` is null/undefined, skip the check (no corpus).
export function checkRedundancy(line, parsed, indexEnvelope) {
  if (!parsed) return { ok: true };
  if (!indexEnvelope || !indexEnvelope.index) return { ok: true };
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  if (body.length === 0) return { ok: true };

  // Signal 1: exact body match (case-insensitive + whitespace-collapsed).
  // We walk the docs map directly — O(N) for small N (this gate only runs
  // on new cerebrum writes; the corpus is bounded by cerebrum size, which
  // tops out in the low thousands per § 6.2).
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const normBody = norm(body);
  if (indexEnvelope.docs && typeof indexEnvelope.docs.forEach === 'function') {
    let exactDup = null;
    indexEnvelope.docs.forEach((doc) => {
      if (exactDup) return;
      if (!doc || typeof doc.body !== 'string') return;
      if (norm(doc.body) === normBody) exactDup = doc;
    });
    if (exactDup) {
      const preview = exactDup.body.length > 80
        ? exactDup.body.slice(0, 77) + '...'
        : exactDup.body;
      return {
        ok: false,
        reason: `redundancy: exact body match against existing rule — "${preview}"`,
      };
    }
  }

  // Signal 2: Lunr BM25 score.
  let hits;
  try {
    // Strip Lunr-meaningful chars to avoid query-syntax errors on identifier-
    // heavy bodies (`auth:token`, `+flag`, etc.). The full text body is the
    // input; Lunr handles tokenization on the field side.
    const safe = body.replace(/[+\-:~^*?"()[\]{}\\]/g, ' ').trim();
    if (safe.length === 0) return { ok: true };
    hits = indexEnvelope.index.search(safe);
  } catch {
    return { ok: true }; // malformed query — skip
  }

  if (!Array.isArray(hits) || hits.length === 0) return { ok: true };
  const top = hits[0];
  if (!top || typeof top.score !== 'number') return { ok: true };
  if (top.score > REDUNDANCY_THRESHOLD) {
    const matchedDoc = indexEnvelope.docs ? indexEnvelope.docs.get(top.ref) : null;
    const matchedBody = matchedDoc && typeof matchedDoc.body === 'string'
      ? matchedDoc.body
      : null;
    // Trim the matched body for the reason message so we don't dump 200 chars.
    const matchedSummary = matchedBody && matchedBody.length > 80
      ? matchedBody.slice(0, 77) + '...'
      : matchedBody;
    const reason = matchedSummary
      ? `redundancy: matches existing rule (score=${top.score.toFixed(2)}) — "${matchedSummary}"`
      : `redundancy: matches existing rule (score=${top.score.toFixed(2)})`;
    return { ok: false, reason };
  }
  return { ok: true };
}

// checkProvenance(line, parsed): mandatory rules ([!] bucket) must carry
// `(by: <session-id>)`.
//
// Non-mandatory rules pass without checks. Non-rule lines pass too.
//
// (cerebrum-v2 T4: the `[match: <regex>]` field was deleted — charter anchor
// #8 — so there is no author-supplied regex to compile or ReDoS-probe here.
// The write-protection capability moved to the runtime [!] write-gate in
// preToolUse, which word-boundary-matches a rule's [kw:] terms against the
// changed hunk — no author regex, no ReDoS surface.)
//
// Returns { ok, reason? } where reason is the SINGLE most specific failure.
export function checkProvenance(line, parsed) {
  if (!parsed) return { ok: true };
  const buckets = Array.isArray(parsed.buckets) ? parsed.buckets : [];
  const isMandatory = buckets.includes('!');
  if (!isMandatory) return { ok: true };

  // The cerebrum parser strips `(by: <sid>)` from `body` and surfaces it as
  // `parsed.bySession`. So presence of the suffix is `parsed.bySession !== null`.
  if (!parsed.bySession || parsed.bySession.length === 0) {
    return { ok: false, reason: 'provenance: mandatory rule requires `(by: <session-id>)` suffix' };
  }

  return { ok: true };
}

// -----------------------------------------------------------------------------
// Aggregator
// -----------------------------------------------------------------------------

// runAllChecks(newLines, opts):
//   newLines — array of raw line strings (the diff between proposed write and
//              existing content).
//   opts.existingLunrIndex — { index, docs } envelope from a Lunr build over
//              the existing cerebrum. Pass null to skip redundancy.
//   opts.today — 'YYYY-MM-DD'. Currently unused but reserved for date-window
//              checks (e.g., reject rules dated in the future). The signature
//              accepts it so callers don't need to update later.
//
// Returns { ok: boolean, failures: [{line, check, reason}, ...] }.
export function runAllChecks(newLines, opts = {}) {
  const failures = [];
  if (!Array.isArray(newLines) || newLines.length === 0) {
    return { ok: true, failures };
  }
  const indexEnvelope = opts.existingLunrIndex ?? null;

  for (const line of newLines) {
    // Skip purely blank lines fast — they aren't checked individually.
    if (typeof line !== 'string') continue;
    if (line.trim().length === 0) continue;

    // Schema first: a malformed schema makes the parse output unreliable.
    const schemaCheck = checkSchema(line);
    if (!schemaCheck.ok) {
      failures.push(fail(line, 'schema', schemaCheck.reason));
      // We DO continue to the other checks if possible — the agent benefits
      // from seeing multiple problems at once. Parse may still work for
      // dated-but-malformed lines; if parseSingleLine returns null below we'll
      // simply skip the dependent checks.
    }

    const parsed = parseSingleLine(line);

    // Specificity + provenance + redundancy depend on parsed.
    // Non-rule lines (parsed === null) trivially pass these.
    const specCheck = checkSpecificity(line, parsed);
    if (!specCheck.ok) failures.push(fail(line, 'specificity', specCheck.reason));

    const redCheck = checkRedundancy(line, parsed, indexEnvelope);
    if (!redCheck.ok) failures.push(fail(line, 'redundancy', redCheck.reason));

    const provCheck = checkProvenance(line, parsed);
    if (!provCheck.ok) failures.push(fail(line, 'provenance', provCheck.reason));
  }

  return { ok: failures.length === 0, failures };
}

// -----------------------------------------------------------------------------
// Test hooks
// -----------------------------------------------------------------------------

// Expose internal constants for tests to assert on so they don't have to
// hard-code values that may change here.
export const _internals = {
  RULE_ANCHOR,
  MIN_BODY_CHARS,
  REDUNDANCY_THRESHOLD,
};
