---
description: Install the Sextant statusLine into ~/.claude/settings.json. Requires Claude Code restart on first install.
allowed-tools: [Bash, Read, Write]
---

Install the Sextant status line.

## Why this needs a helper script (read first)

The status line needs two things under `~/.claude/`:

1. the launcher at `~/.claude/sextant/statusline.mjs`, and
2. a `statusLine` entry in `~/.claude/settings.json`.

Both paths are **blocked for writes from inside Claude Code** (the sandbox bind-mounts settings files to `/dev/null` and does not allow writes under `~/.claude/`). So this command does **not** write them directly — it generates a helper script under `/tmp/claude/` that **you run once from a normal terminal, outside Claude Code.**

You do **not** need to re-run this after plugin updates — it's one-time setup; the launcher tracks the active plugin version itself.

## Step 1 — generate the helper script

This bakes the current plugin root so the helper can copy the launcher, then writes a self-contained installer to `/tmp/claude/`.

The helper body is emitted via a **single-quoted heredoc** (`<<'HELPER'`) so nothing
is expanded or history-mangled at generation time (an unquoted heredoc turns the
node script's `!==` into `\!==`). The only dynamic value — the launcher source
path — is baked safely with `printf %q` on its own line above the literal body.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
src="${CLAUDE_PLUGIN_ROOT}/statusline/launch.mjs"
if [ ! -f "$src" ]; then
  echo "Plugin launcher not found at $src — plugin install is incomplete."
  exit 1
fi
mkdir -p /tmp/claude
helper="/tmp/claude/sextant-install-statusline.sh"
{
  echo '#!/usr/bin/env bash'
  echo '# Sextant statusLine installer — run from a NORMAL terminal (outside Claude'
  echo '# Code); ~/.claude/ is not writable from inside CC.'
  echo 'set -euo pipefail'
  printf 'launcher_src=%q\n' "$src"
  cat <<'HELPER'
dest_dir="$HOME/.claude/sextant"
dest_launcher="$dest_dir/statusline.mjs"
settings="$HOME/.claude/settings.json"

mkdir -p "$dest_dir"
cp "$launcher_src" "$dest_launcher"
chmod +x "$dest_launcher"
echo "Installed launcher: $dest_launcher"

# Merge statusLine into settings.json with Node (no jq dependency). Preserves all
# other keys; refuses to clobber a corrupt file.
node -e '
  const fs = require("fs");
  const path = require("path");
  // node -e argv: [node, <arg1>, ...] — the settings path is argv[1], not argv[2].
  const file = process.argv[1];
  const cmd = "node " + process.env.HOME + "/.claude/sextant/statusline.mjs";
  let obj = {};
  if (fs.existsSync(file)) {
    try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { console.error("settings.json is corrupt — refusing to overwrite. Hand-edit and retry."); process.exit(1); }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const existing = obj.statusLine && obj.statusLine.command;
  if (existing && existing !== cmd) {
    console.error("An existing statusLine is configured:");
    console.error("  " + existing);
    console.error("Re-run with FORCE=1 to replace it with the Sextant statusLine.");
    if (!process.env.FORCE) process.exit(2);
  }
  obj.statusLine = { type: "command", command: cmd, padding: 1, refreshInterval: 2 };
  const tmp = file + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  console.log("Merged statusLine into " + file);
' "$settings"
HELPER
} > "$helper"
chmod +x "$helper"
echo "Wrote helper: $helper"
```

## Step 2 — tell the user to run it outside Claude Code

Print this verbatim:

> **Run this in a normal terminal (not inside Claude Code), then restart Claude Code:**
>
> ```
> bash /tmp/claude/sextant-install-statusline.sh
> ```
>
> If it reports an existing statusLine you want to replace, re-run as `FORCE=1 bash /tmp/claude/sextant-install-statusline.sh`.

## Step 3 — print the restart notice

After the user has run the helper, print verbatim:

> **Restart required after first install.**
>
> If trust isn't accepted, you'll see the notification "statusline skipped · restart to fix" instead of your status line output. Restart Claude Code and accept the trust prompt to enable it.

## Updating the plugin

Nothing to do here. After `/plugin update sextant`, the launcher automatically points the status line at the new version — no re-install needed. (If `/plugin update` itself isn't picking up a new version, refresh the marketplace first: `/plugin marketplace update <marketplace>`.)
