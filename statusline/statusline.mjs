#!/usr/bin/env node
// statusline/statusline.mjs — Sextant two-line statusline renderer.
//
// Line 1 (slow / accumulated):
//   sxt · ctx <pct>%[ · ⚠ bugs N][ · ⚠ graph <state>·N][ · ✎ review N][ · arm:B][ · comp:N]
// Line 2 (live turn pulse):
//   <badge> <action> · rules <N>[↑M][⊘B][⚠deny] · reads <N>[↺R]
//
// Reads CC stdin payload + .sextant runtime/statusline-state.json directly
// on every refresh tick. Degrades silently on any missing input.

import { stdin } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

import { runtimeRootFor } from '../lib/runtime-locate.mjs';

// ── design tokens ────────────────────────────────────────────────
export const T = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  bold:  '\x1b[1m',
  brand: '\x1b[35m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  info:  '\x1b[36m',
};
const c = (s, ...codes) => (codes.length ? `${codes.join('')}${s}${T.reset}` : s);
const SEP = c(' · ', T.dim);

// ── helpers ──────────────────────────────────────────────────────
const safeNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const trunc = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// ctx thresholds: 0–39 normal, 40–69 warn, ≥70 error
function ctxColor(p) { return p >= 70 ? T.error : p >= 40 ? T.warn : ''; }

async function readStdin() { let d = ''; for await (const x of stdin) d += x; return d; }
function runtimeBaseFor(sid, cwd) {
  // Resolve via the shared module (lib/runtime-locate.mjs): native FS by default,
  // honoring SEXTANT_RUNTIME_BASE. The statusline is CC-spawned, so it shares CC's
  // env with the hooks and resolves the same root they wrote to.
  const override = process.env.SEXTANT_RUNTIME_BASE;
  if (!cwd && !(override && override.length > 0)) return '';
  return path.join(runtimeRootFor(cwd), `sextant-${sid}`);
}
function safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// Derive the tranche chip live from the durable .sextant/tranches.json on every
// tick, so the statusline reflects mid-session advances in realtime. The cached
// state.tranche (statusline-state.json) is only written at SessionStart /
// preCompact / restore, so it goes stale the moment a tranche advances and is
// `null` whenever SessionStart's doc-parse failed — reading the source of truth
// here sidesteps both. Parsed inline (not via lib/stores/tranches.mjs) to avoid
// pulling that module's dependency chain into the per-tick statusline process.
// Returns { active_id, status } or null; degrades silently on any missing input.
export function liveTranche(cwd) {
  if (!cwd) return null;
  const t = safeJson(path.join(cwd, '.sextant', 'tranches.json'));
  if (!t || !t.active_tranche_id || !Array.isArray(t.tranches)) return null;
  const active = t.tranches.find((x) => x && x.id === t.active_tranche_id);
  if (!active) return null;
  return { active_id: active.id, status: active.status || null };
}

// ── line 1: slow / accumulated state ─────────────────────────────
export function lineOne(payload, state, cwd, sid = '') {
  const pct = Math.trunc(safeNum(payload?.context_window?.used_percentage));
  const cc = ctxColor(pct);
  const ctxStr = cc ? c(`${pct}%`, cc) : `${pct}%`;

  const sxtChip = c('sxt', T.brand);
  const parts = [sxtChip, `${c('ctx', T.dim)} ${ctxStr}`];

  // Alerts first — mobile-40 protection: these must survive narrow clipping.
  const bugs = safeNum(state?.bugs?.open);
  if (bugs > 0) {
    parts.push(c(`⚠ bugs ${bugs}`, T.warn));
  }
  const g = state?.graph ?? {};
  if (g.state && g.state !== 'idle') {
    parts.push(c(`⚠ graph ${g.state}·${safeNum(g.dirty_count)}`, T.warn));
  }
  const review = safeNum(state?.review_queue_depth);
  if (review > 0) {
    parts.push(c(`✎ review ${review}`, T.info));
  }

  // Tranche chip — between alerts and diagnostics.
  const tr = state?.tranche;
  if (tr && tr.active_id) {
    const shortStatus = (tr.status || '').toLowerCase().replace('-', '');
    parts.push(`T${tr.active_id}:${shortStatus}`);
  }

  // Diagnostics last — allowed to clip on mobile.
  if (state?.ab_arm === 'B') parts.push(`${c('arm:', T.dim)}B`);
  const comp = safeNum(state?.compaction?.compaction_n);
  if (comp > 0) parts.push(`${c('comp:', T.dim)}${comp}`);

  return parts.join(SEP);
}

