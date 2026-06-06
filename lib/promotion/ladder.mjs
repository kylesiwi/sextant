// lib/promotion/ladder.mjs — promotion / demotion candidate selection for
// the /sextant:review loop (Phase 10, § 7.8).
//
// This module is a pure data layer: it reads stats.json + parsed cerebrum
// and returns candidate lists. It does NOT mutate either store — the user
// decides whether to act, then runs /sextant:promote / /sextant:forget.
//
// Thresholds:
//   PROMOTION_THRESHOLD       fires before a rule can be promoted. Tunable
//                             via SEXTANT_PROMOTION_THRESHOLD env var; the
//                             default (50) is arbitrary per § 10.10.
//   DEMOTION_OPPORTUNITY_RATIO ratio of fires/opportunities below which we
//                             treat a rule as "rarely-firing." Opportunities
//                             approximated as session_count * 10 (rough
//                             estimate of average reads per session).
//   DEMOTION_LAST_FIRED_DAYS   only demote rules that haven't fired in this
//                             many days.

import { lineHash } from '../stores/cerebrum.mjs';
import { detectContradictions } from './contradictions.mjs';

const DEFAULT_PROMOTION_THRESHOLD = 50;
export const DEMOTION_OPPORTUNITY_RATIO = 0.05;
export const DEMOTION_LAST_FIRED_DAYS = 30;

// Resolve the promotion threshold from env-or-default. Exported as a function
// so callers (tests, CLI) can pass a tweaked process.env without re-importing
// the module. Also exported as a constant for ergonomic reading; the env
// override only fires at first read.
function resolveThresholdFromEnv(envVal) {
  const raw = typeof envVal === 'string' ? envVal.trim() : '';
  if (raw.length === 0) return DEFAULT_PROMOTION_THRESHOLD;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROMOTION_THRESHOLD;
  return n;
}

export const PROMOTION_THRESHOLD = resolveThresholdFromEnv(process.env.SEXTANT_PROMOTION_THRESHOLD);

// Build an O(1) lookup from line_hash → parsed rule entry so the candidate
// scans don't re-hash every rule on every lookup.
function indexByHash(parsedCerebrum) {
  const map = new Map();
  if (!parsedCerebrum || !Array.isArray(parsedCerebrum.lines)) return map;
  for (const e of parsedCerebrum.lines) {
    if (e.kind !== 'rule') continue;
    map.set(lineHash(e.raw), e);
  }
  return map;
}

// Helper: short body for display (caller may trim further).
function bodyOf(rule) {
  if (rule && typeof rule.body === 'string') return rule.body;
  return rule && typeof rule.raw === 'string' ? rule.raw.trim() : '';
}

// Public: rules eligible for promotion to mandatory ([!]).
//
// Eligibility:
//   - fires >= PROMOTION_THRESHOLD (env-tunable)
//   - !contradicted
//   - the rule exists in the parsed cerebrum (not forgotten/archived)
//   - the rule is NOT already mandatory (already has [!])
//   - the rule IS a keyword rule (has a [kw:] bucket). cerebrum-v2 T6: [!] is
//     kw-only and `cerebrum promote` refuses non-kw rules — so recommending a
//     node:/global rule for promotion would dead-end at a refusal. node:/global
//     already fire by scope; they never need promoting.
//
// Returns: [{ line_hash, fires, body, current_buckets, last_fired }]
export function listPromotionCandidates(stats, parsedCerebrum, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0
    ? opts.threshold
    : PROMOTION_THRESHOLD;
  const byHash = indexByHash(parsedCerebrum);
  const out = [];
  const fires = (stats && stats.rule_fires) || {};
  for (const [hash, info] of Object.entries(fires)) {
    if (!info || typeof info !== 'object') continue;
    if (info.contradicted) continue;
    const count = Number.isFinite(info.fires) ? info.fires : 0;
    if (count < threshold) continue;
    const rule = byHash.get(hash);
    if (!rule) continue; // forgotten / archived
    if (Array.isArray(rule.buckets) && rule.buckets.includes('!')) continue; // already mandatory
    // Only keyword rules are promotable (promote adds [!], the kw-only floor + gate).
    if (!Array.isArray(rule.buckets) || !rule.buckets.some((b) => typeof b === 'string' && b.startsWith('kw:'))) continue;
    out.push({
      line_hash: hash,
      fires: count,
      body: bodyOf(rule),
      current_buckets: Array.isArray(rule.buckets) ? [...rule.buckets] : [],
      last_fired: typeof info.last_fired === 'string' ? info.last_fired : null,
    });
  }
  // Sort by fires desc so the reviewer sees the strongest candidates first.
  out.sort((a, b) => b.fires - a.fires);
  return out;
}

