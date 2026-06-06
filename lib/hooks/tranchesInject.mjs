import { activeTranche } from '../stores/tranches.mjs';

const NUDGE_OPEN = '<!-- sextant:tranche-nudge -->';
const NUDGE_CLOSE = '<!-- /sextant:tranche-nudge -->';

// Per-turn nudge surfacing cap: keep each "needs attention" group to a few items
// so the every-turn injection stays cheap (see TOTAL_BUDGET_CHARS in
// userPromptSubmit). The full list always lives in /sextant:tranche-status.
const ATTN_CAP = 3;
const ATTN_CLIP = 100;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);

// renderAttention: compact "needs attention this turn" lines from the active
// tranche's current-phase open unknowns + relevant open carry-forward concerns.
// extras: { unknowns?: { label, items: string[] }, concerns?: [{ id, text, target }] }
function renderAttention(active, extras) {
  const lines = [];
  const unknowns = extras && extras.unknowns;
  if (unknowns && Array.isArray(unknowns.items) && unknowns.items.length > 0) {
    const { label, items } = unknowns;
    lines.push(`Open questions ${label} (${items.length}) — resolve before ${label === 'before ship' ? 'shipping (or escalate to a concern)' : 'READY'}:`);
    for (const q of items.slice(0, ATTN_CAP)) lines.push(`  - ${clip(q, ATTN_CLIP)}`);
    if (items.length > ATTN_CAP) lines.push(`  …+${items.length - ATTN_CAP} more (/sextant:tranche-status)`);
  }
  const concerns = (extras && Array.isArray(extras.concerns)) ? extras.concerns : [];
  if (concerns.length > 0) {
    lines.push(`Open carry-forward concerns for this tranche (${concerns.length}) — consume or resolve:`);
    for (const c of concerns.slice(0, ATTN_CAP)) lines.push(`  - #${c.id}: ${clip(c.text, ATTN_CLIP)}`);
    if (concerns.length > ATTN_CAP) lines.push(`  …+${concerns.length - ATTN_CAP} more (/sextant:tranche-status)`);
  }
  return lines;
}

export function composeTrancheNudge(trancheState, deliverablesSummary, extras = {}) {
  const active = activeTranche(trancheState);
  if (!active) return null;

  const delivers = deliverablesSummary
    ? `Delivers: ${deliverablesSummary}\n`
    : '';
  const scope = (active.scope && active.scope.length > 0)
    ? `Scope: ${active.scope.join(', ')}\n`
    : '';
  const docPath = active.doc_path
    ? `Tranche doc: ${active.doc_path} (Read for full spec)\n`
    : '';

  const body = [
    `Active: T${active.id} "${active.title}" — ${active.status} | Feature: ${trancheState.feature}`,
    delivers + scope + docPath
      + `Charter: ${trancheState.charter_path ? 'FROZEN' : 'n/a'} | Spec: ${trancheState.spec_path ? 'living — log amendments' : 'n/a'}`,
    ...renderAttention(active, extras),
    'Stay within scope. Capture learnings via /sextant:remember. Log bugs via /sextant:bug-log.',
    'If scope changes needed: /sextant:tranche-amend. When done: /sextant:tranche-advance.',
  ].join('\n');

  return `${NUDGE_OPEN}\n${body}\n${NUDGE_CLOSE}`;
}

