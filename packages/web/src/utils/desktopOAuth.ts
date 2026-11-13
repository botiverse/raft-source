// Social sign-in and account linking in Raft Desktop (RFC 8252: the system
// browser plus a 127.0.0.1 loopback, with PKCE and a state).
//
// The web runs the whole flow; the shell only lends the one thing a page cannot
// do — receive an HTTP callback on 127.0.0.1 (raftDesktop.auth,
// packages/shared desktopBridge.ts). The server's flow is unchanged:
//   1. POST /auth/mobile/oauth/start (sign-in) or
//      /auth/mobile/oauth/:provider/link/start (link, bearer) with the loopback
//      redirect URI (its fragment carries the state) and the S256 challenge;
//   2. the provider leg finishes in the system browser, and the server sends
//      it to the loopback with a one-time code;
//   3. POST …/complete with the code and the PKCE verifier. Tokens only ever
//      arrive here, over HTTPS — never through the browser or the shell.
//
// The flow functions take the bridge and HTTP as arguments so they are tested
// with fakes; runDesktopSocialSignIn / runDesktopAccountLink wire them to the
// app (api, authStore, the pending account link, the toast surface).

import type { DesktopAuthBridge } from "@botiverse/raft-shared";
import { useSyncExternalStore } from "react";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../i18n/messages/en";
import api from "../api/client";
import { forwardToast } from "../components/message/forwardToast";
import { useAuthStore } from "../store/authStore";
import { getDesktopBridge } from "./desktopBridge";
import { assertAccountLinkCompleted, clearPendingAccountLink, failPendingAccountLink, pendingAccountLinkFromError, setPendingAccountLink, usePendingAccountLink } from "./pendingAccountLink";
import type { PendingAccountLink } from "./pendingAccountLink";
import { readSecondFactorChallenge, startSecondFactorSignIn } from "../components/auth/secondFactorSignIn";

/** Raft Desktop's loopback, or null in a browser / the phone app. */
export function getDesktopAuth(): DesktopAuthBridge | null {
  return getDesktopBridge()?.auth ?? null;
}

// ── PKCE (Web Crypto) ──

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── The flow ──

export interface DesktopOAuthDeps {
  auth: DesktopAuthBridge;
  /** POST to the API (bearer attached when signed in); resolves the JSON body, rejects on non-2xx. */
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  /** Told the shell's attempt id as soon as the loopback is armed (so it can be cancelled); throwing ends the flow there. */
  onAttempt?: (attemptId: string) => void;
}

/**
 * One loopback round trip: begin the attempt, let `start` register it with the
 * server, open the provider page, await the code and check the state. Any
 * failure ends the attempt.
 */
async function loopbackLeg(
  deps: DesktopOAuthDeps,
  start: (body: { returnUri: string; codeChallenge: string }) => Promise<unknown>,
): Promise<{ code: string; codeVerifier: string }> {
  const codeVerifier = randomBase64Url(32); // 43 base64url chars
  const codeChallenge = await pkceChallenge(codeVerifier);
  const state = randomBase64Url(24); // 32 chars, within the server's [A-Za-z0-9_-]{16,256}
  const { attemptId, redirectUri } = await deps.auth.beginLoopback({ state });
  deps.onAttempt?.(attemptId);
  try {
    const started = await start({ returnUri: redirectUri, codeChallenge }) as { authorizationUrl?: unknown } | null;
    if (typeof started?.authorizationUrl !== "string") throw new Error("oauth_bad_start_response");
    await deps.auth.openAuthorizationUrl(attemptId, started.authorizationUrl);
    const callback = await deps.auth.awaitCallback(attemptId);
    // Defence in depth only: main echoes the state this attempt began with, so
    // this cannot fail against the real shell. The check that matters is the
    // loopback's, which accepts the browser's POST only when it carries this
    // attempt's state (oauthLoopback.ts, gotState !== attempt.nonce).
    if (callback.state !== state) throw new Error("oauth_state_mismatch");
    return { code: callback.code, codeVerifier };
  } catch (err) {
    deps.auth.cancel(attemptId);
    throw err;
  }
}

function assertProvider(provider: string): void {
  if (!/^[a-z]+$/.test(provider)) throw new Error("oauth_bad_provider");
}

export interface DesktopSignInTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Sign in (or sign up) with `provider`, up to the one-time code: the browser
 * leg. `completeDesktopSignIn` then exchanges it for the session.
 */
