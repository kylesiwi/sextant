---
description: Triage the cerebrum — list the review queue, then optionally sweep for stale rules. Advisory only.
allowed-tools: [Bash, Read, AskUserQuestion]
argument-hint: ""
---

Audit the project's cerebrum (`.sextant/cerebrum/cerebrum.md`). The base pass lists rules that need human
review; then you offer a deeper staleness pass. This command is **advisory** — it prints recommendations and
the exact commands, and waits for the user to act. For a full rule-by-rule channel/scope/format audit against
the rule model, use `/sextant:cerebrum-audit` instead.

## Step 1 — review queue (always)

List the `[provisional]` rules in `cerebrum.md` — the review queue of low-confidence auto-tagged captures awaiting a real scope.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" audit
```

Output shape:

```
Review queue (<N> entries):
  cerebrum.md:
    [<hash>] [provisional] <body>
```

For each entry, print a short recommendation:

- `[provisional]` with no real scope → give it one: `/sextant:forget --line-hash <hash>`, then re-record via
  `/sextant:remember --node "<path>"` (file fact) or `--keywords "<decisive terms>"` (cross-cutting topic).
- A keyword rule the user wants as a must-never-miss safety rule → `/sextant:promote --line-hash <hash>`
  (adds `[!]`; keyword rules only).
- Anything stale → `/sextant:forget --line-hash <hash>`.

When the queue is empty the CLI prints `(empty)`. Either way, continue to Step 2.

The review queue lists only `[provisional]` rules. To act on any other rule, `cerebrum list` prints
every rule in the store with its line hash.

## Step 2 — offer the deeper passes

Use `AskUserQuestion` (multiSelect) to ask which deeper passes to run (not mutually exclusive):

- **Freshness & staleness** — find rules that have rarely or never fired and are candidates for archiving.
- **Channel / scope fit** — find rules in the wrong tier (a `[global]` that should be `[kw:]`, a `[kw:]` with
  weak/generic keywords, a redundant `[!]` on a node/global rule).

If the user picks neither, stop here.

## Step 3a — freshness & staleness (if selected)

Run the measurement-ladder review CLI and surface its demote candidates (low fire-rate AND cold ≥ 30 days):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/review.mjs" --json
```

Present the `demote` array as "stale candidates": `<body> — <fires> fires, <ratio>% rate, last fired <when>`,
and note the `promotion` array. For each stale rule, recommend `/sextant:forget --line-hash <line_hash>`
(archive) or a reword so it matches more often.

If the CLI prints `no measurement data yet`, fall back to reading `cerebrum.md` and listing rules oldest-first
by their `YYYY-MM-DD` date prefix so the user can eyeball obviously-stale entries. Confident staleness needs
accumulated measurement (see `/sextant:stats`).

## Step 3b — channel / scope fit (if selected)

Hand this to the model-aware auditor, which applies the canonical rule model (`cerebrum explain`) rule by rule:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" doctor --root "$PWD"
```

`doctor` flags format/scope errors (bucket-shaped tags in the body, empty `[kw:]`, scope-less `[!]`) and
warns on a redundant `[!]` on a node:/global rule. For deeper per-rule judgement (a `[global]` that should be
`[kw:]`, weak/generic keywords), run `/sextant:cerebrum-audit` (full rubric) or `/sextant:review` (the
`sextant-reviewer` subagent: promotion / demotion / contradiction + keyword-scoping). Recommend the concrete
re-author for each — `forget` the old line, then re-record via `/sextant:remember` with the right scope flags.

## Don't apply changes

Print the recommendations and the exact commands; wait for the user to choose which to run. Never run
`forget` / `remember` / `promote` automatically from audit output.
