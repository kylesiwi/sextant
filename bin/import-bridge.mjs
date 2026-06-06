#!/usr/bin/env node
// bin/import-bridge.mjs — migrate openwolf-graphify-bridge state into .sextant/.
//
// Invoked by /sextant:import-bridge (commands/import-bridge.md) and by the
// Phase 0 falsification harness (test/phase0-falsify.mjs flow 4).
//
// CLI: node bin/import-bridge.mjs [--from <wolf-dir>] [--to <sextant-dir>] [--force]
//
// Defaults:
//   <wolf-dir>     = $PWD/.wolf
//   <sextant-dir>  = $PWD/.sextant
//
// Migration steps (per § 8 Phase 0):
//   1. <wolf-dir>/cerebrum.md → <to>/cerebrum/regular.md
//      Each rule line (^\s*-\s+\d{4}-\d{2}-\d{2}:) is prefixed with
//      "<!-- sextant:migrated -->" so a reviewer can audit migrated rules.
//      Idempotent: a marker already on the preceding line is not duplicated.
//   2. <wolf-dir>/buglog.json → <to>/bugs.json
//      Parsed + re-serialized with 2-space indent. Byte-equivalence is not
//      promised; structural equivalence is.
//
// Idempotency / safety:
//   - If <to>/cerebrum/regular.md or <to>/bugs.json already exists AND its
//     content is non-empty AND differs from what we would write, we exit 1
//     and tell the user to pass --force. With --force we overwrite. An
//     existing-but-identical destination is treated as already migrated and
//     we proceed silently (this also lets the command be safely re-run).
//
// graphify-out is NOT migrated — Phase 1 rebuilds the graph from source.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_MARKER = '<!-- sextant:migrated -->';
const RULE_RE = /^\s*-\s+\d{4}-\d{2}-\d{2}:/;

function parseArgs(argv) {
  const out = { from: null, to: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') { out.from = argv[++i]; }
    else if (a === '--to') { out.to = argv[++i]; }
    else if (a === '--force') { out.force = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else {
      process.stderr.write(`import-bridge: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    'Usage: node bin/import-bridge.mjs [--from <wolf-dir>] [--to <sextant-dir>] [--force]\n' +
    '\n' +
    'Defaults:\n' +
    '  --from $PWD/.wolf\n' +
    '  --to   $PWD/.sextant\n',
  );
}

// Apply migration markers to cerebrum content. Idempotent: if a rule line is
// already preceded by MIGRATION_MARKER, leave that pair alone.
export function applyCerebrumMarkers(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RULE_RE.test(line)) {
      // Previous emitted line is the marker — skip insertion (idempotent).
      const prev = out[out.length - 1];
      if (prev !== MIGRATION_MARKER) {
        out.push(MIGRATION_MARKER);
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function countRules(content) {
  return content.split('\n').filter((l) => RULE_RE.test(l)).length;
}

// Check if dest exists. Returns:
//   { state: 'absent' }     — file doesn't exist; safe to write.
//   { state: 'same' }       — file exists and matches expected; no-op.
//   { state: 'differs' }    — file exists and differs; need --force to overwrite.
function destinationStatus(destPath, expectedBytes) {
  let actual;
  try {
    actual = fs.readFileSync(destPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    throw err;
  }
  if (actual.equals(Buffer.from(expectedBytes))) return { state: 'same' };
  return { state: 'differs' };
}

function migrateCerebrum(fromDir, toDir, force) {
  const src = path.join(fromDir, 'cerebrum.md');
  if (!fs.existsSync(src)) return { migrated: 0, skipped: true };

  const dstDir = path.join(toDir, 'cerebrum');
  const dst = path.join(dstDir, 'regular.md');

  const raw = fs.readFileSync(src, 'utf8');
  const out = applyCerebrumMarkers(raw);
  const status = destinationStatus(dst, out);

  if (status.state === 'differs' && !force) {
    process.stderr.write(
      `import-bridge: ${dst} already has differing content. Re-run with --force to overwrite.\n`,
    );
    process.exit(1);
  }

  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(dst, out, 'utf8');
  return { migrated: countRules(out), skipped: false };
}

function migrateBugs(fromDir, toDir, force) {
  const src = path.join(fromDir, 'buglog.json');
  if (!fs.existsSync(src)) return { migrated: 0, skipped: true };

  const dst = path.join(toDir, 'bugs.json');
  const raw = fs.readFileSync(src, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`import-bridge: ${src} is not valid JSON: ${err.message}\n`);
    process.exit(1);
  }

  const out = JSON.stringify(parsed, null, 2) + '\n';
  const status = destinationStatus(dst, out);

  // Empty-array destination ("[]") is the .sextant/init.md default; treat
  // it as absent so we don't require --force on first migration.
  if (status.state === 'differs' && !force) {
    let existingIsEffectivelyEmpty = false;
    try {
      const existing = JSON.parse(fs.readFileSync(dst, 'utf8'));
      if (Array.isArray(existing) && existing.length === 0) {
        existingIsEffectivelyEmpty = true;
      }
    } catch { /* corrupt destination => treat as differs and require --force */ }

    if (!existingIsEffectivelyEmpty) {
      process.stderr.write(
        `import-bridge: ${dst} already has bug entries. Re-run with --force to overwrite.\n`,
      );
      process.exit(1);
    }
  }

  fs.mkdirSync(toDir, { recursive: true });
  fs.writeFileSync(dst, out, 'utf8');
  const count = Array.isArray(parsed) ? parsed.length : 0;
  return { migrated: count, skipped: false };
}

export function runImportBridge({ from, to, force = false }) {
  if (!fs.existsSync(from)) {
    process.stdout.write(`no .wolf/ found at ${from}; nothing to import\n`);
    return { rules: 0, bugs: 0 };
  }

  const haveCerebrum = fs.existsSync(path.join(from, 'cerebrum.md'));
  const haveBugs = fs.existsSync(path.join(from, 'buglog.json'));
  if (!haveCerebrum && !haveBugs) {
    process.stdout.write(`no migratable files in ${from}; nothing to import\n`);
    return { rules: 0, bugs: 0 };
  }

  const rulesResult = migrateCerebrum(from, to, force);
  const bugsResult = migrateBugs(from, to, force);

  process.stdout.write(
    `Migrated ${rulesResult.migrated} rules + ${bugsResult.migrated} bugs. ` +
    `graphify-out not copied — Phase 1 will rebuild from source.\n`,
  );
  return { rules: rulesResult.migrated, bugs: bugsResult.migrated };
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

if (isEntry()) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); process.exit(0); }
  const cwd = process.cwd();
  const from = args.from ? path.resolve(args.from) : path.join(cwd, '.wolf');
  const to = args.to ? path.resolve(args.to) : path.join(cwd, '.sextant');
  runImportBridge({ from, to, force: args.force });
  process.exit(0);
}
