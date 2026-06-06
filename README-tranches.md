# Tranches: Structured Multi-Step Feature Development

Tranches is a sextant feature that enforces a structured development workflow when building large features. It splits work into ordered tranches (chunks), each with its own mini-spec, checklist, and verification gates. Sextant's hooks enforce the workflow automatically -- blocking edits to shipped code, requiring pre-implementation checklists, and prompting you to capture learnings before ending a turn.

## Quick start

### 1. Plan your feature

Create a document hierarchy in your project:

```
docs/feature-plans/my-feature/
  charter.md          # The "constitution" -- frozen once work begins
  spec.md             # Living technical spec -- amendments are logged
  tranches/
    tranche-1-foundation.md
    tranche-2-write-flows.md
    tranche-3-payments.md
```

### 2. Write the charter

The charter defines what you're building and what's off-limits. It becomes read-only once development starts. Include these sections:

1. **Title + one-line summary**
2. **Scope: In** -- what's included
3. **Scope: Out** -- what's explicitly excluded
4. **Architectural anchors** -- locked decisions that all tranches must respect
5. **Success criteria**
6. **Non-goals**

### 3. Write the spec

The spec is a living document. When you discover changes during implementation, log them in the tranche doc and update the spec. Include:

1. **Schema** -- tables, types, API contracts
2. **Status machines / lifecycle** -- state transitions
3. **Integration points** -- how this connects to existing code
4. **Admin / UI routes**
5. **Resolved decisions**
6. **Risks and mitigations**
7. **Evolution rules**

### 4. Write each tranche document

Each tranche doc is a self-contained mini-spec. Use this structure:

```markdown
# Tranche 1: Foundation -- schema + read-only admin

**Status**: STUB
**Depends on**: (none)
**Delivers**: Database schema, admin list page, seed data

---

## Open questions before implementation
<!-- Must be EMPTY before the tranche can move to READY -->
- [ ] Should we use a soft-delete pattern or hard delete?

## Locked deliverables

### A. Database schema
- quotes table with status enum
- quote_items join table

### B. Admin list page
- /admin/quotes route with pagination
- Status filter dropdown

## Floating details
<!-- Filled during the pre-implementation grep step -->
- (to be filled after grep-and-read)

## Pre-implementation checklist
<!-- Run BEFORE writing any code -->
- [ ] Grep commands run and results reviewed
- [ ] All surfaced files accounted for in scope
- [ ] Floating details section updated

## Open questions before ship
<!-- Discovered IN-FLIGHT. Resolve each, OR escalate to a carry-forward concern
     (/sextant:tranche-concern add), before SHIPPED. `ship` warns while any remain. -->
- (none yet)

## Verification gates
<!-- Each must pass before shipping -->
- [ ] Schema migration runs clean
- [ ] Admin list page renders with test data
- [ ] TypeScript compiles clean

## Spec amendments discovered
<!-- Log changes found during implementation -->
- (none yet)
```

### The unknown escalation ladder

Every unknown you surface has exactly one exit, by deadline — so none is silently lost:

1. **Open questions before implementation** — answer before READY (`checklist-done` HARD-blocks while any remain).
2. **Open questions before ship** — discovered in-flight; answer before SHIPPED (`ship` warns, soft).
3. **Carry-forward concern** — when an in-flight question can't be closed in this tranche, escalate it to a feature-level concern that a *later* tranche must consume:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" concern add --text "<question>" [--target <tranche id>] --root "$PWD"
   ```

   Then check the question's box noting "deferred → concern #N". `finalize` HARD-blocks while any concern is open. See `/sextant:tranche-concern` (add / resolve / list).

> Invariant: **no unknown may leave the feature unresolved.** "Floating details" stays a grep-*findings* aid (facts), distinct from these *question* buckets.

### 5. Register the feature

```bash
/sextant:tranche-start
```

This skill provides the templates and structure shown above. You write the docs, then run the CLI to register:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" start \
  --feature "my-feature" \
  --charter "docs/feature-plans/my-feature/charter.md" \
  --spec "docs/feature-plans/my-feature/spec.md" \
  --tranches '[
    {"id":"1","title":"Foundation","doc_path":"docs/feature-plans/my-feature/tranches/tranche-1-foundation.md","scope":["src/db/schema.sql","src/app/admin/page.tsx"],"depends_on":[]},
    {"id":"2","title":"Write flows","doc_path":"docs/feature-plans/my-feature/tranches/tranche-2-write-flows.md","scope":["src/api/quotes/route.ts"],"depends_on":["1"]},
    {"id":"3","title":"Payments","doc_path":"docs/feature-plans/my-feature/tranches/tranche-3-payments.md","scope":["src/lib/payments.ts"],"depends_on":["2"]}
  ]' \
  --root "$PWD"
```

