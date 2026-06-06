// lib/stores/cerebrum.mjs — pure parse/serialize for cerebrum markdown files
// (§ 6.2 of GROUND_UP_DESIGN.md).
//
// Cerebrum is a flat append-friendly markdown file. Each rule is one line:
//
//   - YYYY-MM-DD: [<bucket>]... <body> [(by: <session>)] [<marker>]
//
// Bucket prefixes (any order, multiple allowed):
//   [!]              — mandatory
//   [!global]        — applies to all reads
//   [!review]        — low-confidence auto-tag, queued for audit
//   [ai-provisional] — agent-entered, awaiting review
//   [node:<path>]    — file-scoped (exact match Phase 2; glob deferred)
//
// HTML comment markers may sit on the same line (trailing) or on a separate
// preceding line. We attach them to the rule that follows.
//
// Parser anchor (per § 6.2):
//   /^\s*-\s+\d{4}-\d{2}-\d{2}:\s*((?:\[![^\]]*\]\s*|\[ai-provisional\]\s*|\[node:[^\]]+\]\s*)*)/
//
// Round-trip strategy: serializeCerebrum re-emits `raw` for each entry, which
// makes parse(serialize(parse(text))) trivially structurally equivalent. The
// auto-tagger mutates raw strings before they re-enter the cerebrum file, so
// parsing-then-serializing on the same input is intentionally a no-op.
//
// I/O wrappers (readCerebrumFile / writeCerebrumFile) live here only because
// they're trivially small; the parse + serialize core is I/O-free.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { withPathLock } from '../state.mjs';

// Anchor for rule lines. Group 1 captures the concatenated bucket prefix.
// Recognizes BOTH the v1 grammar ([!], [!global], [!review], [ai-provisional])
// and the cerebrum-v2 grammar ([global], [provisional]) so one parser handles
// both during the migration window (see docs/feature-plans/cerebrum-v2/).
const RULE_ANCHOR =
  /^\s*-\s+(\d{4}-\d{2}-\d{2}):\s*((?:\[![^\]]*\]\s*|\[global\]\s*|\[provisional\]\s*|\[ai-provisional\]\s*|\[node:[^\]]+\]\s*|\[kw:[^\]]+\]\s*)*)/;

// Walk individual bucket tokens off a prefix string. Returns canonical names:
//   v1: '!', '!global', '!review', 'ai-provisional', 'node:<path>', 'kw:<…>'
//   v2: 'global', 'provisional' (plus the shared 'node:'/'kw:'/'!')
// '!global' precedes 'global' so [!global] tokenizes to the v1 name, not 'global'.
const BUCKET_TOKEN =
  /\[(!global|!review|!|global|provisional|ai-provisional|node:[^\]]+|kw:[^\]]+)\]\s*/y;

// HTML marker comment, anywhere on a line. Used both for trailing-on-rule
// detection and for picking up free-standing marker lines.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

// (by: <session>) parenthetical.
const BY_SESSION = /\(by:\s*([^)]+)\)/;

// Quick predicate: is this line a rule? (Used by callers + by serializer.)
function looksLikeRule(line) {
  return RULE_ANCHOR.test(line);
}

// Pull every bucket token from a prefix substring. Returns canonical names.
function tokenizeBuckets(prefix) {
  const out = [];
  if (!prefix) return out;
  BUCKET_TOKEN.lastIndex = 0;
  let m;
  while ((m = BUCKET_TOKEN.exec(prefix)) !== null) {
    out.push(m[1]);
    if (BUCKET_TOKEN.lastIndex === m.index) BUCKET_TOKEN.lastIndex++;
  }
  return out;
}

// Extract every HTML-comment marker substring from `s`. Returns the raw
// comment strings (e.g. "<!-- sextant:auto-tag confidence=high -->").
function extractMarkers(s) {
  if (!s) return [];
  const out = [];
  HTML_COMMENT.lastIndex = 0;
  let m;
  while ((m = HTML_COMMENT.exec(s)) !== null) out.push(m[0]);
  return out;
}

