---
description: Bootstrap .sextant/ in the current working directory.
allowed-tools: [Bash, Write]
---

Bootstrap the `.sextant/` directory tree in the current working directory. This is idempotent: if files already exist, skip them. Never overwrite a user's customized content.

## Step 1 — scan for predecessor / hook-collision conflicts

Run the conflict scanner BEFORE creating any files. Sextant detects predecessor plugins (OpenWolf, Graphify, openwolf-graphify-bridge) and hook collisions, but never modifies another plugin's config — the policy is to surface findings + explicit remediation steps.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/conflicts.mjs" --root "$PWD"
init_scan_exit=$?
echo "init: conflict-scan exit=${init_scan_exit}"
```

If `init_scan_exit` is non-zero (high-severity conflict): print the scanner output in your reply, then ASK:

> Detected high-severity conflicts. Proceed with `.sextant/` initialization anyway? (yes/no)

Only run Step 2 if the user answers `yes`. The scanner output already includes the `fix:` action hint per finding — share those verbatim so the user can remediate before or after init.

If `init_scan_exit` is `0`: print a brief one-line summary (e.g., `Conflict scan: clean.` or `Conflict scan: N warnings (medium/low) — see output above.`) and proceed to Step 2 without prompting.

## Step 2 — create the directory tree and write default files

Run the bash block below verbatim. It uses heredocs and `[ ! -e ]` guards so it can re-run safely. Re-running `/sextant:init` on an already-initialized project still runs Step 1, then this block becomes a no-op for the files that already exist.

```bash
set -euo pipefail
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded

mkdir -p .sextant/cerebrum .sextant/graph .sextant/lunr .sextant/session

# project.md — identity / stack / glossary template (Layer 3).
if [ ! -e .sextant/project.md ]; then
  cat > .sextant/project.md <<'EOF'
# Project

One-paragraph description of what this project does and who it serves.

## Stack

- Language / runtime: <fill in>
- Frameworks: <fill in>
- Key tooling: <fill in>

## Identity

What this project is NOT — out-of-scope concerns, replaced systems, etc.

## Glossary

- <term>: <definition>
EOF
fi

# Cerebrum store (Layer 2): .sextant/cerebrum/cerebrum.md is created on demand
# the first time a rule is captured (/sextant:remember or the auto-tagger).
# Nothing to scaffold here beyond the directory.
mkdir -p .sextant/cerebrum

# JSON state files — defaults.
[ ! -e .sextant/bugs.json ]            && printf '%s\n' '[]' > .sextant/bugs.json
[ ! -e .sextant/ledger.json ]          && printf '%s\n' '{}' > .sextant/ledger.json
[ ! -e .sextant/deltas.json ]          && printf '%s\n' '{}' > .sextant/deltas.json
[ ! -e .sextant/cerebrum-stats.json ]  && printf '%s\n' '{}' > .sextant/cerebrum-stats.json

# stats.json — default measurement bucket. New install starts at arm A,
# zero sessions, zero tokens.
if [ ! -e .sextant/stats.json ]; then
  cat > .sextant/stats.json <<'EOF'
{
  "ab_arm": "A",
  "session_count": 0,
  "tokens_saved_estimate": 0,
  "tokens_paid_extra": 0,
  "net_savings": 0,
  "rule_fires": {},
  "redundant_reads_blocked": 0
}
EOF
fi

# Version sentinel — used by future migrations.
[ ! -e .sextant/.sextant-version ] && printf '1\n' > .sextant/.sextant-version

# Report what now exists (whether we created it or it was already there).
echo "Sextant initialized at $(pwd)/.sextant"
find .sextant -maxdepth 2 -type f | sort
```

## Step 3 — confirm

Print a one-line summary: `Sextant ready in .sextant/`. If any step above failed, include the bash exit code in your reply so the user can investigate. If Step 1 printed warnings (medium/low conflicts), remind the user they can re-run `/sextant:check-conflicts` at any time for the full action-hint list.
