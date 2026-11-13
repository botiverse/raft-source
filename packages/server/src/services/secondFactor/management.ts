/**
 * Managing a person's own two-step verification (design v8 §3, §5; rollout
 * PR 2): set up and confirm an authenticator app (TOTP), turn two-step
 * verification on and off, regenerate backup codes, step up the current
 * sign-in (PR 3). Served by routes/secondFactor.ts.
 *
 * Turning it on here records `users.second_factor_required_at`, marks the
 * current sign-in verified and signs out the person's other own sign-ins;
 * from then on (with the flag on for them) every password or social sign-in
 * asks for a second step (sessionIssueGate.ts, signIn.ts), and approving a
 * device or app login needs a verified sign-in (stepUpSession).
 *
 * Proof of identity for each change:
 *   - TOTP setup with two-step verification off: a recent sign-in or
 *     re-authentication on this session (reauthentication.ts, 10 minutes;
 *     POST /reauth/password marks one).
 *   - With it on (re-binding TOTP, turning it off, regenerating backup
 *     codes): step-up inline, a current code or a passkey assertion checked
 *     in the same request. Other sensitive actions (password, sign-in
 *     methods, agent keys) instead need this sign-in stepped up in the last
 *     10 minutes (stepUpGate.ts, PR 5).
 *
 * Passkeys (PR 4a) answer like a code wherever step-up takes one
 * (`{ webauthn }`, an assertion from POST /passkeys/assertion/options bound
 * to this sign-in; passkeys.ts), and can turn two-step verification on by
 * themselves (design A9). Registering and removing them: passkeyManagement.ts.
 *
 * Every code check follows attemptWindow.ts: the per-person attempt is claimed
 * and committed first; only a right answer gives it back, in the same
 * transaction as the change it allows (with the TOTP step or backup code it
 * used). Each transaction locks the person's `users` row first, like every
 * session-family revoker, so changes for one person run one at a time.
 *
 * Other sign-ins (design §5, P2): a change that invalidates a credential
 * someone else might hold signs out every other `full` sign-in of the person
 * in the same transaction and keeps the one that made it
 * (revokeOtherWebSessionFamiliesInTransaction: their next refresh is answered
 * 401 `session_revoked`, their access tokens stop at once, their sockets are
 * evicted after commit): turning two-step verification on, new backup codes,
 * a re-bound authenticator app (while on), turning it off (its authenticator
 * app and backup codes go), removing a passkey (passkeyManagement.ts).
 * Adding or confirming something new (a first authenticator app, a passkey)
 * signs nobody out. Device sign-ins (Computers, the raft CLI) always stay. A
 * password change signs out every sign-in, the one that made it too
 * (userService).
 *
 * Nothing here runs for a person who never uses these routes, and nothing
 * else changes for them (design §0): the gates enforce only for a person who
 * turned it on.
 */
import argon2 from "argon2";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { sessionFamilies, userBackupCodes, users, userTotp, type SecondFactorMethod } from "../../db/schema";
import { revokeSocketAccess } from "../../socket/accessRevocation";
import { sendSecondFactorChangeEmail, type SecondFactorChangeEmailEvent } from "../emailService";
import { recordIntegrationAuditEvent, type IntegrationAuditEventType } from "../integrationAuditService";
import {
  DeviceSessionRevokedError,
  lockLiveSessionFamily,
  revokeOtherWebSessionFamiliesInTransaction,
  SECOND_FACTOR_CHANGED_REVOKED_REASON,
} from "../sessionService";
import { claimReauthAttempt, claimSecondFactorAttempt, releaseReauthAttempt, releaseSecondFactorAttempt } from "./attemptWindow";
import {
  consumeBackupCode,
  countUnused,
  countUnusedBackupCodes,
  isUsedBackupCode,
  recordBackupCodeUse,
  replaceBackupCodes,
  sendBackupCodeUsedEmail,
  type BackupCodeUse,
  type BackupCodeUseContext,
} from "./backupCodes";
import { checkPasskeyAssertion, countActivePasskeys, recordPasskeyUse, sendPasskeyCounterWarning, type CheckedPasskeyAssertion } from "./passkeys";
import { isRecentlyReauthenticated, markSessionReauthenticated } from "./reauthentication";
import { afterRecoveryAutoCancel, autoCancelRecoveryInTransaction, getRecoveryView, type RecoveryAutoCancelled, type RecoveryView } from "./recovery";
import { generateTotpSecret, recordTotpStep, totpUri, verifyTotp } from "./totp";
import { decryptTotpSecret, encryptTotpSecret, TotpSecretCryptoError } from "./totpSecretCrypto";
import { parsePasskeyAssertionResponse, webauthnRelyingParty, type PasskeyAssertionResponse, type RelyingParty } from "./webauthn";