// Classify a non-rule line. Markdown headers (#, ##, ...), blank lines, and
// raw HTML-comment lines each get their own kind so we can round-trip without
// muddling them.
function classifyNonRule(line) {
  const trimmed = line.trim();
  if (trimmed === '') return 'blank';
  if (/^#{1,6}\s/.test(trimmed)) return 'header';
  if (/^<!--[\s\S]*-->\s*$/.test(trimmed)) return 'comment';
  return 'other';
}

// Parse one rule line. Returns the entry object (kind === 'rule'). The line
// must have already matched RULE_ANCHOR — callers should anchor-test first.
function parseRuleLine(raw, anchorMatch) {
  const date = anchorMatch[1];
  const prefix = anchorMatch[2] || '';
  const buckets = tokenizeBuckets(prefix);

  // Everything after the bucket prefix is body + optional fields + trailing
  // markers. We strip trailing markers off the *line* (not the body) so
  // marker text doesn't bleed into body text.
  const afterPrefix = raw.slice(anchorMatch[0].length);
  const trailingMarkers = extractMarkers(afterPrefix);

  // Body = afterPrefix with markers and trailing whitespace removed, then
  // with the (by:) field snipped out. ([match:] was deleted in cerebrum-v2 T4
  // — charter anchor #8; the capability is re-keyed onto the [!] write-gate.)
  let body = afterPrefix.replace(HTML_COMMENT, '').trimEnd();

  let bySession = null;
  const byMatch = body.match(BY_SESSION);
  if (byMatch) {
    bySession = byMatch[1].trim();
    body = (body.slice(0, byMatch.index) + body.slice(byMatch.index + byMatch[0].length)).trim();
  }

  body = body.trim();
  if (body === '') body = null;

  return {
    raw,
    kind: 'rule',
    date,
    buckets,
    body,
    bySession,
    markers: trailingMarkers, // preceding markers attached by parseCerebrum
  };
}

// Public: parse cerebrum text into an ordered list of entries.
//
// Preserves line order. Non-rule lines (blank, header, comment, other) keep
// their kind so serializeCerebrum can round-trip them. Preceding HTML-comment
// lines are *also* recorded as their own 'comment' entries (so the serializer
// knows where they live on disk) AND attached to the next rule entry's
// `markers[]` for ergonomic access by callers (e.g. auto-tag wants to see
// confidence markers cheaply).
export function parseCerebrum(text) {
  if (typeof text !== 'string') text = '';
  const lines = text.length === 0 ? [] : text.split(/\r?\n/);
  // split('\n') on trailing newline produces a final empty string; preserve
  // it as a blank entry so round-trip is byte-identical for files ending in
  // a newline. We handle this by simply emitting whatever split gave us.

  const out = [];
  let pendingMarkers = []; // HTML-comment lines immediately preceding a rule

  for (const raw of lines) {
    const anchor = raw.match(RULE_ANCHOR);
    if (anchor) {
      const entry = parseRuleLine(raw, anchor);
      // Prepend preceding markers — they're "owned" by this rule for read
      // access but kept as separate entries for round-trip serialization.
      if (pendingMarkers.length > 0) {
        const precedingTexts = pendingMarkers.map((p) => p.raw.trim());
        entry.markers = [...precedingTexts, ...entry.markers];
        pendingMarkers = [];
      }
      out.push(entry);
      continue;
    }

    const kind = classifyNonRule(raw);
    const node = { raw, kind, date: null, buckets: [], body: null, bySession: null, markers: [] };

    if (kind === 'comment') {
      // Hold this comment to attach to the next rule line (if any). It still
      // becomes its own entry so the serializer emits it on its own line.
      pendingMarkers.push(node);
    } else if (pendingMarkers.length > 0) {
      // Comment-then-non-rule (blank/header/other) breaks the attachment.
      pendingMarkers = [];
    }
    out.push(node);
  }

  return { lines: out };
}

// Public: inverse. Emits the raw text for every entry, joined by newlines.
// Because parser preserves `raw` per entry (including original whitespace),
// this is a faithful round-trip for any text we successfully parsed.
export function serializeCerebrum(parsed) {
  if (!parsed || !Array.isArray(parsed.lines)) return '';
  return parsed.lines.map((e) => e.raw).join('\n');
}

// Read+parse. Missing file => empty parsed object.
export async function readCerebrumFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [] };
    throw err;
  }
  return parseCerebrum(text);
}

