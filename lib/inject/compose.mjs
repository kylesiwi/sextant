// lib/inject/compose.mjs — pure composer for the PreToolUse Read additionalContext block.
//
// Sextant's headline feature: when the agent issues a Read on `<path>`, the
// PreToolUse hook injects an `additionalContext` string describing what the
// graph knows about that file. This module is the pure function that turns
// `{ node, graph }` into the marker-fenced string. No I/O. No hook context.
// Easy to test exhaustively.
//
// Priority order (§ 5.3 — load-bearing):
//   1. Mandatory rules matching [node:<path>]  (Phase 2; opts.includeMandatoryRules)
//   2. Bug count + most recent unfixed         (Phase 3; opts.includeBugSummary)
//   3. graph: <label>; community: #<n>         (Phase 1a)
//   4. Top-K outbound connections              (Phase 1a)
//   5. Top-K inbound used_by                   (Phase 1a)
//   6. symbols: <a>(), <b>()                   (Phase 1a)
//   7. why: <rationale>                        (Phase 4; not generated here)
//   8. Top-K Lunr-ranked rules                 (Phase 4; not generated here)
//   9. Repeated-read warning                   (Phase 1a OR later; opts.repeatedReadWarning)
//
// Truncation:
//   - The cap (default 10,000 CHARACTERS, not bytes — per verified docs) is
//     enforced section by section. After each section is rendered, we check
//     the running total. If adding the next section would push past
//     (capChars - safetyMargin), we stop and emit a truncation marker.
//   - Mandatory rules (pri 1) and bug count (pri 2) must NEVER be in the
//     dropped list. If the priority-1 block exceeds cap alone, we render only
//     the most recently authored mandatory rules that fit and emit a
//     specific truncation warning (§ 5.3 — Phase 2c).
//   - Mandatory rule bodies render in FULL by default; they are clamped only
//     under budget pressure (the priority-1 block alone overflows the cap), and
//     even then via an adaptive per-rule cap = max(MANDATORY_RULE_BODY_MAX,
//     budget / N) — so a handful of rules show whole, while a long tail is
//     trimmed (never below the MANDATORY_RULE_BODY_MAX floor) before any drop.
//
// Render format:
//
//   <!-- sextant:read-context -->
//   rules (<N>):
//     • [node:<path>] <body> (from <by> session)
//     • [!global] <body>
//   graph: <label>; community: <n or 'none'>
//   connections (top 3):
//     -> <to-label> [<edge-type>, <confidence>]
//   used_by (top 3):
//     <- <from-label> [<edge-type>, <confidence>]
//   symbols (up to 20): foo(), bar(), Baz, Qux
//   <!-- /sextant:read-context -->
//
// Notes:
//   - Section header lines are OMITTED entirely when the section is empty.
//   - Unresolved target ids (e.g., `unresolved:lodash`) render as the suffix:
//     `lodash`. Node ids of the form `node:<path>` render as `<path>`.
//   - Symbol render: identifiers; add `()` suffix for symbols whose name
//     starts with a lowercase letter (heuristic for function-named symbols).

import { GRAPH, NODE, EDGE } from '../graph/schema.mjs';
import { topConnections, topUsedBy } from '../graph/read.mjs';

const OPEN_MARKER = '<!-- sextant:read-context -->';
const CLOSE_MARKER = '<!-- /sextant:read-context -->';

// Section identifiers used in both the rendered output (headers) and the
// truncation marker's "dropped:" list. Keep this list aligned with the priority
// order above.
const SECTION = Object.freeze({
  MANDATORY_RULES: 'mandatory_rules',
  BUG_SUMMARY: 'bug_summary',
  IDENTITY: 'identity',
  CONNECTIONS: 'connections',
  USED_BY: 'used_by',
  SYMBOLS: 'symbols',
  WHY: 'why',
  LUNR_RULES: 'lunr_rules',
  REPEATED_READ: 'repeated_read',
});

