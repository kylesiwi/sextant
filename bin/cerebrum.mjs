#!/usr/bin/env node
// bin/cerebrum.mjs — Sextant cerebrum CLI multiplexer.
//
// Backs the five slash commands defined in commands/{remember,promote,forget,
// audit,reconcile}.md. Each subcommand is a thin wrapper around the
// lib/stores/cerebrum.mjs + lib/capture/auto-tag.mjs APIs so the same
// surface is exercised by tests and by the agent.
//
// Subcommands:
//
//   remember (--text "<rule>" | --text-stdin) [--node "<path>"|--global|--keywords "w1,w2"]
//            [--mandatory] [--root <dir>]
//       Append a rule line to the one store .sextant/cerebrum/cerebrum.md. SCOPE
//       decides the delivery channel: --node = deterministic (fires on read+write
//       of that file), --global = always-on, --keywords = BM25-ranked. --mandatory
//       adds the [!] flag, which is KW-ONLY (an exact recall floor + the write-gate)
//       — pair it ONLY with --keywords; on node/global it's redundant, and a bare
//       --mandatory is rejected (fires nowhere). --text-stdin reads the body from
//       stdin so backticks / quotes / $ survive a quoted heredoc (<<'EOF'). With no
//       scope flag, PostToolUse's auto-tagger tags it later. (--critical-keywords /
//       --kw-min are deprecated aliases — the *critical/;min scoring grammar is
//       retired; terms fold into [kw:…]; see parseArgs.) Run `explain` for the model.
//
//   promote --line-hash "<hash>" [--root <dir>]
//       In-place [!] flag-flip: prepend [!] to the rule in cerebrum.md (no file
//       move). The line is identified by SHA1(line content); the agent obtains
//       this hash from `audit` output.
//
//   forget --line-hash "<hash>" [--root <dir>]
//       Archive a rule from cerebrum.md → archive.md (prepending a dated HTML
//       comment), then remove it from cerebrum.md. The original line is preserved
//       verbatim under the comment so a future operator can reconstruct intent.
//
//   audit [--root <dir>]
//       Print the [provisional] review queue from cerebrum.md, each entry
//       prefixed with its line hash so the agent can pipe straight into
//       `promote`/`forget`.
//
//   list [--root <dir>]
//       Print every rule in the store with its line hash (same shape as audit),
//       so the hash is on hand for `promote`/`forget`. Live store only.
//
//   reconcile [--root <dir>]
//       Re-run autoTagFile on cerebrum.md. Useful after a user hand-edits the
//       file outside Claude (FileChanged would normally catch it; this is the
//       manual escape hatch).
//
//   doctor [--root <dir>]
//       Lint the cerebrum store: stale [node:] paths, empty [kw:] buckets,
//       scope-less [!] rules; recommend `migrate` if the store is un/partly
//       migrated. Advisory — exits 0 with findings on stdout.
//
// Exit codes:
//   0 — subcommand succeeded.
//   1 — error (missing required flag, ENOENT on cerebrum file we expected, etc.).
//   2 — unknown subcommand or arg parse error.
//
// Path resolution:
//   --root defaults to $PWD. All cerebrum files live under <root>/.sextant/cerebrum/.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCerebrum,
  serializeCerebrum,
  readCerebrumFile,
  writeCerebrumFile,
  updateCerebrumFile,
  appendEntries,
  ensureV2Header,
  listReviewQueue,
  lineHash,
  migrateCerebrumStores,
  assertMigrationIntegrity,
  CEREBRUM_V2_HEADER,
} from '../lib/stores/cerebrum.mjs';
import { autoTagFile } from '../lib/capture/auto-tag.mjs';
import { lintCerebrumRule } from '../lib/capture/ruleLint.mjs';
import { migrateRuleFires } from '../lib/stores/stats.mjs';
import { durableBase } from '../lib/paths.mjs';
import { CEREBRUM_MODEL } from '../lib/inject/cerebrumModel.mjs';

// CLI cerebrum mutations run interactively, not on the PreToolUse hot path, so
// they can afford to wait much longer than the hook default (50ms) for the
// advisory lock before giving up — dropping a user's `remember` is worse than
// a brief stall.
const CLI_LOCK_TIMEOUT_MS = 2000;