// Atomic write of serialized text. tmp file + rename within same dir, so the
// rename is a single inode swap on POSIX (no torn reads). Matches the pattern
// from lib/io.mjs's writeJsonAtomic but for plain text.
//
// PHASE-0 NOTE: this is the UNLOCKED primitive. Production mutators must go
// through updateCerebrumFile() below (lock + integrity guard), not call this
// directly — concurrent writers that don't share the lock can still lose each
// other's updates (tmp+rename prevents torn reads, not lost writes). Kept
// exported for tests and for updateCerebrumFile's internals.
export async function writeCerebrumFile(filePath, parsed) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const text = serializeCerebrum(parsed);
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// --- Phase 0: locked, validated mutation API -------------------------------

// assertCerebrumIntegrity(parsed): the serialization BACKSTOP (not the primary
// defense — see docs/cerebrum-v2-design.md §7). Serializes `parsed`, re-parses
// the result, and asserts the rule set survives the round-trip: same rule
// COUNT and, per rule, the same bucket multiset. This catches the bug-1
// corruption class (two rules fusing onto one line scrambles/merges their
// [kw:]/[node:] tags) BEFORE the bytes reach disk.
//
// Expected buckets are re-derived from each rule entry's OWN raw via a solo
// parse — NOT from the in-memory `.buckets`, because legitimate mutators (the
// auto-tagger) rewrite `.raw` without syncing `.buckets`. So this measures only
// "does every rule's raw still stand as its own line after the join", which is
// exactly the fusion failure mode.
//
// Returns the serialized text on success (usable directly as withPathLock's
// `serialize`); throws on drift so the caller's tmp-write never happens and the
// on-disk file is left untouched.
export function assertCerebrumIntegrity(parsed) {
  const text = serializeCerebrum(parsed);
  const expected = [];
  for (const e of (parsed?.lines ?? [])) {
    if (e.kind !== 'rule') continue;
    const solo = parseCerebrum(e.raw).lines.find((x) => x.kind === 'rule');
    if (!solo) {
      throw new Error(
        `cerebrum integrity: a rule entry no longer parses as a rule (corruption guard): ${JSON.stringify(e.raw).slice(0, 120)}`,
      );
    }
    expected.push(solo.buckets.join(''));
  }
  const after = parseCerebrum(text).lines
    .filter((e) => e.kind === 'rule')
    .map((e) => e.buckets.join(''));
  if (expected.length !== after.length) {
    throw new Error(
      `cerebrum integrity: rule count drift ${expected.length} -> ${after.length} on serialize (corruption guard)`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== after[i]) {
      throw new Error(
        `cerebrum integrity: bucket drift at rule ${i}: [${expected[i].split('')}] -> [${after[i].split('')}] (corruption guard)`,
      );
    }
  }
  return text;
}

// appendEntries(parsed, entries): splice new entries in AFTER the last rule but
// BEFORE any trailing blank entries. A file ending in '\n' parses to a trailing
// blank entry (see parseCerebrum's note on the final empty split element); a
// naive push would land the new rule after it and serialize a spurious blank
// line between rules. Mutates and returns `parsed`.
export function appendEntries(parsed, entries) {
  if (!parsed || !Array.isArray(parsed.lines)) parsed = { lines: [] };
  let at = parsed.lines.length;
  while (at > 0 && parsed.lines[at - 1].kind === 'blank') at--;
  parsed.lines.splice(at, 0, ...entries);
  return parsed;
}

// updateCerebrumFile(filePath, mutator, opts): the ONE mutation entry point for
// every cerebrum writer (CLI remember/promote/forget, the PostToolUse
// auto-tagger). A flock-coordinated read-modify-write built on withPathLock —
// the same primitive bugs.mjs/stats.mjs use — so concurrent writers serialize
// instead of clobbering. parse = parseCerebrum; serialize = the integrity guard
// (validates then serializes; on corruption it throws and nothing is written).
//
// mutator(parsed) may mutate in place or return a new parsed object. Returns
// the written value, or null on lock-acquisition timeout — callers MUST treat
// null as "NOT written" (do not report success). Pass a longer lockTimeoutMs
// for human-facing CLI paths than the hook default (50ms).
export async function updateCerebrumFile(filePath, mutator, opts = {}) {
  return withPathLock(filePath, mutator, {
    defaultValue: { lines: [] },
    parse: parseCerebrum,
    serialize: assertCerebrumIntegrity,
    ...opts,
  });
}

