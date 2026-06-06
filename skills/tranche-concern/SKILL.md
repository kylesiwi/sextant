---
name: tranche-concern
description: Raise, resolve, or list carry-forward concerns — feature-global unknowns that outlive the tranche that found them and must be consumed by a later tranche. Blocks finalize until resolved.
---

# /sextant:tranche-concern

Manage **carry-forward concerns**: open unknowns or risks discovered in one
tranche that cannot be closed there and must be carried into a later tranche of
the same feature. Unlike a tranche's in-doc open questions (which are
tranche-local), a carry-forward concern lives at the feature level in
`.sextant/tranches.json` and **blocks `finalize` until it is resolved**.

This is the escape valve at the end of the unknown escalation ladder:

```
grep finding ─▶ open question before implementation  (resolve by READY — hard gate)
             ─▶ open question before ship             (resolve in-flight — soft gate)
             ─▶ carry-forward concern                 (resolve in a LATER tranche — finalize gate)
```

## When to use

- An in-flight question cannot be answered within the current tranche, but the
  feature must not ship without it being addressed somewhere downstream.
- You discover, while implementing T2, a risk that genuinely belongs to T4.
- You're about to ship and an "open question before ship" is still open — escalate
  it here (then check its box, noting "deferred → concern #N"), so ship can pass.

## How to invoke

Raise a concern (raised against the currently-active tranche):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" concern add \
  --text "<the concern>" [--target <tranche id>] --root "$PWD"
```

- `--target` is an OPTIONAL surfacing hint (which later tranche likely owns it).
  It is never a gate — a wrong target won't block anything. Accepts `T4` or `4`.

Resolve a concern when a later tranche consumes it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" concern resolve \
  --id <n> [--note "<how it was addressed>"] --root "$PWD"
```

List all concerns (open + resolved):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" concern list --root "$PWD"
```

## Resolution is attestation-based

Marking a concern resolved asserts you addressed it — Sextant does not verify the
underlying work (same as bug-log / remember). The real enforcement is the
`finalize` hard-block: a feature cannot be finalized while any concern is open
(use `finalize --force` to abandon them, which prints them loudly first).

## Surfacing

Open concerns appear in the SessionStart "Active tranche" block (flagging any
targeted at the now-active tranche) and in the first-turn reminder count. Use
`/sextant:tranche-status` to see the full list any time.
