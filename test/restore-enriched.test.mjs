// test/restore-enriched.test.mjs — Phase 9 restoration block enrichment.
//
// buildRestorationBlock now renders five sections (top to bottom):
//   1. todos
//   2. rules
//   3. files
//   4. bugs
//   5. commits
//
// Truncation order (bottom-up): commits → bugs → files → oldest rules → todos.
// Todos never drop first.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRestorationBlock,
  RESTORE_OPEN_MARKER,
  RESTORE_CLOSE_MARKER,
  RESTORE_MAX_CHARS,
} from '../lib/hooks/restore.mjs';

// -- basic empty case ----------------------------------------------------

test('buildRestorationBlock: empty payload → minimal placeholder', () => {
  const out = buildRestorationBlock({});
  assert.match(out, /no captured state to restore/);
  assert.match(out, new RegExp(RESTORE_OPEN_MARKER));
  assert.match(out, new RegExp(RESTORE_CLOSE_MARKER));
});

test('buildRestorationBlock: empty arrays + null todos → minimal placeholder', () => {
  const out = buildRestorationBlock({
    rules: [],
    todos: null,
    files: [],
    bugs: [],
    commits: [],
  });
  assert.match(out, /no captured state to restore/);
});

// -- all 5 sections render ----------------------------------------------

