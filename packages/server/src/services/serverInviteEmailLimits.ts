import { RefusalError } from "../lib/refusal";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";

// Daily bounds on server invite emails (POST /api/servers/:id/invites, and the
// invites an owner's Add Seats finishes in seatRequestService.ts): every
// createInvite sends one email, and a revoke deletes the invite, so the
// pending-invite check alone does not bound how often an address is mailed.
// Counted per email sent, per server and per inviter (who may invite to
// several servers), across replicas in Redis (fixedWindowRateLimit.ts).
// The precedent is the external invites' daily cap per host server
// (EXTERNAL_INVITE_DAILY_CAP, externalInviteService.ts).

/** Invite emails one server may send in a window. */
export const SERVER_INVITE_EMAILS_PER_SERVER = 50;
/** Invite emails one person may send in a window, across their servers. */
export const SERVER_INVITE_EMAILS_PER_INVITER = 100;
/** The window: one day. */
export const SERVER_INVITE_EMAIL_WINDOW_SECONDS = 24 * 60 * 60;

export const SERVER_INVITE_RATE_LIMITED_CODE = "server_invite_rate_limited";

const counter = createFixedWindowCounter();
let limitsForTests: { perServer: number; perInviter: number } | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the limits unless a test sets them, as app.ts's limiters do.
function limits(): { perServer: number; perInviter: number } | null {
  if (limitsForTests) return limitsForTests;
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return { perServer: SERVER_INVITE_EMAILS_PER_SERVER, perInviter: SERVER_INVITE_EMAILS_PER_INVITER };
}

/**
 * Spend one invite email of the server's and the inviter's daily budget; past
 * either, throw a 429 refusal (Retry-After: when that window ends). Call once
 * the invite is valid, before it is written and mailed.
 */
export async function enforceServerInviteEmailRate(input: { serverId: string; inviterUserId: string }, nowMs = Date.now()): Promise<void> {
  const current = limits();
  if (!current) return;
  const window = SERVER_INVITE_EMAIL_WINDOW_SECONDS;
  const byServer = await counter.admit(`slock:server-invite-email:server:${input.serverId}`, current.perServer, window, nowMs);
  const admission = byServer.admitted
    ? await counter.admit(`slock:server-invite-email:inviter:${input.inviterUserId}`, current.perInviter, window, nowMs)
    : byServer;
  if (admission.admitted) return;
  throw new RefusalError(429, {
    code: SERVER_INVITE_RATE_LIMITED_CODE,
    error: byServer.admitted
      ? `You can send at most ${current.perInviter} server invites a day: wait, then send the invite again.`
      : `A server can send at most ${current.perServer} invites a day: wait, then send the invite again.`,
    retryAfterSeconds: admission.retryAfterSeconds,
  });
}

/** Tests only: enforce the limits at these values (also in the pglite harness); null restores the defaults. Forgets the counts. */
export function __setServerInviteEmailRateLimitsForTests(next: { perServer: number; perInviter: number } | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Server invite limit hooks are test-only");
  limitsForTests = next;
  counter.clear();
}
