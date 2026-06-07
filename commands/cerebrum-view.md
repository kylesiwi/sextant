---
description: Generate a self-contained HTML viewer for the cerebrum (rules, bugs, settings, archive).
allowed-tools: [Bash]
argument-hint: "[--out <path>]"
---

Generate a single, self-contained HTML file that lets the user browse everything in their cerebrum — rules, logged bugs, view-only settings, and archived/forgotten rules — in a browser. The data is baked into the file at generate time (a browser opened on a `file://` URL cannot read sibling files), so the output is a **snapshot**: re-run this command to refresh after the cerebrum changes.

## Step 1 — generate the file

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum-view.mjs" $ARGUMENTS
```

Output shape:

```
Cerebrum view written: <path>
  <N> active rule(s), <N> bug(s), <N> archived
Open it in a browser (file://<path>).
```

By default the file is written to `.sextant/cerebrum/cerebrum.html` (already covered by `.sextant/` in `.gitignore`, so the snapshot is never committed). Pass `--out <path>` to write elsewhere, or `--root <path>` to target a different project.

## Step 2 — point the user at it

Report the generated path to the user and tell them to open it in a browser. Do **not** attempt to open it yourself.

The viewer has four tabs:

- **Rules** — every active rule, with a search box, kind checkboxes (path / keyword / global / other, all on by default), and a "mandatory only `[!]`" toggle. Mandatory rules are badged and left-bordered.
- **Bugs** — entries from `bugs.json` (error → root cause → fix), each with a verified/unverified badge.
- **Settings** — view-only `output_mode` and `capture_nudge`. They're changed with `/sextant:output` and `/sextant:autorules`, not from the page.
- **Archive** — forgotten / superseded rules from `archive.md`, dimmed.
