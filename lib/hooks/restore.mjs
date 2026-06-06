// lib/hooks/restore.mjs — Phase 2.5 § 5.15.b shared helpers for the
// post-compact restoration block.
//
// Two callers, one rendering:
//   - UserPromptSubmit (preferred): reads pending_restore, emits the
//     restoration block as additionalContext, clears the flag.
//   - PreToolUse Read (fallback): same logic, but concatenates the
//     restoration block ahead of the per-Read block.
//
// Both share buildRestorationBlock + consumePendingRestore so the
// behaviour matches up to byte-equality except for which marker is
// emitted ahead of which. The composer's own 10K cap is independent
// of ours: this module enforces RESTORE_MAX_CHARS on its own block
// (a sub-budget of the 10K composer cap) so the per-Read injection
// has headroom for its priority-1..6 sections.
//
// Phase 9 (§ 8 Phase 9): three new sections — files / bugs / commits —
// surface between the (existing) rules section and the (new) commits
// section. Render order, top to bottom (bottom drops on truncation):
//
//   1. todos          (Phase 2.5 — top — most recent intent)
//   2. rules          (Phase 2.5)
//   3. files          (Phase 9 — NEW)
//   4. bugs           (Phase 9 — NEW)
//   5. commits        (Phase 9 — NEW — bottom)
//
// Truncation order (bottom-up): commits → bugs → files → oldest rules →
// todos (todos at the top, never dropped first).

import fs from 'node:fs/promises';

import { readJson, readModifyJson, writeJsonAtomic } from '../io.mjs';
import { runtimeFile, turnStatePath } from '../paths.mjs';

export const RESTORE_OPEN_MARKER = '<!-- sextant:post-compact-restore -->';
export const RESTORE_CLOSE_MARKER = '<!-- /sextant:post-compact-restore -->';

// Total character cap for the restoration block. The composer-level cap
// is 10K characters; we reserve 4K for the rules+todos block so the per-Read
// content has at least ~6K to play with.
//
// The task spec says "Cap at 10K characters total". Per the task, we use 10K
// as the *block* budget (single section). The composer's separate per-Read
// block is invoked at PreToolUse time and uses its own cap.
export const RESTORE_MAX_CHARS = 10_000;

const TRUNCATION_MARKER = '<!-- sextant:restore truncated (dropped: %DROPPED%) -->';

