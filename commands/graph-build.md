---
description: Rebuild the AST graph for the current project. Reads source files, extracts symbols and import edges, writes .sextant/graph/graph.json.
allowed-tools: [Bash]
argument-hint: "[--root <path>] [--quiet] [--force]"
---

Rebuild the project's AST graph. The graph is the index PreToolUse Read hooks consult to inject "uses X, used by Y" context for files the agent is about to touch. It does a full rebuild every time; `--force` is reserved for future incremental builds.

## Step 1 — run the builder

Invoke the helper. Pass any arguments the user supplied through verbatim.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/graph-build.mjs" $ARGUMENTS
```

The helper:

- Walks the project root (default `$PWD`), enumerating TypeScript, JavaScript, Python, Go, and Rust source files. When inside a git repo, the walk uses `git ls-files` so your `.gitignore` is respected; otherwise it falls back to a recursive walker that skips `node_modules/`, `.git/`, `.sextant/`, `dist/`, `build/`, `coverage/`, and similar build-output dirs.
- Parses each file with the vendored tree-sitter grammar for its language, extracts symbols + import edges, and serializes the result to `<root>/.sextant/graph/graph.json` atomically.
- Skips files larger than `SEXTANT_GRAPH_MAX_FILE_BYTES` (default 1MB) and stops enumerating after `SEXTANT_GRAPH_MAX_FILES` (default 10000) to bound memory + wall-clock on giant monorepos.
- Writes the `<root>/.sextant/.sextant-version` sidecar if missing or stale.
- Logs per-file warnings (parse errors, read failures) but never fails the whole build because of a single bad file.

## Step 2 — print the summary

The helper prints one summary line on success:

```
Indexed N files, M edges. Wrote <abs path>. Took Xms.
```

Print that line verbatim in your reply. If the helper exits non-zero, print the stderr diagnostic in your reply so the user can act on it.
