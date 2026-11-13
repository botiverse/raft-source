/**
 * A person managing their own passkeys (design v8 §1, §5; rollout PR 4a):
 * register one as a second factor, list, rename and remove them, and get
 * assertion options to answer step-up with one. Served by
 * routes/secondFactor.ts; passkey-only sign-in
 * is passkeySignIn.ts. Registration options carry the person's stored user
 * handle (webauthnUserHandleFor).
 *
 * Proof of identity (design A6, A7):
 *   - Adding a passkey: with two-step verification on, step-up inline at
 *     POST /passkeys/registration/options (a current code, a backup code or
 *     a passkey assertion bound to this sign-in);
 *     off, a recent sign-in or password re-authentication on this sign-in
 *     (reauthentication.ts). The registration challenge it starts is bound to
 *     this sign-in, single use, 5 minutes.
 *   - Removing one: with it on, step-up inline (code, backup code or a
 *     passkey), and never the last passkey while there is no authenticator
 *     app (409 `last_factor`: turn two-step verification off instead).
 * Removing one (two-step verification on or off: a passkey signs in by
 * itself) signs out the person's other own sign-ins in the same transaction
 * and keeps this one (management.ts, "Other sign-ins"); adding one signs
 * nobody out.
 * Every addition and removal is audited and emailed.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { users, userTotp, webauthnCredentials } from "../../db/schema";
import { revokeOtherWebSessionFamiliesInTransaction, SECOND_FACTOR_CHANGED_REVOKED_REASON } from "../sessionService";
import { consumeAuthChallenge, createAuthChallenge, parseAuthChallengeToken } from "./authChallenges";
import {
  audit,
  availableMethods,
  evictSignedOutSessions,
  lockLiveSetupSession,
  lockUser,
  notify,
  SecondFactorError,
  withSecondFactorAnswer,
  type StepUpAnswer,
} from "./management";
import { activePasskeys, countActivePasskeys, PASSKEY_CEREMONY_TTL_MS, startPasskeyAssertion } from "./passkeys";
import { isRecentlyReauthenticated } from "./reauthentication";
import {
  ceremonyChallenge,
  defaultPasskeyName,
  legacyWebauthnUserHandle,
  newWebauthnUserHandle,
  passkeyRegistrationOptions,
  verifyPasskeyRegistration,
  webauthnRelyingParty,
  type PasskeyRegistrationResponse,
  type RelyingParty,
} from "./webauthn";

export const PASSKEY_NAME_MAX_LENGTH = 64;

export type PasskeySummary = { id: string; name: string; createdAt: string; lastUsedAt: string | null; synced: boolean };

const summaryColumns = {
  id: webauthnCredentials.id,
  name: webauthnCredentials.name,
  createdAt: webauthnCredentials.createdAt,
  lastUsedAt: webauthnCredentials.lastUsedAt,
  backupState: webauthnCredentials.backupState,
};

function toSummary(row: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null; backupState: boolean }): PasskeySummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    synced: row.backupState,
  };
}

function relyingParty(): RelyingParty {
  const rp = webauthnRelyingParty();
  if (!rp) throw new SecondFactorError("passkeys_unavailable", "Passkeys are not available right now.");
  return rp;
}

/** A passkey name from a request: trimmed, 1..64 characters; undefined when absent, null when invalid. */
export function parsePasskeyName(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length > 0 && name.length <= PASSKEY_NAME_MAX_LENGTH ? name : null;
}

const passkeyNotFound = () => new SecondFactorError("passkey_not_found", "That passkey was not found.");

/**
 * The person's WebAuthn user handle (`users.webauthn_user_handle`), written
 * the first time they start registering a passkey and never changed after:
 * 32 random bytes, or, for someone who registered passkeys before the column
 * existed (staging only), the HMAC handle those passkeys carry
 * (legacyWebauthnUserHandle), so their authenticators keep one account
 * rather than starting a second one. Removed passkeys count: they may still
 * be on an authenticator. Of two concurrent first writes one wins and both
 * read it back. Stored, so rotating JWT_SECRET changes nobody's handle (a
 * backfill after a rotation would derive under the new secret: staging only,
 * and only for someone who has not registered since this shipped).
 */
async function webauthnUserHandleFor(userId: string): Promise<Buffer> {
  const read = async () => (await getDb().select({ handle: users.webauthnUserHandle }).from(users).where(eq(users.id, userId)))[0]?.handle;
  const stored = await read();
  if (stored) return Buffer.from(stored);
  const [registered] = await getDb().select({ id: webauthnCredentials.id }).from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId)).limit(1);
  await getDb().update(users)
    .set({ webauthnUserHandle: registered ? legacyWebauthnUserHandle(userId) : newWebauthnUserHandle() })
    .where(and(eq(users.id, userId), isNull(users.webauthnUserHandle)));
  const written = await read();
  if (!written) throw new Error(`webauthnUserHandleFor: no handle stored for ${userId}`);
  return Buffer.from(written);
}

