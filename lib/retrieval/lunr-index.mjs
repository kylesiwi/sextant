// lib/retrieval/lunr-index.mjs — Lunr BM25 retrieval over cerebrum + bugs.
//
// Phase 4 (§ 8 Phase 4 of GROUND_UP_DESIGN.md):
//   - PreToolUse Read injects top-K Lunr-ranked rules at priority 8 IN
//     ADDITION to the priority-1 exact-match mandatory rules.
//   - The one store (cerebrum.md) is indexed whole, so mandatory/provisional/
//     node rules CAN appear in the index; callers apply a belt-and-suspenders
//     bucket-membership filter to drop them (priority 1 handles them).
//
// Caching strategy: two-level, source-mtime-keyed (§ 6.1 of GROUND_UP_DESIGN.md).
//   - L1 — in-process Map per file kind, keyed by absolute file path. Each
//     cached entry holds { mtimeMs, index, docs }. Hot path: no I/O beyond
//     a stat().
//   - L2 — on-disk JSON envelope under `<durableBase>/lunr/<name>.idx`
//     holding { version, source_mtime_ms, source_size, index, docs }.
//     Survives process restarts so a fresh CC session doesn't pay the
//     ~100ms rebuild cost on a 1000-rule cerebrum.
//   - Invalidation: stat() the source on every load. If the source mtime/size
//     matches L1, return L1. Else read L2; if its envelope matches, hydrate
//     L1 and return. Else rebuild from source and refresh BOTH caches.
//
// On-disk envelope:
//   {
//     version: 1,                       // bump → silently invalidates old caches
//     source_mtime_ms: <number>,        // source mtime at build time
//     source_size:     <number>,        // source size at build time (sanity)
//     index: <lunr.Index.toJSON()>,     // serialized Lunr index
//     docs:  <docs map, plain object>,  // parallel docs map for hit rendering
//   }
//
// Concurrent writers: atomic tmp + rename handles tearing. Two sessions
// rebuilding simultaneously will both write — last-writer wins, both wrote
// the same data, no harm done.
//
// Field strategy:
//   Cerebrum rules → { id: <line_hash>, body, source, buckets }
//     - id: stable hash of the raw rule line (deterministic across reloads
//       for unchanged content). Lunr requires unique ref ids.
//     - body: rule body text (the most useful field for ranking).
//     - source: 'node:<path>' for file-scoped rules, 'global' otherwise.
//     - buckets: space-joined bucket names so a caller's filter can use the
//       indexed token (rare; mostly informational).
//
//   Bug entries → { id: <bug-id>, error_message, root_cause, fix, file,
//                   graph_node, tags }
//     - body fields are the four free-text fields a bug entry carries.
//     - file + graph_node + tags are indexed so a query like
//       `validateToken auth` can hit both the symbol and the file path.
//
// Defensive query handling:
//   - Lunr throws on malformed queries (unbalanced quotes, stray `:`, etc.).
//     `search()` wraps each call in try/catch and returns [] on failure so
//     a typo in a hook payload can't crash a Read.
//   - Empty / whitespace-only queries return [] without invoking Lunr.
//
// Performance budget (§ 8 Phase 4 falsification):
//   - Cold build < 100ms on 200 rules.
//   - Warm query < 5ms.
//   We honour these in test/phase4-falsify.mjs.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import lunr from 'lunr';

import { parseCerebrum } from '../stores/cerebrum.mjs';
import { readBugs } from '../stores/bugs.mjs';

// --- on-disk persistence layout -------------------------------------------

// Spec § 6.1 promises Lunr indexes are cached at:
//   <durableBase>/lunr/cerebrum.idx
//   <durableBase>/lunr/bugs.idx
const LUNR_DIR_NAME = 'lunr';
const CEREBRUM_INDEX_FILE = 'cerebrum.idx';
const BUGS_INDEX_FILE = 'bugs.idx';

// Envelope version. Bump when the on-disk schema (envelope shape, doc map
// shape, or Lunr serialization format we depend on) changes. Old envelopes
// with a mismatched version are silently rejected and rebuilt.
//   v2 (cerebrum-v2 tranche T3): added the `keywords` field to cerebrum docs.
const INDEX_VERSION = 2;

