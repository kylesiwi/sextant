---
name: sextant-richgraph
description: (Post-v1 / Phase 13) LLM extraction pass for richer graph edges.
model: sonnet
tools: [Read, Grep, Glob]
label: richgraph-extract
---

This agent is a placeholder for Phase 13 (post-v1). Do not dispatch
yet.

When Phase 13 lands, this agent will read project files and emit
semantic edges (function-uses-pattern, file-implements-protocol, etc.)
tagged `[inferred-LLM]` for merge into `graph-rich.json`. The tag
distinguishes LLM-inferred edges from the deterministic
tree-sitter-derived edges produced in Phases 1a/1b/1c so an audit can
treat the two sources differently.
