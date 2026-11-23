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
 * RP IDs (webauthn.ts WEBAUTHN_LEGACY_RP_ID): one ceremony asks under one
 * RP ID, so options offer one group of the person's passkeys (current or
 * legacy, passkeyRpGroup): the group asked for (`rp`), else current when
 * the person has any there, else legacy. With a legacy RP ID set, the
 * challenge records the RP ID it was issued under (payload `rpId`; absent =
 * WEBAUTHN_RP_ID, as every challenge before). The check verifies with the
 * named passkey's own RP ID and refuses one that is not the challenge's.
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
import { addTraceEvent } from "../../tracing/semanticTrace";
import { sendSecondFactorChangeEmail } from "../emailService";
import { recordIntegrationAuditEvent } from "../integrationAuditService";
import { consumeAuthChallenge, createAuthChallenge, parseAuthChallengeToken, type AuthChallengeRow } from "./authChallenges";
import {
  assertionCredentialId,
  ceremonyChallenge,
  effectivePasskeyRpId,
  passkeyAssertionOptions,
  passkeyRpGroup,
  verifyPasskeyAssertion,
  type PasskeyAssertionResponse,
  type PasskeyRpGroup,
  type RelyingParty,
  type StoredPasskey,
} from "./webauthn";

export const PASSKEY_CEREMONY_TTL_MS = 5 * 60_000;

type ActivePasskey = StoredPasskey & { id: string; signCount: number; rpId: string | null };