const TOTP_ISSUER = "Raft";

/** A second factor the person can use, as the API names it. */
export type SecondFactorMethodName = "totp" | "passkey" | "backup_code";

export type SecondFactorErrorCode =
  | "invalid_request"
  | "second_factor_code_invalid"
  | "backup_code_used"
  | "second_factor_locked"
  | "reauth_locked"
  | "reauth_required"
  | "step_up_required"
  | "second_factor_not_enabled"
  | "second_factor_already_enabled"
  | "totp_setup_required"
  | "session_family_required"
  | "password_incorrect"
  | "second_factor_unavailable"
  | "passkeys_unavailable"
  | "passkey_not_found"
  | "passkey_already_registered"
  | "passkey_invalid"
  | "challenge_expired"
  | "last_factor";

const STATUS_OF: Record<SecondFactorErrorCode, number> = {
  invalid_request: 400,
  second_factor_code_invalid: 400,
  backup_code_used: 400,
  second_factor_locked: 429,
  reauth_locked: 429,
  reauth_required: 403,
  step_up_required: 403,
  second_factor_not_enabled: 409,
  second_factor_already_enabled: 409,
  totp_setup_required: 409,
  session_family_required: 403,
  password_incorrect: 401,
  second_factor_unavailable: 503,
  passkeys_unavailable: 503,
  passkey_not_found: 404,
  passkey_already_registered: 409,
  passkey_invalid: 400,
  challenge_expired: 410,
  last_factor: 409,
};

/** A refusal the route sends as `status` with `{ error, code, ...extra }`. */
export class SecondFactorError extends Error {
  readonly status: number;
  constructor(readonly code: SecondFactorErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "SecondFactorError";
    this.status = STATUS_OF[code];
  }
}

/** What step-up was answered with. */
export type StepUpAnswer = { code?: string; backupCode?: string; webauthn?: PasskeyAssertionResponse };

export interface SecondFactorStatus {
  enabled: boolean;
  methods: { totp: boolean; passkeys: number; backupCodesRemaining: number };
}

export async function getSecondFactorStatus(userId: string): Promise<SecondFactorStatus> {
  const db = getDb();
  const [user] = await db.select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  const [totp] = await db.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId));
  return {
    enabled: Boolean(user?.requiredAt),
    methods: {
      totp: Boolean(totp?.confirmedAt),
      passkeys: await countActivePasskeys(db, userId),
      backupCodesRemaining: await countUnusedBackupCodes(userId),
    },
  };
}

/**
 * GET /status: the person's setup, plus whether THIS sign-in (`familyId`, a
 * full-scope web family) passed the second factor, at sign-in or by step-up
 * (`second_factor_verified_at`): lets an approval page ask for a code before
 * the approval would be refused; and `recovery`, the person's confirmed
 * two-step verification recovery request (recovery.ts RecoveryView) or null,
 * so every session can show it with Cancel.
 */
