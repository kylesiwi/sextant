---
description: Show measurement and A/B arm statistics for this project.
allowed-tools: [Bash]
argument-hint: ""
---

Print Sextant's measurement counters and A/B arm assignment for the current project (`.sextant/stats.json`). These accumulate over time on the treatment arm (`ab_arm === 'B'`); on the control arm the counters are deliberately left untouched to protect the promotion ladder.

## Step 1 — invoke the CLI

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/stats.mjs"
```

Output shape:

```
Sextant stats (root: <cwd>)
  A/B arm: <arm>
  Sessions: <N>
  Tokens saved (estimate): <N>
  Tokens paid extra: <N>
  Net savings: <delta>
  Top rules by fires:
    1. <body...> (<N> fires)
    2. ...
  Redundant reads blocked: <N>
  Last updated: <iso>
```

If `.sextant/stats.json` is absent, the CLI prints `no measurement data yet — stats accumulate as you use Sextant`. Once the project is set up the file exists, so you'll see a zero-filled table (counters accrue on the treatment arm) until rules start firing.

## Step 2 — interpret

- **A/B arm** is deterministic per `session_id`; reroll a session (e.g. start a new Claude Code conversation) to land on the other arm.
- **Tokens saved (estimate)**: when this value is 0, tell the user that savings measurement is not yet active.
- **Net savings**: when negative, tell the user this is expected — the system tracks injection cost but savings measurement is not yet active.
- **Top rules by fires** is sorted by `fires` desc. Bodies are resolved from `.sextant/cerebrum/cerebrum.md`; a forgotten/archived rule shows `<hash ...>` instead.
