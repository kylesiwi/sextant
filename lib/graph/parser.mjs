// lib/graph/parser.mjs — tree-sitter parser bootstrap.
//
// This module is the single entry point to the WASM-backed tree-sitter
// runtime. All downstream Phase 1a+ code (extractors, the graph builder) imports
// from here rather than touching `web-tree-sitter` directly — that way swapping
// the parser substrate is a one-file change.
//
// Lazy semantics:
//   - `Parser.init()` is only invoked once, on first call to any
//     `load*Parser()` function. The init promise is reused across concurrent
//     callers to avoid a double-init race.
//   - Each language's Parser is cached independently. Subsequent calls return
//     the same instance — by design, tree-sitter Parser objects are reusable.
//
// Failure mode:
//   - If the runtime WASM or grammar WASM can't be loaded (missing file,
//     corrupt module, ABI mismatch), we log a single line to stderr and return
//     `null`. Callers must handle null — they should treat it as "skip parser
//     work, leave entities empty" rather than crashing the hook.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRAMMARS_DIR = path.join(__dirname, 'grammars');
const TS_WASM_PATH = path.join(GRAMMARS_DIR, 'typescript.wasm');
const JS_WASM_PATH = path.join(GRAMMARS_DIR, 'javascript.wasm');
const PY_WASM_PATH = path.join(GRAMMARS_DIR, 'python.wasm');
const GO_WASM_PATH = path.join(GRAMMARS_DIR, 'go.wasm');
const RS_WASM_PATH = path.join(GRAMMARS_DIR, 'rust.wasm');

// Shared init promise — multiple concurrent `load*Parser()` calls
// during plugin startup must not call `Parser.init()` twice.
let _initPromise = null;

// Cached parser instances + load promises. Parser construction is cheap once
// init+language are loaded, but the language load itself involves a fs read +
// WASM compile, so caching the whole result is worthwhile.
let _tsParser = null;
let _tsParserPromise = null;
let _jsParser = null;
let _jsParserPromise = null;
let _pyParser = null;
let _pyParserPromise = null;
let _goParser = null;
let _goParserPromise = null;
let _rsParser = null;
let _rsParserPromise = null;

function ensureInitialized() {
  if (_initPromise) return _initPromise;
  _initPromise = Parser.init().catch((err) => {
    // Reset so the next call can retry; we don't want a transient I/O failure
    // to permanently disable the parser for the life of the process.
    _initPromise = null;
    throw err;
  });
  return _initPromise;
}

/**
 * Load (and cache) a tree-sitter Parser configured for TypeScript.
 *
 * @returns {Promise<import('web-tree-sitter').Parser | null>}
 *   The configured parser, or `null` if loading failed (see file header).
 */