// Public: return the DETERMINISTIC / addressed rules that apply to a given node
// path — the priority-1 tier. cerebrum-v2 T5.6: scope decides the channel, so a
// rule fires here by SCOPE ALONE (no `[!]` needed). `[!]` is now a kw-only
// importance modifier and is irrelevant to node/global firing. Exact match only;
// globs deferred per § 6.2.
//
// Match criteria:
//   - NOT a keyword rule (kw: is the ranked tier, handled by the BM25 path).
//   - NOT provisional (!review stays in the review queue / high-BM25-floor tier,
//     never deterministic — without this guard, dropping the old `[!]` gate would
//     promote every auto-tagged [provisional][node:F] capture to priority-1).
//   - AND (bucket '!global' is present OR a 'node:<nodePath>' bucket exact-
//     matches the queried path).
export function listMandatoryFor(parsed, nodePath) {
  if (!parsed || !Array.isArray(parsed.lines)) return [];
  const out = [];
  for (const e of parsed.lines) {
    if (e.kind !== 'rule') continue;
    if (e.buckets.some((b) => b.startsWith('kw:'))) continue;
    // Provisional stays in the review queue, never deterministic. Check BOTH
    // the normalized token (!review, from readResolvedCerebrum — the production
    // path) AND the raw v2 token (provisional, from a bare parseCerebrum) so
    // this guard holds regardless of which representation the caller passes.
    if (e.buckets.includes('!review') || e.buckets.includes('provisional')) continue;
    const isGlobal = e.buckets.includes('!global');
    const isFileMatch = e.buckets.some((b) => b.startsWith('node:') && b.slice(5) === nodePath);
    if (isGlobal || isFileMatch) out.push(e);
  }
  return out;
}

// Parse a kw bucket's content (everything after "kw:") into critical/general
// keyword sets plus an optional general-threshold override. Scoring grammar:
//
//   *token          — CRITICAL keyword. Its presence alone fires the rule, and
//                     callers never throttle a critical-triggered fire.
//   token           — GENERAL keyword. General keywords fire the rule only when
//                     enough of them co-occur (generalKeywordThreshold), and a
//                     general-triggered fire is windowed-deduped by callers.
//   ; min=N         — trailing override: require N general keywords instead of
//                     the proportional default.
//
//   "*WSL2, *pwsh, env, port"   → critical:[wsl2,pwsh]  general:[env,port]
//   "a, b, c ; min=3"           → general:[a,b,c]  minOverride:3
//
// LEGACY buckets (no '*' marker and no ';min=') leave `critical` empty and
// `minOverride` null. listKeywordMatches treats that as the backward-compatible
// OR semantics (any single keyword fires). This keeps every pre-existing
// `[kw:a,b,c]` rule matching exactly as before — the new threshold only
// activates when an author opts in with '*' or ';min='.
export function parseKeywordBucket(content) {
  let minOverride = null;
  let list = typeof content === 'string' ? content : '';
  const m = list.match(/;\s*min\s*=\s*(\d+)\s*$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) minOverride = n;
    list = list.slice(0, m.index);
  }
  const critical = [];
  const general = [];
  for (const rawTok of list.split(',')) {
    const tok = rawTok.trim();
    if (!tok) continue;
    if (tok.startsWith('*')) {
      const kw = tok.slice(1).trim().toLowerCase();
      if (kw) critical.push(kw);
    } else {
      general.push(tok.toLowerCase());
    }
  }
  return { critical, general, minOverride };
}

// Word-boundary presence test for a single keyword. Falls back to substring
// containment if the keyword can't form a valid regex. Exported for the v2
// keyword resolver (lib/retrieval/keywordRules.mjs), where it backs the exact
// word-boundary recall floor for [!] kw rules and the Bash (no-BM25) path.
export function keywordPresent(kw, lowerText) {
  try {
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lowerText);
  } catch {
    return lowerText.includes(kw);
  }
}

