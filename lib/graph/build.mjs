// lib/graph/build.mjs — Phase 1a/1b multi-language graph builder.
//
// Orchestrates per-language extractors over a project tree and emits
// .sextant/graph/graph.json. The output is the data structure documented in
// lib/graph/schema.mjs.
//
// Performance shape:
//   - File I/O is parallelised (bounded concurrency) to overlap fs.readFile
//     latency. The extractors themselves are fast (< 50ms / 200-line file)
//     but they call into a tree-sitter Parser instance, and Parser instances
//     are NOT thread-safe, so parsing must be serialised PER LANGUAGE. Cross-
//     language parses can in principle overlap, but in this codebase we keep
//     it simple: a single serial loop runs every file regardless of language.
//   - For a 600-file project the wall-clock budget is < 5s.
//
// Multi-language dispatch:
//   - File extension drives which extractor + parser are used.
//   - `.ts`, `.tsx` → TypeScript extractor.
//   - `.js`, `.mjs`, `.cjs`, `.jsx` → JavaScript extractor.
//   - Extractors are lazy-imported on first use, then cached for the whole
//     build. The cached entry stores (parser, extractFromTree) so the per-file
//     work just calls parser.parse + extractFromTree.
//
// Failure isolation:
//   - A single file's extraction failure (parse crash, read failure) is
//     logged as a per-file warning. The build continues. We never fail the
//     whole build because of one bad file.
//   - If a language's parser can't load (missing WASM), every file of that
//     language becomes a warning, but the build continues with other
//     languages. Empty-project / parser-missing scenarios are non-fatal here
//     unless ZERO extractors load (then there's nothing to do).

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  SCHEMA_VERSION,
  GRAPH,
  NODE,
  validateGraph,
  emptyGraph,
} from './schema.mjs';
import { resolveEdges } from './resolve.mjs';
import { writeJsonAtomic } from '../io.mjs';
import { ensureDurableDir, durableBase } from '../paths.mjs';

// Default extensions Phase 1b understands. Order matters for `path.extname`
// — that returns the last dot segment, so `.ts` and `.tsx` are different
// extensions to the walker.
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.go', '.rs'];
// Conventional dirs to skip during the walk. JS/TS contributes node_modules /
// dist / build / coverage; Python contributes __pycache__, .venv, venv, env,
// and any *.egg-info/ build artefact; Go contributes `vendor/` (vendored
// third-party packages, conventionally not part of your code); Rust
// contributes `target/` (cargo build output). Phase 1c may extend further.
const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.sextant', 'dist', 'build', 'coverage',
  '__pycache__', '.venv', 'venv', 'env', 'vendor', 'target',
];
// Patterns matched against directory base-names. `*.egg-info/` is a Python
// build artefact; we exclude any dir whose name ends with `.egg-info`.
const DEFAULT_EXCLUDE_SUFFIXES = ['.egg-info'];

// Concurrency cap for parallel fs.readFile.
const READ_CONCURRENCY = 64;

// Size-cap defaults. Both env-overridable so a power user can tune for an
// unusually large or unusually constrained codebase.
//
// SEXTANT_GRAPH_MAX_FILE_BYTES (default 1 MB): files whose stat()ed size
// exceeds this are skipped. A single 200MB minified bundle in a monorepo
// would otherwise OOM the Node process during the parallel-read phase.
//
// SEXTANT_GRAPH_MAX_FILES (default 10,000): if the walked tree yields more
// candidates than this, we trim to the first N (alphabetic order) and emit
// a stderr warning. Reason: a monorepo with 200K source files would burn
// minutes of wall-clock and gigabytes of RAM before the parser is even
// reached — degraded indexing beats an OOM crash.
//
// Both caps are soft: we never throw. Skipped files are logged once at the
// end of the build, not per-file.
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 10000;

function getMaxFileBytes() {
  const raw = process.env.SEXTANT_GRAPH_MAX_FILE_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_FILE_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_FILE_BYTES;
  return Math.floor(n);
}

function getMaxFiles() {
  const raw = process.env.SEXTANT_GRAPH_MAX_FILES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_FILES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_FILES;
  return Math.floor(n);
}

