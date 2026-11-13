/**
 * The second step of a sign-in (design v8 §3; rollout PR 3). A first-factor
 * endpoint whose gate (sessionIssueGate.ts) answers "second factor required"
 * issues no tokens: it starts a `second_factor_login` challenge here (5
 * minutes, single use) that carries everything needed to finish exactly as
 * that endpoint would have (SecondFactorSignInContext), and answers
 * `{ secondFactorRequired: true, challenge, expiresAt, methods, maskedEmail }`.
 *
 * POST /api/auth/second-factor/verify answers it (verifySecondFactorSignIn):
 *   1. the person's attempt window is claimed and committed (attemptWindow.ts;
 *      a lock refuses here, and the claim that starts it sends the email);
 *   2. one attempt at the challenge is claimed and committed
 *      (authChallenges.ts; at most AUTH_CHALLENGE_MAX_ATTEMPTS ever);
 *   3. a TOTP code is checked (pure), or a passkey assertion: its
 *      `webauthn_assertion` challenge (from POST
 *      /passkeys/assertion/options with this sign-in's challenge, bound to
 *      it) consumed, then its signature verified (passkeys.ts);
 *   4. ONE transaction: the challenge consumed (compare-and-set: of two
 *      concurrent right answers one wins), the TOTP step recorded, the
 *      passkey's use recorded (counter, last used; a counter regression is
 *      audited, and emailed after commit) or the backup code used (audited,
 *      and emailed after commit, with how many are left), the attempt given back, then the flow's own finish
 *      (any pending social link committed, the session created with a
 *      verified proof, which marks the new family verified).
 * A wrong answer keeps both claims and writes nothing else.
 *
 * A right answer also cancels the person's two-step verification recovery
 * request, if any (recovery.ts autoCancelRecoveryInTransaction, in the same
 * transaction; its email after commit).
 *
 * Recovery (rollout PR 6, recovery.ts): with a request past its 72-hour
 * wait, `methods` also lists `recovery`, and POST /verify { challenge,
 * recovery: true } (completeSecondFactorRecoverySignIn) finishes the
 * sign-in by removing every factor instead of checking one.
 *
 * `methods` lists only what the person has set up; `passkey` while the
 * server has a WebAuthn relying party (webauthn.ts). The challenge body does
 * not carry assertion options: a client offering a passkey asks for them
 * (startSignInPasskeyAssertion), fresh for each try, since a failed
 * assertion uses its WebAuthn challenge up.
 */
import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { users, userTotp, type AuthChallengePayload, type SecondFactorMethod } from "../../db/schema";
import { sendSecondFactorSignInLockedEmail } from "../emailService";
import { proofForSecondFactorRecovered, proofForSecondFactorVerified, type FirstFactorFlow, type SessionIssueProof } from "../sessionIssueGate";
import { pkceS256Challenge, type SocialAuthProvider } from "../socialAuthService";
import { claimSecondFactorAttempt, releaseSecondFactorAttempt, SECOND_FACTOR_LOCK_MS } from "./attemptWindow";
import {
  AUTH_CHALLENGE_MAX_ATTEMPTS,
  claimAuthChallengeAttempt,
  consumeAuthChallenge,
  createAuthChallenge,
  findLiveAuthChallenge,
  type AuthChallengeRow,
  type AuthChallengeToken,
} from "./authChallenges";
import { consumeBackupCode, countUnusedBackupCodes, isUsedBackupCode, recordBackupCodeUse, sendBackupCodeUsedEmail, type BackupCodeUse } from "./backupCodes";
import {
  afterRecoveryAutoCancel,
  assertRecoveryFinishable,
  autoCancelRecoveryInTransaction,
  completeRecoveryInTransaction,
  isRecoveryReady,
  RecoveryError,
  runRecoveryCompletedEffects,
  type RecoveryAutoCancelled,
} from "./recovery";
import { recordTotpStep, verifyTotp } from "./totp";
import { checkPasskeyAssertion, countActivePasskeys, recordPasskeyUse, sendPasskeyCounterWarning, startPasskeyAssertion, type CheckedPasskeyAssertion } from "./passkeys";
import { decryptTotpSecret, TotpSecretCryptoError } from "./totpSecretCrypto";
import { parsePasskeyAssertionResponse, webauthnRelyingParty, type PasskeyAssertionResponse } from "./webauthn";