// Per-Lunr-rule body cap. Mirrors MANDATORY_RULE_BODY_MAX but as documented
// in § 8 Phase 4: "Cap each body at 200 chars".
const LUNR_RULE_BODY_MAX = 200;

const DEFAULTS = Object.freeze({
  capChars: 10000,
  safetyMargin: 200,
  topK: 3,
  symbolsMax: 20,
});

// Per-rule body FLOOR for the adaptive clamp. Mandatory rule bodies render in
// FULL by default — they are clamped ONLY when the priority-1 block overflows
// the section cap, and then via an adaptive cap = max(this, budget / N) so a
// few rules stay whole while a long tail is trimmed before any rule is dropped.
// No rule is ever clamped below this floor (a shorter head loses load-bearing
// text). § 5.3 Phase 2c (variable render budget, v0.36.4).
const MANDATORY_RULE_BODY_MAX = 200;

/**
 * composeReadBlock({ node, graph, opts }) — returns { content, sectionsEmitted, sectionsDropped }.
 *
 * @param {Object} args
 * @param {Object} args.node                       file node from the graph (required for Phase 1a content).
 * @param {Object} args.graph                      the full graph (for edge lookup).
 * @param {Object} [args.opts]
 * @param {number} [args.opts.capChars=10000]      character cap on the rendered block.
 * @param {number} [args.opts.safetyMargin=200]    reserved chars (block can use capChars - safetyMargin).
 * @param {Array<string|Object>} [args.opts.includeMandatoryRules=[]] Phase 2c; entries may
 *                                                              be raw strings (legacy) or rule
 *                                                              objects from parseCerebrum
 *                                                              with shape { body, buckets,
 *                                                              bySession, raw, ... }.
 * @param {Object | null} [args.opts.includeBugSummary=null] Phase 3 hook-up.
 * @param {number} [args.opts.topK=3]              number of connections/used_by to include.
 * @param {number} [args.opts.symbolsMax=20]       cap on symbols rendered.
 * @param {string | null} [args.opts.repeatedReadWarning=null] one-line warning string (no marker; appended).
 * @param {string | null} [args.opts.includeWhy=null]            Phase 4+ priority-7 'why' rationale.
 * @param {Array<{ body: string, score?: number, source?: string }> | null} [args.opts.includeLunrRules=null]
 *        Phase 4 priority-8 top-K Lunr-ranked rules. Each entry's body is
 *        capped at 200 chars when rendered. Score + source are surfaced
 *        inline as ` (score <S>, source <T>)`.
 * @returns {{ content: string, sectionsEmitted: string[], sectionsDropped: string[] }}
 */
