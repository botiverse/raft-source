/**
 * Re-authentication marker on a sign-in (`session_families.reauthenticated_at`):
 * a sensitive change (adding a passkey, design §4) asks that the person
 * proved themselves recently, either by signing in or by re-authenticating
 * within the sign-in. Marked by POST /api/auth/second-factor/reauth/password
 * and read by TOTP setup (management.ts). Only a person's own `full`
 * sign-in counts: a device login's session never does, however recent.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { DatabaseExecutor } from "../../db/index";
import { sessionFamilies } from "../../db/schema";

function liveFullFamily(familyId: string) {
  return and(
    eq(sessionFamilies.id, familyId),
    eq(sessionFamilies.scope, "full"),
    isNull(sessionFamilies.revokedAt),
    isNull(sessionFamilies.retiredAt),
  );
}

/** How long a sign-in or re-authentication counts as recent. */
export const REAUTHENTICATION_WINDOW_MS = 10 * 60_000;

/**
 * Record that the person just re-authenticated in this sign-in. False when
 * the family is unknown, revoked, retired or not `full` (nothing is marked).
 */
export async function markSessionReauthenticated(executor: DatabaseExecutor, familyId: string, now: Date): Promise<boolean> {
  const updated = await executor
    .update(sessionFamilies)
    .set({ reauthenticatedAt: now })
    .where(liveFullFamily(familyId))
    .returning({ id: sessionFamilies.id });
  return updated.length === 1;
}

/**
 * Whether the sign-in was made, or re-authenticated, within `windowMs` of
 * `now`. False for an unknown, revoked, retired or device-scope family.
 */
export async function isRecentlyReauthenticated(
  executor: DatabaseExecutor,
  familyId: string,
  now: Date,
  windowMs: number = REAUTHENTICATION_WINDOW_MS,
): Promise<boolean> {
  const [family] = await executor
    .select({ createdAt: sessionFamilies.createdAt, reauthenticatedAt: sessionFamilies.reauthenticatedAt })
    .from(sessionFamilies)
    .where(liveFullFamily(familyId));
  if (!family) return false;
  const since = now.getTime() - windowMs;
  return [family.createdAt, family.reauthenticatedAt].some((at) => at !== null && at.getTime() >= since);
}