export const SECOND_FACTOR_SIGN_IN_TTL_MS = 5 * 60_000;

/** A second factor a sign-in challenge can be answered with. */
export type SignInSecondFactorMethod = SecondFactorMethod;

/**
 * What a challenge carries to finish the sign-in exactly as its first step
 * would have. Never a secret: a pending social link is carried by its stored
 * hash, a mobile handoff by its PKCE challenge (the verifier comes back with
 * the answer), a password sign-in by a fingerprint of the password hash it
 * passed (a password changed since voids the challenge).
 */
export type SecondFactorSignInContext =
  | { flow: "password_login"; passwordFingerprint: string; pendingLinkTokenHash: string | null }
  | { flow: "social_login"; provider: SocialAuthProvider; returnTo: string | null; pendingLinkTokenHash: string | null }
  | {
      flow: "mobile_social_login";
      provider: SocialAuthProvider;
      returnUri: string;
      codeChallenge: string;
      pendingLinkTokenHash: string | null;
    }
  | {
      // SSO (rfcs/083-server-sso.md §5.4): the connection travels on the challenge so the proof keeps it;
      // an app's leg (desktop, mobile) is bound to its PKCE challenge like a mobile social sign-in.
      flow: "sso_login";
      ssoConnectionId: string;
      returnTo: string | null;
      codeChallenge: string | null;
      pendingLinkTokenHash: null;
    };

/** Binds a password sign-in's challenge to the password hash it passed. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(`second-factor-sign-in:${passwordHash}`).digest("hex");
}

function toPayload(context: SecondFactorSignInContext): AuthChallengePayload {
  const { flow: _flow, ...payload } = context;
  return payload;
}

const PROVIDERS: ReadonlySet<string> = new Set<SocialAuthProvider>(["google", "github", "apple"]);

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** The context a challenge row was created with; null if it is not one this file wrote. */
function parseContext(row: AuthChallengeRow): SecondFactorSignInContext | null {
  const payload = row.payload ?? {};
  const pendingLinkTokenHash = stringOrNull(payload.pendingLinkTokenHash);
  if (pendingLinkTokenHash === undefined) return null;
  const provider = typeof payload.provider === "string" && PROVIDERS.has(payload.provider) ? payload.provider as SocialAuthProvider : null;
  switch (row.flow as FirstFactorFlow | null) {
    case "password_login":
      return typeof payload.passwordFingerprint === "string"
        ? { flow: "password_login", passwordFingerprint: payload.passwordFingerprint, pendingLinkTokenHash }
        : null;
    case "social_login": {
      const returnTo = stringOrNull(payload.returnTo);
      return provider && returnTo !== undefined ? { flow: "social_login", provider, returnTo, pendingLinkTokenHash } : null;
    }
    case "mobile_social_login":
      return provider && typeof payload.returnUri === "string" && typeof payload.codeChallenge === "string"
        ? { flow: "mobile_social_login", provider, returnUri: payload.returnUri, codeChallenge: payload.codeChallenge, pendingLinkTokenHash }
        : null;
    case "sso_login": {
      const returnTo = stringOrNull(payload.returnTo);
      const codeChallenge = stringOrNull(payload.codeChallenge);
      return typeof payload.ssoConnectionId === "string" && payload.ssoConnectionId && returnTo !== undefined && codeChallenge !== undefined && pendingLinkTokenHash === null
        ? { flow: "sso_login", ssoConnectionId: payload.ssoConnectionId, returnTo, codeChallenge, pendingLinkTokenHash: null }
        : null;
    }
    default:
      return null;
  }
}

/** What the person can answer a sign-in challenge with: only what is set up. */
export async function signInSecondFactorMethods(userId: string): Promise<SignInSecondFactorMethod[]> {
  const [totp] = await getDb().select({ userId: userTotp.userId }).from(userTotp)
    .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
  const passkeys = webauthnRelyingParty() ? await countActivePasskeys(getDb(), userId) : 0;
  return [
    ...(totp ? ["totp" as const] : []),
    ...(passkeys > 0 ? ["passkey" as const] : []),
    ...((await countUnusedBackupCodes(userId)) > 0 ? ["backup_code" as const] : []),
  ];
}