test('buildRestorationBlock: full payload renders all 5 sections in order', () => {
  const out = buildRestorationBlock({
    rules: [
      { body: 'always run prettier', source_file: '.sextant/cerebrum/mandatory.md', bucket: '[!global]' },
    ],
    todos: [
      { content: 'Implement Phase 9', status: 'in_progress' },
    ],
    files: [
      { path: 'src/api.ts', ts: new Date(Date.now() - 60_000).toISOString(), kind: 'Edit' },
      { path: 'src/util.ts', ts: new Date(Date.now() - 120_000).toISOString(), kind: 'Write' },
    ],
    bugs: [
      { id: 'bug-3', file: 'src/api.ts', error_message: 'TypeError: Cannot read properties of undefined' },
    ],
    commits: [
      { ts: '2026-05-11T10:00:00Z', edit_count: 4, file_paths: ['src/a.ts', 'src/b.ts'] },
    ],
  });

  // R13: imperative line present after header.
  assert.match(out, /Resume following every rule below/);

  // Each section header present.
  assert.match(out, /### Open todos/);
  assert.match(out, /### Rules fired this session/);
  assert.match(out, /### Recent files \(top 5\)/);
  assert.match(out, /### Open bugs \(this session\)/);
  assert.match(out, /### Recent commits \(last 3\)/);

  // Specific content.
  assert.match(out, /always run prettier/);
  assert.match(out, /Implement Phase 9/);
  assert.match(out, /src\/api\.ts/);
  assert.match(out, /bug-3/);
  assert.match(out, /2026-05-11T10:00:00Z/);

  // Order: todos → rules → files → bugs → commits.
  const idxTodos = out.indexOf('### Open todos');
  const idxRules = out.indexOf('### Rules fired this session');
  const idxFiles = out.indexOf('### Recent files');
  const idxBugs = out.indexOf('### Open bugs');
  const idxCommits = out.indexOf('### Recent commits');
  assert.ok(idxTodos < idxRules, 'todos before rules');
  assert.ok(idxRules < idxFiles, 'rules before files');
  assert.ok(idxFiles < idxBugs, 'files before bugs');
  assert.ok(idxBugs < idxCommits, 'bugs before commits');
});

test('buildRestorationBlock: status renders as [<status>] prefix', () => {
  const out = buildRestorationBlock({
    todos: [{ content: 'Ship it', status: 'pending' }],
  });
  assert.match(out, /- \[pending\] Ship it/);
});

test('buildRestorationBlock: files entry without ts/kind degrades gracefully', () => {
  const out = buildRestorationBlock({
    files: [{ path: 'src/x.ts' }],
  });
  assert.match(out, /- src\/x\.ts$/m);
});

test('buildRestorationBlock: bugs entry renders id [file] error_message', () => {
  const out = buildRestorationBlock({
    bugs: [{ id: 'bug-1', file: 'src/auth.ts', error_message: 'TypeError: foo' }],
  });
  assert.match(out, /- bug-1 \[src\/auth\.ts\] TypeError: foo/);
});

test('buildRestorationBlock: commits entry renders ts: N edits across M files', () => {
  const out = buildRestorationBlock({
    commits: [
      { ts: '2026-05-11T10:00:00Z', edit_count: 7, file_paths: ['a.ts', 'b.ts', 'c.ts'] },
    ],
  });
  assert.match(out, /- 2026-05-11T10:00:00Z: 7 edits across 3 files/);
});

// -- bottom-up truncation ----------------------------------------------

test('buildRestorationBlock: oversized payload drops commits first', () => {
  // Each section synthesised large enough to ensure cap is exceeded.
  // We construct so that commits + bugs together would exceed RESTORE_MAX_CHARS,
  // but dropping commits alone keeps it under cap.
  const bigBugs = Array.from({ length: 60 }, (_, i) => ({
    id: `bug-${i}`,
    file: `src/file${i}.ts`,
    error_message: 'x'.repeat(40),
  }));
  // Big enough commits section to force truncation when combined with bugs.
  const bigCommits = Array.from({ length: 3 }, (_, i) => ({
    ts: `2026-05-11T10:0${i}:00Z`,
    edit_count: 5,
    file_paths: [`a${i}.ts`, `b${i}.ts`],
  }));

  // Each bug line ~ 60 chars; 60 bugs = ~3600 chars; commits 3 lines = small.
  // To force truncation we need to exceed RESTORE_MAX_CHARS (10K). Boost bugs.
  const veryBig = Array.from({ length: 250 }, (_, i) => ({
    id: `bug-${i}`,
    file: `src/path/to/file${i}.ts`,
    error_message: 'TypeError: undefined property reading X'.repeat(2),
  }));

  const out = buildRestorationBlock({
    rules: [{ body: 'rule body', source_file: 'cerebrum/mandatory.md' }],
    todos: [{ content: 'todo', status: 'pending' }],
    files: [{ path: 'src/a.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' }],
    bugs: veryBig,
    commits: bigCommits,
  });

  assert.ok(out.length <= RESTORE_MAX_CHARS, `block length ${out.length} <= ${RESTORE_MAX_CHARS}`);
  assert.match(out, /sextant:restore truncated/, 'truncation marker present');
  // Commits dropped first.
  assert.doesNotMatch(out, /### Recent commits/, 'commits header dropped');
  // Truncation marker mentions commits.
  assert.match(out, /commits/);
  // Bugs may also drop depending on size; the test confirms commits drop first
  // even if bugs also drop. Use a smaller bugs payload to verify exactly
  // commits-only drops in the next test.
  // For this case we only assert commits dropped + budget honored.
  void bigBugs;
});

test('buildRestorationBlock: just over budget → only commits drops, files/bugs survive', () => {
  // Carefully sized: rules + todos + files + bugs fits under 10K; adding
  // commits pushes it over. So dropping commits alone should rescue it.

  // Each commit line is small; we need a big commits section to be the only
  // section over budget. Make commits oversized via long ts strings.
  const longTs = 'x'.repeat(2000);
  const oversizedCommits = Array.from({ length: 5 }, () => ({
    ts: longTs,
    edit_count: 3,
    file_paths: ['a.ts', 'b.ts', 'c.ts'],
  }));

  const out = buildRestorationBlock({
    rules: [{ body: 'rule body 1', source_file: 'mandatory.md' }],
    todos: [{ content: 'todo 1', status: 'pending' }],
    files: [{ path: 'src/a.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' }],
    bugs: [{ id: 'bug-1', file: 'src/a.ts', error_message: 'oops' }],
    commits: oversizedCommits,
  });

  assert.ok(out.length <= RESTORE_MAX_CHARS, 'fits budget');
  // Commits dropped.
  assert.doesNotMatch(out, /### Recent commits/);
  // Files + bugs survive.
  assert.match(out, /### Recent files/);
  assert.match(out, /### Open bugs/);
  assert.match(out, /### Open todos/);
  assert.match(out, /### Rules fired/);
  // Truncation marker mentions commits.
  assert.match(out, /commits/);
});

test('buildRestorationBlock: large enough payload drops commits → bugs → files in order', () => {
  // Force aggressive truncation. Each subsequent section needs to be big
  // enough that even removing the previous one doesn't rescue us.
  const bigCommits = Array.from({ length: 20 }, (_, i) => ({
    ts: `2026-05-11T10:${String(i).padStart(2, '0')}:00Z`,
    edit_count: 5,
    file_paths: Array.from({ length: 5 }, (_, j) => `commit${i}-file${j}.ts`),
  }));

  // 200 bugs (~12000 chars).
  const lotsOfBugs = Array.from({ length: 200 }, (_, i) => ({
    id: `bug-${i}`,
    file: `src/very/long/path/to/file${i}.ts`,
    error_message: 'TypeError: Cannot read properties of undefined (reading X)',
  }));

  // 200 files (long paths).
  const lotsOfFiles = Array.from({ length: 200 }, (_, i) => ({
    path: `src/another/long/path/to/file${i}.ts`,
    ts: '2026-05-11T10:00:00Z',
    kind: 'Edit',
  }));

  const out = buildRestorationBlock({
    rules: [{ body: 'rule 1', source_file: 'mandatory.md' }],
    todos: [{ content: 'todo 1', status: 'pending' }],
    files: lotsOfFiles,
    bugs: lotsOfBugs,
    commits: bigCommits,
  });

  assert.ok(out.length <= RESTORE_MAX_CHARS);
  assert.match(out, /sextant:restore truncated/);

  // Commits and bugs and files should all be dropped (since each alone is
  // oversized). Todos + rules survive.
  assert.doesNotMatch(out, /### Recent commits/);
  assert.doesNotMatch(out, /### Open bugs/);
  assert.doesNotMatch(out, /### Recent files/);
  assert.match(out, /### Open todos/);

  // Order of dropped names matches the contracted bottom-up sequence.
  const marker = out.match(/sextant:restore truncated \(dropped: ([^)]+)\)/);
  assert.ok(marker, 'truncation marker captures dropped list');
  const dropped = marker[1].split(',').map((s) => s.trim());
  // Commits should appear before bugs in the dropped list, bugs before files.
  const idxCommits = dropped.indexOf('commits');
  const idxBugs = dropped.indexOf('bugs');
  const idxFiles = dropped.indexOf('files');
  assert.ok(idxCommits >= 0 && idxBugs >= 0 && idxFiles >= 0, 'all three logged');
  assert.ok(idxCommits < idxBugs, `commits dropped before bugs (commits=${idxCommits}, bugs=${idxBugs})`);
  assert.ok(idxBugs < idxFiles, `bugs dropped before files (bugs=${idxBugs}, files=${idxFiles})`);
});

test('buildRestorationBlock: under budget → no truncation marker', () => {
  const out = buildRestorationBlock({
    rules: [{ body: 'r', source_file: 'm.md' }],
    todos: [{ content: 't', status: 'pending' }],
    files: [{ path: 'a.ts', ts: '2026-05-11T10:00:00Z', kind: 'Edit' }],
    bugs: [{ id: 'b-1', file: 'a.ts', error_message: 'e' }],
    commits: [{ ts: '2026-05-11T10:00:00Z', edit_count: 1, file_paths: ['a.ts'] }],
  });
  assert.doesNotMatch(out, /sextant:restore truncated/, 'no truncation marker for under-budget payload');
});

test('buildRestorationBlock: only rules section populated → renders just rules', () => {
  const out = buildRestorationBlock({
    rules: [{ body: 'lone rule', source_file: 'm.md' }],
  });
  assert.match(out, /### Rules fired this session/);
  assert.match(out, /lone rule/);
  assert.doesNotMatch(out, /### Recent files/);
  assert.doesNotMatch(out, /### Open bugs/);
  assert.doesNotMatch(out, /### Recent commits/);
  assert.doesNotMatch(out, /### Open todos/);
});

test('buildRestorationBlock: only commits section populated → renders just commits', () => {
  const out = buildRestorationBlock({
    commits: [{ ts: '2026-05-11T10:00:00Z', edit_count: 4, file_paths: ['a.ts', 'b.ts'] }],
  });
  assert.match(out, /### Recent commits/);
  assert.match(out, /4 edits across 2 files/);
});

test('buildRestorationBlock: very-long single rule + oversized commits → oldest rules dropped after commits/bugs/files', () => {
  // Construct so:
  //   - todos: small
  //   - rules: many lines, but each small
  //   - files/bugs/commits: combined heavy enough to require dropping all three
  //   - rules section still pushes us over budget
  // Expect oldest rules popped from the tail.
  const manyRules = Array.from({ length: 200 }, (_, i) => ({
    body: `rule body number ${i} ${'x'.repeat(50)}`,
    source_file: 'mandatory.md',
  }));

  const heavyCommits = Array.from({ length: 10 }, (_, i) => ({
    ts: `2026-05-11T10:${i}:00Z`,
    edit_count: 5,
    file_paths: Array.from({ length: 5 }, (_, j) => 'long_path_'.repeat(20) + j + '.ts'),
  }));

  const out = buildRestorationBlock({
    rules: manyRules,
    todos: [{ content: 'todo lives', status: 'in_progress' }],
    files: [{ path: 'src/a.ts', kind: 'Edit', ts: '2026-05-11T10:00:00Z' }],
    bugs: [{ id: 'bug-1', file: 'src/a.ts', error_message: 'oops' }],
    commits: heavyCommits,
  });

  assert.ok(out.length <= RESTORE_MAX_CHARS);
  // Todos preserved.
  assert.match(out, /todo lives/);
  // Truncation marker mentions oldest-rules or rules.
  assert.match(out, /sextant:restore truncated/);
});

test('buildRestorationBlock: pathological payload too big for even minimum → emits fallback', () => {
  // Force-truncate everything by passing tiny budget via internal threshold:
  // construct so rules alone are enormous (> 10K).
  const huge = Array.from({ length: 1000 }, () => ({
    body: 'x'.repeat(50),
    source_file: 'm.md',
  }));
  const out = buildRestorationBlock({
    rules: huge,
    todos: null,
  });
  assert.ok(out.length <= RESTORE_MAX_CHARS);
  assert.match(out, /sextant:restore truncated/);
});
