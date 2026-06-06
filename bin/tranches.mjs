#!/usr/bin/env node
// bin/tranches.mjs — Sextant tranche-workflow CLI multiplexer.
//
// Subcommands:
//
//   start   --feature <name> --charter <path> --spec <path> --tranches '<json>'
//           [--doc-root <path>] [--root <path>]
//
//   status  [--root <path>]
//
//   advance --tranche <id> --to <status> [--root <path>]
//
//   ship    --tranche <id> [--root <path>]
//
//   amend   --text "<amendment text>" [--tranche <id>] [--root <path>]
//
//   checklist-done --tranche <id> [--root <path>]
//
//   complete [--root <path>]
//
//   finalize [--force] [--root <path>]
//
// Exit codes:
//   0 — subcommand succeeded.
//   1 — validation error (missing flag, lifecycle violation).
//   2 — unknown subcommand or arg parse error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readTranches,
  writeTranches,
  readTrancheDoc,
  startFeature,
  advanceTranche,
  setChecklistComplete,
  recordAmendment,
  recordConcern,
  resolveConcern,
  openConcerns,
  finalizeFeature,
  activeTranche,
} from '../lib/stores/tranches.mjs';

const USAGE = `Usage: tranches <subcommand> [options]

Subcommands:
  start           --feature <name> --charter <path> --spec <path> --tranches '<json>'
  status
  advance         --tranche <id> --to <status>
  ship            --tranche <id>
  amend           --text "<text>" [--tranche <id>]
  checklist-done  --tranche <id>
  concern         add --text "<text>" [--target <id>] | resolve --id <n> [--note "<text>"] | list
  complete
  finalize        [--force]

Global options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  -h, --help      Print this message.`;

// Normalize a --tranche id so both the display form "T4" (what `status` prints,
// and what agents naturally copy) and the bare "4" the store keys on are
// accepted. Strip a single leading T/t only when it precedes a digit, so the
// display form round-trips; any other value (incl. non-numeric ids) is left
// untouched. Without this, "T4" never matches id "4" and error messages double
// the prefix ("TT4 not found").
export function normalizeTrancheId(raw) {
  if (typeof raw !== 'string') return raw;
  const m = raw.match(/^[Tt](\d.*)$/);
  return m ? m[1] : raw;
}