/** `a***@example.com`: enough to recognise the account, not to learn the address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** What a sign-in challenge offers: the factors set up, and `recovery` when a recovery request can be finished. */
export type SignInChallengeMethod = SignInSecondFactorMethod | "recovery";

export type SecondFactorRequiredBody = {
  secondFactorRequired: true;
  challenge: AuthChallengeToken;
  expiresAt: string;
  methods: SignInChallengeMethod[];
  maskedEmail: string;
};

/** Start the second step for `userId` (the gate answered "second factor required"). */
export async function startSecondFactorSignIn(
  userId: string,
  context: SecondFactorSignInContext,
  now: Date = currentDate(),
): Promise<SecondFactorRequiredBody> {
  const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) throw new Error("startSecondFactorSignIn: user not found");
  const created = await createAuthChallenge({
    kind: "second_factor_login",
    userId,
    flow: context.flow,
    payload: toPayload(context),
    ttlMs: SECOND_FACTOR_SIGN_IN_TTL_MS,
    now,
  });
  return {
    secondFactorRequired: true,
    challenge: created.challenge,
    expiresAt: created.expiresAt.toISOString(),
    methods: [...(await signInSecondFactorMethods(userId)), ...((await isRecoveryReady(userId, now)) ? ["recovery" as const] : [])],
    maskedEmail: maskEmail(user.email),
  };
}

export type SecondFactorSignInErrorCode =
  | "invalid_request"
  | "second_factor_code_invalid"
  | "backup_code_used"
  | "challenge_expired"
  | "challenge_attempts_exhausted"
  | "second_factor_locked"
  | "pkce_mismatch"
  | "second_factor_unavailable"
  | "passkeys_unavailable"
  | "passkey_not_found"
  | "recovery_not_found"
  | "recovery_not_ready";

const STATUS_OF: Record<SecondFactorSignInErrorCode, number> = {
  invalid_request: 400,
  second_factor_code_invalid: 400,
  backup_code_used: 400,
  challenge_expired: 410,
  challenge_attempts_exhausted: 429,
  second_factor_locked: 429,
  pkce_mismatch: 400,
  second_factor_unavailable: 503,
  passkeys_unavailable: 503,
  passkey_not_found: 404,
  recovery_not_found: 409,
  recovery_not_ready: 409,
};

/** A refusal the route sends as `status` with `{ error, code, ...extra }`. */
export class SecondFactorSignInError extends Error {
  readonly status: number;
  constructor(readonly code: SecondFactorSignInErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "SecondFactorSignInError";
    this.status = STATUS_OF[code];
  }
}

const challengeExpired = () => new SecondFactorSignInError("challenge_expired", "This sign-in has expired. Sign in again.");

export type SecondFactorSignInAnswer = { totp: string } | { backupCode: string } | { webauthn: PasskeyAssertionResponse };

/** `{ recovery: true }` and nothing else: the second step is answered by finishing a recovery request. */
export function isSecondFactorRecoveryAnswer(body: unknown): boolean {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return record.recovery === true && record.code === undefined && record.totp === undefined
    && record.backupCode === undefined && record.webauthn === undefined;
}

/**
 * `{ code }` (or `{ totp }`, its earlier name), `{ backupCode }` or
 * `{ webauthn }`: exactly one, well-formed; null otherwise (`code` and
 * `totp` together count as two).
 */
export function parseSecondFactorSignInAnswer(body: unknown): SecondFactorSignInAnswer | null {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "" ? value : null;
  const code = text(record.code);
  const totpField = text(record.totp);
  const totp = code ?? totpField;
  const backupCode = text(record.backupCode);
  const webauthn = record.webauthn === undefined ? null : parsePasskeyAssertionResponse(record.webauthn);
  if (record.webauthn !== undefined && !webauthn) return null;
  const given = [code, totpField, backupCode, webauthn].filter((answer) => answer !== null).length;
  if (given !== 1) return null;
  if (totp) return { totp };
  if (backupCode) return { backupCode };
  return { webauthn: webauthn! };
}