// Lunr field boosts for cerebrum rules. Named (not inline magic numbers) so the
// retrieval weighting is discoverable and tunable from stats.rule_fires. The
// explicit [kw:] tag is a stronger authoring signal than incidental body text,
// so `keywords` outranks `body` (cerebrum-v2 tranche T3 / §3 keyword scope).
const CEREBRUM_FIELD_BOOST = { keywords: 12, body: 10, source: 5, buckets: 1 };

// BM25 minScore thresholds for the v2 keyword (`keywords` field) query — named,
// not inline, so they tune from stats.rule_fires (cerebrum-v2 tranche T3 / §3):
//   READ        — Read / Grep / Glob / UserPromptSubmit kw matches.
//   WRITE       — Edit / Write / MultiEdit; tighter so a safety rule isn't
//                 silently missed on a write that BM25 ranks just under READ.
//   PROVISIONAL — the deliberately HIGH floor for migrated [provisional] rules,
//                 so a large migrated corpus surfaces only on strong matches and
//                 the queue decays through use (anchor #6). Applied per-rule:
//                 a provisional hit must clear this; a normal hit clears READ/WRITE.
// (Bash uses exact word-boundary only — NO BM25 — so it has no threshold here.)
export const KW_MINSCORE = { READ: 0.3, WRITE: 0.15, PROVISIONAL: 0.8 };

function lunrDir(durableBase) {
  return path.join(durableBase, LUNR_DIR_NAME);
}

function cerebrumIndexPath(durableBase) {
  return path.join(lunrDir(durableBase), CEREBRUM_INDEX_FILE);
}

function bugsIndexPath(durableBase) {
  return path.join(lunrDir(durableBase), BUGS_INDEX_FILE);
}

// --- module-level caches ---------------------------------------------------

// One cache per kind. Keyed by ABSOLUTE file path (we resolve before storing
// so equivalent relative paths share an entry). Each value:
//   { mtimeMs: number, size: number, index: lunr.Index, docs: Map<id, doc> }
const _cerebrumCache = new Map();
const _bugsCache = new Map();

// --- public: index builders -----------------------------------------------

/**
 * buildCerebrumIndex(parsedCerebrum): build a Lunr index over the rules in a
 * parsed cerebrum object (the shape produced by lib/stores/cerebrum.mjs's
 * parseCerebrum). Iterates `lines`, keeps only `kind === 'rule'` AND
 * non-archived entries (archived = no archived bucket; we don't have one
 * today, but the carve-out is here for forward-compat with `cerebrum/archive.md`
 * which is parsed by a separate file in any case).
 *
 * Returns { index, docs } where docs is a Map<id, doc> the caller uses to
 * render results.
 */
export function buildCerebrumIndex(parsedCerebrum) {
  const docs = new Map();
  const entries = [];
  if (parsedCerebrum && Array.isArray(parsedCerebrum.lines)) {
    for (const e of parsedCerebrum.lines) {
      if (!e || e.kind !== 'rule') continue;
      // Phase 4 leaves archived rules out of the index. archive.md is parsed
      // separately, so this is mostly defensive; we still skip entries whose
      // buckets list 'archive' (forward-compat).
      const buckets = Array.isArray(e.buckets) ? e.buckets : [];
      if (buckets.includes('archive')) continue;
      const body = typeof e.body === 'string' ? e.body : '';
      if (body.length === 0) continue;
      const id = ruleId(e.raw, body);
      const source = sourceOf(buckets);
      const doc = {
        id,
        body,
        source,
        buckets: buckets.join(' '),
        keywords: keywordsOf(buckets),
      };
      docs.set(id, doc);
      entries.push(doc);
    }
  }

  const index = lunr(function () {
    // Field weighting (CEREBRUM_FIELD_BOOST): `keywords` (the explicit [kw:] tag)
    // is the strongest authoring signal — kw rules opt into ranked retrieval, so
    // their tagged terms outrank incidental body text. `body` is the next most
    // informative for "which rule covers this symbol?"; `source` (e.g.
    // node:src/auth.ts) is a strong signal too; `buckets` is weakest.
    this.ref('id');
    this.field('keywords', { boost: CEREBRUM_FIELD_BOOST.keywords });
    this.field('body', { boost: CEREBRUM_FIELD_BOOST.body });
    this.field('source', { boost: CEREBRUM_FIELD_BOOST.source });
    this.field('buckets', { boost: CEREBRUM_FIELD_BOOST.buckets });
    // Add every collected doc. lunr's builder accepts each doc verbatim and
    // applies the standard pipeline (tokenizer + stopwords + stemmer).
    for (const doc of entries) this.add(doc);
  });

  return { index, docs };
}

