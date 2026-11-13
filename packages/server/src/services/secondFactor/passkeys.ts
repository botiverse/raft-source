/**
 * Passkeys as a second factor (design v8 §1, §5; rollout PR 4a): a person's
 * stored WebAuthn credentials (`webauthn_credentials`) and the assertion
 * ceremony that answers a second step with one. Library calls are in
 * webauthn.ts; registration and the management routes in passkeyManagement.ts.
 *
 * An assertion answers exactly one thing: its challenge
 * (`auth_challenges` kind `webauthn_assertion`, 5 minutes, single use) is
 * bound when it is created to either the person's current sign-in
 * (`{ familyId }`: step-up, turning two-step verification on or off, removing
 * a passkey) or one second-factor sign-in challenge (`{ signInChallengeId }`:
 * POST /verify). checkPasskeyAssertion consumes it first (a failed check
 * still uses it up: ask for new options), then verifies; the caller records
 * the use with recordPasskeyUse in the same transaction as what it allows.
 *
 * Sign counter (design §5, T1): a counter that stays 0 is fine (synced
 * passkeys). A non-zero counter that does not go up is a risk signal, not a
 * refusal: the answer is accepted, an audit event is written in the same
 * transaction, and the person is emailed after it commits. The stored counter
 * never goes down.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { users, webauthnCredentials, type AuthChallengePayload } from "../../db/schema";
import { sendSecondFactorChangeEmail } from "../emailService";
import { recordIntegrationAuditEvent } from "../integrationAuditService";
import { consumeAuthChallenge, createAuthChallenge, parseAuthChallengeToken } from "./authChallenges";
import {
  assertionCredentialId,
  ceremonyChallenge,
  passkeyAssertionOptions,
  verifyPasskeyAssertion,
  type PasskeyAssertionResponse,
  type RelyingParty,
  type StoredPasskey,
} from "./webauthn";

export const PASSKEY_CEREMONY_TTL_MS = 5 * 60_000;

type ActivePasskey = StoredPasskey & { id: string; signCount: number };

const activeColumns = {
  id: webauthnCredentials.id,
  credentialId: webauthnCredentials.credentialId,
  publicKey: webauthnCredentials.publicKey,
  transports: webauthnCredentials.transports,
  signCount: webauthnCredentials.signCount,
};

const active = (userId: string) => and(eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt));

/** The person's passkeys that are not removed. */
export async function activePasskeys(executor: DatabaseExecutor, userId: string): Promise<ActivePasskey[]> {
  return executor.select(activeColumns).from(webauthnCredentials).where(active(userId));
}

/**
 * The passkey (not removed) with this credential id, whoever's it is: how
 * passkey sign-in finds the account (passkeySignIn.ts). Never by user handle.
 */
export async function findActivePasskeyByCredentialId(
  executor: DatabaseExecutor,
  credentialId: Buffer,
): Promise<(ActivePasskey & { userId: string }) | null> {
  const [row] = await executor.select({ ...activeColumns, userId: webauthnCredentials.userId }).from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.credentialId, credentialId), isNull(webauthnCredentials.revokedAt)));
  return row ?? null;
}

export async function countActivePasskeys(executor: DatabaseExecutor, userId: string): Promise<number> {
  const [row] = await executor.select({ n: sql<number>`count(*)::int` }).from(webauthnCredentials).where(active(userId));
  return row?.n ?? 0;
}

/** What an assertion challenge answers (see the file comment). */
export type PasskeyAssertionBinding = { familyId: string } | { signInChallengeId: string };

function bindingPayload(binding: PasskeyAssertionBinding): AuthChallengePayload {
  return "familyId" in binding ? { familyId: binding.familyId } : { signInChallengeId: binding.signInChallengeId };
}

/**
 * New assertion options for `userId`, bound to `binding`: allowCredentials
 * are the person's passkeys, user verification required. Null when the
 * person has none.
 */
export async function startPasskeyAssertion(
  rp: RelyingParty,
  input: { userId: string; binding: PasskeyAssertionBinding; now: Date },
): Promise<{ options: Awaited<ReturnType<typeof passkeyAssertionOptions>> } | null> {
  const allow = await activePasskeys(getDb(), input.userId);
  if (allow.length === 0) return null;
  const created = await createAuthChallenge({
    kind: "webauthn_assertion",
    userId: input.userId,
    payload: bindingPayload(input.binding),
    ttlMs: PASSKEY_CEREMONY_TTL_MS,
    now: input.now,
  });
  return { options: await passkeyAssertionOptions(rp, { challenge: created.challenge, allow }) };
}