export function composeReadBlock(args) {
  const node = args && args.node;
  const graph = args && args.graph;
  const opts = (args && args.opts) || {};

  const capChars = (typeof opts.capChars === 'number' && opts.capChars > 0)
    ? opts.capChars : DEFAULTS.capChars;
  const safetyMargin = (typeof opts.safetyMargin === 'number' && opts.safetyMargin >= 0)
    ? opts.safetyMargin : DEFAULTS.safetyMargin;
  const topK = (typeof opts.topK === 'number' && opts.topK >= 0)
    ? opts.topK : DEFAULTS.topK;
  const symbolsMax = (typeof opts.symbolsMax === 'number' && opts.symbolsMax >= 0)
    ? opts.symbolsMax : DEFAULTS.symbolsMax;
  const mandatoryRules = Array.isArray(opts.includeMandatoryRules) ? opts.includeMandatoryRules : [];
  const bugSummary = opts.includeBugSummary ?? null;
  const repeatedReadWarning = (typeof opts.repeatedReadWarning === 'string' && opts.repeatedReadWarning.length > 0)
    ? opts.repeatedReadWarning : null;
  const why = (typeof opts.includeWhy === 'string' && opts.includeWhy.length > 0)
    ? opts.includeWhy : null;
  const lunrRules = Array.isArray(opts.includeLunrRules) ? opts.includeLunrRules : [];

  // Effective budget for body content (excluding markers; budget includes the
  // marker fences when we measure). We track running character count of the
  // full rendered block — markers + sections — against capChars - safetyMargin.
  const effectiveCap = Math.max(0, capChars - safetyMargin);

  // Sections we will *attempt* to render, in priority order. Each entry knows
  // its identifier (for the dropped list) and how to render itself given the
  // current state. We render lazily so we can stop on truncation.
  const sections = [];

  // Pri 1: mandatory rules (Phase 2). Rules are rendered as bullet lines under
  // a `rules (<N>):` header. Truncation inside this section is
  // tracked separately: if the whole block would blow the cap, we keep the
  // last N rules (most recent — by source order, with newest entries at the
  // tail) that still fit. mandatoryDroppedCount records what we trimmed.
  //
  // mandatoryTotalCount = total rules the caller asked for (used for warning).
  let mandatoryTotalCount = 0;
  let mandatoryDroppedCount = 0;
  if (mandatoryRules.length > 0) {
    mandatoryTotalCount = mandatoryRules.filter((r) => r != null).length;
    const rendered = renderMandatoryRules(mandatoryRules);
    if (rendered) sections.push({ id: SECTION.MANDATORY_RULES, text: rendered, mandatory: true });
  }

  // Pri 2: bug summary (Phase 3). Shape is opaque to Phase 1a; if the caller
  // provided one with the documented shape, render its lines.
  if (bugSummary && typeof bugSummary === 'object') {
    const rendered = renderBugSummary(bugSummary);
    if (rendered) sections.push({ id: SECTION.BUG_SUMMARY, text: rendered, mandatory: true });
  }

  // Pri 3: identity line. Always rendered when we have a node (even with
  // community=null → "community: none"). Skipped only if node is missing.
  if (node && typeof node === 'object') {
    const rendered = renderIdentity(node);
    if (rendered) sections.push({ id: SECTION.IDENTITY, text: rendered });
  }

  // Pri 4: top-K outbound connections.
  if (node && graph && topK > 0) {
    const rendered = renderConnections(graph, node, topK);
    if (rendered) sections.push({ id: SECTION.CONNECTIONS, text: rendered });
  }

  // Pri 5: top-K inbound used_by.
  if (node && graph && topK > 0) {
    const rendered = renderUsedBy(graph, node, topK);
    if (rendered) sections.push({ id: SECTION.USED_BY, text: rendered });
  }

  // Pri 6: symbols (up to symbolsMax).
  if (node && symbolsMax > 0) {
    const rendered = renderSymbols(node, symbolsMax);
    if (rendered) sections.push({ id: SECTION.SYMBOLS, text: rendered });
  }

  // Pri 7: 'why' rationale (Phase 4+; not generated here). Renders only when
  // opts.includeWhy is a non-empty string. Plain one-liner per § 5.3.
  if (why) {
    sections.push({ id: SECTION.WHY, text: `why: ${why}` });
  }

  // Pri 8: top-K Lunr-ranked rules (Phase 4). Each entry body is clamped at
  // LUNR_RULE_BODY_MAX chars. Score + source are surfaced inline so the agent
  // can sanity-check whether the rule is on-topic.
  if (lunrRules.length > 0) {
    const rendered = renderLunrRules(lunrRules);
    if (rendered) sections.push({ id: SECTION.LUNR_RULES, text: rendered });
  }

  // Pri 9: repeated-read warning. Composer doesn't generate; receives via opts.
  if (repeatedReadWarning) {
    sections.push({ id: SECTION.REPEATED_READ, text: repeatedReadWarning });
  }

  // If there are no sections at all, emit nothing — callers treat empty
  // strings as "no additionalContext to inject".
  if (sections.length === 0) {
    return { content: '', sectionsEmitted: [], sectionsDropped: [] };
  }

  // Build the block section by section, checking the cap each time. The
  // measured "running length" includes the open marker, all emitted sections
  // (joined with newlines), and the close marker. We compute incrementally.
  const emittedTexts = [];
  const sectionsEmitted = [];
  const sectionsDropped = [];

  // Start with marker overhead — open + close + the joining newlines we'd
  // need. Conservative pre-charge so the first section's cap check is honest.
  const fixedOverhead = OPEN_MARKER.length + 1 /* \n */ + CLOSE_MARKER.length;

  let runningLen = fixedOverhead;

  for (const sec of sections) {
    // Candidate addition: text plus the newline that joins it to the prior
    // section (or to the open marker if it's the first content line).
    const addLen = sec.text.length + 1; // +1 for the joining newline
    const wouldBe = runningLen + addLen;

    if (wouldBe > effectiveCap && !sec.mandatory) {
      // Drop this section and continue checking remaining ones (some later
      // sections might still fit, but the spec says drop from the bottom up,
      // so we stop checking subsequent sections too — they would only push
      // further past the cap).
      sectionsDropped.push(sec.id);
      // Continue iteration so we collect the full dropped list. Note: we
      // do NOT try to fit smaller later sections; the priority order means
      // anything after a dropped section is also dropped.
      continue;
    }

    if (sec.mandatory && wouldBe > effectiveCap && sec.id === SECTION.MANDATORY_RULES) {
      // Phase 2c: the mandatory-rules block alone won't fit. Re-render it
      // with only the most recently authored rules (tail of the list, since
      // cerebrum is append-ordered → newest entries appear last). Drop one
      // rule at a time until the budget admits it, recording the dropped
      // count for a specific warning.
      const budgetForBlock = Math.max(0, effectiveCap - runningLen - 1); // -1 newline
      const trimmed = renderMandatoryRulesWithBudget(mandatoryRules, budgetForBlock);
      mandatoryDroppedCount = mandatoryTotalCount - trimmed.kept;
      if (trimmed.text.length > 0) {
        emittedTexts.push(trimmed.text);
        sectionsEmitted.push(sec.id);
        runningLen += trimmed.text.length + 1;
      } else {
        // Even one rule doesn't fit — record everything as dropped. Per § 5.3
        // mandatory rules never appear in `sectionsDropped`; the dedicated
        // truncation warning carries the count.
        mandatoryDroppedCount = mandatoryTotalCount;
      }
      continue;
    }

    if (sec.mandatory && wouldBe > effectiveCap) {
      // Other mandatory sections (e.g., bug summary) — render anyway. Spec
      // says mandatories never go on the dropped list.
      emittedTexts.push(sec.text);
      sectionsEmitted.push(sec.id);
      runningLen = wouldBe;
      continue;
    }

    emittedTexts.push(sec.text);
    sectionsEmitted.push(sec.id);
    runningLen = wouldBe;
  }

  // If we dropped anything, append the truncation marker. It's also a body
  // line and consumes characters; we add it after the cap check so we still
  // honour capChars (it's why safetyMargin exists — to reserve headroom for
  // this line).
  //
  // Phase 2c: a non-empty mandatoryDroppedCount means we trimmed the priority-1
  // block to fit. Render that as a distinct prefix in the warning, since
  // mandatory rules MUST NEVER appear in `sectionsDropped` per § 5.3.
  let truncationLine = '';
  if (mandatoryDroppedCount > 0 || sectionsDropped.length > 0) {
    const parts = [];
    if (mandatoryDroppedCount > 0) {
      parts.push(`rules (${mandatoryDroppedCount} dropped)`);
    }
    if (sectionsDropped.length > 0) {
      parts.push(sectionsDropped.join(', '));
    }
    truncationLine = `<!-- sextant:truncated due to cap; dropped: ${parts.join('; ')} -->`;
  }

  // Stitch the block: open marker, imperative, emitted sections, optional truncation line, close marker.
  const lines = [OPEN_MARKER];
  lines.push(buildImperative(sectionsEmitted));
  for (const t of emittedTexts) lines.push(t);
  if (truncationLine) lines.push(truncationLine);
  lines.push(CLOSE_MARKER);
  const content = lines.join('\n');

  return { content, sectionsEmitted, sectionsDropped };
}