/** POST /passkeys/registration/options (proof of identity in the file comment). */
export async function startPasskeyRegistration(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }) {
  const now = input.now ?? currentDate();
  const { userId, familyId } = input;
  const rp = relyingParty();
  const [user] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName, requiredAt: users.secondFactorRequiredAt })
    .from(users).where(eq(users.id, userId));
  if (!user) throw new SecondFactorError("session_family_required", "Sign in again to continue.");

  if (user.requiredAt) {
    if (!input.answer.code && !input.answer.backupCode && !input.answer.webauthn) {
      throw new SecondFactorError("step_up_required", "Confirm it's you to add a passkey.", { methods: await availableMethods(userId) });
    }
    // A passkey answers too (bound to this sign-in, like every step-up), so
    // someone with only passkeys does not spend a backup code on this.
    await withSecondFactorAnswer(userId, input.answer, now, { allowBackupCode: true, passkey: { familyId } }, async () => undefined);
  } else if (!(await isRecentlyReauthenticated(getDb(), familyId, now))) {
    throw new SecondFactorError("reauth_required", "Confirm your password to add a passkey.");
  }

  const created = await createAuthChallenge({ kind: "webauthn_registration", userId, payload: { familyId }, ttlMs: PASSKEY_CEREMONY_TTL_MS, now });
  const options = await passkeyRegistrationOptions(rp, {
    challenge: created.challenge,
    userHandle: await webauthnUserHandleFor(userId),
    userName: user.email,
    displayName: user.displayName || user.name,
    exclude: await activePasskeys(getDb(), userId),
  });
  return { options, expiresAt: created.expiresAt.toISOString() };
}