// (cerebrum-v2 T3.5) The v1 keyword SCORING engine — listKeywordMatches +
// generalKeywordThreshold + countKeywordsPresent (critical-*/general/legacy/;min)
// — is DELETED (charter anchor #8). v2 ranks kw rules by BM25 over the `keywords`
// field with the [!] exact word-boundary floor (lib/retrieval/keywordRules.mjs).
// `parseKeywordBucket` is retained: it's the kw-content parser the v2 resolver
// uses to extract a rule's keyword terms (the `*`/`;min` stripping is now inert).

// Public: stable 16-char SHA1 over a rule's raw text. Used by promote /
// forget (bin/cerebrum.mjs) and by Phase 8's stats.rule_fires keying so
// the agent and the ledger see the same identifier for a given rule.
// We snapshot the exact bytes (no trim) so the hash round-trips with the
// on-disk text. bin/cerebrum.mjs's hashLine helper re-exports this — the
// canonical home is here so anything that imports cerebrum can hash.
export function lineHash(raw) {
  return crypto.createHash('sha1').update(typeof raw === 'string' ? raw : '', 'utf8').digest('hex').slice(0, 16);
}

// Public: return all rule entries flagged for human review. cerebrum-v2 (T3.5):
// the v2 token is 'provisional'; the v1 '!review'/'ai-provisional' are still
// recognized so a not-yet-normalized store (or the normalized read path, which
// maps provisional→!review) is handled either way.
export function listReviewQueue(parsed) {
  if (!parsed || !Array.isArray(parsed.lines)) return [];
  const out = [];
  for (const e of parsed.lines) {
    if (e.kind !== 'rule') continue;
    if (e.buckets.includes('provisional') || e.buckets.includes('!review') || e.buckets.includes('ai-provisional')) out.push(e);
  }
  return out;
}

// --- cerebrum-v2 migration (Phase 1 / tranche T1) ---------------------------
//
// One-time, NON-DESTRUCTIVE remap of the two-file store (mandatory.md +
// regular.md) into a single cerebrum.md that separates SCOPE (node:/kw:/global)
// from IMPORTANCE ([!]). See docs/feature-plans/cerebrum-v2/{charter,spec}.md.
// These are PURE transforms (no I/O); the bin/cerebrum.mjs `migrate` subcommand
// does the backup/write/rollback orchestration around them.
//
// The remap rewrites ONLY a rule's bucket PREFIX. Everything after the prefix
// (body, the (by:) parenthetical, trailing markers, and any legacy field text)
// is carried over byte-for-byte — assertMigrationIntegrity proves this.

// First line of a migrated cerebrum.md; doubles as the idempotency sentinel.
export const CEREBRUM_V2_HEADER = '<!-- sextant:cerebrum-v2 -->';

// v1 decorative file-header comments we drop on merge (they describe the old
// two-file split, which no longer exists). Real markers (auto-tag confidence,
// sextant:migrated) are preserved.
const V1_DECORATIVE_COMMENT = /always-injected|ranked rules|append entries|demoted|superseded/i;

// Strip the deleted keyword-scoring grammar from a kw bucket's content: drop the
// trailing `;min=N` override and the leading `*` critical markers, keeping the
// bare keyword list (under v2 these flow into the Lunr `keywords` field — the
// critical/general engine is deleted, anchor #8).
function migrateKwContent(content) {
  let list = typeof content === 'string' ? content : '';
  const m = list.match(/;\s*min\s*=\s*\d+\s*$/i);
  if (m) list = list.slice(0, m.index);
  const toks = list
    .split(',')
    .map((s) => s.trim().replace(/^\*+/, '').trim())
    .filter(Boolean);
  return toks.join(', ');
}