export async function getSessionSecondFactorStatus(input: { userId: string; familyId: string }): Promise<SecondFactorStatus & { sessionVerified: boolean; recovery: RecoveryView | null }> {
  const [family] = await getDb().select({ verifiedAt: sessionFamilies.secondFactorVerifiedAt }).from(sessionFamilies)
    .where(and(
      eq(sessionFamilies.id, input.familyId),
      eq(sessionFamilies.userId, input.userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
    ));
  return { ...(await getSecondFactorStatus(input.userId)), sessionVerified: Boolean(family?.verifiedAt), recovery: await getRecoveryView(input.userId) };
}

/**
 * The methods the person can answer with (the `methods` of a refusal):
 * passkeys only while the server has a WebAuthn relying party.
 */
export async function availableMethods(userId: string): Promise<SecondFactorMethodName[]> {
  const { methods } = await getSecondFactorStatus(userId);
  return [
    ...(methods.totp ? ["totp" as const] : []),
    ...(methods.passkeys > 0 && webauthnRelyingParty() ? ["passkey" as const] : []),
    ...(methods.backupCodesRemaining > 0 ? ["backup_code" as const] : []),
  ];
}

export type LockedUser = { email: string; name: string; requiredAt: Date | null };

/** The person's `users` row FOR UPDATE: every change here takes it first. */
export async function lockUser(tx: DatabaseExecutor, userId: string): Promise<LockedUser> {
  const [user] = await tx
    .select({ email: users.email, displayName: users.displayName, name: users.name, requiredAt: users.secondFactorRequiredAt, retiredAt: users.retiredAt })
    .from(users).where(eq(users.id, userId)).for("update");
  if (!user || user.retiredAt) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
  return { email: user.email, name: user.displayName || user.name, requiredAt: user.requiredAt };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Reads `{ code }` / `{ backupCode }` / `{ webauthn }` from a request body. */
export function parseStepUpAnswer(body: unknown): StepUpAnswer {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const webauthn = record.webauthn === undefined ? undefined : parsePasskeyAssertionResponse(record.webauthn) ?? undefined;
  return { code: stringField(record.code), backupCode: stringField(record.backupCode), webauthn };
}

/** Thrown inside a transaction to roll it back on a wrong answer; mapped after. */
class WrongAnswer extends Error {
  constructor(readonly kind: SecondFactorMethod) {
    super("wrong second-factor answer");
  }
}

function sealSecret(secret: string, userId: string): string {
  try {
    return encryptTotpSecret(secret, userId);
  } catch (err) {
    if (err instanceof TotpSecretCryptoError) {
      throw new SecondFactorError("second_factor_unavailable", "Two-step verification is not available right now.");
    }
    throw err;
  }
}

function openSecret(ciphertext: string, userId: string): string | null {
  try {
    return decryptTotpSecret(ciphertext, userId);
  } catch (err) {
    if (err instanceof TotpSecretCryptoError && err.code === "totp_secret_key_missing") {
      throw new SecondFactorError("second_factor_unavailable", "Two-step verification is not available right now.");
    }
    return null;
  }
}

function passkeyRelyingParty(): RelyingParty {
  const rp = webauthnRelyingParty();
  if (!rp) throw new SecondFactorError("passkeys_unavailable", "Passkeys are not available right now.");
  return rp;
}

/**
 * A change to the person's second factors may be written only while the
 * sign-in that asked for it is still live, checked under the lock in the
 * transaction that writes it. Otherwise a request authenticated just before a
 * password reset (or any revoke of that sign-in) could finish after it and
 * leave a factor behind for whoever held the revoked sign-in
 * (#raft-architecture:102593c2). Call after lockUser.
 */
export async function lockLiveSetupSession(tx: DatabaseExecutor, userId: string, familyId: string): Promise<void> {
  try {
    await lockLiveSessionFamily(tx, familyId, userId);
  } catch (err) {
    if (err instanceof DeviceSessionRevokedError) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
    throw err;
  }
}

/**
 * Checks one second-factor answer and, only when it is right, runs `action`
 * in the same transaction (design §3 step-up, inline):
 *   1. claim the person's attempt and commit it (a lock refuses here);
 *   2. TOTP: check the code against the confirmed secret, or `secret` when
 *      given (confirming a new one), then record its step (replay guard;
 *      for a pending re-bind secret `action` records it with the swap, since
 *      the stored step belongs to the old secret);
 *      passkey (when `passkey` names the sign-in it answers for): consume
 *      the assertion challenge and verify it (passkeys.ts), then record the
 *      use (counter, last used; a counter regression is audited);
 *      backup code: use it (single use, compare-and-set);
 *   3. give the claim back, cancel the person's two-step verification
 *      recovery request if any (recovery.ts: a right answer proves they still
 *      have a factor; its email after commit), run `action`, and for a backup
 *      code audit its use with the codes left after `action`; all of it
 *      commits together. A backup code's email goes after commit.
 * A wrong answer keeps the claim and writes nothing else.
 */
export async function withSecondFactorAnswer<T>(
  userId: string,
  answer: StepUpAnswer,
  now: Date,
  options: {
    allowBackupCode: boolean;
    passkey?: { familyId: string };
    secret?: { ciphertext: string; pending: boolean };
    /** With allowBackupCode: what a backup code answers here and for which sign-in (audit and email). */
    backupCodeUse?: { context: BackupCodeUseContext; sessionFamilyId: string };
  },
  action: (tx: DatabaseExecutor, ctx: { user: LockedUser; method: SecondFactorMethod; step: number | null }) => Promise<T>,
): Promise<T> {
  const usePasskey = !answer.code && Boolean(options.passkey && answer.webauthn);
  const useBackupCode = !answer.code && !usePasskey && options.allowBackupCode && Boolean(answer.backupCode);
  if (!answer.code && !usePasskey && !useBackupCode) {
    const choices = ["a code from your authenticator app", ...(options.allowBackupCode ? ["a backup code"] : []), ...(options.passkey ? ["a passkey"] : [])];
    throw new SecondFactorError("invalid_request", `Use ${choices.length > 1 ? `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}` : choices[0]}.`);
  }
  const rp = usePasskey ? passkeyRelyingParty() : null;

  const claim = await claimSecondFactorAttempt(getDb(), userId, now);
  if (!claim.ok) {
    throw new SecondFactorError("second_factor_locked", "Too many wrong codes. Try again later.", {
      lockedUntil: claim.lockedUntil.toISOString(),
      methods: await availableMethods(userId),
    });
  }

  let verifiedStep: number | null = null;
  let verifiedTotpCiphertext: string | null = null;
  let passkey: CheckedPasskeyAssertion | null = null;
  if (usePasskey) {
    passkey = await checkPasskeyAssertion(rp!, { userId, binding: { familyId: options.passkey!.familyId }, response: answer.webauthn!, now });
    if (!passkey) throw new SecondFactorError("second_factor_code_invalid", "That passkey didn't work. Try again.");
  } else if (!useBackupCode) {
    // Checked before the transaction (pure); the step is recorded inside it.
    const [row] = await getDb().select({
      ciphertext: userTotp.secretCiphertext,
      confirmedAt: userTotp.confirmedAt,
      lastUsedStep: userTotp.lastUsedStep,
      pendingCiphertext: userTotp.pendingSecretCiphertext,
    }).from(userTotp).where(eq(userTotp.userId, userId));
    const pending = options.secret?.pending ?? false;
    const stored = pending ? row?.pendingCiphertext : row?.ciphertext;
    const ciphertext = options.secret ? options.secret.ciphertext : row?.confirmedAt ? row.ciphertext : null;
    const secret = ciphertext && stored === ciphertext ? openSecret(ciphertext, userId) : null;
    const result = secret ? verifyTotp({ secret, code: answer.code!, now, lastUsedStep: pending ? null : row?.lastUsedStep ?? null }) : null;
    if (!result?.ok) throw new SecondFactorError("second_factor_code_invalid", "That code didn't work. Check your authenticator app and try again.");
    verifiedStep = result.step;
    verifiedTotpCiphertext = ciphertext!;
  }

  const method: SecondFactorMethod = usePasskey ? "passkey" : useBackupCode ? "backup_code" : "totp";
  let counterRegressed = false;
  let recoveryCancelled: RecoveryAutoCancelled = null;
  let backupCodeUsed: BackupCodeUse | null = null;
  try {
    const result = await getDb().transaction(async (tx) => {
      const user = await lockUser(tx, userId);
      if (passkey) {
        const used = await recordPasskeyUse(tx, { userId, checked: passkey, now, sessionFamilyId: options.passkey!.familyId, context: "step_up" });
        // Removed in between.
        if (!used.recorded) throw new WrongAnswer("passkey");
        counterRegressed = used.counterRegressed;
      } else if (useBackupCode) {
        const used = await consumeBackupCode(tx, userId, answer.backupCode!, now);
        if (!used.ok) throw new WrongAnswer("backup_code");
      } else if (!options.secret?.pending && !(await recordTotpStep(tx, userId, verifiedStep!, verifiedTotpCiphertext!))) {
        // The same code was used a moment ago (or the secret changed since).
        throw new WrongAnswer("totp");
      }
      await releaseSecondFactorAttempt(tx, userId, now);
      recoveryCancelled = await autoCancelRecoveryInTransaction(tx, userId, now);
      const acted = await action(tx, { user, method, step: verifiedStep });
      if (useBackupCode) {
        // Counted after `action`: turning two-step verification off removes the rest.
        backupCodeUsed = {
          context: options.backupCodeUse?.context ?? "step_up",
          remaining: await countUnused(tx, userId),
          sessionFamilyId: options.backupCodeUse?.sessionFamilyId ?? null,
        };
        await recordBackupCodeUse(tx, userId, backupCodeUsed);
      }
      return acted;
    });
    if (counterRegressed) await sendPasskeyCounterWarning(userId);
    if (backupCodeUsed) await sendBackupCodeUsedEmail(userId, backupCodeUsed);
    await afterRecoveryAutoCancel(recoveryCancelled);
    return result;
  } catch (err) {
    if (!(err instanceof WrongAnswer)) throw err;
    if (err.kind === "passkey") throw new SecondFactorError("second_factor_code_invalid", "That passkey didn't work. Try again.");
    if (err.kind === "backup_code" && await isUsedBackupCode(getDb(), userId, answer.backupCode!)) {
      throw new SecondFactorError("backup_code_used", "That backup code was already used.");
    }
    throw new SecondFactorError("second_factor_code_invalid", err.kind === "backup_code"
      ? "That backup code didn't work."
      : "That code didn't work. Check your authenticator app and try again.");
  }
}

export async function audit(
  tx: DatabaseExecutor,
  userId: string,
  eventType: IntegrationAuditEventType,
  metadata: Record<string, unknown>,
): Promise<void> {
  // The person's own: no serverId, never on a server's audit page.
  await recordIntegrationAuditEvent({
    serverId: null,
    eventType,
    outcome: "success",
    source: "web",
    actor: { type: "human", id: userId },
    subject: { type: "human", id: userId },
    target: { type: "user", id: userId },
    metadata,
  }, tx);
}

/** Best effort after commit: the change stands even if the email fails. */
export async function notify(user: LockedUser, userId: string, event: SecondFactorChangeEmailEvent): Promise<void> {
  if (!user.email) return;
  try {
    await sendSecondFactorChangeEmail(user.email, user.name, event);
  } catch (err) {
    console.error(`[second-factor] ${event} email to ${userId} failed:`, err);
  }
}

/** After commit: closes the sockets of the sign-ins a change signed out. Logged, not thrown: the change stands. */
export async function evictSignedOutSessions(userId: string, familyIds: readonly string[]): Promise<void> {
  for (const familyId of familyIds) {
    try {
      await revokeSocketAccess({ userId, familyId });
    } catch (err) {
      console.error(`[second-factor] evicting signed-out sign-in ${familyId} failed:`, err);
    }
  }
}

/** First setup: a fresh unconfirmed secret over any unconfirmed one (the replay guard starts over with it). */
async function storeUnconfirmedSecret(tx: DatabaseExecutor, userId: string, ciphertext: string, now: Date): Promise<void> {
  await tx.insert(userTotp)
    .values({ userId, secretCiphertext: ciphertext, confirmedAt: null, lastUsedStep: null, createdAt: now })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { secretCiphertext: ciphertext, confirmedAt: null, lastUsedStep: null, createdAt: now, pendingSecretCiphertext: null, pendingCreatedAt: null },
    });
}

