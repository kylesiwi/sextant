// lib/hooks/composeSessionStart.mjs — pure compose helper for the
// SessionStart additionalContext block (§ 5.1).
//
// Why a separate module: lib/hooks/sessionStart.mjs is the side-effectful
// handler (reads files, writes state, logs). Composition is pure — given
// project.md content, an optional last.json snapshot, graph stats, and a
// staleness flag, produce the marker-fenced block string Claude Code will
// inject as additionalContext.
//
// Marker fencing convention (per § 5.1):
//   <!-- sextant:session-start -->
//   …content…
//   <!-- /sextant:session-start -->
//
// Empty-block convention (deliberate, documented):
//   If neither project.md nor last.json exists AND the graph stats line
//   produces nothing useful (no graph at all), composeSessionStartBlock
//   returns null. Callers MUST treat null as "do not emit additionalContext"
//   and avoid sending an empty marker block (which would needlessly burn
//   context tokens). Tests assert the null contract.

const OPEN_MARKER = '<!-- sextant:session-start -->';
const CLOSE_MARKER = '<!-- /sextant:session-start -->';

// Default cap for the verbatim project.md preamble. A 50KB project.md would
// otherwise burn ~12K tokens on every SessionStart fire. 4000 chars is a
// reasonable budget: enough to carry a project's mission statement and the
// most-load-bearing context, while bounding silent token cost.
//
// Overridable via SEXTANT_PROJECTMD_MAX_CHARS. Non-numeric / non-positive
// values fall back to the default — we never want a malformed env var to
// crash the SessionStart hook.
const DEFAULT_PROJECTMD_MAX_CHARS = 4000;

function getProjectMdMaxChars() {
  const raw = process.env.SEXTANT_PROJECTMD_MAX_CHARS;
  if (raw === undefined || raw === '') return DEFAULT_PROJECTMD_MAX_CHARS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PROJECTMD_MAX_CHARS;
  return Math.floor(n);
}

