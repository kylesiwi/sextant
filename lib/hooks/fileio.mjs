// lib/hooks/fileio.mjs — thin re-export shim over lib/io.mjs.
//
// History: this module originally held the writeJsonAtomic / readJson /
// readModifyJson helpers used by hook-owned JSON side files (precompact.json,
// turn-state.json). When Phase 1a's graph builder needed the same atomic
// JSON IO, the helpers were promoted to lib/io.mjs (project-wide) and this
// module became a re-export shim so existing hook code keeps working.
//
// New code SHOULD import directly from `lib/io.mjs`. This shim exists for
// backwards-compatibility with hook handlers that already import from here;
// don't add new exports to this file.

export {
  writeJsonAtomic,
  readJson,
  readModifyJson,
} from '../io.mjs';