// --- extractor registry ----------------------------------------------------
//
// Each extension maps to a lazy loader returning { language, parser, extract }.
// The loader is called at most once per build; the registry caches the
// resolved entry on the registry map itself so repeated calls reuse it.
//
// The `language` key is used for warnings ("the typescript parser failed
// to load") — it has no functional role beyond that.

const REGISTRY = {
  '.ts':  { language: 'typescript', module: './extractors/typescript.mjs', loader: 'loadTypescriptParser' },
  '.tsx': { language: 'typescript', module: './extractors/typescript.mjs', loader: 'loadTypescriptParser' },
  '.js':  { language: 'javascript', module: './extractors/javascript.mjs', loader: 'loadJavascriptParser' },
  '.mjs': { language: 'javascript', module: './extractors/javascript.mjs', loader: 'loadJavascriptParser' },
  '.cjs': { language: 'javascript', module: './extractors/javascript.mjs', loader: 'loadJavascriptParser' },
  '.jsx': { language: 'javascript', module: './extractors/javascript.mjs', loader: 'loadJavascriptParser' },
  '.py':  { language: 'python',     module: './extractors/python.mjs',     loader: 'loadPythonParser'     },
  '.go':  { language: 'go',         module: './extractors/go.mjs',         loader: 'loadGoParser'         },
  '.rs':  { language: 'rust',       module: './extractors/rust.mjs',       loader: 'loadRustParser'       },
};

// Resolves an extension to its extractor instance. Returns null and pushes a
// warning if the extractor can't be loaded (missing wasm, parser load failed,
// etc.). The first such failure for a given language is cached so subsequent
// files don't re-trigger the same diagnostic.
async function resolveExtractor(ext, cache, warnings) {
  const entry = REGISTRY[ext];
  if (!entry) return null;

  // Use language as the cache key — `.ts` and `.tsx` share a single parser
  // instance, same with `.js`/`.mjs`/`.cjs`/`.jsx`.
  const key = entry.language;
  if (cache.has(key)) return cache.get(key);

  // Lazy ESM import. The static specifier here is relative to this file's
  // location; `./extractors/...` resolves the same way as a top-level import.
  let mod;
  try {
    mod = await import(entry.module);
  } catch (err) {
    warnings.push(`${entry.language}: extractor module load failed: ${err.message}`);
    cache.set(key, null);
    return null;
  }

  // The parser loader sits in parser.mjs; import it by name.
  const parserMod = await import('./parser.mjs');
  const loader = parserMod[entry.loader];
  if (typeof loader !== 'function') {
    warnings.push(`${entry.language}: parser loader '${entry.loader}' not exported by parser.mjs`);
    cache.set(key, null);
    return null;
  }

  let parser;
  try {
    parser = await loader();
  } catch (err) {
    warnings.push(`${entry.language}: parser load threw: ${err.message}`);
    cache.set(key, null);
    return null;
  }
  if (!parser) {
    warnings.push(`${entry.language}: parser unavailable (check grammar wasm)`);
    cache.set(key, null);
    return null;
  }

  const resolved = {
    language: entry.language,
    parser,
    extract: mod.extractFromTree,
  };
  cache.set(key, resolved);
  return resolved;
}

/**
 * buildGraph(opts): build a project graph and persist it to
 * .sextant/graph/graph.json.
 *
 * @param {Object} [opts]
 * @param {string} [opts.root=process.cwd()] - project root (resolved to absolute).
 * @param {string[]} [opts.patterns] - reserved; current implementation walks
 *   by extension list (see extensionsFromPatterns).
 * @param {string[]} [opts.excludes] - directory base-names to skip.
 * @param {boolean} [opts.quiet=false] - suppress progress to stderr.
 * @param {boolean} [opts.skipResolve=false] - skip Phase 1c cross-file edge
 *   resolution. Default false (resolution runs). Tests pass true when they
 *   want to assert on the raw, pre-resolution edge shape.
 * @returns {Promise<{files:number, edges:number, ms:number, graphPath:string, warnings:string[], resolved_count:number, unresolved_count:number}>}
 */
