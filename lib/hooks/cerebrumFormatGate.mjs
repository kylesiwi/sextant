// lib/hooks/cerebrumFormatGate.mjs — shared read+lint for the Stop/SubagentStop
// cerebrum format gate (cerebrum-v2 T5.5).
//
// Pure-ish: reads the one store and runs the shared deterministic linter over
// rules NOT yet in the accepted-hash set. The stateful orchestration (the
// accepted-set, the block counter + fail-open, the { decision: 'block' }
// envelope) lives in stop.mjs, which has withState/readState; this module just
// produces the lint result + the model-facing reason text.

import path from 'node:path';

import { readCerebrumFile, lineHash } from '../stores/cerebrum.mjs';
import { lintCerebrumRule } from '../capture/ruleLint.mjs';
import { durableFile } from '../paths.mjs';

export function cerebrumStorePath(cwd) {
  return durableFile(cwd, path.join('cerebrum', 'cerebrum.md'));
}

// collectRuleLint(cwd, acceptedHashes) → { allHashes, cleanHashes, failing }
//   allHashes   — every current rule's lineHash (the next accepted baseline)
//   cleanHashes — to-check rules (hash ∉ accepted) that lint with NO errors
//   failing     — [{ hash, errors, preview }] for to-check rules with ≥1 error
// Only ERRORS gate; warns (e.g. a not-yet-created [node:] path) are ignored here.
// Any IO/parse failure → empty result (caller treats as "nothing to gate").
export async function collectRuleLint(cwd, acceptedHashes) {
  const accepted = acceptedHashes instanceof Set
    ? acceptedHashes
    : new Set(Array.isArray(acceptedHashes) ? acceptedHashes : []);

  let parsed;
  try {
    parsed = await readCerebrumFile(cerebrumStorePath(cwd));
  } catch {
    return { allHashes: [], cleanHashes: [], failing: [] };
  }

  const lines = (parsed && Array.isArray(parsed.lines)) ? parsed.lines : [];
  const allHashes = [];
  const cleanHashes = [];
  const failing = [];
  for (const e of lines) {
    if (!e || e.kind !== 'rule' || typeof e.raw !== 'string') continue;
    const hash = lineHash(e.raw);
    allHashes.push(hash);
    if (accepted.has(hash)) continue; // baselined or already accepted
    const { errors } = lintCerebrumRule(e, { root: cwd });
    if (errors.length === 0) { cleanHashes.push(hash); continue; }
    const preview = (typeof e.body === 'string' ? e.body : e.raw).slice(0, 70);
    failing.push({ hash, errors, preview });
  }
  return { allHashes, cleanHashes, failing };
}

// composeFormatGateReason(failing) — the model-facing block reason. Actionable:
// names each offending rule + what's wrong + how to fix.
export function composeFormatGateReason(failing) {
  const out = [
    'Sextant: a cerebrum rule you added this session is mis-formatted. Fix it before ending the turn.',
    '',
  ];
  for (const f of failing) {
    out.push(`Rule [${f.hash}] "${f.preview}…"`);
    for (const m of f.errors) out.push(`  - ${m}`);
  }
  out.push('');
  out.push('Fix: edit .sextant/cerebrum/cerebrum.md to move scope/importance into the prefix, or run `cerebrum forget --line-hash <h>` then re-add it with `cerebrum remember`. Run `cerebrum doctor` to re-check.');
  return out.join('\n');
}
