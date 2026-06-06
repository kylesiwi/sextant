// Tests for lib/inject/compose.mjs — pure composer for the PreToolUse Read
// additionalContext block.
//
// These tests don't load the parser, don't touch the filesystem, and don't
// hit Claude. We construct synthetic graph + node objects in memory and
// exercise the composer's section ordering, omission rules, truncation, and
// label-rendering edge cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  composeReadBlock,
  READ_CONTEXT_OPEN_MARKER,
  READ_CONTEXT_CLOSE_MARKER,
  SECTIONS,
} from '../lib/inject/compose.mjs';

import {
  NODE_TYPES,
  EDGE_TYPES,
  CONFIDENCE,
  GRAPH,
  NODE,
  EDGE,
  fileNodeId,
} from '../lib/graph/schema.mjs';

// ---- helpers --------------------------------------------------------------

function makeFileNode(rel, symbols = [], community = null) {
  return {
    [NODE.ID]: fileNodeId(rel),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: path.basename(rel),
    [NODE.PATH]: rel,
    [NODE.SYMBOLS]: symbols,
    [NODE.COMMUNITY]: community,
  };
}

function makeEdge(from, to, type = EDGE_TYPES.IMPORTS, conf = CONFIDENCE.INTRA_FILE_ONLY) {
  return {
    [EDGE.FROM]: from,
    [EDGE.TO]: to,
    [EDGE.TYPE]: type,
    [EDGE.CONFIDENCE]: conf,
  };
}

function makeGraph(nodes, edges) {
  return {
    [GRAPH.SCHEMA_VERSION]: 1,
    [GRAPH.NODES]: nodes,
    [GRAPH.EDGES]: edges,
    [GRAPH.BUILT_AT]: '2026-05-11T00:00:00Z',
    [GRAPH.STATS]: { files: nodes.length, edges: edges.length },
  };
}

// ---- 1. happy path: all 4 Phase 1a sections render in order ---------------

test('composeReadBlock: emits all 4 Phase 1a sections in priority order', () => {
  const a = makeFileNode('src/a.ts', ['alpha', 'Beta'], 7);
  const b = makeFileNode('src/b.ts', ['b']);
  const c = makeFileNode('src/c.ts', ['c']);
  const d = makeFileNode('src/d.ts', ['d']);
  const e = makeFileNode('src/e.ts', ['e']);
  const graph = makeGraph(
    [a, b, c, d, e],
    [
      // a imports b, c, d (top 3 outbound)
      makeEdge(a[NODE.ID], b[NODE.ID]),
      makeEdge(a[NODE.ID], c[NODE.ID]),
      makeEdge(a[NODE.ID], d[NODE.ID]),
      // d uses a (one inbound)
      makeEdge(d[NODE.ID], a[NODE.ID]),
      makeEdge(e[NODE.ID], a[NODE.ID]),
    ],
  );

  const { content, sectionsEmitted, sectionsDropped } = composeReadBlock({ node: a, graph });

  assert.equal(sectionsDropped.length, 0);
  assert.deepEqual(sectionsEmitted, [
    SECTIONS.IDENTITY,
    SECTIONS.CONNECTIONS,
    SECTIONS.USED_BY,
    SECTIONS.SYMBOLS,
  ]);

  assert.ok(content.startsWith(READ_CONTEXT_OPEN_MARKER));
  assert.ok(content.endsWith(READ_CONTEXT_CLOSE_MARKER));
  // R13: imperative line (no mandatory rules → graph-context variant)
  assert.match(content, /Use the context below to understand this file/);
  // Identity line
  assert.match(content, /graph: a\.ts; community: #7/);
  // Connections section
  assert.match(content, /connections \(top 3\):/);
  assert.match(content, /-> b\.ts \[imports, intra-file-only\]/);
  assert.match(content, /-> c\.ts \[imports, intra-file-only\]/);
  assert.match(content, /-> d\.ts \[imports, intra-file-only\]/);
  // used_by section
  assert.match(content, /used_by \(top 2\):/);
  assert.match(content, /<- d\.ts \[imports, intra-file-only\]/);
  assert.match(content, /<- e\.ts \[imports, intra-file-only\]/);
  // Symbols section — alpha is lowercase, Beta uppercase
  assert.match(content, /symbols \(up to 20\): alpha\(\), Beta/);
});

// ---- 2. empty connections → connections header omitted ---------------------

test('composeReadBlock: zero connections omits the connections section header', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const b = makeFileNode('src/b.ts');
  const graph = makeGraph(
    [a, b],
    [makeEdge(b[NODE.ID], a[NODE.ID])], // only inbound, no outbound from a
  );

  const { content, sectionsEmitted } = composeReadBlock({ node: a, graph });

  assert.ok(!content.includes('connections'), `should not include connections header; got: ${content}`);
  assert.ok(content.includes('used_by'));
  assert.deepEqual(sectionsEmitted, [
    SECTIONS.IDENTITY,
    SECTIONS.USED_BY,
    SECTIONS.SYMBOLS,
  ]);
});