// ── line 2: live turn pulse ──────────────────────────────────────
export function lineTwo(state, cwd = '', sid = '') {
  const r = state?.rules ?? {};
  const rd = state?.reads ?? {};
  const st = state?.stuck ?? {};
  const evtTag = state?.last_event?.tag ?? '';

  let badge, action;
  if (safeNum(st.count) > 0) {
    badge = c('✕', T.error, T.bold);
    action = c(`stuck:${st.tool ?? '?'}×${st.count}`, T.error);
  } else if (evtTag === 'PreCompact') {
    badge = c('⏵', T.brand); action = 'compacting';
  } else if (evtTag === 'PostCompact') {
    badge = c('⏵', T.brand); action = 'compacted';
  } else if (evtTag === 'Stop') {
    badge = c('✓', T.dim); action = c('idle', T.dim);
  } else if (state?.last_event?.detail || state?.last_event?.tag) {
    badge = c('▸', T.brand);
    action = trunc(state.last_event.detail || state.last_event.tag, 16);
  } else {
    badge = c('●', T.dim); action = c('idle', T.dim);
  }

  // Rules group — chips concat without inner spaces to fit mobile-40.
  const rChips = [];
  if (safeNum(r.mandatory_fires) > 0) rChips.push(c(`↑${r.mandatory_fires}`, T.bold));
  if (safeNum(r.blocked) > 0) rChips.push(c(`⊘${r.blocked}`, T.warn));
  if (r.deny_red) rChips.push(c('⚠deny', T.error));
  const rulesSeg = `${c('rules', T.dim)} ${safeNum(r.fires_this_turn)}${rChips.join('')}`;

  // Reads group.
  const readsSeg = `${c('reads', T.dim)} ${safeNum(rd.total)}` +
    (safeNum(rd.redundant_blocked) > 0 ? c(`↺${rd.redundant_blocked}`, T.warn) : '');

  return [`${badge} ${action}`, rulesSeg, readsSeg].join(SEP);
}

// ── main ─────────────────────────────────────────────────────────
async function main() {
  const raw = await readStdin();
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch {}
  const sid = payload?.session_id ?? '';
  const cwd = payload?.workspace?.current_dir ?? '';
  const rb = sid ? runtimeBaseFor(sid, cwd) : '';
  const state = rb ? safeJson(path.join(rb, 'statusline-state.json')) : null;

  // Override the (potentially stale) cached tranche with a live read of the
  // durable tranches.json so the chip tracks mid-session advances in realtime.
  // Use a render-state object even when statusline-state.json is absent, so the
  // chip can still surface for a fresh session with an active tranche.
  const renderState = state || {};
  renderState.tranche = liveTranche(cwd);

  process.stdout.write(lineOne(payload, renderState, cwd, sid) + '\n');
  process.stdout.write(lineTwo(renderState, cwd, sid) + '\n');
}

// Run when invoked as the entrypoint — either directly (`node statusline.mjs`)
// or spawned by the launcher (statusline/launch.mjs), which execs
// `node <pluginRoot>/statusline/statusline.mjs`. Both cases give argv[1] a
// `statusline.mjs` basename. Skipped during tests, which import named exports
// from a file whose basename doesn't match.
const isEntry = path.basename(process.argv[1] ?? '') === 'statusline.mjs';
if (isEntry) {
  main().catch(() => {
    process.stdout.write('sxt · ctx 0%\n● idle · rules 0 · reads 0\n');
  });
}
