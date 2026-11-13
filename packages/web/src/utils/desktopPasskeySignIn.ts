// Passkey sign-in in Raft Desktop (design v2 A5, D8, Q1, Q7).
//
// Desktop's page (app://raft) can't use WebAuthn, so the passkey is used in the
// system browser through the app-login handoff, received on a 127.0.0.1
// loopback like Desktop's social sign-in (desktopOAuth.ts, the same one live
// attempt and its "Waiting for your browser… Cancel"):
//   1. POST /auth/app-login/start { returnUri: http://127.0.0.1:<port>/callback,
//      codeChallenge (S256), clientId: "raft-desktop" } → { requestId, loginUrl };
//   2. the browser opens loginUrl (+ `method=passkey`, a hint older web
//      sign-in pages read to show "Sign In with a Passkey"; the current one
//      shows it in every browser that can use passkeys), signs in
//      and confirms; the server sends it to the loopback with
//      `requestId` and a one-time `code` (2 minutes) or an `error`;
//   3. POST /auth/app-login/complete { code, codeVerifier, returnUri } → the
//      password sign-in's body. The session inherits the browser's second
//      step, and a passkey counts as both factors, so no second step follows.
//
// The shell half is optional (DesktopAuthBridge.beginAppLoginLoopback /
// openAppLoginUrl): on a shell without it nothing here is offered.
//
// D8 (A): "Sign In with a Passkey" shows in Desktop only once this Desktop knows
// an account that signs in here has a passkey: a handoff succeeded once, or a
// signed-in account's status listed passkeys. The record outlives sign-out and
// names no account.

import { useEffect } from "react";
import type { IntlShape } from "react-intl";
import api from "../api/client";
import { forwardToast } from "../components/message/forwardToast";
import { fetchSecondFactorStatus } from "../components/settings/secondFactorApi";
import { useAuthStore } from "../store/authStore";
import type { User } from "../store/authStore";
import { getApiErrorResponse } from "./apiErrorResponse";
import {
  attemptDeps,
  beginAttempt,
  getDesktopAuth,
  markAttemptCompleting,
  pkceChallenge,
  providerErrorCodeFromFailure,
  randomBase64Url,
  settleAttempt,
} from "./desktopOAuth";
import type { DesktopOAuthDeps } from "./desktopOAuth";

type FormatMessage = IntlShape["formatMessage"];

/** The live attempt's `provider` while a passkey handoff waits (DesktopSignInWaiting). */
export const DESKTOP_PASSKEY_PROVIDER = "passkey";

/** The app-login client Desktop is registered as (server APP_LOGIN_CLIENTS). */
const DESKTOP_APP_LOGIN_CLIENT_ID = "raft-desktop";

/** Whether this is Raft Desktop with the shell half of the handoff. */
export function canUseDesktopPasskeyHandoff(): boolean {
  const auth = getDesktopAuth();
  return typeof auth?.beginAppLoginLoopback === "function" && typeof auth.openAppLoginUrl === "function";
}

// ── D8: the local record ──

const ACCOUNT_RECORD_KEY = "raft.passkey.desktop-account";

/** An account that signs in on this Desktop has a passkey (no account kept). */
export function rememberDesktopPasskeyAccount(): void {
  try {
    localStorage.setItem(ACCOUNT_RECORD_KEY, "1");
  } catch {
    // Storage off: the link stays hidden; the second step still offers the handoff.
  }
}

export function desktopPasskeyAccountRecorded(): boolean {
  try {
    return localStorage.getItem(ACCOUNT_RECORD_KEY) === "1";
  } catch {
    return false;
  }
}

/** Show "Sign In with a Passkey" on Desktop's sign-in page. */
export function desktopPasskeySignInShown(): boolean {
  return canUseDesktopPasskeyHandoff() && desktopPasskeyAccountRecorded();
}

/**
 * Signed in on Desktop: write the record once the account's status lists a
 * passkey. One status read per signed-in person until it is written; a
 * status that can't be read (the flag off answers 404) writes nothing.
 */
export function useRememberDesktopPasskeyAccount(userId: string | null): void {
  useEffect(() => {
    if (!userId || !canUseDesktopPasskeyHandoff() || desktopPasskeyAccountRecorded()) return undefined;
    let cancelled = false;
    fetchSecondFactorStatus().then((status) => {
      if (!cancelled && (status?.methods?.passkeys ?? 0) > 0) rememberDesktopPasskeyAccount();
    }, () => {});
    return () => { cancelled = true; };
  }, [userId]);
}

// ── The flow ──

export interface DesktopPasskeyLeg {
  code: string;
  codeVerifier: string;
  returnUri: string;
}