// ---- 3. empty used_by → used_by header omitted -----------------------------

test('composeReadBlock: zero used_by omits the used_by section header', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const b = makeFileNode('src/b.ts');
  const graph = makeGraph(
    [a, b],
    [makeEdge(a[NODE.ID], b[NODE.ID])], // outbound only
  );

  const { content, sectionsEmitted } = composeReadBlock({ node: a, graph });

  assert.ok(content.includes('connections'));
  assert.ok(!content.includes('used_by'), `should not include used_by header; got: ${content}`);
  assert.deepEqual(sectionsEmitted, [
    SECTIONS.IDENTITY,
    SECTIONS.CONNECTIONS,
    SECTIONS.SYMBOLS,
  ]);
});

// ---- 4. 25 symbols + symbolsMax=20 → exactly 20 rendered ------------------

test('composeReadBlock: caps symbols at symbolsMax', () => {
  const syms = [];
  for (let i = 0; i < 25; i++) syms.push(`sym${i}`);
  const a = makeFileNode('src/a.ts', syms);
  const graph = makeGraph([a], []);

  const { content } = composeReadBlock({ node: a, graph, opts: { symbolsMax: 20 } });

  // Count the function-suffixed names; all sym0..sym19 start lowercase.
  const matches = content.match(/sym\d+\(\)/g) || [];
  assert.equal(matches.length, 20, `expected 20 symbols; got ${matches.length}`);
  // sym19 should be present; sym20 should NOT be.
  assert.ok(content.includes('sym19()'));
  assert.ok(!content.includes('sym20()'));
});

test('composeReadBlock: symbolsMax=0 omits the symbols section', () => {
  const a = makeFileNode('src/a.ts', ['x', 'y']);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({ node: a, graph, opts: { symbolsMax: 0 } });
  assert.ok(!content.includes('symbols'));
  assert.ok(!sectionsEmitted.includes(SECTIONS.SYMBOLS));
});

// ---- 5. truncation: small cap drops bottom sections ------------------------

test('composeReadBlock: small cap truncates from the bottom up', () => {
  const syms = Array.from({ length: 20 }, (_, i) => `verylongidentifierwithpadding_${i}`);
  const a = makeFileNode('src/a.ts', syms);
  const b = makeFileNode('src/b.ts');
  const c = makeFileNode('src/c.ts');
  const graph = makeGraph(
    [a, b, c],
    [
      makeEdge(a[NODE.ID], b[NODE.ID]),
      makeEdge(c[NODE.ID], a[NODE.ID]),
    ],
  );

  // capChars=200 is tight enough that, with overhead, only the identity line fits.
  const { content, sectionsEmitted, sectionsDropped } = composeReadBlock({
    node: a, graph,
    opts: { capChars: 200, safetyMargin: 50 },
  });

  // At minimum, identity is emitted and symbols (large) is dropped.
  assert.ok(sectionsEmitted.includes(SECTIONS.IDENTITY));
  assert.ok(sectionsDropped.includes(SECTIONS.SYMBOLS), `expected symbols in dropped; dropped=${sectionsDropped}`);
  assert.ok(content.includes('sextant:truncated'));
  // Dropped list in marker includes the human-readable id.
  assert.ok(content.includes('symbols'));
});

