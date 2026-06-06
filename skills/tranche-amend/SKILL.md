---
name: tranche-amend
description: Start an amendment workflow to modify frozen charter, shipped scope files, or update the spec. Unlocks deny gates temporarily.
---

# /sextant:tranche-amend

Record an amendment and temporarily unlock deny gates so you can edit
protected files (frozen charter, shipped tranche scope files).

## When to use

- When you need to edit a file that Sextant's PreToolUse hook blocked
  with a `deny` decision
- When you discover a spec change during implementation that needs to be
  logged
- When scope needs to change for the active tranche

The deny reason text will tell you to run this skill when a gate blocks.

## How to invoke

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" amend \
  --text "<description of the amendment>" \
  --root "$PWD"
```

Optionally target a specific tranche (defaults to active):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" amend \
  --text "<description>" \
  --tranche "<id>" \
  --root "$PWD"
```

## What it does

1. Records the amendment in `tranches.json` with a timestamp
2. Sets `pending_amendment: true` — this flag unlocks deny gates for the
   next edit attempt
3. The flag is consumed after the amendment is processed

## After amending

1. Retry the edit that was previously blocked — it will now be allowed
2. Update `spec.md` with the amendment details
3. Add an entry to the active tranche doc's "Spec amendments discovered"
   section
4. If scope changed, update the tranche's `scope` array in
   `tranches.json` by re-running the start command or editing directly

## Amendment log

All amendments are recorded with timestamps in `tranches.json` and
visible via `/sextant:tranche-status`. This provides an audit trail of
every deviation from the original plan.