// Remap a canonical v1 bucket-token list (from tokenizeBuckets) to the v2 token
// list, ordered scope/kw first then [!] last to match the target grammar
// (`[global][!]`, `[kw:…][!]`, `[node:F][!]`).
export function migrateBucketTokens(tokens) {
  let importance = false;
  let global = false;
  const mid = [];
  for (const t of tokens || []) {
    if (t === '!') importance = true;
    else if (t === '!global') global = true;                        // [!global] → [global] (T6: [!] kw-only)
    else if (t === '!review') mid.push('provisional');              // anchor #6
    else if (t === 'ai-provisional') { /* deleted (anchor #8) */ }
    else if (t.startsWith('node:')) mid.push(t);                    // preserved
    else if (t.startsWith('kw:')) mid.push(`kw:${migrateKwContent(t.slice(3))}`);
    // unknown tokens can't occur (tokenizeBuckets only yields the above).
  }
  const hasKw = mid.some((t) => t.startsWith('kw:'));
  const out = [];
  if (global) out.push('global');
  out.push(...mid);
  // cerebrum-v2 T6: [!] is a KW-ONLY importance modifier. Keep it ONLY on keyword
  // rules — node:/global fire by scope (and the read-time normalizer re-adds the
  // internal '!' to [global], so global firing is unaffected). A scope-less
  // mandatory rule keeps a bare '!' so the lint flags it for re-scoping; we do not
  // silently promote it to [global].
  if (importance && (hasKw || (mid.length === 0 && !global))) out.push('!');
  return out;
}

// Remap a single raw rule line. Returns { raw, date, before, after, rest } where
// `rest` is the verbatim post-prefix region (body + fields + markers). Returns
// null if the line is not a rule.
export function migrateRuleLine(raw) {
  const m = (typeof raw === 'string' ? raw : '').match(RULE_ANCHOR);
  if (!m) return null;
  const prefix = m[2] || '';
  const head = raw.slice(0, m[0].length - prefix.length); // "<lead>- DATE: "
  const rest = raw.slice(m[0].length);                    // body + fields + markers, VERBATIM
  const before = tokenizeBuckets(prefix);
  const after = migrateBucketTokens(before);
  const newPrefix = after.length ? after.map((t) => `[${t}]`).join(' ') + ' ' : '';
  return { raw: `${head}${newPrefix}${rest}`, date: m[1], before, after, rest };
}

// Walk one source file's raw text, emitting migrated rule lines and preserved
// markers (dropping blanks and the v1 decorative headers). Returns
// { outLines: string[], rules: [{date, before, after, rest}] }.
function migrateFileLines(text) {
  const outLines = [];
  const rules = [];
  const lines = (typeof text === 'string' && text.length) ? text.split(/\r?\n/) : [];
  for (const line of lines) {
    const migrated = migrateRuleLine(line);
    if (migrated) {
      outLines.push(migrated.raw);
      rules.push(migrated);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') continue;                          // drop blanks
    if (/^<!--[\s\S]*-->$/.test(trimmed)) {
      if (V1_DECORATIVE_COMMENT.test(trimmed)) continue;   // drop v1 file headers
      outLines.push(line);                                 // keep real markers
    }
    // any other stray non-rule line is dropped (the v1 store has none in practice).
  }
  return { outLines, rules };
}

// Merge mandatory.md + regular.md into one v2 cerebrum.md text. mandatory rules
// come first (higher importance), then regular rules — a deterministic order.
// Returns { text, rulesIn, rulesOut, deadToLive }.
//   deadToLive: regular.md rules that gain a deterministic marker ([global] or
//   [!]) on remap — previously inert (regular.md is never scanned for mandatory
//   rules), now live constitution rules in the unified store. Surfaced so the
//   user can /forget stale ones and it feeds the T4 behavior-diff.
export function migrateCerebrumStores({ mandatoryText = '', regularText = '' } = {}) {
  const man = migrateFileLines(mandatoryText);
  const reg = migrateFileLines(regularText);
  const bodyLines = [...man.outLines, ...reg.outLines];
  const text = [CEREBRUM_V2_HEADER, ...bodyLines].join('\n') + '\n';
  const deadToLive = reg.rules
    .filter((r) => r.after.includes('global') || r.after.some((t) => t.startsWith('node:')))
    .map((r) => ({ rest: r.rest.trim(), after: r.after }));
  return {
    text,
    rulesIn: man.rules.length + reg.rules.length,
    rulesOut: bodyLines.filter((l) => RULE_ANCHOR.test(l)).length,
    deadToLive,
  };
}

// Union bucket-prefix anchor matching BOTH v1 tokens ([!], [!global], [!review],
// [ai-provisional]) and v2 tokens ([global], [provisional]) plus the shared
// [node:]/[kw:]. The integrity check runs over the v1 INPUT and the v2 OUTPUT, so
// it can't use the v1-only RULE_ANCHOR — that one stops at a bare [global] and
// mis-attributes it to the body (false "body drift"). This union finds the true
// post-prefix boundary on either side. ([todo] and other non-buckets correctly
// stay in `rest` on both sides, so they compare equal.)
const ANY_RULE_ANCHOR =
  /^\s*-\s+(\d{4}-\d{2}-\d{2}):\s*((?:\[(?:![^\]]*|global|provisional|ai-provisional|node:[^\]]+|kw:[^\]]+)\]\s*)*)/;