// Pull unchecked checklist items ("- [ ] …") out of a doc section's raw text,
// returning each item's text with the marker stripped. Used to surface a
// tranche's pre-implementation open questions at SessionStart. Checked items
// ("- [x] …", i.e. resolved) and comment/prose lines are ignored — mirrors how
// readTrancheDoc counts only "- [ ]" for open_questions_count.
function uncheckedItems(sectionText) {
  if (typeof sectionText !== 'string' || sectionText.length === 0) return [];
  const out = [];
  for (const line of sectionText.split('\n')) {
    const m = line.match(/^\s*-\s*\[ \]\s+(.+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// Single-line clip for surfaced free-text (concern bodies can run long).
function clip(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// nextActionDirective(active): a status-aware "what to do next" clause appended
// to the first-turn reminder, so an agent joining a feature cold always knows
// the correct next move for the active tranche — not just in the READY case.
// Keyed on the active tranche's lifecycle status; '' when there's no resolved
// active tranche. The leading space lets it concatenate onto the reminder.
//
// Grounded in the state machine (lib/stores/tranches.mjs):
//   - Coding is only gated while IN-FLIGHT (Stop's capture gate keys on
//     workflow_state IMPLEMENTING). A STUB/READY tranche is NOT gated — Sextant
//     does not block coding against it — so the directive is the safeguard.
//   - STUB → READY → IN-FLIGHT → SHIPPED, advanced via /sextant:tranche-advance.
//   - A ship auto-advances active_tranche_id to the next STUB, so an active
//     tranche is SHIPPED only when ALL tranches are terminal (→ COMPLETING),
//     whose next step is the `complete` then `finalize` CLI flow.
function nextActionDirective(active) {
  if (!active || active.id == null) return '';
  const id = active.id;
  switch (active.status) {
    case 'STUB':
      return ` NEXT — T${id} is STUB (being scoped): finish detailing it (resolve its open questions / pre-implementation checklist), then /sextant:tranche-advance it to READY. Don't start implementation yet.`;
    case 'READY':
      return ` NEXT — T${id} is READY (planned, not started): implementation only happens while IN-FLIGHT, and Sextant does not block coding against a READY tranche. Run /sextant:tranche-advance to move it to IN-FLIGHT BEFORE writing any implementation code.`;
    case 'IN-FLIGHT':
      return ` NEXT — T${id} is IN-FLIGHT (active implementation tranche): build against its scope and capture learnings as you go; once its verification gates pass, review then ship it via /sextant:tranche-advance (shipping FREEZES scope).`;
    case 'SHIPPED':
      return ` NEXT — T${id} is SHIPPED (feature complete): close it out — run the tranche \`complete\` then \`finalize\` steps (resolve any open carry-forward concerns first).`;
    default:
      return '';
  }
}

/**
 * composeSessionStartBlock({ projectMd, lastJson, graphStats, isStale }):
 *
 * @param {Object} opts
 * @param {string | null} opts.projectMd  - raw contents of .sextant/project.md (or null).
 * @param {Object | null} opts.lastJson   - parsed .sextant/session/last.json (or null).
 *   Minimal Phase 1a shape: { ended_at, focus, open_todos: string[] }. Any
 *   missing field renders gracefully.
 * @param {Object | null} opts.graphStats - { files: number, builtAtMs: number | null } or null.
 *   builtAtMs is epoch-ms used to render a relative-time hint.
 * @param {boolean} opts.isStale          - true if the graph is older than the staleness threshold.
 * @param {Array<{ body?: string, raw?: string }> | null} [opts.globalRules]
 *   Mandatory rules carrying the [!global] bucket. When present and non-empty,
 *   renders a "Global mandatory rules" section after graph status. Empty or
 *   absent → section is omitted.
 * @param {(now?: number) => number} [opts.now] - clock; tests pass a fixed epoch ms.
 * @returns {string | null} the fenced block, or null if there's nothing to emit.
 */
export function composeSessionStartBlock(opts) {
  const projectMd = opts && opts.projectMd;
  const lastJson = opts && opts.lastJson;
  const graphStats = opts && opts.graphStats;
  const isStale = Boolean(opts && opts.isStale);
  const globalRules = (opts && Array.isArray(opts.globalRules)) ? opts.globalRules : [];
  const trancheState = (opts && opts.trancheState) || null;
  const trancheDocParsed = (opts && opts.trancheDocParsed) || null;
  // captureNudge: when true (default), append a one-line steering nudge for
  // non-tranche sessions. Off → omit it (the config kill switch).
  const captureNudge = !(opts && opts.captureNudge === false);
  const now = (opts && typeof opts.now === 'function') ? opts.now() : Date.now();

  const segments = [];

  // R13: action imperative for Opus 4.7 — prepended as the first segment so
  // the model reads a directive before any project/session/graph data.
  const SESSION_IMPERATIVE = 'Follow the project conventions and context below for this session.';

  // 1. project.md preamble (verbatim — up to the cap). Keep the section
  //    header so the LLM can tell where the user-authored prose ends.
  //
  //    Size cap: an unbounded project.md silently burns tokens on every
  //    SessionStart. If `projectMd.length` exceeds the cap (default 4000,
  //    overridable via SEXTANT_PROJECTMD_MAX_CHARS), truncate to the cap
  //    and append a visible HTML comment so the user can see what's been
  //    clipped. Truncation is by character count (UTF-16 code units —
  //    same unit as String.prototype.length).
  if (typeof projectMd === 'string' && projectMd.trim().length > 0) {
    const maxChars = getProjectMdMaxChars();
    const original = projectMd.trimEnd();
    let rendered = original;
    if (original.length > maxChars) {
      // Reserve the marker's bytes inside the cap so the final emitted length
      // is ≤ maxChars (was previously maxChars + ~76 because the marker was
      // appended after a maxChars slice). If the marker itself is bigger than
      // the cap (degenerate maxChars), emit it alone — clipped content was
      // never going to be useful at that budget.
      const marker = `\n\n<!-- sextant:truncated project.md was ${original.length}chars, capped at ${maxChars}chars -->`;
      const contentBudget = Math.max(0, maxChars - marker.length);
      rendered = original.slice(0, contentBudget) + marker;
    }
    segments.push('## Project (from .sextant/project.md)');
    segments.push('');
    segments.push(rendered);
  }

  // 2. last.json summary, only if at least one of the three useful fields
  //    is present. Renders gracefully when fields are missing.
  if (lastJson && typeof lastJson === 'object') {
    const hasAnything =
      typeof lastJson.ended_at === 'string' ||
      typeof lastJson.focus === 'string' ||
      (Array.isArray(lastJson.open_todos) && lastJson.open_todos.length > 0);
    if (hasAnything) {
      if (segments.length > 0) segments.push('');
      segments.push('## Last session');
      const parts = [];
      if (typeof lastJson.ended_at === 'string' && lastJson.ended_at.length > 0) {
        parts.push(`ended at ${lastJson.ended_at}`);
      }
      if (typeof lastJson.focus === 'string' && lastJson.focus.length > 0) {
        parts.push(`working on ${lastJson.focus}`);
      }
      const todos = Array.isArray(lastJson.open_todos) ? lastJson.open_todos : [];
      if (todos.length > 0) {
        // Cap at 10 todos; cumulative todo backlogs can grow unbounded.
        const shown = todos.slice(0, 10);
        parts.push(`open todos: ${shown.join(', ')}`);
      }
      // Phrase as a single sentence joined by ", ".
      const sentence = parts.length > 0 ? `Last session ${parts.join(', ')}.` : '';
      if (sentence) segments.push(sentence);
    }
  }

  // 3. Graph status. Only emit if we have any graph stats to report.
  if (graphStats && typeof graphStats === 'object' && typeof graphStats.files === 'number') {
    if (segments.length > 0) segments.push('');
    segments.push('## Graph');
    const builtAtMs = (typeof graphStats.builtAtMs === 'number' && !Number.isNaN(graphStats.builtAtMs))
      ? graphStats.builtAtMs : null;
    const rel = builtAtMs !== null ? relativeTime(now - builtAtMs) : 'never';
    let line = `Graph: ${graphStats.files} files indexed, last build ${rel}.`;
    if (isStale) {
      line += ' (stale — run /sextant:graph-build)';
    }
    segments.push(line);
  }

  // 4. Global mandatory rules. Rules tagged [!global] apply for the whole
  //    session, so surfacing them once at SessionStart is the right place —
  //    PreToolUse:Read only fires when the agent reads a file, and PreToolUse:
  //    Bash only fires on commands. SessionStart is the only hook the agent is
  //    guaranteed to see before any tool call.
  if (globalRules.length > 0) {
    if (segments.length > 0) segments.push('');
    segments.push('## Global mandatory rules');
    segments.push('Apply every global rule below for the entire session.');
    for (const r of globalRules) {
      const body = (r && typeof r.body === 'string' && r.body.length > 0)
        ? r.body
        : (r && typeof r.raw === 'string' ? r.raw : '');
      if (body.length > 0) segments.push(`  - ${body}`);
    }
  }

  // 4b. Capture steering (non-tranche only). One soft line nudging capture as
  //     you go. Gated on existing content so a bare repo still returns null (the
  //     documented empty-block contract), and omitted when a tranche is active
  //     (its own section already carries a capture line). Kept to a single line
  //     to avoid diluting the mandatory rules injected above it.
  if (captureNudge && segments.length > 0 && !(trancheState && trancheState.feature)) {
    segments.push('');
    segments.push('## Capture as you go');
    segments.push('When you hit a gotcha, a non-obvious constraint, or fix a subtle bug, record it the moment you find it with /sextant:remember — don\'t wait for the end of the task; lessons captured in-flight compound across sessions.');
  }

  // 5. Active tranche section. Renders full orientation when a tranche
  //    workflow is active: feature name, workflow state, all tranche statuses,
  //    active tranche deliverables (from the parsed tranche doc), and commands.
  if (trancheState && trancheState.feature) {
    if (segments.length > 0) segments.push('');
    segments.push('## Active tranche');

    const active = Array.isArray(trancheState.tranches)
      ? trancheState.tranches.find(t => t.id === trancheState.active_tranche_id)
      : null;

    // First-turn user reminder — a directive the agent should SURFACE to the
    // user on its opening reply, not silently absorb. Flags that a tranche
    // workflow is in progress and offers to read the (frozen) charter so the
    // agent can get reacquainted before doing other work.
    const activeDesc = active
      ? `active T${active.id} "${active.title}" (${active.status})`
      : `workflow ${trancheState.workflow_state}`;
    const charterOffer = trancheState.charter_path
      ? ` Offer to read the full charter (${trancheState.charter_path}) to get reacquainted before continuing.`
      : '';
    const oqCount = (trancheDocParsed && Number.isFinite(trancheDocParsed.open_questions_count))
      ? trancheDocParsed.open_questions_count
      : 0;
    const oqReminder = oqCount > 0
      ? ` There ${oqCount === 1 ? 'is' : 'are'} ${oqCount} open question${oqCount === 1 ? '' : 's'} to resolve before this tranche can reach READY.`
      : '';
    const openConcernList = Array.isArray(trancheState.carry_forward)
      ? trancheState.carry_forward.filter((c) => c && c.status === 'open')
      : [];
    const concernReminder = openConcernList.length > 0
      ? ` The feature has ${openConcernList.length} open carry-forward concern${openConcernList.length === 1 ? '' : 's'} that must be consumed before it can finalize.`
      : '';
    // Status-aware "next action" directive — so an agent joining a feature cold
    // always knows the correct next move for the active tranche, whatever its
    // lifecycle status. See nextActionDirective().
    const nextAction = nextActionDirective(active);
    segments.push(
      `On your first reply this session, remind the user that a tranche workflow is in progress — ` +
      `feature "${trancheState.feature}", ${activeDesc} — before starting other work.${charterOffer}${oqReminder}${concernReminder}${nextAction}`,
    );

    segments.push(`Feature: ${trancheState.feature} | Workflow: ${trancheState.workflow_state}`);
    if (trancheState.charter_path) {
      segments.push(`Charter: ${trancheState.charter_path} (FROZEN — do not edit)`);
    }
    if (trancheState.spec_path) {
      segments.push(`Spec: ${trancheState.spec_path} (living — amendments must be logged)`);
    }

    if (Array.isArray(trancheState.tranches) && trancheState.tranches.length > 0) {
      segments.push('');
      segments.push('Tranche status:');
      // Brief legend so an agent joining cold knows what the statuses mean — in
      // particular that READY ≠ "go" (it's planned-but-not-started) and that
      // implementation only happens while IN-FLIGHT.
      segments.push('  (lifecycle: STUB = scoping → READY = planned, not started → IN-FLIGHT = implementing → SHIPPED = done; code only while IN-FLIGHT — advance a READY tranche first)');
      for (const t of trancheState.tranches) {
        const activeMarker = t.id === trancheState.active_tranche_id ? ' (active)' : '';
        const shipped = t.shipped_at ? ` (${t.shipped_at.slice(0, 10)})` : '';
        segments.push(`  T${t.id} "${t.title}" — ${t.status}${shipped}${activeMarker}`);
      }
    }

    if (active && trancheDocParsed) {
      segments.push('');
      // Pre-implementation open questions — the blockers that must be emptied
      // before READY. Surfaced as actionable text (not just a count) so the
      // agent can drive them down. The checklist-done gate forces count==0
      // before IN-FLIGHT, so in practice this only renders for STUB/READY.
      const openQs = uncheckedItems(trancheDocParsed.sections?.['open questions before implementation']);
      if (openQs.length > 0) {
        const OQ_CAP = 8;
        segments.push(`T${active.id} open questions to resolve before READY (${openQs.length}):`);
        for (const q of openQs.slice(0, OQ_CAP)) segments.push(`  - ${q}`);
        if (openQs.length > OQ_CAP) {
          segments.push(`  …and ${openQs.length - OQ_CAP} more (see ${active.doc_path || 'the tranche doc'}).`);
        }
      }
      if (Array.isArray(trancheDocParsed.deliverables_summary) && trancheDocParsed.deliverables_summary.length > 0) {
        segments.push(`T${active.id} deliverables: ${trancheDocParsed.deliverables_summary.join(' | ')}`);
      }
      segments.push(`T${active.id} verification gates: ${trancheDocParsed.verification_gates_done}/${trancheDocParsed.verification_gates_total} checked`);
      if (active.doc_path) {
        segments.push(`T${active.id} tranche doc: ${active.doc_path}`);
      }
      if (Array.isArray(active.scope) && active.scope.length > 0) {
        segments.push(`Active scope (T${active.id}): ${active.scope.join(', ')}`);
      }
      const checklistStatus = active.checklist_complete ? 'COMPLETE' : 'PENDING';
      segments.push(`Pre-implementation checklist: ${checklistStatus}`);
    }

    // Carry-forward concerns — feature-global open unknowns. Surfaced once per
    // session (fuller than the per-turn nudge), flagging any aimed at the now-
    // active tranche. These block `finalize` until resolved.
    if (openConcernList.length > 0) {
      segments.push('');
      segments.push(`Carry-forward concerns (open: ${openConcernList.length}):`);
      const CC_CAP = 8;
      for (const concern of openConcernList.slice(0, CC_CAP)) {
        const flag = active && concern.target === active.id
          ? ' ← for this tranche'
          : (concern.target ? ` (target T${concern.target})` : '');
        segments.push(`  #${concern.id}${flag}: ${clip(concern.text, 160)}`);
      }
      if (openConcernList.length > CC_CAP) {
        segments.push(`  …and ${openConcernList.length - CC_CAP} more (/sextant:tranche-status).`);
      }
    }

    segments.push('');
    segments.push('Commands: /sextant:tranche-status, /sextant:tranche-advance, /sextant:tranche-amend');
    segments.push('Capture learnings: /sextant:remember | Log bugs: /sextant:bug-log');
  }

  if (segments.length === 0) return null;

  return [OPEN_MARKER, SESSION_IMPERATIVE, ...segments, CLOSE_MARKER].join('\n');
}

/**
 * relativeTime(deltaMs): a friendly "Nm ago" / "Nh ago" / "Nd ago" string.
 *
 * Negative deltas (future) become "just now" — clock skew shouldn't surface
 * to the user as nonsense.
 */
export function relativeTime(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Exported for tests that want to assert on the exact marker shape.
export const SESSION_START_OPEN_MARKER = OPEN_MARKER;
export const SESSION_START_CLOSE_MARKER = CLOSE_MARKER;