/**
 * buildBugsIndex(bugs): build a Lunr index over an array of bug entries.
 * The doc id is the entry's `id` field (e.g., 'bug-1'); the indexed text
 * is error_message + root_cause + fix + file + graph_node + tags.
 */
export function buildBugsIndex(bugs) {
  const docs = new Map();
  const entries = [];
  if (Array.isArray(bugs)) {
    for (const b of bugs) {
      if (!b || typeof b !== 'object') continue;
      const id = typeof b.id === 'string' ? b.id : null;
      if (!id) continue;
      const tagsList = Array.isArray(b.tags) ? b.tags : [];
      const doc = {
        id,
        error_message: typeof b.error_message === 'string' ? b.error_message : '',
        root_cause: typeof b.root_cause === 'string' ? b.root_cause : '',
        fix: typeof b.fix === 'string' ? b.fix : '',
        file: typeof b.file === 'string' ? b.file : '',
        graph_node: typeof b.graph_node === 'string' ? b.graph_node : '',
        tags: tagsList.join(' '),
      };
      docs.set(id, doc);
      entries.push(doc);
    }
  }

  const index = lunr(function () {
    this.ref('id');
    this.field('error_message', { boost: 10 });
    this.field('root_cause', { boost: 5 });
    this.field('fix', { boost: 2 });
    this.field('file', { boost: 3 });
    this.field('graph_node', { boost: 5 });
    this.field('tags', { boost: 2 });
    for (const doc of entries) this.add(doc);
  });

  return { index, docs };
}

// --- public: search --------------------------------------------------------

/**
 * search(index, docs, query, k=5, minScore=0.3): run the query against the
 * index and return the top-K matches above minScore, each shaped:
 *   { id, score, doc }
 *
 * Results are sorted descending by score. A malformed Lunr query (e.g. a
 * stray colon, unbalanced quote) or an empty/whitespace-only query returns
 * an empty array — defensive: we never want a PreToolUse Read to crash on
 * a typo'd identifier.
 *
 * NOTE: We accept `docs` as a separate argument (rather than coupling to the
 * { index, docs } envelope) so test cases can pass synthetic doc maps freely.
 */
