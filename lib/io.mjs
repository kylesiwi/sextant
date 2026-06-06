// lib/io.mjs — project-wide atomic-write helpers for JSON files.
//
// Single source of truth for tmp-write + rename JSON IO. Started life as
// lib/hooks/fileio.mjs (hook-owned side files); promoted here when the graph
// builder needed the same pattern. lib/hooks/fileio.mjs now re-exports from
// this module so existing hook code keeps working without changes.
//
// Atomicity contract:
//   - writeJsonAtomic writes to a tmp file alongside the target, then renames.
//     On a POSIX-compatible filesystem rename is atomic, so readers never see
//     a partially written file.
//   - On rename failure the tmp file is cleaned up so we don't leave debris.
//
// All paths must be absolute (callers' responsibility). The parent directory
// is created with mkdir -p as a convenience.

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fs.rename(tmp, filePath);
  } catch (err) {
    // Clean up tmp on failure so we don't leave debris that confuses later
    // readers / fs walkers.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// readModifyJson(filePath, mutator):
//   Read JSON from filePath if it exists (else start with empty object),
//   call await mutator(obj), write the result atomically.
//   Single-writer per file is assumed; no lock. Use this for runtime files
//   that only one hook event mutates per turn (e.g., turn-state.json).
//
// Atomicity: writes go through writeJsonAtomic (tmp + rename). A mutator
// that throws aborts before the rename, so the on-disk file is unchanged.
export async function readModifyJson(filePath, mutator) {
  let obj;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') obj = {};
    else if (err instanceof SyntaxError) obj = {};
    else throw err;
  }
  await mutator(obj);
  await writeJsonAtomic(filePath, obj);
}
