#!/usr/bin/env node
// verify.mjs — Sextant Phase 0 health check.
//
// Two call sites:
//   1. Local dev: `node verify.mjs` from the plugin repo root.
//   2. Runtime:   `/sextant:doctor` runs `node ${CLAUDE_PLUGIN_ROOT}/verify.mjs`.
//
// Output contract:
//   - First line: banner "sextant verify v0.1.0".
//   - One line per check:  "[OK] <name>" | "[FAIL] <name>: <reason>" | "[WARN] <name>: <reason>"
//   - Final line: "RESULT: ok" | "RESULT: warn (<N>)" | "RESULT: fail (<N>)"
//   - Exit 0 on ok/warn, exit 1 on fail.
//
// Design constraints:
//   - Builtins only. No third-party deps. No YAML library — frontmatter is
//     parsed via small regex.
//   - Fast: should complete in well under 200 ms cold.
//   - Self-locating: works whether invoked from the plugin root or from
//     CLAUDE_PLUGIN_ROOT (we resolve paths relative to this file).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const VERSION = '0.1.0';

// Plugin root = directory containing this file. The script must always sit at
// the repo top level so this stays true.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- result aggregation ----------------------------------------------------

const results = [];
function ok(name)            { results.push({ status: 'OK',   name }); }
function fail(name, reason)  { results.push({ status: 'FAIL', name, reason }); }
function warn(name, reason)  { results.push({ status: 'WARN', name, reason }); }

// --- small utilities -------------------------------------------------------

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, err };
  }
}

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

function fileExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function syntaxCheck(p) {
  // `node --check` does a parse-only pass. Exit 0 = OK; any nonzero =
  // syntax error (the message is on stderr).
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stderr: (r.stderr ?? '').trim(),
  };
}

// Parse `---\n...\n---` YAML-ish frontmatter from a markdown file. We don't
// need a real YAML parser — `key: value` lines, one per line, are enough for
// the agent templates (name, model, label, etc.). Returns { found: bool, fields }.
function parseFrontmatter(filePath) {
  let body;
  try { body = fs.readFileSync(filePath, 'utf8'); }
  catch { return { found: false, fields: {}, err: 'unreadable' }; }
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { found: false, fields: {}, err: 'no frontmatter' };
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    // Strip surrounding quotes if present, otherwise keep literal value.
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fields[mm[1]] = v;
  }
  return { found: true, fields };
}

// --- individual checks ----------------------------------------------------

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major)) {
    fail('node-version', `unparseable: ${process.versions.node}`);
    return;
  }
  if (major < 20) {
    fail('node-version', `node ${process.versions.node} < 20`);
    return;
  }
  ok('node-version');
}

function checkManifest() {
  const p = path.join(HERE, '.claude-plugin', 'plugin.json');
  if (!fileExists(p)) {
    fail('plugin-manifest', `missing: ${p}`);
    return null;
  }
  const r = readJsonSafe(p);
  if (!r.ok) {
    fail('plugin-manifest', `parse error: ${r.err.message}`);
    return null;
  }
  const obj = r.value;
  const missing = [];
  if (!obj.name)    missing.push('name');
  if (!obj.version) missing.push('version');
  if (missing.length) {
    fail('plugin-manifest', `missing field(s): ${missing.join(',')}`);
    return null;
  }
  ok('plugin-manifest');
  return obj;
}

function checkInlineHooks(manifest) {
  if (!manifest) {
    fail('inline-hooks', 'manifest unavailable');
    return;
  }
  if (!manifest.hooks || typeof manifest.hooks !== 'object') {
    fail('inline-hooks', 'manifest.hooks missing or not an object');
    return;
  }
  // Required by R14: the manifest must inline-declare every event the
  // dispatcher knows how to handle. We assert the Phase 0 minimum here;
  // FileChanged / SubagentStop / etc. are bonus.
  const required = [
    'SessionStart', 'UserPromptSubmit',
    'PreToolUse', 'PostToolUse',
    'PreCompact', 'PostCompact', 'Stop',
  ];
  const missing = required.filter((e) => !(e in manifest.hooks));
  if (missing.length) {
    fail('inline-hooks', `missing event(s): ${missing.join(',')}`);
    return;
  }
  ok('inline-hooks');
}