// Build the restoration block from precompact.json's payload. Pure: no IO.
//
// payload = {
//   rules:   [{ ts, body, source_file, bucket }],
//   todos:   [{ content, status, ... }] | null,
//   files:   [{ path, ts, kind }],         // Phase 9
//   bugs:    [{ id, file, error_message, ... }],  // Phase 9
//   commits: [{ ts, edit_count, file_paths }],     // Phase 9
//   tranche: { feature, active_id, status, workflow_state, scope, ... } | null,
// }
//
// Render order (top to bottom — bottom drops on truncation):
//   0. ### Active tranche       (Tranches — top — dropped last)
//   1. ### Open todos           (Phase 2.5)
//   2. ### Rules fired this session
//   3. ### Recent files (top 5)
//   4. ### Open bugs (this session)
//   5. ### Recent commits (last 3)
//
// Truncation strategy: drop bottom-up — commits, bugs, files, oldest rules
// (head of list — rules array is sorted newest-first when written), then
// finally todos. Append a truncation marker noting what was dropped.
//
// Returns a string. If everything is empty (no rules, no todos, no files,
// no bugs, no commits), returns a minimal placeholder.
export function buildRestorationBlock(payload) {
  const rules = Array.isArray(payload && payload.rules) ? payload.rules : [];
  const todos = Array.isArray(payload && payload.todos) ? payload.todos : null;
  const files = Array.isArray(payload && payload.files) ? payload.files : [];
  const bugs = Array.isArray(payload && payload.bugs) ? payload.bugs : [];
  const commits = Array.isArray(payload && payload.commits) ? payload.commits : [];
  const tranche = (payload && payload.tranche && typeof payload.tranche === 'object') ? payload.tranche : null;
  const cap = RESTORE_MAX_CHARS;

  // Tag what was kept / dropped for the truncation marker.
  const droppedKinds = [];

  // -- Tranche section (priority 0: absolute top, dropped last) ------------
  const trancheLines = [];
  if (tranche) {
    const feature = tranche.feature || '(unknown)';
    const id = tranche.active_id || '?';
    const status = tranche.status || '?';
    trancheLines.push(`Feature: ${feature} | T${id} — ${status}`);
    if (Array.isArray(tranche.scope) && tranche.scope.length > 0) {
      trancheLines.push(`Scope: ${tranche.scope.join(', ')}`);
    }
    if (tranche.charter_path) {
      trancheLines.push(`Charter: FROZEN | Spec: living — log amendments`);
    }
    trancheLines.push('Capture learnings before ending turns.');
  }

  // -- Todos section (priority 1: top, never dropped first) ----------------
  const todoLines = [];
  if (Array.isArray(todos) && todos.length > 0) {
    for (const t of todos) {
      const content = (t && typeof t.content === 'string' && t.content.length > 0) ? t.content : '(empty)';
      const status = (t && typeof t.status === 'string' && t.status.length > 0) ? t.status : 'pending';
      todoLines.push(`- [${status}] ${content}`);
    }
  }

  // -- Rules section (priority 2) ------------------------------------------
  const ruleLines = [];
  for (const r of rules) {
    const body = (r && typeof r.body === 'string' && r.body.length > 0) ? r.body : '(empty)';
    const source = (r && typeof r.source_file === 'string' && r.source_file.length > 0) ? r.source_file : null;
    const line = source ? `- ${body} (from ${source})` : `- ${body}`;
    ruleLines.push(line);
  }

  // -- Files section (priority 3) ------------------------------------------
  const fileLines = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const p = typeof f.path === 'string' ? f.path : '(unknown)';
    const ts = typeof f.ts === 'string' ? f.ts : null;
    const kind = typeof f.kind === 'string' ? f.kind : null;
    const rel = ts ? relativeTimeShort(ts) : null;
    const parts = [];
    if (rel) parts.push(rel);
    if (kind) parts.push(kind);
    fileLines.push(parts.length > 0 ? `- ${p} (${parts.join(', ')})` : `- ${p}`);
  }

  // -- Bugs section (priority 4) -------------------------------------------
  const bugLines = [];
  for (const b of bugs) {
    if (!b || typeof b !== 'object') continue;
    const id = typeof b.id === 'string' ? b.id : '(no-id)';
    const file = typeof b.file === 'string' ? b.file : '(no-file)';
    const err = typeof b.error_message === 'string' ? b.error_message : '';
    bugLines.push(`- ${id} [${file}] ${err}`);
  }

  // -- Commits section (priority 5: bottom, dropped first) -----------------
  const commitLines = [];
  for (const c of commits) {
    if (!c || typeof c !== 'object') continue;
    const ts = typeof c.ts === 'string' ? c.ts : '(no-ts)';
    const editCount = typeof c.edit_count === 'number' ? c.edit_count : 0;
    const filePaths = Array.isArray(c.file_paths) ? c.file_paths : [];
    commitLines.push(`- ${ts}: ${editCount} edits across ${filePaths.length} files`);
  }

  // Empty-state placeholder.
  if (
    trancheLines.length === 0 &&
    ruleLines.length === 0 &&
    todoLines.length === 0 &&
    fileLines.length === 0 &&
    bugLines.length === 0 &&
    commitLines.length === 0
  ) {
    return [
      RESTORE_OPEN_MARKER,
      '## Restored from pre-compaction snapshot',
      '(no captured state to restore)',
      RESTORE_CLOSE_MARKER,
    ].join('\n');
  }

  // Build the ordered section list. Order matters for truncation — top
  // sections are preserved, bottom sections drop first.
  // Render order is: todos, rules, files, bugs, commits.
  // Truncation order is reverse: commits → bugs → files → rules-from-tail → todos.
  const sections = [];
  if (trancheLines.length > 0) sections.push({ kind: 'tranche', header: '### Active tranche', body: trancheLines });
  if (todoLines.length > 0) sections.push({ kind: 'todos', header: '### Open todos', body: todoLines });
  if (ruleLines.length > 0) sections.push({ kind: 'rules', header: '### Rules fired this session', body: ruleLines });
  if (fileLines.length > 0) sections.push({ kind: 'files', header: '### Recent files (top 5)', body: fileLines });
  if (bugLines.length > 0) sections.push({ kind: 'bugs', header: '### Open bugs (this session)', body: bugLines });
  if (commitLines.length > 0) sections.push({ kind: 'commits', header: '### Recent commits (last 3)', body: commitLines });

  // Try at full capacity first.
  // R13: action imperative for Opus 4.7.
  const RESTORE_IMPERATIVE = 'Resume following every rule below for the remainder of this session. Continue any open todos.';

  function render(sectionList) {
    const out = [RESTORE_OPEN_MARKER, '## Restored from pre-compaction snapshot', RESTORE_IMPERATIVE];
    for (const sec of sectionList) {
      out.push(sec.header);
      for (const ln of sec.body) out.push(ln);
    }
    out.push(RESTORE_CLOSE_MARKER);
    return out.join('\n');
  }

  function withTruncationMarker(sectionList, dropped) {
    const out = [RESTORE_OPEN_MARKER, '## Restored from pre-compaction snapshot', RESTORE_IMPERATIVE];
    for (const sec of sectionList) {
      out.push(sec.header);
      for (const ln of sec.body) out.push(ln);
    }
    const marker = TRUNCATION_MARKER.replace('%DROPPED%', dropped.join(', '));
    out.push(marker);
    out.push(RESTORE_CLOSE_MARKER);
    return out.join('\n');
  }

  let rendered = render(sections);
  if (rendered.length <= cap) return rendered;

  // Over cap. Drop bottom-up: commits → bugs → files → oldest rules → todos.
  // We mutate `sections` by removing the trailing section(s).
  const dropOrder = ['commits', 'bugs', 'files'];
  let workSections = sections.slice();
  for (const kind of dropOrder) {
    const idx = workSections.findIndex((s) => s.kind === kind);
    if (idx === -1) continue;
    workSections.splice(idx, 1);
    droppedKinds.push(kind);
    rendered = withTruncationMarker(workSections, droppedKinds);
    if (rendered.length <= cap) return rendered;
  }

  // Step: drop oldest rule lines until it fits. ruleLines is in order
  // matching precompact.json's payload.rules — newest-first per PreCompact's
  // contract. Pop from the tail (oldest).
  const rulesSec = workSections.find((s) => s.kind === 'rules');
  if (rulesSec) {
    while (rulesSec.body.length > 0) {
      rulesSec.body.pop();
      const sectionsForRender = rulesSec.body.length > 0
        ? workSections
        : workSections.filter((s) => s.kind !== 'rules');
      rendered = withTruncationMarker(
        sectionsForRender,
        rulesSec.body.length > 0 ? droppedKinds.concat(['oldest-rules']) : droppedKinds.concat(['rules']),
      );
      if (rendered.length <= cap) return rendered;
    }
    // Remove the rules section entirely once empty.
    workSections = workSections.filter((s) => s.kind !== 'rules');
    if (!droppedKinds.includes('rules')) droppedKinds.push('rules');
  }

  // Drop todos (second-to-last priority).
  const todosSec = workSections.find((s) => s.kind === 'todos');
  if (todosSec) {
    workSections = workSections.filter((s) => s.kind !== 'todos');
    droppedKinds.push('todos');
    rendered = withTruncationMarker(workSections, droppedKinds);
    if (rendered.length <= cap) return rendered;
  }

  // Finally, drop tranche (highest priority — last to go).
  const trancheSec = workSections.find((s) => s.kind === 'tranche');
  if (trancheSec) {
    workSections = workSections.filter((s) => s.kind !== 'tranche');
    droppedKinds.push('tranche');
    rendered = withTruncationMarker(workSections, droppedKinds);
    if (rendered.length <= cap) return rendered;
  }

  // Pathological: even a header + close marker exceeds cap.
  return [RESTORE_OPEN_MARKER, TRUNCATION_MARKER.replace('%DROPPED%', 'everything'), RESTORE_CLOSE_MARKER].join('\n');
}