/**
 * Writes the new secret where it belongs: beside a confirmed secret as the
 * pending re-bind (the confirmed one is never touched here and keeps working
 * until the new one is confirmed), else as the unconfirmed first secret.
 * Read under the person's lock, so a concurrent confirm cannot be overwritten.
 */
async function storeNewSecret(tx: DatabaseExecutor, userId: string, ciphertext: string, now: Date): Promise<void> {
  const [row] = await tx.select({ confirmedAt: userTotp.confirmedAt }).from(userTotp).where(eq(userTotp.userId, userId));
  if (row?.confirmedAt) {
    await tx.update(userTotp)
      .set({ pendingSecretCiphertext: ciphertext, pendingCreatedAt: now })
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
    return;
  }
  await storeUnconfirmedSecret(tx, userId, ciphertext, now);
}

/**
 * POST /totp/setup. Off: needs a recent sign-in or re-authentication on this
 * session (POST /reauth/password). On: step-up first (a current TOTP code or
 * a backup code). Then the new secret is stored: as the first, unconfirmed
 * secret, or, when a confirmed one exists, as the pending re-bind beside it
 * (the confirmed secret stays valid until POST /totp/confirm swaps them; an
 * abandoned re-bind changes nothing and the next setup overwrites it).
 * Returns the secret once; only its ciphertext is stored.
 */
