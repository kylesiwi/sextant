// lib/inject/promptExtract.mjs — UserPromptSubmit Phase 6 helpers.
//
// Three pure functions consumed by lib/hooks/userPromptSubmit.mjs's Phase 6
// preload step (§ 5.2 + § 8 Phase 6):
//
//   - extractPaths(prompt): regex-scrape POSIX-style file paths whose
//     extension is one of a small known set (ts/tsx/js/jsx/mjs/cjs/py/go/rs/
//     md/json/yaml/yml/toml). Returns a unique, posix-normalized list. No
//     glob expansion — the agent gave us literals, we trust them as-is.
//
//   - extractSymbols(prompt): scrape capitalized identifiers >= 3 chars
//     after filtering a small stoplist of common English words that would
//     otherwise be flagged as candidate identifiers. Returns a unique list.
//
//   - filterToGraph(symbols, graph): given a parsed graph (or null), keep
//     only those symbols that appear in some file node's `symbols` array.
//     Returns array of { symbol, nodeId } pairs. If `graph` is null or
//     malformed, returns []. This is the gate that prevents a runaway
//     prompt mentioning "Foo" from preloading a file unless we actually
//     have a node whose symbols include that name.
//
// Design constraints:
//   - Pure. No I/O. Easy to unit-test.
//   - No regex catastrophic backtracking: keep all classes simple and
//     character-bounded.
//   - Path detection is intentionally conservative (extension-anchored) so
//     normal English prose doesn't pull in noise like "node.js" or "foo.bar".
//   - Symbol detection caps the stoplist at ~30 words — enough to nuke the
//     obvious sentence-starters without false negatives on real identifiers
//     like "Set" or "Map" (which we DO want to extract if used as types).

import { GRAPH, NODE } from '../graph/schema.mjs';

// Known file extensions we'll match against. Keep this list explicit; an
// unknown extension is fine to miss in Phase 6 — the agent will Read it and
// the per-Read block fires as usual.
const PATH_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|ya?ml|toml)\b/g;

// Capitalized identifier regex. ASCII only; word boundary on both sides so
// we don't match suffix substrings of other identifiers. >=3 chars after the
// leading uppercase character → minimum length 3.
const SYMBOL_RE = /\b[A-Z][a-zA-Z0-9_]{2,}\b/g;

// Common English words that look like identifiers under the SYMBOL_RE. The
// list is deliberately short; we'd rather over-include false positives at the
// symbol-detection stage than risk filtering out a real identifier the agent
// cares about. filterToGraph() acts as the second gate.
const STOPLIST = new Set([
  'The', 'And', 'For', 'But', 'Or', 'Not', 'You', 'This', 'That',
  'These', 'Those', 'Run', 'Get', 'Set', 'Make', 'New', 'Old', 'Add',
  'Use', 'Was', 'Are', 'Has', 'Have', 'Will', 'Would', 'Could', 'Should',
  'Can', 'May', 'Per', 'Via', 'When', 'Where', 'What', 'Why', 'How',
  'All', 'Any', 'Some', 'None', 'One', 'Two', 'See', 'Try',
]);

/**
 * extractPaths(prompt): scrape POSIX-style file paths with a known extension.
 *
 * @param {string} prompt
 * @returns {string[]} unique, posix-normalized paths in source order.
 */
export function extractPaths(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const m of prompt.matchAll(PATH_RE)) {
    // Normalise to posix separators (the regex only emits '/' but be safe).
    let p = m[0].split(/\\+/).join('/');
    // Strip a leading './' so 'src/a.ts' and './src/a.ts' dedupe.
    if (p.startsWith('./')) p = p.slice(2);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * extractSymbols(prompt): scrape capitalized identifiers >=3 chars after
 * filtering the stoplist of common English words. Order: source order.
 *
 * @param {string} prompt
 * @returns {string[]} unique identifier candidates in source order.
 */
export function extractSymbols(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const m of prompt.matchAll(SYMBOL_RE)) {
    const tok = m[0];
    if (STOPLIST.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * filterToGraph(symbols, graph): keep only the symbols that appear in some
 * file node's `symbols` array. Returns parallel { symbol, nodeId } pairs.
 *
 * @param {string[]} symbols
 * @param {Object|null} graph
 * @returns {Array<{ symbol: string, nodeId: string }>}
 */
export function filterToGraph(symbols, graph) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  if (!graph || typeof graph !== 'object') return [];
  const nodes = graph[GRAPH.NODES];
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  // Build a map of symbol → first nodeId it appears in. The "first" tie-break
  // is source order of the graph's nodes array (deterministic).
  const symToNode = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const syms = n[NODE.SYMBOLS];
    if (!Array.isArray(syms)) continue;
    for (const s of syms) {
      if (typeof s !== 'string' || s.length === 0) continue;
      if (symToNode.has(s)) continue; // first occurrence wins
      symToNode.set(s, n[NODE.ID]);
    }
  }

  const out = [];
  for (const sym of symbols) {
    const nodeId = symToNode.get(sym);
    if (nodeId) out.push({ symbol: sym, nodeId });
  }
  return out;
}
