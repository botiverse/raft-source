import { RefusalError } from "../lib/refusal";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";

// Bounds on a person creating servers: each one commits a server, its owner
// membership, #all, the onboarding channel, default apps and a hosted Cindy.
// Every path that creates a server for its caller goes through
// createServerAsOwner (serverCreateService.ts): POST /api/servers and an
// external invite's connect-new-server.

/** Servers one person may create in a window. */
export const SERVER_CREATE_PER_USER = 10;
/** The rate window: one hour. */
export const SERVER_CREATE_WINDOW_SECONDS = 60 * 60;

export const SERVER_CREATE_RATE_LIMITED_CODE = "server_create_rate_limited";

const counter = createFixedWindowCounter();
let limitForTests: number | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the rate unless a test sets it, as app.ts's limiters do.
function rateLimit(): number | null {
  if (limitForTests !== null) return limitForTests;
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return SERVER_CREATE_PER_USER;
}

/**
 * Spend one unit of the person's server-create budget; past it, throw a 429
 * refusal (Retry-After: when the window ends). Call once the request is
 * valid, before the server is written.
 */
export async function enforceServerCreateRate(userId: string, nowMs = Date.now()): Promise<void> {
  const limit = rateLimit();
  if (limit === null) return;
  const admission = await counter.admit(`slock:server-create:user:${userId}`, limit, SERVER_CREATE_WINDOW_SECONDS, nowMs);
  if (admission.admitted) return;
  throw new RefusalError(429, {
    code: SERVER_CREATE_RATE_LIMITED_CODE,
    error: `You can create at most ${limit} servers an hour: wait, then create the server again.`,
    retryAfterSeconds: admission.retryAfterSeconds,
  });
}

/** Tests only: enforce the rate at this limit (also in the pglite harness); null restores the default. Forgets the counts. */
export function __setServerCreateRateLimitForTests(limit: number | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Server create limit hooks are test-only");
  limitForTests = limit;
  counter.clear();
}