export async function setUpTotp(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ secret: string; otpauthUri: string }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  const [user] = await getDb().select({ email: users.email, requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  if (!user) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
  const secret = generateTotpSecret();
  // Sealed before any code is checked, so a missing key never burns a backup code.
  const ciphertext = sealSecret(secret, userId);
  const result = { secret, otpauthUri: totpUri({ secret, accountName: user.email, issuer: TOTP_ISSUER }) };

  if (!user.requiredAt) {
    if (!(await isRecentlyReauthenticated(getDb(), input.familyId, now))) {
      throw new SecondFactorError("reauth_required", "Confirm your password to set up an authenticator app.");
    }
    await getDb().transaction(async (tx) => {
      const locked = await lockUser(tx, userId);
      await lockLiveSetupSession(tx, userId, input.familyId);
      // Turned on in between: this now needs step-up.
      if (locked.requiredAt) throw new SecondFactorError("step_up_required", "Enter a code to change your authenticator app.", { methods: await availableMethods(userId) });
      await storeNewSecret(tx, userId, ciphertext, now);
    });
    return result;
  }

  if (!input.answer.code && !input.answer.backupCode && !input.answer.webauthn) {
    throw new SecondFactorError("step_up_required", "Enter a code to change your authenticator app.", { methods: await availableMethods(userId) });
  }
  const answerOptions = { allowBackupCode: true, passkey: { familyId: input.familyId }, backupCodeUse: { context: "totp_setup" as const, sessionFamilyId: input.familyId } };
  await withSecondFactorAnswer(userId, input.answer, now, answerOptions, async (tx) => {
    await lockLiveSetupSession(tx, userId, input.familyId);
    await storeNewSecret(tx, userId, ciphertext, now);
  });
  return result;
}

/**
 * POST /totp/confirm: a code from the new secret confirms it. A first secret
 * is marked confirmed; a pending re-bind replaces the confirmed secret in one
 * update (its step becomes the replay guard) and, with two-step
 * verification on, signs out the person's other sign-ins (this one stays).
 * Confirming does not turn two-step verification on by itself (POST /enable).
 */
export async function confirmTotp(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ confirmed: true; enabled: boolean }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  if (!input.answer.code) throw new SecondFactorError("invalid_request", "Enter a code from your authenticator app.");
  const [row] = await getDb().select({ ciphertext: userTotp.secretCiphertext, confirmedAt: userTotp.confirmedAt, pendingCiphertext: userTotp.pendingSecretCiphertext })
    .from(userTotp).where(eq(userTotp.userId, userId));
  const target = row?.pendingCiphertext
    ? { ciphertext: row.pendingCiphertext, pending: true }
    : row && !row.confirmedAt ? { ciphertext: row.ciphertext, pending: false } : null;
  if (!target) throw new SecondFactorError("totp_setup_required", "Set up an authenticator app first.");
  const { user, enabled, signedOut } = await withSecondFactorAnswer(userId, { code: input.answer.code }, now, { allowBackupCode: false, secret: target }, async (tx, ctx) => {
    await lockLiveSetupSession(tx, userId, input.familyId);
    const confirmed = target.pending
      ? await tx.update(userTotp)
        .set({ secretCiphertext: target.ciphertext, confirmedAt: now, lastUsedStep: ctx.step, createdAt: now, pendingSecretCiphertext: null, pendingCreatedAt: null })
        .where(and(eq(userTotp.userId, userId), eq(userTotp.pendingSecretCiphertext, target.ciphertext)))
        .returning({ userId: userTotp.userId })
      : await tx.update(userTotp).set({ confirmedAt: now })
        .where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt), eq(userTotp.secretCiphertext, target.ciphertext)))
        .returning({ userId: userTotp.userId });
    if (confirmed.length !== 1) throw new SecondFactorError("totp_setup_required", "Set up an authenticator app first.");
    const enabled = Boolean(ctx.user.requiredAt);
    const signedOut = target.pending && enabled
      ? await revokeOtherWebSessionFamiliesInTransaction(tx, userId, input.familyId, now, SECOND_FACTOR_CHANGED_REVOKED_REASON)
      : [];
    await audit(tx, userId, "account.second_factor_totp_confirmed", {
      sessionFamilyId: input.familyId, rebind: target.pending, ...(target.pending && enabled ? { signedOutSessionCount: signedOut.length } : {}),
    });
    return { user: ctx.user, enabled, signedOut };
  });
  await evictSignedOutSessions(userId, signedOut);
  await notify(user, userId, "totp_added");
  return { confirmed: true, enabled };
}