// Collect (date, rest) for every rule line in a text, in document order. `rest`
// is the byte-exact post-prefix region. Used by the integrity check.
function ruleRestsOf(text) {
  const out = [];
  for (const line of (typeof text === 'string' && text.length ? text.split(/\r?\n/) : [])) {
    const m = line.match(ANY_RULE_ANCHOR);
    if (m) out.push({ date: m[1], rest: line.slice(m[0].length) });
  }
  return out;
}

// v2-aware migration integrity check. The v1 assertCerebrumIntegrity is keyed on
// v1 bucket tokens, so it can't validate v2 tags ([provisional]/[global]); this
// proves the remap is LOSSLESS instead. Asserts, in document order:
//   1. rule count in == out (catches dropped rules and bug-1-class fusion, which
//      collapses two rules onto one line → one fewer leading anchor),
//   2. each rule's date is unchanged,
//   3. each rule's post-prefix region (body + (by:) + markers + any legacy
//      field text) is byte-for-byte identical — the ONLY change is the prefix.
// Throws on any drift; returns the rule count on success.
export function assertMigrationIntegrity({ mandatoryText = '', regularText = '' } = {}, outText) {
  const inRules = [...ruleRestsOf(mandatoryText), ...ruleRestsOf(regularText)];
  const outRules = ruleRestsOf(outText);
  if (inRules.length !== outRules.length) {
    throw new Error(
      `migration integrity: rule count drift ${inRules.length} -> ${outRules.length} (corruption guard)`,
    );
  }
  for (let i = 0; i < inRules.length; i++) {
    if (inRules[i].date !== outRules[i].date) {
      throw new Error(`migration integrity: date drift at rule ${i}: ${inRules[i].date} -> ${outRules[i].date}`);
    }
    if (inRules[i].rest !== outRules[i].rest) {
      throw new Error(
        `migration integrity: body drift at rule ${i} (only the bucket prefix may change):\n` +
        `  in:  ${JSON.stringify(inRules[i].rest).slice(0, 160)}\n` +
        `  out: ${JSON.stringify(outRules[i].rest).slice(0, 160)}`,
      );
    }
  }
  return inRules.length;
}

// --- cerebrum-v2 one-store reader + compat shim (tranche T2) ----------------
//
// The deterministic read channels (preToolUse listMandatoryFor, the SessionStart
// [!global] filter, mandatoryGlobals digest) key on the v1 bucket names. To route
// them through the v2 one store WITHOUT rewriting their semantics (that is T4),
// readResolvedCerebrum reads cerebrum.md and normalizes its v2 tokens back to the
// v1 canonical names. In T2 writes still target the two v1 files and Lunr still
// reads regular.md — only the deterministic read path cuts over.

// Map a v2 bucket-token list to the v1-equivalent names so existing predicates
// fire unchanged. A v2 [global] becomes BOTH '!global' AND '!' because
// listMandatoryFor requires '!' (a bare '!global' is the inert-leak shape and
// would be skipped). A v1 '!global' (already that name) passes through WITHOUT
// gaining '!', preserving v1 firing on the fallback path. [provisional] maps to
// '!review' so it stays queued, not deterministically fired.
export function normalizeV2Buckets(buckets) {
  const out = [];
  const add = (b) => { if (!out.includes(b)) out.push(b); };
  for (const b of (Array.isArray(buckets) ? buckets : [])) {
    if (b === 'global') { add('!global'); add('!'); }
    else if (b === 'provisional') { add('!review'); }
    else add(b); // '!', '!global', 'node:…', 'kw:…' pass through
  }
  return out;
}