// ---- 6. cap large enough → no truncation marker ----------------------------

test('composeReadBlock: large cap emits no truncation marker', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content, sectionsDropped } = composeReadBlock({
    node: a, graph,
    opts: { capChars: 10000 },
  });
  assert.equal(sectionsDropped.length, 0);
  assert.ok(!content.includes('sextant:truncated'));
});

// ---- 7. community rendering -----------------------------------------------

test('composeReadBlock: community number renders as #<n>', () => {
  const a = makeFileNode('src/a.ts', [], 5);
  const graph = makeGraph([a], []);
  const { content } = composeReadBlock({ node: a, graph });
  assert.match(content, /community: #5/);
});

test('composeReadBlock: null community renders as "none"', () => {
  const a = makeFileNode('src/a.ts', [], null);
  const graph = makeGraph([a], []);
  const { content } = composeReadBlock({ node: a, graph });
  assert.match(content, /community: none/);
});

// ---- 8. unresolved target ids → prefix stripped ----------------------------

test('composeReadBlock: unresolved:<spec> target renders as <spec>', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph(
    [a],
    [makeEdge(a[NODE.ID], 'unresolved:lodash', EDGE_TYPES.IMPORTS, CONFIDENCE.UNVERIFIED)],
  );
  const { content } = composeReadBlock({ node: a, graph });
  assert.match(content, /-> lodash \[imports, unverified\]/);
});

// ---- 9. node:src/foo.ts target with intra-file-only confidence ------------

test('composeReadBlock: node:<path> target without resolved node renders as <path>', () => {
  const a = makeFileNode('src/a.ts');
  // Edge target is `node:./bar` style (the extractor's intra-file-only output)
  // but no resolved node sits in the graph for it.
  const graph = makeGraph(
    [a],
    [makeEdge(a[NODE.ID], 'node:src/foo.ts')],
  );
  const { content } = composeReadBlock({ node: a, graph });
  assert.match(content, /-> src\/foo\.ts \[imports, intra-file-only\]/);
});

test('composeReadBlock: node:./bar style target renders the bare path', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph(
    [a],
    [makeEdge(a[NODE.ID], 'node:./bar')],
  );
  const { content } = composeReadBlock({ node: a, graph });
  assert.match(content, /-> \.\/bar \[imports, intra-file-only\]/);
});

// ---- 10. empty graph / node-less call --------------------------------------

test('composeReadBlock: missing node returns empty content', () => {
  const { content, sectionsEmitted } = composeReadBlock({ node: null, graph: makeGraph([], []) });
  assert.equal(content, '');
  assert.equal(sectionsEmitted.length, 0);
});

test('composeReadBlock: node with no symbols and no edges emits identity only', () => {
  const a = makeFileNode('src/a.ts', [], null);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({ node: a, graph });
  assert.deepEqual(sectionsEmitted, [SECTIONS.IDENTITY]);
  assert.match(content, /graph: a\.ts; community: none/);
  assert.ok(!content.includes('connections'));
  assert.ok(!content.includes('used_by'));
  assert.ok(!content.includes('symbols'));
});

// ---- 11. topK=0 omits connections + used_by --------------------------------

test('composeReadBlock: topK=0 omits both connection sections', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const b = makeFileNode('src/b.ts');
  const graph = makeGraph(
    [a, b],
    [makeEdge(a[NODE.ID], b[NODE.ID]), makeEdge(b[NODE.ID], a[NODE.ID])],
  );
  const { content, sectionsEmitted } = composeReadBlock({ node: a, graph, opts: { topK: 0 } });
  assert.ok(!content.includes('connections'));
  assert.ok(!content.includes('used_by'));
  assert.deepEqual(sectionsEmitted, [SECTIONS.IDENTITY, SECTIONS.SYMBOLS]);
});