/**
 * POST /api/auth/second-factor/passkeys/assertion/options { challenge }:
 * assertion options for the person a live second-factor sign-in challenge
 * belongs to, bound to that challenge (passkeys.ts). Takes no attempt; the
 * answer at /verify does.
 */
export async function startSignInPasskeyAssertion(challenge: AuthChallengeToken, now: Date = currentDate()) {
  const live = await findLiveAuthChallenge(getDb(), challenge, "second_factor_login", now);
  if (!live?.userId) throw challengeExpired();
  if (live.attempts >= AUTH_CHALLENGE_MAX_ATTEMPTS) {
    throw new SecondFactorSignInError("challenge_attempts_exhausted", "Too many wrong codes for this sign-in. Sign in again.");
  }
  const rp = webauthnRelyingParty();
  if (!rp) throw new SecondFactorSignInError("passkeys_unavailable", "Passkeys are not available right now.");
  const started = await startPasskeyAssertion(rp, { userId: live.userId, binding: { signInChallengeId: live.id }, now });
  if (!started) throw new SecondFactorSignInError("passkey_not_found", "There is no passkey on this account.");
  return started;
}

/**
 * The flow's own finish, run inside the verify transaction after the answer
 * was accepted: commit what the first step deferred and create the session
 * with `proof`. Made by the caller's `prepare` (which may do work outside
 * the transaction first, and may throw to refuse).
 */
export type SignInFinish<T> = (tx: DatabaseExecutor, proof: SessionIssueProof) => Promise<T>;

export type SecondFactorSignInVerified<T> = {
  context: SecondFactorSignInContext;
  /** What answered: a factor, or `recovery` (completeSecondFactorRecoverySignIn). */
  method: SignInChallengeMethod;
  result: T;
  /** After a backup code: how many unused ones are left. */
  backupCodesRemaining: number | null;
};

/** Thrown inside the transaction to roll it back on a wrong answer; mapped after. */
class WrongAnswer extends Error {}

async function lockRefusal(userId: string, lockedUntil: Date, lockStarted: boolean): Promise<SecondFactorSignInError> {
  if (lockStarted) {
    const [user] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName })
      .from(users).where(eq(users.id, userId));
    if (user?.email) {
      try {
        await sendSecondFactorSignInLockedEmail(user.email, user.displayName || user.name, Math.round(SECOND_FACTOR_LOCK_MS / 60_000));
      } catch (err) {
        console.error(`[second-factor] sign-in lock email to ${userId} failed:`, err);
      }
    }
  }
  return new SecondFactorSignInError("second_factor_locked", "Too many wrong codes. Try again later.", {
    lockedUntil: lockedUntil.toISOString(),
    methods: await signInSecondFactorMethods(userId),
  });
}

async function readTotpSecret(userId: string): Promise<{ secret: string; ciphertext: string; lastUsedStep: number | null } | null> {
  const [row] = await getDb().select({ ciphertext: userTotp.secretCiphertext, lastUsedStep: userTotp.lastUsedStep })
    .from(userTotp).where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
  if (!row) return null;
  try {
    return { secret: decryptTotpSecret(row.ciphertext, userId), ciphertext: row.ciphertext, lastUsedStep: row.lastUsedStep };
  } catch (err) {
    if (err instanceof TotpSecretCryptoError && err.code === "totp_secret_key_missing") {
      throw new SecondFactorSignInError("second_factor_unavailable", "Two-step verification is not available right now.");
    }
    return null;
  }
}

/**
 * Answer a second-factor sign-in challenge (order in the file comment).
 * `codeVerifier`: a mobile handoff's PKCE verifier, required for that flow.
 * `prepare` gets the challenge's context once both attempts are claimed and
 * returns the flow's finish for the transaction.
 */