// Public: rules that have rarely fired AND haven't fired recently.
//
// Eligibility:
//   - opportunities = max(1, session_count * 10) (approximation)
//   - ratio = fires / opportunities; ratio < DEMOTION_OPPORTUNITY_RATIO
//   - last_fired older than DEMOTION_LAST_FIRED_DAYS (or never)
//   - the rule exists in the parsed cerebrum (not forgotten/archived)
//
// Why both conditions: a brand-new project with session_count=1 hasn't given
// rules a chance to fire yet, so the ratio alone is noisy. The "no fire in N
// days" gate filters out the freshness false positive — a rule that fired
// yesterday is "young" even at low ratio and we leave it alone.
//
// Returns: [{ line_hash, fires, ratio, body, last_fired }]
export function listDemoteCandidates(stats, parsedCerebrum, opts = {}) {
  const ratioThreshold = Number.isFinite(opts.ratioThreshold) && opts.ratioThreshold >= 0
    ? opts.ratioThreshold
    : DEMOTION_OPPORTUNITY_RATIO;
  const lastFiredDays = Number.isFinite(opts.lastFiredDays) && opts.lastFiredDays >= 0
    ? opts.lastFiredDays
    : DEMOTION_LAST_FIRED_DAYS;
  // nowMs override exists purely so tests can pin time deterministically.
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const byHash = indexByHash(parsedCerebrum);
  const sessionCount = Number.isFinite(stats && stats.session_count)
    ? Math.max(0, stats.session_count)
    : 0;
  const opportunities = Math.max(1, sessionCount * 10);
  const cutoffMs = nowMs - lastFiredDays * 86400 * 1000;

  const out = [];
  const fires = (stats && stats.rule_fires) || {};
  for (const [hash, info] of Object.entries(fires)) {
    if (!info || typeof info !== 'object') continue;
    const count = Number.isFinite(info.fires) ? info.fires : 0;
    const ratio = count / opportunities;
    if (ratio >= ratioThreshold) continue;
    // Last-fired gate. If last_fired is null we treat it as "never fired"
    // which trivially satisfies "older than N days."
    const lastIso = typeof info.last_fired === 'string' ? info.last_fired : null;
    if (lastIso) {
      const lastMs = Date.parse(lastIso);
      if (Number.isFinite(lastMs) && lastMs > cutoffMs) continue;
    }
    const rule = byHash.get(hash);
    if (!rule) continue; // forgotten / archived
    out.push({
      line_hash: hash,
      fires: count,
      ratio: Number(ratio.toFixed(4)),
      body: bodyOf(rule),
      last_fired: lastIso,
    });
  }
  // Sort by ratio asc (worst offenders first), then by last_fired asc.
  out.sort((a, b) => {
    if (a.ratio !== b.ratio) return a.ratio - b.ratio;
    const at = a.last_fired ? Date.parse(a.last_fired) : 0;
    const bt = b.last_fired ? Date.parse(b.last_fired) : 0;
    return at - bt;
  });
  return out;
}

// Public: convenience aggregator that bin/review.mjs uses to assemble its
// JSON payload. Returns { promotion, demote, contradictions }.
//
// We don't mutate stats here — the reviewer is read-only; PostToolUse runs
// markContradicted on every cerebrum write to keep stats.contradicted fresh.
export function summarizeReviewQueue(parsedCerebrum, stats, opts = {}) {
  return {
    promotion: listPromotionCandidates(stats, parsedCerebrum, opts),
    demote: listDemoteCandidates(stats, parsedCerebrum, opts),
    contradictions: detectContradictions(parsedCerebrum),
  };
}
