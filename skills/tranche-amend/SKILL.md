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

Optionally target a specific tranche (defaults to active), and scope the unlock:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" amend \
  --text "<description>" \
  --tranche "<id>" \
  --edits <n> \
  --files "<relpath,relpath,…>" \
  --root "$PWD"
```

- `--edits <n>` — how many edits the amendment may make to frozen/shipped files
  (default 1). Use this when one logical amendment spans several edits.
- `--files <a,b,…>` — restrict the unlock to these project-relative paths.
  **Required when `--edits > 1`** (a multi-edit unlock must name its files).
  Omitted with `--edits 1`, the single edit may touch any file.

## What it does

1. Records the amendment in `tranches.json` with a timestamp.
2. Opens an edit budget: `<n>` edits to the named files, valid for 10 minutes.
3. Each successful edit to a frozen/shipped file spends one edit; when the budget
   is exhausted (or the 10-minute window passes) the deny gates re-freeze. An edit
   that fails does not spend the budget.

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
