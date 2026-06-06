// lib/ledger/tokens.mjs — cheap token-count heuristic for the A/B ledger.
//
// Phase 8 (§ 6.4 + § 8 Phase 8 of GROUND_UP_DESIGN.md):
//   The token ledger needs a fast, dependency-free way to estimate the
//   token cost of a string we're about to emit as additionalContext. We
//   don't need precision — the ledger is comparative ("control vs.
//   treatment"), not absolute. A GPT-style chars-per-token baseline is
//   adequate for that delta.
//
// Heuristic: Math.ceil(text.length / 4). The 4 chars/token figure is the
// commonly cited English-prose baseline. Code is typically slightly denser
// (~3.5 chars/token) so a future estimateForCodeFile() may differentiate;
// for v1 we use the same estimator everywhere and disclose the precision
// gap in § 10.10.
//
// Falsification claim: estimateTokens('hello') === 2 (5/4 = 1.25 → 2).
// Empty input returns 0. Long input grows linearly.
//
// We document the rounding semantics here so test assertions are precise:
//   - text === ''      → 0
//   - text === ' '     → 1     (Math.ceil(1/4) = 1)
//   - text === 'hello' → 2     (Math.ceil(5/4) = 2)
//   - 4-char chunks    → exact (Math.ceil(4n/4) = n)

export function estimateTokens(text) {
  if (typeof text !== 'string') return 0;
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

// estimateForCodeFile(text): future hook for a code-tuned ratio. v1 just
// proxies estimateTokens — see § 10.10 disclosure. Kept as a separate
// callable so future phases can switch a single call site without
// touching the ledger.
export function estimateForCodeFile(text) {
  return estimateTokens(text);
}