export async function loadTypescriptParser() {
  if (_tsParser) return _tsParser;
  if (_tsParserPromise) return _tsParserPromise;
  _tsParserPromise = (async () => {
    try {
      // Fail fast if the vendored WASM blob is missing — Language.load gives
      // an unhelpful "RuntimeError: ... incompatible" otherwise.
      if (!fs.existsSync(TS_WASM_PATH)) {
        throw new Error(`grammar wasm not found: ${TS_WASM_PATH}`);
      }
      await ensureInitialized();
      const language = await Language.load(TS_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(language);
      _tsParser = parser;
      return parser;
    } catch (err) {
      process.stderr.write(`sextant: tree-sitter load failed: ${err.message}\n`);
      // Reset the promise so callers can retry (e.g. after the user reinstalls
      // dependencies via /sextant:doctor). Leave _tsParser unset.
      _tsParserPromise = null;
      return null;
    }
  })();
  return _tsParserPromise;
}

/**
 * Load (and cache) a tree-sitter Parser configured for JavaScript.
 *
 * Same shape as loadTypescriptParser(); separate Parser+Language so the two
 * languages can coexist in one process without contention. Parsers are not
 * thread-safe per upstream tree-sitter, but a single-language Parser is
 * reusable across many parse() calls — the cached instance is fine here.
 *
 * @returns {Promise<import('web-tree-sitter').Parser | null>}
 *   The configured parser, or `null` if loading failed.
 */
export async function loadJavascriptParser() {
  if (_jsParser) return _jsParser;
  if (_jsParserPromise) return _jsParserPromise;
  _jsParserPromise = (async () => {
    try {
      if (!fs.existsSync(JS_WASM_PATH)) {
        throw new Error(`grammar wasm not found: ${JS_WASM_PATH}`);
      }
      await ensureInitialized();
      const language = await Language.load(JS_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(language);
      _jsParser = parser;
      return parser;
    } catch (err) {
      process.stderr.write(`sextant: tree-sitter load failed: ${err.message}\n`);
      _jsParserPromise = null;
      return null;
    }
  })();
  return _jsParserPromise;
}

/**
 * Load (and cache) a tree-sitter Parser configured for Python.
 *
 * Same shape as loadTypescriptParser(); separate Parser+Language so all three
 * languages can coexist in one process without contention.
 *
 * @returns {Promise<import('web-tree-sitter').Parser | null>}
 *   The configured parser, or `null` if loading failed.
 */
export async function loadPythonParser() {
  if (_pyParser) return _pyParser;
  if (_pyParserPromise) return _pyParserPromise;
  _pyParserPromise = (async () => {
    try {
      if (!fs.existsSync(PY_WASM_PATH)) {
        throw new Error(`grammar wasm not found: ${PY_WASM_PATH}`);
      }
      await ensureInitialized();
      const language = await Language.load(PY_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(language);
      _pyParser = parser;
      return parser;
    } catch (err) {
      process.stderr.write(`sextant: tree-sitter load failed: ${err.message}\n`);
      _pyParserPromise = null;
      return null;
    }
  })();
  return _pyParserPromise;
}

/**
 * Load (and cache) a tree-sitter Parser configured for Go.
 *
 * Same shape as loadTypescriptParser(); separate Parser+Language so all four
 * languages can coexist in one process without contention.
 *
 * @returns {Promise<import('web-tree-sitter').Parser | null>}
 *   The configured parser, or `null` if loading failed.
 */
export async function loadGoParser() {
  if (_goParser) return _goParser;
  if (_goParserPromise) return _goParserPromise;
  _goParserPromise = (async () => {
    try {
      if (!fs.existsSync(GO_WASM_PATH)) {
        throw new Error(`grammar wasm not found: ${GO_WASM_PATH}`);
      }
      await ensureInitialized();
      const language = await Language.load(GO_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(language);
      _goParser = parser;
      return parser;
    } catch (err) {
      process.stderr.write(`sextant: tree-sitter load failed: ${err.message}\n`);
      _goParserPromise = null;
      return null;
    }
  })();
  return _goParserPromise;
}

/**
 * Load (and cache) a tree-sitter Parser configured for Rust.
 *
 * Same shape as loadTypescriptParser(); separate Parser+Language so all five
 * languages can coexist in one process without contention.
 *
 * @returns {Promise<import('web-tree-sitter').Parser | null>}
 *   The configured parser, or `null` if loading failed.
 */
export async function loadRustParser() {
  if (_rsParser) return _rsParser;
  if (_rsParserPromise) return _rsParserPromise;
  _rsParserPromise = (async () => {
    try {
      if (!fs.existsSync(RS_WASM_PATH)) {
        throw new Error(`grammar wasm not found: ${RS_WASM_PATH}`);
      }
      await ensureInitialized();
      const language = await Language.load(RS_WASM_PATH);
      const parser = new Parser();
      parser.setLanguage(language);
      _rsParser = parser;
      return parser;
    } catch (err) {
      process.stderr.write(`sextant: tree-sitter load failed: ${err.message}\n`);
      _rsParserPromise = null;
      return null;
    }
  })();
  return _rsParserPromise;
}

/**
 * Parse a TypeScript source string with a previously-loaded parser.
 *
 * Synchronous once the parser is loaded — the underlying tree-sitter parse is
 * not asynchronous. A null parser short-circuits to null so callers can write
 * `const tree = parseTypescript(await loadTypescriptParser(), src)` and handle
 * the null tree uniformly.
 *
 * @param {import('web-tree-sitter').Parser | null} parser
 * @param {string} source
 * @returns {import('web-tree-sitter').Tree | null}
 */
export function parseTypescript(parser, source) {
  if (!parser) return null;
  return parser.parse(source);
}

/**
 * Parse a JavaScript source string with a previously-loaded parser.
 *
 * Same shape as parseTypescript(); the only reason it's a separate function is
 * intent — callers can read which language they're parsing without needing
 * comments.
 *
 * @param {import('web-tree-sitter').Parser | null} parser
 * @param {string} source
 * @returns {import('web-tree-sitter').Tree | null}
 */
export function parseJavascript(parser, source) {
  if (!parser) return null;
  return parser.parse(source);
}

/**
 * Parse a Python source string with a previously-loaded parser.
 *
 * Same shape as parseTypescript(); see notes above.
 *
 * @param {import('web-tree-sitter').Parser | null} parser
 * @param {string} source
 * @returns {import('web-tree-sitter').Tree | null}
 */
export function parsePython(parser, source) {
  if (!parser) return null;
  return parser.parse(source);
}

/**
 * Parse a Go source string with a previously-loaded parser.
 *
 * Same shape as parseTypescript(); see notes above.
 *
 * @param {import('web-tree-sitter').Parser | null} parser
 * @param {string} source
 * @returns {import('web-tree-sitter').Tree | null}
 */
export function parseGo(parser, source) {
  if (!parser) return null;
  return parser.parse(source);
}

/**
 * Parse a Rust source string with a previously-loaded parser.
 *
 * Same shape as parseTypescript(); see notes above.
 *
 * @param {import('web-tree-sitter').Parser | null} parser
 * @param {string} source
 * @returns {import('web-tree-sitter').Tree | null}
 */
export function parseRust(parser, source) {
  if (!parser) return null;
  return parser.parse(source);
}

// --- test-only helpers -----------------------------------------------------
//
// Exposed so the smoke test in test/parser.test.mjs can clear cached state
// between cases. Not part of the public API; downstream code MUST NOT use
// these — they exist to make the unit tests deterministic.

/** @internal */
export function __resetCacheForTests() {
  _tsParser = null;
  _tsParserPromise = null;
  _jsParser = null;
  _jsParserPromise = null;
  _pyParser = null;
  _pyParserPromise = null;
  _goParser = null;
  _goParserPromise = null;
  _rsParser = null;
  _rsParserPromise = null;
  _initPromise = null;
}

/** @internal */
export function __getCachedParserForTests() {
  return _tsParser;
}

/** @internal */
export function __getCachedJavascriptParserForTests() {
  return _jsParser;
}

/** @internal */
export function __getCachedPythonParserForTests() {
  return _pyParser;
}

/** @internal */
export function __getCachedGoParserForTests() {
  return _goParser;
}

/** @internal */
export function __getCachedRustParserForTests() {
  return _rsParser;
}
