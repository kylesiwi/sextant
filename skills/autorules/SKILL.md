---
name: autorules
description: View or change Sextant's non-tranche auto-rule capture nudges (on | off). When on, the Stop hook scans a turn's output for trip-up words and nudges you/the agent to record durable lessons. Never affects in-flight tranche capture, which stays mandatory.
---

# /sextant:autorules

Show or change **autorules** — Sextant's non-tranche capture nudge. When `on`
(default), the Stop hook scans the turn's visible output for trip-up words
(*gotcha*, *footgun*, *root cause*, *non-obvious*, …) and, when one shows up and
nothing was captured, leaves the agent a soft standing note to record the lesson
next turn (a strong signal also surfaces a one-line heads-up to you).

This is **scoped to non-tranche turns only**. While a tranche is in flight, the
mandatory capture gate is unaffected by this setting — it always holds the turn
until something is captured. Turning autorules `off` disables only the
ordinary-turn nudges (and the SessionStart "Capture as you go" steering line).

## Modes

- `on` (default) — scan ordinary turns and nudge to capture durable lessons.
- `off` — no non-tranche capture nudges; in-flight tranche capture stays as-is.

The setting is durable (`.sextant/config.json`, the `capture_nudge` key) and
persists across sessions until you change it.

## How to handle the invocation

Read/write the mode through `bin/config.mjs`.

### If the user named a mode

Map the argument to a mode, then set it:

- `--on` / `on` / `enable` → `on`
- `--off` / `off` / `disable` → `off`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/config.mjs" autorules-set <on|off> --root "$PWD"
```

Confirm the new mode to the user in one line.

### If the user gave NO argument

Read the current mode, report it (and what it means), then offer to flip it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/config.mjs" autorules-get --root "$PWD"
```

Tell the user whether autorules is currently `on` or `off` and what that means,
then offer to switch to the other mode. If they accept, run the `autorules-set`
command above.
