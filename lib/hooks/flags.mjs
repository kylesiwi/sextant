// lib/hooks/flags.mjs — Phase 5 sentinel-flag helpers.
//
// Bash flags live in the runtime dir as single-byte files. They're
// strictly boolean (present = true, absent = false); the contents are a
// '1' character so test inspections + tail logs are easier to read.
//
// We do plain fs.writeFile rather than atomic tmp-rename because the
// files are single-byte and the only contract is "present after write".

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * writeFlagFile(absPath, value='1'): ensure the parent dir exists and
 * write the flag. Idempotent — calling twice is fine.
 */
export async function writeFlagFile(absPath, value = '1') {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, value, 'utf8');
}

/**
 * flagExists(absPath): true iff the file exists. Never throws.
 */
export async function flagExists(absPath) {
  try {
    await fs.access(absPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * rmFlag(absPath): delete the flag, ignoring ENOENT. Re-throws anything
 * else.
 */
export async function rmFlag(absPath) {
  try {
    await fs.unlink(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
