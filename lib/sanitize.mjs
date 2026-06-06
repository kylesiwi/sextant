// lib/sanitize.mjs — neutralize untrusted text before it reaches an interpreted
// stream (the user's terminal, or the agent's injected context).
//
// Threat: content sourced from a project's `.sextant/` (cerebrum rules, bug
// entries, tranches.json) is attacker-controlled the moment a user opens a
// cloned third-party repo. Sextant's CODE is trusted (it runs from the user-scope
// plugin cache, never the project), but the DATA it reads is not — so every value
// that crosses into a terminal/context string must be stripped here first.

// Match C0 (U+0000–U+001F) and C1 (U+007F–U+009F) control characters. These
// include ESC (U+001B), which begins every ANSI/OSC terminal escape sequence —
// color, cursor moves, OSC 52 (clipboard write), OSC 8 (hyperlink), screen
// manipulation.
//
// Built from a double-escaped string (source stays pure ASCII) rather than a
// regex literal: embedding raw control bytes in this file would be fragile — any
// editor/tool that re-saves it could mangle them, silently breaking the one
// defense that is supposed to be bulletproof.
const CONTROL_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

// stripControlBytes: drop every control character. A legitimate human-readable
// value never contains a raw control byte, so removal is lossless for real data
// and disarms terminal injection.
//
// Order of use: strip the UNTRUSTED value here, THEN let trusted sextant code
// wrap it in its own (intended) color codes. Never strip after wrapping — that
// would erase sextant's own styling.
export function stripControlBytes(value) {
  return String(value).replace(CONTROL_RE, '');
}

// cleanField: strip control bytes and cap length. The cap bounds a hostile value
// that is byte-clean but enormous (used to flood/garble a statusline or message).
// Pass the max length the sink can reasonably show.
export function cleanField(value, maxLen = 256) {
  const s = stripControlBytes(value);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}
