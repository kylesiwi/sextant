// lib/poll.mjs — bounded async polling helper, shared across hooks.
//
// Born from bug-7: the agent's "no captures needed" reply is appended to the
// transcript JSONL as the turn ends, but the write is not always visible to the
// Stop hook the instant it fires — on slow / 9p (WSL2→Windows) mounts the append
// lags by tens of ms. A single read therefore misses a genuine ack and the gate
// re-blocks, looping until the safety valve. The fix — re-read for a small budget
// — is generic: any hook that races a not-yet-flushed file write wants the same
// pattern, so it lives here rather than inlined in stop.mjs.
//
// All durations are milliseconds.

// Defaults tuned for the transcript-flush race: a real ack is seen on the first
// read and returns at once; only the no-ack case pays the full budget.
export const POLL_DEFAULTS = { budgetMs: 250, intervalMs: 25 };

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// pollUntil(fn, opts): await fn() repeatedly until it resolves truthy or the
// budget elapses. Returns fn's last value (the truthy hit, or the final falsy
// result once the budget runs out). fn runs at least once even with budgetMs 0,
// so { budgetMs: 0 } means "single immediate check, no waiting". A throw from
// fn propagates — callers that must stay safe should catch inside fn.
export async function pollUntil(fn, opts = {}) {
  const budgetMs = opts.budgetMs ?? POLL_DEFAULTS.budgetMs;
  const intervalMs = opts.intervalMs ?? POLL_DEFAULTS.intervalMs;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    await sleep(Math.min(intervalMs, remaining));
  }
}