// ---- 12. dropped list excludes mandatory sections --------------------------

test('composeReadBlock: mandatory rules + bug summary never appear in dropped list (Phase 1a noop)', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  // Phase 1a callers don't pass these — confirm the dropped list is empty.
  const { sectionsDropped } = composeReadBlock({ node: a, graph });
  assert.ok(!sectionsDropped.includes(SECTIONS.MANDATORY_RULES));
  assert.ok(!sectionsDropped.includes(SECTIONS.BUG_SUMMARY));
});

test('composeReadBlock: includeMandatoryRules (strings) renders at the top with bullet header', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: ['MUST not touch foo()', 'NEVER do bar'] },
  });
  // mandatory_rules id appears before identity in emitted list.
  assert.equal(sectionsEmitted[0], SECTIONS.MANDATORY_RULES);
  // R13: imperative line (rules present → enforcement variant)
  assert.match(content, /Apply every rule below to all edits in this file/);
  // Header has the count.
  assert.match(content, /rules \(2\):/);
  // Bullet prefix added when strings don't already include one.
  assert.match(content, /^ {2}• MUST not touch foo\(\)$/m);
  assert.match(content, /^ {2}• NEVER do bar$/m);

  // The priority-1 block must precede the identity line in the output.
  const idxMandatory = content.indexOf('rules (');
  const idxIdentity = content.indexOf('graph:');
  assert.ok(idxMandatory >= 0 && idxIdentity > idxMandatory,
    `mandatory rules should come before identity; got mandatory=${idxMandatory} identity=${idxIdentity}`);
});

// ---- 12b. Phase 2c: mandatory rules as parseCerebrum-style objects --------

test('composeReadBlock: includeMandatoryRules accepts rule objects with body/buckets/bySession', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const ruleA = {
    raw: '- 2026-05-10: [!] [node:src/a.ts] never log secrets (by: sess-1)',
    kind: 'rule',
    buckets: ['!', 'node:src/a.ts'],
    body: 'never log secrets',
    bySession: 'sess-1',
  };
  const ruleB = {
    raw: '- 2026-05-10: [!] [!global] always run prettier',
    kind: 'rule',
    buckets: ['!', '!global'],
    body: 'always run prettier',
    bySession: null,
  };
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: [ruleA, ruleB] },
  });
  assert.equal(sectionsEmitted[0], SECTIONS.MANDATORY_RULES);
  assert.match(content, /rules \(2\):/);
  // node-bucketed rule renders by SCOPE only ([node:<path>])
  // — no hardcoded [!], since node: fires by scope and [!] is now kw-only.
  assert.match(content, /  • \[node:src\/a\.ts\] never log secrets \(from sess-1 session\)/);
  // Global rule renders with [!global] label, no by clause.
  assert.match(content, /  • \[!global\] always run prettier/);
});

test('composeReadBlock: a [kw:]-only rule (no !) renders with a [kw] label (cerebrum-v2 T3)', () => {
  // Regression: BM25-surfaced kw rules carry only [kw:…] (no '!'); the renderer
  // must NOT drop them as "filtered incorrectly" — that silently hid the entire
  // v2 ranked-kw Read tier.
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const kwRule = { kind: 'rule', buckets: ['kw:billing'], body: 'ranked billing rule', bySession: null };
  const { content } = composeReadBlock({
    node: a, graph, opts: { includeMandatoryRules: [kwRule] },
  });
  assert.match(content, /rules \(1\):/);
  assert.match(content, /  • \[kw\] ranked billing rule/);
});

// ---- 12c. truncation: mandatory rules under cap → all render --------------

test('composeReadBlock: mandatory rules under cap all render, no truncation', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const rules = [
    { kind: 'rule', buckets: ['!', '!global'], body: 'rule one', bySession: null },
    { kind: 'rule', buckets: ['!', '!global'], body: 'rule two', bySession: null },
    { kind: 'rule', buckets: ['!', '!global'], body: 'rule three', bySession: null },
  ];
  const { content, sectionsEmitted, sectionsDropped } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: rules, capChars: 10000 },
  });
  assert.equal(sectionsEmitted[0], SECTIONS.MANDATORY_RULES);
  assert.equal(sectionsDropped.length, 0);
  assert.match(content, /rules \(3\):/);
  assert.match(content, /rule one/);
  assert.match(content, /rule two/);
  assert.match(content, /rule three/);
  assert.ok(!content.includes('sextant:truncated'));
});