export async function buildGraph(opts = {}) {
  const root = path.resolve(opts.root ?? process.cwd());
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  const patterns = opts.patterns ?? ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx', '**/*.py', '**/*.go', '**/*.rs'];
  const quiet = opts.quiet === true;
  const skipResolve = opts.skipResolve === true;
  const extensions = extensionsFromPatterns(patterns);

  const start = process.hrtime.bigint();
  const warnings = [];

  // 1) Walk the tree.
  let relFiles = await listSourceFiles(root, { extensions, excludes });

  // 1a) File-count cap. Apply BEFORE the per-extension partition / read so
  //     we never enumerate, stat, or read past the cap. We process the
  //     candidates in their existing (alphabetic) order, which is the order
  //     listSourceFiles guarantees, so the behaviour is deterministic.
  const maxFiles = getMaxFiles();
  if (relFiles.length > maxFiles) {
    const dropped = relFiles.length - maxFiles;
    process.stderr.write(
      `sextant: graph: file-count ${relFiles.length} exceeds cap ${maxFiles}, skipping rest (${dropped} files dropped)\n`,
    );
    relFiles = relFiles.slice(0, maxFiles);
  }

  if (!quiet) {
    process.stderr.write(`sextant: graph build — ${relFiles.length} candidate files\n`);
  }

  // 2) Partition by extension. Anything we don't have a registered extractor
  //    for is silently dropped (the walker should already have filtered, but
  //    callers could pass arbitrary patterns).
  const byExt = new Map();
  for (const rel of relFiles) {
    const ext = path.extname(rel);
    if (!REGISTRY[ext]) continue;
    if (!byExt.has(ext)) byExt.set(ext, []);
    byExt.get(ext).push(rel);
  }

  // No files? Write an empty graph and return early. We still need to write
  // the .sextant-version sidecar so downstream consumers find a populated dir.
  // We share the rest of the pipeline by setting up empty arrays.

  // 3) Resolve every extractor we'll need. The resolveExtractor call is
  //    idempotent and cached; we call it eagerly here so all parser-load
  //    failures surface before we start chewing through files.
  const extractorCache = new Map();
  for (const ext of byExt.keys()) {
    // The result may be null on load failure — that's recorded in warnings.
    await resolveExtractor(ext, extractorCache, warnings);
  }

  // 4) Read sources in parallel (bounded), then parse + extract sequentially.
  //    We intentionally don't do `Promise.all(read+parse)` because parsing on
  //    one Parser must be serialised.
  const nodes = [];
  const edges = [];
  const nodeIdSet = new Set();

  // Build the full read list across all extensions, preserving overall
  // alphabetic order (listSourceFiles already sorted relFiles).
  const allTargets = relFiles
    .filter((rel) => REGISTRY[path.extname(rel)])
    .map((rel) => ({ rel, abs: path.join(root, rel) }));

  // Per-file size cap: stat each file before reading. Files larger than
  // SEXTANT_GRAPH_MAX_FILE_BYTES are silently skipped here (the result
  // entry carries `error: 'oversized'`). We collect the list and emit one
  // stderr summary at the end — per-file noise isn't useful.
  const maxFileBytes = getMaxFileBytes();
  const oversizedSkipped = [];
  const sources = await readSourceFiles(allTargets, {
    concurrency: READ_CONCURRENCY,
    warnings,
    maxFileBytes,
    oversizedSkipped,
  });

  if (oversizedSkipped.length > 0) {
    // One summary line, then up to 5 example paths so the user has actionable
    // signal without flooding stderr in a worst-case monorepo.
    const examples = oversizedSkipped.slice(0, 5).join(', ');
    const more = oversizedSkipped.length > 5 ? ` (and ${oversizedSkipped.length - 5} more)` : '';
    process.stderr.write(
      `sextant: graph: skipped ${oversizedSkipped.length} oversized file(s) (> ${maxFileBytes} bytes): ${examples}${more}\n`,
    );
  }

  // 5) Parse + extract sequentially.
  for (const item of sources) {
    if (item.error) continue;
    const ext = path.extname(item.rel);
    const extractor = await resolveExtractor(ext, extractorCache, warnings);
    if (!extractor) {
      // Parser unavailable for this language. We've already pushed a warning
      // in resolveExtractor on first encounter; per-file noise isn't useful,
      // so we silently skip subsequent files of the same language. The
      // candidate count in the summary line still includes them.
      continue;
    }
    let tree;
    try {
      tree = extractor.parser.parse(item.source);
    } catch (err) {
      warnings.push(`${item.rel}: parse threw: ${err.message}`);
      continue;
    }
    let out;
    try {
      out = extractor.extract(tree, item.rel);
    } catch (err) {
      warnings.push(`${item.rel}: extract threw: ${err.message}`);
      continue;
    }
    if (out.errors && out.errors.length > 0) {
      for (const e of out.errors) warnings.push(`${item.rel}: ${e}`);
    }
    if (out.node) {
      if (!nodeIdSet.has(out.node[NODE.ID])) {
        nodes.push(out.node);
        nodeIdSet.add(out.node[NODE.ID]);
      }
    }
    for (const e of out.edges) edges.push(e);
  }

  // 6a) Phase 1c — cross-file edge resolution. After all per-file extractors
  //     have emitted `imports` edges with `intra-file-only` / `unverified`
  //     placeholder targets, walk each edge and try to rewrite it to a real
  //     file-node id at confidence `verified`. Pure, in-memory, no I/O.
  //     Opt-out via skipResolve = true (default false).
  let resolvedCount = 0;
  let unresolvedCount = 0;
  let finalEdges = edges;
  if (!skipResolve) {
    const r = resolveEdges({ nodes, edges, project_root: root });
    finalEdges = r.edges;
    resolvedCount = r.resolved_count;
    unresolvedCount = r.unresolved_count;
    if (!quiet) {
      const total = resolvedCount + unresolvedCount;
      process.stderr.write(
        `sextant: graph build — resolved ${resolvedCount}/${total} cross-file imports\n`,
      );
    }
  }

  // 6b) Assemble + stamp + validate.
  const graph = emptyGraph();
  graph[GRAPH.NODES] = nodes;
  graph[GRAPH.EDGES] = finalEdges;
  graph[GRAPH.BUILT_AT] = new Date().toISOString();
  graph[GRAPH.STATS] = { files: nodes.length, edges: finalEdges.length };

  const v = validateGraph(graph);
  if (!v.ok) {
    throw new Error(`graph build produced invalid graph: ${v.error}`);
  }

  // 7) Write the graph (atomic) and the .sextant-version sidecar.
  const graphDir = await ensureDurableDir(root, 'graph');
  const graphPath = path.join(graphDir, 'graph.json');
  await writeJsonAtomic(graphPath, graph);

  // .sextant-version sidecar at the durable base (per § 4.2 R1).
  const versionPath = path.join(durableBase(root), '.sextant-version');
  let existing = null;
  try {
    existing = (await fs.readFile(versionPath, 'utf8')).trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing !== String(SCHEMA_VERSION)) {
    await fs.writeFile(versionPath, `${SCHEMA_VERSION}\n`, 'utf8');
  }

  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  if (!quiet) {
    process.stderr.write(`sextant: graph build — ${nodes.length} files, ${finalEdges.length} edges in ${ms.toFixed(0)}ms\n`);
  }

  return {
    files: nodes.length,
    edges: finalEdges.length,
    ms,
    graphPath,
    warnings,
    resolved_count: resolvedCount,
    unresolved_count: unresolvedCount,
  };
}

/**
 * isGitRepo(root): returns true if `root` looks like the top of a git repo.
 *
 * Detects both regular repos (`.git/` is a directory) and worktrees /
 * submodules (`.git` is a file containing `gitdir: ...`).
 */
async function isGitRepo(root) {
  try {
    const stat = await fs.stat(path.join(root, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * listSourceFilesViaGit(root, opts): use `git ls-files` to enumerate
 * tracked + untracked-but-not-ignored files. This respects the user's
 * .gitignore so generated dirs (`proto-gen/`, `out/`, `.next/`, ...) don't
 * flood the graph.
 *
 * Command: `git ls-files --cached --others --exclude-standard -z`
 *   --cached            : tracked files
 *   --others            : untracked files (so newly added files aren't missing)
 *   --exclude-standard  : respect .gitignore + .git/info/exclude + global excludes
 *   -z                  : NUL-terminate (handles filenames with newlines / spaces)
 *
 * After receiving the file list, apply the same filters as listSourceFiles:
 *   - filter by extension
 *   - filter by hardcoded excludes (safety net: a user could `git add -f
 *     node_modules/`, but we still want to drop those for graph purposes)
 *   - filter by excludeSuffixes (e.g. `.egg-info` dirs)
 *
 * Throws on git error (not in a git repo, git not installed, command timeout,
 * non-zero exit). Caller is expected to fall back to the walker.
 *
 * @returns {Promise<string[]>} sorted relative paths (POSIX-style)
 */
async function listSourceFilesViaGit(root, { extensions, excludes, excludeSuffixes }) {
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, timeout: 5000, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdoutBuf) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdoutBuf);
      },
    );
  });

  // -z output: NUL-separated, no trailing NUL guarantee (some git versions
  // do emit one). Filter out empty strings to handle both.
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout);
  const raw = text.split('\0').filter((s) => s.length > 0);

  const extSet = new Set(extensions);
  const excludeSet = excludes instanceof Set ? excludes : new Set(excludes ?? []);
  const sufList = Array.isArray(excludeSuffixes) ? excludeSuffixes : [];

  const out = [];
  for (const rel of raw) {
    // Normalise to POSIX separators. git already emits forward slashes even
    // on Windows, but be defensive.
    const norm = rel.split(path.sep).join('/');
    // Extension match.
    const ext = path.extname(norm);
    if (!extSet.has(ext)) continue;
    // Hardcoded skip-list applied to every path segment. Defensive against
    // `git add -f node_modules/foo.js` and against the `.git/` directory
    // itself (which git wouldn't list, but the dotfile rule should still
    // apply to other top-level dotdirs we explicitly exclude).
    const segs = norm.split('/');
    let skip = false;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (excludeSet.has(seg)) { skip = true; break; }
      if (sufList.length > 0 && sufList.some((suf) => seg.endsWith(suf))) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    out.push(norm);
  }
  out.sort();
  return out;
}

