// Tests for the non-tranche capture nudge (lib/hooks/captureNudge.mjs) and its
// wiring into config + composeSessionStart.
//
// The scanner reads a transcript JSONL tail, scopes to the CURRENT turn (the
// assistant's visible output since the last real user prompt), and classifies
// trigger words into weak (model-flag only) and strong (also user-facing) tiers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  scanTurnTriggers,
  currentTurnAssistantText,
  composeCaptureNudge,
  composeCaptureNudgeUserMessage,
} from '../lib/hooks/captureNudge.mjs';
import { readCaptureNudgeMode, configPath, DEFAULT_CAPTURE_NUDGE_MODE } from '../lib/config.mjs';
import { composeSessionStartBlock } from '../lib/hooks/composeSessionStart.mjs';
import stop from '../lib/hooks/stop.mjs';
import userPromptSubmit from '../lib/hooks/userPromptSubmit.mjs';
import { readState, withState } from '../lib/state.mjs';
import { rulesAuthoredPath, turnStatePath } from '../lib/paths.mjs';
import {
  defaultTranches, startFeature, advanceTranche, setChecklistComplete, writeTranches,
} from '../lib/stores/tranches.mjs';

const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*m/g, '') : s);
const ctx = { eventName: 'Stop', nowIso: () => new Date().toISOString(), log: async () => {} };

function freshDir(prefix) {
  const p = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  fsSync.mkdirSync(p, { recursive: true });
  return p;
}

// Build a transcript JSONL from a list of [role, text|blocks] tuples.
function userMsg(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}
function assistantMsg(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}
// A tool result comes back as a `user` entry whose content is tool_result blocks
// (no human text) — it must NOT be treated as a turn boundary.
function toolResultMsg() {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  });
}
// An assistant entry mixing thinking + tool_use + text — only the text is visible.
function assistantWithThinking(thinkText, visibleText) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thinkText, signature: 'sig' },
        { type: 'tool_use', id: 't', name: 'Bash', input: {} },
        { type: 'text', text: visibleText },
      ],
    },
  });
}