// R13: action imperative for Opus 4.7 — data without a directive is passive context.
function buildImperative(sectionsEmitted) {
  const hasGraph = sectionsEmitted.includes(SECTION.IDENTITY)
    || sectionsEmitted.includes(SECTION.CONNECTIONS)
    || sectionsEmitted.includes(SECTION.USED_BY)
    || sectionsEmitted.includes(SECTION.SYMBOLS);
  if (sectionsEmitted.includes(SECTION.MANDATORY_RULES)) {
    // The rules-only floor (the Read path, post read-context hygiene) carries no
    // graph context — only reference the graph when a graph section is present.
    return hasGraph
      ? 'Apply every rule below to all edits in this file. Use the graph context to understand dependencies.'
      : 'Apply every rule below to all edits in this file.';
  }
  return 'Use the context below to understand this file\'s role and dependencies before making changes.';
}

// --- section renderers -----------------------------------------------------

// Render the priority-1 mandatory-rules block.
//
// Each entry can be:
//   - a string: rendered as a bullet line verbatim (legacy, also used by tests
//     that want to bypass formatting).
//   - an object with { body, buckets, bySession }: formatted into
//     `  • [<bucket>] <body> (from <by> session)`.
//
// Returns '' when the input is empty (caller omits the section header).
function renderMandatoryRules(rules) {
  const lines = [];
  for (const r of rules) {
    const line = formatMandatoryBullet(r);
    if (line.length > 0) lines.push(line);
  }
  if (lines.length === 0) return '';
  return `rules (${lines.length}):\n${lines.join('\n')}`;
}