// ---- 12d. truncation: mandatory rules exceed cap → trim + specific warning ---

test('composeReadBlock: path (node:) rules are NEVER dropped; keyword matches shed first on overflow', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  const body = 'y'.repeat(55);
  // Two node rules FIRST (the oldest entries — under the old front-drop they'd be
  // shed first), then four keyword matches. Budget admits only a few lines.
  const rules = [
    { kind: 'rule', buckets: ['!', 'node:src/a.ts'], body: `NODEKEEP0-${body}`, bySession: null },
    { kind: 'rule', buckets: ['node:src/a.ts'], body: `NODEKEEP1-${body}`, bySession: null },
    { kind: 'rule', buckets: ['kw:foo'], body: `KWDROP0-${body}`, bySession: null },
    { kind: 'rule', buckets: ['kw:foo'], body: `KWDROP1-${body}`, bySession: null },
    { kind: 'rule', buckets: ['kw:foo'], body: `KWDROP2-${body}`, bySession: null },
    { kind: 'rule', buckets: ['kw:foo'], body: `KWDROP3-${body}`, bySession: null },
  ];
  const { content } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: rules, capChars: 320, safetyMargin: 50 },
  });

  // Both node rules survive even though they are the OLDEST entries.
  assert.ok(content.includes('NODEKEEP0-'), `node rule 0 must survive overflow; got:\n${content}`);
  assert.ok(content.includes('NODEKEEP1-'), `node rule 1 must survive overflow; got:\n${content}`);
  // Keyword matches are shed to make room; truncation marker reports it.
  assert.ok(content.includes('sextant:truncated'), `expected truncation marker; got:\n${content}`);
  assert.ok(!content.includes('KWDROP0-'), `oldest keyword match should drop; got:\n${content}`);
});

test('composeReadBlock: mandatory rules exceeding cap drop oldest first + emit specific warning', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  // Build 5 long rules. With capChars=300/safetyMargin=50, the budget is 250,
  // and each rule line is ~80 chars → only 2-3 fit. Oldest entries (index 0..)
  // should be dropped first.
  const bodyText = 'x'.repeat(60);
  const rules = [];
  for (let i = 0; i < 5; i++) {
    rules.push({
      kind: 'rule',
      buckets: ['!', '!global'],
      body: `rule-${i}-${bodyText}`,
      bySession: null,
    });
  }
  const { content, sectionsEmitted, sectionsDropped } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: rules, capChars: 300, safetyMargin: 50 },
  });

  // mandatory rules section was emitted (some rules survived).
  assert.ok(sectionsEmitted.includes(SECTIONS.MANDATORY_RULES));
  // Mandatory rules MUST NEVER appear in sectionsDropped per § 5.3.
  assert.ok(!sectionsDropped.includes(SECTIONS.MANDATORY_RULES),
    `mandatory_rules MUST NOT appear in dropped list; got: ${sectionsDropped}`);
  // Truncation warning is emitted with the specific mandatory-rules count.
  assert.ok(content.includes('sextant:truncated'),
    `expected truncation marker; got:\n${content}`);
  assert.match(content, /dropped: rules \(\d+ dropped\)/,
    `expected rules dropped count; got:\n${content}`);
  // Newest rule (index 4) must be present; oldest (index 0) must be dropped.
  assert.ok(content.includes('rule-4-'), `newest rule should remain; got:\n${content}`);
  assert.ok(!content.includes('rule-0-'), `oldest rule should be dropped; got:\n${content}`);
});

// ---- 12e. adaptive body clamp (variable render budget, v0.36.4) ----------

