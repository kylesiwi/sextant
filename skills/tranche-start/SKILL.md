---
name: tranche-start
description: Start a new feature plan with charter, spec, and tranche documents. Use when beginning a multi-tranche development effort.
---

# /sextant:tranche-start

Automated workflow that reads a user-provided plan or spec, then creates
the full tranche document hierarchy (charter, spec, tranche docs) and
registers the feature in `.sextant/tranches.json`.

## Prerequisites

1. Check that no feature is already active:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" status --root "$PWD"
   ```
   If a feature is active, stop and tell the user. Only one feature at a time.

2. The user must provide a plan, spec, or description of the feature.
   This can be:
   - A file path to an existing plan/spec document
   - Inline text in the conversation
   - A high-level description that you'll expand through discussion

   If the user hasn't provided enough detail to identify the feature name,
   scope, and tranche breakdown, ask clarifying questions before proceeding.

## Step 1: Extract the feature structure

From the user's input, identify:

- **Feature name** — a short slug (e.g. `quotes-system`, `admin-restructure`)
- **Scope: In** — what the feature includes
- **Scope: Out** — what's explicitly excluded
- **Architectural anchors** — locked decisions all tranches must respect
- **Tranche breakdown** — ordered list of tranches, each with:
  - Title and one-line summary
  - What it delivers (deliverable groups)
  - Which files it will touch (scope)
  - Dependencies on prior tranches
  - Open questions that need resolution before implementation
  - Verification gates (acceptance criteria)

If the user's plan doesn't clearly break into tranches, propose a breakdown
and get confirmation before proceeding.

## Step 2: Create the directory structure

```bash
mkdir -p "docs/feature-plans/<feature-slug>/tranches"
```

## Step 3: Write charter.md

Write `docs/feature-plans/<feature-slug>/charter.md` with ALL of these
sections in this order. Every section is required — populate from the
user's plan, or write `(to be determined)` and flag it to the user.

```markdown
# <Feature Name>

<One-line summary of what this feature does and why.>

## Scope: In

- <What's included, one bullet per item>

## Scope: Out

- <What's explicitly excluded, one bullet per item>

## Architectural anchors

1. <Locked decision that all tranches must respect>
2. <Another locked decision>

## Success criteria

- <How we know the feature is done>

## Non-goals

- <Things that look related but are explicitly deferred>
```

## Step 4: Write spec.md

Write `docs/feature-plans/<feature-slug>/spec.md` with ALL of these
sections. Populate from the user's plan. Sections that can't be filled
yet should say `(to be detailed during implementation)`.

```markdown
# <Feature Name> — Technical Spec

## Schema

<Tables, columns, types, constraints, indexes, API contracts, type definitions.>

## Status machines / lifecycle

<State transitions with allowed/forbidden paths. Diagram if helpful.>

## Integration points

<How this feature connects to existing code — webhook handlers, shared
tables, reused components, external APIs.>

## Admin / UI routes

<Page structure, URL patterns, component hierarchy.>

## Resolved decisions

<Questions that came up during planning and how they were answered.>

## Risks and mitigations

<What could go wrong and what we'd do about it.>

## Evolution rules

<How this spec should be updated going forward.>
```

## Step 5: Write each tranche document

For each tranche, write `docs/feature-plans/<feature-slug>/tranches/tranche-N-<slug>.md`
using this exact template. Fill in from the user's plan.

```markdown
# Tranche N: <Title>

**Status**: STUB
**Depends on**: T<N-1> (if applicable, otherwise "(none)")
**Delivers**: <one-line summary of all deliverables>

---

## Open questions before implementation
<!-- Must be EMPTY before status can move to READY -->
- [ ] <question — anything uncertain about this tranche's implementation>

## Locked deliverables

### A. <Deliverable group name>
- <specific deliverable>
- <specific deliverable>

### B. <Deliverable group name>
- <specific deliverable>

## Floating details
<!-- Pinned during the pre-implementation grep-and-read step -->
- (to be filled after grep-and-read)

## Pre-implementation checklist
<!-- Non-negotiable. Run BEFORE writing any code. -->
```bash
grep -rn "<relevant pattern 1>" src/ --include="*.ts" | grep -v node_modules
grep -rn "<relevant pattern 2>" src/ --include="*.ts" | grep -v node_modules
```
- [ ] All grep commands run and results reviewed
- [ ] All surfaced files accounted for in scope or explicitly excluded
- [ ] No code paths in spec that the grep missed
- [ ] Floating details section updated with grep findings

