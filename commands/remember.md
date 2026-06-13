---
description: Record a rule into the cerebrum (.sextant/cerebrum/cerebrum.md); choose its scope (--node / --keywords / --global) so it fires reliably.
allowed-tools: [Bash, Read, AskUserQuestion]
argument-hint: ""
---

Record a rule you've decided to capture. Derive the rule body and scope from the current context.
(Run `cerebrum explain` any time for the full rule model.)

## Step 1 — choose the scope (scope decides how the rule fires)

A rule's SCOPE decides its delivery channel. Pick one, or none:

- `--node "<path>"` — a fact about ONE file. Fires deterministically when that exact file is
  **read** (once per turn) **and written** (every edit). The best default for file-specific rules.
- `--keywords "w1,w2"` — a cross-cutting topic. Ranked by relevance (BM25): fires when those words
  appear in a prompt or a tool's input. Choose **decisive** keywords (domain nouns, API/symbol names,
  filenames, error codes) — never generic words like `todo`, `test`, `env`, `port`, `path`, which over-fire.
- `--global` — applies everywhere (the project "constitution"). Always-on; shown once per session. Use sparingly.
- none — leave untagged and the auto-tagger scopes it `[node:<path>]` (if a project file was just edited)
  or `[provisional]` (the review queue). The auto-tagger runs after a tool edit, so when you author by a
  direct CLI call with no edit in play, pass an explicit scope — an untagged rule only matches incidentally
  until it's tagged.

### `--mandatory` is keyword-only

`--mandatory` marks a **must-never-miss keyword safety rule**: it adds `[!]`, which gives a `[kw:…]` rule an
exact word-boundary recall floor — it fires whenever a keyword literally appears, regardless of rank, so the
rule is injected as context 100% of the time on a matching Read/Edit/Write/Bash (never throttled like a
general keyword fire). (v0.44.0: `[!]` no longer pauses an edit for your approval — the write-gate that did
that over-fired and couldn't explain itself at the permission card, so it was removed; the rule now surfaces
as injected context, not a prompt.)

- `--mandatory` **only pairs with `--keywords`** → `[kw:w1,w2] [!]`. Use it for safety rules.
- The CLI accepts `--mandatory` on `--node`/`--global` but it does nothing there — those fire by scope, so
  `[!]` is redundant (`cerebrum doctor` warns). Only a scope-less `--mandatory` is rejected (it fires nowhere).

## Step 2 — write the body: tight and head-dense

Write a good rule body BEFORE worrying about the shell:

- **Head-dense — load-bearing part FIRST.** Rules render in full when few apply, but under budget pressure the
  read-time injection trims long bodies tail-first to a ~200-char floor with `…` — so open with the constraint
  or directive and put supporting specifics after it. A rule that opens with backstory risks losing its actual
  point to truncation.
- **Concise, factual, actionable, ground-truth.** State ONE constraint the agent can act on — what to do / not
  do, plus the exact symbol, path, or value that makes it actionable. No history, no narrative, no rationale,
  no "we tried X then Y": that's bug-log material, not a rule.
- **One rule = one constraint.** Split unrelated facts into separate rules so each fires by its own scope.

  - Good: `Use santiagoToday()/asDateOnly for booking dates; never new Date() — Vercel runs UTC, breaks at Santiago midnight.`
  - Weak: `While debugging booking we found that since Vercel is UTC and clients vary, after investigation new Date() turned out to… (the actual rule is now past the 200-char cut)`

Then pass the body through stdin with `--text-stdin` and a quoted heredoc (`<<'SEXTANT_RULE'`) — every rule
uses this form. Put the exact body between the markers (backticks, quotes, and `$` are all safe there); once
written tight, pass it verbatim — don't mangle it for the shell.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" remember --root "$PWD" --text-stdin <SCOPE FLAGS> <<'SEXTANT_RULE'
The rule body, verbatim, on one line.
SEXTANT_RULE
```

Replace `<SCOPE FLAGS>` with the flags from Step 1 (e.g. `--node "src/auth.ts"`, or `--keywords "deploy,friday" --mandatory`). The closing `SEXTANT_RULE` must be on its own line.

## Step 3 — confirm

The CLI prints the appended line (and rejects a mis-formatted rule with an actionable message). If it landed
`[provisional]`, run `/sextant:triage` to give it a real scope. To turn a `[kw:…]` rule into a safety rule
later, `/sextant:review` surfaces frequently-firing rules as promotion candidates with their hash — run
`/sextant:promote --line-hash <hash>` (promote adds `[!]`, and only applies to keyword rules).
