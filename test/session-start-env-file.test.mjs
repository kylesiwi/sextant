// test/session-start-env-file.test.mjs — coverage for writeSessionEnvFile.
//
// The helper is the durable fix for CLAUDE_PLUGIN_ROOT not being injected
// into Bash-tool subprocesses (issue #27145). It writes a single shell
// `export SEXTANT_ROOT=...` line into CLAUDE_ENV_FILE, which Claude Code
// sources before each subsequent Bash-tool invocation in the session.
//
// Contract these tests pin:
//   - happy path produces exactly the expected single-quoted line
//   - existing env-file content is preserved (append, never overwrite)
//   - embedded single quotes in pluginRoot are escaped as '\''
//   - caller is responsible for the unset-envFile check; given a valid
//     path the helper resolves without error

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { writeSessionEnvFile } from '../lib/hooks/sessionStart.mjs';

function freshEnvFile() {
  return path.join(os.tmpdir(), 'sextant-envfile-test-' + crypto.randomUUID());
}

test('writeSessionEnvFile: writes exactly one quoted export line', async (t) => {
  const envFile = freshEnvFile();
  t.after(() => fs.rm(envFile, { force: true }));

  const pluginRoot = '/home/user/.claude/plugins/cache/kylesiwi/sextant';
  await writeSessionEnvFile({ envFile, pluginRoot });

  const written = await fs.readFile(envFile, 'utf8');
  assert.equal(written, `export SEXTANT_ROOT='${pluginRoot}'\n`);
});

test('writeSessionEnvFile: appends to existing env-file content', async (t) => {
  const envFile = freshEnvFile();
  t.after(() => fs.rm(envFile, { force: true }));

  const prior = `export FOO=bar\n`;
  await fs.writeFile(envFile, prior, 'utf8');

  const pluginRoot = '/opt/sextant';
  await writeSessionEnvFile({ envFile, pluginRoot });

  const written = await fs.readFile(envFile, 'utf8');
  assert.equal(written, `${prior}export SEXTANT_ROOT='${pluginRoot}'\n`);
});

test("writeSessionEnvFile: escapes embedded single quotes as '\\''", async (t) => {
  const envFile = freshEnvFile();
  t.after(() => fs.rm(envFile, { force: true }));

  const pluginRoot = `/tmp/has'quote/sextant`;
  await writeSessionEnvFile({ envFile, pluginRoot });

  const written = await fs.readFile(envFile, 'utf8');
  // The embedded `'` must be closed, escaped, and reopened: '\''
  assert.equal(written, `export SEXTANT_ROOT='/tmp/has'\\''quote/sextant'\n`);
});

test('writeSessionEnvFile: valid path resolves without error', async (t) => {
  // Caller (sessionStart) is responsible for the unset-envFile check; the
  // helper itself just delegates to fs.appendFile. Pin that contract.
  const envFile = freshEnvFile();
  t.after(() => fs.rm(envFile, { force: true }));

  await assert.doesNotReject(
    writeSessionEnvFile({ envFile, pluginRoot: '/plain/path' })
  );
});