/**
 * listSourceFiles(root, opts): enumerate source files under root.
 *
 * Two strategies, tried in order:
 *   1. If `root/.git` exists and `SEXTANT_GRAPH_USE_GITIGNORE` is not `0`,
 *      use `git ls-files` to enumerate tracked + untracked-but-not-ignored
 *      files. This respects the user's `.gitignore` so we don't flood the
 *      graph with generated code in monorepos.
 *   2. Otherwise (no `.git`, or git failed), recursively walk the tree with
 *      the hardcoded excludes list.
 *
 * The walker path skips:
 *   - directories whose basename is in `excludes`
 *   - any entry whose name begins with '.' (dotfile / dot-dir)
 *   - symlinks (avoids loops on monorepos with cross-package symlinks)
 *
 * Set `SEXTANT_GRAPH_USE_GITIGNORE=0` to force the walker even inside a git
 * repo (useful when you have files committed in `.gitignored` paths via
 * `git add -f` that you nonetheless want excluded from the graph).
 *
 * @param {string} root absolute project root
 * @param {Object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {string[]} [opts.excludes]
 * @param {string[]} [opts.excludeSuffixes]
 * @returns {Promise<string[]>} relative file paths (POSIX-style separators)
 */
export async function listSourceFiles(root, opts = {}) {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const excludes = new Set(opts.excludes ?? DEFAULT_EXCLUDES);
  // Suffix excludes apply to directory base-names (e.g. `*.egg-info`).
  // Callers can override via opts.excludeSuffixes; default matches Python build
  // artefacts.
  const excludeSuffixes = opts.excludeSuffixes ?? DEFAULT_EXCLUDE_SUFFIXES;

  // Try git-aware path first; fall back to recursive walker.
  if (process.env.SEXTANT_GRAPH_USE_GITIGNORE !== '0' && await isGitRepo(root)) {
    try {
      return await listSourceFilesViaGit(root, { extensions, excludes, excludeSuffixes });
    } catch (err) {
      // Fall through to walker. Log to stderr so users know why a giant
      // generated dir is now in the graph.
      process.stderr.write(
        `sextant: graph: git ls-files failed (${err.message}); falling back to recursive walker\n`,
      );
    }
  }

  const out = [];
  await walkDir(root, '', { extensions, excludes, excludeSuffixes, out });
  out.sort();
  return out;
}

