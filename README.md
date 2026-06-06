# Sextant

A per-project memory framework for Claude Code that injects the right rules and context at the moment the agent acts — by reading and writing through every one of Claude Code's hooks, not by hoping the model remembers.

---

## What is Sextant?

Sextant is a per-project memory framework that deterministically feeds an agent the rules and context that apply to whatever it's about to do. Any time the agent reads a file, edits one, runs a command, or submits a prompt, Sextant has already run — it looks at what's happening, finds the rules and graph context that match, and injects them straight into the agent's context window for that step.

Claude Code already ships a memory system: `CLAUDE.md` files that load at the start of a session. They're useful, and Sextant doesn't replace them. But Claude Code's own docs are blunt about what `CLAUDE.md` is — *"Claude treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook instead."* A long session drifts. The instruction you wrote at the top of `CLAUDE.md` is a thousand messages back by the time it matters, and the model can quietly deprioritize or ignore it.

Sextant lives entirely on that hook layer the docs point to. Instead of one big file loaded once and slowly forgotten, rules are attached to the things they're about — a specific file, a topic, a keyword — and delivered *when that thing comes up*. A rule about `lib/auth.ts` shows up the moment the agent opens `lib/auth.ts`. A safety rule about cookies can refuse to let an edit through until you've approved it. The point isn't more context; it's context that arrives on time and, where it matters, context the agent can't skip.

It also keeps a small amount of project knowledge that compounds over time: an AST graph of how your files connect, a log of bugs you've fixed, and a rule store the agent can add to as it learns. For larger pieces of work, Sextant includes a lightweight planning workflow — *tranches* — that keeps a feature's charter, spec, and live progress notes in sync as the agent builds (more on that below).

Everything lives under `.sextant/` in your project. It's per-project by design: the rules for this repo don't leak into the next one.

---

## How Sextant was born

This started as a personal annoyance. Claude kept not knowing things it should have known — that *this* file has a non-obvious constraint, that *this* workflow has a step you can't skip, that *this* directory is load-bearing in a way that isn't visible from the code. The obvious fix is to write it down in a markdown file. That doesn't really work. The agent reads the file once, then forgets it as the session fills up, or reads it and decides not to follow it. Plain instructions are suggestions, and over a long session, suggestions lose.

So Sextant takes a more stubborn approach. Rules get injected at the exact step they apply to, and some actions are blocked until the agent does them right — a malformed rule can't end the turn, an edit to a protected file is denied, a safety-critical change pauses for approval. It's the difference between leaving a sticky note and putting a gate on the door.

The tranche workflow came later, out of using the plugin on real work. It's a lighter alternative to heavier planning systems (like the *superpowers* plugin), shaped around how an agent actually moves through a feature:

- A **charter** that's frozen once work begins — the scope and the non-negotiables, written down so they can't quietly drift mid-feature.
- A **spec** that's allowed to change, but only with the change logged — so the living design stays honest about what it learned.
- **Tranche docs** that are written *live, as the agent works on them* — each one grounded in the latest state: what's already shipped, what's still in scope, and what the spec has frozen. The plan isn't a thing you write up front and abandon; it's written as the work happens, against the current reality of the work.

---

## Does it work automatically?

Mostly, yes — and that's the design goal. The hooks do their job on every turn without you typing anything:

