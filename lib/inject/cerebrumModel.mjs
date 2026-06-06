// lib/inject/cerebrumModel.mjs — the single canonical description of HOW cerebrum
// rules are evaluated. One inline ground truth, consumed by:
//   - `cerebrum explain`           (bin/cerebrum.mjs) — prints it verbatim
//   - `/sextant:cerebrum-audit`    (commands/cerebrum-audit.md) — the audit rubric
//   - injected instruction headers — teach-by-example on every fire
//
// This is an INLINE constant, never a file written to a user's cwd. Keep it dense
// and AI-legible; it is read by agents, not end users. Keep it in lockstep with
// lib/stores/cerebrum.mjs (listMandatoryFor), lib/hooks/preToolUse.mjs (the
// priority-8 skip + node-on-write + read-dedup), and lib/retrieval/* (kw).

export const CEREBRUM_MODEL = `# How cerebrum evaluates rules

The store is \`.sextant/cerebrum/cerebrum.md\`. One rule per line:
\`- YYYY-MM-DD: [scope] [scope…] [!] body text (by: <session>)\`

SCOPE decides the CHANNEL a rule fires through. There are two channels:

1. DETERMINISTIC / ADDRESSED tier — fires by SCOPE ALONE, no ranking.
   - [node:<path>]  a fact about ONE file. Fires when the agent READS that exact
     file (deduped: once per file per turn) AND when it WRITES that file (100%,
     every edit — the write is the moment the rule most needs to assert). Never
     surfaces on other files. Path is repo-relative; exact match only (no globs yet).
     Fires on reads/writes of the file, NOT on a command that merely names it — for
     a command-triggered rule, use [kw:] with the path as a keyword.
   - [global]       applies everywhere. Injected at SessionStart and re-asserted
     before actions; deduped per session (shown once, not re-spammed).

2. RANKED tier — fires by RELEVANCE, scored against the action.
   - [kw:a, b, c]   keyword rule. Ranked by BM25 over the action's text (file
     path + content / command / prompt). Surfaces when it scores above a
     threshold (writes use a lower, more-permissive threshold than reads).

IMPORTANCE — the [!] flag — is KW-ONLY.
   - On a [kw:…] rule, [!] does two things: (a) an exact word-boundary RECALL
     FLOOR — if any keyword literally appears in the action, the rule fires
     regardless of BM25 score; (b) the WRITE-GATE — on an Edit/Write/MultiEdit whose
     hunk contains a keyword, the tool call escalates to a permission ask.
   - On [node:] / [global], [!] is REDUNDANT — those fire by scope already; it's
     accepted but does nothing, and doctor warns. A bare [!] with NO scope fires
     NOWHERE (rejected at author time).

[provisional]  a not-yet-reviewed capture (the auto-tagger stamps new rules
   this way). It stays in the REVIEW QUEUE — never deterministic — and only
   surfaces on a STRONG BM25 match (a high floor). Promote or forget it via the
   review queue (\`cerebrum audit\`).

AUTHORING (the CLI mirrors the model):
   - fact about one file        → [node:<path>]            (\`remember --node <p>\`)
   - cross-cutting topic        → [kw:terms]               (\`remember --keywords "a,b"\`)
   - must-never-miss kw safety  → [kw:terms] [!]           (\`remember --keywords "a,b" --mandatory\`)
   - applies everywhere         → [global]                 (\`remember --global\`)
   - [!] only ever pairs with [kw:…]. \`--mandatory\` alone is rejected (fires nowhere).

GOOD KEYWORDS are decisive (the rule SHOULD fire when they appear): domain nouns,
API names, file/dir stems. BAD keywords are generic (todo, test, env, path, fix)
— they over-fire. Keep [global] rare (true constitution only); prefer [node:]/[kw:].

BODY — write it tight and HEAD-DENSE:
   - Load-bearing part FIRST. Rules render in full when few apply, but under
     budget pressure long bodies are trimmed tail-first to a ~200-char floor
     ("…"), so open with the constraint/directive; specifics after it.
   - Concise, factual, actionable, ground-truth: ONE constraint the agent can
     act on, plus the exact symbol/path/value. No history, narrative, or
     rationale ("we tried X then Y" is bug-log material, not a rule).
   - One rule = one constraint. Split unrelated facts into separate rules.
`;
