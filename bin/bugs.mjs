#!/usr/bin/env node
// bin/bugs.mjs — Sextant bug-store CLI multiplexer.
//
// Backs /sextant:bug-log + /sextant:bug-search. Subcommands:
//
//   log     --file <path> --error "<msg>" --root-cause "<text>" --fix "<text>"
//           [--symbol <name>] [--tags <a,b,c>] [--root <path>]
//
//     Append a new bug entry to .sextant/bugs.json. Allocates id 'bug-<N+1>'
//     (N = current count), sets ts to now, session_id from
//     SEXTANT_SESSION_ID (env) or the literal 'cli'. Prints the allocated id
//     on stdout.
//
//   search  --file <path> [--symbol <name>] [--root <path>]
//
//     Print one line per matching entry: '<id> [<file>:<graph_node>] <error_message>'.
//
//   list    [--open-only] [--root <path>]
//
//     Same render shape as search but lists everything (or just unfixed).
//
// Exit codes:
//   0 — subcommand succeeded.
//   1 — error (missing required flag, etc.).
//   2 — unknown subcommand or arg parse error.
//
// Path resolution:
//   --root defaults to $PWD. The store is <root>/.sextant/bugs.json.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableBase } from '../lib/paths.mjs';
import {
  readBugs,
  addBug,
  findBugsForFile,
  findBugsForSymbol,
} from '../lib/stores/bugs.mjs';

const USAGE = `Usage: bugs <subcommand> [options]

Subcommands:
  log     --file <path> --error "<msg>" --root-cause "<text>" --fix "<text>"
          [--symbol <name>] [--tags <a,b,c>]
  search  --file <path> [--symbol <name>]
  list    [--open-only]

Global options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  -h, --help      Print this message.`;

function parseArgs(argv) {
  const out = {
    root: null,
    file: null,
    error: null,
    rootCause: null,
    fix: null,
    symbol: null,
    tags: null,
    openOnly: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--error') out.error = argv[++i];
    else if (a === '--root-cause') out.rootCause = argv[++i];
    else if (a === '--fix') out.fix = argv[++i];
    else if (a === '--symbol') out.symbol = argv[++i];
    else if (a === '--tags') out.tags = argv[++i];
    else if (a === '--open-only') out.openOnly = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`bugs: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

function parseTagsCSV(csv) {
  if (typeof csv !== 'string' || csv.length === 0) return [];
  return csv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function sessionIdFromEnv() {
  const v = process.env.SEXTANT_SESSION_ID;
  return (typeof v === 'string' && v.length > 0) ? v : 'cli';
}

function renderEntryLine(entry) {
  const id = entry.id ?? '<no-id>';
  const file = entry.file ?? '';
  const node = entry.graph_node ?? '';
  const err = entry.error_message ?? '';
  return `${id} [${file}:${node}] ${err}`;
}

// --- log -------------------------------------------------------------------

async function cmdLog(rootDir, args) {
  if (!args.file || args.file.length === 0) {
    process.stderr.write('bugs log: --file is required\n');
    return 1;
  }
  if (!args.error || args.error.length === 0) {
    process.stderr.write('bugs log: --error is required\n');
    return 1;
  }
  if (!args.rootCause || args.rootCause.length === 0) {
    process.stderr.write('bugs log: --root-cause is required\n');
    return 1;
  }
  if (!args.fix || args.fix.length === 0) {
    process.stderr.write('bugs log: --fix is required\n');
    return 1;
  }

  const base = durableBase(rootDir);
  const entry = {
    ts: new Date().toISOString(),
    session_id: sessionIdFromEnv(),
    file: args.file,
    error_message: args.error,
    root_cause: args.rootCause,
    fix: args.fix,
    fix_verified: false,
    verified_ts: null,
    verified_by: null,
    tags: parseTagsCSV(args.tags),
  };
  // --symbol pre-tags the bug; PostToolUse sweep would have arrived at the
  // same result, but allowing the caller to set it directly is useful when
  // the agent already knows the affected symbol.
  if (args.symbol && args.symbol.length > 0) {
    entry.graph_node = args.symbol;
    entry.graph_node_confidence = 'symbol-match';
  }

  const saved = await addBug(base, entry);
  process.stdout.write(`${saved.id}\n`);
  return 0;
}

// --- search ----------------------------------------------------------------

async function cmdSearch(rootDir, args) {
  if (!args.file || args.file.length === 0) {
    process.stderr.write('bugs search: --file is required\n');
    return 1;
  }
  const base = durableBase(rootDir);
  const bugs = await readBugs(base);
  const matches = args.symbol
    ? findBugsForSymbol(bugs, args.file, args.symbol)
    : findBugsForFile(bugs, args.file);
  for (const m of matches) {
    process.stdout.write(`${renderEntryLine(m)}\n`);
  }
  return 0;
}

// --- list ------------------------------------------------------------------

async function cmdList(rootDir, args) {
  const base = durableBase(rootDir);
  const bugs = await readBugs(base);
  for (const b of bugs) {
    if (args.openOnly && b && b.fix_verified) continue;
    process.stdout.write(`${renderEntryLine(b)}\n`);
  }
  return 0;
}

// --- entry -----------------------------------------------------------------

function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

async function main() {
  const sub = process.argv[2];
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE + '\n');
    return sub ? 0 : 2;
  }

  const args = parseArgs(process.argv.slice(3));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const rootDir = args.root ? path.resolve(args.root) : process.cwd();

  switch (sub) {
    case 'log':    return await cmdLog(rootDir, args);
    case 'search': return await cmdSearch(rootDir, args);
    case 'list':   return await cmdList(rootDir, args);
    default:
      process.stderr.write(`bugs: unknown subcommand "${sub}"\n`);
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`bugs: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

// Re-exports for testing the helpers directly.
export { parseArgs, parseTagsCSV, renderEntryLine };