Each tranche object needs:
- `id` -- string identifier (e.g. `"1"`, `"2"`)
- `title` -- human-readable name
- `doc_path` -- path to the tranche markdown file
- `scope` -- array of file paths this tranche will modify
- `depends_on` -- array of tranche IDs that must be SHIPPED before this one can start

### 6. Verify

```bash
/sextant:tranche-status
```

You should see your feature registered with T1 as the active tranche.

---

## The tranche lifecycle

Each tranche moves through these statuses in order:

```
STUB --> READY --> IN-FLIGHT --> SHIPPED --> ARCHIVED
```

The overall workflow state tracks where you are:

```
IDLE --> PLANNING --> DETAILING --> IMPLEMENTING --> COMPLETING --> IDLE
```

### STUB --> READY (detailing complete)

The `advance --to READY` transition enforces dependency ordering -- all tranches listed in `depends_on` must be SHIPPED or later. The CLI does not check tranche doc contents at this step, so it's your responsibility to ensure:
- Open questions are resolved (section has no unchecked items)
- Verification gates are finalized
- Floating details are ready to be pinned during the pre-implementation step

These doc-level checks are enforced later by `checklist-done` (before IN-FLIGHT).

```bash
/sextant:tranche-advance
```

### READY --> IN-FLIGHT (implementation begins)

Before moving to IN-FLIGHT, the pre-implementation checklist must be complete:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" checklist-done \
  --tranche "1" --root "$PWD"
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" advance \
  --tranche "1" --to IN-FLIGHT --root "$PWD"
```

Or use the skill:

```bash
/sextant:tranche-advance
```

### IN-FLIGHT --> SHIPPED (implementation done)

Check off all verification gates in the tranche doc, then ship:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" ship \
  --tranche "1" --root "$PWD"
```

The ship command warns (soft — it still ships) if any verification gates are
unchecked OR any "Open questions before ship" remain unresolved. For each open
before-ship question, resolve it (check the box) or escalate it to a carry-forward
concern (`concern add`) so it isn't lost.

### SHIPPED, and beyond

Shipping a tranche completes it and advances the workflow straight to the next pending tranche. Once all tranches reach a terminal status (SHIPPED/ARCHIVED), run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" complete --root "$PWD"
```

This transitions the workflow to COMPLETING. Write your final `overview.md` and `technical-spec.md`.

### COMPLETING --> IDLE (finalize)

When the summary docs are written, finalize the feature. This is the step that closes the sprint:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" finalize --root "$PWD"
```

`finalize` **HARD-blocks while any carry-forward concern is still open** — a feature may not close with an unresolved cross-tranche unknown (resolve them via `concern resolve`, or `finalize --force` to abandon them, which lists them loudly first).

Once it passes, `finalize` clears the tranche state machine back to `IDLE` — which **lifts every tranche file restriction**. The charter freeze, shipped-scope deny, checklist gate, and scope-drift nudge all stop firing, because they only apply while a feature is active. A new feature can then be started cleanly.

> A finished sprint should not leave perdurable hook locks behind. If some of those files genuinely need lasting edit-protection or care, that belongs in the cerebrum as a normal rule (`/sextant:remember`), **not** as a tranche lock that later, unrelated work has to fight with `/sextant:tranche-amend`.

