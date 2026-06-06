#!/usr/bin/env node
// bin/stats.mjs — Sextant stats CLI.
//
// Backs /sextant:stats (commands/stats.md). Loads .sextant/stats.json and
// prints a human-readable summary per § 6.4. Missing file → friendly
// "no measurement data yet" line; the file accumulates as PreToolUse fires.
//
// Top rules by fires:
//   The cerebrum store hashes rules by SHA1-16 of the raw text and stats.json
//   keys rule_fires by that hash. We don't store the rule body in stats.json
//   (to avoid the file growing without bound when a rule is renamed). So we
//   try to look it up in regular.md + mandatory.md by re-hashing each
//   parsed rule entry; rules that no longer exist in the cerebrum (forgotten /
//   archived) are still surfaced but with the hash as the label.
//
// Options:
//   --root <dir>      Project root containing .sextant/ (default: $PWD).
//   --json            Emit JSON instead of human-readable text.
//   --top <N>         Number of top rules by fires to show (default 5).
//   -h, --help        Print usage.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableBase } from '../lib/paths.mjs';
import { readStats, statsPath, defaultStats } from '../lib/stores/stats.mjs';
import { readResolvedCerebrum, lineHash } from '../lib/stores/cerebrum.mjs';

const USAGE = `Usage: stats [options]

Print Sextant's measurement + A/B-arm stats for the current project.

Options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  --json          Emit JSON to stdout instead of human-readable text.
  --top <N>       Number of top rules by fires to show (default 5).
  -h, --help      Print this message.`;

function parseArgs(argv) {
  const out = { root: null, json: false, top: 5, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--top') {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.top = n;
    } else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`stats: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

// Resolve rule_fires hashes back to bodies by walking the cerebrum files. If
// a hash doesn't match anything (forgotten/archived), we leave body=null and
// the renderer falls back to the hash.
async function resolveRuleBodies(root, ruleFires) {
  const wanted = new Set(Object.keys(ruleFires || {}));
  if (wanted.size === 0) return new Map();
  const cerebrumDir = path.join(root, '.sextant', 'cerebrum');
  const out = new Map();
  try {
    const resolved = await readResolvedCerebrum(cerebrumDir);
    for (const e of resolved.parsed.lines || []) {
      if (e.kind !== 'rule') continue;
      const h = lineHash(e.raw);
      if (wanted.has(h)) out.set(h, e.body || e.raw.trim());
    }
  } catch {
    // Missing store is fine — the renderer falls back to the hash.
  }
  return out;
}

function topRules(ruleFires, n) {
  const entries = Object.entries(ruleFires || {});
  entries.sort((a, b) => (b[1].fires ?? 0) - (a[1].fires ?? 0));
  return entries.slice(0, n);
}

function truncateBody(body, max) {
  if (typeof body !== 'string') return '';
  if (body.length <= max) return body;
  return body.slice(0, max - 3) + '...';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : process.cwd();
  const base = durableBase(root);
  const file = statsPath(base);

  // Check existence so we can give a friendly message when the project has
  // never produced any ledger writes (e.g. fresh install, control arm only).
  let exists = true;
  try { await fsp.access(file); } catch { exists = false; }

  if (!exists) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ ...defaultStats(), root, exists: false }) + '\n');
      return 0;
    }
    process.stdout.write(`Sextant stats (root: ${root})\n`);
    process.stdout.write('  no measurement data yet — stats accumulate as you use Sextant\n');
    return 0;
  }

  const stats = await readStats(base);

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...stats, root, exists: true }) + '\n');
    return 0;
  }

  const top = topRules(stats.rule_fires, args.top);
  const bodyMap = await resolveRuleBodies(root, stats.rule_fires);

  process.stdout.write(`Sextant stats (root: ${root})\n`);
  process.stdout.write(`  A/B arm: ${stats.ab_arm}\n`);
  process.stdout.write(`  Sessions: ${stats.session_count}\n`);
  process.stdout.write(`  Tokens saved (estimate): ${stats.tokens_saved_estimate}\n`);
  process.stdout.write(`  Tokens paid extra: ${stats.tokens_paid_extra}\n`);
  process.stdout.write(`  Net savings: ${stats.net_savings}\n`);
  process.stdout.write('  Top rules by fires:\n');
  if (top.length === 0) {
    process.stdout.write('    (none yet)\n');
  } else {
    let idx = 1;
    for (const [hash, info] of top) {
      const body = bodyMap.get(hash);
      const label = body ? truncateBody(body, 80) : `<hash ${hash}>`;
      process.stdout.write(`    ${idx}. ${label} (${info.fires ?? 0} fires)\n`);
      idx++;
    }
  }
  process.stdout.write(`  Redundant reads blocked: ${stats.redundant_reads_blocked}\n`);
  process.stdout.write(`  Last updated: ${stats.last_updated ?? '(never)'}\n`);
  return 0;
}

function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`stats: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

export { parseArgs, topRules, resolveRuleBodies };
