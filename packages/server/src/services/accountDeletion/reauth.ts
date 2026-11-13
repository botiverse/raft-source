/**
 * How a person proves it is them before requesting deletion (design §4):
 *   - two-step verification on (`users.second_factor_required_at`): a step-up
 *     answer in the same request (TOTP, passkey or backup code), checked by
 *     withSecondFactorAnswer with the second step's attempt lock;
 *   - otherwise, a recent sign-in or password re-authentication of this
 *     sign-in (isRecentlyReauthenticated, 10 minutes; POST
 *     /api/auth/second-factor/reauth/password), or, for a person with a
 *     password, `{ password }` in the request itself (the same check and
 *     reauth_attempt_windows counter);
 *   - otherwise, for a person without a password (social sign-in only), the
 *     emailed code (emailCode.ts).
 * `methods` is what a 403 `reauth_required` lists for the person.
 */
import { eq } from "drizzle-orm";

import { getDb } from "../../db/index";
import { users } from "../../db/schema";
import { availableMethods, type SecondFactorMethodName } from "../secondFactor/management";

export type AccountDeletionReauthMethod = "password" | SecondFactorMethodName | "email_code";

export type AccountDeletionReauth =
  | { kind: "second_factor"; methods: SecondFactorMethodName[] }
  | { kind: "password"; methods: ["password"] }
  | { kind: "email_code"; methods: ["email_code"] };

export async function accountDeletionReauthFor(userId: string): Promise<AccountDeletionReauth> {
  const [user] = await getDb().select({
    secondFactorRequiredAt: users.secondFactorRequiredAt,
    passwordCredentialEstablishedAt: users.passwordCredentialEstablishedAt,
  }).from(users).where(eq(users.id, userId));
  if (user?.secondFactorRequiredAt) return { kind: "second_factor", methods: await availableMethods(userId) };
  if (user?.passwordCredentialEstablishedAt) return { kind: "password", methods: ["password"] };
  return { kind: "email_code", methods: ["email_code"] };
}