function checkHookCommands(manifest) {
  if (!manifest || !manifest.hooks) {
    fail('hook-commands', 'manifest.hooks unavailable');
    return;
  }
  // Every command must match the literal "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs <Event>"
  // pattern. Anything else is a bug (e.g., a stale path or a leftover from a
  // hooks/<event>.sh experiment).
  const errors = [];
  for (const [eventName, matchers] of Object.entries(manifest.hooks)) {
    if (!Array.isArray(matchers)) {
      errors.push(`${eventName}: not an array`);
      continue;
    }
    for (const matcher of matchers) {
      if (!matcher || !Array.isArray(matcher.hooks)) {
        errors.push(`${eventName}: matcher.hooks missing`);
        continue;
      }
      for (const h of matcher.hooks) {
        if (!h || h.type !== 'command') {
          errors.push(`${eventName}: hook.type !== "command"`);
          continue;
        }
        const expected = `\${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs ${eventName}`;
        if (h.command !== expected) {
          errors.push(`${eventName}: command="${h.command}" (expected "${expected}")`);
        }
      }
    }
  }
  if (errors.length) {
    fail('hook-commands', errors.slice(0, 3).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''));
    return;
  }
  ok('hook-commands');
}

function checkCliExecutable() {
  const p = path.join(HERE, 'bin', 'cli.mjs');
  if (!fileExists(p)) {
    fail('cli-executable', `missing: ${p}`);
    return;
  }
  if (process.platform !== 'win32' && !fileExecutable(p)) {
    fail('cli-executable', `not executable: ${p}`);
    return;
  }
  ok('cli-executable');
}

function checkAgents() {
  const dir = path.join(HERE, 'agents');
  const required = ['sextant-reviewer.md', 'sextant-bugcapturer.md', 'sextant-richgraph.md'];
  let failures = 0;
  let labelWarns = 0;
  for (const name of required) {
    const p = path.join(dir, name);
    if (!fileExists(p)) {
      fail(`agent:${name}`, 'missing');
      failures++;
      continue;
    }
    const fm = parseFrontmatter(p);
    if (!fm.found) {
      fail(`agent:${name}`, `no YAML frontmatter (${fm.err})`);
      failures++;
      continue;
    }
    if (!fm.fields.name)  { fail(`agent:${name}`, 'frontmatter missing "name"');  failures++; continue; }
    if (!fm.fields.model) { fail(`agent:${name}`, 'frontmatter missing "model"'); failures++; continue; }
    if (!fm.fields.label) {
      // label is undocumented per § 10.10 — warn so we know if we drop it.
      warn(`agent:${name}`, 'frontmatter missing "label" (undocumented but useful)');
      labelWarns++;
      continue;
    }
    ok(`agent:${name}`);
  }
  // (Aggregate accounting is done by the consumer; we've already recorded
  // per-file results.)
  void failures; void labelWarns;
}

function checkSlashCommands() {
  const dir = path.join(HERE, 'commands');
  const required = ['init.md', 'doctor.md', 'import-bridge.md', 'check-conflicts.md'];
  for (const name of required) {
    const p = path.join(dir, name);
    if (!fileExists(p)) {
      fail(`command:${name}`, 'missing');
      continue;
    }
    ok(`command:${name}`);
  }
}

async function checkLibModules() {
  // Dynamic import via file:// URL so the script works regardless of cwd.
  const pathsUrl = pathToFileURL(path.join(HERE, 'lib', 'paths.mjs')).href;
  const stateUrl = pathToFileURL(path.join(HERE, 'lib', 'state.mjs')).href;
  try {
    const paths = await import(pathsUrl);
    const required = ['runtimeBase', 'durableBase', 'statuslineStatePath', 'hooksLogPath', 'runtimeFile', 'durableFile', 'ensureRuntimeDir', 'lockfilePath'];
    const missing = required.filter((k) => typeof paths[k] !== 'function');
    if (missing.length) {
      fail('lib:paths.mjs', `missing exports: ${missing.join(',')}`);
    } else {
      ok('lib:paths.mjs');
    }
  } catch (err) {
    fail('lib:paths.mjs', `import error: ${err.message}`);
  }
  try {
    const state = await import(stateUrl);
    const required = ['readState', 'withState', 'defaultState', 'resetTurnAndSession'];
    const missing = required.filter((k) => typeof state[k] !== 'function');
    if (missing.length) {
      fail('lib:state.mjs', `missing exports: ${missing.join(',')}`);
    } else {
      ok('lib:state.mjs');
    }
  } catch (err) {
    fail('lib:state.mjs', `import error: ${err.message}`);
  }
}