export async function verifySecondFactorSignIn<T>(
  input: { challenge: AuthChallengeToken; answer: SecondFactorSignInAnswer; codeVerifier?: string | null; now?: Date },
  prepare: (context: SecondFactorSignInContext, userId: string) => Promise<SignInFinish<T>>,
): Promise<SecondFactorSignInVerified<T>> {
  const now = input.now ?? currentDate();
  const kind = "second_factor_login";
  const live = await findLiveAuthChallenge(getDb(), input.challenge, kind, now);
  if (!live?.userId) throw challengeExpired();
  if (live.attempts >= AUTH_CHALLENGE_MAX_ATTEMPTS) {
    throw new SecondFactorSignInError("challenge_attempts_exhausted", "Too many wrong codes for this sign-in. Sign in again.");
  }
  const userId = live.userId;
  const rp = "webauthn" in input.answer ? webauthnRelyingParty() : null;
  if ("webauthn" in input.answer && !rp) throw new SecondFactorSignInError("passkeys_unavailable", "Passkeys are not available right now.");

  const claim = await claimSecondFactorAttempt(getDb(), userId, now);
  if (!claim.ok) throw await lockRefusal(userId, claim.lockedUntil, claim.lockStarted);

  const claimed = await claimAuthChallengeAttempt(getDb(), input.challenge, kind, now);
  if (!claimed) {
    const after = await findLiveAuthChallenge(getDb(), input.challenge, kind, now);
    if (after && after.attempts >= AUTH_CHALLENGE_MAX_ATTEMPTS) {
      throw new SecondFactorSignInError("challenge_attempts_exhausted", "Too many wrong codes for this sign-in. Sign in again.");
    }
    throw challengeExpired();
  }
  const context = parseContext(claimed);
  if (!context || claimed.userId !== userId) throw challengeExpired();
  if ((context.flow === "mobile_social_login" || (context.flow === "sso_login" && context.codeChallenge !== null))
    && (!input.codeVerifier || pkceS256Challenge(input.codeVerifier) !== context.codeChallenge)) {
    throw new SecondFactorSignInError("pkce_mismatch", "PKCE verifier did not match the OAuth request");
  }

  const method: SignInSecondFactorMethod = "totp" in input.answer ? "totp" : "webauthn" in input.answer ? "passkey" : "backup_code";
  let totpStep: number | null = null;
  let verifiedTotpCiphertext: string | null = null;
  let passkey: CheckedPasskeyAssertion | null = null;
  if ("webauthn" in input.answer) {
    passkey = await checkPasskeyAssertion(rp!, { userId, binding: { signInChallengeId: claimed.id }, response: input.answer.webauthn, now });
    if (!passkey) throw new SecondFactorSignInError("second_factor_code_invalid", "That passkey didn't work. Try again.");
  } else if ("totp" in input.answer) {
    const stored = await readTotpSecret(userId);
    const checked = stored ? verifyTotp({ secret: stored.secret, code: input.answer.totp, now, lastUsedStep: stored.lastUsedStep }) : null;
    if (!checked?.ok) {
      throw new SecondFactorSignInError("second_factor_code_invalid", "That code didn't work. Check your authenticator app and try again.");
    }
    totpStep = checked.step;
    verifiedTotpCiphertext = stored!.ciphertext;
  }

  const finish = await prepare(context, userId);
  let counterRegressed = false;
  let recoveryCancelled: RecoveryAutoCancelled = null;
  let backupCodeUsed: BackupCodeUse | null = null;
  try {
    const verified = await getDb().transaction(async (tx) => {
      const consumed = await consumeAuthChallenge(tx, input.challenge, kind, now);
      if (!consumed) throw challengeExpired();
      let backupCodesRemaining: number | null = null;
      if (passkey) {
        const used = await recordPasskeyUse(tx, { userId, checked: passkey, now, sessionFamilyId: null, context: "sign_in" });
        // Removed in between.
        if (!used.recorded) throw new WrongAnswer();
        counterRegressed = used.counterRegressed;
      } else if ("backupCode" in input.answer) {
        const used = await consumeBackupCode(tx, userId, input.answer.backupCode, now);
        if (!used.ok) throw new WrongAnswer();
        backupCodesRemaining = used.remaining;
        backupCodeUsed = { context: "sign_in", remaining: used.remaining, sessionFamilyId: null, signInFlow: context.flow };
        await recordBackupCodeUse(tx, userId, backupCodeUsed);
      } else if (!(await recordTotpStep(tx, userId, totpStep!, verifiedTotpCiphertext!))) {
        // The code was used or the verified secret was replaced in between.
        throw new WrongAnswer();
      }
      await releaseSecondFactorAttempt(tx, userId, now);
      recoveryCancelled = await autoCancelRecoveryInTransaction(tx, userId, now);
      const result = await finish(tx, proofForSecondFactorVerified(consumed, method));
      return { context, method, result, backupCodesRemaining };
    });
    if (counterRegressed) await sendPasskeyCounterWarning(userId);
    if (backupCodeUsed) await sendBackupCodeUsedEmail(userId, backupCodeUsed);
    await afterRecoveryAutoCancel(recoveryCancelled);
    return verified;
  } catch (err) {
    if (!(err instanceof WrongAnswer)) throw err;
    if (passkey) throw new SecondFactorSignInError("second_factor_code_invalid", "That passkey didn't work. Try again.");
    if ("backupCode" in input.answer) {
      if (await isUsedBackupCode(getDb(), userId, input.answer.backupCode)) {
        throw new SecondFactorSignInError("backup_code_used", "That backup code was already used.");
      }
      throw new SecondFactorSignInError("second_factor_code_invalid", "That backup code didn't work.");
    }
    throw new SecondFactorSignInError("second_factor_code_invalid", "That code didn't work. Check your authenticator app and try again.");
  }
}