// Same as renderMandatoryRules but the total rendered length (including the
// header) must fit within `budget`. Drops rules from the head (oldest first)
// until what remains fits. Returns { text, kept } where kept is the number of
// rules included. § 5.3 — "render only the most recently authored mandatory
// rules" → oldest entries drop first.
// renderMandatoryRulesWithBudget(rules, budget): render the priority-1 block
// trimmed to fit `budget` chars. Two-stage trim: (1) an ADAPTIVE per-rule body
// cap = max(MANDATORY_RULE_BODY_MAX, budget / N) clamps long bodies so more
// rules fit whole — few rules → full bodies, a long tail → trimmed heads; then
// (2) if it still overflows, DROP rules, RANK-AWARE — path ([node:]) rules are
// the deterministic scope floor and are NEVER dropped. On overflow we shed only
// NON-path matches (BM25 keyword / global / bare-[!]) OLDEST-FIRST; if just path
// rules remain we keep them all even past budget (the floor wins — a
// deterministic scope match must outrank a ranked keyword match no matter how
// many matched). Render order stays the original source order; only the DROP
// order is rank-aware. Returns { text, kept }.
function renderMandatoryRulesWithBudget(rules, budget) {
  // First pass: keep the rules that render to a non-empty bullet (some objects
  // are filtered as malformed). We need the count N before we can size the
  // adaptive per-rule cap.
  const valid = [];
  for (const r of rules) {
    if (formatMandatoryBullet(r).length === 0) continue;
    const buckets = Array.isArray(r && r.buckets) ? r.buckets : [];
    const isPath = buckets.some((b) => typeof b === 'string' && b.startsWith('node:'));
    valid.push({ rule: r, isPath });
  }
  if (valid.length === 0) return { text: '', kept: 0 };

  // Adaptive per-rule body cap (the variable render budget): split the budget
  // evenly across the rules, never below MANDATORY_RULE_BODY_MAX. With a few
  // rules the share is large → bodies render whole; with a long tail each is
  // trimmed so more rules fit before we resort to dropping. Computed from the
  // ORIGINAL N (no greedy redistribution as rules drop — uniform is enough).
  const cap = Math.max(MANDATORY_RULE_BODY_MAX, Math.floor(budget / valid.length));
  const items = valid.map((v) => ({
    line: formatMandatoryBullet(v.rule, cap),
    isPath: v.isPath,
  }));

  const measure = (kept) => {
    if (kept.length === 0) return 0;
    const header = `rules (${kept.length}):`;
    const body = kept.reduce((s, it) => s + it.line.length + 1, -1); // first line has no leading \n
    return header.length + 1 + body; // header + \n + body
  };

  // Keep everything, then drop the OLDEST non-path rule until it fits. Stop when
  // only path rules remain — those are never dropped.
  const kept = items.slice();
  while (kept.length > 0 && measure(kept) > budget) {
    const dropIdx = kept.findIndex((it) => !it.isPath);
    if (dropIdx === -1) break; // only path rules left → keep the floor, even over budget
    kept.splice(dropIdx, 1);
  }

  if (kept.length === 0) return { text: '', kept: 0 };
  return { text: `rules (${kept.length}):\n${kept.map((it) => it.line).join('\n')}`, kept: kept.length };
}