async function checkConflictsModule() {
  // Phase post-v1: predecessor / hook-collision detection (§ 11 R17).
  const libUrl = pathToFileURL(path.join(HERE, 'lib', 'conflicts.mjs')).href;
  try {
    const mod = await import(libUrl);
    if (typeof mod.detectConflicts !== 'function') {
      fail('lib:conflicts.mjs', 'missing export: detectConflicts');
    } else {
      ok('lib:conflicts.mjs');
    }
  } catch (err) {
    fail('lib:conflicts.mjs', `import error: ${err.message}`);
  }
  const cliPath = path.join(HERE, 'bin', 'conflicts.mjs');
  if (!fileExists(cliPath)) {
    fail('bin:conflicts.mjs', `missing: ${cliPath}`);
    return;
  }
  // Parse-only check — actually invoking it would launch a scan.
  const s = syntaxCheck(cliPath);
  if (!s.ok) {
    fail('bin:conflicts.mjs', `syntax error: ${s.stderr.split('\n')[0]}`);
    return;
  }
  ok('bin:conflicts.mjs');
}

function checkNoLegacyShellScripts() {
  // Per R15: status-line scripts are Node, not sh. A leftover .sh would
  // indicate a partial migration; warn so the dev notices.
  const dir = path.join(HERE, 'statusline');
  let leftovers = [];
  try {
    leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.sh'));
  } catch { /* dir missing handled elsewhere */ }
  if (leftovers.length) {
    warn('no-shell-scripts', `leftover .sh in statusline/: ${leftovers.join(',')}`);
    return;
  }
  ok('no-shell-scripts');
}

function checkNoHooksDir() {
  // Per R14: hooks are inline in plugin.json, no `hooks/` directory at root.
  const dir = path.join(HERE, 'hooks');
  if (fileExists(dir)) {
    warn('no-hooks-dir', `unexpected directory: ${dir}`);
    return;
  }
  ok('no-hooks-dir');
}

function checkGrammarWasm(checkName, fileName, minBytes) {
  // Vendored grammar — must be present and look like a real WASM blob
  // (not truncated). Cheap magic-number check guards against
  // `.gitkeep`-style placeholders too.
  const p = path.join(HERE, 'lib', 'graph', 'grammars', fileName);
  if (!fileExists(p)) {
    fail(checkName, `missing: ${p}`);
    return;
  }
  let size = 0;
  try { size = fs.statSync(p).size; }
  catch (err) {
    fail(checkName, `stat error: ${err.message}`);
    return;
  }
  if (size < minBytes) {
    fail(checkName, `too small: ${size} bytes (expected > ${minBytes} bytes)`);
    return;
  }
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (!(buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d)) {
      fail(checkName, `not a WebAssembly module (magic: ${buf.toString('hex')})`);
      return;
    }
  } catch (err) {
    fail(checkName, `magic-number check failed: ${err.message}`);
    return;
  }
  ok(checkName);
}

function checkTypescriptGrammarWasm() {
  // The current TS grammar weighs ~1.4 MB.
  checkGrammarWasm('wasm:typescript-grammar', 'typescript.wasm', 100 * 1024);
}

function checkJavascriptGrammarWasm() {
  // The current JS grammar weighs ~400 KB.
  checkGrammarWasm('wasm:javascript-grammar', 'javascript.wasm', 100 * 1024);
}

function checkPythonGrammarWasm() {
  // The current Python grammar weighs ~450 KB.
  checkGrammarWasm('wasm:python-grammar', 'python.wasm', 100 * 1024);
}

function checkGoGrammarWasm() {
  // The current Go grammar weighs ~210 KB.
  checkGrammarWasm('wasm:go-grammar', 'go.wasm', 100 * 1024);
}

function checkRustGrammarWasm() {
  // The current Rust grammar weighs ~1.1 MB.
  checkGrammarWasm('wasm:rust-grammar', 'rust.wasm', 100 * 1024);
}

