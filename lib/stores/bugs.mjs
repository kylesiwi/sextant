// lib/stores/bugs.mjs — pure I/O + index helpers for .sextant/bugs.json
// (§ 6.3 of GROUND_UP_DESIGN.md).
//
// Bug entry shape (load-bearing — § 6.3):
//
//   {
//     "id": "bug-013",
//     "ts": "2026-05-10T14:33:00Z",
//     "session_id": "...",
//     "file": "src/api/auth.ts",
//     "graph_node": "validateToken",        // symbol-aware tag (Phase 3)
//     "graph_node_confidence": "symbol-match", // | "file-level"
//     "graph_community": 3,
//     "error_message": "TypeError: Cannot read properties of undefined",
//     "root_cause": "API response was null",
//     "fix": "Added optional chaining",
//     "fix_verified": true,
//     "verified_ts": "2026-05-10T14:35:00Z",
//     "verified_by": "test-pass",
//     "tags": ["null-check", "api-response"]
//   }
//
// `graph_node_confidence`:
//   - `symbol-match` — error_message or root_cause contains a unique symbol
//     name from the file's graph node. graph_node carries the symbol name.
//   - `file-level` — no symbol match. graph_node carries the file's relative
//     path so callers can still index by file.
//
// The store lives at `<durableBase>/bugs.json` — a flat array of entries,
// newest entries appended at the tail. Phase 3 keeps this dirt-simple; a
// future phase may sharded it if the count grows enough to hurt linear scans.

import path from 'node:path';

import { readJson } from '../io.mjs';
import { withPathLock } from '../state.mjs';
import { GRAPH, NODE } from '../graph/schema.mjs';

const BUGS_FILENAME = 'bugs.json';

// Durable-store lock timeout. Runtime state.json uses 50ms because hooks are
// on the critical path and an unrecoverable hang would block the user; for
// the durable bug store we prefer correctness — losing a bug write is far
// worse than a brief queue behind another writer. 5s comfortably absorbs
// dozens of concurrent addBug calls without false timeouts.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 2;

function bugsFilePath(durableBase) {
  return path.join(durableBase, BUGS_FILENAME);
}

/**
 * readBugs(durableBase): read bugs.json under durableBase. ENOENT → [].
 * Malformed JSON or non-array shape → [] (defensive; never crash a hook).
 */
export async function readBugs(durableBase) {
  const value = await readJson(bugsFilePath(durableBase));
  if (!Array.isArray(value)) return [];
  return value;
}

/**
 * writeBugs(durableBase, bugs): lock-coordinated atomic write. Routes
 * through withPathLock so a concurrent addBug or writeBugs from another
 * session can't interleave reads with our write. The mutator discards the
 * current on-disk value and returns the caller's array, so this is a true
 * overwrite — callers that want merge semantics should build the merged
 * array themselves and pass it in.
 */
export async function writeBugs(durableBase, bugs) {
  if (!Array.isArray(bugs)) throw new Error('writeBugs: bugs must be an array');
  await withPathLock(
    bugsFilePath(durableBase),
    () => bugs,
    { defaultValue: [], lockTimeoutMs: LOCK_TIMEOUT_MS, pollIntervalMs: LOCK_POLL_MS },
  );
}

// Highest existing bug-N suffix in an array. Non-conforming ids (anything not
// matching /^bug-(\d+)$/) are skipped but preserved in the underlying array;
// they just don't participate in the max calculation. Returns 0 when the
// array is empty or has no numeric ids, so the caller can use `max + 1`.
function maxBugIdSuffix(bugs) {
  let max = 0;
  for (const b of bugs) {
    if (!b || typeof b.id !== 'string') continue;
    const m = /^bug-(\d+)$/.exec(b.id);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * addBug(durableBase, entry): allocate id 'bug-<max(existing) + 1>', append,
 * write atomically, return the saved entry (with the allocated id).
 *
 * Critical correctness note: the old implementation used `bugs.length + 1`
 * which reused ids after a `/sextant:forget` removed an entry — old
 * transcript references then pointed at a totally different bug. We now
 * compute the max numeric suffix among existing ids and add 1, so an id is
 * never reused within the lifetime of bugs.json. Non-conforming ids
 * (imported entries, e.g. `id: "imported-XYZ"`) are preserved but ignored
 * by the max search.
 *
 * The whole read-allocate-append-write sequence runs under withPathLock so
 * two concurrent addBug calls produce distinct ids (no `bug-3` collision).
 */
export async function addBug(durableBase, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('addBug: entry must be an object');
  }
  let saved;
  await withPathLock(
    bugsFilePath(durableBase),
    (current) => {
      const bugs = Array.isArray(current) ? current : [];
      const id = `bug-${maxBugIdSuffix(bugs) + 1}`;
      saved = { ...entry, id };
      bugs.push(saved);
      return bugs;
    },
    { defaultValue: [], lockTimeoutMs: LOCK_TIMEOUT_MS, pollIntervalMs: LOCK_POLL_MS },
  );
  return saved;
}

/**
 * findBugsForFile(bugs, relPath): linear scan; returns entries where
 * entry.file === relPath. Preserves order.
 */
export function findBugsForFile(bugs, relPath) {
  if (!Array.isArray(bugs)) return [];
  const out = [];
  for (const b of bugs) {
    if (b && b.file === relPath) out.push(b);
  }
  return out;
}

/**
 * findBugsForSymbol(bugs, relPath, symbolName): file AND graph_node match.
 */
export function findBugsForSymbol(bugs, relPath, symbolName) {
  if (!Array.isArray(bugs)) return [];
  const out = [];
  for (const b of bugs) {
    if (b && b.file === relPath && b.graph_node === symbolName) out.push(b);
  }
  return out;
}

/**
 * countOpenBugs(bugs): count entries where !fix_verified.
 */
export function countOpenBugs(bugs) {
  if (!Array.isArray(bugs)) return 0;
  let n = 0;
  for (const b of bugs) {
    if (b && !b.fix_verified) n++;
  }
  return n;
}

/**
 * mostRecentUnfixedFor(bugs, relPath): return the entry with the latest ts
 * among bugs for that file with !fix_verified. Null if none.
 */
export function mostRecentUnfixedFor(bugs, relPath) {
  if (!Array.isArray(bugs)) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const b of bugs) {
    if (!b || b.file !== relPath || b.fix_verified) continue;
    const t = b.ts ? Date.parse(b.ts) : NaN;
    // If ts is missing/unparseable, fall back to "tail wins" via index — we
    // use Number.NEGATIVE_INFINITY+i so later entries beat earlier ones.
    const score = Number.isFinite(t) ? t : -Infinity;
    if (score > bestTs) {
      best = b;
      bestTs = score;
    }
  }
  // If every candidate had unparseable ts, the linear scan above leaves
  // `best` set to the FIRST match (because subsequent scores all equal
  // -Infinity and `>` is false). Spec asks for the latest entry by ts; this
  // is a defensible interpretation and we don't allocate yet another sort.
  return best;
}