// formatMandatoryBullet(rule, maxBody=Infinity): render one bullet line. The
// body renders in FULL unless `maxBody` is finite (the adaptive budget path
// passes a per-rule cap; the common render path passes nothing → no clamp).
function formatMandatoryBullet(rule, maxBody = Infinity) {
  if (rule == null) return '';

  // String form: pass through with bullet prefix if not already present.
  if (typeof rule === 'string') {
    if (rule.length === 0) return '';
    if (rule.startsWith('  • ') || rule.startsWith('  - ')) return rule;
    return `  • ${truncateBody(rule, maxBody)}`;
  }

  // Object form (parseCerebrum entry).
  if (typeof rule !== 'object') return '';

  const buckets = Array.isArray(rule.buckets) ? rule.buckets : [];
  // Render the most-informative bucket. Prefer [!global] when present (it's
  // the more visible label), else the first bucket beyond plain '!'.
  let label;
  if (buckets.includes('!global')) {
    label = '[!global]';
  } else {
    const nodeBucket = buckets.find((b) => typeof b === 'string' && b.startsWith('node:'));
    const kwBucket = buckets.find((b) => typeof b === 'string' && b.startsWith('kw:'));
    if (nodeBucket) {
      // cerebrum-v2 T5.6: node: rules fire by scope alone (no [!] needed), so
      // label by scope only — a hardcoded [!] would imply importance the rule
      // may not carry and contradicts the "[!] is kw-only" model.
      label = `[${nodeBucket}]`;
    } else if (buckets.includes('!')) {
      label = '[!]';
    } else if (kwBucket) {
      // A keyword-scoped rule surfaced by the BM25 kw branch (Read) carries only
      // [kw:…], NOT '!'. These merge into the priority-1 block, so the renderer
      // labels them rather than dropping them as "filtered incorrectly".
      label = '[kw]';
    } else {
      // No mandatory/keyword bucket at all — caller filtered incorrectly. Skip.
      return '';
    }
  }

  const body = typeof rule.body === 'string' ? rule.body : '';
  const bySession = typeof rule.bySession === 'string' && rule.bySession.length > 0
    ? rule.bySession
    : null;

  let line = `  • ${label} ${truncateBody(body, maxBody)}`;
  if (bySession) line += ` (from ${bySession} session)`;
  return line;
}

// Clamp a rule body to `max` chars (default Infinity = no clamp). Mandatory
// bodies render in full on the common path; only the adaptive budget path passes
// a finite cap. Anything past `max` gets a `...` elision suffix.
function truncateBody(text, max = Infinity) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

