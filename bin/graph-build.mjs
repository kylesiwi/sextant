#!/usr/bin/env node
// bin/graph-build.mjs — Phase 1a graph builder CLI.
//
// CLI wrapper around lib/graph/build.mjs. Invoked by /sextant:graph-build
// (commands/graph-build.md) and runnable directly from a checkout for
// manual rebuilds.
//
// CLI: node bin/graph-build.mjs [--root <path>] [--quiet] [--force]
//
// Defaults:
//   --root   $PWD
//   --quiet  off (progress lines to stderr)
//   --force  reserved for future incremental builds. Phase 1a always
//            rebuilds from scratch; the flag is accepted but currently a
//            no-op so callers can be forward-compatible without churn.
//
// Exit codes:
//   0 — build succeeded; summary line on stdout.
//   1 — build failed (e.g. --root is not a directory, parser/wasm load
//       failure, validation error). One-line diagnostic on stderr.
//   2 — argument parse error (unknown flag).
//
// Output contract (success):
//   stdout: exactly one line —
//     "Indexed N files, M edges. Wrote <abs path>. Took Xms."
//   stderr: progress lines from buildGraph (suppressed by --quiet).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGraph } from '../lib/graph/build.mjs';

function parseArgs(argv) {
  const out = { root: null, quiet: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { out.root = argv[++i]; }
    else if (a === '--quiet') { out.quiet = true; }
    else if (a === '--force') { out.force = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else {
      process.stderr.write(`graph-build: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    'Usage: node bin/graph-build.mjs [--root <path>] [--quiet] [--force]\n' +
    '\n' +
    'Build the AST graph for a project root. Writes\n' +
    '<root>/.sextant/graph/graph.json plus the .sextant-version sidecar.\n' +
    '\n' +
    'Flags:\n' +
    '  --root <path>  Project root (default: $PWD).\n' +
    '  --quiet        Suppress progress lines on stderr; only the summary remains.\n' +
    '  --force        Reserved for future incremental builds. Phase 1a always\n' +
    '                 rebuilds; the flag is accepted as a no-op for forward-compat.\n',
  );
}

// CLI entry. Only run when invoked as a script — importing this file (e.g.,
// from tests) shouldn't trigger the side effects.
function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }

  const root = args.root ? path.resolve(args.root) : process.cwd();

  // Pre-flight: verify --root is a real directory before we ask the builder
  // to walk it. The builder treats ENOENT as "empty project" (returns 0 nodes),
  // which would mask a typo'd path. Catching this here gives a clear exit 1.
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    process.stderr.write(`graph-build: --root not found: ${root}\n`);
    return 1;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`graph-build: --root is not a directory: ${root}\n`);
    return 1;
  }

  // --force is reserved for future incremental builds; Phase 1a always
  // does a fresh rebuild. Keep the param wired through for forward-compat.
  void args.force;

  let result;
  try {
    result = await buildGraph({ root, quiet: args.quiet });
  } catch (err) {
    process.stderr.write(`graph-build: build failed: ${err.message}\n`);
    return 1;
  }

  // Summary line. Always to stdout. ms is rounded for stable output.
  process.stdout.write(
    `Indexed ${result.files} files, ${result.edges} edges. ` +
    `Wrote ${result.graphPath}. ` +
    `Took ${Math.round(result.ms)}ms.\n`,
  );

  return 0;
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`graph-build: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}
