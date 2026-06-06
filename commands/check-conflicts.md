---
description: Scan for conflicts with predecessor plugins (OpenWolf, Graphify, bridge) and other hook/statusLine collisions.
allowed-tools: [Bash]
---

Scan the current project + the user's `~/.claude/` for predecessor plugins, hook collisions, and statusLine collisions. Detection is **read-only** — Sextant never modifies another plugin's files, even when it could fix the collision mechanically. The failure mode of a silent mis-edit (we wreck a config the user spent time tuning) is worse than the failure mode we'd be fixing (the user pays double-hook latency until they notice).

## Step 1 — run the conflict scanner

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/conflicts.mjs" --root "$PWD"
```

The scanner prints one block per finding with `severity`, `kind`, `where`, a one-line message, and a multi-line `fix:` remediation. It exits with:

- `0` if no findings, or only medium/low findings (warnings).
- `1` if any high-severity finding was detected.

## Step 2 — print the result

Print the scanner's output verbatim in your reply. If the exit code is non-zero, tell the user:

> Sextant detected high-severity conflicts. Sextant will **not** modify other plugins' files automatically — apply the `fix:` step from each finding manually. After remediation, re-run `/sextant:check-conflicts` to confirm.

If the exit code is `0` but there are medium/low findings, print them as warnings in your reply and explain Sextant runs in parallel with the predecessor; the only cost is double-hook latency and possible duplicate `additionalContext` injection.

If there are no findings, end with: `No conflicts detected.`