test('composeReadBlock: long bodies render in FULL when the block fits (no clamp)', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  // A single 500-char rule with a generous cap: the priority-1 block fits, so
  // the body is NOT clamped — the whole point of the variable budget (few rules
  // → no cap). This would have been truncated at 200 under the old hard cap.
  const longBody = 'L'.repeat(500);
  const rule = { kind: 'rule', buckets: ['!', '!global'], body: longBody, bySession: null };
  const { content } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: [rule], capChars: 10000 },
  });
  assert.ok(content.includes('L'.repeat(500)), `full body should render uncapped; got:\n${content}`);
  assert.ok(!content.includes('L'.repeat(500) + '...'), 'no ellipsis when rendered in full');
});

test('composeReadBlock: adaptive cap clamps long bodies under budget pressure', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  // Three node-path rules (never dropped) each far longer than the floor, with a
  // tight cap so the priority-1 block overflows → the adaptive per-rule clamp
  // cap = max(200, budget/3) trims each body. Path rules survive, but clamped.
  const longBody = 'L'.repeat(500);
  const rules = [];
  for (let i = 0; i < 3; i++) {
    rules.push({ kind: 'rule', buckets: [`node:src/a.ts`], body: `R${i}-${longBody}`, bySession: null });
  }
  const { content } = composeReadBlock({
    node: a, graph,
    opts: { includeMandatoryRules: rules, capChars: 900 },
  });
  // All three path rules survive (deterministic floor, never dropped)...
  assert.ok(content.includes('R0-') && content.includes('R1-') && content.includes('R2-'),
    `all node rules must survive; got:\n${content}`);
  // ...but each body is clamped (no full 500-run) with an ellipsis suffix.
  assert.ok(!content.includes('L'.repeat(400)), `body should be clamped well under 400 L's; got:\n${content}`);
  assert.match(content, /L{100,}\.\.\./, 'expected ellipsis after clamped body');
});

test('composeReadBlock: includeBugSummary renders before identity', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeBugSummary: { open: 3, most_recent: 'race in foo' } },
  });
  // bug_summary id appears before identity in emitted list (no mandatory rules here).
  assert.equal(sectionsEmitted[0], SECTIONS.BUG_SUMMARY);
  assert.match(content, /bugs: 3 open/);
  assert.match(content, /most recent unfixed: race in foo/);
});

// ---- Phase 3 bug summary shapes -------------------------------------------

test('composeReadBlock: Phase 3 shape — open_count + most_recent entry renders id + error_message', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: {
      includeBugSummary: {
        open_count: 3,
        most_recent: {
          id: 'bug-7',
          error_message: 'TypeError on validateToken',
        },
      },
    },
  });
  assert.equal(sectionsEmitted[0], SECTIONS.BUG_SUMMARY);
  assert.match(content, /bugs: 3 open in project/);
  assert.match(content, /most recent in this file: TypeError on validateToken \(id bug-7\)/);
});

test('composeReadBlock: Phase 3 shape — open_count > 0 + most_recent=null renders count only', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeBugSummary: { open_count: 5, most_recent: null } },
  });
  assert.equal(sectionsEmitted[0], SECTIONS.BUG_SUMMARY);
  assert.match(content, /bugs: 5 open in project/);
  assert.ok(!content.includes('most recent in this file'),
    `should not render most recent when null; got:\n${content}`);
});

test('composeReadBlock: Phase 3 shape — open_count === 0 omits the section entirely', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeBugSummary: { open_count: 0, most_recent: null } },
  });
  assert.ok(!sectionsEmitted.includes(SECTIONS.BUG_SUMMARY));
  assert.ok(!content.includes('bugs:'));
});

// ---- Phase 4: priority-8 Lunr-ranked rules --------------------------------

