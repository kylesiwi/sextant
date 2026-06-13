---
description: Audit every cerebrum rule — format, scope, channel-fit, staleness — against the rule model, and recommend concrete fixes.
allowed-tools: [Bash, Read]
---

Audit this project's cerebrum (`.sextant/cerebrum/cerebrum.md`). Produce a report
and recommend fixes; **do not change any rule without asking first.**

## Step 1 — gather (run this bash block)

```bash
set -uo pipefail
: "${CLAUDE_PLUGIN_ROOT:=}"  # guard: unbound under set -u if run from a stray shell
CB="${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs"

echo "===== RULE MODEL (how rules are evaluated) ====="
node "$CB" explain

echo
echo "===== DETERMINISTIC LINT (cerebrum doctor) ====="
node "$CB" doctor --root "$PWD" || true

echo
echo "===== REVIEW QUEUE (provisional rules, with hashes) ====="
node "$CB" audit --root "$PWD" || true

echo
echo "===== FULL STORE (all rules) ====="
cat .sextant/cerebrum/cerebrum.md 2>/dev/null || echo "(no cerebrum.md)"
```

## Step 2 — judge each rule against the model

Using the RULE MODEL printed above, review **every** rule for:

- **Format** — any bucket-shaped `[tag]` left in the body? `[!]` with no scope
  (fires nowhere)? empty `[kw:]`? (The `doctor` ERRORS already flag these — confirm
  + explain each.)
- **Channel fit** — is it in the right tier? A fact about ONE file → `[node:]`
  (fires by scope on read+write of that file). A cross-file topic → `[kw:]` with
  **decisive** keywords (not generic words like todo/test/env/path). Truly
  everywhere → `[global]` (sparingly). Flag `[global]` rules that should be
  `[kw:]`/`[node:]`, and `[kw:]` rules with weak/generic keywords.
- **Importance (`[!]` is kw-only)** — `[!]` is meaningful ONLY on `[kw:]` rules (it
  adds the exact word-boundary recall floor — 100% injection on a keyword match,
  never throttled; v0.44.0 removed the old write-gate). Flag `[!]` sitting on a
  `[node:]`/`[global]` rule as **redundant** (doctor WARNs these) — recommend
  dropping it. Flag a must-never-miss keyword safety rule that LACKS `[!]`.
- **Staleness** — does a `[node:]` path still exist (doctor WARNs these)? Is the
  body still true / not superseded by a newer rule? Flag duplicates/contradictions.

## Step 3 — report + recommend (no changes yet)

Group findings by severity (errors → channel/staleness → nits). For each, give the
**concrete fix** and its command, using the hash from the `doctor`/`audit` output
(or quote the rule body if it wasn't hashed there):

- re-scope / fix format: `cerebrum forget --line-hash <h>` then
  `cerebrum remember --text "<body>" [--node <p> | --global | --keywords "a,b"] [--mandatory]`
  (note: `--mandatory` only pairs with `--keywords`)
- drop a redundant `[!]` on a node:/global rule: `cerebrum forget --line-hash <h>` then
  re-`remember` with just the scope flag (no `--mandatory`)
- drop a stale/wrong rule: `cerebrum forget --line-hash <h>`

End with a one-line summary: `clean` / `N issues (E errors)`. Then ASK whether to
apply the recommended fixes.
