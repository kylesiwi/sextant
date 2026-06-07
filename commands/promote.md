---
description: Promote a keyword rule to a safety rule by adding the [!] importance flag (exact recall floor + write-gate).
allowed-tools: [Bash, Read, Write]
argument-hint: "<hash>"
---

Promote a `[kw:…]` rule in `.sextant/cerebrum/cerebrum.md` to a **safety rule** by adding `[!]` in place.
Identify the target with the short SHA-1 hash printed by `/sextant:triage`.

`[!]` is **keyword-only**: it gives a `[kw:…]` rule an exact word-boundary recall floor (it fires whenever a
keyword literally appears, regardless of BM25 rank) plus a write-gate (an Edit/Write/MultiEdit whose change
contains a keyword pauses for approval). Promote therefore only applies to keyword rules — `node:`/`global` rules already
fire by scope, so the CLI refuses to stamp a redundant `[!]` on them.

## Step 1 — get the line hash

`cerebrum list` prints every rule in the store with its line hash — use it to find the keyword
rule you want to elevate:

```
cerebrum.md (N rules):
  [abcd1234ef567890] [kw:deploy,friday] never deploy on a friday afternoon
```

(`/sextant:review` also lists frequently-firing keyword rules as promotion candidates with their
hash, and `/sextant:remember` echoes the hash of a rule as you write it. If you already know a rule
is safety-critical, author it that way from the start: `/sextant:remember --keywords "…" --mandatory`.)

## Step 2 — invoke the CLI

`$ARGUMENTS` is the hash (positional). The CLI flips `[!]` onto the rule in place (no file move). If the user
already prefixed `--line-hash`, strip it so we don't double the flag.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded
HASH="$ARGUMENTS"
HASH="${HASH#--line-hash }"
HASH="${HASH#--line-hash=}"
node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" promote --line-hash "$HASH"
```

If the rule has no `[kw:]` bucket (or no rule matches the hash), the CLI exits non-zero with a diagnostic on
stderr — print it to the user. For a non-keyword rule it explains how to re-author as a keyword safety rule
(`forget` + `remember --keywords "…" --mandatory`).

## Step 3 — confirm

The CLI prints the promoted line. Show it back so the user sees the new `[!]` prefix.
