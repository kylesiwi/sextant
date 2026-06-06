#!/usr/bin/env node
// bin/config.mjs — Sextant durable-config CLI, backing the /sextant:output and
// /sextant:autorules commands.
//
// Subcommands:
//   get               Print the current output mode (off|quiet|verbose), one line.
//   set <mode>        Set the output mode. <mode> ∈ off|quiet|verbose.
//   autorules-get     Print the current autorules (capture_nudge) mode (on|off).
//   autorules-set <m> Set the autorules mode. <m> ∈ on|off.
//
// Global options:
//   --root <path>  Project root containing .sextant/ (default: $PWD).
//   -h, --help     Print usage.
//
// Exit codes:
//   0 — ok.
//   1 — validation error (bad mode).
//   2 — unknown subcommand / arg parse error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readOutputMode, setOutputMode, OUTPUT_MODES,
  readCaptureNudgeMode, setCaptureNudgeMode, CAPTURE_NUDGE_MODES,
} from '../lib/config.mjs';

const USAGE = `Usage: config <get | set <mode> | autorules-get | autorules-set <mode>> [--root <path>]

Subcommands:
  get                Print the current output mode (${OUTPUT_MODES.join('|')}).
  set <mode>         Set the output mode (${OUTPUT_MODES.join('|')}).
  autorules-get      Print the current autorules mode (${CAPTURE_NUDGE_MODES.join('|')}).
  autorules-set <m>  Set the autorules mode (${CAPTURE_NUDGE_MODES.join('|')}).

Global options:
  --root <path>  Project root containing .sextant/ (default: $PWD).
  -h, --help     Print this message.`;

function parseArgs(argv) {
  const out = { root: null, positional: [], help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      process.stderr.write(`config: unknown arg "${a}"\n`);
      process.exit(2);
    } else out.positional.push(a);
  }
  return out;
}

async function cmdGet(rootDir) {
  process.stdout.write(`${await readOutputMode(rootDir)}\n`);
  return 0;
}

async function cmdSet(rootDir, mode) {
  if (!mode) {
    process.stderr.write(`config: set requires a mode (${OUTPUT_MODES.join('|')})\n`);
    return 2;
  }
  try {
    await setOutputMode(rootDir, mode);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`output mode set to "${mode}"\n`);
  return 0;
}

async function cmdAutorulesGet(rootDir) {
  process.stdout.write(`${await readCaptureNudgeMode(rootDir)}\n`);
  return 0;
}

async function cmdAutorulesSet(rootDir, mode) {
  if (!mode) {
    process.stderr.write(`config: autorules-set requires a mode (${CAPTURE_NUDGE_MODES.join('|')})\n`);
    return 2;
  }
  try {
    await setCaptureNudgeMode(rootDir, mode);
  } catch (err) {
    process.stderr.write(`config: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(`autorules mode set to "${mode}"\n`);
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
    case 'get': return await cmdGet(rootDir);
    case 'set': return await cmdSet(rootDir, args.positional[0]);
    case 'autorules-get': return await cmdAutorulesGet(rootDir);
    case 'autorules-set': return await cmdAutorulesSet(rootDir, args.positional[0]);
    default:
      process.stderr.write(`config: unknown subcommand "${sub}"\n`);
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`config: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

export { parseArgs };
