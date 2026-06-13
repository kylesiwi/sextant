import path from 'node:path';
import fs from 'node:fs/promises';

import { readJson } from '../io.mjs';
import { withPathLock } from '../state.mjs';

const TRANCHES_FILENAME = 'tranches.json';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 2;

export const TRANCHES_SCHEMA_VERSION = 1;

const TRANCHE_STATUSES = ['STUB', 'READY', 'IN-FLIGHT', 'SHIPPED', 'ARCHIVED'];
const WORKFLOW_STATES = ['IDLE', 'PLANNING', 'DETAILING', 'IMPLEMENTING', 'VERIFYING', 'COMPLETING'];

export function defaultTranches() {
  return {
    schema_version: TRANCHES_SCHEMA_VERSION,
    feature: null,
    doc_root: null,
    charter_path: null,
    spec_path: null,
    active_tranche_id: null,
    workflow_state: 'IDLE',
    tranches: [],
    amendments: [],
    // carry_forward: feature-global unknowns/concerns that outlive the tranche
    // that raised them and must be consumed by a later tranche. The ONLY
    // cross-tranche unknown store (tranche-local unknowns live in the doc).
    // Hard-gated at finalize: no open concern may leave the feature.
    carry_forward: [],
    captures_this_session: { rules: 0, bugs: 0 },
    pending_amendment: false,
    last_updated: null,
  };
}

export function tranchesPath(durableBase) {
  return path.join(durableBase, TRANCHES_FILENAME);
}

export async function readTranches(cwd) {
  const file = tranchesPath(path.resolve(cwd, '.sextant'));
  const data = await readJson(file);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...defaultTranches(), ...data };
  }
  return defaultTranches();
}

export async function writeTranches(cwd, tranches) {
  const file = tranchesPath(path.resolve(cwd, '.sextant'));
  tranches.last_updated = new Date().toISOString();
  await withPathLock(
    file,
    () => tranches,
    { defaultValue: defaultTranches(), lockTimeoutMs: LOCK_TIMEOUT_MS, pollIntervalMs: LOCK_POLL_MS },
  );
  return tranches;
}

// mutateTranches(cwd, mutator): ATOMIC read-modify-write under the tranches.json
// lock. Unlike readTranches()+writeTranches() (which reads unlocked then clobbers
// on write, losing a concurrent writer's change), the mutator runs on the CURRENT
// on-disk value inside the lock — required for the amend-budget decrement, where
// two parallel edits must not both read `edits_remaining:2` and both write `1`.
export async function mutateTranches(cwd, mutator) {
  const file = tranchesPath(path.resolve(cwd, '.sextant'));
  return await withPathLock(
    file,
    (current) => {
      const state = (current && typeof current === 'object' && !Array.isArray(current))
        ? { ...defaultTranches(), ...current }
        : defaultTranches();
      mutator(state);
      state.last_updated = new Date().toISOString();
      return state;
    },
    { defaultValue: defaultTranches(), lockTimeoutMs: LOCK_TIMEOUT_MS, pollIntervalMs: LOCK_POLL_MS },
  );
}

// --- Tranche doc parser ---

const TRANCHE_DOC_SECTIONS = [
  'open questions before implementation',
  'locked deliverables',
  'floating details',
  'pre-implementation checklist',
  // In-flight unknowns: discovered during implementation, must be resolved OR
  // escalated to a carry-forward concern before SHIPPED (soft ship gate). Safe
  // beside "…before implementation" — neither name prefixes the other.
  'open questions before ship',
  'verification gates',
  'spec amendments discovered',
];