export function composeTrancheSessionBlock(trancheState, trancheDocParsed) {
  const active = activeTranche(trancheState);
  if (!active) return null;

  const lines = [
    '## Active tranche',
    `Feature: ${trancheState.feature} | Workflow: ${trancheState.workflow_state}`,
    `Charter: ${trancheState.charter_path} (FROZEN — do not edit)`,
    `Spec: ${trancheState.spec_path} (living — amendments must be logged)`,
    '',
    'Tranche status:',
  ];

  for (const t of trancheState.tranches) {
    const marker = t.id === active.id ? ' (active)' : '';
    const shipped = t.shipped_at ? ` (${t.shipped_at.slice(0, 10)})` : '';
    const depends = t.depends_on?.length ? ` (depends on T${t.depends_on.join(', T')})` : '';
    lines.push(`  T${t.id} "${t.title}" — ${t.status}${shipped}${depends}${marker}`);
  }

  if (trancheDocParsed) {
    lines.push('');
    if (trancheDocParsed.deliverables_summary.length > 0) {
      const docName = active.doc_path ? active.doc_path.split('/').pop() : 'tranche doc';
      lines.push(`T${active.id} deliverables (from ${docName}):`);
      for (const d of trancheDocParsed.deliverables_summary) {
        lines.push(`  ${d}`);
      }
    }
    lines.push(`T${active.id} verification gates: ${trancheDocParsed.verification_gates_done}/${trancheDocParsed.verification_gates_total} checked`);
  }

  if (active.doc_path) {
    lines.push(`T${active.id} tranche doc: ${active.doc_path}`);
  }
  lines.push(`Active scope (T${active.id}): ${(active.scope || []).join(', ') || '(none)'}`);
  if (!active.checklist_complete && (active.status === 'STUB' || active.status === 'READY')) {
    lines.push('Pre-implementation checklist: NOT COMPLETE');
  } else if (active.checklist_complete) {
    lines.push('Pre-implementation checklist: COMPLETE');
  }

  lines.push('');
  lines.push('Commands: /sextant:tranche-status, /sextant:tranche-advance, /sextant:tranche-amend');
  lines.push('Capture learnings: /sextant:remember | Log bugs: /sextant:bug-log');

  return lines.join('\n');
}

export function composeTrancheRestoreSection(payload) {
  if (!payload || !payload.tranche || !payload.tranche.active_id) return null;

  const t = payload.tranche;
  const lines = [
    '### Active tranche',
    `Feature: ${t.feature || '(unnamed)'} | T${t.active_id} — ${t.status || 'UNKNOWN'}`,
  ];
  if (Array.isArray(t.scope) && t.scope.length > 0) {
    lines.push(`Scope: ${t.scope.slice(0, 8).join(', ')}`);
  }
  lines.push('Charter: FROZEN | Spec: living — log amendments');
  lines.push('Capture learnings before ending turns.');

  return lines.join('\n');
}

export function composeStopCapturePrompt(trancheState, trancheDocParsed) {
  const active = activeTranche(trancheState);
  if (!active) return null;

  const scopeExamples = (active.scope || []).slice(0, 2);
  const nodeExamples = scopeExamples.map(s => `[node:${s}]`).join(' or ');

  const lines = [
    `Sextant: Tranche T${active.id} "${active.title}" is IN-FLIGHT. Before this turn ends, capture any learnings:`,
    '',
    '- Gotchas, workarounds, or non-obvious behavior discovered during implementation:',
    `  → /sextant:remember with appropriate tags:`,
  ];
  if (nodeExamples) {
    lines.push(`    ${nodeExamples} for file-scoped learnings`);
  }
  lines.push(
    '    [kw:*decisive, corroborating] keyword-scoped — mark the decisive token',
    '      with * so it fires alone every turn; plain words need several present',
    '      to fire (and are throttled). Avoid generic words (todo/test/env).',
    '    [!global] for project-wide rules',
  );

  if (trancheDocParsed) {
    const amendments = trancheDocParsed.sections?.['spec amendments discovered'] || '';
    if (!amendments || amendments.includes('(none yet)') || amendments.trim().length < 10) {
      lines.push('');
      lines.push('- Did you discover anything that changes the spec? Log it in the tranche doc\'s "Spec amendments discovered" section.');
    }
  }

  lines.push(
    '',
    '- Bugs found and fixed (or found and deferred):',
    '  → /sextant:bug-log',
    '',
    '- Nothing to capture this turn:',
    '  → Reply "no captures needed"',
  );

  return lines.join('\n');
}
