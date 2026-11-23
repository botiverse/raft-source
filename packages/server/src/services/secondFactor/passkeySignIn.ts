/**
 * Sign-in with a passkey alone (design v8 §1, §2 D3; rollout PR 4b): a
 * discoverable-credential assertion with user verification counts as both
 * factors, so it signs in without a password and without a second step, for
 * anyone it is open to (sessionIssueGate.ts isPasskeySignInOpen: an active
 * account). Web only (conditional
 * mediation); native apps have no passkeys in v1.
 *
 *   POST /api/auth/passkey/options { rp? } (startPasskeySignIn): assertion options
 *     `{ options, expiresAt }` with an empty allowCredentials (the browser offers whatever passkey it
 *     holds for the RP ID), user verification required, and a new
 *     `auth_challenges` row (kind `webauthn_assertion`, flow `passkey_login`,
 *     no user, 5 minutes). Under WEBAUTHN_RP_ID, or with `rp: "legacy"`
 *     under WEBAUTHN_LEGACY_RP_ID (the challenge records which, payload
 *     `rpId`; the body then also carries `rp`, present only while a legacy
 *     RP ID is set). `rp: "legacy"` without one: 404 `passkey_rp_unavailable`.
 *   POST /api/auth/passkey/verify { challenge (options.challenge), response }
 *     (verifyPasskeySignIn), answered exactly like POST /api/auth/login:
 *     1. the challenge's only answer is claimed and committed
 *        (claimOnlyAuthChallengeAnswer): single use whatever the outcome;
 *     2. the passkey is found by its credential id (never by user handle),
 *        not removed; its person must be one passkey sign-in is open to;
 *     3. the assertion is verified (origin, RP ID, user verification,
 *        signature) against that passkey, with the passkey's own RP ID,
 *        which must be the one the challenge was issued under;
 *     4. ONE transaction: the challenge consumed, the gate's proof
 *        (proofForPasskeyLogin, under the person's row lock), the passkey's
 *        use recorded (counter and last used, design §5: a counter that does
 *        not go up is allowed, audited and emailed after commit), any
 *        two-step verification recovery request cancelled (recovery.ts), then
 *        the caller's finish (createSession with the proof: the new family is
 *        marked verified by passkey).
 *   Every refusal after the claim is the same `passkey_not_recognized`: an
 *   unknown or removed passkey, a person it is not open to, and a failed
 *   verification look alike (no account enumeration).
 *
 * The per-person second-step lock (attemptWindow.ts) does not apply (design
 * §3: the lock never blocks passkey sign-in, or knowing someone's password
 * would be enough to keep them out). What bounds guessing here is authLimiter,
 * single-use challenges and the signature itself.
 */
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { isPasskeySignInOpen, PASSKEY_LOGIN_FLOW, proofForPasskeyLogin, type SessionIssueProof } from "../sessionIssueGate";
import { claimOnlyAuthChallengeAnswer, consumeAuthChallenge, createAuthChallenge, type AuthChallengeToken } from "./authChallenges";
import {
  challengeRpId,
  challengeRpPayload,
  findActivePasskeyByCredentialId,
  PASSKEY_CEREMONY_TTL_MS,
  recordPasskeyUse,
  sendPasskeyCounterWarning,
  verifyStoredPasskey,
} from "./passkeys";
import { afterRecoveryAutoCancel, autoCancelRecoveryInTransaction, type RecoveryAutoCancelled } from "./recovery";
import {
  assertionCredentialId,
  passkeyAssertionOptions,
  rpIdOfGroup,
  webauthnRelyingParty,
  type PasskeyAssertionResponse,
  type PasskeyRpGroup,
  type RelyingParty,
} from "./webauthn";

export type PasskeySignInErrorCode = "passkeys_unavailable" | "passkey_rp_unavailable" | "challenge_expired" | "passkey_not_recognized";

const STATUS_OF: Record<PasskeySignInErrorCode, number> = {
  // 404, not 503: the login page asks for options on every load (browser
  // autofill), so "not configured" is an expected answer, not a server error.
  // Web pages already out read only `code` and hide the passkey entry.
  // The signed-in management routes keep 503 (a deliberate action).
  passkeys_unavailable: 404,
  // `rp: "legacy"` asked of a server without a legacy RP ID.
  passkey_rp_unavailable: 404,
  challenge_expired: 410,
  passkey_not_recognized: 401,
};