/**
 * tagBugSymbol(bugs, graph): for each bug missing `graph_node`, attempt a
 * symbol-match using the graph's file-node symbols.
 *
 * Heuristic: load the bug's file node from the graph, look at its `symbols`
 * array, and search the bug's `error_message` + `root_cause` for any symbol
 * name as a whole-word match (regex with \b). First match wins
 * (graph_node = symbol, graph_node_confidence = 'symbol-match'). If no
 * symbol matches, fallback to graph_node = relPath, graph_node_confidence
 * = 'file-level'.
 *
 * Returns { bugs: <new array>, tagged: <count>, untagged: <count> } where
 * `tagged` counts symbol-match wins and `untagged` counts file-level
 * fallbacks. Bugs already carrying a graph_node are left untouched.
 */
export function tagBugSymbol(bugs, graph) {
  if (!Array.isArray(bugs)) return { bugs: [], tagged: 0, untagged: 0 };
  if (!graph) {
    // Without a graph we can't symbol-match; still fall back to file-level
    // tagging so the store has *some* graph_node on each entry.
    return tagWithoutGraph(bugs);
  }
  const fileNodesByPath = indexFileNodesByPath(graph);

  const out = new Array(bugs.length);
  let tagged = 0;
  let untagged = 0;

  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i];
    if (!b || typeof b !== 'object') {
      out[i] = b;
      continue;
    }
    if (b.graph_node && b.graph_node_confidence) {
      // Already tagged. Leave alone.
      out[i] = b;
      continue;
    }
    const file = typeof b.file === 'string' ? b.file : null;
    if (!file) {
      out[i] = b;
      continue;
    }
    const node = fileNodesByPath.get(file);
    const symbolNames = Array.isArray(node && node[NODE.SYMBOLS]) ? node[NODE.SYMBOLS] : [];
    const haystack = [b.error_message, b.root_cause]
      .filter((s) => typeof s === 'string')
      .join('\n');
    const matched = firstWholeWordSymbol(haystack, symbolNames);
    if (matched) {
      out[i] = { ...b, graph_node: matched, graph_node_confidence: 'symbol-match' };
      tagged++;
    } else {
      out[i] = { ...b, graph_node: file, graph_node_confidence: 'file-level' };
      untagged++;
    }
  }

  return { bugs: out, tagged, untagged };
}

// --- helpers ---------------------------------------------------------------

function indexFileNodesByPath(graph) {
  const m = new Map();
  const nodes = Array.isArray(graph[GRAPH.NODES]) ? graph[GRAPH.NODES] : [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const p = n[NODE.PATH];
    if (typeof p === 'string') m.set(p, n);
  }
  return m;
}

// Returns the first symbol name (in source order) that appears as a whole-
// word match in haystack. Whole-word = `\b<symbol>\b` regex with the symbol
// regex-escaped. Returns null when none match.
function firstWholeWordSymbol(haystack, symbolNames) {
  if (!haystack || symbolNames.length === 0) return null;
  for (const name of symbolNames) {
    if (typeof name !== 'string' || name.length === 0) continue;
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (re.test(haystack)) return name;
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagWithoutGraph(bugs) {
  const out = new Array(bugs.length);
  let untagged = 0;
  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i];
    if (!b || typeof b !== 'object') {
      out[i] = b;
      continue;
    }
    if (b.graph_node && b.graph_node_confidence) {
      out[i] = b;
      continue;
    }
    const file = typeof b.file === 'string' ? b.file : null;
    if (!file) {
      out[i] = b;
      continue;
    }
    out[i] = { ...b, graph_node: file, graph_node_confidence: 'file-level' };
    untagged++;
  }
  return { bugs: out, tagged: 0, untagged };
}

// Exposed for tests.
export const BUGS_FILE = BUGS_FILENAME;
