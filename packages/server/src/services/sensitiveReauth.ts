/**
 * How a person proves it is them before a sensitive request on their own
 * sign-in: deleting the account (routes/accountDeletion.ts) and starting a
 * data export (routes/dataExports.ts). The ladder, by what the person has:
 *   - two-step verification on (`users.second_factor_required_at`): the second
 *     factor. Account deletion takes the answer inline (withSecondFactorAnswer);
 *     a data export uses step-up (stepUpGate.ts, action `data_export`: passed
 *     on this sign-in within 10 minutes);
 *   - otherwise, a password: a recent sign-in or password re-authentication of
 *     this sign-in (isRecentlyReauthenticated, 10 minutes; POST
 *     /api/auth/second-factor/reauth/password), or `{ password }` in the
 *     request itself (the same check and reauth_attempt_windows counter);
 *   - otherwise (social sign-in only), the emailed code of the request's own
 *     flow (accountDeletion/emailCode.ts): a code sent for one flow never
 *     confirms another.
 * `methods` is what a 403 `reauth_required` lists for the person.
 */
import { eq } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { users } from "../db/schema";
import { claimEmailCode, consumeEmailCode, parseEmailCode, type EmailCodeFlow } from "./accountDeletion/emailCode";
import { availableMethods, reauthenticateWithPassword, type SecondFactorMethodName } from "./secondFactor/management";
import { isRecentlyReauthenticated } from "./secondFactor/reauthentication";

export type SensitiveReauthMethod = "password" | SecondFactorMethodName | "email_code";

export type SensitiveReauth =
  | { kind: "second_factor"; methods: SecondFactorMethodName[] }
  | { kind: "password"; methods: ["password"] }
  | { kind: "email_code"; methods: ["email_code"] };

export async function sensitiveReauthFor(userId: string): Promise<SensitiveReauth> {
  const [user] = await getDb().select({
    secondFactorRequiredAt: users.secondFactorRequiredAt,
    passwordCredentialEstablishedAt: users.passwordCredentialEstablishedAt,
  }).from(users).where(eq(users.id, userId));
  if (user?.secondFactorRequiredAt) return { kind: "second_factor", methods: await availableMethods(userId) };
  if (user?.passwordCredentialEstablishedAt) return { kind: "password", methods: ["password"] };
  return { kind: "email_code", methods: ["email_code"] };
}

export type FirstFactorReauthResult =
  /** Confirmed. `useInTransaction`: the emailed code, used in the request's transaction (false: it ended in between, refuse). */
  | { ok: true; useInTransaction: ((tx: DatabaseExecutor) => Promise<boolean>) | null }
  | { ok: false; reason: "reauth_required"; methods: SensitiveReauthMethod[] }
  | { ok: false; reason: "email_code_invalid" }
  | { ok: false; reason: "second_factor_locked"; lockedUntil: Date };

/**
 * The password and emailed-code rungs, for a person without two-step
 * verification (the caller handles `second_factor` first). A wrong inline
 * password throws SecondFactorError (401 password_incorrect, 429
 * reauth_locked), as POST /api/auth/second-factor/reauth/password does. A code
 * is claimed here (claim-first: an attempt is spent whatever the answer) and
 * used by the caller in its transaction.
 */
export async function firstFactorReauth(input: {
  reauth: Exclude<SensitiveReauth, { kind: "second_factor" }>;
  userId: string;
  familyId: string;
  now: Date;
  password?: unknown;
  emailCode?: unknown;
  flow: EmailCodeFlow;
}): Promise<FirstFactorReauthResult> {
  const { reauth, userId, familyId, now } = input;
  let recent = await isRecentlyReauthenticated(getDb(), familyId, now);
  if (!recent && reauth.kind === "password" && typeof input.password === "string" && input.password) {
    await reauthenticateWithPassword({ userId, familyId, password: input.password, now });
    recent = true;
  }
  if (recent) return { ok: true, useInTransaction: null };
  if (reauth.kind !== "email_code" || input.emailCode === undefined) return { ok: false, reason: "reauth_required", methods: reauth.methods };
  const code = parseEmailCode(input.emailCode);
  if (!code) return { ok: false, reason: "email_code_invalid" };
  const claimed = await claimEmailCode(input.flow, { userId, familyId, code, now });
  if (!claimed.ok) return claimed.reason === "locked" ? { ok: false, reason: "second_factor_locked", lockedUntil: claimed.lockedUntil } : { ok: false, reason: "email_code_invalid" };
  return { ok: true, useInTransaction: (tx) => consumeEmailCode(input.flow, tx, { userId, challengeId: claimed.challengeId, now }) };
}