/**
 * POST /reauth/password: the current password, checked like sign-in
 * (argon2, then the hash re-read under the person's lock), marks this sign-in
 * re-authenticated (reauthentication.ts) for the next 10 minutes. Guesses are
 * bounded by the person's own re-authentication attempt window (claimed
 * first, given back on a right password; apart from the second-step window,
 * so wrong passwords from a stolen session cannot lock the owner's second
 * step at sign-in) and authLimiter per address. Social-only accounts have an
 * unknowable placeholder hash and cannot pass; provider re-authentication is
 * deferred.
 */
export async function reauthenticateWithPassword(input: { userId: string; familyId: string; password: string; now?: Date }): Promise<void> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  const [user] = await getDb().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!user) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
  const claim = await claimReauthAttempt(getDb(), userId, now);
  if (!claim.ok) {
    throw new SecondFactorError("reauth_locked", "Too many wrong passwords. Try again later.", {
      lockedUntil: claim.lockedUntil.toISOString(),
    });
  }
  if (!(await argon2.verify(user.passwordHash, input.password))) {
    throw new SecondFactorError("password_incorrect", "Current password is incorrect");
  }
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ passwordHash: users.passwordHash, retiredAt: users.retiredAt }).from(users).where(eq(users.id, userId)).for("update");
    if (!current || current.retiredAt) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
    // Changed since the check (a password change also signs this session out).
    if (current.passwordHash !== user.passwordHash) throw new SecondFactorError("password_incorrect", "Current password is incorrect");
    if (!(await markSessionReauthenticated(tx, input.familyId, now))) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
    await releaseReauthAttempt(tx, userId, now);
  });
}

