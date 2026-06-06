// lib/hooks/preCompact.mjs — PreCompact handler.
//
// Phase 0 substrate (per R12): we own the file layout for the compaction
// snapshot.
//
// Phase 2.5 (§ 5.11 + § 8 Phase 2.5) fills it in:
//   - Read rules-fired.jsonl tail; group by source_file; take up to 50 most
//     recent unique entries; serialise into payload.rules (newest first).
//   - Stream transcript_path JSONL backwards; find the most recent message
//     containing a TodoWrite tool_use; extract input.todos array into
//     payload.todos. If none found, todos = null.
//   - Compose precompact.json with schema_version, compaction_n (the bumped
//     value from statusline state), ts, payload.
//   - Set turn-state.json#pending_restore=true + compaction_n (read-modify
//     preserves other keys per Phase 2's contract).
//   - Emit a one-shot systemMessage "Sextant: snapshot saved (<N> rules,
//     <M> todos)" with suppression key precompact_<n>.
//
// Phase 9 (§ 8 Phase 9) enrichment — three new sections in payload:
//   - files: read runtime/edits.json (Phase 5's append-only tracker). Take
//     the 5 most-recent unique paths (newest first by ts). Shape:
//     [{ path, ts, kind }, ...]
//   - bugs:  read .sextant/bugs.json; filter to entries where
//     session_id === payload.session_id && !fix_verified. All open entries
//     (typically <10 per session).
//   - commits: list .sextant/session/<sid>/commits/*.json, sort mtime desc,
//     take 3. Each summarized as
//     { ts, edit_count, file_paths: [unique paths, capped at 5] }.
//
// Files written:
//   runtime/precompact.json   — { schema_version, compaction_n, ts, payload }
//   runtime/turn-state.json   — pending_restore + snapshot_ts + compaction_n
//
// statusline-state.json gets its compaction counters bumped via withState
// (under the state.mjs lock).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { withState } from '../state.mjs';
import { mergeSystemMessage } from './systemMessage.mjs';
import { runtimeFile, rulesFiredPath, editsPath, durableBase } from '../paths.mjs';
import { writeJsonAtomic, readModifyJson, readJson } from './fileio.mjs';
import { readBugs } from '../stores/bugs.mjs';
import { commitsDir } from '../capture/commit-snapshot.mjs';
import { readTranches, activeTranche } from '../stores/tranches.mjs';

// Max rules to include in payload.rules. Newest-first.
const MAX_RULES = 50;

// Phase 9: Cap on payload.files. Take 5 most-recent unique paths newest-first.
const MAX_FILES = 5;

// Phase 9: Cap on payload.commits. Take 3 most-recent by mtime.
const MAX_COMMITS = 3;

// Phase 9: Cap on file_paths array inside each commit summary.
const MAX_COMMIT_FILE_PATHS = 5;

// Phase 2.5: read rules-fired.jsonl, parse each line, return all entries
// (oldest-first as they were appended). Best-effort: any IO error → [].
async function readRulesFired(sid, cwd) {
  let raw;
  try {
    raw = await fs.readFile(rulesFiredPath(sid, cwd), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // Skip malformed lines — they shouldn't happen but defensive parsing
      // is cheap.
    }
  }
  return out;
}

