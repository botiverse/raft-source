/**
 * App step-up with a legacy passkey on the web (docs/contracts/app-web-step-up.md).
 *
 * An app session whose person has only legacy passkeys (RP ID
 * WEBAUTHN_LEGACY_RP_ID, which iOS and the Mac app cannot ask for natively)
 * verifies on the web instead:
 *   1. start (the app's bearer, sign-in F of person U): an
 *      `app_login_requests` row, purpose `step_up`, bound to (U, F), with the
 *      app's PKCE challenge and a registry return URI (mobile and Mac only);
 *      5 minutes. Any earlier open step-up for F is denied.
 *   2. the page /login/app/verify?request=R (no web sign-in needed) shows
 *      the account and the action, then asks for one of U's legacy passkeys
 *      under a challenge of its own kind bound to R (passkeys.ts
 *      `{ appStepUpRequestId }`), answered from a WEBAUTHN_ORIGINS origin;
 *      the row goes pending -> approved (approved_at = the assertion's time)
 *      with a one-time code, sent only to the return URI.
 *   3. complete (the app's bearer, which must be F of U again, plus the PKCE
 *      verifier and the code within 2 minutes): approved -> completed, and F's
 *      second_factor_verified_at becomes approved_at (never later: the
 *      step-up window is not extended by the handoff).
 * Nothing marks F verified before step 3, so someone holding F's tokens who
 * sends U the genuine link gains nothing: the code reaches only U's own app,
 * which is not waiting for it, and there is no status endpoint.
 *
 * Behind the flag `app_web_step_up_v1` (by person, default off): while off
 * for U, start answers 404 `not_enabled` and every other step "not found".
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseTransaction } from "../db/index";
import { appLoginRequests, sessionFamilies, users } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import {
  APP_LOGIN_CLIENTS,
  APP_LOGIN_CODE_TTL_MS,
  allowedAppLoginReturnUris,
  callbackUrl,
  loadPending,
  storedClient,
  type AppLoginClient,
} from "./appLoginService";
import { evaluateFeatureFlag, APP_WEB_STEP_UP_FEATURE_FLAG_KEY } from "./featureFlagService";
import { hashOneTimeCode, isPkceChallenge, pkceVerifierMatches } from "./loopbackRedirect";
import { SecondFactorError, parseStepUpAnswer, withSecondFactorAnswer } from "./secondFactor/management";
import { groupPasskeys, activePasskeys, startPasskeyAssertion, type StartedPasskeyAssertion } from "./secondFactor/passkeys";
import { maskEmail } from "./secondFactor/signIn";
import { STEP_UP_ACTIONS, type StepUpAction } from "./secondFactor/stepUpGate";
import { webauthnRelyingParty } from "./secondFactor/webauthn";
import { isApprovingSessionLive } from "./sessionService";

/** A step-up request lives as long as its passkey ceremony may (PASSKEY_CEREMONY_TTL_MS). */
export const APP_STEP_UP_REQUEST_TTL_MS = 5 * 60_000;

/** Only the native apps with a custom scheme: never Raft Desktop's loopback (it has no step-up here). */
const STEP_UP_CLIENT_IDS: ReadonlySet<string> = new Set(["raft-app", "raft-mac"]);

/** The registry client of `uri` when it may receive a step-up's code, else null. */
export function appStepUpClientForReturnUri(uri: string, env: NodeJS.ProcessEnv = process.env): AppLoginClient | null {
  if (!allowedAppLoginReturnUris(env).includes(uri)) return null;
  const entry = APP_LOGIN_CLIENTS.find((client) => STEP_UP_CLIENT_IDS.has(client.id) && client.returnUris.includes(uri));
  return entry ? { id: entry.id, name: entry.name } : null;
}

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(STEP_UP_ACTIONS, value);
}

export async function isAppWebStepUpEnabled(userId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: APP_WEB_STEP_UP_FEATURE_FLAG_KEY, userId })).enabled === true;
  } catch {
    return false;
  }
}

function trace(stage: "start" | "verify" | "complete" | "cancel", attrs: Record<string, string | boolean> = {}): void {
  addTraceEvent("auth.app_web_step_up", { stage, ...attrs });
}

export type AppStepUpStartError =
  | "not_enabled"
  | "return_uri_not_allowed"
  | "client_mismatch"
  | "code_challenge_invalid"
  | "invalid_action"
  | "second_factor_not_enabled"
  | "passkey_not_found";

