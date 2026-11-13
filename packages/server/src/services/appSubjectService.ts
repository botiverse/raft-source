import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { UUID_RE } from "../lib/messageId";

/**
 * The `sub` an App received for a person at Sign in with Raft (the id_token
 * and `/api/oauth/userinfo` claim), as the App hands it back to Raft. Opaque
 * to the App; minted only by {@link parseAppSubject}.
 */
export type AppSubject = string & { readonly __appSubject: unique symbol };

/**
 * Accept a string as an App subject. A Raft-issued `sub` is a UUID; anything
 * else names no one (and must never reach a uuid column, where it would be a
 * query error instead of a miss).
 */
export function parseAppSubject(raw: string): AppSubject | null {
  return UUID_RE.test(raw) ? raw as AppSubject : null;
}

/**
 * The Raft user an App means by `sub`: THE one place an App subject becomes a
 * user id. Null when the subject names no one.
 *
 * Today the mapping is the identity: Sign in with Raft gives every App the
 * person's `users.id` as `sub` (routes/oauth.ts, id_token `sub` and userinfo
 * `sub: token.humanId`, where `humanId` is `users.id` joined through
 * `oauth_access_tokens.user_id`). `clientId` (`oauth_clients.id` of the App
 * asking) is not consulted yet; it is in the signature so that adopting
 * per-App subjects changes this function and the issuing side only, never a
 * caller. Callers check membership, role and lifecycle themselves on the user
 * id returned here, and never compare `users.id` with a subject directly.
 */
export async function resolveAppSubjectToUserId(input: { clientId: string; sub: AppSubject }): Promise<string | null> {
  const [user] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.sub))
    .limit(1);
  return user?.id ?? null;
}