export async function desktopSignInLeg(provider: string, deps: DesktopOAuthDeps): Promise<{ code: string; codeVerifier: string }> {
  assertProvider(provider);
  return loopbackLeg(deps, (body) =>
    deps.post("/auth/mobile/oauth/start", { provider, mode: "login", linkOnConflict: true, ...body }),
  );
}

/** Exchange the code (with the PKCE verifier) for the session tokens. */
export async function completeDesktopSignIn(
  deps: Pick<DesktopOAuthDeps, "post">,
  leg: { code: string; codeVerifier: string },
  pendingLinkToken?: string,
): Promise<DesktopSignInTokens> {
  return await deps.post("/auth/mobile/oauth/complete", {
    code: leg.code,
    codeVerifier: leg.codeVerifier,
    ...(pendingLinkToken ? { pendingLinkToken } : {}),
  }) as DesktopSignInTokens;
}

/**
 * Connect `provider` to the signed-in account (Settings → Account). The web
 * link flow keeps its anti-CSRF state in a cookie the system browser does not
 * have, so desktop links on the authenticated mobile link endpoints instead:
 * the server binds the request to this user and refuses a code issued for
 * another user or for sign-in. Returns no tokens; rejects when nothing linked.
 */
export async function linkAccountWithDesktopLoopback(provider: string, deps: DesktopOAuthDeps): Promise<void> {
  await completeDesktopLink(provider, deps, await desktopLinkLeg(provider, deps));
}

/**
 * Runs the link start: the app passes withSecondFactorStepUp, so "Verify it's
 * you" comes before the browser opens (the server refuses the start without it).
 */
export type DesktopLinkStartGate = (start: () => Promise<unknown>) => Promise<unknown>;

const ungated: DesktopLinkStartGate = (start) => start();

/** The browser leg of a link, up to the one-time code. */
async function desktopLinkLeg(
  provider: string,
  deps: DesktopOAuthDeps,
  gateStart: DesktopLinkStartGate = ungated,
): Promise<{ code: string; codeVerifier: string }> {
  assertProvider(provider);
  return loopbackLeg(deps, (body) => gateStart(() => deps.post(`/auth/mobile/oauth/${provider}/link/start`, body)));
}

async function completeDesktopLink(provider: string, deps: Pick<DesktopOAuthDeps, "post">, leg: { code: string; codeVerifier: string }): Promise<void> {
  await deps.post(`/auth/mobile/oauth/${provider}/link/complete`, { code: leg.code, codeVerifier: leg.codeVerifier });
}

// ── Failure copy ──

type FormatMessage = IntlShape["formatMessage"];

/**
 * The server reason carried by a loopback rejection
 * (`oauth_provider_error:<code>`, task #103), or null for any other failure.
 * Also reads it at the END of Electron's IPC wrapping ("Error invoking remote
 * method '…': Error: oauth_provider_error:<code>").
 */
export function providerErrorCodeFromFailure(err: unknown): string | null {
  const message = err instanceof Error ? err.message : "";
  const match = /(?:^|[\s:])oauth_provider_error:([A-Za-z0-9_.-]{1,64})\s*$/.exec(message);
  return match ? match[1].toLowerCase() : null;
}

const FAILURE_MESSAGE_IDS: Record<string, MessageId> = {
  account_conflict: "auth.desktopSignIn.accountConflict",
  registration_disabled: "auth.desktopSignIn.registrationDisabled",
  expired: "auth.desktopSignIn.expired",
  request_not_pending: "auth.desktopSignIn.requestNotPending",
  provider_cancelled: "auth.desktopSignIn.providerCancelled",
  access_denied: "auth.desktopSignIn.accessDenied",
  provider_exchange_failed: "auth.desktopSignIn.providerExchangeFailed",
};

/**
 * One line for a failed desktop sign-in: a known server reason says what
 * happened and what to do; an unknown one keeps the generic line plus the code
 * (to quote to support); anything else is the generic line.
 */
export function describeDesktopSignInFailure(err: unknown, providerLabel: string, formatMessage: FormatMessage): string {
  const code = providerErrorCodeFromFailure(err);
  // Own-property lookup: the code is untrusted (`constructor`, `__proto__`).
  const id = code && Object.prototype.hasOwnProperty.call(FAILURE_MESSAGE_IDS, code) ? FAILURE_MESSAGE_IDS[code] : null;
  if (id) return formatMessage({ id }, { provider: providerLabel });
  return code
    ? formatMessage({ id: "auth.desktopSignIn.failedWithReason" }, { provider: providerLabel, reason: code })
    : formatMessage({ id: "auth.desktopSignIn.failed" }, { provider: providerLabel });
}