const activeColumns = {
  id: webauthnCredentials.id,
  credentialId: webauthnCredentials.credentialId,
  publicKey: webauthnCredentials.publicKey,
  transports: webauthnCredentials.transports,
  signCount: webauthnCredentials.signCount,
  rpId: webauthnCredentials.rpId,
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

/**
 * What an assertion challenge answers (see the file comment).
 * `appStepUpRequestId`: one app step-up request answered on the web
 * (services/appStepUpService.ts); its challenge is its own kind
 * (`webauthn_app_step_up`), so it never answers a family-bound or sign-in
 * ceremony, nor they it.
 */
export type PasskeyAssertionBinding = { familyId: string } | { signInChallengeId: string } | { appStepUpRequestId: string };

function bindingPayload(binding: PasskeyAssertionBinding): AuthChallengePayload {
  if ("familyId" in binding) return { familyId: binding.familyId };
  if ("appStepUpRequestId" in binding) return { appStepUpRequestId: binding.appStepUpRequestId };
  return { signInChallengeId: binding.signInChallengeId };
}

function challengeKind(binding: PasskeyAssertionBinding): "webauthn_assertion" | "webauthn_app_step_up" {
  return "appStepUpRequestId" in binding ? "webauthn_app_step_up" : "webauthn_assertion";
}

/**
 * The challenge payload's RP ID entry: only with a legacy RP ID set, so a
 * server without one writes exactly what it wrote before.
 */
export function challengeRpPayload(rp: RelyingParty, rpId: string): AuthChallengePayload {
  return rp.legacyRpID === undefined ? {} : { rpId };
}

/** The RP ID a challenge was issued under (absent: WEBAUTHN_RP_ID, see the file comment). */
export function challengeRpId(rp: RelyingParty, challenge: Pick<AuthChallengeRow, "payload">): string {
  const recorded = challenge.payload?.rpId;
  return typeof recorded === "string" ? recorded : rp.rpID;
}

/**
 * The person's passkeys by group (passkeyRpGroup; one whose RP ID is neither
 * configured one is in none).
 */
export function groupPasskeys<T extends { rpId: string | null }>(rp: RelyingParty, passkeys: T[]): Record<PasskeyRpGroup, T[]> {
  const groups: Record<PasskeyRpGroup, T[]> = { current: [], legacy: [] };
  for (const passkey of passkeys) {
    const group = passkeyRpGroup(rp, passkey.rpId);
    if (group) groups[group].push(passkey);
  }
  return groups;
}

export type StartedPasskeyAssertion = {
  options: Awaited<ReturnType<typeof passkeyAssertionOptions>>;
  /** The group the options are for; present only with a legacy RP ID set. */
  rp?: PasskeyRpGroup;
  /**
   * The other groups the person has an active passkey in (names only, never
   * credential ids), so a client whose first ask found nothing can offer
   * "use an earlier passkey". Present only with a legacy RP ID set and such a
   * group. Only these signed-in or password-identified options carry it,
   * never the anonymous passkey sign-in (it would tell anyone whether an
   * account has old passkeys).
   */
  otherRps?: PasskeyRpGroup[];
};

/**
 * Why there are no options: `none`, the person has no passkey that can
 * answer at all; `group_empty`, none in the group asked for, but some in
 * `available` (e.g. iOS asks for `current` and the person has only legacy
 * passkeys: it sends them to the web instead).
 */
export type NoPasskeyAssertion = { refused: "none" } | { refused: "group_empty"; rp: PasskeyRpGroup; available: PasskeyRpGroup[] };

/**
 * New assertion options for `userId`, bound to `binding`: allowCredentials
 * are the person's passkeys in one group (`rp`, else the default in the file
 * comment), user verification required.
 */
export async function startPasskeyAssertion(
  rp: RelyingParty,
  input: { userId: string; binding: PasskeyAssertionBinding; now: Date; rp?: PasskeyRpGroup },
): Promise<StartedPasskeyAssertion | NoPasskeyAssertion> {
  const groups = groupPasskeys(rp, await activePasskeys(getDb(), input.userId));
  const available = (["current", "legacy"] as const).filter((group) => groups[group].length > 0);
  if (available.length === 0) return { refused: "none" };
  const group = input.rp ?? available[0]!;
  if (groups[group].length === 0) return { refused: "group_empty", rp: group, available };
  const rpID = group === "current" ? rp.rpID : rp.legacyRpID!;
  const created = await createAuthChallenge({
    kind: challengeKind(input.binding),
    userId: input.userId,
    payload: { ...bindingPayload(input.binding), ...challengeRpPayload(rp, rpID) },
    ttlMs: PASSKEY_CEREMONY_TTL_MS,
    now: input.now,
  });
  const options = await passkeyAssertionOptions(rp, { challenge: created.challenge, allow: groups[group], rpID });
  if (rp.legacyRpID === undefined) return { options };
  const otherRps = available.filter((other) => other !== group);
  return otherRps.length > 0 ? { options, rp: group, otherRps } : { options, rp: group };
}

export type CheckedPasskeyAssertion = {
  passkeyId: string;
  storedCounter: number;
  counter: number;
  backupState: boolean;
  /** The group the passkey answered in. */
  rpGroup: PasskeyRpGroup;
  /** Answered from a web origin (not the Android app). */
  webOrigin: boolean;
};

/**
 * A verified passkey, ready for recordPasskeyUse: verified with its own RP
 * ID, which must be the one `challenge` was issued under (a challenge from
 * one group never answers with a passkey of the other). Null when it does
 * not verify.
 */
export async function verifyStoredPasskey(
  rp: RelyingParty,
  input: { response: PasskeyAssertionResponse; challenge: string; challengeRpId: string; passkey: ActivePasskey },
): Promise<CheckedPasskeyAssertion | null> {
  const { passkey } = input;
  const rpGroup = passkeyRpGroup(rp, passkey.rpId);
  const rpID = effectivePasskeyRpId(rp, passkey.rpId);
  if (!rpGroup || rpID !== input.challengeRpId) return null;
  const verified = await verifyPasskeyAssertion(rp, input.response, input.challenge, passkey, rpID);
  if (!verified) return null;
  return {
    passkeyId: passkey.id,
    storedCounter: passkey.signCount,
    counter: verified.counter,
    backupState: verified.backupState,
    rpGroup,
    webOrigin: verified.webOrigin,
  };
}

/**
 * Trace event for a verified passkey: which RP group answered (counts how
 * much the legacy RP ID is still used) and whether from the web.
 * Active legacy passkeys left, with WEBAUTHN_LEGACY_RP_ID = 'raft.build':
 *   SELECT count(*) FROM webauthn_credentials
 *   WHERE revoked_at IS NULL AND (rp_id IS NULL OR rp_id = 'raft.build');
 */
export function tracePasskeyVerified(checked: CheckedPasskeyAssertion, context: PasskeyUseContext): void {
  addTraceEvent("auth.passkey.verified", {
    context,
    rp_group: checked.rpGroup,
    web_origin: checked.webOrigin,
  });
}

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
  const consumed = await consumeAuthChallenge(getDb(), challenge, challengeKind(input.binding), input.now);
  const expected = bindingPayload(input.binding);
  if (!consumed || consumed.userId !== input.userId) return null;
  const { rpId: _rpId, ...payload } = consumed.payload ?? {};
  if (Object.keys(expected).length !== Object.keys(payload).length || Object.entries(expected).some(([key, value]) => payload[key] !== value)) return null;

  const [passkey] = await getDb().select(activeColumns).from(webauthnCredentials)
    .where(and(active(input.userId), eq(webauthnCredentials.credentialId, assertionCredentialId(input.response))));
  if (!passkey) return null;
  return verifyStoredPasskey(rp, { response: input.response, challenge, challengeRpId: challengeRpId(rp, consumed), passkey });
}

/** What a verified passkey answered (trace and counter-regression audit). */
export type PasskeyUseContext = "sign_in" | "passkey_sign_in" | "step_up" | "app_web_step_up";

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
  input: { userId: string; checked: CheckedPasskeyAssertion; now: Date; sessionFamilyId: string | null; context: PasskeyUseContext },
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
  tracePasskeyVerified(checked, input.context);
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
