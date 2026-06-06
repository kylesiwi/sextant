---
description: Archive a rule from the cerebrum store (cerebrum.md → archive.md). The original line is preserved with a date marker.
allowed-tools: [Bash, Read, Write]
argument-hint: "<hash>"
---

Archive a rule so it stops firing without losing the historical record. Identify the target with its line hash from `cerebrum list`.

## Step 1 — get the line hash

`cerebrum list` prints every rule in the store with its line hash — find the one you want to archive
there. (`/sextant:audit` also prints hashes for the `[provisional]` review queue, and `/sextant:review`
for rules flagged to promote or demote.)

## Step 2 — invoke the CLI

`$ARGUMENTS` is the hash (positional). The CLI removes the matching line from `cerebrum.md` and appends it to `archive.md` under a `<!-- sextant:archived YYYY-MM-DD -->` marker. If the user already prefixed `--line-hash`, strip it so we don't double the flag.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
HASH="$ARGUMENTS"
HASH="${HASH#--line-hash }"
HASH="${HASH#--line-hash=}"
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" forget --line-hash "$HASH"
```

## Step 3 — confirm

The CLI prints the archived line. Show it back so the user sees what was archived.

If no rule matches the hash (e.g., the user removed it from `cerebrum.md` manually before invoking), the CLI exits non-zero. Pass the diagnostic through.