## Open questions before ship
<!-- Discovered IN-FLIGHT. Each must be resolved, OR escalated to a carry-forward
     concern (/sextant:tranche-concern add), before the tranche is SHIPPED.
     `ship` warns (does not block) while any remain. -->
- (none yet)

## Verification gates
<!-- Acceptance criteria. Each must pass before SHIPPED. -->
- [ ] <specific, testable acceptance criterion>
- [ ] <another criterion>
- [ ] TypeScript/lint compiles clean (if applicable)
- [ ] No regressions in existing tests

## Spec amendments discovered
<!-- Logged during implementation. Each entry → spec.md update. -->
- (none yet)
```

### The unknown escalation ladder

Every unknown you surface has exactly one exit, by deadline:

1. **Open questions before implementation** — answer before READY. `checklist-done`
   HARD-blocks while any remain.
2. **Open questions before ship** — discovered in-flight; answer before SHIPPED.
   `ship` warns (soft) while any remain.
3. **Carry-forward concern** (`/sextant:tranche-concern add`) — when an in-flight
   question can't be closed in this tranche, escalate it (optionally `--target` a
   later tranche), then check its box noting "deferred → concern #N". `ship` then
   passes; `finalize` HARD-blocks until the concern is resolved in a later tranche.

No unknown may leave the feature unresolved — that is the invariant the three
buckets + their gates enforce.

### Tranche doc guidelines

- **Open questions**: Write real questions you extracted from the plan,
  or things you're uncertain about. Don't leave this empty for STUB
  tranches — the whole point is to surface unknowns early.
- **Grep commands**: Tailor these to the tranche's deliverables. Grep
  for the symbols, table names, route patterns, and component names
  that this tranche will touch or interact with.
- **Verification gates**: Make these specific and testable. "API works"
  is bad. "POST /api/quotes returns 201 with valid payload" is good.
  Include at least one regression gate.
- **Scope files**: List every file this tranche will create or modify.
  These become the enforcement boundary — edits inside scope are allowed,
  edits outside scope trigger a nudge.

## Step 6: Register the feature

Build and run the CLI command. The `--tranches` flag takes a JSON array.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" start \
  --feature "<feature-slug>" \
  --charter "docs/feature-plans/<feature-slug>/charter.md" \
  --spec "docs/feature-plans/<feature-slug>/spec.md" \
  --tranches '<JSON array of tranche objects>' \
  --root "$PWD"
```

Each tranche object in the JSON array must have:
- `"id"`: string (e.g. `"1"`, `"2"`)
- `"title"`: human-readable title matching the tranche doc header
- `"doc_path"`: relative path to the tranche markdown file
- `"scope"`: array of file paths this tranche will create or modify
- `"depends_on"`: array of tranche IDs that must be SHIPPED first

Example:
```json
[
  {"id":"1","title":"Foundation — schema + read-only admin","doc_path":"docs/feature-plans/quotes-system/tranches/tranche-1-foundation.md","scope":["src/db/schema.sql","src/app/admin/page.tsx"],"depends_on":[]},
  {"id":"2","title":"Write flows — CRUD + lifecycle","doc_path":"docs/feature-plans/quotes-system/tranches/tranche-2-write-flows.md","scope":["src/api/quotes/route.ts","src/lib/quotes/lifecycle.ts"],"depends_on":["1"]}
]
```

## Step 7: Verify and summarize

1. Run status to confirm registration:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/tranches.mjs" status --root "$PWD"
   ```

2. Tell the user what was created:
   - List all files written (charter, spec, tranche docs)
   - Show the tranche breakdown with titles and dependencies
   - Note any open questions that need resolution before T1 can move to READY
   - Remind them that the charter is now FROZEN

3. Suggest next steps:
   - Review and refine the charter and spec while workflow is still in PLANNING
   - Resolve open questions in T1's tranche doc
   - When ready, advance T1: `/sextant:tranche-advance`

## What happens after registration

- The **charter** is FROZEN. Any edit attempt is blocked with a deny gate.
  To edit it, run `/sextant:tranche-amend` first.
- The **spec** is living — it can be edited freely, but amendments should
  be logged in the active tranche doc's "Spec amendments discovered" section.
- **T1** starts as STUB. The lifecycle is:
  `STUB → READY → IN-FLIGHT → SHIPPED → ARCHIVED`
- Sextant hooks enforce the workflow automatically: checklist gates,
  scope protection, capture prompts. See README-tranches.md for details.
