---
name: tranche-status
description: Show current tranche workflow status — active feature, tranche statuses, verification gate progress, and doc paths.
---

# /sextant:tranche-status

Read-only display of the current tranche workflow state.

## How to invoke

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" status --root "$PWD"
```

## Output

Shows:
- Feature name and workflow state
- Charter and spec paths
- All tranches with their status, shipped dates, and checklist state
- Active tranche deliverables summary (from the tranche doc)
- Verification gate progress (checked/total)
- Recent amendments
- Open carry-forward concerns (feature-global unknowns awaiting a later tranche;
  raise/resolve with `/sextant:tranche-concern`)

If no feature is active, prints "No active feature plan."

## When to use

- At the start of a session to orient yourself
- Before advancing a tranche to check prerequisites
- When the user asks about feature progress
- After compaction to re-orient on the current state
