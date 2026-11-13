// Platform entry point: whether a person's sign-in still stands, for callers
// that act for a person without their access token in hand (the content
// Worker names a sign-in by user and session family). The same rule
// middleware/auth.ts verifyActiveAccessToken applies to every user token:
// signing out, retiring the account, or scheduling its deletion ends access.
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { accountDeletionRequests, sessionFamilies, users } from "../db/schema";

/**
 * The user exists and isn't retired, and `sessionFamilyId` (when given; null
 * for a legacy token without one) is a session family of that user that
 * isn't revoked or retired.
 */
export async function signedIn(userId: string, sessionFamilyId: string | null): Promise<boolean> {
  const db = getDb();
  const [user] = await db.select({ retiredAt: users.retiredAt, deletionScheduledFor: accountDeletionRequests.scheduledFor }).from(users)
    .leftJoin(accountDeletionRequests, and(eq(accountDeletionRequests.userId, users.id), eq(accountDeletionRequests.state, "pending")))
    .where(eq(users.id, userId)).limit(1);
  if (!user || user.retiredAt || user.deletionScheduledFor) return false;
  if (sessionFamilyId === null) return true;
  const [family] = await db.select({ revokedAt: sessionFamilies.revokedAt, retiredAt: sessionFamilies.retiredAt }).from(sessionFamilies)
    .where(and(eq(sessionFamilies.id, sessionFamilyId), eq(sessionFamilies.userId, userId)))
    .limit(1);
  return !!family && !family.revokedAt && !family.retiredAt;
}
