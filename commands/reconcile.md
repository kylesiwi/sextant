---
description: Manually re-run the cerebrum auto-tagger on cerebrum.md. Useful after a hand-edit outside Claude.
allowed-tools: [Bash, Read, Write]
argument-hint: ""
---

Re-tag every rule line in `.sextant/cerebrum/cerebrum.md`. The FileChanged hook normally handles this, but `/sextant:reconcile` is the manual escape hatch — e.g. when you copied a rule in from another file or a teammate committed a hand-edit.

## Step 1 — invoke the CLI

No arguments. The CLI runs the same `autoTagFile` pass that PostToolUse + FileChanged use, with `lastProjectFileEdit = null` (so untagged rules land `[provisional]` — the review queue — rather than `[node:...]`).

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" reconcile
```

## Step 2 — print the counts

The CLI prints one line for the store plus a totals line:

```
Reconciled cerebrum.md: high=0 low=2 unchanged=5 lines=7
Total: high=0 low=2 unchanged=5 lines=7
```

Pass that through to the user so they know if any `[provisional]` entries surfaced. If `low > 0`, recommend `/sextant:audit` to triage them.