function parseArgs(argv) {
  const out = {
    root: null,
    feature: null,
    charter: null,
    spec: null,
    tranches: null,
    docRoot: null,
    tranche: null,
    to: null,
    text: null,
    id: null,
    target: null,
    note: null,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--feature') out.feature = argv[++i];
    else if (a === '--charter') out.charter = argv[++i];
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--tranches') out.tranches = argv[++i];
    else if (a === '--doc-root') out.docRoot = argv[++i];
    else if (a === '--tranche') out.tranche = normalizeTrancheId(argv[++i]);
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--target') out.target = normalizeTrancheId(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`tranches: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

// --- start ------------------------------------------------------------------

async function cmdStart(rootDir, args) {
  if (!args.feature) { process.stderr.write('tranches start: --feature required\n'); return 1; }
  if (!args.charter) { process.stderr.write('tranches start: --charter required\n'); return 1; }
  if (!args.spec) { process.stderr.write('tranches start: --spec required\n'); return 1; }
  if (!args.tranches) { process.stderr.write('tranches start: --tranches required (JSON array)\n'); return 1; }

  let tranchesArr;
  try {
    tranchesArr = JSON.parse(args.tranches);
    if (!Array.isArray(tranchesArr)) throw new Error('must be array');
  } catch (err) {
    process.stderr.write(`tranches start: --tranches parse error: ${err.message}\n`);
    return 1;
  }

  const state = await readTranches(rootDir);
  try {
    startFeature(state, {
      feature: args.feature,
      docRoot: args.docRoot || path.dirname(args.charter),
      charterPath: args.charter,
      specPath: args.spec,
      tranches: tranchesArr,
    });
  } catch (err) {
    process.stderr.write(`tranches start: ${err.message}\n`);
    return 1;
  }

  await writeTranches(rootDir, state);
  process.stdout.write(`Feature "${args.feature}" started with ${tranchesArr.length} tranches.\n`);
  process.stdout.write(`Active: T${state.active_tranche_id} — ${state.workflow_state}\n`);
  return 0;
}

// --- status -----------------------------------------------------------------

async function cmdStatus(rootDir) {
  const state = await readTranches(rootDir);
  if (!state.feature) {
    process.stdout.write('No active feature plan.\n');
    return 0;
  }

  process.stdout.write(`Feature: ${state.feature}\n`);
  process.stdout.write(`Workflow: ${state.workflow_state}\n`);
  process.stdout.write(`Charter: ${state.charter_path}\n`);
  process.stdout.write(`Spec: ${state.spec_path}\n`);
  process.stdout.write(`Active tranche: T${state.active_tranche_id}\n`);
  process.stdout.write('\nTranches:\n');

  for (const t of state.tranches) {
    const active = t.id === state.active_tranche_id ? ' ← active' : '';
    const shipped = t.shipped_at ? ` (shipped ${t.shipped_at.slice(0, 10)})` : '';
    const checklist = t.checklist_complete ? '' : ' [checklist pending]';
    process.stdout.write(`  T${t.id} "${t.title}" — ${t.status}${shipped}${checklist}${active}\n`);

    if (t.doc_path) {
      const doc = await readTrancheDoc(rootDir, t.doc_path);
      if (doc) {
        if (doc.deliverables_summary.length > 0) {
          process.stdout.write(`       Delivers: ${doc.deliverables_summary.join(' | ')}\n`);
        }
        process.stdout.write(`       Gates: ${doc.verification_gates_done}/${doc.verification_gates_total}\n`);
      }
    }
  }

  if (state.amendments.length > 0) {
    process.stdout.write(`\nAmendments: ${state.amendments.length}\n`);
    for (const a of state.amendments.slice(-3)) {
      process.stdout.write(`  [${a.ts.slice(0, 10)}] ${a.text}\n`);
    }
  }

  const open = openConcerns(state);
  if (open.length > 0) {
    process.stdout.write(`\nCarry-forward concerns (open: ${open.length}):\n`);
    for (const c of open) {
      const tgt = c.target ? ` → T${c.target}` : '';
      process.stdout.write(`  #${c.id}${tgt} (raised by T${c.raised_by}): ${c.text}\n`);
    }
  }

  return 0;
}

// --- advance ----------------------------------------------------------------

async function cmdAdvance(rootDir, args) {
  if (!args.tranche) { process.stderr.write('tranches advance: --tranche required\n'); return 1; }
  if (!args.to) { process.stderr.write('tranches advance: --to required\n'); return 1; }

  const state = await readTranches(rootDir);
  const prevWorkflow = state.workflow_state;
  try {
    advanceTranche(state, args.tranche, args.to);
  } catch (err) {
    process.stderr.write(`tranches advance: ${err.message}\n`);
    return 1;
  }

  await writeTranches(rootDir, state);
  process.stdout.write(`T${args.tranche} → ${args.to}. Workflow: ${state.workflow_state}\n`);
  maybeProdComplete(state, prevWorkflow);
  return 0;
}

// maybeProdComplete: once every tranche is terminal, updateWorkflowState flips
// the workflow to COMPLETING on its own. Surface that so the agent knows the
// remaining steps — otherwise the feature sits in COMPLETING with file
// restrictions still live and no obvious way out. Fires only on the transition
// INTO COMPLETING so later advances within COMPLETING don't re-nag.
function maybeProdComplete(state, prevWorkflow) {
  if (state.workflow_state === 'COMPLETING' && prevWorkflow !== 'COMPLETING') {
    process.stdout.write(
      'All tranches are terminal. Run "complete" to write the final docs, ' +
        'then "finalize" to clear tranche state and lift all file restrictions.\n',
    );
  }
}

// --- ship -------------------------------------------------------------------

async function cmdShip(rootDir, args) {
  if (!args.tranche) { process.stderr.write('tranches ship: --tranche required\n'); return 1; }

  const state = await readTranches(rootDir);
  const prevWorkflow = state.workflow_state;
  const tranche = state.tranches.find(t => t.id === args.tranche);
  if (!tranche) { process.stderr.write(`tranches ship: T${args.tranche} not found\n`); return 1; }

  if (tranche.doc_path) {
    const doc = await readTrancheDoc(rootDir, tranche.doc_path);
    if (doc && doc.verification_gates_total > 0) {
      const unchecked = doc.verification_gates_total - doc.verification_gates_done;
      if (unchecked > 0) {
        process.stderr.write(`Warning: ${unchecked}/${doc.verification_gates_total} verification gates unchecked in ${tranche.doc_path}\n`);
      }
    }
    // Soft gate on in-flight "open questions before ship": warn (never block),
    // and point at the two honest exits — resolve, or escalate to a concern.
    if (doc && doc.open_questions_before_ship_count > 0) {
      const n = doc.open_questions_before_ship_count;
      process.stderr.write(
        `Warning: ${n} open question${n === 1 ? '' : 's'} before ship unresolved in ${tranche.doc_path}. ` +
        'Resolve them, or escalate each to a carry-forward concern ' +
        '(node bin/tranches.mjs concern add / /sextant:tranche-concern) before shipping.\n',
      );
    }
  }

  try {
    advanceTranche(state, args.tranche, 'SHIPPED');
  } catch (err) {
    process.stderr.write(`tranches ship: ${err.message}\n`);
    return 1;
  }

  await writeTranches(rootDir, state);
  process.stdout.write(`T${args.tranche} shipped. Workflow: ${state.workflow_state}\n`);
  // Soft review-before-ship reminder. Unconditional (there is no review-tracking
  // state, and a reminder you've-already-reviewed is cheap), never blocks. Ship
  // FREEZES this tranche's scope — a late fix needs /sextant:tranche-amend.
  process.stdout.write(
    'Reminder: shipping freezes this tranche\'s scope. If you have not already, ' +
    'run an adversarial review (advisor / /code-review) before relying on it; ' +
    'late fixes need /sextant:tranche-amend.\n',
  );
  maybeProdComplete(state, prevWorkflow);
  return 0;
}

// --- amend ------------------------------------------------------------------

async function cmdAmend(rootDir, args) {
  if (!args.text) { process.stderr.write('tranches amend: --text required\n'); return 1; }

  const state = await readTranches(rootDir);
  if (!state.feature) { process.stderr.write('tranches amend: no active feature\n'); return 1; }

  recordAmendment(state, {
    trancheId: args.tranche || state.active_tranche_id,
    text: args.text,
  });
  state.pending_amendment = true;

  await writeTranches(rootDir, state);
  process.stdout.write(`Amendment recorded. Deny gates unlocked for next edit.\n`);
  return 0;
}

// --- checklist-done ---------------------------------------------------------

async function cmdChecklistDone(rootDir, args) {
  if (!args.tranche) { process.stderr.write('tranches checklist-done: --tranche required\n'); return 1; }

  const state = await readTranches(rootDir);
  const tranche = state.tranches.find(t => t.id === args.tranche);
  if (!tranche) { process.stderr.write(`tranches checklist-done: T${args.tranche} not found\n`); return 1; }

  if (tranche.doc_path) {
    const doc = await readTrancheDoc(rootDir, tranche.doc_path);
    if (doc) {
      if (doc.open_questions_count > 0) {
        process.stderr.write(`tranches checklist-done: ${doc.open_questions_count} open questions remain in ${tranche.doc_path}\n`);
        return 1;
      }
      if (doc.checklist_total > 0 && doc.checklist_done < doc.checklist_total) {
        process.stderr.write(`tranches checklist-done: checklist ${doc.checklist_done}/${doc.checklist_total} in ${tranche.doc_path}\n`);
        return 1;
      }
    }
  }

  setChecklistComplete(state, args.tranche);
  await writeTranches(rootDir, state);
  process.stdout.write(`T${args.tranche} checklist marked complete.\n`);
  return 0;
}

// --- complete ---------------------------------------------------------------

async function cmdComplete(rootDir) {
  const state = await readTranches(rootDir);
  if (!state.feature) { process.stderr.write('tranches complete: no active feature\n'); return 1; }

  const nonTerminal = state.tranches.filter(t =>
    t.status !== 'SHIPPED' && t.status !== 'ARCHIVED'
  );
  if (nonTerminal.length > 0) {
    process.stderr.write(`tranches complete: ${nonTerminal.length} tranches not yet shipped\n`);
    for (const t of nonTerminal) {
      process.stderr.write(`  T${t.id} "${t.title}" — ${t.status}\n`);
    }
    return 1;
  }

  state.workflow_state = 'COMPLETING';
  await writeTranches(rootDir, state);
  process.stdout.write(`Workflow → COMPLETING. Write overview.md + technical-spec.md, then run "finalize".\n`);
  return 0;
}

// --- concern ----------------------------------------------------------------

async function cmdConcern(rootDir, action, args) {
  const state = await readTranches(rootDir);
  if (!state.feature) { process.stderr.write('tranches concern: no active feature\n'); return 1; }

  if (action === 'add') {
    if (!args.text) { process.stderr.write('tranches concern add: --text required\n'); return 1; }
    let concern;
    try {
      concern = recordConcern(state, { text: args.text, target: args.target });
    } catch (err) {
      process.stderr.write(`tranches concern add: ${err.message}\n`);
      return 1;
    }
    await writeTranches(rootDir, state);
    const tgt = concern.target ? ` (target T${concern.target})` : '';
    process.stdout.write(`Carry-forward concern #${concern.id} recorded${tgt}.\n`);
    return 0;
  }

  if (action === 'resolve') {
    if (!args.id) { process.stderr.write('tranches concern resolve: --id required\n'); return 1; }
    try {
      resolveConcern(state, { id: args.id, note: args.note });
    } catch (err) {
      process.stderr.write(`tranches concern resolve: ${err.message}\n`);
      return 1;
    }
    await writeTranches(rootDir, state);
    process.stdout.write(`Concern #${args.id} resolved.\n`);
    return 0;
  }

  if (action === 'list') {
    const all = Array.isArray(state.carry_forward) ? state.carry_forward : [];
    if (all.length === 0) { process.stdout.write('No carry-forward concerns.\n'); return 0; }
    const open = all.filter((c) => c.status === 'open');
    const resolved = all.filter((c) => c.status === 'resolved');
    process.stdout.write(`Carry-forward concerns (open: ${open.length}, resolved: ${resolved.length}):\n`);
    for (const c of open) {
      const tgt = c.target ? ` → T${c.target}` : '';
      process.stdout.write(`  #${c.id} [open]${tgt} (raised by T${c.raised_by}): ${c.text}\n`);
    }
    for (const c of resolved) {
      process.stdout.write(`  #${c.id} [resolved by T${c.resolved_by}]: ${c.text}\n`);
    }
    return 0;
  }

  process.stderr.write(`tranches concern: unknown action "${action || ''}" (use add | resolve | list)\n`);
  return 2;
}

// --- finalize ---------------------------------------------------------------

async function cmdFinalize(rootDir, args) {
  const state = await readTranches(rootDir);
  if (!state.feature) { process.stderr.write('tranches finalize: no active feature\n'); return 1; }

  const feature = state.feature;
  // When --force abandons open concerns, say so loudly + by name before the
  // store wipes them — abandoning carry-forward unknowns must never be silent.
  if (args.force) {
    const open = openConcerns(state);
    if (open.length > 0) {
      process.stderr.write(`Warning: abandoning ${open.length} open carry-forward concern(s):\n`);
      for (const c of open) process.stderr.write(`  #${c.id}: ${c.text}\n`);
    }
  }
  try {
    finalizeFeature(state, { force: args.force });
  } catch (err) {
    process.stderr.write(`tranches finalize: ${err.message}\n`);
    return 1;
  }

  await writeTranches(rootDir, state);
  process.stdout.write(`Feature "${feature}" finalized — tranche state cleared (workflow → IDLE).\n`);
  process.stdout.write(`All tranche file restrictions are now lifted; a new feature can be started.\n`);
  process.stdout.write(`If any of those files still need lasting edit-protection or care, capture it as a normal rule via /sextant:remember — not a tranche lock.\n`);
  return 0;
}

// --- entry ------------------------------------------------------------------

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

  // `concern` takes a sub-action positional (add|resolve|list) before its flags;
  // parseArgs would reject that positional, so intercept and parse from slice(4).
  if (sub === 'concern') {
    const action = process.argv[3];
    const args = parseArgs(process.argv.slice(4));
    if (args.help) { process.stdout.write(USAGE + '\n'); return 0; }
    const rootDir = args.root ? path.resolve(args.root) : process.cwd();
    return await cmdConcern(rootDir, action, args);
  }

  const args = parseArgs(process.argv.slice(3));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const rootDir = args.root ? path.resolve(args.root) : process.cwd();

  switch (sub) {
    case 'start':          return await cmdStart(rootDir, args);
    case 'status':         return await cmdStatus(rootDir);
    case 'advance':        return await cmdAdvance(rootDir, args);
    case 'ship':           return await cmdShip(rootDir, args);
    case 'amend':          return await cmdAmend(rootDir, args);
    case 'checklist-done': return await cmdChecklistDone(rootDir, args);
    case 'complete':       return await cmdComplete(rootDir);
    case 'finalize':       return await cmdFinalize(rootDir, args);
    default:
      process.stderr.write(`tranches: unknown subcommand "${sub}"\n`);
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`tranches: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

export { parseArgs };
