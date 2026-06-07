#!/usr/bin/env node
// bin/cerebrum-view.mjs — Sextant cerebrum HTML viewer generator.
//
// Backs /sextant:cerebrum-view (commands/cerebrum-view.md). Reads the project's
// cold state — cerebrum.md (active rules), archive.md (forgotten rules),
// bugs.json, config.json — and emits ONE self-contained HTML file with the data
// inlined as a <script> blob plus inline CSS/JS. No fetch, no server, no
// external assets: a browser opened on a file:// URL cannot read sibling files
// (CORS blocks fetch of local files), so we bake the data in at generate time.
// The file is therefore a SNAPSHOT — re-run the command to refresh.
//
// Tabs: Rules · Bugs · Settings (view-only) · Archive.
// Rules filtering: kind checkboxes (path / keyword / global / other, all on),
// a mandatory-only toggle, and free-text search.
//
// Options:
//   --root <path>   Project root containing .sextant/ (default: $PWD).
//   --out <path>    Output HTML path (default: <root>/.sextant/cerebrum/cerebrum.html).
//   -h, --help      Print usage.
//
// Exit codes: 0 ok; 2 arg parse error; 1 fatal.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { durableBase } from '../lib/paths.mjs';
import { parseCerebrum, readResolvedCerebrum } from '../lib/stores/cerebrum.mjs';
import { readConfig } from '../lib/config.mjs';

const USAGE = `Usage: cerebrum-view [options]

Generate a self-contained HTML viewer for this project's cerebrum, bugs,
settings, and archive.

Options:
  --root <path>   Project root containing .sextant/ (default: $PWD).
  --out <path>    Output HTML path (default: <root>/.sextant/cerebrum/cerebrum.html).
  -h, --help      Print this message.`;

function parseArgs(argv) {
  const out = { root: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      process.stderr.write(`cerebrum-view: unknown arg "${a}"\n`);
      process.exit(2);
    }
  }
  return out;
}

// Classify a rule's bucket tokens into the four filter KINDS. A rule may be in
// more than one kind (e.g. a [node:..][kw:..] rule is both path and keyword).
// Anything not path/keyword/global (provisional, ai-provisional, !review,
// untagged) falls to 'other'.
function classifyKinds(buckets) {
  const kinds = [];
  if (buckets.some((b) => b.startsWith('node:'))) kinds.push('path');
  if (buckets.some((b) => b.startsWith('kw:'))) kinds.push('keyword');
  if (buckets.includes('global') || buckets.includes('!global')) kinds.push('global');
  if (kinds.length === 0) kinds.push('other');
  return kinds;
}

function isMandatory(buckets) {
  return buckets.includes('!') || buckets.includes('!global');
}

// Pull the archive date out of a `<!-- sextant:archived YYYY-MM-DD -->` marker,
// which the parser attaches to a rule's `markers` when forget() prepends it in
// archive.md. Returns null for live rules (no such marker).
function archivedDateOf(markers) {
  for (const m of markers || []) {
    const hit = /sextant:archived\s+(\d{4}-\d{2}-\d{2})/.exec(m);
    if (hit) return hit[1];
  }
  return null;
}

// Shape a parsed cerebrum entry into a plain, JSON-serializable rule record.
function toRuleRecord(e) {
  return {
    date: e.date || null,
    archivedDate: archivedDateOf(e.markers),
    buckets: e.buckets || [],
    kinds: classifyKinds(e.buckets || []),
    mandatory: isMandatory(e.buckets || []),
    body: e.body || '',
    bySession: e.bySession || null,
  };
}