// ── App wiring ──

const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub", apple: "Apple" };
function providerLabel(provider: string): string {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider)
    ? PROVIDER_LABELS[provider]
    : provider.charAt(0).toUpperCase() + provider.slice(1);
}

function httpStatus(err: unknown): number | undefined {
  const response = (err as { response?: { status?: unknown } } | null)?.response;
  return typeof response?.status === "number" ? response.status : undefined;
}

const appPost = async (path: string, body: Record<string, unknown>) => (await api.post(path, body)).data;

// ── The live attempt ──
//
// The shell runs one loopback attempt at a time, so sign-in and linking share
// it. A new click supersedes a live attempt that is still waiting for the
// browser (the user closed that tab, or it opened somewhere they cannot find):
// the old loopback is cancelled and its rejection is swallowed, no toast. Once
// the browser came back, the code exchange is under way and a click is ignored.

/** What the screens show while an attempt waits for the browser ("Waiting for your browser… Cancel"). */
export type DesktopOAuthWaiting = { kind: "signIn" | "link"; provider: string } | null;

export interface LiveAttempt {
  auth: DesktopAuthBridge;
  kind: "signIn" | "link";
  provider: string;
  attemptId: string | null;
  /** Ended here (superseded by a newer click, or Cancel): whatever it settles with is dropped. */
  ended: boolean;
  /** The browser came back; the exchange is running. */
  completing: boolean;
}

let live: LiveAttempt | null = null;
let waiting: DesktopOAuthWaiting = null;
const waitingListeners = new Set<() => void>();

function publishWaiting(): void {
  const next: DesktopOAuthWaiting = live && !live.completing && !live.ended ? { kind: live.kind, provider: live.provider } : null;
  if (next?.kind === waiting?.kind && next?.provider === waiting?.provider) return;
  waiting = next;
  for (const listener of waitingListeners) listener();
}

function endAttempt(attempt: LiveAttempt): void {
  if (attempt.ended) return;
  attempt.ended = true;
  // Not armed yet: onAttempt cancels it as soon as the id arrives.
  if (attempt.attemptId) attempt.auth.cancel(attempt.attemptId);
  if (live === attempt) live = null;
  publishWaiting();
}

/** Start an attempt, superseding one that still waits for the browser; null while one is completing. */
export function beginAttempt(auth: DesktopAuthBridge, kind: LiveAttempt["kind"], provider: string): LiveAttempt | null {
  if (live?.completing) return null;
  if (live) endAttempt(live);
  const attempt: LiveAttempt = { auth, kind, provider, attemptId: null, ended: false, completing: false };
  live = attempt;
  publishWaiting();
  return attempt;
}

export function attemptDeps(attempt: LiveAttempt): DesktopOAuthDeps {
  return {
    auth: attempt.auth,
    post: appPost,
    onAttempt: (attemptId) => {
      attempt.attemptId = attemptId;
      if (!attempt.ended) return;
      // Cancelled (or superseded) while the loopback was arming: end it before
      // the server is asked to start or the browser opens.
      attempt.auth.cancel(attemptId);
      throw new Error("oauth_cancelled");
    },
  };
}

export function settleAttempt(attempt: LiveAttempt): void {
  if (live === attempt) live = null;
  publishWaiting();
}

/** The browser came back: the exchange is under way and the waiting line goes (desktopPasskeySignIn.ts). */
export function markAttemptCompleting(attempt: LiveAttempt): void {
  attempt.completing = true;
  publishWaiting();
}

/** Cancel the attempt that is waiting for the browser (the screens' Cancel). */
export function cancelDesktopOAuthAttempt(): void {
  if (live && !live.completing) endAttempt(live);
}

export function subscribeDesktopOAuthWaiting(listener: () => void): () => void {
  waitingListeners.add(listener);
  return () => { waitingListeners.delete(listener); };
}

export function getDesktopOAuthWaiting(): DesktopOAuthWaiting {
  return waiting;
}

