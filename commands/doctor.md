---
description: Health check — verifies plugin install, hooks ready, state coherent.
allowed-tools: [Bash, Read]
---

Run the diagnostic checks below and report the results. Conclude with a one-line summary: `OK`, `WARNINGS: <n>`, or `BLOCKED: <reason>`.

## Step 1 — collect diagnostics

Run this bash block. It writes a multi-section report to stdout.

```bash
set -uo pipefail  # NOT -e: we want every check to run even if one fails.
: "${ZSH_VERSION:=}"  # workaround: CC shell snapshot tests $ZSH_VERSION unguarded

echo "## Sextant doctor"
echo

# 1. Plugin root + verify.mjs (if present).
echo "### Plugin"
echo "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-<unset>}"
echo "SEXTANT_ROOT=${SEXTANT_ROOT:-<unset>}"
if [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
  ver=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" | head -1)
  echo "plugin.json: present (${ver})"
else
  echo "plugin.json: MISSING at ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"
fi
if [ -x "${CLAUDE_PLUGIN_ROOT}/bin/cli.mjs" ]; then
  echo "bin/cli.mjs: executable"
else
  echo "bin/cli.mjs: missing or not executable"
fi
if [ -f "${CLAUDE_PLUGIN_ROOT}/verify.mjs" ]; then
  echo "verify.mjs: present — running"
  node "${CLAUDE_PLUGIN_ROOT}/verify.mjs" 2>&1 || echo "verify.mjs: nonzero exit"
fi
echo

# 2. Project-level .sextant/
echo "### Project state (.sextant/)"
if [ -d .sextant ]; then
  echo ".sextant/: present"
  # Filesystem type — useful on WSL2 to detect 9p/drvfs.
  fs_t="$(stat -f -c %T .sextant 2>/dev/null || true)"
  if [ -n "${fs_t:-}" ]; then
    echo "filesystem: ${fs_t}"
  else
    mp="$(stat -c %m .sextant 2>/dev/null || true)"
    if [ -n "${mp:-}" ]; then
      mount | grep " on ${mp} " | head -1 || true
    fi
  fi
  [ -f .sextant/.sextant-version ] && echo "version: $(cat .sextant/.sextant-version)" || echo "version: <missing .sextant-version>"
  echo "files:"
  find .sextant -maxdepth 2 -type f | sort | sed 's/^/  /'
else
  echo ".sextant/: not initialized — run /sextant:init"
fi
echo

# 3. Runtime dir (best-effort: we don't know the session_id at command time).
# v0.20.0: hot state moved OFF the project tree onto native FS (it was paying
# v9fs write latency under <cwd>/.sextant/runtime). SessionStart records the
# resolved root in the cwd-deterministic pointer .sextant/runtime-root; read that,
# falling back to the SEXTANT_RUNTIME_BASE override, then the legacy path.
echo "### Runtime"
if [ -n "${SEXTANT_RUNTIME_BASE}" ]; then
  runtime_base="${SEXTANT_RUNTIME_BASE}"
elif [ -f .sextant/runtime-root ]; then
  runtime_base="$(cat .sextant/runtime-root)"
else
  runtime_base="$PWD/.sextant/runtime"
fi
echo "base: ${runtime_base}"
matches=$(ls -d "${runtime_base}"/sextant-* 2>/dev/null | wc -l | tr -d ' ')
echo "sextant-<sid> dirs: ${matches}"
if [ "${matches}" != "0" ]; then
  for d in "${runtime_base}"/sextant-*; do
    [ -d "$d" ] || continue
    log="${d}/hooks.log"
    if [ -f "$log" ]; then
      lines=$(wc -l < "$log" | tr -d ' ')
      echo "  $(basename "$d"): hooks.log ${lines} lines"
    else
      echo "  $(basename "$d"): no hooks.log yet"
    fi
  done
fi
echo

# 4. Bundled agents shipped with the plugin.
echo "### Bundled agents (\${CLAUDE_PLUGIN_ROOT}/agents/sextant-*.md)"
if ls -la "${CLAUDE_PLUGIN_ROOT}/agents"/sextant-*.md 2>/dev/null; then
  :
else
  echo "(none found — plugin install may be incomplete)"
fi
echo

# 5. Conflicts — predecessor plugins, hook collisions.
# Read-only display. The dedicated /sextant:check-conflicts command does the
# same scan and is the place to act on remediation. doctor never modifies
# another plugin's files.
echo "### Conflicts"
if [ -f "${CLAUDE_PLUGIN_ROOT}/bin/conflicts.mjs" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/bin/conflicts.mjs" --root "$PWD" 2>&1 || echo "conflicts: nonzero exit (high-severity findings present)"
else
  echo "(conflict scanner not found — install incomplete?)"
fi
echo

# 6. Cerebrum store lint. Read-only: flags misfiled/malformed rules (stale
# [node:] paths, empty [kw:] buckets, scope-less [!] rules) and recommends
# `cerebrum migrate` only when the store still needs migrating.
echo "### Cerebrum store"
if [ -f "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" ]; then
  node "${CLAUDE_PLUGIN_ROOT}/bin/cerebrum.mjs" doctor --root "$PWD" 2>&1 || echo "cerebrum doctor: nonzero exit"
else
  echo "(cerebrum CLI not found — install incomplete?)"
fi
echo
```

## Step 2 — summarize

Based on the report, end your reply with ONE of these single-line summaries:

- `OK` — everything found, no warnings.
- `WARNINGS: <n>` — list the warnings briefly (missing optional files, no planted agents yet, etc.).
- `BLOCKED: <reason>` — plugin.json missing, cli.mjs not executable, or any other condition that prevents the plugin from working.
