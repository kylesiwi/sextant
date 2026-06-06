---
description: Show promotion candidates, demote candidates, and contradiction warnings from the cerebrum. Optionally dispatches the sextant-reviewer subagent for structured analysis.
allowed-tools: [Bash, Read, Task]
argument-hint: ""
---

Run the promotion-ladder review: identify rules that have earned mandatory status, rules that have rarely fired, and contradiction warnings from the cerebrum heuristic detector.

## Step 1 — invoke the CLI

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/review.mjs" --json
```

The CLI reads `.sextant/stats.json` and the cerebrum (`.sextant/cerebrum/cerebrum.md`) and emits a JSON payload with three arrays: `promotion`, `demote`, `contradictions`. If `.sextant/stats.json` is absent the CLI prints `no measurement data yet — accumulate via use` and exits 0; once it exists, the arrays are simply empty until rules accrue fires.

## Step 2 — present the summary

Read the JSON. Each `promotion`/`demote` entry carries a `line_hash` — include it so the user can
act on a candidate directly. Render the three sections back to the user in plain Markdown:

```
## Promotion candidates (<N>)
- [<line_hash>] <body> — <fires> fires, last fired <when>

## Demote candidates (<N>)
- [<line_hash>] <body> — <fires> fires, <ratio>% fire rate

## Contradictions (<N>)
- <body_a>
  vs <body_b>
  reason: <reason>
```

If any section is empty, write `(none)`. Do not apply changes from the output. Print the results and wait for the user to run `/sextant:promote --line-hash <hash>` / `/sextant:forget --line-hash <hash>` to apply.

Limit each entry to 1-2 lines. If any section exceeds 20 items, show the first 20 and append `(N more — run with --verbose for full list)`.

## Step 3 — subagent analysis

When the JSON payload contains at least one entry across `promotion`, `demote`, or `contradictions`, dispatch the `sextant-reviewer` subagent via the Task tool with the full JSON payload as input. The subagent returns per-candidate recommendations (1-2 sentences each).

Skip dispatch only when the user explicitly requested a bare list (e.g., "just show the list", "no analysis").

The `sextant-reviewer` subagent is bundled with the plugin (`${CLAUDE_PLUGIN_ROOT}/agents/sextant-reviewer.md`) and is available whenever Sextant is installed — no setup step required.

## Notes

- The promotion threshold defaults to 50 fires and is tunable via the `SEXTANT_PROMOTION_THRESHOLD` env var (the default is arbitrary).
- Contradiction detection is heuristic: it pairs rules with opposite verbs (`always`/`never`, `prefer`/`avoid`, `must`/`must not`, `required`/`forbidden`, `enable`/`disable`, `allow`/`deny`) that share a content keyword. It compares `[global]` and `[kw:]` rules against each other; a `[node:]` rule is checked only against other rules for the same file. Findings are candidates for you to judge, not confirmed conflicts; subtler semantic conflicts slip past.
- Demote candidates require *both* low fire ratio AND no fires in the last 30 days; brand-new rules aren't demoted on noise.
