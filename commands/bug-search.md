---
description: Search .sextant/bugs.json for prior bugs by file (optionally by symbol).
allowed-tools: [Bash]
argument-hint: "--file <path> [--symbol <name>]"
---

Query the project's bug store for previously-logged bugs touching a given file. Run it before debugging a regression in that file.

## Step 1 — invoke the CLI

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/bugs.mjs" search $ARGUMENTS
```

Accepted flags:

- `--file <path>` — required. Project-relative file path.
- `--symbol <name>` — optional. Narrows to bugs whose `graph_node` matches the symbol.

Each matching entry prints as one line:

```
<id> [<file>:<graph_node>] <error_message>
```

## Step 2 — print the result

If matches exist, present them to the user and suggest reading the relevant section. If none, say so plainly.
