// Tests for bin/cerebrum-view.mjs — the cerebrum HTML viewer generator.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  classifyKinds,
  isMandatory,
  collectData,
  buildHtml,
  safeJson,
} from '../bin/cerebrum-view.mjs';

import { CEREBRUM_V2_HEADER } from '../lib/stores/cerebrum.mjs';

async function freshRoot(t) {
  const root = path.join(os.tmpdir(), 'sextant-cv-' + crypto.randomUUID());
  await fs.mkdir(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// Re-extract the embedded JSON blob from a generated HTML document.
function extractData(html) {
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'data blob present');
  const unescaped = m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');
  return JSON.parse(unescaped);
}

test('classifyKinds maps buckets to kinds (multi-kind allowed)', () => {
  assert.deepEqual(classifyKinds(['node:a.mjs', '!']), ['path']);
  assert.deepEqual(classifyKinds(['kw:foo,bar']), ['keyword']);
  assert.deepEqual(classifyKinds(['global', '!']), ['global']);
  assert.deepEqual(classifyKinds(['node:a.mjs', 'kw:x']), ['path', 'keyword']);
  assert.deepEqual(classifyKinds(['!global']), ['global']);
  // provisional / untagged fall to 'other'
  assert.deepEqual(classifyKinds(['provisional']), ['other']);
  assert.deepEqual(classifyKinds([]), ['other']);
});

test('isMandatory detects the [!] and [!global] tokens', () => {
  assert.equal(isMandatory(['node:a', '!']), true);
  assert.equal(isMandatory(['!global']), true);
  assert.equal(isMandatory(['kw:x']), false);
  assert.equal(isMandatory(['provisional']), false);
});

test('safeJson neutralizes </script> and HTML-comment breakouts', () => {
  const out = safeJson({ body: 'evil </script><!-- x -->' });
  assert.ok(!out.includes('</script'), 'no raw closing script tag');
  assert.ok(!out.includes('<!--'), 'no raw comment open');
  assert.ok(out.includes('\\u003c'), 'angle brackets escaped');
});

test('collectData reads rules, bugs, config; missing files yield empty sections', async (t) => {
  const root = await freshRoot(t);
  const cdir = path.join(root, '.sextant', 'cerebrum');
  await fs.writeFile(path.join(cdir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n` +
    '- 2026-06-05: [node:lib/a.mjs] [!] mandatory path rule\n' +
    '- 2026-05-12: [kw:plugins,cache] keyword rule\n' +
    '- 2026-05-15: [global] [!] global rule\n' +
    '- 2026-06-05: [provisional] provisional rule\n', 'utf8');
  await fs.writeFile(path.join(cdir, 'archive.md'),
    '<!-- demoted -->\n- 2026-04-01: [kw:old] archived rule\n', 'utf8');
  await fs.writeFile(path.join(root, '.sextant', 'bugs.json'),
    JSON.stringify([{ id: 'bug-1', ts: '2026-05-30T00:00:00Z', file: 'x.mjs',
      error_message: 'boom', root_cause: 'rc', fix: 'fx', fix_verified: true }]), 'utf8');
  await fs.writeFile(path.join(root, '.sextant', 'config.json'),
    JSON.stringify({ output_mode: 'verbose', capture_nudge: 'on' }), 'utf8');

  const data = await collectData(root);
  assert.equal(data.rules.length, 4);
  assert.equal(data.archived.length, 1);
  assert.equal(data.bugs.length, 1);
  assert.equal(data.config.output_mode, 'verbose');

  const mand = data.rules.find((r) => r.body === 'mandatory path rule');
  assert.deepEqual(mand.kinds, ['path']);
  assert.equal(mand.mandatory, true);
});

test('collectData on an empty project never throws and yields empty sections', async (t) => {
  const root = await freshRoot(t);
  const data = await collectData(root);
  assert.deepEqual(data.rules, []);
  assert.deepEqual(data.archived, []);
  assert.deepEqual(data.bugs, []);
  assert.deepEqual(data.config, {});
});

test('buildHtml embeds parseable data with the rules round-tripping', async (t) => {
  const root = await freshRoot(t);
  const cdir = path.join(root, '.sextant', 'cerebrum');
  await fs.writeFile(path.join(cdir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n- 2026-06-05: [node:lib/a.mjs] [!] alpha rule\n`, 'utf8');
  const data = await collectData(root);
  data.generatedAt = '2026-06-06T00:00:00Z';
  const html = buildHtml(data);

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  const round = extractData(html);
  assert.equal(round.rules.length, 1);
  assert.equal(round.rules[0].body, 'alpha rule');
  assert.equal(round.generatedAt, '2026-06-06T00:00:00Z');
  // four tabs referenced in the script
  assert.ok(html.includes('"rules"') && html.includes('"bugs"') &&
            html.includes('"settings"') && html.includes('"archive"'));
});

test('archived rules carry the forget marker date, not the authored date', async (t) => {
  const root = await freshRoot(t);
  const cdir = path.join(root, '.sextant', 'cerebrum');
  await fs.writeFile(path.join(cdir, 'cerebrum.md'), `${CEREBRUM_V2_HEADER}\n`, 'utf8');
  await fs.writeFile(path.join(cdir, 'archive.md'),
    '<!-- demoted -->\n' +
    '<!-- sextant:archived 2026-06-01 -->\n' +
    '- 2026-04-01: [kw:old] an old rule\n', 'utf8');
  const data = await collectData(root);
  assert.equal(data.archived.length, 1);
  assert.equal(data.archived[0].date, '2026-04-01', 'original authored date preserved');
  assert.equal(data.archived[0].archivedDate, '2026-06-01', 'forget date extracted from marker');
});

test('search re-renders only the list, not the focused input (regression)', async (t) => {
  const root = await freshRoot(t);
  await fs.mkdir(path.join(root, '.sextant', 'cerebrum'), { recursive: true });
  const data = await collectData(root);
  const html = buildHtml(data);
  // The search handler must call draw() (list-only), never the full renderRules,
  // or typing destroys+rebuilds the input and drops focus on every keystroke.
  assert.ok(/search\.oninput\s*=\s*\(\)\s*=>\s*\{[^}]*draw\(\)/.test(html),
    'search.oninput redraws the list via draw()');
  assert.ok(!/search\.oninput[\s\S]{0,80}renderRules\(/.test(html),
    'search.oninput does not re-run renderRules');
});

test('buildHtml is safe when a rule body contains a </script> sequence', async (t) => {
  const root = await freshRoot(t);
  const cdir = path.join(root, '.sextant', 'cerebrum');
  await fs.writeFile(path.join(cdir, 'cerebrum.md'),
    `${CEREBRUM_V2_HEADER}\n- 2026-06-05: [kw:x] body with </script> inside\n`, 'utf8');
  const data = await collectData(root);
  const html = buildHtml(data);
  // The only </script> tokens are the two real closing tags, not the data.
  const closers = html.split('</script>').length - 1;
  assert.equal(closers, 2, 'exactly the two real script closers');
  const round = extractData(html);
  assert.ok(round.rules[0].body.includes('</script>'));
});
