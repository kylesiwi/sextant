#!/usr/bin/env node
// bin/review.mjs — Sextant review CLI (Phase 10).
//
// Backs /sextant:review (commands/review.md). Reads stats.json + the parsed
// cerebrum and prints three sections:
//
//   - Promotion candidates: fires >= threshold, !contradicted, !mandatory
//   - Demote candidates: low fire ratio + stale last-fired
//   - Contradictions: heuristic textual oppositions (always/never, etc.)
//
// Output is human-readable by default; --json emits the structured payload
// the sextant-reviewer subagent consumes. The contradictions section relies
// on lib/promotion/contradictions.mjs's heuristic scan (§ 10.10).
//
// Options:
//   --root <path>   Project root containing .sextant/ (default: $PWD).
//   --json          Emit JSON to stdout instead of human-readable text.
//   -h, --help      Print usage.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableBase } from '../lib/paths.mjs';
import { readStats, statsPath, defaultStats } from '../lib/stores/stats.mjs';
import { readResolvedCerebrum, parseCerebrum } from '../lib/stores/cerebrum.mjs';
import {
  summarizeReviewQueue,
  PROMOTION_THRESHOLD,
} from '../lib/promotion/ladder.mjs';

const USAGE = `Usage: review [options]

Show promotion candidates, demote candidates, and contradiction warnings
from this project's cerebrum + stats.json.

Options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  --json          Emit JSON instead of human-readable text.
  -h, --help      Print this message.`;

export function parseArgs(argv) {
  const out = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`review: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

// Load the one cerebrum store (cerebrum-v2: regular.md/mandatory.md retired) and
// return the parsed, normalized object. readResolvedCerebrum normalizes v2 tokens
// to the canonical buckets the promotion ladder + contradiction detector expect.
async function loadFullCerebrum(root) {
  const dir = path.join(root, '.sextant', 'cerebrum');
  const resolved = await readResolvedCerebrum(dir);
  return resolved.parsed;
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function relativeTimeShort(iso, nowMs) {
  if (typeof iso !== 'string' || iso.length === 0) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const deltaMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) - t;
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function renderText(root, summary) {
  const lines = [];
  lines.push(`Sextant review summary (root: ${root})`);
  lines.push('');

  // -- Promotion candidates ---------------------------------------------------
  lines.push(`Promotion candidates (${summary.promotion.length}):`);
  if (summary.promotion.length === 0) {
    lines.push('  (none)');
  } else {
    const now = Date.now();
    for (const c of summary.promotion) {
      const body = truncate(c.body || '(empty)', 100);
      const lf = relativeTimeShort(c.last_fired, now);
      lines.push(`  [${c.line_hash}] ${body} (${c.fires} fires, ${lf} last fired)`);
    }
  }
  lines.push('');

  // -- Demote candidates ------------------------------------------------------
  lines.push(`Demote candidates (${summary.demote.length}):`);
  if (summary.demote.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of summary.demote) {
      const body = truncate(c.body || '(empty)', 100);
      const pct = (c.ratio * 100).toFixed(2);
      lines.push(`  [${c.line_hash}] ${body} (${c.fires} fires, ${pct}% fire rate)`);
    }
  }
  lines.push('');

  // -- Contradictions ---------------------------------------------------------
  lines.push(`Contradictions (${summary.contradictions.length}):`);
  if (summary.contradictions.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of summary.contradictions) {
      const a = truncate(c.line_a.body || '(empty)', 80);
      const b = truncate(c.line_b.body || '(empty)', 80);
      lines.push(`  - ${a}`);
      lines.push(`    vs ${b}`);
      lines.push(`    reason: ${c.reason}`);
    }
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : process.cwd();
  const base = durableBase(root);
  const sFile = statsPath(base);

  // If no stats.json has ever been written we print a friendly no-data line
  // and bail. The cerebrum may still exist, but without measurement data
  // there's nothing to promote or demote.
  let exists = true;
  try { await fsp.access(sFile); } catch { exists = false; }

  if (!exists) {
    if (args.json) {
      process.stdout.write(JSON.stringify({
        root,
        exists: false,
        promotion: [],
        demote: [],
        contradictions: [],
        message: 'no measurement data yet — accumulate via use',
      }) + '\n');
      return 0;
    }
    process.stdout.write(`Sextant review summary (root: ${root})\n`);
    process.stdout.write('  no measurement data yet — accumulate via use\n');
    return 0;
  }

  const stats = await readStats(base);
  const cerebrum = await loadFullCerebrum(root);
  const summary = summarizeReviewQueue(cerebrum, stats);

  if (args.json) {
    process.stdout.write(JSON.stringify({
      root,
      exists: true,
      threshold: PROMOTION_THRESHOLD,
      session_count: stats.session_count,
      ...summary,
    }) + '\n');
    return 0;
  }
  process.stdout.write(renderText(root, summary));
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
      process.stderr.write(`review: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

// Suppress unused-warning on imports used for re-export-by-default helpers.
void parseCerebrum;
void defaultStats;