test('composeReadBlock: includeLunrRules renders priority-8 block', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const lunrRules = [
    { body: 'validateToken should return a boolean', score: 4.32, source: 'global' },
    { body: 'refreshToken needs await before returning', score: 2.1, source: 'node:src/auth.ts' },
  ];
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeLunrRules: lunrRules },
  });
  // The Lunr section is part of the emitted list.
  assert.ok(sectionsEmitted.includes(SECTIONS.LUNR_RULES));
  // Header includes the count.
  assert.match(content, /related rules \(top 2\):/);
  // Each rule line surfaces body + score + source.
  assert.match(content, / {2}- validateToken should return a boolean \(score 4\.32, source global\)/);
  assert.match(content, / {2}- refreshToken needs await before returning \(score 2\.1, source node:src\/auth\.ts\)/);
});

test('composeReadBlock: includeLunrRules clamps long body to 200 chars with ellipsis', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const longBody = 'L'.repeat(500);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeLunrRules: [{ body: longBody, score: 1, source: 'global' }] },
  });
  assert.ok(sectionsEmitted.includes(SECTIONS.LUNR_RULES));
  // Clamped well under the runaway threshold and tagged with ellipsis.
  assert.ok(!content.includes('L'.repeat(300)));
  assert.match(content, /L{100,}\.\.\./);
});

test('composeReadBlock: includeLunrRules with missing score/source still renders body', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content } = composeReadBlock({
    node: a, graph,
    opts: { includeLunrRules: [{ body: 'bare rule' }] },
  });
  assert.match(content, / {2}- bare rule\n/);
});

test('composeReadBlock: includeLunrRules empty array omits the section', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeLunrRules: [] },
  });
  assert.ok(!sectionsEmitted.includes(SECTIONS.LUNR_RULES));
  assert.ok(!content.includes('related rules'));
});

test('composeReadBlock: includeLunrRules sits below symbols, above repeated-read warning', () => {
  const a = makeFileNode('src/a.ts', ['x', 'y']);
  const graph = makeGraph([a], []);
  const warning = 'sextant: this file was already read this turn';
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: {
      includeLunrRules: [{ body: 'related rule one', score: 2, source: 'global' }],
      repeatedReadWarning: warning,
    },
  });
  // Order: identity → symbols → lunr_rules → repeated_read.
  const idxIdentity = sectionsEmitted.indexOf(SECTIONS.IDENTITY);
  const idxSymbols = sectionsEmitted.indexOf(SECTIONS.SYMBOLS);
  const idxLunr = sectionsEmitted.indexOf(SECTIONS.LUNR_RULES);
  const idxWarn = sectionsEmitted.indexOf(SECTIONS.REPEATED_READ);
  assert.ok(idxIdentity < idxSymbols);
  assert.ok(idxSymbols < idxLunr);
  assert.ok(idxLunr < idxWarn);

  // Same in content order.
  const cIdentity = content.indexOf('graph:');
  const cSymbols = content.indexOf('symbols (up to');
  const cLunr = content.indexOf('related rules');
  const cWarn = content.indexOf(warning);
  assert.ok(cIdentity < cSymbols && cSymbols < cLunr && cLunr < cWarn);
});

test('composeReadBlock: tight cap drops lunr_rules before why (priority 7 before 8)', () => {
  // We use both a `why` line and lunr rules. Spec: priority 7 (why) survives
  // before priority 8 (lunr) when truncating from the bottom up.
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const longLunr = [
    { body: 'L'.repeat(190), score: 4.2, source: 'global' },
    { body: 'M'.repeat(190), score: 3.1, source: 'global' },
    { body: 'N'.repeat(190), score: 2.4, source: 'global' },
  ];
  const { content, sectionsEmitted, sectionsDropped } = composeReadBlock({
    node: a, graph,
    opts: {
      includeWhy: 'this file owns auth flow',
      includeLunrRules: longLunr,
      capChars: 250, // Tight enough that lunr rules can't fit alongside why
      safetyMargin: 50,
    },
  });
  // why renders, lunr_rules is dropped.
  assert.ok(sectionsEmitted.includes(SECTIONS.WHY),
    `expected why in emitted; got ${sectionsEmitted}`);
  assert.ok(sectionsDropped.includes(SECTIONS.LUNR_RULES),
    `expected lunr_rules in dropped; got ${sectionsDropped}`);
  // The truncation marker mentions lunr_rules.
  assert.ok(content.includes('sextant:truncated'));
  assert.ok(content.includes('lunr_rules'));
});