function renderBugSummary(summary) {
  // Phase 3 shape (§ 6.3 + Phase 3 plan):
  //   { open_count: <N>, most_recent: <bug-entry> | null }
  //
  // Render rules:
  //   - open_count === 0 → omit the section entirely (return '').
  //   - open_count > 0 + most_recent is a full bug entry →
  //       "bugs: <N> open in project; most recent in this file:
  //        <error_message> (id <bug-N>)"
  //   - open_count > 0 + most_recent missing → "bugs: <N> open in project".
  //
  // Legacy shape ({ open: <N>, most_recent: <string> }) is still supported
  // as a fallback so older callers and tests don't break — we render it the
  // same way we did before.
  if (summary == null) return '';

  const openCount = (typeof summary.open_count === 'number')
    ? summary.open_count
    : (typeof summary.open === 'number' ? summary.open : null);

  if (typeof openCount === 'number') {
    if (openCount === 0) return '';
    const parts = [`bugs: ${openCount} open in project`];
    const mr = summary.most_recent;
    if (mr && typeof mr === 'object') {
      const errMsg = typeof mr.error_message === 'string' ? mr.error_message : '';
      const id = typeof mr.id === 'string' ? mr.id : '';
      if (errMsg.length > 0 || id.length > 0) {
        const idSuffix = id.length > 0 ? ` (id ${id})` : '';
        parts.push(`most recent in this file: ${errMsg}${idSuffix}`);
      }
    } else if (typeof mr === 'string' && mr.length > 0) {
      // Legacy shape: just a short string.
      parts.push(`most recent unfixed: ${mr}`);
    }
    return parts.join('; ');
  }

  // No open_count at all → defensive fallback to the legacy shape's exact
  // semantics (render whatever scraps the caller provided).
  const parts = [];
  if (typeof summary.most_recent === 'string' && summary.most_recent.length > 0) {
    parts.push(`most recent unfixed: ${summary.most_recent}`);
  }
  if (parts.length === 0) return '';
  return parts.join('; ');
}

function renderIdentity(node) {
  const label = typeof node[NODE.LABEL] === 'string' && node[NODE.LABEL].length > 0
    ? node[NODE.LABEL]
    : (typeof node[NODE.PATH] === 'string' ? node[NODE.PATH] : 'unknown');
  const community = node[NODE.COMMUNITY];
  const communityStr = (community === null || community === undefined)
    ? 'none'
    : `#${community}`;
  return `graph: ${label}; community: ${communityStr}`;
}

function renderConnections(graph, node, topK) {
  const nodeId = node[NODE.ID];
  const conns = topConnections(graph, nodeId, topK);
  if (conns.length === 0) return '';
  const headerCount = Math.min(topK, conns.length);
  const lines = [`connections (top ${headerCount}):`];
  for (const c of conns) {
    const targetId = c.edge[EDGE.TO];
    const label = renderTargetLabel(c.targetNode, targetId);
    const edgeType = c.edge[EDGE.TYPE];
    const confidence = c.edge[EDGE.CONFIDENCE];
    lines.push(`  -> ${label} [${edgeType}, ${confidence}]`);
  }
  return lines.join('\n');
}

function renderUsedBy(graph, node, topK) {
  const nodeId = node[NODE.ID];
  const uses = topUsedBy(graph, nodeId, topK);
  if (uses.length === 0) return '';
  const headerCount = Math.min(topK, uses.length);
  const lines = [`used_by (top ${headerCount}):`];
  for (const u of uses) {
    const sourceId = u.edge[EDGE.FROM];
    const label = renderSourceLabel(u.sourceNode, sourceId);
    const edgeType = u.edge[EDGE.TYPE];
    const confidence = u.edge[EDGE.CONFIDENCE];
    lines.push(`  <- ${label} [${edgeType}, ${confidence}]`);
  }
  return lines.join('\n');
}

function renderSymbols(node, symbolsMax) {
  const syms = Array.isArray(node[NODE.SYMBOLS]) ? node[NODE.SYMBOLS] : [];
  if (syms.length === 0) return '';
  const shown = syms.slice(0, symbolsMax);
  const rendered = shown.map(renderSymbolName).join(', ');
  return `symbols (up to ${symbolsMax}): ${rendered}`;
}