// Trim rules-fired entries to the most recent MAX_RULES, newest first.
// Dedup by (body, source_file) so a rule that fires twice on the same file
// only takes one slot. Newest fires win the slot.
function selectRulesForSnapshot(entries) {
  // Walk backwards (newest at the tail), keeping first occurrence of each
  // unique (body, source_file) key. Stop at MAX_RULES.
  const seen = new Set();
  const picked = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const body = (e && typeof e.body === 'string') ? e.body : '';
    const src = (e && typeof e.source_file === 'string') ? e.source_file : '';
    const key = `${body}${src}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(e);
    if (picked.length >= MAX_RULES) break;
  }
  return picked;
}

// NOTE on the transcript-flush race (bug-7 family): the third transcript reader
// in the codebase (alongside stop.mjs and captureNudge.mjs), but it does NOT
// need stop's pollUntil guard. That race is acute only when reading a line
// written microseconds ago — stop races the just-emitted ack, captureNudge the
// just-emitted final message. preCompact reads HISTORICAL TodoWrite entries
// (tool_use blocks flushed mid-turn, long before compaction fires), so there is
// no flush gap to lose. And the only transcript-derived field is `todos`:
// payload.rules comes from rules-fired.jsonl (readRulesFired, not the
// transcript), so a missed entry degrades to a slightly-stale todo list — never
// lost rules. Polling here would tax every compaction for no real coverage.
//
// Stream the transcript JSONL line by line and return the most recent
// `input.todos` array from any TodoWrite tool_use. Defensive parsing: we
// adapt to whatever Claude Code emits. Each line of the transcript may be:
//
//   { "type": "user"|"assistant", "message": { "content": [...] }, ... }
//
// where content[].type === "tool_use" and content[].name === "TodoWrite";
// the todos live at content[].input.todos.
//
// Some Claude Code variants embed tool_use directly under the top-level
// (e.g., { "type": "tool_use", "tool_use": { "name": ..., "input": ... } }),
// so we also probe entry.tool_use.{name,input}.
async function extractTodosFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
  // Existence check up front so a missing file falls through fast.
  try {
    await fs.access(transcriptPath);
  } catch {
    return null;
  }

  // Walk the file with a stream. We collect candidate todos as we go,
  // returning the LAST one found (newest). The file is JSONL, so a stream
  // read is fine even for multi-MB transcripts.
  let lastTodos = null;
  const stream = fsSync.createReadStream(transcriptPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const todos = extractTodosFromEntry(parsed);
      if (todos !== null) lastTodos = todos;
    }
  } finally {
    rl.close();
    stream.close();
  }
  return lastTodos;
}

// Pull todos from a single transcript entry, if it represents a TodoWrite
// tool_use. Returns the todos array or null.
function extractTodosFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  // Variant 1: entry.message.content is an array of content blocks.
  if (entry.message && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      const t = extractTodosFromContentBlock(block);
      if (t !== null) return t;
    }
  }
  // Variant 2: entry.content is an array of content blocks (older format).
  if (Array.isArray(entry.content)) {
    for (const block of entry.content) {
      const t = extractTodosFromContentBlock(block);
      if (t !== null) return t;
    }
  }
  // Variant 3: entry.tool_use directly.
  if (entry.tool_use && typeof entry.tool_use === 'object') {
    const t = extractTodosFromContentBlock({
      type: 'tool_use',
      name: entry.tool_use.name,
      input: entry.tool_use.input,
    });
    if (t !== null) return t;
  }
  // Variant 4: entry itself is a tool_use block.
  return extractTodosFromContentBlock(entry);
}

function extractTodosFromContentBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type !== 'tool_use') return null;
  if (block.name !== 'TodoWrite') return null;
  if (!block.input || typeof block.input !== 'object') return null;
  if (!Array.isArray(block.input.todos)) return null;
  return block.input.todos;
}

// Phase 9: read runtime/edits.json and select the MAX_FILES most-recent
// unique paths, newest-first by ts. ENOENT / malformed JSON → []. Each entry
// preserves { path, ts, kind }.
async function selectRecentFiles(sid, cwd) {
  const raw = await readJson(editsPath(sid, cwd));
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Walk backwards (tail = newest), dedup by path, stop at MAX_FILES.
  const seen = new Set();
  const out = [];
  for (let i = raw.length - 1; i >= 0; i--) {
    const e = raw[i];
    if (!e || typeof e !== 'object') continue;
    const p = typeof e.path === 'string' ? e.path : null;
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({
      path: p,
      ts: typeof e.ts === 'string' ? e.ts : null,
      kind: typeof e.kind === 'string' ? e.kind : null,
    });
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// Phase 9: read .sextant/bugs.json and filter to entries owned by `sid`
// (matching session_id) and !fix_verified. Best-effort: any IO error → [].
async function selectOpenBugs(cwd, sid) {
  if (typeof cwd !== 'string' || cwd.length === 0) return [];
  let bugs;
  try {
    bugs = await readBugs(durableBase(cwd));
  } catch {
    return [];
  }
  if (!Array.isArray(bugs)) return [];
  const out = [];
  for (const b of bugs) {
    if (!b || typeof b !== 'object') continue;
    if (b.fix_verified) continue;
    if (b.session_id !== sid) continue;
    out.push(b);
  }
  return out;
}

// Phase 9: list .sextant/session/<sid>/commits/*.json, sort mtime desc,
// take MAX_COMMITS, summarise each. Best-effort: any IO error → [].
async function selectRecentCommits(cwd, sid) {
  if (typeof cwd !== 'string' || cwd.length === 0) return [];
  const dir = commitsDir(cwd, sid);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    return [];
  }
  const jsonFiles = entries.filter((n) => n.endsWith('.json'));
  if (jsonFiles.length === 0) return [];

  // Stat each so we can sort by mtime desc.
  const stated = [];
  for (const name of jsonFiles) {
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      stated.push({ full, mtimeMs: st.mtimeMs });
    } catch {
      // skip missing files (could race with a snapshot in-flight)
    }
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = stated.slice(0, MAX_COMMITS);

  const out = [];
  for (const { full } of top) {
    let parsed;
    try {
      parsed = await readJson(full);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const edits = Array.isArray(parsed.edits) ? parsed.edits : [];
    // Unique paths order-preserving, capped at MAX_COMMIT_FILE_PATHS.
    const seen = new Set();
    const filePaths = [];
    for (const e of edits) {
      if (!e || typeof e !== 'object') continue;
      const p = typeof e.path === 'string' ? e.path : null;
      if (!p || seen.has(p)) continue;
      seen.add(p);
      filePaths.push(p);
      if (filePaths.length >= MAX_COMMIT_FILE_PATHS) break;
    }
    out.push({
      ts: typeof parsed.ts === 'string' ? parsed.ts : null,
      edit_count: edits.length,
      file_paths: filePaths,
    });
  }
  return out;
}

export default async function preCompact(payload, ctx) {
  const sid = payload.session_id;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const ts = ctx.nowIso();

  await ctx.log({ ts, event: 'PreCompact', sid });

  // Bump compaction counters + record snapshot timestamp.
  const state = await withState(sid, cwd, (s) => {
    s.compaction.compaction_n += 1;
    s.compaction.last_snapshot_ts = ts;
    s.last_event = { tag: 'PreCompact', ts, detail: 'compacting' };
  });

  const compactionN = (state && state.compaction) ? state.compaction.compaction_n : 0;

  // Phase 2.5: gather rules from rules-fired.jsonl, todos from transcript.
  // Both reads are best-effort: any failure degrades to an empty payload
  // field rather than aborting the snapshot.
  let rules = [];
  try {
    const all = await readRulesFired(sid, cwd);
    rules = selectRulesForSnapshot(all);
  } catch (err) {
    process.stderr.write(`sextant: preCompact rules-fired read err=${err.message}\n`);
    rules = [];
  }

  let todos = null;
  try {
    todos = await extractTodosFromTranscript(payload.transcript_path);
  } catch (err) {
    process.stderr.write(`sextant: preCompact transcript read err=${err.message}\n`);
    todos = null;
  }

  // Phase 9: gather files, bugs, commits. Each best-effort: failures degrade
  // to an empty array rather than aborting the snapshot.
  let files = [];
  try {
    files = await selectRecentFiles(sid, cwd);
  } catch (err) {
    process.stderr.write(`sextant: preCompact files read err=${err.message}\n`);
    files = [];
  }

  let bugs = [];
  try {
    bugs = await selectOpenBugs(payload.cwd, sid);
  } catch (err) {
    process.stderr.write(`sextant: preCompact bugs read err=${err.message}\n`);
    bugs = [];
  }

  let commits = [];
  try {
    commits = await selectRecentCommits(payload.cwd, sid);
  } catch (err) {
    process.stderr.write(`sextant: preCompact commits read err=${err.message}\n`);
    commits = [];
  }

  let tranche = null;
  try {
    if (cwd) {
      const tState = await readTranches(cwd);
      const active = activeTranche(tState);
      if (active) {
        tranche = {
          feature: tState.feature,
          active_id: active.id,
          status: active.status,
          workflow_state: tState.workflow_state,
          scope: active.scope || [],
          checklist_complete: !!active.checklist_complete,
          charter_path: tState.charter_path,
          spec_path: tState.spec_path,
        };
      }
    }
  } catch (err) {
    process.stderr.write(`sextant: preCompact tranche read err=${err.message}\n`);
    tranche = null;
  }

  // Write the snapshot. Write-once per compaction; wholesale overwrite is
  // correct here.
  await writeJsonAtomic(runtimeFile(sid, 'precompact.json', cwd), {
    schema_version: 1,
    compaction_n: compactionN,
    ts,
    payload: { rules, todos, files, bugs, commits, tranche },
  });

  // Flag a restore as pending. PostCompact can't emit additionalContext (R7),
  // so the next UserPromptSubmit or PreToolUse will read this flag and
  // perform the restore. Read-modify-write preserves any other keys (e.g.,
  // dedup state) other phases may add.
  await readModifyJson(runtimeFile(sid, 'turn-state.json', cwd), (o) => {
    o.pending_restore = true;
    o.snapshot_ts = ts;
    if (state && state.compaction) {
      o.compaction_n = state.compaction.compaction_n;
    }
  });

  // Routine snapshot notice via the shared helper. NOTE: PreCompact's
  // systemMessage does NOT render in the CC UI (it only surfaces in /compact
  // debug output) — kept for single-path compliance, but effectively invisible.
  // Routine → verbose-only; no suppression key (inert for a routine line).
  const ruleCount = rules.length;
  const todoCount = Array.isArray(todos) ? todos.length : 0;
  return mergeSystemMessage(
    undefined,
    `snapshot saved (${ruleCount} rules, ${todoCount} todos)`,
    { category: 'transition', level: 'routine', sid, cwd },
  );
}