export function search(index, docs, query, k = 5, minScore = 0.3) {
  if (!index || typeof query !== 'string') return [];
  const q = query.trim();
  if (q.length === 0) return [];

  let raw;
  try {
    raw = index.search(q);
  } catch {
    // Lunr throws on syntax errors — colons, unbalanced quotes, lone `+`/`-`.
    // We could try to escape the query and retry; for Phase 4 we simply
    // return [] and let callers fall back to other ranking signals.
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const limit = Math.max(0, k | 0);
  const filtered = [];
  for (const r of raw) {
    if (!r || typeof r.score !== 'number') continue;
    if (r.score < minScore) continue;
    const doc = docs ? docs.get(r.ref) : null;
    filtered.push({ id: r.ref, score: r.score, doc: doc || null });
  }

  // Lunr already sorts desc by score, but we still take the first `limit`
  // explicitly so callers can rely on the contract.
  return filtered.slice(0, limit);
}

// --- public: cached loaders ----------------------------------------------

/**
 * loadCerebrumIndex(durableBase): async loader for the cerebrum Lunr index.
 * Returns { index, docs }, or { index: empty, docs: empty } if the file is
 * missing.
 *
 * Two-level cache (§ 6.1):
 *   - L1: in-process Map (instant return on mtime match).
 *   - L2: <durableBase>/lunr/cerebrum.idx (rebuild-free across processes).
 *
 * The whole one store (`cerebrum.md`) is indexed: kw rules flow through BM25
 * ranked retrieval; mandatory/provisional/node rules also land in the index but
 * are dropped by the priority-8 caller's bucket filter (priority 1 handles them
 * via listMandatoryFor). Production callers pass `opts.sourceFile = 'cerebrum.md'`;
 * the default below is `regular.md` only as a generic fallback (exercised by the
 * unit tests). The mtime cache keys on the absolute source path, so switching
 * files is safe.
 */
export async function loadCerebrumIndex(durableBase, opts = {}) {
  const sourceFile = typeof opts.sourceFile === 'string' ? opts.sourceFile : 'regular.md';
  const filePath = path.join(durableBase, 'cerebrum', sourceFile);
  return loadIndexCached(
    filePath,
    _cerebrumCache,
    cerebrumIndexPath(durableBase),
    async (text) => {
      const parsed = parseCerebrum(text);
      return buildCerebrumIndex(parsed);
    },
    /* missingValue= */ buildCerebrumIndex({ lines: [] }),
  );
}

/**
 * loadBugsIndex(durableBase): async loader for the bugs.json Lunr index.
 * Returns { index, docs } even on a missing file (empty index + empty docs).
 *
 * Same two-level cache as loadCerebrumIndex; on-disk envelope at
 * <durableBase>/lunr/bugs.idx.
 */
export async function loadBugsIndex(durableBase) {
  const filePath = path.join(durableBase, 'bugs.json');
  return loadIndexCached(
    filePath,
    _bugsCache,
    bugsIndexPath(durableBase),
    async () => {
      // bugs.json is JSON; use the canonical reader so we share defensive
      // parsing (malformed JSON → []).
      const bugs = await readBugs(durableBase);
      return buildBugsIndex(bugs);
    },
    /* missingValue= */ buildBugsIndex([]),
  );
}

// --- internals ------------------------------------------------------------

// Shared cache machinery for both loaders. We pass:
//   - filePath: absolute path of the SOURCE file whose mtime drives
//               invalidation (cerebrum/regular.md or bugs.json).
//   - cacheMap: the per-kind in-memory cache to consult/update.
//   - diskIndexPath: absolute path of the on-disk Lunr index envelope file
//                    under <durableBase>/lunr/.
//   - buildFromText: an async builder that takes the raw file text and
//                    returns { index, docs }.
//     (For bugs we don't actually use the text — readBugs does the I/O —
//      but the contract is consistent: build from a fresh snapshot.)
//   - missingValue: what to return if the source stat() ENOENTs.
async function loadIndexCached(filePath, cacheMap, diskIndexPath, buildFromText, missingValue) {
  const absPath = path.resolve(filePath);

  // 1. Stat the source to get current mtime + size.
  let mtimeMs;
  let size;
  try {
    const stat = await fs.stat(absPath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch (err) {
    if (err && err.code === 'ENOENT') return missingValue;
    // Other stat errors (permission, etc.) → empty index. Best-effort.
    return missingValue;
  }

  // 2. L1: in-process cache. Hot path.
  const cached = cacheMap.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return { index: cached.index, docs: cached.docs };
  }

  // 3. L2: on-disk cache. Cold path on a fresh process; cheaper than rebuilding.
  const onDisk = await readOnDiskIndex(diskIndexPath);
  if (
    onDisk
    && onDisk.source_mtime_ms === mtimeMs
    && onDisk.source_size === size
  ) {
    const hydrated = hydrateFromEnvelope(onDisk);
    if (hydrated) {
      cacheMap.set(absPath, { mtimeMs, size, index: hydrated.index, docs: hydrated.docs });
      return hydrated;
    }
    // Hydration failed (corrupt index payload) → fall through to rebuild.
  }

  // 4. Stale / missing / corrupt: rebuild from source.
  let text;
  try {
    text = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return missingValue;
    return missingValue;
  }

  let built;
  try {
    built = await buildFromText(text);
  } catch {
    // Builder failure → empty index. Surface stderr so debug runs see it.
    process.stderr.write(`sextant: lunr-index build failed for ${absPath}\n`);
    return missingValue;
  }

  // 5. Refresh both caches. Disk write is best-effort: in-memory result
  //    still ships even if persistence fails.
  cacheMap.set(absPath, { mtimeMs, size, index: built.index, docs: built.docs });
  await writeOnDiskIndex(diskIndexPath, {
    version: INDEX_VERSION,
    source_mtime_ms: mtimeMs,
    source_size: size,
    index: built.index.toJSON(),
    docs: docsToObject(built.docs),
  });

  return built;
}

// --- on-disk envelope I/O --------------------------------------------------

// readOnDiskIndex: parse the envelope at indexFilePath. Returns null on any
// failure (missing file, invalid JSON, wrong version, structurally bad) so
// the caller falls through to a fresh rebuild.
async function readOnDiskIndex(indexFilePath) {
  let raw;
  try {
    raw = await fs.readFile(indexFilePath, 'utf8');
  } catch {
    return null;
  }
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.version !== INDEX_VERSION) return null;
  if (typeof envelope.source_mtime_ms !== 'number') return null;
  if (typeof envelope.source_size !== 'number') return null;
  if (!envelope.index || !envelope.docs) return null;
  return envelope;
}

// writeOnDiskIndex: atomic tmp + rename. Best-effort — if disk is full or
// the parent dir is readonly we log to stderr and continue with the
// in-memory index intact. Concurrent writers race the rename; last-writer
// wins on identical payloads, which is harmless.
async function writeOnDiskIndex(indexFilePath, envelope) {
  try {
    await fs.mkdir(path.dirname(indexFilePath), { recursive: true });
    const tmp = `${indexFilePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(envelope), 'utf8');
    try {
      await fs.rename(tmp, indexFilePath);
    } catch (renameErr) {
      // Rename failed — best-effort cleanup of the temp file so we don't
      // leave litter in <durableBase>/lunr/.
      try { await fs.unlink(tmp); } catch {}
      throw renameErr;
    }
  } catch (err) {
    process.stderr.write(`sextant: lunr-index write failed (${err && err.message ? err.message : err})\n`);
  }
}

// hydrateFromEnvelope: rebuild { index, docs } from a parsed envelope.
// Returns null on a malformed payload so the caller can fall through to a
// full rebuild without crashing.
function hydrateFromEnvelope(envelope) {
  let index;
  try {
    index = lunr.Index.load(envelope.index);
  } catch {
    return null;
  }
  const docs = docsFromObject(envelope.docs);
  if (!docs) return null;
  return { index, docs };
}

// docsToObject: Map<id, doc> → plain object suitable for JSON.stringify.
// We keep doc ids as keys to mirror the in-memory shape; JSON has no Map
// type so the on-disk form is necessarily an object.
function docsToObject(docs) {
  if (!docs) return {};
  if (docs instanceof Map) {
    const out = {};
    for (const [id, doc] of docs) out[id] = doc;
    return out;
  }
  // Already a plain object (defensive — current builders always emit Maps).
  return docs;
}

// docsFromObject: plain object → Map<id, doc>. Returns null on a
// structurally invalid payload (not an object).
function docsFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const docs = new Map();
  for (const [id, doc] of Object.entries(obj)) docs.set(id, doc);
  return docs;
}

// Stable id for a rule line. We hash the raw text so the same line keeps the
// same id across reloads. SHA-1 is plenty — these aren't security-sensitive
// and short hex makes Lunr's internal dictionaries cheaper.
function ruleId(raw, fallback) {
  const text = typeof raw === 'string' && raw.length > 0
    ? raw
    : (typeof fallback === 'string' ? fallback : '');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// Compute the canonical "source" tag for a rule based on its buckets. Priority:
//   - first 'node:<path>' bucket → 'node:<path>'.
//   - else 'global' (covers '!global', plain rules with no node bucket, etc.).
function sourceOf(buckets) {
  if (!Array.isArray(buckets)) return 'global';
  for (const b of buckets) {
    if (typeof b === 'string' && b.startsWith('node:')) return b;
  }
  return 'global';
}

// Extract the indexable keyword text from a rule's [kw:…] bucket(s). Joins the
// keyword lists, strips commas (Lunr's tokenizer splits on whitespace) and any
// residual v1 scoring markers ('*' criticals, ';min=' overrides — already removed
// by the T1 migration, stripped here defensively for un-migrated v1 stores). The
// result feeds the high-boost `keywords` field so kw rules enter BM25 ranked
// retrieval (cerebrum-v2 tranche T3). Non-kw rules yield ''.
function keywordsOf(buckets) {
  if (!Array.isArray(buckets)) return '';
  const parts = [];
  for (const b of buckets) {
    if (typeof b !== 'string' || !b.startsWith('kw:')) continue;
    const content = b.slice(3).replace(/;\s*min\s*=\s*\d+\s*$/i, '');
    parts.push(content.replace(/\*/g, ' ').replace(/,/g, ' '));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// --- test hooks -----------------------------------------------------------

/**
 * _resetCacheForTests(): clear both module caches. Tests that touch the
 * filesystem rely on this to avoid mtime collisions between cases.
 */
export function _resetCacheForTests() {
  _cerebrumCache.clear();
  _bugsCache.clear();
}