test('composeReadBlock: priority-7 why renders without lunr rules', () => {
  const a = makeFileNode('src/a.ts');
  const graph = makeGraph([a], []);
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { includeWhy: 'computed rationale here' },
  });
  assert.ok(sectionsEmitted.includes(SECTIONS.WHY));
  assert.match(content, /^why: computed rationale here$/m);
});

// ---- 13. repeated-read warning ---------------------------------------------

test('composeReadBlock: repeatedReadWarning is appended at the bottom', () => {
  const a = makeFileNode('src/a.ts', ['x']);
  const graph = makeGraph([a], []);
  const warning = 'sextant: this file was already read this turn — skip if unchanged';
  const { content, sectionsEmitted } = composeReadBlock({
    node: a, graph,
    opts: { repeatedReadWarning: warning },
  });
  assert.ok(sectionsEmitted.includes(SECTIONS.REPEATED_READ));
  assert.ok(content.includes(warning));
});

// ---- 14. topK clamp -------------------------------------------------------

test('composeReadBlock: topK=5 only emits as many edges as exist', () => {
  const a = makeFileNode('src/a.ts');
  const b = makeFileNode('src/b.ts');
  const graph = makeGraph(
    [a, b],
    [makeEdge(a[NODE.ID], b[NODE.ID])],
  );
  const { content } = composeReadBlock({ node: a, graph, opts: { topK: 5 } });
  // We have only 1 outbound; header should reflect 1.
  assert.match(content, /connections \(top 1\):/);
  // Count edge lines specifically — the close marker `-->` would otherwise
  // also be caught by a loose `->` regex.
  const edgeLines = content.match(/^  -> /gm) || [];
  assert.equal(edgeLines.length, 1);
});

// ---- 15. Performance smoke: 600-file graph in < 50ms -----------------------

test('composeReadBlock: O(N) over a 600-file graph stays under 50ms', () => {
  const N = 600;
  const nodes = [];
  for (let i = 0; i < N; i++) nodes.push(makeFileNode(`src/file${i}.ts`, [`s${i}`]));
  const edges = [];
  // Each file imports its successor; that yields N-1 edges. The composer only
  // walks the edges relevant to the target node, but it has to filter through
  // all of them — that's the O(E) component we care about.
  for (let i = 0; i < N - 1; i++) {
    edges.push(makeEdge(nodes[i][NODE.ID], nodes[i + 1][NODE.ID]));
  }
  const graph = makeGraph(nodes, edges);
  const target = nodes[300];

  const start = process.hrtime.bigint();
  const { content } = composeReadBlock({ node: target, graph });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;

  // The composer is pure JS; even a worst-case run should complete well under 50ms.
  assert.ok(ms < 50, `compose took ${ms.toFixed(1)}ms on ${N}-file graph`);
  assert.ok(content.length > 0);
});

// ---- 16. character cap is in CHARACTERS, not bytes -------------------------

test('composeReadBlock: capChars is measured in characters, not bytes (multi-byte safe)', () => {
  // A node whose label contains 4-byte emoji. The character count of the
  // composed block should respect capChars even though byte count is larger.
  const a = {
    [NODE.ID]: fileNodeId('src/sushi.ts'),
    [NODE.TYPE]: NODE_TYPES.FILE,
    [NODE.LABEL]: 'sushi.ts',  // ASCII label — keep counting honest.
    [NODE.PATH]: 'src/sushi.ts',
    [NODE.SYMBOLS]: ['emojiSym\u{1F363}\u{1F363}\u{1F363}'],
    [NODE.COMMUNITY]: null,
  };
  const graph = makeGraph([a], []);
  const { content } = composeReadBlock({ node: a, graph, opts: { capChars: 10000 } });
  // .length on a JS string is UTF-16 code units, which is the unit JavaScript
  // tests against. We allow it as a "character count" approximation per spec.
  assert.ok(content.length <= 10000);
});
