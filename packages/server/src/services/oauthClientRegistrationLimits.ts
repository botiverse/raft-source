import { RefusalError } from "../lib/refusal";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";

// RFC 084 §5: new Apps per Server per day, so creating and using Apps can't
// reserve keys without limit. Spent where a person registers one (the web route,
// the register card's execute). Deleting an App gives no unit back.

/** New Apps one Server may register in a window. */
export const OAUTH_APP_REGISTRATIONS_PER_SERVER_PER_DAY = 30;
/** The window: one day from the Server's first registration in it. */
export const OAUTH_APP_REGISTRATION_WINDOW_SECONDS = 24 * 60 * 60;

export const OAUTH_APP_REGISTRATION_RATE_LIMITED_CODE = "oauth_app_registration_rate_limited";

const counter = createFixedWindowCounter();
let limitForTests: number | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the budget unless a test sets it, as agentCredentialMintLimits.ts does.
function dailyLimit(): number | null {
  if (limitForTests !== null) return limitForTests;
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return OAUTH_APP_REGISTRATIONS_PER_SERVER_PER_DAY;
}

/** Spends one unit of the Server's daily registration budget; past it, throws a 429 refusal. */
export async function enforceOAuthAppRegistrationRate(serverId: string, nowMs = Date.now()): Promise<void> {
  const limit = dailyLimit();
  if (limit === null) return;
  const admission = await counter.admit(`slock:oauth-app-registration:server:${serverId}`, limit, OAUTH_APP_REGISTRATION_WINDOW_SECONDS, nowMs);
  if (admission.admitted) return;
  throw new RefusalError(429, {
    code: OAUTH_APP_REGISTRATION_RATE_LIMITED_CODE,
    error: `This Server has reached its limit of ${limit} new Apps in a day; wait before registering another.`,
    retryAfterSeconds: admission.retryAfterSeconds,
  });
}

/** Tests only: a limit for this process (null: back to the default), with a fresh count. */
export function __setOAuthAppRegistrationLimitForTests(limit: number | null): void {
  limitForTests = limit;
  counter.clear();
}
