---
name: output
description: View or change Sextant's user-facing message verbosity (off | quiet | verbose). Controls systemMessage status lines only; never affects rule injection.
---

# /sextant:output

Show or change the **output mode** — how verbose Sextant's user-facing status lines
(`systemMessage`) are. This does NOT touch rule injection / `additionalContext`; it
only controls which status lines surface to you.

## Modes

- `off` — no status lines at all.
- `quiet` (default) — transitions, real-time alerts, and the end-of-turn turn
  summary only; aggregated, no per-rule detail.
- `verbose` — everything `quiet` shows, plus per-rule detail, injection-point
  notices, and Sextant health lines.

The setting is durable (`.sextant/config.json`) and persists across sessions until
you change it.

## How to handle the invocation

Read/write the mode through `bin/config.mjs`.

### If the user named a mode

Map the argument to a mode, then set it:

- `--off` / `off` → `off`
- `--quiet` / `quiet` → `quiet`
- `--verbose` / `verbose` → `verbose`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/config.mjs" set <mode> --root "$PWD"
```

Confirm the new mode to the user in one line.

### If the user gave NO argument

Read the current mode, report it (and what it means), then offer the other two:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/config.mjs" get --root "$PWD"
```

Tell the user the current mode and offer to switch to either alternative. If they
choose one, run the `set` command above.
