import { RefusalError } from "../lib/refusal";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";

// RFC 084 §5: a rename reserves its old id for good, so an App can't do it
// without limit. Spent only by a rename that goes through.

/** Renames one App may do in a window. */
export const OAUTH_CLIENT_KEY_RENAMES_PER_APP_PER_DAY = 5;
/** The window: one day from the App's first rename in it. */
export const OAUTH_CLIENT_KEY_RENAME_WINDOW_SECONDS = 24 * 60 * 60;

export const OAUTH_CLIENT_KEY_RENAME_RATE_LIMITED_CODE = "CLIENT_KEY_RENAME_RATE_LIMITED";

const counter = createFixedWindowCounter();
let limitForTests: number | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the budget unless a test sets it, as oauthClientRegistrationLimits.ts does.
function dailyLimit(): number | null {
  if (limitForTests !== null) return limitForTests;
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return OAUTH_CLIENT_KEY_RENAMES_PER_APP_PER_DAY;
}

/** Spends one unit of the App's daily renames; past it, throws a 429 refusal. */
export async function enforceOAuthClientKeyRenameRate(appId: string, nowMs = Date.now()): Promise<void> {
  const limit = dailyLimit();
  if (limit === null) return;
  const admission = await counter.admit(`slock:oauth-client-key-rename:app:${appId}`, limit, OAUTH_CLIENT_KEY_RENAME_WINDOW_SECONDS, nowMs);
  if (admission.admitted) return;
  throw new RefusalError(429, {
    code: OAUTH_CLIENT_KEY_RENAME_RATE_LIMITED_CODE,
    error: `This App has changed its client ID ${limit} times in a day, the most it can; wait before changing it again.`,
    retryAfterSeconds: admission.retryAfterSeconds,
  });
}

/** Tests only: a limit for this process (null: back to the default), with a fresh count. */
export function __setOAuthClientKeyRenameLimitForTests(limit: number | null): void {
  limitForTests = limit;
  counter.clear();
}