/** Step 1, with the app's bearer: U and its live `full` sign-in F. */
export async function startAppStepUp(input: {
  userId: string;
  familyId: string;
  returnUri: string;
  codeChallenge: string;
  clientId?: string;
  action: unknown;
}): Promise<
  | { ok: true; requestId: string; expiresAt: Date; client: AppLoginClient }
  | { ok: false; error: AppStepUpStartError }
> {
  if (!(await isAppWebStepUpEnabled(input.userId))) return { ok: false, error: "not_enabled" };
  const client = appStepUpClientForReturnUri(input.returnUri);
  if (!client) return { ok: false, error: "return_uri_not_allowed" };
  if (input.clientId !== undefined && input.clientId !== client.id) return { ok: false, error: "client_mismatch" };
  if (!isPkceChallenge(input.codeChallenge)) return { ok: false, error: "code_challenge_invalid" };
  if (!isStepUpAction(input.action)) return { ok: false, error: "invalid_action" };
  const [user] = await getDb().select({ requiredAt: users.secondFactorRequiredAt }).from(users).where(eq(users.id, input.userId));
  if (!user?.requiredAt) return { ok: false, error: "second_factor_not_enabled" };
  // Only for someone with a legacy passkey: the current ones answer in the app.
  const rp = webauthnRelyingParty();
  if (!rp?.legacyRpID || groupPasskeys(rp, await activePasskeys(getDb(), input.userId)).legacy.length === 0) {
    return { ok: false, error: "passkey_not_found" };
  }
  const action = input.action;
  const now = currentDate();
  const expiresAt = new Date(now.getTime() + APP_STEP_UP_REQUEST_TTL_MS);
  const requestId = await getDb().transaction(async (tx) => {
    // One start at a time per sign-in; the earlier open (or verified, not
    // redeemed) one is denied, so its page and code stop working.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app_step_up:${input.familyId}`}, 0))`);
    await tx.update(appLoginRequests).set({ status: "denied" }).where(and(
      eq(appLoginRequests.purpose, "step_up"),
      eq(appLoginRequests.targetFamilyId, input.familyId),
      inArray(appLoginRequests.status, ["pending", "approved"]),
    ));
    const [row] = await tx.insert(appLoginRequests).values({
      purpose: "step_up",
      userId: input.userId,
      targetFamilyId: input.familyId,
      stepUpAction: action,
      codeChallenge: input.codeChallenge,
      returnUri: input.returnUri,
      expiresAt,
    }).returning({ id: appLoginRequests.id });
    return row!.id;
  });
  trace("start", { client: client.id, action });
  return { ok: true, requestId, expiresAt, client };
}

export type AppStepUpResolveError = "request_not_found" | "request_expired" | "request_already_resolved";

/** A pending step-up whose person has the flag on; "not found" otherwise. */
async function loadPendingStepUp(requestId: string) {
  const pending = await loadPending(requestId, "step_up");
  const userId = pending.ok ? pending.row.userId : pending.row?.userId;
  if (!userId || !(await isAppWebStepUpEnabled(userId))) return { ok: false as const, error: "request_not_found" as const };
  // The app's sign-in is gone (its family row deleted, target SET NULL).
  if (pending.ok && !pending.row.targetFamilyId) return { ok: false as const, error: "request_not_found" as const };
  return pending;
}

/** The expired answer: the callback that tells the app, when the row is known. */
function expiredRedirect(row: { returnUri: string }, requestId: string): string {
  return callbackUrl(row.returnUri, requestId, { error: "expired" });
}

/** What the page shows before asking for the passkey. */
export async function describeAppStepUp(requestId: string): Promise<
  | { ok: true; expiresAt: Date; createdAt: Date; client: AppLoginClient; action: StepUpAction | null; account: { name: string; maskedEmail: string } }
  | { ok: false; error: AppStepUpResolveError; cancelUrl?: string }