function checkNodeModulesInstalled() {
  // Phase 1a brings in `web-tree-sitter` as a runtime dep. Until the plugin
  // ships a bundled build (see § 8 Phase 1b), users must run `npm install`
  // inside the plugin directory once after cloning. Detect the missing
  // install and tell them how to fix it.
  const pkgRoot = path.join(HERE, 'node_modules', 'web-tree-sitter');
  if (!fileExists(pkgRoot)) {
    fail(
      'node-modules:web-tree-sitter',
      `missing node_modules/web-tree-sitter — run \`npm install\` inside ${HERE}`,
    );
    return;
  }
  // Also confirm the runtime entry point resolves; a half-installed package
  // can have the directory without a useful entry.
  const entry = path.join(pkgRoot, 'web-tree-sitter.js');
  if (!fileExists(entry)) {
    fail(
      'node-modules:web-tree-sitter',
      `entry missing: ${entry} (try \`npm install\` to repair)`,
    );
    return;
  }
  ok('node-modules:web-tree-sitter');
}

function checkLunrInstalled() {
  // Phase 4 brings in `lunr` as a runtime dep for BM25 ranking over cerebrum
  // + bugs. Same install pattern as web-tree-sitter: the plugin user must run
  // `npm install` inside the plugin dir after cloning.
  const pkgRoot = path.join(HERE, 'node_modules', 'lunr');
  if (!fileExists(pkgRoot)) {
    fail(
      'node-modules:lunr',
      `missing node_modules/lunr — run \`npm install\` inside ${HERE}`,
    );
    return;
  }
  // package.json's `main` is lunr.js — fail loudly if it's gone.
  const entry = path.join(pkgRoot, 'lunr.js');
  if (!fileExists(entry)) {
    fail(
      'node-modules:lunr',
      `entry missing: ${entry} (try \`npm install\` to repair)`,
    );
    return;
  }
  ok('node-modules:lunr');
}

async function checkParserModule() {
  // Smoke-import lib/graph/parser.mjs and verify the public surface. We don't
  // load the WASM here (that'd be slow and would surface failures already
  // caught upstream by wasm:typescript-grammar / wasm:javascript-grammar /
  // node-modules:web-tree-sitter); we just check that the module parses,
  // imports cleanly, and exports the expected names. Parser exercise lives
  // in test/parser.test.mjs.
  const url = pathToFileURL(path.join(HERE, 'lib', 'graph', 'parser.mjs')).href;
  try {
    const mod = await import(url);
    const required = ['loadTypescriptParser', 'parseTypescript', 'loadJavascriptParser', 'parseJavascript', 'loadPythonParser', 'parsePython', 'loadGoParser', 'parseGo', 'loadRustParser', 'parseRust'];
    const missing = required.filter((k) => typeof mod[k] !== 'function');
    if (missing.length) {
      fail('lib:graph/parser.mjs', `missing exports: ${missing.join(',')}`);
      return;
    }
    ok('lib:graph/parser.mjs');
  } catch (err) {
    fail('lib:graph/parser.mjs', `import error: ${err.message}`);
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  process.stdout.write(`sextant verify v${VERSION}\n`);

  checkNode();
  const manifest = checkManifest();
  checkInlineHooks(manifest);
  checkHookCommands(manifest);
  checkCliExecutable();
  checkAgents();
  checkSlashCommands();
  await checkLibModules();
  await checkConflictsModule();
  checkNoLegacyShellScripts();
  checkNoHooksDir();
  checkTypescriptGrammarWasm();
  checkJavascriptGrammarWasm();
  checkPythonGrammarWasm();
  checkGoGrammarWasm();
  checkRustGrammarWasm();
  checkNodeModulesInstalled();
  checkLunrInstalled();
  await checkParserModule();

  let fails = 0, warns = 0;
  for (const r of results) {
    if (r.status === 'OK') {
      process.stdout.write(`[OK] ${r.name}\n`);
    } else if (r.status === 'WARN') {
      warns++;
      process.stdout.write(`[WARN] ${r.name}: ${r.reason}\n`);
    } else {
      fails++;
      process.stdout.write(`[FAIL] ${r.name}: ${r.reason}\n`);
    }
  }

  if (fails > 0) {
    process.stdout.write(`RESULT: fail (${fails})\n`);
    process.exit(1);
  }
  if (warns > 0) {
    process.stdout.write(`RESULT: warn (${warns})\n`);
    process.exit(0);
  }
  process.stdout.write('RESULT: ok\n');
  process.exit(0);
}

main().catch((err) => {
  // Anything we missed catching inside a check — bubble out as a single
  // top-level FAIL so the output contract is honored.
  process.stdout.write(`[FAIL] verify-self: ${err.message}\n`);
  process.stdout.write('RESULT: fail (1)\n');
  process.exit(1);
});