async function writeTranscript(lines) {
  const dir = freshDir('capture-nudge-tx');
  const p = path.join(dir, 'transcript.jsonl');
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

test('scanner: weak trigger in final assistant message → matched, not strong', async () => {
  const p = await writeTranscript([
    userMsg('do the thing'),
    assistantMsg('Wait, that path was wrong but I fixed it.'),
  ]);
  const r = await scanTurnTriggers(p);
  assert.equal(r.matched, true);
  assert.equal(r.strong, false);
  assert.ok(r.words.map((w) => w.toLowerCase()).includes('wait'));
});

test('scanner: strong trigger → strong=true', async () => {
  const p = await writeTranscript([
    userMsg('fix it'),
    assistantMsg('The root cause was a stale cache; classic footgun.'),
  ]);
  const r = await scanTurnTriggers(p);
  assert.equal(r.matched, true);
  assert.equal(r.strong, true);
});

test('scanner: trigger in mid-turn narration (not the final message) is caught', async () => {
  const p = await writeTranscript([
    userMsg('investigate'),
    assistantMsg('Let me look. Wait — this is a gotcha in the parser.'), // mid-turn
    assistantWithThinking('private reasoning', 'All done, summary follows.'), // clean final msg
  ]);
  const r = await scanTurnTriggers(p);
  assert.equal(r.matched, true, 'mid-turn trigger should be scanned, not just the final message');
  assert.equal(r.strong, true); // "gotcha"
});

test('scanner: trigger ONLY in a prior turn is excluded (turn scoping)', async () => {
  const p = await writeTranscript([
    userMsg('first task'),
    assistantMsg('Wait, that was a gotcha.'), // prior turn — must be ignored
    userMsg('second task'), // current turn boundary
    assistantMsg('All clear, nothing notable here.'),
  ]);
  const r = await scanTurnTriggers(p);
  assert.equal(r.matched, false, 'a trigger before the last user prompt must not fire');
});

test('scanner: tool_result user entries are NOT a turn boundary', async () => {
  const p = await writeTranscript([
    userMsg('run the build'),
    assistantMsg('Running it now.'),
    toolResultMsg(), // role:user but tool_result — not a boundary
    assistantMsg('Turns out the build was broken — pitfall in the config.'),
  ]);
  const r = await scanTurnTriggers(p);
  assert.equal(r.matched, true);
  assert.equal(r.strong, true); // "turns out" / "pitfall" survive across the tool_result
});

test('scanner: clean output → no match', async () => {
  const p = await writeTranscript([
    userMsg('summarize'),
    assistantMsg('Here is the summary. Everything looks consistent and correct.'),
  ]);
  // budgetMs:0 → single scan: a true no-match turn shouldn't pay the poll budget.
  const r = await scanTurnTriggers(p, { budgetMs: 0 });
  assert.equal(r.matched, false);
});

test('scanner: thinking text is never scanned (only visible blocks)', async () => {
  // The trigger word lives ONLY in the thinking block; visible text is clean.
  const p = await writeTranscript([
    userMsg('go'),
    assistantWithThinking('Wait, this is a critical footgun gotcha', 'Done — no issues.'),
  ]);
  const r = await scanTurnTriggers(p, { budgetMs: 0 });
  assert.equal(r.matched, false, 'thinking content must not trigger the nudge');
});

test('scanner: missing / empty path → none', async () => {
  assert.deepEqual(await scanTurnTriggers('', { budgetMs: 0 }), { matched: false, strong: false, words: [] });
  assert.deepEqual(
    await scanTurnTriggers('/nonexistent/twirl.jsonl', { budgetMs: 0 }),
    { matched: false, strong: false, words: [] },
  );
});

// bug-7 sibling (flush race): at Stop the current turn's last assistant message
// may not be flushed to the transcript JSONL yet on a slow / 9p mount, so a
// single read can miss a trigger word that lives in that tail. The bounded poll
// must catch a late-flushed trigger; a budgetMs:0 control proves a single read
// would miss it (i.e. the poll — not the parser — is what fixes it).
test('scanner race: a late-flushed trigger is caught by the poll, not missed', async () => {
  const p = await writeTranscript([
    userMsg('investigate the parser'),
    assistantMsg('Looking into it now; reading the relevant files.'), // clean so far
  ]);
  // Control: an immediate single scan sees no trigger yet.
  const immediate = await scanTurnTriggers(p, { budgetMs: 0 });
  assert.equal(immediate.matched, false, 'single read must miss the not-yet-flushed trigger');

  // Flush a trigger-bearing message ~30ms in — comfortable slack inside the
  // 100ms budget so a loaded CI box's setTimeout drift can't push it past the
  // deadline (the budget here is tighter than bug-7's 250ms, so keep the margin).
  const late = assistantMsg('Turns out it was a gotcha in the tokenizer.');
  const timer = setTimeout(() => {
    fs.appendFile(p, late + '\n', 'utf8').catch(() => {});
  }, 30);
  try {
    const r = await scanTurnTriggers(p); // default poll budget
    assert.equal(r.matched, true, 'the late-flushed trigger must be caught by the poll');
    assert.equal(r.strong, true); // "turns out" / "gotcha"
  } finally {
    clearTimeout(timer);
  }
});

test('currentTurnAssistantText: partial first line is dropped', () => {
  const tail = { text: '{"broken json...\n' + assistantMsg('Critical bug here.'), partial: true };
  const txt = currentTurnAssistantText(tail);
  assert.ok(txt.includes('Critical bug here.'));
});

test('composeCaptureNudge: fenced, mentions /sextant:remember and the words', () => {
  const block = composeCaptureNudge(['gotcha', 'Wait']);
  assert.ok(block.includes('<!-- sextant:capture-nudge -->'));
  assert.ok(block.includes('<!-- /sextant:capture-nudge -->'));
  assert.ok(block.includes('/sextant:remember'));
  assert.ok(block.includes('gotcha'));
  // Standing-note phrasing, not an imperative to capture immediately.
  assert.ok(/don't let capture preempt|do that first/i.test(block));
});

test('composeCaptureNudgeUserMessage: tentative wording, no over-claim', () => {
  const msg = composeCaptureNudgeUserMessage();
  assert.ok(/might/i.test(msg), 'should hedge — a word match is not a verified rule');
  assert.ok(/sextant:remember|record/i.test(msg));
});

test('config: readCaptureNudgeMode defaults to on, honors off, ignores garbage', async () => {
  const dir = freshDir('capture-nudge-cfg');
  assert.equal(await readCaptureNudgeMode(dir), DEFAULT_CAPTURE_NUDGE_MODE);
  assert.equal(DEFAULT_CAPTURE_NUDGE_MODE, 'on');
  await fs.mkdir(path.dirname(configPath(dir)), { recursive: true });
  await fs.writeFile(configPath(dir), JSON.stringify({ capture_nudge: 'off' }), 'utf8');
  assert.equal(await readCaptureNudgeMode(dir), 'off');
  await fs.writeFile(configPath(dir), JSON.stringify({ capture_nudge: 'nonsense' }), 'utf8');
  assert.equal(await readCaptureNudgeMode(dir), 'on');
});

test('composeSessionStart: steering line present with content + non-tranche', () => {
  const block = composeSessionStartBlock({
    projectMd: '# Demo project',
    now: () => 0,
  });
  assert.ok(block.includes('## Capture as you go'));
  assert.ok(block.includes('/sextant:remember'));
});

test('composeSessionStart: steering omitted when captureNudge:false', () => {
  const block = composeSessionStartBlock({
    projectMd: '# Demo project',
    captureNudge: false,
    now: () => 0,
  });
  assert.ok(!block.includes('## Capture as you go'));
});

test('composeSessionStart: steering omitted during an active tranche', () => {
  const block = composeSessionStartBlock({
    projectMd: '# Demo project',
    trancheState: { feature: 'F', workflow_state: 'IMPLEMENTING', tranches: [] },
    now: () => 0,
  });
  assert.ok(!block.includes('## Capture as you go'));
});

test('composeSessionStart: empty inputs still return null (steering does not force a block)', () => {
  const block = composeSessionStartBlock({ now: () => 0 });
  assert.equal(block, null);
});

test('composeSessionStart: active tranche emits a first-turn reminder + charter offer', () => {
  const block = composeSessionStartBlock({
    trancheState: {
      feature: 'list-view-filters',
      workflow_state: 'IMPLEMENTING',
      charter_path: 'docs/feature-plans/list-view-filters/charter.md',
      active_tranche_id: '4',
      tranches: [
        { id: '3', title: 'Asesorías', status: 'SHIPPED' },
        { id: '4', title: 'Pagos', status: 'IN-FLIGHT' },
      ],
    },
    now: () => 0,
  });
  // Directive to surface to the user on the first reply.
  assert.match(block, /On your first reply this session, remind the user/);
  // Names the feature + the active tranche with its status.
  assert.match(block, /feature "list-view-filters"/);
  assert.match(block, /active T4 "Pagos" \(IN-FLIGHT\)/);
  // Offers to read the charter, by path, to get reacquainted.
  assert.match(block, /Offer to read the full charter \(docs\/feature-plans\/list-view-filters\/charter\.md\)/);
});

test('composeSessionStart: first-turn reminder degrades without charter_path / active match', () => {
  const block = composeSessionStartBlock({
    trancheState: { feature: 'F', workflow_state: 'PLANNING', tranches: [] },
    now: () => 0,
  });
  assert.match(block, /remind the user that a tranche workflow is in progress/);
  assert.match(block, /feature "F", workflow PLANNING/);
  // No charter path → no charter offer clause.
  assert.ok(!block.includes('Offer to read the full charter'));
});

// --- T1: surface pre-implementation open questions at SessionStart ---------

function trancheStateWithDoc({ status = 'STUB', oqCount = 0, oqText = '' }) {
  return {
    trancheState: {
      feature: 'F',
      workflow_state: status === 'IN-FLIGHT' ? 'IMPLEMENTING' : 'PLANNING',
      active_tranche_id: '1',
      tranches: [{ id: '1', title: 'T1', status, doc_path: 'docs/t1.md' }],
    },
    trancheDocParsed: {
      open_questions_count: oqCount,
      sections: { 'open questions before implementation': oqText },
      deliverables_summary: [],
      verification_gates_done: 0,
      verification_gates_total: 0,
    },
    now: () => 0,
  };
}

test('composeSessionStart: surfaces unchecked open questions (text) + count in reminder', () => {
  const block = composeSessionStartBlock(trancheStateWithDoc({
    oqCount: 2,
    oqText: '- [ ] First question\n- [x] already resolved\n- [ ] Second question',
  }));
  assert.match(block, /T1 open questions to resolve before READY \(2\):/);
  assert.match(block, /- First question/);
  assert.match(block, /- Second question/);
  assert.ok(!block.includes('already resolved'), 'checked items are not listed');
  // Count folded into the first-turn reminder (plural).
  assert.match(block, /There are 2 open questions to resolve before this tranche can reach READY\./);
});

test('composeSessionStart: singular phrasing for a single open question', () => {
  const block = composeSessionStartBlock(trancheStateWithDoc({
    oqCount: 1,
    oqText: '- [ ] The only question',
  }));
  assert.match(block, /There is 1 open question to resolve before this tranche can reach READY\./);
  assert.match(block, /T1 open questions to resolve before READY \(1\):/);
});

test('composeSessionStart: open-questions list caps at 8 with an overflow note', () => {
  const oqText = Array.from({ length: 11 }, (_, i) => `- [ ] Q${i + 1}`).join('\n');
  const block = composeSessionStartBlock(trancheStateWithDoc({ oqCount: 11, oqText }));
  assert.match(block, /open questions to resolve before READY \(11\):/);
  assert.ok(block.includes('Q8'), 'shows up to the cap');
  assert.ok(!block.includes('Q9'), 'omits items beyond the cap');
  assert.match(block, /…and 3 more \(see docs\/t1\.md\)\./);
});

test('composeSessionStart: no open-questions block or count when the section is empty', () => {
  const block = composeSessionStartBlock(trancheStateWithDoc({
    status: 'IN-FLIGHT', oqCount: 0, oqText: '',
  }));
  assert.ok(!block.includes('open questions to resolve before READY'));
  assert.ok(!block.includes('open question'), 'no count clause in the reminder when zero');
});

// --- status legend + READY → IN-FLIGHT advance directive -------------------
// An agent joining a feature cold must know the statuses mean (READY ≠ "go")
// and that it has to advance a READY tranche to IN-FLIGHT before coding —
// Sextant's capture gate keys on IMPLEMENTING and does NOT block coding against
// a READY tranche, so the reminder is the safeguard.

test('composeSessionStart: tranche status block carries a lifecycle legend', () => {
  const block = composeSessionStartBlock({
    trancheState: {
      feature: 'F', workflow_state: 'IMPLEMENTING', active_tranche_id: '1',
      tranches: [{ id: '1', title: 'T1', status: 'IN-FLIGHT' }],
    },
    now: () => 0,
  });
  assert.match(block, /lifecycle: STUB.*READY.*IN-FLIGHT.*SHIPPED/);
  assert.match(block, /code only while IN-FLIGHT/);
});

test('composeSessionStart: a READY active tranche gets an advance-to-IN-FLIGHT directive', () => {
  const block = composeSessionStartBlock(trancheStateWithDoc({ status: 'READY', oqCount: 0, oqText: '' }));
  assert.match(block, /T1 is READY \(planned, not started\)/);
  assert.match(block, /Run \/sextant:tranche-advance to move it to IN-FLIGHT BEFORE writing any implementation code/);
  assert.match(block, /Sextant does not block coding against a READY tranche/);
});

test('composeSessionStart: each active status gets its own next-action directive', () => {
  const stub = composeSessionStartBlock(trancheStateWithDoc({ status: 'STUB', oqCount: 0, oqText: '' }));
  assert.match(stub, /T1 is STUB \(being scoped\)/);
  assert.match(stub, /\/sextant:tranche-advance it to READY/);

  const inflight = composeSessionStartBlock(trancheStateWithDoc({ status: 'IN-FLIGHT', oqCount: 0, oqText: '' }));
  assert.match(inflight, /T1 is IN-FLIGHT \(active implementation tranche\)/);
  assert.match(inflight, /ship it via \/sextant:tranche-advance/);

  const shipped = composeSessionStartBlock(trancheStateWithDoc({ status: 'SHIPPED', oqCount: 0, oqText: '' }));
  assert.match(shipped, /T1 is SHIPPED \(feature complete\)/);
  assert.match(shipped, /`complete` then `finalize`/);
});

test('composeSessionStart: only READY gets the move-to-IN-FLIGHT directive', () => {
  for (const status of ['STUB', 'IN-FLIGHT', 'SHIPPED']) {
    const block = composeSessionStartBlock(trancheStateWithDoc({ status, oqCount: 0, oqText: '' }));
    assert.ok(!block.includes('move it to IN-FLIGHT BEFORE writing'),
      `${status} must not emit the READY-specific advance directive`);
  }
});

// --- end-to-end: Stop sets the flag + user line, next UserPromptSubmit drains it.

test('e2e: strong trigger → Stop user line + pending flag → UserPromptSubmit injects + clears', async () => {
  const cwd = freshDir('capture-nudge-e2e'); // no tranche, no cerebrum → gates skipped
  const sid = crypto.randomUUID();
  const tx = await writeTranscript([
    userMsg('fix the parser'),
    assistantMsg('Found it — the root cause was a stale cache. Classic footgun.'),
  ]);

  // Stop: scans the transcript, sets the pending flag, surfaces a user line.
  const r = await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  assert.ok(r && typeof r.systemMessage === 'string', 'expected a systemMessage on the clean stop');
  assert.ok(/capturable lessons|record those rules/i.test(stripAnsi(r.systemMessage)),
    `expected the capture user line; got: ${stripAnsi(r.systemMessage)}`);

  const afterStop = await readState(sid, cwd);
  assert.ok(afterStop.capture_nudge_pending, 'Stop should set capture_nudge_pending');

  // Next turn: UserPromptSubmit injects the model-facing nudge and clears the flag.
  const up = await userPromptSubmit({ session_id: sid, cwd, prompt: 'ok, do it' }, ctx);
  const add = up?.hookSpecificOutput?.additionalContext || '';
  assert.ok(add.includes('<!-- sextant:capture-nudge -->'), 'expected the capture-nudge block injected');
  assert.ok(add.includes('/sextant:remember'));

  const afterPrompt = await readState(sid, cwd);
  assert.ok(!afterPrompt.capture_nudge_pending, 'UserPromptSubmit should consume (clear) the flag');
});

test('e2e: capture_nudge=off suppresses the Stop flag entirely', async () => {
  const cwd = freshDir('capture-nudge-off');
  await fs.mkdir(path.dirname(configPath(cwd)), { recursive: true });
  await fs.writeFile(configPath(cwd), JSON.stringify({ capture_nudge: 'off' }), 'utf8');
  const sid = crypto.randomUUID();
  const tx = await writeTranscript([
    userMsg('go'),
    assistantMsg('This is a gotcha and a footgun and a pitfall.'),
  ]);
  await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  const st = await readState(sid, cwd);
  assert.ok(!st.capture_nudge_pending, 'off mode must not set a pending flag');
});

test('e2e: weak-only trigger sets the flag but emits NO user line', async () => {
  const cwd = freshDir('capture-nudge-weak');
  const sid = crypto.randomUUID();
  const tx = await writeTranscript([
    userMsg('check'),
    assistantMsg('Wait, there might be a gap here, but it is a minor problem.'),
  ]);
  const r = await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  const st = await readState(sid, cwd);
  assert.ok(st.capture_nudge_pending, 'weak trigger still sets the model flag');
  const msg = stripAnsi(r && r.systemMessage ? r.systemMessage : '');
  assert.ok(!/capturable lessons|record those rules/i.test(msg),
    'weak-only match must not raise the user-facing line');
});

// --- don't-fire paths: the noise-control gates (the actual risk surface).

test('e2e suppression: a rule authored this turn → NO pending flag', async () => {
  const cwd = freshDir('capture-nudge-supp');
  const sid = crypto.randomUUID();
  const tx = await writeTranscript([
    userMsg('fix'),
    assistantMsg('The root cause was obvious — a real gotcha.'),
  ]);
  // Simulate /sextant:remember having appended a rule THIS turn: one
  // rules-authored.jsonl entry with a fresh ts (countAuthoredThisTurn > 0).
  await fs.mkdir(path.dirname(rulesAuthoredPath(sid, cwd)), { recursive: true });
  await fs.writeFile(
    rulesAuthoredPath(sid, cwd),
    JSON.stringify({ ts: new Date().toISOString() }) + '\n',
    'utf8',
  );
  await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  const st = await readState(sid, cwd);
  assert.ok(!st.capture_nudge_pending, 'capture happened → suppress the nudge');
});

test('e2e cooldown: a recent nudge holds off another within the window', async () => {
  const cwd = freshDir('capture-nudge-cool');
  const sid = crypto.randomUUID();
  const tx = await writeTranscript([
    userMsg('look'),
    assistantMsg('Another gotcha — a footgun in the config.'),
  ]);
  // This turn is turn_id 5; we nudged on turn 4 → diff 1 < cooldown(3) → hold.
  await fs.mkdir(path.dirname(turnStatePath(sid, cwd)), { recursive: true });
  await fs.writeFile(turnStatePath(sid, cwd), JSON.stringify({ turn_id: 5 }), 'utf8');
  await withState(sid, cwd, (s) => { s.capture_nudge_last_turn = 4; });
  await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  const st = await readState(sid, cwd);
  assert.equal(st.capture_nudge_last_turn, 4, 'cooldown must not advance the marker');
  assert.ok(!st.capture_nudge_pending, 'cooldown must suppress a new nudge');
});

// --- in-tranche: the existing IN-FLIGHT capture gate must be untouched, and the
// non-tranche nudge must NOT also fire (no double capture prompting).

async function seedInFlight(cwd) {
  await fs.mkdir(path.join(cwd, '.sextant'), { recursive: true });
  const s = defaultTranches();
  startFeature(s, {
    feature: 'f', docRoot: 'docs/f', charterPath: 'docs/f/charter.md',
    specPath: 'docs/f/spec.md', tranches: [{ id: '1', title: 'T1', scope: ['x'], depends_on: [] }],
  });
  advanceTranche(s, '1', 'READY');
  setChecklistComplete(s, '1');
  advanceTranche(s, '1', 'IN-FLIGHT'); // workflow → IMPLEMENTING (arms the capture gate)
  await writeTranches(cwd, s);
}

test('in-tranche: capture gate still blocks; non-tranche nudge does NOT also fire', async () => {
  const cwd = freshDir('capture-nudge-tranche');
  const sid = crypto.randomUUID();
  await seedInFlight(cwd);
  const tx = await writeTranscript([
    userMsg('implement it'),
    assistantMsg('Done — though there is a gotcha and a footgun worth noting.'),
  ]);
  const r = await stop({ session_id: sid, cwd, transcript_path: tx }, ctx);
  // The tranche IN-FLIGHT capture gate owns this — it blocks (unchanged behavior).
  assert.equal(r.decision, 'block', 'in-flight tranche capture gate must still block');
  const st = await readState(sid, cwd);
  assert.ok(!st.capture_nudge_pending,
    'non-tranche nudge must NOT set a flag while a tranche is active (no double prompting)');
});
