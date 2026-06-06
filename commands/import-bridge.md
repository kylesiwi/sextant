---
description: Migrate from openwolf-graphify-bridge — copy .wolf/ cerebrum + bugs into .sextant/.
allowed-tools: [Bash, Read, Write]
---

Migrate from the legacy `openwolf-graphify-bridge` plugin (`.wolf/` directory) into Sextant's `.sextant/` layout. This command migrates cerebrum rules and bug history only. It does not migrate graph data.

## Step 1 — confirm .sextant/ is initialized

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
if [ ! -d .sextant ]; then
  echo ".sextant/ not initialized — run /sextant:init first, then re-run this command."
  exit 1
fi
```

Do not auto-init. Print the error message from Step 1 and stop.

## Step 2 — run the migration helper

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/import-bridge.mjs" --from .wolf --to .sextant
```

The helper:

- Looks for `.wolf/cerebrum.md` and `.wolf/buglog.json`. If neither exists, prints a friendly message and exits 0 (nothing to migrate).
- Copies `.wolf/cerebrum.md` → `.sextant/cerebrum/regular.md`. Each rule line (`- YYYY-MM-DD: ...`) is prefixed with `<!-- sextant:migrated -->`. The cerebrum parser ignores HTML comments, but a reviewer can later audit which rules came from the legacy bridge. Re-running the command is idempotent — markers are not duplicated.
- Copies `.wolf/buglog.json` → `.sextant/bugs.json` (parsed + re-serialized with 2-space indent).
- Does NOT copy `graphify-out/` (`/sextant:graph-build` rebuilds it from source).

If `.sextant/bugs.json` already contains entries (i.e., not the default empty `[]`), the helper refuses to overwrite and exits 1 with a hint to re-run with `--force`. If you see that error and want to replace the destination:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/import-bridge.mjs" --from .wolf --to .sextant --force
```

## Step 3 — confirm the summary

The helper prints one summary line on success:

```
Migrated N rules + M bugs. graphify-out not copied — graph-build rebuilds it from source.
```

Print this to the user verbatim.