To abandon a feature that is still mid-flight (clear state without shipping every tranche), pass `--force`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" finalize --force --root "$PWD"
```

---

## What the hooks enforce

Once a feature is registered, sextant's hooks automatically enforce the workflow. You don't need to remember the rules -- the hooks handle it.

### Charter freeze (deny)

After the workflow leaves PLANNING, the charter is read-only. Any attempt to edit it is blocked:

> Sextant: charter.md is frozen (workflow is past PLANNING). Charter edits require an amendment. Run /sextant:tranche-amend first.

### Shipped scope protection (deny)

Files in a shipped tranche's `scope` array are protected. If T1 shipped and you try to edit a file from T1's scope:

> Sextant: src/db/schema.sql belongs to tranche T1 "Foundation" which is SHIPPED. Run /sextant:tranche-amend first.

### Checklist gate (ask)

If you try to edit a scope file before completing the pre-implementation checklist, sextant asks for confirmation:

> Sextant: pre-implementation checklist not complete for T1. Run the grep-and-read pre-step and then /sextant:tranche-advance to confirm readiness before editing scope files.

### Scope drift detection (nudge)

If you edit a file that isn't in any tranche's scope while a tranche is IN-FLIGHT, sextant emits a one-time warning:

> Sextant: editing src/utils/helpers.ts which is outside tranche T2 scope. Consider whether this belongs in a future tranche or if T2 scope needs amending via /sextant:tranche-amend.

This fires once per file per session -- not on every edit.

### Auto-capture gate (stop hook)

When a tranche is IN-FLIGHT and you haven't captured any learnings during the turn, sextant blocks the turn from ending:

> Sextant: Tranche T2 "Write flows" is IN-FLIGHT. Before this turn ends, capture any learnings:
> - Gotchas or workarounds: /sextant:remember with [node:file] or [kw:keyword] tags
> - Bugs found: /sextant:bug-log
> - Nothing to capture: reply "no captures needed"

This ensures implementation discoveries are recorded in sextant's rule store. The gate has a safety valve -- after 3 consecutive blocks in one session, it downgrades to a nudge.

Subagents (sessions with a `parent_session_id`) skip the capture gate entirely.

---

## Unlocking deny gates with amendments

When a deny gate blocks you, the fix is always the same:

```bash
/sextant:tranche-amend
```

This does two things:
1. Records the amendment in `tranches.json` with a timestamp (visible in `/sextant:tranche-status`)
2. Sets a one-shot `pending_amendment` flag that unlocks the deny gate for your next edit

The flag is consumed after one edit -- if you need to edit multiple protected files, run the amend command before each one.

After amending:
1. Retry the edit that was blocked
2. Update `spec.md` with the amendment details
3. Add an entry to the tranche doc's "Spec amendments discovered" section

---

## Context injection

Sextant injects tranche context at several points so the agent stays oriented without you needing to repeat yourself.

### Per-turn nudge (~150 tokens, every prompt)

A lightweight reminder injected into every turn showing the active tranche, its scope, and available commands. Does not re-read the tranche doc each turn.

### Session start (~400 tokens, once)

A full orientation block at session start showing all tranches, their statuses, deliverables, and verification gate progress. Reads the active tranche doc.

### Post-compaction restoration (~100 tokens)

After context compaction, the tranche state is restored at highest priority (dropped last during truncation). Even if compaction loses it, the next prompt re-reads `tranches.json` from disk.

### Checking tranche state

Run `/sextant:tranche-status` any time to see the active feature and where each tranche sits in its lifecycle. Lifecycle transitions also surface inline via Sextant's `systemMessage` status lines.

---

## Available commands

| Command | What it does |
|---------|-------------|
| `/sextant:tranche-start` | Register a new feature with charter, spec, and tranches |
| `/sextant:tranche-status` | Show current workflow state, tranche statuses, gate progress |
| `/sextant:tranche-advance` | Move a tranche to its next lifecycle status |
| `/sextant:tranche-amend` | Record an amendment and unlock deny gates for one edit |

### CLI direct usage

All commands can also be run directly via the CLI:

```bash
# Check status
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" status --root "$PWD"

# Advance a tranche
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" advance --tranche "1" --to READY --root "$PWD"

# Mark checklist complete
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" checklist-done --tranche "1" --root "$PWD"

# Ship a tranche
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" ship --tranche "1" --root "$PWD"

# Record an amendment
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" amend --text "Need to add index on status column" --root "$PWD"

# Complete the feature (all tranches must be shipped) — enters COMPLETING
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" complete --root "$PWD"

# Finalize — clears tranche state to IDLE and lifts all file restrictions
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" finalize --root "$PWD"
```

---

## Storage

Tranche state lives in `.sextant/tranches.json`. This is a single JSON file tracking one active feature at a time. It stores:

- Feature name and document paths
- Active tranche ID and workflow state
- Each tranche's status, scope, dependencies, and timestamps
- Amendment log with timestamps
- Session capture counters
- The `pending_amendment` flag for deny gate unlocking

The file is read by hooks on every turn (sub-millisecond when no feature is active). Writes use file-level locking for atomicity.

Feature documents (charter, spec, tranche docs) live in your project tree and are committed to git alongside your code. Sextant reads them but never modifies them -- the agent writes all docs.

---

## Projects without tranches

If you don't use tranches, there is zero overhead. All tranche hooks check for an active feature first and return immediately when `workflow_state` is `IDLE` (the default). No `tranches.json` file is created until you run `/sextant:tranche-start`. No context is injected.