// Read a file's text, or null if it doesn't exist (ENOENT). Other errors throw.
async function readTextOrNull(p) {
  try { return await fs.readFile(p, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// ensureV2Header(parsed): guarantee the v2 header comment is the first entry so a
// freshly-created cerebrum.md is recognized as v2 by readResolvedCerebrum. The
// write path calls this inside the locked mutator on every append. Idempotent.
// Mutates and returns `parsed`.
export function ensureV2Header(parsed) {
  if (!parsed || !Array.isArray(parsed.lines)) parsed = { lines: [] };
  const has = parsed.lines.some(
    (e) => e && e.kind === 'comment' && typeof e.raw === 'string' && e.raw.trim() === CEREBRUM_V2_HEADER,
  );
  if (!has) {
    parsed.lines.unshift({
      raw: CEREBRUM_V2_HEADER, kind: 'comment', date: null, buckets: [], body: null, bySession: null, markers: [],
    });
  }
  return parsed;
}

// Read the one authoritative store. cerebrum-v2 / tranche T3.5: `cerebrum.md` is
// the SINGLE source of truth for both read and write. The v1 dual-read
// (mandatory.md/regular.md), the SEXTANT_CEREBRUM_V2 kill-switch, and the
// derive-from-v1 regen are RETIRED. A missing cerebrum.md resolves to an empty
// store (created lazily on first write). Buckets are normalized to the v1
// canonical names (normalizeV2Buckets) so the existing predicates fire unchanged.
// `cerebrumDir` is the absolute <root>/.sextant/cerebrum. Returns
// { parsed, source: 'v2' } (source kept constant for caller compatibility).
export async function readResolvedCerebrum(cerebrumDir) {
  const onePath = path.join(cerebrumDir, 'cerebrum.md');
  const oneText = (await readTextOrNull(onePath)) ?? '';
  const parsed = parseCerebrum(oneText);
  for (const e of parsed.lines) {
    if (e.kind === 'rule') e.buckets = normalizeV2Buckets(e.buckets);
  }
  return { parsed, source: 'v2' };
}

// autoMigrateIfNeeded(cerebrumDir): the SessionStart auto-heal (T3.5/R3). Once v1
// reads are retired, an un-migrated project (no cerebrum.md, but a v1 file with
// rules) would resolve to a SILENTLY EMPTY store. This migrates it ONCE,
// non-destructively: validate the remap, back up the v1 files, write cerebrum.md.
// Returns a structured result for the caller to surface; NEVER throws (a failure
// must surface as a warning, not crash SessionStart). Statuses:
//   { status: 'noop' }      — cerebrum.md already present (migrated).
//   { status: 'empty' }     — no v1 rules to migrate (fresh project; lazy-created on write).
//   { status: 'migrated', count, backupDir }
//   { status: 'failed', error } — integrity drift / write error; caller WARNS and must
//                                  NOT treat the store as legitimately empty.
export async function autoMigrateIfNeeded(cerebrumDir) {
  try {
    const onePath = path.join(cerebrumDir, 'cerebrum.md');
    if ((await readTextOrNull(onePath)) !== null) return { status: 'noop' };

    const manText = (await readTextOrNull(path.join(cerebrumDir, 'mandatory.md'))) ?? '';
    const regText = (await readTextOrNull(path.join(cerebrumDir, 'regular.md'))) ?? '';
    const res = migrateCerebrumStores({ mandatoryText: manText, regularText: regText });
    if (!res || res.rulesOut === 0) return { status: 'empty' };

    // Prove the remap is lossless BEFORE any bytes are written.
    assertMigrationIntegrity({ mandatoryText: manText, regularText: regText }, res.text);

    // Back up the v1 files once (the sources are never mutated; best-effort).
    const backupDir = path.join(cerebrumDir, '..', 'backups', 'cerebrum-pre-v2');
    try {
      await fs.mkdir(backupDir, { recursive: true });
      for (const name of ['regular.md', 'mandatory.md', 'archive.md']) {
        const txt = await readTextOrNull(path.join(cerebrumDir, name));
        if (txt !== null) await fs.writeFile(path.join(backupDir, name), txt, 'utf8');
      }
    } catch { /* best-effort: the source files are retained regardless */ }

    await writeCerebrumFile(onePath, parseCerebrum(res.text));
    return { status: 'migrated', count: res.rulesOut, backupDir };
  } catch (err) {
    return { status: 'failed', error: (err && err.message) ? err.message : String(err) };
  }
}
