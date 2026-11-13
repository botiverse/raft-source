/**
 * Resetting two-step verification by email, for someone who lost every
 * second step (#triage:#135, design v2 group d, D6 option A: email + 72
 * hours). Server: packages/server/src/routes/secondFactor.ts (file comment,
 * "Email recovery"), services/secondFactor/recovery.ts.
 *
 *   Signed out (the sign-in's second step and the emailed links):
 *     POST /auth/second-factor/recovery         { email } -> 200 { ok, message }, the same for
 *                                               every address (never says whether the account exists)
 *     POST /auth/second-factor/recovery/confirm { token } -> { recovery } (the 72-hour wait starts)
 *     POST /auth/second-factor/recovery/cancel  { token } -> { cancelled: true }
 *       400 recovery_token_invalid: unknown, used or expired.
 *   Signed in:
 *     GET    /auth/second-factor/recovery -> { recovery: RecoveryView | null }
 *     DELETE /auth/second-factor/recovery -> { cancelled, recovery: null } (one step, no step-up)
 *   Finishing is at sign-in: once ready the challenge lists `recovery` in its
 *   methods and POST /auth/second-factor/verify { challenge, recovery: true }
 *   answers like a code (secondFactorSignIn.ts verifySecondFactorSignIn);
 *   409 recovery_not_ready / recovery_not_found otherwise.
 *
 * The emailed links open `?second_factor_recovery=<token>` (confirm) and
 * `?cancel_second_factor_recovery=<token>` (cancel); their page acts only on
 * a click, so a mail scanner that opens the link changes nothing
 * (SecondFactorRecoveryLinkPage).
 */
import api from "../../api/client";

const BASE = "/auth/second-factor/recovery";

/** The token of an emailed recovery link; only parseRecoveryLinkToken makes one. */
export type SecondFactorRecoveryLinkToken = string & { readonly __secondFactorRecoveryLinkToken: unique symbol };

const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A link's token as the server issues it (43 base64url characters), else null. */
export function parseRecoveryLinkToken(value: string | null | undefined): SecondFactorRecoveryLinkToken | null {
  return typeof value === "string" && LINK_TOKEN_RE.test(value) ? value as SecondFactorRecoveryLinkToken : null;
}

/** The query parameters the emailed links open (server emailService.ts). */
export const RECOVERY_CONFIRM_PARAM = "second_factor_recovery";
export const RECOVERY_CANCEL_PARAM = "cancel_second_factor_recovery";

/** A recovery request that is waiting or ready (the server's RecoveryView, the same for web and mobile). */
export interface SecondFactorRecovery {
  /** ready: eligibleAt has passed, the next sign-in can finish it. */
  status: "waiting" | "ready";
  requestedAt: string;
  /** ISO: from then a sign-in can finish it. */
  eligibleAt: string;
  /** ISO: eligibleAt + 7 days; not finished by then, it lapses. */
  expiresAt: string;
  /** set_password: the account has no password and no connected sign-in, so it sets a password (forgot password) first. */
  firstFactorRequired: "set_password" | null;
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A RecoveryView from the server, or null for anything else (no request, or a shape this client doesn't know). */
export function parseRecovery(value: unknown): SecondFactorRecovery | null {
  if (!value || typeof value !== "object") return null;
  const view = value as Record<string, unknown>;
  if (view.status !== "waiting" && view.status !== "ready") return null;
  if (!isIsoTime(view.requestedAt) || !isIsoTime(view.eligibleAt) || !isIsoTime(view.expiresAt)) return null;
  return {
    status: view.status,
    requestedAt: view.requestedAt,
    eligibleAt: view.eligibleAt,
    expiresAt: view.expiresAt,
    firstFactorRequired: view.firstFactorRequired === "set_password" ? "set_password" : null,
  };
}

/** Asks for the emailed link. Resolves the same way whether or not the account exists. */
export async function requestSecondFactorRecovery(email: string): Promise<void> {
  await api.post(BASE, { email: email.trim() });
}

/** The confirm link's click: starts the 72-hour wait. */
export async function confirmSecondFactorRecovery(token: SecondFactorRecoveryLinkToken): Promise<SecondFactorRecovery | null> {
  const { data } = await api.post<{ recovery?: unknown }>(`${BASE}/confirm`, { token });
  return parseRecovery(data?.recovery);
}

/** The emailed cancel link's click, signed in or not. */
export async function cancelSecondFactorRecoveryByLink(token: SecondFactorRecoveryLinkToken): Promise<void> {
  await api.post(`${BASE}/cancel`, { token });
}

/** This person's waiting or ready request, or null (also a 404 while the flag is off: the caller treats a failure as nothing to show). */
export async function fetchSecondFactorRecovery(): Promise<SecondFactorRecovery | null> {
  const { data } = await api.get<{ recovery?: unknown }>(BASE);
  return parseRecovery(data?.recovery);
}

/** Cancels this person's request from a signed-in session: one step, no step-up. */
export async function cancelSecondFactorRecovery(): Promise<void> {
  await api.delete(BASE);
}