/**
 * POST /enable: one code from the authenticator app (the confirmed one, or the
 * one /totp/setup just created, which this confirms), or an assertion from a
 * passkey already registered (`{ webauthn }`, design A9: no authenticator app
 * needed), turns two-step verification on, in one transaction with: the
 * current sign-in marked verified (with that method), 10 new backup codes,
 * and every other own sign-in of the person signed out (P2; device sign-ins,
 * Computers and the CLI, stay). Returns the backup codes once.
 */
export async function enableSecondFactor(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ backupCodes: string[] }> {
  const now = input.now ?? currentDate();
  const { userId, familyId } = input;
  const withPasskey = !input.answer.code && Boolean(input.answer.webauthn);
  if (!input.answer.code && !withPasskey) throw new SecondFactorError("invalid_request", "Enter a code from your authenticator app or use a passkey.");
  const status = await getSecondFactorStatus(userId);
  if (status.enabled) throw new SecondFactorError("second_factor_already_enabled", "Two-step verification is already on.");
  // One code turns it on (Kirby, #triage:#133): without a confirmed
  // authenticator app, the code is checked against the secret /totp/setup
  // just created and confirms it in the same transaction, so nobody waits for
  // a second code. /totp/confirm is then only for re-binding.
  let unconfirmed: { ciphertext: string; pending: false } | null = null;
  if (!withPasskey && !status.methods.totp) {
    const [row] = await getDb().select({ ciphertext: userTotp.secretCiphertext, confirmedAt: userTotp.confirmedAt })
      .from(userTotp).where(eq(userTotp.userId, userId));
    if (!row || row.confirmedAt) throw new SecondFactorError("totp_setup_required", "Set up an authenticator app first.");
    unconfirmed = { ciphertext: row.ciphertext, pending: false };
  }

  const answerOptions = withPasskey
    ? { allowBackupCode: false, passkey: { familyId } }
    : unconfirmed ? { allowBackupCode: false, secret: unconfirmed } : { allowBackupCode: false };
  const answer = withPasskey ? { webauthn: input.answer.webauthn } : { code: input.answer.code };
  const { user, backupCodes, signedOut } = await withSecondFactorAnswer(userId, answer, now, answerOptions, async (tx, ctx) => {
    if (ctx.user.requiredAt) throw new SecondFactorError("second_factor_already_enabled", "Two-step verification is already on.");
    if (unconfirmed) {
      const confirmed = await tx.update(userTotp).set({ confirmedAt: now })
        .where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt), eq(userTotp.secretCiphertext, unconfirmed.ciphertext)))
        .returning({ userId: userTotp.userId });
      if (confirmed.length !== 1) throw new SecondFactorError("totp_setup_required", "Set up an authenticator app first.");
      await audit(tx, userId, "account.second_factor_totp_confirmed", { sessionFamilyId: familyId, rebind: false });
    }
    await tx.update(users).set({ secondFactorRequiredAt: now, updatedAt: now }).where(eq(users.id, userId));
    const marked = await tx.update(sessionFamilies)
      .set({ secondFactorVerifiedAt: now, secondFactorMethod: ctx.method })
      .where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "full"), isNull(sessionFamilies.revokedAt), isNull(sessionFamilies.retiredAt)))
      .returning({ id: sessionFamilies.id });
    if (marked.length !== 1) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
    const codes = await replaceBackupCodes(userId, now, tx);
    const revoked = await revokeOtherWebSessionFamiliesInTransaction(tx, userId, familyId, now);
    await audit(tx, userId, "account.second_factor_enabled", { sessionFamilyId: familyId, method: ctx.method, signedOutSessionCount: revoked.length });
    return { user: ctx.user, backupCodes: codes, signedOut: revoked };
  });
  await evictSignedOutSessions(userId, signedOut);
  await notify(user, userId, "enabled");
  return { backupCodes };
}

/**
 * POST /disable: step-up with a current TOTP code, a passkey or a backup code, then two-step
 * verification is off: the authenticator app and the backup codes are removed
 * (passkeys stay: they are also sign-in credentials), and every other own
 * sign-in of the person is signed out in the same transaction (this one
 * stays).
 */