function isUniqueViolation(err: unknown): boolean {
  for (let cause = err; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * POST /passkeys/registration/verify: the browser's registration answers the
 * challenge registration/options started for this sign-in (single use,
 * consumed whatever the outcome); origin, RP ID and user verification are
 * checked, then the passkey is stored, audited and emailed. Adding a
 * passkey does not turn two-step verification on (POST /enable does).
 */
export async function finishPasskeyRegistration(input: {
  userId: string;
  familyId: string;
  challenge: string | undefined;
  response: PasskeyRegistrationResponse;
  name: string | undefined;
  now?: Date;
}): Promise<{ passkey: PasskeySummary }> {
  const now = input.now ?? currentDate();
  const { userId, familyId } = input;
  const rp = relyingParty();
  const token = parseAuthChallengeToken(ceremonyChallenge(input.response));
  const expired = () => new SecondFactorError("challenge_expired", "This passkey setup has expired. Start again.");
  if (!token || (input.challenge !== undefined && input.challenge !== token)) throw expired();
  const consumed = await consumeAuthChallenge(getDb(), token, "webauthn_registration", now);
  if (!consumed || consumed.userId !== userId || consumed.payload?.familyId !== familyId) throw expired();

  const registered = await verifyPasskeyRegistration(rp, input.response, token);
  if (!registered) throw new SecondFactorError("passkey_invalid", "That passkey couldn't be added. Try again.");

  const duplicate = () => new SecondFactorError("passkey_already_registered", "That passkey is already registered.");
  let result: { user: Awaited<ReturnType<typeof lockUser>>; passkey: PasskeySummary };
  try {
    result = await getDb().transaction(async (tx) => {
      const user = await lockUser(tx, userId);
      await lockLiveSetupSession(tx, userId, familyId);
      const [existing] = await tx.select({ id: webauthnCredentials.id }).from(webauthnCredentials)
        .where(eq(webauthnCredentials.credentialId, registered.credentialId));
      if (existing) throw duplicate();
      const [row] = await tx.insert(webauthnCredentials).values({
        userId,
        credentialId: registered.credentialId,
        publicKey: registered.publicKey,
        signCount: registered.signCount,
        aaguid: registered.aaguid,
        backupEligible: registered.backupEligible,
        backupState: registered.backupState,
        transports: registered.transports,
        name: input.name ?? defaultPasskeyName(registered.aaguid),
        createdAt: now,
      }).returning(summaryColumns);
      await audit(tx, userId, "account.second_factor_passkey_added", {
        sessionFamilyId: familyId,
        passkeyId: row!.id,
        aaguid: registered.aaguid,
        synced: registered.backupState,
      });
      return { user, passkey: toSummary(row!) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
  await notify(result.user, userId, "passkey_added");
  return { passkey: result.passkey };
}

/** GET /passkeys: the person's passkeys, oldest first (removed ones are not listed). */
export async function listPasskeys(userId: string): Promise<{ passkeys: PasskeySummary[] }> {
  const rows = await getDb().select(summaryColumns).from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)))
    .orderBy(asc(webauthnCredentials.createdAt), asc(webauthnCredentials.id));
  return { passkeys: rows.map(toSummary) };
}

/** PATCH /passkeys/:id { name }: the person's own label; nothing else changes. */
export async function renamePasskey(input: { userId: string; passkeyId: string; name: string }): Promise<{ passkey: PasskeySummary }> {
  const [row] = await getDb().update(webauthnCredentials).set({ name: input.name })
    .where(and(eq(webauthnCredentials.id, input.passkeyId), eq(webauthnCredentials.userId, input.userId), isNull(webauthnCredentials.revokedAt)))
    .returning(summaryColumns);
  if (!row) throw passkeyNotFound();
  return { passkey: toSummary(row) };
}

/** design A7: with two-step verification on, a passkey can go only if another factor (passkey or authenticator app) stays. */
async function wouldRemoveLastFactor(executor: DatabaseExecutor, userId: string): Promise<boolean> {
  const [totp] = await executor.select({ userId: userTotp.userId }).from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
  return !totp && (await countActivePasskeys(executor, userId)) <= 1;
}

const lastFactor = () => new SecondFactorError("last_factor", "This is your last way to verify it's you. Turn off two-step verification instead.");

/**
 * DELETE /passkeys/:id: marks it removed (`revoked_at`; the row stays for
 * the audit trail). With two-step verification on: step-up inline first, and
 * the last factor stays (checked before anything is claimed, and again under
 * the person's lock). Every other own sign-in of the person is signed out in
 * the same transaction; this one stays.
 */
export async function removePasskey(input: { userId: string; familyId: string; passkeyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ removed: true }> {
  const now = input.now ?? currentDate();
  const { userId, familyId, passkeyId } = input;
  const [current] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  if (!current) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
  const [target] = await getDb().select({ id: webauthnCredentials.id }).from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, passkeyId), eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)));
  if (!target) throw passkeyNotFound();

  const remove = async (tx: DatabaseExecutor, user: Awaited<ReturnType<typeof lockUser>>, method: string | null) => {
    await lockLiveSetupSession(tx, userId, familyId);
    if (user.requiredAt && await wouldRemoveLastFactor(tx, userId)) throw lastFactor();
    const removed = await tx.update(webauthnCredentials).set({ revokedAt: now })
      .where(and(eq(webauthnCredentials.id, passkeyId), eq(webauthnCredentials.userId, userId), isNull(webauthnCredentials.revokedAt)))
      .returning({ id: webauthnCredentials.id });
    if (removed.length !== 1) throw passkeyNotFound();
    const signedOut = await revokeOtherWebSessionFamiliesInTransaction(tx, userId, familyId, now, SECOND_FACTOR_CHANGED_REVOKED_REASON);
    await audit(tx, userId, "account.second_factor_passkey_removed", { sessionFamilyId: familyId, passkeyId, method, signedOutSessionCount: signedOut.length });
    return { user, signedOut };
  };

  let removedResult: Awaited<ReturnType<typeof remove>>;
  if (current.requiredAt) {
    if (await wouldRemoveLastFactor(getDb(), userId)) throw lastFactor();
    if (!input.answer.code && !input.answer.backupCode && !input.answer.webauthn) {
      throw new SecondFactorError("step_up_required", "Confirm it's you to remove this passkey.", { methods: await availableMethods(userId) });
    }
    removedResult = await withSecondFactorAnswer(userId, input.answer, now, { allowBackupCode: true, passkey: { familyId } }, (tx, ctx) => remove(tx, ctx.user, ctx.method));
  } else {
    removedResult = await getDb().transaction(async (tx) => {
      const locked = await lockUser(tx, userId);
      // Turned on in between: this now needs step-up.
      if (locked.requiredAt) throw new SecondFactorError("step_up_required", "Confirm it's you to remove this passkey.", { methods: await availableMethods(userId) });
      return remove(tx, locked, null);
    });
  }
  await evictSignedOutSessions(userId, removedResult.signedOut);
  await notify(removedResult.user, userId, "passkey_removed");
  return { removed: true };
}

/**
 * POST /passkeys/assertion/options (signed in): options to answer step-up,
 * turning two-step verification on or off, regenerating backup codes or
 * removing a passkey with a passkey; bound to this sign-in.
 */
export async function startStepUpPasskeyAssertion(input: { userId: string; familyId: string; now?: Date }) {
  const now = input.now ?? currentDate();
  const started = await startPasskeyAssertion(relyingParty(), { userId: input.userId, binding: { familyId: input.familyId }, now });
  if (!started) throw passkeyNotFound();
  return started;
}
