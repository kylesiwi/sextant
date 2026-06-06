// lib/hooks/notification.mjs — Notification handler.
//
// Phase 0: log only. Notification events are user-action prompts (e.g.,
// "Claude needs your permission to ..."); we don't drive any state from
// them yet.

export default async function notification(payload, ctx) {
  const sid = payload.session_id;
  await ctx.log({ ts: ctx.nowIso(), event: 'Notification', sid });
  return undefined;
}