async function readTextOrEmpty(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function readJsonOrNull(p) {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Gather everything the viewer needs into a single plain object. Every source
// is read defensively — a missing or malformed file yields an empty section,
// never a throw, so the viewer always generates.
async function collectData(root) {
  const base = durableBase(root);
  const cerebrumDir = path.join(base, 'cerebrum');

  // Active rules (v2 resolver applies bucket normalization).
  let active = [];
  try {
    const { parsed } = await readResolvedCerebrum(cerebrumDir);
    active = (parsed.lines || []).filter((e) => e.kind === 'rule').map(toRuleRecord);
  } catch { active = []; }

  // Archived / forgotten rules (raw parse — same line format).
  let archived = [];
  try {
    const archiveText = await readTextOrEmpty(path.join(cerebrumDir, 'archive.md'));
    const parsed = parseCerebrum(archiveText);
    archived = (parsed.lines || []).filter((e) => e.kind === 'rule').map(toRuleRecord);
  } catch { archived = []; }

  // Bugs.
  let bugs = await readJsonOrNull(path.join(base, 'bugs.json'));
  if (!Array.isArray(bugs)) bugs = [];

  // Config (view-only).
  let config = {};
  try { config = await readConfig(root); } catch { config = {}; }

  return {
    root,
    generatedAt: null, // stamped by caller (Date.now() unavailable in some sandboxes)
    rules: active,
    archived,
    bugs,
    config,
  };
}

// --- HTML rendering ---------------------------------------------------------

// Escape a string for safe embedding inside a JSON <script> blob. We serialize
// the data as JSON, then neutralize the two sequences that could break out of
// a <script> element or an HTML comment.
function safeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildHtml(data) {
  const json = safeJson(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sextant — cerebrum</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1d212b; --fg: #e6e9ef;
    --muted: #8b93a7; --line: #2a2f3a; --accent: #6ea8fe; --bang: #ffcb6b;
    --path: #7ee787; --kw: #79c0ff; --global: #d2a8ff; --other: #8b93a7;
    --ok: #3fb950; --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 16px 20px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .meta { color: var(--muted); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--line);
    background: var(--panel); }
  nav button { background: none; border: none; color: var(--muted); padding: 12px 16px;
    cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; }
  nav button:hover { color: var(--fg); }
  nav button.active { color: var(--fg); border-bottom-color: var(--accent); }
  nav .count { color: var(--muted); font-size: 12px; margin-left: 6px; }
  main { padding: 20px; max-width: 1100px; }
  .controls { display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
    margin-bottom: 16px; }
  .controls input[type=search] { background: var(--panel2); border: 1px solid var(--line);
    color: var(--fg); padding: 8px 12px; border-radius: 6px; min-width: 260px; }
  .controls label { color: var(--muted); display: inline-flex; align-items: center;
    gap: 6px; cursor: pointer; user-select: none; }
  .controls .sep { width: 1px; height: 20px; background: var(--line); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 10px; }
  .card.mandatory { border-left: 3px solid var(--bang); }
  .card.archived { opacity: 0.6; }
  .card .top { display: flex; gap: 8px; align-items: center; margin-bottom: 6px;
    flex-wrap: wrap; }
  .date { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .chip { font-size: 11px; padding: 2px 7px; border-radius: 10px; border: 1px solid var(--line);
    color: var(--muted); white-space: nowrap; }
  .chip.path { color: var(--path); border-color: #2a4a32; }
  .chip.kw { color: var(--kw); border-color: #1f3a5a; }
  .chip.global { color: var(--global); border-color: #3a2a5a; }
  .chip.bang { color: var(--bang); border-color: #5a4a1f; font-weight: 600; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .body .hl { background: #4d4316; color: #fff; border-radius: 2px; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  .bug .err { font-weight: 600; }
  .bug .field { margin-top: 6px; }
  .bug .field .k { color: var(--muted); font-size: 12px; text-transform: uppercase;
    letter-spacing: 0.04em; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
  .badge.ok { background: #122b18; color: var(--ok); }
  .badge.no { background: #2b2412; color: var(--warn); }
  table.settings { border-collapse: collapse; }
  table.settings td { padding: 8px 16px 8px 0; border-bottom: 1px solid var(--line); }
  table.settings td.k { color: var(--muted); }
  .note { color: var(--muted); margin-top: 16px; font-size: 13px;
    background: var(--panel2); padding: 12px 14px; border-radius: 8px; }
  code { background: var(--panel2); padding: 1px 5px; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>Sextant — cerebrum</h1>
  <span class="meta" id="meta"></span>
</header>
<nav id="tabs"></nav>
<main id="view"></main>

<script id="data" type="application/json">${json}</script>
<script>
(function () {
  "use strict";
  const DATA = JSON.parse(document.getElementById("data").textContent);
  const el = (t, c, txt) => { const e = document.createElement(t); if (c) e.className = c;
    if (txt != null) e.textContent = txt; return e; };

  const meta = document.getElementById("meta");
  meta.textContent = DATA.root + (DATA.generatedAt ? "  ·  generated " + DATA.generatedAt : "")
    + "  ·  " + DATA.rules.length + " active rules";

  const TABS = [
    { id: "rules", label: "Rules", count: DATA.rules.length },
    { id: "bugs", label: "Bugs", count: DATA.bugs.length },
    { id: "settings", label: "Settings", count: null },
    { id: "archive", label: "Archive", count: DATA.archived.length },
  ];
  let current = "rules";

  const nav = document.getElementById("tabs");
  TABS.forEach((t) => {
    const b = el("button", null);
    b.appendChild(document.createTextNode(t.label));
    if (t.count != null) { const c = el("span", "count", String(t.count)); b.appendChild(c); }
    b.onclick = () => { current = t.id; render(); };
    b.dataset.id = t.id;
    nav.appendChild(b);
  });

  // Rules-tab filter state.
  const filter = { q: "", path: true, keyword: true, global: true, other: true, mandatoryOnly: false };

  function chipFor(bucket) {
    if (bucket.startsWith("node:")) return el("span", "chip path", bucket);
    if (bucket.startsWith("kw:")) return el("span", "chip kw", bucket);
    if (bucket === "global" || bucket === "!global") return el("span", "chip global", bucket);
    if (bucket === "!") return el("span", "chip bang", "!");
    return el("span", "chip", bucket);
  }

  function highlight(text, q) {
    const frag = document.createDocumentFragment();
    if (!q) { frag.appendChild(document.createTextNode(text)); return frag; }
    const lower = text.toLowerCase(), lq = q.toLowerCase();
    let i = 0, idx;
    while ((idx = lower.indexOf(lq, i)) !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      frag.appendChild(el("span", "hl", text.slice(idx, idx + q.length)));
      i = idx + q.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  function ruleCard(r, opts) {
    const card = el("div", "card" + (r.mandatory ? " mandatory" : "") + (opts && opts.archived ? " archived" : ""));
    const top = el("div", "top");
    if (r.date) top.appendChild(el("span", "date", r.date));
    if (opts && opts.archived && r.archivedDate) top.appendChild(el("span", "date", "↳ forgotten " + r.archivedDate));
    if (r.mandatory) top.appendChild(chipFor("!"));
    (r.buckets || []).filter((b) => b !== "!").forEach((b) => top.appendChild(chipFor(b)));
    card.appendChild(top);
    const body = el("div", "body");
    body.appendChild(highlight(r.body || "(no body)", filter.q));
    card.appendChild(body);
    return card;
  }

  function matchesFilter(r) {
    if (filter.mandatoryOnly && !r.mandatory) return false;
    const kindOk = r.kinds.some((k) => filter[k]);
    if (!kindOk) return false;
    if (filter.q) {
      const hay = (r.body + " " + r.buckets.join(" ")).toLowerCase();
      if (!hay.includes(filter.q.toLowerCase())) return false;
    }
    return true;
  }

  function renderRules(view) {
    // Build the controls ONCE; only the list below is redrawn on input. Re-running
    // the whole render on every keystroke would replace the focused <input> with a
    // new node, dropping focus/caret — making the search box unusable.
    view.innerHTML = "";
    const controls = el("div", "controls");
    const list = el("div");

    const draw = () => {
      list.innerHTML = "";
      const shown = DATA.rules.filter(matchesFilter);
      if (shown.length === 0) { list.appendChild(el("div", "empty", "No rules match the current filters.")); return; }
      shown.forEach((r) => list.appendChild(ruleCard(r)));
    };

    const search = el("input"); search.type = "search"; search.placeholder = "Search rules…";
    search.value = filter.q;
    search.oninput = () => { filter.q = search.value; draw(); };
    controls.appendChild(search);
    controls.appendChild(el("span", "sep"));
    [["path", "path"], ["keyword", "keyword"], ["global", "global"], ["other", "other"]]
      .forEach(([key, label]) => {
        const lab = el("label");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = filter[key];
        cb.onchange = () => { filter[key] = cb.checked; draw(); };
        lab.appendChild(cb); lab.appendChild(document.createTextNode(label));
        controls.appendChild(lab);
      });
    controls.appendChild(el("span", "sep"));
    const mlab = el("label");
    const mcb = el("input"); mcb.type = "checkbox"; mcb.checked = filter.mandatoryOnly;
    mcb.onchange = () => { filter.mandatoryOnly = mcb.checked; draw(); };
    mlab.appendChild(mcb); mlab.appendChild(document.createTextNode("mandatory only [!]"));
    controls.appendChild(mlab);

    view.appendChild(controls);
    view.appendChild(list);
    draw();
  }

  function renderBugs(view) {
    view.innerHTML = "";
    if (DATA.bugs.length === 0) { view.appendChild(el("div", "empty", "No bugs logged.")); return; }
    DATA.bugs.slice().reverse().forEach((b) => {
      const card = el("div", "card bug");
      const top = el("div", "top");
      top.appendChild(el("span", "date", (b.ts || "").slice(0, 10)));
      if (b.id) top.appendChild(el("span", "chip", b.id));
      if (b.file) top.appendChild(el("span", "chip path", b.file));
      top.appendChild(el("span", "badge " + (b.fix_verified ? "ok" : "no"),
        b.fix_verified ? "verified" : "unverified"));
      card.appendChild(top);
      card.appendChild(el("div", "err", b.error_message || "(no message)"));
      const fields = [["root cause", b.root_cause], ["fix", b.fix]];
      fields.forEach(([k, v]) => { if (v) {
        const f = el("div", "field"); f.appendChild(el("div", "k", k));
        f.appendChild(el("div", null, v)); card.appendChild(f);
      }});
      view.appendChild(card);
    });
  }

  function renderSettings(view) {
    view.innerHTML = "";
    const cfg = DATA.config || {};
    const tbl = el("table", "settings");
    const rows = [
      ["output_mode", cfg.output_mode != null ? String(cfg.output_mode) : "(default: quiet)"],
      ["capture_nudge", cfg.capture_nudge != null ? String(cfg.capture_nudge) : "(default: on)"],
    ];
    rows.forEach(([k, v]) => {
      const tr = el("tr");
      tr.appendChild(el("td", "k", k));
      const td = el("td"); td.appendChild(el("code", null, v)); tr.appendChild(td);
      tbl.appendChild(tr);
    });
    view.appendChild(tbl);
    const note = el("div", "note");
    note.appendChild(document.createTextNode("Settings are view-only here. Change output verbosity with "));
    note.appendChild(el("code", null, "/sextant:output"));
    note.appendChild(document.createTextNode(" and auto-rule capture with "));
    note.appendChild(el("code", null, "/sextant:autorules"));
    note.appendChild(document.createTextNode("."));
    view.appendChild(note);
  }

  function renderArchive(view) {
    view.innerHTML = "";
    if (DATA.archived.length === 0) { view.appendChild(el("div", "empty", "No archived rules.")); return; }
    view.appendChild(el("div", "note", "Forgotten / superseded rules from archive.md (no longer injected)."));
    DATA.archived.forEach((r) => view.appendChild(ruleCard(r, { archived: true })));
  }

  function render() {
    [...nav.children].forEach((b) => b.classList.toggle("active", b.dataset.id === current));
    const view = document.getElementById("view");
    if (current === "rules") renderRules(view);
    else if (current === "bugs") renderBugs(view);
    else if (current === "settings") renderSettings(view);
    else if (current === "archive") renderArchive(view);
  }

  render();
})();
</script>
</body>
</html>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const root = args.root ? path.resolve(args.root) : process.cwd();
  const data = await collectData(root);
  data.generatedAt = new Date().toISOString();

  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(durableBase(root), 'cerebrum', 'cerebrum.html');

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const html = buildHtml(data);
  const tmp = `${outPath}.tmp.${process.pid}`;
  await fsp.writeFile(tmp, html, 'utf8');
  await fsp.rename(tmp, outPath);

  process.stdout.write(`Cerebrum view written: ${outPath}\n`);
  process.stdout.write(`  ${data.rules.length} active rule(s), ${data.bugs.length} bug(s), ${data.archived.length} archived\n`);
  process.stdout.write(`Open it in a browser (file://${outPath}).\n`);
  return 0;
}

function isEntry() {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isEntry()) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      process.stderr.write(`cerebrum-view: fatal: ${err.message}\n${err.stack}\n`);
      process.exit(1);
    });
}

export { parseArgs, classifyKinds, isMandatory, collectData, buildHtml, safeJson };