const USAGE = `Usage: cerebrum <subcommand> [options]

Subcommands:
  remember (--text "<rule>" | --text-stdin) [--node "<path>" | --global | --keywords "w1,w2"]
           [--mandatory]
             Scope decides the channel: --node = deterministic (read+write of that
             file), --global = always-on, --keywords = BM25-ranked. --mandatory ([!])
             is kw-only (recall floor + write-gate) — pair only with --keywords.
  promote --line-hash "<hash>"   Add [!] to a [kw:…] rule (kw rules only).
  forget  --line-hash "<hash>"   Archive a rule (cerebrum.md → archive.md).
  list                           List every rule with its line hash.
  audit
  reconcile
  migrate [--dry-run] [--rollback] [--force]
  doctor  Lint the cerebrum store + flag a v1/partly-migrated store.
  explain Print the canonical "how cerebrum evaluates rules" rubric.

Global options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  -h, --help      Print this message.`;

function parseArgs(argv) {
  const out = { root: null, text: null, textStdin: false, node: null, global: false, mandatory: false, keywords: null, criticalKeywords: null, lineHash: null, dryRun: false, rollback: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--rollback') out.rollback = true;
    else if (a === '--force') out.force = true;
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--text-stdin') out.textStdin = true;
    else if (a === '--node') out.node = argv[++i];
    else if (a === '--global') out.global = true;
    else if (a === '--mandatory') out.mandatory = true;
    else if (a === '--keywords') out.keywords = argv[++i];
    else if (a === '--critical-keywords') {
      // cerebrum-v2 (T5): deprecated alias. The critical-`*` scoring model is
      // retired; its terms simply fold into the plain [kw:…] bucket. Preserved
      // (not dropped) so existing /sextant:remember + /sextant:triage prose keeps
      // working until T6 rewrites it. Set importance explicitly with --mandatory.
      out.criticalKeywords = argv[++i];
      process.stderr.write('cerebrum: --critical-keywords is deprecated (cerebrum-v2); its terms fold into [kw:…]. Set importance with --mandatory.\n');
    }
    else if (a === '--kw-min') {
      // Deprecated + ignored (keywords are BM25-ranked now). Consume the value
      // so it doesn't trip the unknown-arg guard below.
      i += 1;
      process.stderr.write('cerebrum: --kw-min is deprecated and ignored (keywords are BM25-ranked in cerebrum-v2).\n');
    }
    else if (a === '--legacy-keywords') {
      // Deprecated + ignored (the legacy-keyword audit scan was removed).
      process.stderr.write('cerebrum: --legacy-keywords is deprecated and ignored (the legacy-keyword audit scan was removed in cerebrum-v2).\n');
    }
    else if (a === '--line-hash') out.lineHash = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`cerebrum: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// SHA1 of a single raw line. Delegates to lib/stores/cerebrum.mjs's
// lineHash so the agent's hash from `audit`, the Phase 8 stats.rule_fires
// keying, and promote/forget all agree on the same identifier.
function hashLine(raw) {
  return lineHash(raw);
}

function cerebrumDir(root) {
  return path.join(root, '.sextant', 'cerebrum');
}

// cerebrum-v2 / T3.5: the single authoritative store. regular.md/mandatory.md are
// retired write targets — only `migrate` (the one-time importer) still reads them.
function cerebrumPath(root)  { return path.join(cerebrumDir(root), 'cerebrum.md'); }
function regularPath(root)   { return path.join(cerebrumDir(root), 'regular.md'); }
function mandatoryPath(root) { return path.join(cerebrumDir(root), 'mandatory.md'); }
function archivePath(root)   { return path.join(cerebrumDir(root), 'archive.md'); }

async function ensureCerebrumDir(root) {
  await fsp.mkdir(cerebrumDir(root), { recursive: true });
}

// Read all of stdin to a UTF-8 string. Used by `remember --text-stdin`.
async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// --- remember --------------------------------------------------------------

async function cmdRemember(root, args) {
  // --text-stdin: read the rule body from stdin instead of --text. This lets
  // callers pass text containing backticks, quotes, or `$` via a quoted
  // heredoc (`<<'EOF'`) without bash mangling it. Internal newlines collapse to
  // single spaces so the rule stays on one line.
  if (args.textStdin) {
    if (process.stdin.isTTY) {
      process.stderr.write('cerebrum remember: --text-stdin expects piped input (e.g. a quoted heredoc), not a TTY\n');
      return 1;
    }
    const raw = await readAllStdin();
    const collapsed = raw.replace(/\s*\r?\n\s*/g, ' ').trim();
    if (collapsed.length === 0) {
      process.stderr.write('cerebrum remember: --text-stdin received empty input\n');
      return 1;
    }
    args.text = collapsed;
  }

  if (!args.text || args.text.length === 0) {
    process.stderr.write('cerebrum remember: --text is required\n');
    return 1;
  }

  // Validate flags. --global and --node are mutually-exclusive scope flags;
  // --mandatory is the kw-only importance flag ([!]) — it pairs with --keywords.
  // The combinations we accept:
  //   --node "<p>"           → [node:<p>]      (scope: this file)
  //   --global               → [global]        (scope: always-on)
  //   --keywords "a,b"       → [kw:a, b]       (scope: BM25-ranked)
  //   --mandatory --keywords → [kw:…] [!]      (must-never-miss keyword rule)
  //   --mandatory --node "p" → [node:p] [!]    ([!] redundant on node: — see T5.6)
  //   --mandatory (no scope) → [!]             → REJECTED (fires nowhere)
  //   (no scope flag)        → untagged; auto-tagger will tag later
  const scopeFlags = [args.node ? 'node' : null, args.global ? 'global' : null].filter(Boolean);
  if (scopeFlags.length > 1) {
    process.stderr.write('cerebrum remember: --node and --global are mutually exclusive\n');
    return 1;
  }

  // Keyword rules → ONE [kw:...] bucket. cerebrum-v2: the critical-`*` / general /
  // `;min=` scoring grammar is RETIRED (anchor #8) — BM25 over the keywords field
  // ranks them now. --critical-keywords folds into plain keywords (deprecated alias,
  // terms preserved). Keyword importance ([!]) is set explicitly via --mandatory
  // (T5.6: [!] only changes behavior on kw: rules — the recall floor + write-gate).
  let kwBucketContent = null;
  // Flag-present check (not truthiness): `--keywords ""` (or with no value) must
  // hit the empty-keywords error below, not silently fall through to an untagged rule.
  if (args.keywords !== null || args.criticalKeywords !== null) {
    const kws = [...(args.criticalKeywords || '').split(','), ...(args.keywords || '').split(',')]
      .map((k) => k.trim().replace(/^\*+/, '')).filter(Boolean);
    if (kws.length === 0) {
      process.stderr.write('cerebrum remember: keyword flags require at least one non-empty keyword\n');
      return 1;
    }
    kwBucketContent = kws.join(', ');
  }

  const today = todayUtc();
  // v2 grammar: scope tokens first, [!] importance last (mirrors the migration's
  // [global]/[node:F]/[kw:…] + [!] order).
  //
  // cerebrum-v2 T5.5: --mandatory is the importance flag ([!]); it carries no
  // scope of its own. A bare `--mandatory` (no --global/--node/--keywords) yields
  // a scope-less [!], which fires in NO channel — the shared linter (below)
  // rejects it with an actionable message. We do NOT silently auto-scope it.
  const bucketParts = [];
  if (args.global)     bucketParts.push('[global]');
  if (args.node)       bucketParts.push(`[node:${args.node}]`);
  if (kwBucketContent) bucketParts.push(`[kw:${kwBucketContent}]`);
  if (args.mandatory)  bucketParts.push('[!]');

  const prefix = bucketParts.length > 0 ? `${bucketParts.join(' ')} ` : '';
  const line = `- ${today}: ${prefix}${args.text}\n`;

  await ensureCerebrumDir(root);
  const target = cerebrumPath(root);

  // Append through the locked parse/serialize path (no raw appendFile). This
  // eliminates the bug-1 fusion class structurally: the new rule is parsed into
  // its own entry and appendEntries lands it on its own line (before any
  // trailing blank), then the integrity guard validates before the write.
  const ruleText = line.replace(/\n+$/, '');
  const newEntry = parseCerebrum(ruleText).lines.find((e) => e.kind === 'rule');
  if (!newEntry) {
    process.stderr.write('cerebrum remember: internal error — composed rule did not parse as a rule\n');
    return 1;
  }

  // cerebrum-v2 (T5.5): reject mal-formatted rules at authoring time — the
  // tightest loop (remember is a Bash call, so the PreToolUse structural gate
  // never sees it). Same shared linter the Stop gate + doctor use. ERROR-only;
  // warns (e.g. a not-yet-created [node:] path) don't block a deliberate write.
  const lint = lintCerebrumRule(newEntry, { root });
  if (lint.errors.length > 0) {
    process.stderr.write('cerebrum remember: rule rejected — fix the format and retry:\n');
    for (const m of lint.errors) process.stderr.write(`  - ${m}\n`);
    return 1;
  }

  const written = await updateCerebrumFile(
    target,
    (parsed) => { ensureV2Header(parsed); return appendEntries(parsed, [newEntry]); },
    { lockTimeoutMs: CLI_LOCK_TIMEOUT_MS },
  );
  if (written === null) {
    process.stderr.write('cerebrum remember: could not acquire cerebrum lock (another writer is busy); rule NOT saved — retry\n');
    return 1;
  }

  if (bucketParts.length === 0) {
    process.stderr.write('cerebrum remember: no scope set — this rule matches only incidentally until it is scoped; add --node/--keywords/--global, or let the auto-tagger scope it.\n');
  }
  process.stdout.write(`Appended to cerebrum.md: ${ruleText}\n`);
  process.stdout.write(`  line-hash: ${hashLine(ruleText)}\n`);
  return 0;
}

// --- promote ---------------------------------------------------------------

async function cmdPromote(root, args) {
  if (!args.lineHash || args.lineHash.length === 0) {
    process.stderr.write('cerebrum promote: --line-hash is required\n');
    return 1;
  }

  const cPath = cerebrumPath(root);
  await ensureCerebrumDir(root);

  // cerebrum-v2 (T3.5): promote is an in-place [!] flag-flip in the single store
  // — no file move. Locate the rule (read-only) for a precise not-found message;
  // the authoritative flip re-finds it by hash under the lock.
  const parsed = await readCerebrumFile(cPath);
  const original = parsed.lines.find(
    (e) => e.kind === 'rule' && hashLine(e.raw) === args.lineHash,
  );
  if (!original) {
    process.stderr.write(`cerebrum promote: no rule found with hash ${args.lineHash}\n`);
    return 1;
  }
  if (original.buckets.includes('!')) {
    process.stdout.write(`Already mandatory: ${original.raw.trim()}\n`);
    return 0;
  }

  // cerebrum-v2 T6: a [provisional] rule is in the review queue — promoting it
  // (adding [!]) does nothing until it's triaged (the kw resolver skips the
  // exact-floor for provisional rules). Triage it first via /sextant:triage.
  if (original.buckets.includes('provisional') || original.buckets.includes('!review')) {
    process.stderr.write(
      'cerebrum promote: this rule is [provisional] (review queue) — [!] has no effect until it is triaged.\n' +
      'Re-scope it first: cerebrum forget --line-hash ' + args.lineHash + ', then cerebrum remember --keywords "…" --mandatory --text "<body>".\n',
    );
    return 1;
  }

  // cerebrum-v2 T6: [!] is a KW-ONLY importance modifier (it adds the exact
  // recall floor + the write-gate). Promoting a non-kw rule would only stamp a
  // redundant [!] — node:/global already fire by scope (T5.6), and a scope-less
  // rule fires nowhere. Refuse with guidance rather than author a rule the lint
  // immediately warns about (the prose-vs-behavior divergence T6 exists to kill).
  const isKw = original.buckets.some((b) => typeof b === 'string' && b.startsWith('kw:'));
  if (!isKw) {
    process.stderr.write(
      'cerebrum promote: [!] only affects [kw:…] rules (it adds the exact recall floor + the write-gate).\n' +
      'This rule has no [kw:] bucket — node:/global rules already fire by scope, and a scope-less rule fires nowhere.\n' +
      'To make it a keyword safety rule: cerebrum forget --line-hash ' + args.lineHash + ', then\n' +
      '  cerebrum remember --keywords "<decisive terms>" --mandatory --text "<body>"\n',
    );
    return 1;
  }

  let promotedRaw = original.raw;
  const updated = await updateCerebrumFile(
    cPath,
    (p) => {
      const e = p.lines.find((x) => x.kind === 'rule' && hashLine(x.raw) === args.lineHash);
      if (e && !e.buckets.includes('!')) {
        e.raw = appendBucketToPrefix(e.raw, '[!]');
        promotedRaw = e.raw;
      }
      return p;
    },
    { lockTimeoutMs: CLI_LOCK_TIMEOUT_MS },
  );
  if (updated === null) {
    process.stderr.write('cerebrum promote: could not acquire cerebrum.md lock; nothing changed — retry\n');
    return 1;
  }

  // The in-place [!] flip rewrote the line, so its hash changed. Carry the
  // rule's fire history from the old hash to the new one — otherwise promoting
  // a frequently-firing rule (the whole point) would orphan its measured
  // history. Migrate only when the rewrite actually happened (hash changed).
  const newHash = hashLine(promotedRaw);
  if (newHash !== args.lineHash) {
    await migrateRuleFires(durableBase(root), [{ oldHash: args.lineHash, newHash }]);
  }

  process.stdout.write(`Promoted: ${promotedRaw.trim()}\n`);
  process.stdout.write(`  line-hash: ${newHash}\n`);
  return 0;
}

// --- forget ----------------------------------------------------------------

async function cmdForget(root, args) {
  if (!args.lineHash || args.lineHash.length === 0) {
    process.stderr.write('cerebrum forget: --line-hash is required\n');
    return 1;
  }

  await ensureCerebrumDir(root);
  const cPath = cerebrumPath(root);

  // cerebrum-v2 (T3.5): forget operates on the single store. Locate (read-only)
  // for a precise not-found message; the authoritative remove re-finds by hash.
  const parsed = await readCerebrumFile(cPath);
  const original = parsed.lines.find(
    (e) => e.kind === 'rule' && hashLine(e.raw) === args.lineHash,
  );
  if (!original) {
    process.stderr.write(`cerebrum forget: no rule found with hash ${args.lineHash}\n`);
    return 1;
  }

  // Order so a failure errs toward a recoverable duplicate, never a lost rule:
  // ARCHIVE first (the rule's audit copy), THEN remove from the store. Both go
  // through the locked parse/serialize path — no raw appendFile.
  const today = todayUtc();
  const marker = `<!-- sextant:archived ${today} -->`;
  const archiveEntries = parseCerebrum(`${marker}\n${original.raw}`).lines;
  const archived = await updateCerebrumFile(
    archivePath(root),
    (p) => appendEntries(p, archiveEntries),
    { lockTimeoutMs: CLI_LOCK_TIMEOUT_MS },
  );
  if (archived === null) {
    process.stderr.write('cerebrum forget: could not acquire archive.md lock; nothing changed — retry\n');
    return 1;
  }

  const removed = await updateCerebrumFile(
    cPath,
    (p) => {
      const idx = p.lines.findIndex(
        (e) => e.kind === 'rule' && hashLine(e.raw) === args.lineHash,
      );
      if (idx >= 0) p.lines.splice(idx, 1);
      return p;
    },
    { lockTimeoutMs: CLI_LOCK_TIMEOUT_MS },
  );
  if (removed === null) {
    process.stderr.write(
      `cerebrum forget: archived the rule but could not lock cerebrum.md to remove it — it still exists there; retry forget on hash ${args.lineHash}\n`,
    );
    return 1;
  }

  process.stdout.write(`Forgot (archived from cerebrum.md): ${original.raw.trim()}\n`);
  return 0;
}

// --- audit -----------------------------------------------------------------

async function cmdAudit(root, args) {
  // cerebrum-v2 (T3.5): surface the review queue ([provisional]) from the single
  // store. Each line prints with its hash prefix so the user can hand the hash to
  // `promote` or `forget`.
  const groups = [];
  {
    const parsed = await readCerebrumFile(cerebrumPath(root));
    const queue = listReviewQueue(parsed);
    if (queue.length > 0) groups.push({ filename: 'cerebrum.md', entries: queue });
  }

  const total = groups.reduce((s, g) => s + g.entries.length, 0);
  process.stdout.write(`Review queue (${total} entries):\n`);
  if (total === 0) {
    process.stdout.write('  (empty)\n');
  } else {
    for (const g of groups) {
      process.stdout.write(`  ${g.filename}:\n`);
      for (const entry of g.entries) {
        const hash = hashLine(entry.raw);
        // Render bucket(s) + body in a compact form. Prefer canonical buckets in
        // the order they appeared.
        const buckets = entry.buckets.map((b) => `[${b}]`).join(' ');
        const body = typeof entry.body === 'string' ? entry.body : '';
        process.stdout.write(`    [${hash}] ${buckets} ${body}\n`);
      }
    }
  }

  // cerebrum-v2 (T5): the legacy-keyword re-scoping scan was removed — the
  // critical-`*`/general/`;min` scoring model it surfaced is retired (anchor #8).
  // `--legacy-keywords` is now an accepted-and-ignored deprecated flag.
  return 0;
}

// --- list ------------------------------------------------------------------

// List every rule in the store with its line hash, so the hash is on hand for
// `promote` / `forget`. Same [<hash>] <buckets> <body> shape as `audit`.
async function cmdList(root) {
  const parsed = await readCerebrumFile(cerebrumPath(root));
  const rules = (parsed.lines || []).filter((e) => e.kind === 'rule');
  process.stdout.write(`cerebrum.md (${rules.length} rules):\n`);
  if (rules.length === 0) {
    process.stdout.write('  (empty)\n');
    return 0;
  }
  for (const e of rules) {
    const hash = hashLine(e.raw);
    const buckets = Array.isArray(e.buckets) ? e.buckets.map((b) => `[${b}]`).join(' ') : '';
    const body = typeof e.body === 'string' ? e.body : '';
    process.stdout.write(`  [${hash}] ${buckets ? `${buckets} ` : ''}${body}\n`);
  }
  return 0;
}

// --- reconcile -------------------------------------------------------------

async function cmdReconcile(root, _args) {
  const today = todayUtc();
  const turnStartTs = new Date(0).toISOString(); // open-ended floor: any edit counts as "recent" iff a project edit exists.
  // We deliberately don't read last_project_file_edit.json here — the CLI
  // runs outside the hook context, so there's no project-edit signal we can
  // trust. Pass null so every untagged rule lands in [!review]. Users who
  // want high-confidence tagging should edit the project file first and let
  // PostToolUse handle the cerebrum write.
  let totalHigh = 0, totalLow = 0, totalUnchanged = 0, totalLines = 0;
  const rewrites = [];

  // cerebrum-v2 (T3.5): reconcile the single store. Untagged rules land as
  // [provisional] (the v2 review queue) via autoTagFile.
  for (const filename of ['cerebrum.md']) {
    const filePath = path.join(cerebrumDir(root), filename);
    if (!fs.existsSync(filePath)) continue;
    const result = await autoTagFile({
      filePath,
      lastProjectFileEdit: null,
      turnStartTs,
      today,
    });
    totalHigh += result.high;
    totalLow += result.low;
    totalUnchanged += result.unchanged;
    totalLines += result.total_lines;
    if (Array.isArray(result.rewrites)) rewrites.push(...result.rewrites);
    process.stdout.write(
      `Reconciled ${filename}: high=${result.high} low=${result.low} unchanged=${result.unchanged} lines=${result.total_lines}\n`,
    );
  }

  // Re-tagging rehashes any line it touches; carry each rule's fire history
  // across so reconcile doesn't orphan the counts of an already-fired rule.
  await migrateRuleFires(durableBase(root), rewrites);

  process.stdout.write(
    `Total: high=${totalHigh} low=${totalLow} unchanged=${totalUnchanged} lines=${totalLines}\n`,
  );
  return 0;
}

// --- migrate (cerebrum-v2 / tranche T1) ------------------------------------

// One-time, NON-DESTRUCTIVE migration of the two-file store into one
// cerebrum.md (see docs/feature-plans/cerebrum-v2/). regular.md/mandatory.md are
// LEFT IN PLACE — cutover to the one store is tranche T2. Idempotent via the v2
// header sentinel; backs up the pre-v2 files OUTSIDE the cerebrum dir (so no
// future "glob the whole store" reader counts them as live rules); --rollback
// restores from backup; --dry-run reports without writing.
async function cmdMigrate(root, args) {
  const dir = cerebrumDir(root);
  const regP = regularPath(root);
  const manP = mandatoryPath(root);
  const arcP = archivePath(root);
  const oneP = path.join(dir, 'cerebrum.md');
  const bDir = path.join(root, '.sextant', 'backups', 'cerebrum-pre-v2');

  // --rollback: restore the pre-v2 files and remove the one store.
  if (args.rollback) {
    if (!fs.existsSync(bDir)) {
      process.stderr.write('cerebrum migrate: no backup at .sextant/backups/cerebrum-pre-v2/ — nothing to roll back\n');
      return 1;
    }
    for (const name of ['regular.md', 'mandatory.md', 'archive.md']) {
      const src = path.join(bDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    if (fs.existsSync(oneP)) fs.unlinkSync(oneP);
    process.stdout.write('Rolled back: restored pre-v2 cerebrum files from backup; removed cerebrum.md.\n');
    return 0;
  }

  // Idempotency: a cerebrum.md carrying the v2 header is already migrated.
  if (fs.existsSync(oneP)) {
    const cur = fs.readFileSync(oneP, 'utf8');
    if (cur.startsWith(CEREBRUM_V2_HEADER) && !args.force) {
      process.stdout.write('cerebrum migrate: cerebrum.md already migrated (v2 header present); nothing to do. Pass --force to re-migrate.\n');
      return 0;
    }
  }

  const manText = fs.existsSync(manP) ? fs.readFileSync(manP, 'utf8') : '';
  const regText = fs.existsSync(regP) ? fs.readFileSync(regP, 'utf8') : '';
  if (manText === '' && regText === '') {
    process.stderr.write('cerebrum migrate: no regular.md or mandatory.md found; nothing to migrate\n');
    return 1;
  }

  const res = migrateCerebrumStores({ mandatoryText: manText, regularText: regText });
  // Prove the remap is lossless BEFORE any bytes are written.
  assertMigrationIntegrity({ mandatoryText: manText, regularText: regText }, res.text);

  const report = [];
  report.push(`cerebrum-v2 migration: ${res.rulesIn} rules in → ${res.rulesOut} rules out (one store).`);
  if (res.deadToLive.length > 0) {
    report.push(`  ${res.deadToLive.length} previously-inert regular.md rule(s) resurrected to live ([global]/[!]):`);
    for (const r of res.deadToLive) {
      const preview = r.rest.length > 80 ? r.rest.slice(0, 77) + '...' : r.rest;
      report.push(`    [${r.after.join('][')}] ${preview}`);
    }
    report.push('  Review these — /forget any that are stale (e.g. a dead [todo] rule).');
  }

  if (args.dryRun) {
    process.stdout.write(report.join('\n') + '\nDry-run: nothing written.\n');
    return 0;
  }

  // Back up the pre-v2 files (only once — the first backup is the true snapshot;
  // the source files are never mutated, so a later --force won't lose anything).
  if (!fs.existsSync(bDir)) {
    fs.mkdirSync(bDir, { recursive: true });
    for (const [name, p] of [['regular.md', regP], ['mandatory.md', manP], ['archive.md', arcP]]) {
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bDir, name));
    }
    report.push('  Backed up pre-v2 files → .sextant/backups/cerebrum-pre-v2/');
  } else {
    report.push('  Backup already exists (pre-v2 snapshot preserved; not overwritten).');
  }

  // Write the one store atomically. parseCerebrum→serialize round-trips res.text
  // byte-for-byte (raw is preserved per entry); writeCerebrumFile is tmp+rename.
  await writeCerebrumFile(oneP, parseCerebrum(res.text));
  report.push('  Wrote .sextant/cerebrum/cerebrum.md (old files retained; cutover is T2).');

  process.stdout.write(report.join('\n') + '\n');
  return 0;
}

// --- doctor ----------------------------------------------------------------

// cmdDoctor: lint the one store + detect a v1/partly-migrated store. Advisory —
// prints findings to stdout and returns 0 even when findings exist (an IO error
// returns 1). Lints, per rule: a stale [node:<path>] (path missing under root),
// an empty [kw:] bucket, and [!] importance with no scope token (node:/kw:/global)
// — which fires nowhere (listMandatoryFor needs node/!global; kw needs a kw bucket).
//
// The migrate recommendation is HEALTH-gated, NOT presence-gated: migration RETAINS
// regular.md/mandatory.md on disk, so their mere presence is not a problem. We
// recommend `migrate` only when cerebrum.md is absent, or has rules but lacks the
// v2 header (a partial migration). v1 leftovers beside a healthy store → info only.
async function cmdDoctor(root) {
  const cPath = cerebrumPath(root);
  const findings = []; // { level: 'warn' | 'info', hash?, msg }

  const hasV2 = fs.existsSync(cPath);
  const hasV1 = fs.existsSync(regularPath(root)) || fs.existsSync(mandatoryPath(root));

  let parsed = { lines: [] };
  if (hasV2) {
    try {
      parsed = await readCerebrumFile(cPath);
    } catch (err) {
      process.stderr.write(`cerebrum doctor: could not read ${cPath}: ${err.message}\n`);
      return 1;
    }
  }

  const ruleEntries = parsed.lines.filter((e) => e.kind === 'rule');
  const hasV2Header = parsed.lines.some(
    (e) => e.kind === 'comment' && e.raw.trim() === CEREBRUM_V2_HEADER,
  );

  // Store-level health (migrate recommendation is health-gated — see header).
  if (!hasV2) {
    if (hasV1) {
      findings.push({ level: 'warn', msg: "v1 store present (regular.md/mandatory.md) but no cerebrum.md — run 'cerebrum migrate'." });
    } else {
      process.stdout.write('cerebrum doctor: no store found (.sextant/cerebrum/cerebrum.md). Nothing to lint.\n');
      return 0;
    }
  } else if (ruleEntries.length > 0 && !hasV2Header) {
    findings.push({ level: 'warn', msg: "cerebrum.md has rules but lacks the v2 header — possible partial migration; run 'cerebrum migrate'." });
  } else if (hasV1) {
    findings.push({ level: 'info', msg: 'legacy v1 files (regular.md/mandatory.md) present beside a healthy cerebrum.md — safe to archive.' });
  }

  // Per-rule lint — the SHARED linter (same logic the Stop gate + remember use).
  for (const e of ruleEntries) {
    const { errors, warns } = lintCerebrumRule(e, { root });
    if (errors.length === 0 && warns.length === 0) continue;
    const hash = hashLine(e.raw);
    const preview = (typeof e.body === 'string' ? e.body : e.raw).slice(0, 60);
    for (const m of errors) findings.push({ level: 'error', hash, msg: `${m} — "${preview}"` });
    for (const m of warns) findings.push({ level: 'warn', hash, msg: `${m} — "${preview}"` });
  }

  // Report.
  const errs = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  process.stdout.write(`cerebrum doctor: ${ruleEntries.length} rule(s) checked; ${errs.length} error(s), ${warns.length} warning(s).\n`);
  for (const f of findings) {
    const tag = f.level === 'error' ? 'ERROR' : (f.level === 'warn' ? 'WARN' : 'info');
    const h = f.hash ? `[${f.hash}] ` : '';
    process.stdout.write(`  ${tag}: ${h}${f.msg}\n`);
  }
  if (errs.length === 0 && warns.length === 0) process.stdout.write('  OK — no misfiled/malformed rules.\n');
  return 0;
}

// --- explain ---------------------------------------------------------------

// cmdExplain: print the canonical "how cerebrum evaluates rules" rubric. The
// single ground truth lives in lib/inject/cerebrumModel.mjs (cerebrum-v2 T5.6:
// the two-tier model); this surfaces it to an agent (e.g. /sextant:cerebrum-audit)
// without writing anything to disk.
function cmdExplain() {
  process.stdout.write(CEREBRUM_MODEL.endsWith('\n') ? CEREBRUM_MODEL : CEREBRUM_MODEL + '\n');
  return 0;
}

// --- helpers ---------------------------------------------------------------

// Append a bucket token at the END of an existing rule line's bucket prefix
// (after the last [..] token, before the body). Canonical order matches what
// `remember` writes: scope buckets first, [!] last.
function appendBucketToPrefix(raw, bucketToken) {
  const m = raw.match(/^(\s*-\s+\d{4}-\d{2}-\d{2}:\s*(?:\[[^\]]*\]\s*)*)/);
  if (!m) {
    // Not a recognisable rule head — return unchanged. Caller already
    // verified shape via parseCerebrum so this is defensive.
    return raw;
  }
  const prefix = m[1];                 // head + existing bucket tokens (+ trailing space)
  const body = raw.slice(prefix.length);
  return `${prefix}${bucketToken} ${body}`;
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
  const root = args.root ? path.resolve(args.root) : process.cwd();

  switch (sub) {
    case 'remember':  return await cmdRemember(root, args);
    case 'promote':   return await cmdPromote(root, args);
    case 'forget':    return await cmdForget(root, args);
    case 'audit':     return await cmdAudit(root, args);
    case 'list':      return await cmdList(root);
    case 'reconcile': return await cmdReconcile(root, args);
    case 'migrate':   return await cmdMigrate(root, args);
    case 'doctor':    return await cmdDoctor(root);
    case 'explain':   return cmdExplain();
    default:
      process.stderr.write(`cerebrum: unknown subcommand "${sub}"\n`);
      process.stderr.write(USAGE + '\n');
      return 2;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`cerebrum: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

// Re-exports for testing the helpers directly.
export { hashLine, appendBucketToPrefix, parseArgs };
// Round-trip sanity tag — keep serializeCerebrum live so future maintenance
// notices when the import is no longer needed.
void serializeCerebrum;
