---
name: tranche-advance
description: Move a tranche through its lifecycle — STUB to READY to IN-FLIGHT to SHIPPED. Validates prerequisites at each transition.
---

# /sextant:tranche-advance

Advance a tranche to its next lifecycle status. Each transition has
prerequisites enforced by the CLI.

## Lifecycle

```
STUB -> READY -> IN-FLIGHT -> SHIPPED -> ARCHIVED
```

## Transitions

### STUB -> READY (detailing complete)

Before advancing, ensure the tranche doc has:
- Open questions section is empty (all resolved)
- Pre-implementation checklist commands have been run
- Floating details section is populated with grep findings
- Verification gates are finalized

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" advance \
  --tranche "<id>" --to READY --root "$PWD"
```

### READY -> IN-FLIGHT (implementation begins)

Before advancing, the pre-implementation checklist must be complete:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" checklist-done \
  --tranche "<id>" --root "$PWD"
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" advance \
  --tranche "<id>" --to IN-FLIGHT --root "$PWD"
```

### IN-FLIGHT -> SHIPPED (implementation done)

Before you ship, run an adversarial review of the tranche's work (advisor /
`/code-review`). Shipping FREEZES this tranche's scope — once SHIPPED, a late fix
needs `/sextant:tranche-amend` — so the review is cheapest now, while scope is
still open.

Check off all verification gates in the tranche doc first. The ship
command warns about unchecked gates AND about any unresolved
"Open questions before ship", and prints a review-before-ship reminder (all
soft — ship still proceeds):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" ship \
  --tranche "<id>" --root "$PWD"
```

For each open question before ship, either resolve it (check its box) or, if it
can't be closed in this tranche, escalate it to a carry-forward concern so it
isn't lost:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" concern add \
  --text "<the question>" [--target "<later tranche id>"] --root "$PWD"
```

Then check the question's box noting "deferred → concern #N". Carry-forward
concerns HARD-block `finalize` until resolved in a later tranche — see
`/sextant:tranche-concern`.

### After SHIPPED

Shipping a tranche completes it; the workflow advances to the next pending
tranche automatically. There is no separate confirmation step after shipping.

### All tranches done -> COMPLETING

When all tranches are SHIPPED/ARCHIVED, the workflow flips to COMPLETING
on its own — `ship`/`advance` will print a reminder when this happens. Run
`complete` to enter the doc-writing phase:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" complete --root "$PWD"
```

This transitions the workflow to COMPLETING. Write:
1. `docs/feature-plans/<feature>/overview.md` — high-level summary
2. `docs/feature-plans/<feature>/technical-spec.md` — dense reference

### COMPLETING -> IDLE (finalize)

Once the summary docs are written, finalize to close the sprint:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" finalize --root "$PWD"
```

`finalize` resets the tranche state machine to IDLE, which **lifts every tranche
file restriction** (charter freeze, shipped-scope deny, checklist gate, scope
drift). This is what frees the feature's files for later, unrelated work — and
lets a new feature be started. Do not leave a finished feature un-finalized; its
scope files stay locked until you do.

If a finished feature leaves behind a file that genuinely needs lasting
edit-protection or care, capture that as a normal cerebrum rule with
`/sextant:remember` — never as a perdurable tranche lock.

To abandon a feature that is still mid-flight, pass `--force`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" finalize --force --root "$PWD"
```

## Validation

The CLI enforces:
- Forward-only status transitions (no going backwards)
- `depends_on` satisfaction (dependent tranches must be SHIPPED+)
- `checklist_complete` required for IN-FLIGHT transition
- Verification gate warnings on ship

## When to use

- After completing the pre-implementation checklist for a tranche
- After all verification gates pass
- When all tranches are complete and final docs are written