- Rules fire and get injected as the agent reads, writes, and runs commands.
- Graph context (a file's dependencies, dependents, and symbols) is attached when the agent opens a file.
- The end-of-turn digest, the auto-tagging of new rules, the gates that block bad actions, and the snapshots that survive a context compaction all happen on their own.

The slash commands are for the deliberate moments — capturing a rule you want to keep, starting a tranche, running a health check. And here's the part that keeps it from being a chore: **the agent is nudged, in-context, to drive most of this itself.** It gets prompted to capture what it learned before ending a turn. During a tranche it sees the active deliverables every turn. When it writes a rule, the auto-tagger scopes it; when it writes a bad one, a gate makes it fix it. So in practice you're not hand-running commands to make Sextant work — the agent does, guided by what Sextant puts in front of it.

Two honest caveats. Rule *authoring* is best-effort: the auto-tagger guesses a scope and the agent proposes rules, but the quality of what gets captured still benefits from an occasional review (there's a command for that). And the graph is rebuilt on a heuristic — after enough edits or once it's gone stale — not on every keystroke, so it can lag a large refactor until the next rebuild.

---

## Quick start

**1. Add the marketplace and install the plugin.** In Claude Code:

```
/plugin marketplace add kylesiwi/sextant
/plugin install sextant@kylesiwi
```

(`kylesiwi/sextant` is the GitHub repo; `sextant@kylesiwi` is the plugin in that marketplace.) Restart or run `/reload-plugins` to activate.

**2. Initialize the project.** In the repo you want Sextant to track:

```
/sextant:init
```

This creates `.sextant/` and bootstraps the rule store, bug log, and config.

**3. Build the graph** so file context is available from the first read:

```
/sextant:graph-build
```

**4. Check everything's wired up:**

```
/sextant:doctor
```

`doctor` verifies the plugin is installed, the hooks are live, the project state is coherent, and lints the rule store for problems. Run it any time something feels off.

**Statusline (removed — returning in a later version).** Earlier releases shipped an optional statusline. It has been removed for now so it can be rebuilt with terminal-output safety designed in from the ground up; everything it surfaced (context density, open bugs, review queue, per-turn pulse) is already covered by Sextant's `systemMessage` status lines, which stay on screen rather than refreshing away. There is no longer an `install-statusline` command.

> **Upgrading from a release that had the statusline?** If you previously installed it, your `~/.claude/settings.json` still points `statusLine` at `~/.claude/sextant/statusline.mjs`, which will now render a frozen `sxt · ctx 0% / ● idle …` line. To remove it, delete the `statusLine` entry from `~/.claude/settings.json` and the `~/.claude/sextant/` directory (both must be edited from a normal terminal — Claude Code's sandbox blocks writes under `~/.claude/`).

**Message verbosity.** By default Sextant only speaks up for real transitions. To see (or silence) more:

```
/sextant:output verbose   # show the per-rule detail in the end-of-turn digest
/sextant:output quiet      # default — headlines only
/sextant:output off        # silence
```

**Auto-rule capture nudges.** Outside a tranche, Sextant nudges the agent (and you) to record durable lessons it stumbles on. On by default; toggle it with:

```
/sextant:autorules        # no arg — report current state, offer to flip it
/sextant:autorules on     # enable non-tranche capture nudges (default)
/sextant:autorules off    # disable them (in-flight tranche capture is unaffected)
```

---

## How does it work?

Walk through a real prompt. Say you type:

> *I want the login page to our admin panel to have a "Remember me for 3 weeks" function and checkbox.*

Here's the turn, step by step.

**1. The prompt is read before the agent starts (UserPromptSubmit).** Sextant scans your text for keywords and file/symbol mentions. Suppose you once captured a mandatory rule: `[kw:login,session,cookie] [!] Sessions go through lib/session.ts — never set Set-Cookie directly`. The word *login* matches, so that rule is injected into the agent's context as a system reminder *before it writes a line of code*. If "login page" maps to a file Sextant knows, that file's graph neighborhood is preloaded too.

**2. The agent reads files (PreToolUse on Read).** It opens `src/pages/admin/login.tsx`. Sextant attaches that file's graph context — what it imports, what imports it, the symbols it declares — plus any rule scoped to that exact file, plus a heads-up if the most recent open bug touched it. The agent reads `lib/session.ts` next and gets the same treatment; the node rule for session handling fires again because it's relevant again.

**3. The agent makes an edit (PreToolUse on Edit/Write).** It goes to add the cookie logic in `lib/session.ts`. Because the change contains a guarded keyword (`cookie` / `Set-Cookie`), the mandatory write-gate pauses the edit and surfaces the rule for approval — the agent can't silently route around the shared session helper. If `lib/session.ts` belonged to a shipped tranche's locked scope, the edit would be denied outright until the scope was amended. The file's node rule is re-injected on the write, too, so the constraint is in front of the agent exactly when it's editing.

**4. The turn ends (Stop).** Sextant prints a digest of what governed the work — for example, *"5 rules injected this turn (3 path, 1 global, 1 keyword)"* with the rule texts beneath it. If a tranche is in flight and nothing was captured, the turn is held with a nudge to record what was learned. Outside a tranche, Sextant scans the turn's own output for trip-up words — *gotcha*, *root cause*, *footgun* — and, when one shows up and nothing was captured, leaves the agent a standing note to record the lesson on the next turn (and, on a strong signal, tells you so you can ask it to). If the agent added a malformed rule along the way, a format gate blocks the turn until it's fixed.

**5. Later — next session, or after a compaction.** Snapshots taken at Stop and before each context compaction mean the next SessionStart (or the next prompt after a compaction) restores where you left off: the recent files, the open todos, the rules that fired, the bugs still open. The session that picks up the work isn't starting cold.

The throughline: at every step there's a hook that has already looked at what's happening and put the relevant knowledge — or a gate — directly in the agent's path.

---

## Feature deep dive

**Graph memory.** A tree-sitter AST graph of your project (TypeScript, JavaScript, Python, Go, Rust), stored at `.sextant/graph/graph.json`. It tracks files, their import edges, and the symbols each file declares. When the agent reads a file, Sextant injects that file's neighborhood so the agent understands its blast radius before changing it. The graph rebuilds after enough edits or once it's gone stale; `/sextant:graph-build` forces it.

**Rule injection (the cerebrum).** The rule store is a flat markdown file, `.sextant/cerebrum/cerebrum.md`. Each rule has a *scope* that decides when it fires:

| Scope | Fires when | Good for |
|------|------------|----------|
| `[node:<path>]` | the agent reads or edits that exact file | a fact about one file |
| `[kw:word,word]` | those words appear in a prompt or a tool's input (ranked by relevance) | a cross-cutting topic — use decisive words, not generic ones |
| `[global]` | once per session, always on | the project's constitution; use sparingly |
| `[!]` (mandatory) | adds an exact-match recall floor to a keyword rule **and** a write-gate that pauses any edit whose change contains the keyword | safety-critical rules you can't afford to miss |

You add rules with `/sextant:remember` (the agent is nudged to do this too). `/sextant:promote` turns a frequently-firing keyword rule into a mandatory one; `/sextant:forget` archives a rule.

**Rule authoring.** New rules don't have to be hand-scoped. When the agent captures a rule right after editing a file, the auto-tagger scopes it to that file; otherwise it lands in a `[provisional]` review queue. A format gate at the end of the turn refuses to let a malformed rule through, and a contradiction sweep flags rules that fight each other. It's best-effort capture with a safety net, not a free-for-all.

**Capture nudges.** Capture is best-effort, so Sextant leans on the turn itself to trigger it. While a tranche is in flight, the turn won't end until something is captured. Outside a tranche, Sextant watches the agent's *visible* output for trip-up words — *gotcha*, *footgun*, *root cause*, *non-obvious*, and the like — and, when one shows up without a capture, drops a soft, non-blocking note into the next turn so the lesson gets written down instead of lost; a strong signal also surfaces a one-line heads-up to you. It's tiered (only the strong words reach you), rate-limited, suppressed the moment a rule is actually captured, and toggled with `/sextant:autorules` (on by default; off disables only the ordinary-turn nudges — in-flight tranche capture stays mandatory). (Thinking text isn't available to the hooks, so only what the agent actually writes out is scanned.)

**Tranches.** A lightweight feature-planning workflow: a frozen **charter**, a living **spec** (changes must be logged), and **tranche docs** written live as the agent implements. Tranches move through `STUB → READY → IN-FLIGHT → SHIPPED`. While a tranche is in flight, the turn won't end until something is captured (or the agent explicitly says there's nothing to capture), and files in a shipped tranche's scope are write-protected until you amend the scope. Driven by `/sextant:tranche-start`, `tranche-status`, `tranche-advance`, and `tranche-amend`.

**Bug history.** A searchable log of bugs you've debugged and fixed (`.sextant/bugs.json`), recorded with `/sextant:bug-log` and surfaced automatically when the agent reads a file a past bug touched. `/sextant:bug-search` queries it directly.

**Health, audit, and review.** `/sextant:doctor` is the health check. `/sextant:audit` surfaces the provisional review queue and stale rules. `/sextant:review` proposes which rules to promote, which to demote (low-firing and cold), and which contradict each other — optionally handing the analysis to a review subagent.

**Output as system messages.** Sextant talks through Claude Code's `systemMessage` channel, kept separate from the authoritative context it injects. Messages are color-coded and default-quiet — you only hear about real transitions unless you opt into `verbose`. The end-of-turn digest deduplicates repeated rule fires (a rule that fired four times shows once, as `(×4)`).

**Cross-session continuity.** Snapshots at the end of each turn and before each compaction let the next session — or the next prompt after the context is compacted — pick up with the recent files, open todos, fired rules, and open bugs intact.

---

## Where it lives

Everything is under `.sextant/` in your project:

```
.sextant/
  cerebrum/cerebrum.md   the rule store
  graph/graph.json       the AST dependency graph
  bugs.json              the bug history
  tranches.json          tranche workflow state
  stats.json             measurement counters
  config.json            output verbosity + capture-nudge toggle
```

Hooks run from `bin/cli.mjs`, which dispatches each Claude Code event to a handler in `lib/hooks/`. The CLIs behind the slash commands (`bin/cerebrum.mjs`, `bin/tranches.mjs`, `bin/bugs.mjs`, `bin/graph-build.mjs`, and others) are plain Node and can be run directly if you want to script against them.

---

## Status

Sextant is built on Node 20+ (ESM throughout) with no runtime framework — the standard library, tree-sitter WASM grammars for the AST graph, and Lunr for rule search. Core rule injection, the graph, the gates, and cross-session continuity are solid and in daily use. The tranche workflow is functional and still maturing at the edges. The statusline has been pulled for a from-scratch, safety-first rebuild in a later version.

It's a per-project tool. Point it at a repo, let the hooks run, and it gets more useful the more the project teaches it.