// Compact relative-time helper for the files section. Returns short strings
// like "5s ago", "3m ago", "2h ago", "4d ago". Falls back to the ISO ts
// itself if parsing fails. Phase 9 keeps this private to restore.mjs because
// the existing composeSessionStart.relativeTime exports a longer ("5 seconds
// ago") form that bloats the per-section budget.
function relativeTimeShort(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaMs = Date.now() - t;
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// Read precompact.json + pending_restore. If pending_restore is true and
// precompact.json exists, return its parsed contents; otherwise return null.
//
// Side-effect-free read.
export async function readPrecompactSnapshot(sid, cwd) {
  const ts = await readJson(turnStatePath(sid, cwd));
  if (!ts || ts.pending_restore !== true) return null;
  const snapshot = await readJson(runtimeFile(sid, 'precompact.json', cwd));
  if (!snapshot || typeof snapshot !== 'object') return null;
  return snapshot;
}

// Clear pending_restore (set false) + rotate precompact.json to
// precompact-<ts>.json for diagnostics. Idempotent.
//
// Also clears mandatory_globals_digest so the next PreToolUse Bash/Read
// re-emits the full [!global] rule set, and kw_general_last_turn so the next
// general-triggered [kw:] fire isn't throttled. precompact.json does NOT carry
// globals or kw rules, so post-compact the agent may have lost them from its
// context window; forcing a fresh emit is the safety net documented in
// lib/hooks/mandatoryGlobals.mjs and lib/hooks/keywordDedup.mjs.
export async function clearPendingRestore(sid, snapshotTs, cwd) {
  await readModifyJson(turnStatePath(sid, cwd), (o) => {
    o.pending_restore = false;
    delete o.mandatory_globals_digest;
    delete o.kw_general_last_turn;
  });
  // Rotate precompact.json → precompact-<ts>.json. Use the snapshot's own ts
  // if present (so multiple compactions in one session don't collide on the
  // rotated filename).
  const src = runtimeFile(sid, 'precompact.json', cwd);
  const safeTs = typeof snapshotTs === 'string' && snapshotTs.length > 0
    ? snapshotTs.replace(/[^0-9A-Za-z._-]/g, '_')
    : new Date().toISOString().replace(/[^0-9A-Za-z._-]/g, '_');
  const dst = runtimeFile(sid, `precompact-${safeTs}.json`, cwd);
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`sextant: clearPendingRestore rename err=${err.message}\n`);
    }
  }
}