/** The browser URL with the Q7 hint, for sign-in pages before the link showed everywhere (#triage:5c43fdb1). */
export function withPasskeyHint(loginUrl: string): string {
  const url = new URL(loginUrl);
  url.searchParams.set("method", "passkey");
  return url.toString();
}

/**
 * The browser leg, up to the one-time code: arm the loopback, register the
 * request, open the confirm page, await the callback for that request. Any
 * failure ends the attempt.
 */
export async function desktopPasskeyLeg(deps: DesktopOAuthDeps): Promise<DesktopPasskeyLeg> {
  const { auth } = deps;
  if (!auth.beginAppLoginLoopback || !auth.openAppLoginUrl) throw new Error("app_login_unavailable");
  const codeVerifier = randomBase64Url(32); // 43 base64url chars
  const codeChallenge = await pkceChallenge(codeVerifier);
  const { attemptId, returnUri } = await auth.beginAppLoginLoopback();
  deps.onAttempt?.(attemptId);
  try {
    const started = await deps.post("/auth/app-login/start", {
      returnUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      clientId: DESKTOP_APP_LOGIN_CLIENT_ID,
    }) as { requestId?: unknown; loginUrl?: unknown } | null;
    if (typeof started?.requestId !== "string" || typeof started.loginUrl !== "string") throw new Error("app_login_bad_start_response");
    await auth.openAppLoginUrl(attemptId, { requestId: started.requestId, loginUrl: withPasskeyHint(started.loginUrl) });
    const callback = await auth.awaitCallback(attemptId);
    // Defence in depth, as the social leg's state: main accepts only this request's callback.
    if (callback.state !== started.requestId) throw new Error("app_login_request_mismatch");
    return { code: callback.code, codeVerifier, returnUri };
  } catch (err) {
    auth.cancel(attemptId);
    throw err;
  }
}

type SessionBody = { user: User; accessToken: string; refreshToken: string };

/** Exchange the code; the return URI is required for a loopback client. */
export async function completeDesktopPasskeySignIn(deps: Pick<DesktopOAuthDeps, "post">, leg: DesktopPasskeyLeg): Promise<SessionBody> {
  const body = await deps.post("/auth/app-login/complete", {
    code: leg.code,
    codeVerifier: leg.codeVerifier,
    returnUri: leg.returnUri,
  }) as Partial<SessionBody> | null;
  if (!body || typeof body.accessToken !== "string" || typeof body.refreshToken !== "string" || !body.user) {
    throw new Error("app_login_bad_complete_response");
  }
  return body as SessionBody;
}

// ── Failure copy ──

/**
 * One line for a failed handoff: the browser's cancel or an expired / used
 * request says so; anything else (the loopback, the network) is the generic
 * line.
 */
export function describeDesktopPasskeyFailure(err: unknown, formatMessage: FormatMessage): string {
  const callbackError = providerErrorCodeFromFailure(err);
  const apiCode = getApiErrorResponse(err)?.code;
  if (callbackError === "access_denied") return formatMessage({ id: "auth.desktopPasskey.denied" });
  if (callbackError === "expired" || apiCode === "code_expired") return formatMessage({ id: "auth.desktopSignIn.expired" });
  if (apiCode === "code_consumed") return formatMessage({ id: "auth.desktopSignIn.requestNotPending" });
  return formatMessage({ id: "auth.desktopPasskey.failed" });
}

const appPost = async (path: string, body: Record<string, unknown>) => (await api.post(path, body)).data;

/**
 * "Sign In with a Passkey" in Raft Desktop (the sign-in page, or "Use a
 * Passkey" in the second step, which drops its challenge first). Ends signed
 * in, or with a toast saying why not; Cancel and a newer click end it quietly.
 */
export async function runDesktopPasskeySignIn(formatMessage: FormatMessage): Promise<void> {
  const auth = getDesktopAuth();
  if (!auth || !canUseDesktopPasskeyHandoff()) return;
  const attempt = beginAttempt(auth, "signIn", DESKTOP_PASSKEY_PROVIDER);
  if (!attempt) return;
  try {
    const leg = await desktopPasskeyLeg(attemptDeps(attempt));
    if (attempt.ended) return;
    markAttemptCompleting(attempt);
    const body = await completeDesktopPasskeySignIn({ post: appPost }, leg);
    useAuthStore.getState().applySignIn(body);
    rememberDesktopPasskeyAccount();
  } catch (err) {
    if (attempt.ended) return;
    console.error("[raft-desktop] desktop passkey sign-in failed", err);
    forwardToast.error(describeDesktopPasskeyFailure(err, formatMessage), { dismissible: true });
  } finally {
    settleAttempt(attempt);
  }
}