> {
  const pending = await loadPendingStepUp(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: false, error: pending.error, cancelUrl: expiredRedirect(pending.row!, requestId) }
      : { ok: false, error: pending.error };
  }
  const { row } = pending;
  const [user] = await getDb().select({ email: users.email, name: users.name, displayName: users.displayName })
    .from(users).where(eq(users.id, row.userId!));
  if (!user) return { ok: false, error: "request_not_found" };
  return {
    ok: true,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    client: storedClient(row.returnUri),
    action: isStepUpAction(row.stepUpAction) ? row.stepUpAction : null,
    account: { name: user.displayName || user.name, maskedEmail: maskEmail(user.email) },
  };
}

/** Passkey options for the request's person: legacy passkeys only, bound to the request. */
export async function startAppStepUpAssertion(requestId: string): Promise<
  | { ok: true; options: StartedPasskeyAssertion["options"]; rp: "legacy" }
  | { ok: false; error: AppStepUpResolveError | "passkey_not_found"; cancelUrl?: string }
> {
  const pending = await loadPendingStepUp(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: false, error: pending.error, cancelUrl: expiredRedirect(pending.row!, requestId) }
      : { ok: false, error: pending.error };
  }
  const rp = webauthnRelyingParty();
  if (!rp?.legacyRpID) return { ok: false, error: "passkey_not_found" };
  const started = await startPasskeyAssertion(rp, {
    userId: pending.row.userId!,
    binding: { appStepUpRequestId: requestId },
    now: currentDate(),
    rp: "legacy",
  });
  if ("refused" in started) return { ok: false, error: "passkey_not_found" };
  // Never `otherRps`: the page asks for this group only.
  return { ok: true, options: started.options, rp: "legacy" };
}

/**
 * The passkey answer, from the page: a legacy passkey of the request's
 * person, answering this request's challenge from a web origin
 * (WEBAUTHN_ORIGINS; not the Android app). In the transaction that records
 * the passkey's use: pending -> approved with a one-time code. F is not
 * touched here. Wrong answers are SecondFactorErrors (the person's attempt
 * window counts them) and leave the request pending.
 */
export async function verifyAppStepUp(requestId: string, body: unknown): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppStepUpResolveError; redirectUrl?: string }
> {
  const pending = await loadPendingStepUp(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: false, error: pending.error, redirectUrl: expiredRedirect(pending.row!, requestId) }
      : { ok: false, error: pending.error };
  }
  const { row } = pending;
  const targetFamilyId = row.targetFamilyId;
  if (!targetFamilyId) return { ok: false, error: "request_not_found" };
  const answer = parseStepUpAnswer(body);
  if (!answer.webauthn) throw new SecondFactorError("invalid_request", "Use a passkey.");
  const now = currentDate();
  const code = randomBytes(32).toString("base64url");
  const approved = await withSecondFactorAnswer(row.userId!, { webauthn: answer.webauthn }, now, {
    allowBackupCode: false,
    passkey: {
      familyId: targetFamilyId,
      binding: { appStepUpRequestId: requestId },
      accept: (checked) => checked.rpGroup === "legacy" && checked.webOrigin,
      context: "app_web_step_up",
    },
  }, async (tx) => {
    const [updated] = await tx.update(appLoginRequests)
      .set({ status: "approved", codeHash: hashOneTimeCode(code), approvedAt: now })
      .where(and(
        eq(appLoginRequests.id, requestId),
        eq(appLoginRequests.purpose, "step_up"),
        eq(appLoginRequests.status, "pending"),
        gt(appLoginRequests.expiresAt, now),
      ))
      .returning({ returnUri: appLoginRequests.returnUri });
    return updated ?? null;
  });
  if (!approved) return { ok: false, error: "request_already_resolved" };
  trace("verify");
  return { ok: true, redirectUrl: callbackUrl(approved.returnUri, requestId, { code }) };
}

/** Cancel on the page: the app hears `access_denied` (or `expired`). */
export async function cancelAppStepUp(requestId: string): Promise<
  | { ok: true; redirectUrl: string }
  | { ok: false; error: AppStepUpResolveError }
> {
  const pending = await loadPendingStepUp(requestId);
  if (!pending.ok) {
    return pending.error === "request_expired"
      ? { ok: true, redirectUrl: expiredRedirect(pending.row!, requestId) }
      : { ok: false, error: pending.error };
  }
  const [updated] = await getDb().update(appLoginRequests)
    .set({ status: "denied" })
    .where(and(eq(appLoginRequests.id, requestId), eq(appLoginRequests.purpose, "step_up"), eq(appLoginRequests.status, "pending")))
    .returning({ returnUri: appLoginRequests.returnUri });
  if (!updated) return { ok: false, error: "request_already_resolved" };
  trace("cancel");
  return { ok: true, redirectUrl: callbackUrl(updated.returnUri, requestId, { error: "access_denied" }) };
}

