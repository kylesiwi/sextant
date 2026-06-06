---
description: Log a bug fix to .sextant/bugs.json.
allowed-tools: [Bash]
argument-hint: "--file <path> --error '<msg>' --root-cause '<text>' --fix '<text>'"
---

Capture a debugged-and-fixed bug into the project's bug store. The PostToolUse sweep will tag the entry with a `graph_node` (symbol match when one of the file's symbols appears in the error/root-cause, otherwise file-level fallback) on the next Edit/Write/MultiEdit event.

## Step 1 — invoke the CLI

Pass `$ARGUMENTS` through verbatim. The CLI handles flag parsing, id allocation, and the atomic write.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
node "${CLAUDE_PLUGIN_ROOT}/bin/bugs.mjs" log $ARGUMENTS
```

Write the fields **factual and specific — not narrative.** State what actually
broke and what actually fixed it, with the concrete symbol/value; skip the
debugging story and diff stats. `--error` is what surfaces in the injected bug
summary, so keep it a specific one-liner. (Good fix: `pinned booking dates to
santiagoToday()`. Weak fix: `rewrote 10→21 lines`.)

Accepted flags:

- `--file <path>` — required. Project-relative file path that contained the bug.
- `--error "<msg>"` — required. The concrete error/symptom — the actual message or a specific one-line description ("TypeError on alpha at Santiago midnight", not "booking broke").
- `--root-cause "<text>"` — required. Why it occurred — one factual sentence naming the actual cause.
- `--fix "<text>"` — required. The concrete change the patch made (the fix itself, not diff stats or "refactored X").
- `--symbol <name>` — optional. Pre-tags the entry as `graph_node=<name>` with `symbol-match` confidence (otherwise the PostToolUse sweep decides).
- `--tags <a,b,c>` — optional. Comma-separated free-form tags.

The CLI prints the allocated bug id (e.g. `bug-7`) on stdout. Print it back to the user so they can reference it later.

## Step 2 — print the result

Tell the user the new id and how it will be tagged. If the agent already knows the affected symbol, prefer `--symbol` so the entry is symbol-tagged immediately instead of waiting for the next sweep.