/** A refusal the route sends as `status` with `{ error, code }`. */
export class PasskeySignInError extends Error {
  readonly status: number;
  constructor(readonly code: PasskeySignInErrorCode, message: string) {
    super(message);
    this.name = "PasskeySignInError";
    this.status = STATUS_OF[code];
  }
}

const notRecognized = () => new PasskeySignInError("passkey_not_recognized", "That passkey wasn't recognized. Try another way to sign in.");
const challengeExpired = () => new PasskeySignInError("challenge_expired", "This passkey sign-in has expired. Try again.");

function relyingParty(): RelyingParty {
  const rp = webauthnRelyingParty();
  if (!rp) throw new PasskeySignInError("passkeys_unavailable", "Passkeys are not available right now.");
  return rp;
}

/** POST /api/auth/passkey/options: discoverable assertion options and their challenge. */
export async function startPasskeySignIn(now: Date = currentDate(), group: PasskeyRpGroup = "current") {
  const rp = relyingParty();
  const rpID = rpIdOfGroup(rp, group);
  if (!rpID) throw new PasskeySignInError("passkey_rp_unavailable", "There are no earlier passkeys to sign in with.");
  const payload = challengeRpPayload(rp, rpID);
  const created = await createAuthChallenge({
    kind: "webauthn_assertion",
    userId: null,
    flow: PASSKEY_LOGIN_FLOW,
    payload: Object.keys(payload).length > 0 ? payload : null,
    ttlMs: PASSKEY_CEREMONY_TTL_MS,
    now,
  });
  return {
    options: await passkeyAssertionOptions(rp, { challenge: created.challenge, allow: [], rpID }),
    expiresAt: created.expiresAt.toISOString(),
    ...(rp.legacyRpID === undefined ? {} : { rp: group }),
  };
}

/** Thrown inside the transaction to roll it back; mapped to notRecognized. */
class Refused extends Error {}

/**
 * POST /api/auth/passkey/verify (steps in the file comment). `finish` runs
 * inside the transaction with the gate's proof and issues the session.
 */
export async function verifyPasskeySignIn<T>(
  input: { challenge: AuthChallengeToken; response: PasskeyAssertionResponse; now?: Date },
  finish: (tx: DatabaseExecutor, proof: SessionIssueProof) => Promise<T>,
): Promise<T> {
  const now = input.now ?? currentDate();
  const rp = relyingParty();
  const claimed = await claimOnlyAuthChallengeAnswer(getDb(), input.challenge, "webauthn_assertion", PASSKEY_LOGIN_FLOW, now);
  if (!claimed || claimed.userId !== null) throw challengeExpired();

  const passkey = await findActivePasskeyByCredentialId(getDb(), assertionCredentialId(input.response));
  if (!passkey || !(await isPasskeySignInOpen(passkey.userId))) throw notRecognized();
  const checked = await verifyStoredPasskey(rp, { response: input.response, challenge: input.challenge, challengeRpId: challengeRpId(rp, claimed), passkey });
  if (!checked) throw notRecognized();

  let counterRegressed = false;
  let recoveryCancelled: RecoveryAutoCancelled = null;
  let result: T;
  try {
    result = await getDb().transaction(async (tx) => {
      const consumed = await consumeAuthChallenge(tx, input.challenge, "webauthn_assertion", now);
      if (!consumed) throw challengeExpired();
      // The gate locks the person's row first, like every session issuer.
      const proof = await proofForPasskeyLogin(consumed, { userId: passkey.userId, passkeyId: passkey.id }, tx);
      if (!proof) throw new Refused();
      const used = await recordPasskeyUse(tx, { userId: passkey.userId, checked, now, sessionFamilyId: null, context: "passkey_sign_in" });
      // Removed in between.
      if (!used.recorded) throw new Refused();
      counterRegressed = used.counterRegressed;
      // A passkey is a second factor too: it cancels a recovery request (recovery.ts).
      recoveryCancelled = await autoCancelRecoveryInTransaction(tx, passkey.userId, now);
      return finish(tx, proof);
    });
  } catch (err) {
    if (err instanceof Refused) throw notRecognized();
    throw err;
  }
  if (counterRegressed) await sendPasskeyCounterWarning(passkey.userId);
  await afterRecoveryAutoCancel(recoveryCancelled);
  return result;
}
