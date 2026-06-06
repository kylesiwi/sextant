// lib/config.mjs — durable, per-project user config for Sextant.
//
// Cold/durable state under .sextant/config.json (git-ignored). Today it holds
// exactly one setting: output_mode — the verbosity of user-facing systemMessage
// status lines. Read by the systemMessage helper (lib/hooks/systemMessage.mjs);
// written by the /sextant:output command (bin/config.mjs). This replaces the
// legacy SEXTANT_VERBOSE environment variable — the mode is now a sticky,
// per-clone preference rather than a per-shell env toggle.

import { durableFile } from './paths.mjs';
import { readJson, writeJsonAtomic } from './io.mjs';

export const OUTPUT_MODES = ['off', 'quiet', 'verbose'];
export const DEFAULT_OUTPUT_MODE = 'quiet';

// capture_nudge: kill switch for the non-tranche capture nudge (lib/hooks/
// captureNudge.mjs). 'on' (default) scans turns for trip-up trigger words and
// nudges the agent (and, on a strong match, the user) to record durable
// lessons; 'off' disables both the scan and the SessionStart steering line.
export const CAPTURE_NUDGE_MODES = ['on', 'off'];
export const DEFAULT_CAPTURE_NUDGE_MODE = 'on';

export function configPath(cwd) {
  return durableFile(cwd, 'config.json');
}

// readConfig: parsed config object, or {} when missing / corrupt / not an
// object. Never throws on a missing or malformed file (readJson returns null).
export async function readConfig(cwd) {
  const obj = await readJson(configPath(cwd));
  return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
}

// readOutputMode: resolve output_mode to a valid mode, defaulting to quiet.
// Never throws — a missing / corrupt / unrecognized value falls back to the
// default so the message layer always has a usable mode.
export async function readOutputMode(cwd) {
  try {
    const cfg = await readConfig(cwd);
    return OUTPUT_MODES.includes(cfg.output_mode) ? cfg.output_mode : DEFAULT_OUTPUT_MODE;
  } catch {
    return DEFAULT_OUTPUT_MODE;
  }
}

// readCaptureNudgeMode: resolve capture_nudge to 'on'|'off', defaulting to 'on'.
// Never throws — a missing / corrupt / unrecognized value falls back to the
// default so the hooks always have a usable mode.
export async function readCaptureNudgeMode(cwd) {
  try {
    const cfg = await readConfig(cwd);
    return CAPTURE_NUDGE_MODES.includes(cfg.capture_nudge)
      ? cfg.capture_nudge : DEFAULT_CAPTURE_NUDGE_MODE;
  } catch {
    return DEFAULT_CAPTURE_NUDGE_MODE;
  }
}

// setOutputMode: persist a validated mode, merging into any existing config.
// Throws on an invalid mode so the CLI can report a usage error.
export async function setOutputMode(cwd, mode) {
  if (!OUTPUT_MODES.includes(mode)) {
    throw new Error(`invalid output mode "${mode}" (expected ${OUTPUT_MODES.join('|')})`);
  }
  const cfg = await readConfig(cwd);
  cfg.output_mode = mode;
  await writeJsonAtomic(configPath(cwd), cfg);
  return cfg;
}

// setCaptureNudgeMode: persist a validated capture_nudge mode ('on'|'off'),
// merging into any existing config. Throws on an invalid mode so the CLI can
// report a usage error. Backs the /sextant:autorules command.
export async function setCaptureNudgeMode(cwd, mode) {
  if (!CAPTURE_NUDGE_MODES.includes(mode)) {
    throw new Error(`invalid autorules mode "${mode}" (expected ${CAPTURE_NUDGE_MODES.join('|')})`);
  }
  const cfg = await readConfig(cwd);
  cfg.capture_nudge = mode;
  await writeJsonAtomic(configPath(cwd), cfg);
  return cfg;
}