async function walkDir(absRoot, relDir, ctx) {
  let entries;
  try {
    entries = await fs.readdir(path.join(absRoot, relDir), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return;
    throw err;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (ctx.excludes.has(ent.name)) continue;
      // Suffix-match exclusions (Python's *.egg-info build dirs).
      if (ctx.excludeSuffixes && ctx.excludeSuffixes.some((suf) => ent.name.endsWith(suf))) continue;
      await walkDir(absRoot, rel, ctx);
      continue;
    }
    if (ent.isFile()) {
      const ext = extname(ent.name);
      if (ctx.extensions.includes(ext)) {
        ctx.out.push(rel);
      }
    }
  }
}

function extname(name) {
  return path.extname(name);
}

/**
 * readSourceFiles(items, opts): read source files in parallel (bounded).
 *
 * @param {{rel:string, abs:string}[]} items
 * @param {Object} [opts]
 * @param {number} [opts.concurrency=64]
 * @param {string[]} [opts.warnings] - mutated to receive per-file read errors
 * @param {number} [opts.maxFileBytes] - if set, files whose stat.size exceeds
 *   this are skipped (result entry carries `error: 'oversized'`). When not
 *   provided, no size check is performed.
 * @param {string[]} [opts.oversizedSkipped] - if provided, the rel paths of
 *   any oversized files are appended here so callers can emit a one-shot
 *   summary.
 * @returns {Promise<{rel:string, source:string, error?:string}[]>}
 *   Output is in the same order as the input items.
 */
