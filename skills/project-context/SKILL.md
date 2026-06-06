---
name: project-context
description: Print Sextant's current state — recent project files, open bugs, recent commits, mandatory rules. Use when starting a new conversation about an ongoing project, after compaction, or when asking 'what was I working on?'
---

# /sextant:project-context

Read-only snapshot of Sextant's view of the project: recent files touched in
this session, open bugs, recent commit boundaries, and the mandatory rules
that govern this codebase. Use this when:

- Starting a new turn after the conversation history was compacted and the
  pre-compact restoration block isn't enough to re-orient.
- The user asks "what was I working on?", "what's the state of this project?",
  or otherwise needs you to recall recent activity.
- The user just opened a new session on a project with prior Sextant history
  and asks about previous work or needs context from earlier sessions.

## How to invoke

Run the bundled CLI and print its output verbatim. Use the
`$CLAUDE_PLUGIN_ROOT` environment variable so the path resolves regardless of
where the plugin was installed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/context.mjs" --root "$PWD"
```

If you want a machine-readable view (e.g., to feed another tool), pass
`--json`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/context.mjs" --root "$PWD" --json
```

If you already know the session id (e.g., the user provided it),
pass it explicitly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/context.mjs" --root "$PWD" --sid <session_id>
```

When `--sid` is omitted, the CLI auto-detects the most recently active
session by scanning the runtime base directory.

## Output sections

The text view emits four sections in order:

1. **Recent files** — up to 5 most-recent unique paths touched in this
   session, with relative timestamps and the tool that touched them
   (Edit / Write / MultiEdit).
2. **Open bugs** — bug entries for this session that have not been verified
   as fixed (`fix_verified` is false).
3. **Recent commits** — up to 3 most-recent commit snapshots, each showing
   the edit count and number of files touched.
4. **Mandatory rules** — the deterministic rules from `.sextant/cerebrum/cerebrum.md`
   that fire by scope: `[global]` (always-on) and `[node:<path>]` (file-scoped),
   with the session that wrote them.

Empty sections render `(none)` rather than being omitted.

## When *not* to use

- Mid-task, when you're already oriented and just need to read one specific
  file — use `Read` directly.
- When you need the pre-compact restoration block — that's emitted
  automatically as `additionalContext` on the first `UserPromptSubmit` after
  compaction. This skill is a manual fallback for when the automatic path
  is insufficient or unavailable.