export type AppStepUpCompleteError = "not_enabled" | "code_not_found" | "code_expired" | "code_consumed" | "pkce_mismatch" | "return_uri_mismatch";

/**
 * Step 3, with the app's bearer (U, F): the code must be a step-up's for
 * exactly (U, F) (anyone else's: not found), within its 2 minutes and its
 * request's 5, with the PKCE verifier and the start's return URI; a wrong
 * verifier or return URI does not use it up. Single use (approved ->
 * completed). Then F is marked verified as of the passkey's time
 * (approved_at; a later verification of F is kept), method passkey, while
 * F is a live `full` sign-in of U's (else it answers as an expired code).
 * The person's `users` row is taken first, as every revoke takes it, so a
 * revoke of F commits before (refused) or after the mark.
 */
export async function completeAppStepUp(tx: DatabaseTransaction, input: {
  userId: string;
  familyId: string;
  code: string;
  codeVerifier: string;
  returnUri: string;
}): Promise<{ ok: true; verifiedAt: Date } | { ok: false; error: AppStepUpCompleteError }> {
  if (!(await isAppWebStepUpEnabled(input.userId))) return { ok: false, error: "not_enabled" };
  if (!input.code || input.code.length > 256) return { ok: false, error: "code_not_found" };
  const [row] = await tx.select().from(appLoginRequests)
    .where(and(eq(appLoginRequests.codeHash, hashOneTimeCode(input.code)), eq(appLoginRequests.purpose, "step_up"))).limit(1);
  if (!row || row.userId !== input.userId || row.targetFamilyId !== input.familyId) return { ok: false, error: "code_not_found" };
  if (row.status === "completed") return { ok: false, error: "code_consumed" };
  const now = currentDate().getTime();
  if (row.expiresAt.getTime() <= now) return { ok: false, error: "code_expired" };
  if (!row.approvedAt || row.approvedAt.getTime() + APP_LOGIN_CODE_TTL_MS < now) return { ok: false, error: "code_expired" };
  if (!pkceVerifierMatches(input.codeVerifier, row.codeChallenge)) return { ok: false, error: "pkce_mismatch" };
  if (input.returnUri !== row.returnUri) return { ok: false, error: "return_uri_mismatch" };
  await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1).for("update");
  if (row.status !== "approved" || !(await isApprovingSessionLive(tx, { userId: input.userId, familyId: input.familyId }))) {
    return { ok: false, error: "code_expired" };
  }
  const [consumed] = await tx.update(appLoginRequests)
    .set({ status: "completed", consumedAt: currentDate() })
    .where(and(
      eq(appLoginRequests.id, row.id),
      eq(appLoginRequests.purpose, "step_up"),
      eq(appLoginRequests.status, "approved"),
      isNull(appLoginRequests.consumedAt),
    ))
    .returning({ approvedAt: appLoginRequests.approvedAt });
  if (!consumed?.approvedAt) return { ok: false, error: "code_consumed" };
  const at = sql`${consumed.approvedAt.toISOString()}::timestamptz`;
  // Never moves an existing, later verification of F back (nor its method).
  const older = sql`(${sessionFamilies.secondFactorVerifiedAt} IS NULL OR ${sessionFamilies.secondFactorVerifiedAt} < ${at})`;
  const [marked] = await tx.update(sessionFamilies)
    .set({
      secondFactorVerifiedAt: sql`CASE WHEN ${older} THEN ${at} ELSE ${sessionFamilies.secondFactorVerifiedAt} END`,
      secondFactorMethod: sql`CASE WHEN ${older} THEN 'passkey' ELSE ${sessionFamilies.secondFactorMethod} END`,
    })
    .where(and(
      eq(sessionFamilies.id, input.familyId),
      eq(sessionFamilies.userId, input.userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
    ))
    .returning({ verifiedAt: sessionFamilies.secondFactorVerifiedAt });
  if (!marked?.verifiedAt) throw new Error("app step-up: the live sign-in could not be marked");
  trace("complete");
  return { ok: true, verifiedAt: marked.verifiedAt };
}