// Render priority-8 top-K Lunr-ranked rules. Each entry shape:
//   { body: <text>, score?: <number>, source?: <node:path-or-global> }
//
// The body is clamped to LUNR_RULE_BODY_MAX chars (200 per § 8 Phase 4).
// Empty bodies are skipped. Returns '' if no entries survive.
function renderLunrRules(rules) {
  const lines = [];
  for (const r of rules) {
    const line = formatLunrBullet(r);
    if (line.length > 0) lines.push(line);
  }
  if (lines.length === 0) return '';
  return `related rules (top ${lines.length}):\n${lines.join('\n')}`;
}

function formatLunrBullet(rule) {
  if (rule == null || typeof rule !== 'object') return '';
  const body = typeof rule.body === 'string' ? rule.body : '';
  if (body.length === 0) return '';
  const clamped = body.length > LUNR_RULE_BODY_MAX
    ? body.slice(0, LUNR_RULE_BODY_MAX - 3) + '...'
    : body;
  const parts = [];
  if (typeof rule.score === 'number' && Number.isFinite(rule.score)) {
    parts.push(`score ${formatScore(rule.score)}`);
  }
  if (typeof rule.source === 'string' && rule.source.length > 0) {
    parts.push(`source ${rule.source}`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `  - ${clamped}${suffix}`;
}

// Two-decimal score for compact rendering. We strip trailing zeros so 1.0 →
// "1" but 0.62 stays "0.62". Avoids excessive precision noise in the block.
function formatScore(score) {
  const s = score.toFixed(2);
  if (s.endsWith('.00')) return s.slice(0, -3);
  if (s.endsWith('0')) return s.slice(0, -1);
  return s;
}

// Heuristic: a symbol whose name starts with a lowercase letter is "probably a
// function" and gets a `()` suffix. Class / interface / type names typically
// start with an uppercase letter and stay bare. Cheap, not load-bearing.
function renderSymbolName(name) {
  if (typeof name !== 'string' || name.length === 0) return String(name);
  const first = name.charAt(0);
  // Lowercase ASCII letter → function-y; anything else (uppercase, $, _, digit) → bare.
  if (first >= 'a' && first <= 'z') return `${name}()`;
  return name;
}

// Render the label for an outbound edge target. Prefer the resolved node's
// label when available; fall back to the raw id minus its `node:` /
// `unresolved:` prefix.
function renderTargetLabel(targetNode, targetId) {
  if (targetNode && typeof targetNode[NODE.LABEL] === 'string' && targetNode[NODE.LABEL].length > 0) {
    return targetNode[NODE.LABEL];
  }
  // Strip a known id prefix; otherwise return as-is.
  if (typeof targetId === 'string') {
    if (targetId.startsWith('node:')) return targetId.slice(5);
    if (targetId.startsWith('unresolved:')) return targetId.slice(11);
    return targetId;
  }
  return '<unknown>';
}

// Render the label for an inbound edge source. Same rules.
function renderSourceLabel(sourceNode, sourceId) {
  if (sourceNode && typeof sourceNode[NODE.LABEL] === 'string' && sourceNode[NODE.LABEL].length > 0) {
    return sourceNode[NODE.LABEL];
  }
  if (typeof sourceId === 'string') {
    if (sourceId.startsWith('node:')) return sourceId.slice(5);
    if (sourceId.startsWith('unresolved:')) return sourceId.slice(11);
    return sourceId;
  }
  return '<unknown>';
}

// Exported for tests that want to assert on the exact marker shape.
export const READ_CONTEXT_OPEN_MARKER = OPEN_MARKER;
export const READ_CONTEXT_CLOSE_MARKER = CLOSE_MARKER;
export const SECTIONS = SECTION;
// Sanity probe: GRAPH import isn't unused — keep the symbol live for the rare
// future case where we want to expose schema fields from the composer.
void GRAPH;
