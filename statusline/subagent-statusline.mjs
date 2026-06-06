#!/usr/bin/env node
// statusline/subagent-statusline.mjs — Sextant per-task subagent statusline.
//
// Claude Code invokes this script once per refresh tick with stdin JSON:
//
//   {
//     "columns": 80,
//     "tasks": [
//       { "id": "...", "name": "...", "type": "...", "status": "...",
//         "description": "...", "label": "...", "startTime": "...",
//         "tokenCount": 0, "tokenSamples": [], "cwd": "..." }, ...
//     ]
//   }
//
// Contract (verbatim from May 2026 statusline docs):
//   "Write one JSON line to stdout per row you want to override, in the form
//    {"id": "<task id>", "content": "<row body>"}. The content string is
//    rendered as-is, including ANSI colors and OSC 8 hyperlinks. Omit a
//    task's id to keep the default rendering for that row; emit an empty
//    content string to hide it."
//
// Sextant policy: emit a row override ONLY for tasks whose `name` starts
// with "sextant-" (our planted subagents). For all other tasks, emit nothing
// so Claude Code's default rendering applies.
//
// Render format (per § 5.17 / R10):
//   <name> · <status> · tok <tokenCount>[ · <label>]
//
// On any error (parse failure, missing fields, etc.) we exit 0 silently —
// the subagent row simply falls back to default rendering.

import { stdin } from 'node:process';

async function readStdin() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data;
}

function renderTask(task) {
  const name = task.name ?? '';
  if (!name.startsWith('sextant-')) return null;
  const status = task.status ?? '';
  const tokenCount = task.tokenCount ?? 0;
  const label = task.label ?? '';
  const base = `${name} · ${status} · tok ${tokenCount}`;
  const content = label ? `${base} · ${label}` : base;
  return { id: task.id, content };
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  for (const task of tasks) {
    const row = renderTask(task);
    if (row) process.stdout.write(JSON.stringify(row) + '\n');
  }
}

main().catch(() => { /* swallow — Claude Code falls back to default */ });