/** The attempt waiting for the browser, or null (always null in a browser). */
export function useDesktopOAuthWaiting(): DesktopOAuthWaiting {
  return useSyncExternalStore(subscribeDesktopOAuthWaiting, getDesktopOAuthWaiting, getDesktopOAuthWaiting);
}

/** Signed in: the tokens, then the person (a pending account link is done). */
async function enterDesktopSignIn(tokens: DesktopSignInTokens, pendingLink: PendingAccountLink | null): Promise<void> {
  if (pendingLink) {
    assertAccountLinkCompleted(tokens, pendingLink);
    clearPendingAccountLink(pendingLink.token);
  }
  useAuthStore.getState().setTokens(tokens.accessToken, tokens.refreshToken);
  await useAuthStore.getState().loadUser();
}

/**
 * A social sign-in button in Raft Desktop. Ends with the user signed in, or a
 * toast saying why not. A pending account link (the email already had an
 * account) is carried into /complete, as on the web.
 */
export async function runDesktopSocialSignIn(provider: string, formatMessage: FormatMessage): Promise<void> {
  const auth = getDesktopAuth();
  if (!auth) return;
  const attempt = beginAttempt(auth, "signIn", provider);
  if (!attempt) return;
  const label = providerLabel(provider);
  const pendingLink = usePendingAccountLink.getState().pending;
  try {
    const leg = await desktopSignInLeg(provider, attemptDeps(attempt));
    if (attempt.ended) return;
    attempt.completing = true;
    publishWaiting();
    let tokens: DesktopSignInTokens;
    try {
      tokens = await completeDesktopSignIn({ post: appPost }, leg, pendingLink?.token);
      const challenge = readSecondFactorChallenge(tokens);
      if (challenge) {
        // Two-step verification is on: the code is entered here, in Desktop
        // (design v2 desk-step-code), and its answer carries the session
        // (the same body; the PKCE verifier goes back with the answer).
        startSecondFactorSignIn({
          challenge,
          codeVerifier: leg.codeVerifier,
          finish: (body) => enterDesktopSignIn(body as DesktopSignInTokens, pendingLink),
        });
        return;
      }
      if (pendingLink) assertAccountLinkCompleted(tokens, pendingLink);
    } catch (err) {
      const conflict = pendingAccountLinkFromError(err);
      if (conflict) {
        setPendingAccountLink(conflict);
        return;
      }
      if (pendingLink) {
        failPendingAccountLink(pendingLink.token, err);
        return;
      }
      // 422 LEGAL_ACCEPTANCE_REQUIRED / 409 TERMS_CHANGED: the social profile
      // has no account and a new one would be created. There is no desktop
      // terms-consent step yet, so say how to get there instead of accepting
      // on the user's behalf.
      const status = httpStatus(err);
      if (status === 422 || status === 409) {
        forwardToast.info(formatMessage({ id: "auth.desktopSignIn.signUpFirst" }, { provider: label }), { dismissible: true });
        return;
      }
      throw err;
    }
    await enterDesktopSignIn(tokens, pendingLink);
  } catch (err) {
    // Superseded by a newer click or cancelled with Cancel: the user moved on.
    if (attempt.ended) return;
    console.error("[raft-desktop] desktop sign-in failed", err);
    forwardToast.error(describeDesktopSignInFailure(err, label, formatMessage), { dismissible: true });
  } finally {
    settleAttempt(attempt);
  }
}

/**
 * Settings → Account "Connect" in Raft Desktop. Resolves true once linked,
 * false when the attempt was superseded or cancelled here (nothing to show);
 * rejects when the link failed (Settings shows why), or with what
 * `gateStart` rejected with (a closed "Verify it's you").
 */
export async function runDesktopAccountLink(provider: string, gateStart?: DesktopLinkStartGate): Promise<boolean> {
  const auth = getDesktopAuth();
  if (!auth) throw new Error("oauth_unavailable");
  const attempt = beginAttempt(auth, "link", provider);
  if (!attempt) throw new Error("oauth_in_flight");
  const deps = attemptDeps(attempt);
  try {
    const leg = await desktopLinkLeg(provider, deps, gateStart);
    if (attempt.ended) return false;
    attempt.completing = true;
    publishWaiting();
    await completeDesktopLink(provider, deps, leg);
    return true;
  } catch (err) {
    if (attempt.ended) return false;
    throw err;
  } finally {
    settleAttempt(attempt);
  }
}