/**
 * POST /verify { challenge, recovery: true }: the second step of a
 * first-factor sign-in answered by finishing the person's recovery request
 * (recovery.ts, step 5). Like verifySecondFactorSignIn but with no factor to
 * check (so the person's attempt window, which counts wrong codes, is not
 * claimed): refused before anything is claimed when no request can be
 * finished now; then one attempt at the challenge is claimed and committed;
 * then ONE transaction: the challenge consumed, the request completed by
 * compare-and-set with every factor removed and every family revoked
 * (completeRecoveryInTransaction), then the flow's own finish with a
 * `not_required` proof (proofForSecondFactorRecovered: there is no second
 * factor any more). After commit: the security-revoke cascade and the email
 * (runRecoveryCompletedEffects).
 */
export async function completeSecondFactorRecoverySignIn<T>(
  input: { challenge: AuthChallengeToken; codeVerifier?: string | null; now?: Date },
  prepare: (context: SecondFactorSignInContext, userId: string) => Promise<SignInFinish<T>>,
): Promise<SecondFactorSignInVerified<T>> {
  const now = input.now ?? currentDate();
  const kind = "second_factor_login";
  const live = await findLiveAuthChallenge(getDb(), input.challenge, kind, now);
  if (!live?.userId) throw challengeExpired();
  if (live.attempts >= AUTH_CHALLENGE_MAX_ATTEMPTS) {
    throw new SecondFactorSignInError("challenge_attempts_exhausted", "Too many wrong codes for this sign-in. Sign in again.");
  }
  const userId = live.userId;
  try {
    await assertRecoveryFinishable(userId, now);
  } catch (err) {
    throw recoveryRefusal(err);
  }

  const claimed = await claimAuthChallengeAttempt(getDb(), input.challenge, kind, now);
  if (!claimed) throw challengeExpired();
  const context = parseContext(claimed);
  if (!context || claimed.userId !== userId) throw challengeExpired();
  if ((context.flow === "mobile_social_login" || (context.flow === "sso_login" && context.codeChallenge !== null))
    && (!input.codeVerifier || pkceS256Challenge(input.codeVerifier) !== context.codeChallenge)) {
    throw new SecondFactorSignInError("pkce_mismatch", "PKCE verifier did not match the OAuth request");
  }

  const finish = await prepare(context, userId);
  let verified: SecondFactorSignInVerified<T>;
  try {
    verified = await getDb().transaction(async (tx) => {
      const consumed = await consumeAuthChallenge(tx, input.challenge, kind, now);
      if (!consumed) throw challengeExpired();
      await completeRecoveryInTransaction(tx, { userId, flow: context.flow, now });
      const result = await finish(tx, proofForSecondFactorRecovered(consumed));
      return { context, method: "recovery" as const, result, backupCodesRemaining: null };
    });
  } catch (err) {
    throw recoveryRefusal(err);
  }
  await runRecoveryCompletedEffects(userId);
  return verified;
}

function recoveryRefusal(err: unknown): unknown {
  if (err instanceof RecoveryError && (err.code === "recovery_not_found" || err.code === "recovery_not_ready")) {
    return new SecondFactorSignInError(err.code, err.message, err.extra);
  }
  return err;
}
