#!/usr/bin/env node
// bin/conflicts.mjs — CLI wrapper around lib/conflicts.mjs.
//
// Usage:
//   node bin/conflicts.mjs [--root <path>] [--json] [--help]
//
// Invoked by:
//   - /sextant:check-conflicts (commands/check-conflicts.md)
//   - /sextant:init            (commands/init.md, gating step)
//   - /sextant:doctor          (commands/doctor.md, ongoing display)
//
// Exit codes:
//   0 — no findings, OR only medium/low findings (warnings).
//   1 — at least one high-severity finding (install-time blocker by policy).
//
// The detection module reads only; this wrapper never writes.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectConflicts } from '../lib/conflicts.mjs';

function parseArgs(argv) {
  const out = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      out.root = argv[++i];
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      process.stderr.write(`conflicts: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    'Usage: node bin/conflicts.mjs [--root <path>] [--json]\n' +
    '\n' +
    'Scan for conflicts with predecessor plugins (OpenWolf, Graphify,\n' +
    'openwolf-graphify-bridge) plus generic hook/statusLine collisions.\n' +
    '\n' +
    'Options:\n' +
    '  --root <path>  Project root to scan (default: $PWD).\n' +
    '  --json         Emit findings as a JSON array on stdout.\n' +
    '  --help, -h     This message.\n' +
    '\n' +
    'Exit codes:\n' +
    '  0  No findings, or only medium/low (warnings).\n' +
    '  1  At least one high-severity finding.\n',
  );
}

// Indent every line of `text` by two spaces. Used to format action hints
// nested under their finding header.
function indent(text, prefix = '       ') {
  return text.split('\n').map((l) => prefix + l).join('\n');
}

function prettyPrint(root, findings) {
  process.stdout.write(`Sextant conflict scan (root: ${root})\n\n`);
  if (findings.length === 0) {
    process.stdout.write('No conflicts detected.\n');
    return;
  }
  for (const f of findings) {
    process.stdout.write(`${f.severity}: ${f.kind}\n`);
    process.stdout.write(`  where: ${f.location}\n`);
    process.stdout.write(`  ${f.message}\n`);
    process.stdout.write(`  fix:\n${indent(f.action_hint)}\n`);
    process.stdout.write('\n');
  }
  const high = findings.filter((f) => f.severity === 'high').length;
  const med = findings.filter((f) => f.severity === 'medium').length;
  const low = findings.filter((f) => f.severity === 'low').length;
  const parts = [];
  if (high) parts.push(`${high} high`);
  if (med) parts.push(`${med} medium`);
  if (low) parts.push(`${low} low`);
  process.stdout.write(`Summary: ${parts.join(', ')}.\n`);
  if (high > 0) {
    process.stdout.write(
      'Sextant will NOT modify other plugins\' files automatically. ' +
      'Use the `fix:` hint above to remediate.\n',
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  const root = args.root ? path.resolve(args.root) : process.cwd();
  const home = process.env.HOME ?? '';

  let findings;
  try {
    findings = await detectConflicts({ cwd: root, home });
  } catch (err) {
    process.stderr.write(`conflicts: scan failed: ${err.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
  } else {
    prettyPrint(root, findings);
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  process.exit(hasHigh ? 1 : 0);
}

// Only run the CLI when invoked directly, not when imported.
function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().catch((err) => {
    process.stderr.write(`conflicts: unhandled error: ${err.message}\n`);
    process.exit(2);
  });
}