// extractDeliverablesSummary: pull the deliverable titles (### sub-headers under
// the "## Locked deliverables" H2) straight out of raw doc text. The markdown
// headers ARE the sentinels — we slice the one section we need instead of parsing
// the whole doc, so the per-turn nudge read stays cheap. Shared by readTrancheDoc
// (full parse) and readTrancheDeliverables (focused read) so the extraction rule
// has a single definition and the two can't drift.
export function extractDeliverablesSummary(content) {
  if (typeof content !== 'string' || content.length === 0) return [];
  // Locate "## Locked deliverables" (case-insensitive; startsWith semantics via
  // the trailing .* so a header like "## Locked deliverables (frozen)" matches).
  const start = /^##[ \t]+locked deliverables.*$/im.exec(content);
  if (!start) return [];
  const after = content.slice(start.index + start[0].length);
  // Section ends at the next H2 (`## `) or EOF. `^##[ \t]` won't match `### `
  // (third # is not whitespace), so sub-headers don't terminate the section.
  const nextH2 = /^##[ \t]+/m.exec(after);
  const body = nextH2 ? after.slice(0, nextH2.index) : after;
  const headers = body.match(/^###\s+(.+)/gm) || [];
  return headers.map(h => h.replace(/^###\s+/, '').trim());
}

// readTrancheDeliverables: cheap focused read of just the deliverables summary
// from a tranche doc, for the per-turn UserPromptSubmit nudge. Returns an array
// of titles (empty on missing file / missing section). Unlike readTrancheDoc it
// does no checkbox/section accounting — only the one slice the nudge needs.
export async function readTrancheDeliverables(cwd, docPath) {
  if (!cwd || !docPath) return [];
  const fullPath = path.resolve(cwd, docPath);
  let content;
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch {
    return [];
  }
  return extractDeliverablesSummary(content);
}

// extractUncheckedItems: the unchecked "- [ ]" item texts under a named "## <section>"
// H2, sliced straight from raw doc text (same cheap approach as
// extractDeliverablesSummary). Generic over section name so the per-turn nudge can
// surface either "open questions before implementation" (pre-flight) or "open
// questions before ship" (in-flight). Checked items and prose are ignored.
export function extractUncheckedItems(content, sectionName) {
  if (typeof content !== 'string' || content.length === 0) return [];
  if (typeof sectionName !== 'string' || sectionName.length === 0) return [];
  const esc = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^##[ \\t]+${esc}.*$`, 'im').exec(content);
  if (!start) return [];
  const after = content.slice(start.index + start[0].length);
  const nextH2 = /^##[ \t]+/m.exec(after);
  const body = nextH2 ? after.slice(0, nextH2.index) : after;
  const out = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*-\s*\[ \]\s+(.+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// readTrancheUnchecked: cheap focused read of the unchecked items of one named
// section from a tranche doc, for the per-turn nudge. Empty on missing file/args.
export async function readTrancheUnchecked(cwd, docPath, sectionName) {
  if (!cwd || !docPath) return [];
  const fullPath = path.resolve(cwd, docPath);
  let content;
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch {
    return [];
  }
  return extractUncheckedItems(content, sectionName);
}

export async function readTrancheDoc(cwd, docPath) {
  const fullPath = path.resolve(cwd, docPath);
  let content;
  try {
    content = await fs.readFile(fullPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  const result = {
    raw: content,
    status: null,
    depends_on: null,
    delivers: null,
    sections: {},
    open_questions_count: 0,
    open_questions_before_ship_count: 0,
    checklist_total: 0,
    checklist_done: 0,
    verification_gates_total: 0,
    verification_gates_done: 0,
    deliverables_summary: [],
  };

  const lines = content.split('\n');

  for (const line of lines) {
    const statusMatch = line.match(/^\*\*Status\*\*:\s*(.+)/i);
    if (statusMatch) result.status = statusMatch[1].trim();

    const depsMatch = line.match(/^\*\*Depends on\*\*:\s*(.+)/i);
    if (depsMatch) result.depends_on = depsMatch[1].trim();

    const deliversMatch = line.match(/^\*\*Delivers\*\*:\s*(.+)/i);
    if (deliversMatch) result.delivers = deliversMatch[1].trim();
  }

  let currentSection = null;
  let sectionLines = [];

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/);
    if (headerMatch) {
      if (currentSection) {
        result.sections[currentSection] = sectionLines.join('\n').trim();
      }
      const normalized = headerMatch[1].trim().toLowerCase();
      const matched = TRANCHE_DOC_SECTIONS.find(s => normalized.startsWith(s));
      currentSection = matched || null;
      sectionLines = [];
      continue;
    }
    if (currentSection) {
      sectionLines.push(line);
    }
  }
  if (currentSection) {
    result.sections[currentSection] = sectionLines.join('\n').trim();
  }

  // Count open questions (unchecked checkboxes)
  const oqSection = result.sections['open questions before implementation'] || '';
  const oqUnchecked = (oqSection.match(/- \[ \]/g) || []).length;
  result.open_questions_count = oqUnchecked;

  // Count in-flight "open questions before ship" (unchecked) — mirrors
  // open_questions_count; the ship gate warns when this is > 0.
  const oqsSection = result.sections['open questions before ship'] || '';
  result.open_questions_before_ship_count = (oqsSection.match(/- \[ \]/g) || []).length;

  // Count checklist items
  const clSection = result.sections['pre-implementation checklist'] || '';
  result.checklist_total = (clSection.match(/- \[[ x]\]/g) || []).length;
  result.checklist_done = (clSection.match(/- \[x\]/gi) || []).length;

  // Count verification gates
  const vgSection = result.sections['verification gates'] || '';
  result.verification_gates_total = (vgSection.match(/- \[[ x]\]/g) || []).length;
  result.verification_gates_done = (vgSection.match(/- \[x\]/gi) || []).length;

  // Extract deliverables summary (### headings under locked deliverables) via
  // the shared slice-based extractor, so this and readTrancheDeliverables agree.
  result.deliverables_summary = extractDeliverablesSummary(content);

  return result;
}

// --- Pure mutators ---

export function startFeature(state, { feature, docRoot, charterPath, specPath, tranches }) {
  if (state.workflow_state !== 'IDLE') {
    throw new Error(`Cannot start feature: workflow is ${state.workflow_state}, must be IDLE`);
  }
  state.feature = feature;
  state.doc_root = docRoot;
  state.charter_path = charterPath;
  state.spec_path = specPath;
  state.workflow_state = 'PLANNING';
  state.tranches = tranches.map((t, i) => ({
    id: t.id || String(i + 1),
    title: t.title,
    doc_path: t.doc_path,
    status: i === 0 ? 'STUB' : 'STUB',
    scope: t.scope || [],
    checklist_complete: false,
    depends_on: t.depends_on || (i > 0 ? [String(i)] : []),
    started_at: null,
    shipped_at: null,
  }));
  state.active_tranche_id = state.tranches[0]?.id || null;
  state.amendments = [];
  state.carry_forward = [];
  state.captures_this_session = { rules: 0, bugs: 0 };
  state.pending_amendment = false;
}

export function advanceTranche(state, trancheId, targetStatus) {
  const tranche = state.tranches.find(t => t.id === trancheId);
  if (!tranche) throw new Error(`Tranche ${trancheId} not found`);

  const currentIdx = TRANCHE_STATUSES.indexOf(tranche.status);
  const targetIdx = TRANCHE_STATUSES.indexOf(targetStatus);
  if (targetIdx < 0) throw new Error(`Invalid status: ${targetStatus}`);
  if (targetIdx <= currentIdx) throw new Error(`Cannot move ${tranche.status} → ${targetStatus} (not forward)`);
  if (targetIdx > currentIdx + 1) throw new Error(`Cannot skip statuses: ${tranche.status} → ${targetStatus}`);

  if (targetStatus === 'READY') {
    for (const depId of (tranche.depends_on || [])) {
      const dep = state.tranches.find(t => t.id === depId);
      if (dep && TRANCHE_STATUSES.indexOf(dep.status) < TRANCHE_STATUSES.indexOf('SHIPPED')) {
        throw new Error(`Dependency T${depId} is ${dep.status}, must be SHIPPED or later`);
      }
    }
  }

  if (targetStatus === 'IN-FLIGHT' && !tranche.checklist_complete) {
    throw new Error('Pre-implementation checklist not complete');
  }

  tranche.status = targetStatus;
  const now = new Date().toISOString();

  if (targetStatus === 'IN-FLIGHT') {
    tranche.started_at = now;
    // The tranche entering implementation becomes the active one. This matters
    // for out-of-order/parallel work: without it, active_tranche_id could stay
    // pinned to another tranche, leaving activeTranche() — read by the deny gate
    // and ~8 hooks — pointed at the wrong tranche while this one is in flight.
    state.active_tranche_id = trancheId;
  }
  if (targetStatus === 'SHIPPED') tranche.shipped_at = now;

  updateWorkflowState(state);
}

// finalizeFeature: close out a finished feature and clear the tranche state
// machine back to IDLE. This is the terminal transition the lifecycle diagram
// promises (COMPLETING --> IDLE). Resetting to defaultTranches() drops feature,
// charter, and every tranche scope — which is what lifts all hook-enforced file
// restrictions, since the deny gate and the other tranche hooks all early-return
// once there is no active feature. Any constraint that must outlive the feature
// belongs in the cerebrum as a normal rule, NOT as a perdurable tranche lock.
//
// Requires workflow_state === 'COMPLETING' (i.e. all tranches terminal and
// `complete` has been run) unless { force: true } is passed to abandon a feature
// that is still mid-flight.
export function finalizeFeature(state, { force = false } = {}) {
  if (!state.feature) {
    throw new Error('No active feature to finalize');
  }
  if (!force && state.workflow_state !== 'COMPLETING') {
    throw new Error(
      `Cannot finalize: workflow is ${state.workflow_state}, must be COMPLETING. ` +
        'Ship all tranches and run "complete" first, or pass --force to abandon a mid-flight feature.',
    );
  }
  // The feature-level invariant: no open carry-forward concern may leave the
  // feature unresolved. This is the one HARD gate that makes carry-forward real
  // — surfacing/warnings elsewhere are soft. --force abandons them (loudly, in
  // the CLI).
  if (!force) {
    const open = openConcerns(state);
    if (open.length > 0) {
      const first = open[0];
      const preview = first.text.length > 60 ? first.text.slice(0, 59) + '…' : first.text;
      throw new Error(
        `Cannot finalize: ${open.length} open carry-forward concern(s) remain ` +
          `(e.g. #${first.id} "${preview}"). Resolve them via "concern resolve", ` +
          'or pass --force to abandon them.',
      );
    }
  }
  Object.assign(state, defaultTranches());
}

// recordConcern: append a feature-global carry-forward concern. Purely additive
// metadata — unlike recordAmendment it does NOT touch pending_amendment (a
// concern is not an edit, so it must not unlock a deny gate). Mints a monotonic
// string id (max existing numeric id + 1). Returns the created concern.
export function recordConcern(state, { text, target = null, ts } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Concern text required');
  }
  if (!Array.isArray(state.carry_forward)) state.carry_forward = [];
  const maxId = state.carry_forward.reduce((m, c) => {
    const n = Number(c && c.id);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const concern = {
    id: String(maxId + 1),
    text: text.trim(),
    raised_by: state.active_tranche_id || null,
    raised_at: ts || new Date().toISOString(),
    target: target || null,
    status: 'open',
    resolved_by: null,
    resolved_at: null,
    note: null,
  };
  state.carry_forward.push(concern);
  return concern;
}

// resolveConcern: mark a carry-forward concern resolved (attestation — the agent
// asserts it; the system does not verify the underlying work). Throws on unknown
// or already-resolved id. Returns the updated concern.
export function resolveConcern(state, { id, note = null, ts } = {}) {
  if (!Array.isArray(state.carry_forward)) state.carry_forward = [];
  const c = state.carry_forward.find((x) => x && x.id === id);
  if (!c) throw new Error(`Concern ${id} not found`);
  if (c.status === 'resolved') throw new Error(`Concern ${id} already resolved`);
  c.status = 'resolved';
  c.resolved_by = state.active_tranche_id || null;
  c.resolved_at = ts || new Date().toISOString();
  c.note = note || null;
  return c;
}

// openConcerns: the open (unresolved) carry-forward concerns, in raise order.
export function openConcerns(state) {
  return Array.isArray(state.carry_forward)
    ? state.carry_forward.filter((c) => c && c.status === 'open')
    : [];
}

export function setChecklistComplete(state, trancheId) {
  const tranche = state.tranches.find(t => t.id === trancheId);
  if (!tranche) throw new Error(`Tranche ${trancheId} not found`);
  tranche.checklist_complete = true;
}

export function recordAmendment(state, { trancheId, text, ts }) {
  state.amendments.push({
    ts: ts || new Date().toISOString(),
    tranche_id: trancheId || state.active_tranche_id,
    text,
  });
  state.pending_amendment = false;
}

// -----------------------------------------------------------------------------
// lean-interventions T4: the amend EDIT BUDGET. `pending_amendment` is now either
// `false` (frozen) or `{ files:string[]|null, edits_remaining:number,
// created_ts:string|null }`. A bare legacy `true` reads as one edit, any file.
// One logical amendment can now span several edits to the named files under one
// ceremony, bounded by an edit count + TTL. All failure modes fail toward
// RE-FREEZE (anchor #3): a lost/ambiguous signal leaves the budget MORE depleted,
// never more permissive.
// -----------------------------------------------------------------------------

export const AMENDMENT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// readAmendmentBudget(state): normalize pending_amendment → null | budget object.
export function readAmendmentBudget(state) {
  const pa = state && state.pending_amendment;
  if (!pa) return null;
  if (pa === true) return { files: null, edits_remaining: 1, created_ts: null }; // legacy one-shot
  if (typeof pa === 'object') {
    return {
      files: Array.isArray(pa.files) && pa.files.length > 0 ? pa.files : null,
      edits_remaining: Number.isFinite(pa.edits_remaining) ? pa.edits_remaining : 1,
      created_ts: typeof pa.created_ts === 'string' ? pa.created_ts : null,
    };
  }
  return null;
}

// amendmentExpired(budget, nowIso, ttlMs): TTL check. A null created_ts (legacy
// bare `true`) never expires — it's a one-shot consumed by the first edit anyway.
export function amendmentExpired(budget, nowIso, ttlMs = AMENDMENT_TTL_MS) {
  if (!budget || !budget.created_ts) return false;
  const created = Date.parse(budget.created_ts);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return false;
  return (now - created) > ttlMs;
}

// budgetCoversFile(budget, relPath): files===null means "any file" (only allowed
// for a 1-edit budget); otherwise the file must be in the named list.
export function budgetCoversFile(budget, relPath) {
  if (!budget) return false;
  if (budget.files === null) return true;
  return budget.files.includes(relPath);
}

// fileNeedsAmendment(state, relPath): does editing this file require an amendment
// (charter-frozen OR shipped-scope-protected, with the pending-scope exemption)?
// Returns { kind, reason } or null. THE single source of truth shared by the
// preToolUse gate (deny message + allow-via-budget) and the postToolUse decrement
// (so only edits that actually needed the unlock consume budget — no leak).
export function fileNeedsAmendment(state, relPath) {
  if (!state || !state.feature || state.workflow_state === 'IDLE') return null;
  if (state.charter_path && relPath === state.charter_path && state.workflow_state !== 'PLANNING') {
    return { kind: 'charter', reason: `${state.charter_path} is frozen (workflow is past PLANNING). Charter edits require an amendment. Run /sextant:tranche-amend first.` };
  }
  const tranches = Array.isArray(state.tranches) ? state.tranches : [];
  const pendingScope = new Set(
    tranches
      .filter((t) => t.status !== 'SHIPPED' && t.status !== 'ARCHIVED' && Array.isArray(t.scope))
      .flatMap((t) => t.scope),
  );
  if (!pendingScope.has(relPath)) {
    for (const t of tranches) {
      if (t.status !== 'SHIPPED' && t.status !== 'ARCHIVED') continue;
      if (Array.isArray(t.scope) && t.scope.includes(relPath)) {
        return { kind: 'shipped', reason: `${relPath} belongs to tranche T${t.id} "${t.title}" which is ${t.status}. Edits to shipped tranche files are blocked. Run /sextant:tranche-amend first.` };
      }
    }
  }
  return null;
}

// openAmendment(state, {files, edits, ts}): set the budget. files is the
// validated list (or null = any-file, only when edits===1). Caller (CLI) enforces
// the "--files required when edits>1" rule and stamps ts.
export function openAmendment(state, { files = null, edits = 1, ts = null } = {}) {
  const cleanFiles = Array.isArray(files) && files.length > 0 ? files : null;
  const cleanEdits = Number.isFinite(edits) && edits > 0 ? edits : 1;
  state.pending_amendment = {
    files: cleanFiles,
    edits_remaining: cleanEdits,
    created_ts: typeof ts === 'string' ? ts : null,
  };
}

// consumeAmendmentEdit(state, relPath, nowIso): on a successful edit to a file
// that NEEDED an amendment and is covered by an unexpired budget, decrement
// edits_remaining and re-freeze (pending_amendment=false) when it hits 0. An
// expired budget is cleared (re-freeze) without consuming. Mutates state; returns
// true if it consumed. Non-idempotent by design: a double-fire decrements twice,
// which fails toward re-freeze — the safe direction (anchor #3).
export function consumeAmendmentEdit(state, relPath, nowIso) {
  const budget = readAmendmentBudget(state);
  if (!budget) return false;
  if (amendmentExpired(budget, nowIso)) { state.pending_amendment = false; return false; }
  if (!fileNeedsAmendment(state, relPath)) return false; // edit didn't need the unlock → don't spend
  if (!budgetCoversFile(budget, relPath)) return false;
  const remaining = budget.edits_remaining - 1;
  state.pending_amendment = remaining <= 0
    ? false // re-freeze
    : { files: budget.files, edits_remaining: remaining, created_ts: budget.created_ts };
  return true;
}

export function recordCapture(state, type) {
  if (!state.captures_this_session) {
    state.captures_this_session = { rules: 0, bugs: 0 };
  }
  if (type === 'rule') state.captures_this_session.rules += 1;
  if (type === 'bug') state.captures_this_session.bugs += 1;
}

export function resetSessionCaptures(state) {
  state.captures_this_session = { rules: 0, bugs: 0 };
}

export function activeTranche(state) {
  if (!state.active_tranche_id) return null;
  return state.tranches.find(t => t.id === state.active_tranche_id) || null;
}

export function tranchesByStatus(state, status) {
  return state.tranches.filter(t => t.status === status);
}

function updateWorkflowState(state) {
  const active = activeTranche(state);
  if (!active) {
    state.workflow_state = 'IDLE';
    return;
  }

  const allStatuses = state.tranches.map(t => t.status);
  const allTerminal = allStatuses.every(s => s === 'SHIPPED' || s === 'ARCHIVED');

  if (allTerminal) {
    state.workflow_state = 'COMPLETING';
    return;
  }

  switch (active.status) {
    case 'STUB': state.workflow_state = 'DETAILING'; break;
    case 'READY': state.workflow_state = 'DETAILING'; break;
    case 'IN-FLIGHT': state.workflow_state = 'IMPLEMENTING'; break;
    case 'SHIPPED': {
      // Shipping a tranche completes it — move straight to the next pending
      // tranche. If none remain, the allTerminal check above has already
      // flipped us to COMPLETING.
      const next = state.tranches.find(t => t.status === 'STUB');
      if (next) {
        state.active_tranche_id = next.id;
        state.workflow_state = 'DETAILING';
      } else {
        state.workflow_state = 'COMPLETING';
      }
      break;
    }
    default: break;
  }
}