export async function disableSecondFactor(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ enabled: false }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  const [current] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  if (!current?.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
  const answerOptions = { allowBackupCode: true, passkey: { familyId: input.familyId }, backupCodeUse: { context: "disable" as const, sessionFamilyId: input.familyId } };
  const { user, signedOut } = await withSecondFactorAnswer(userId, input.answer, now, answerOptions, async (tx, ctx) => {
    if (!ctx.user.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
    await lockLiveSetupSession(tx, userId, input.familyId);
    await tx.update(users).set({ secondFactorRequiredAt: null, updatedAt: now }).where(eq(users.id, userId));
    await tx.delete(userTotp).where(eq(userTotp.userId, userId));
    await tx.delete(userBackupCodes).where(eq(userBackupCodes.userId, userId));
    const revoked = await revokeOtherWebSessionFamiliesInTransaction(tx, userId, input.familyId, now, SECOND_FACTOR_CHANGED_REVOKED_REASON);
    await audit(tx, userId, "account.second_factor_disabled", { sessionFamilyId: input.familyId, method: ctx.method, signedOutSessionCount: revoked.length });
    return { user: ctx.user, signedOut: revoked };
  });
  await evictSignedOutSessions(userId, signedOut);
  await notify(user, userId, "disabled");
  return { enabled: false };
}

/**
 * POST /backup-codes/regenerate: step-up with a current TOTP code or a
 * passkey; the new set replaces every earlier code, and every other own
 * sign-in of the person is signed out in the same transaction (this one
 * stays).
 */
export async function regenerateBackupCodes(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ backupCodes: string[] }> {
  const now = input.now ?? currentDate();
  const { userId } = input;
  if (!input.answer.code && !input.answer.webauthn) throw new SecondFactorError("invalid_request", "Enter a code from your authenticator app or use a passkey.");
  const [current] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  if (!current?.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
  const answer = { code: input.answer.code, webauthn: input.answer.webauthn };
  const { user, backupCodes, signedOut } = await withSecondFactorAnswer(userId, answer, now, { allowBackupCode: false, passkey: { familyId: input.familyId } }, async (tx, ctx) => {
    if (!ctx.user.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
    await lockLiveSetupSession(tx, userId, input.familyId);
    const codes = await replaceBackupCodes(userId, now, tx);
    const revoked = await revokeOtherWebSessionFamiliesInTransaction(tx, userId, input.familyId, now, SECOND_FACTOR_CHANGED_REVOKED_REASON);
    await audit(tx, userId, "account.second_factor_backup_codes_regenerated", { sessionFamilyId: input.familyId, method: ctx.method, signedOutSessionCount: revoked.length });
    return { user: ctx.user, backupCodes: codes, signedOut: revoked };
  });
  await evictSignedOutSessions(userId, signedOut);
  await notify(user, userId, "backup_codes_regenerated");
  return { backupCodes };
}

/**
 * POST /step-up: a current TOTP code, a passkey or a backup code marks this sign-in
 * verified (`session_families.second_factor_verified_at` / `_method`), as
 * passing the second step at sign-in would have, so it can approve device
 * and app logins (design §3 step 4). Only with two-step verification on, and
 * only for the person's own live `full` sign-in (the route refuses a device
 * login's session before this; the update requires `full` again).
 */
export async function stepUpSession(input: { userId: string; familyId: string; answer: StepUpAnswer; now?: Date }): Promise<{ verified: true; backupCodesRemaining?: number }> {
  const now = input.now ?? currentDate();
  const { userId, familyId } = input;
  const [current] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, userId));
  if (!current?.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
  const answerOptions = { allowBackupCode: true, passkey: { familyId }, backupCodeUse: { context: "step_up" as const, sessionFamilyId: familyId } };
  const method = await withSecondFactorAnswer(userId, input.answer, now, answerOptions, async (tx, ctx) => {
    if (!ctx.user.requiredAt) throw new SecondFactorError("second_factor_not_enabled", "Two-step verification is off.");
    const marked = await tx.update(sessionFamilies)
      .set({ secondFactorVerifiedAt: now, secondFactorMethod: ctx.method })
      .where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId), eq(sessionFamilies.scope, "full"), isNull(sessionFamilies.revokedAt), isNull(sessionFamilies.retiredAt)))
      .returning({ id: sessionFamilies.id });
    if (marked.length !== 1) throw new SecondFactorError("session_family_required", "Sign in again to continue.");
    return ctx.method;
  });
  return method === "backup_code" ? { verified: true, backupCodesRemaining: await countUnusedBackupCodes(userId) } : { verified: true };
}