export type CheckedPasskeyAssertion = { passkeyId: string; storedCounter: number; counter: number; backupState: boolean };

/**
 * Check an assertion for `userId` answering `binding`: its challenge is
 * consumed (single use, whatever the outcome), then the signature is
 * verified with the named passkey, which must be the person's and not
 * removed. Null when any of it fails.
 */
export async function checkPasskeyAssertion(
  rp: RelyingParty,
  input: { userId: string; binding: PasskeyAssertionBinding; response: PasskeyAssertionResponse; now: Date },
): Promise<CheckedPasskeyAssertion | null> {
  const challenge = parseAuthChallengeToken(ceremonyChallenge(input.response));
  if (!challenge) return null;
  const consumed = await consumeAuthChallenge(getDb(), challenge, "webauthn_assertion", input.now);
  const expected = bindingPayload(input.binding);
  if (!consumed || consumed.userId !== input.userId) return null;
  const payload = consumed.payload ?? {};
  if (Object.keys(expected).length !== Object.keys(payload).length || Object.entries(expected).some(([key, value]) => payload[key] !== value)) return null;

  const [passkey] = await getDb().select(activeColumns).from(webauthnCredentials)
    .where(and(active(input.userId), eq(webauthnCredentials.credentialId, assertionCredentialId(input.response))));
  if (!passkey) return null;
  const verified = await verifyPasskeyAssertion(rp, input.response, challenge, passkey);
  if (!verified) return null;
  return { passkeyId: passkey.id, storedCounter: passkey.signCount, counter: verified.counter, backupState: verified.backupState };
}

/** design §5: a counter that is in use (non-zero on either side) and did not go up. */
export function isCounterRegression(checked: Pick<CheckedPasskeyAssertion, "storedCounter" | "counter">): boolean {
  return (checked.storedCounter > 0 || checked.counter > 0) && checked.counter <= checked.storedCounter;
}

/**
 * Record a checked assertion inside the transaction that acts on it: last
 * used, counter (never down) and backup state, and on a counter regression
 * the audit event. False when the passkey was removed in between (refuse).
 * After commit, call sendPasskeyCounterWarning when `counterRegressed`.
 */
export async function recordPasskeyUse(
  tx: DatabaseExecutor,
  input: { userId: string; checked: CheckedPasskeyAssertion; now: Date; sessionFamilyId: string | null; context: "sign_in" | "passkey_sign_in" | "step_up" },
): Promise<{ recorded: boolean; counterRegressed: boolean }> {
  const { checked } = input;
  const counterRegressed = isCounterRegression(checked);
  const updated = await tx.update(webauthnCredentials)
    .set({
      lastUsedAt: input.now,
      signCount: sql`GREATEST(${webauthnCredentials.signCount}, ${checked.counter})`,
      backupState: checked.backupState,
    })
    .where(and(eq(webauthnCredentials.id, checked.passkeyId), active(input.userId)))
    .returning({ id: webauthnCredentials.id });
  if (updated.length !== 1) return { recorded: false, counterRegressed: false };
  if (counterRegressed) {
    await recordIntegrationAuditEvent({
      serverId: null,
      eventType: "account.second_factor_passkey_counter_regressed",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: input.userId },
      subject: { type: "human", id: input.userId },
      target: { type: "user", id: input.userId },
      metadata: {
        passkeyId: checked.passkeyId,
        storedCounter: checked.storedCounter,
        receivedCounter: checked.counter,
        context: input.context,
        sessionFamilyId: input.sessionFamilyId,
      },
    }, tx);
  }
  return { recorded: true, counterRegressed };
}

/** Best effort after commit: tell the person a passkey's counter went backwards. */
export async function sendPasskeyCounterWarning(userId: string): Promise<void> {
  try {
    const [user] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, userId));
    if (user?.email) await sendSecondFactorChangeEmail(user.email, user.displayName || user.name, "passkey_counter_regressed");
  } catch (err) {
    console.error(`[second-factor] passkey counter warning email to ${userId} failed:`, err);
  }
}