export async function readSourceFiles(items, opts = {}) {
  const concurrency = opts.concurrency ?? READ_CONCURRENCY;
  const warnings = opts.warnings;
  const maxFileBytes = (typeof opts.maxFileBytes === 'number' && opts.maxFileBytes > 0)
    ? opts.maxFileBytes : null;
  const oversizedSkipped = Array.isArray(opts.oversizedSkipped) ? opts.oversizedSkipped : null;
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i];
      // Pre-read size check. We stat before reading so a single 200MB
      // minified bundle can't OOM the read step. The stat is cheap relative
      // to the parallel-read latency it might otherwise allocate against.
      if (maxFileBytes !== null) {
        try {
          const st = await fs.stat(item.abs);
          if (typeof st.size === 'number' && st.size > maxFileBytes) {
            if (oversizedSkipped) oversizedSkipped.push(item.rel);
            results[i] = { rel: item.rel, source: '', error: 'oversized' };
            continue;
          }
        } catch (err) {
          // stat failed — fall through to readFile, which will produce its
          // own error entry. We don't double-warn here.
        }
      }
      try {
        const source = await fs.readFile(item.abs, 'utf8');
        results[i] = { rel: item.rel, source };
      } catch (err) {
        if (warnings) warnings.push(`${item.rel}: read failed: ${err.message}`);
        results[i] = { rel: item.rel, source: '', error: err.message };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// extensionsFromPatterns: given a list of glob patterns, extract the set of
// extensions to walk. We honour two shapes: '**/*.<ext>' and '*.<ext>'.
function extensionsFromPatterns(patterns) {
  const out = new Set();
  for (const p of patterns) {
    const m = p.match(/\*\.([A-Za-z0-9]+)$/);
    if (m) {
      out.add(`.${m[1]}`);
    }
  }
  if (out.size === 0) {
    for (const ext of DEFAULT_EXTENSIONS) out.add(ext);
  }
  return [...out];
}
