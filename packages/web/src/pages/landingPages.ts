import { matchPath } from "react-router-dom";
import { whenIdle } from "../utils/whenIdle";
import { sharedModule } from "../boot/sharedModule";
import { INTEGRATION_INVITE_ROUTE } from "@botiverse/raft-shared";
import { EXTERNAL_INVITE_ROUTE, SERVER_CONNECT_REQUEST_ROUTE } from "../components/externalInvite/externalInviteAccept";
import { RECOVERY_CANCEL_PARAM, RECOVERY_CONFIRM_PARAM } from "../components/auth/secondFactorRecovery";
import { CHINESE_COMMUNITY_PAGE_PATH } from "../utils/communityServers";
import { initialAuthView } from "../utils/devMode";

/**
 * The pages someone lands on from a link (sign-in setup, device login, an
 * invite, a reset or verification email, AppSumo...) and the signed-out
 * steps after the sign-in page (create account, forgot password). None is
 * drawn on the signed-in first screen, so each is its own chunk
 * (docs/frontend/boot-bundle.md). App.tsx renders them through `lazyPanel`;
 * `preloadLandingPageForLocation` (main.tsx, at boot) starts the one the
 * address names right away, beside the first requests, so its page waits
 * on the same request instead of starting it once the app has rendered.
 * Each loader is one shared load (boot/sharedModule) that remembers its
 * module, so a page whose code is already in opens without the loading line.
 */
export const loadHumanLoginSetupPage = sharedModule(() => import("./HumanLoginSetupPage"));
export const loadDeviceLoginPage = sharedModule(() => import("./DeviceLoginPage"));
export const loadDeviceLoginRevokePage = sharedModule(() => import("./DeviceLoginRevokePage"));
export const loadSecondFactorRecoveryLinkPage = sharedModule(() => import("./SecondFactorRecoveryLinkPage"));
export const loadAccountDeletionCancelLinkPage = sharedModule(() => import("./AccountDeletionCancelLinkPage").then((module) => ({ default: module.AccountDeletionCancelLinkPage })));
export const loadAppLoginPage = sharedModule(() => import("./AppLoginPage"));
export const loadIntegrationInvitePage = sharedModule(() => import("./IntegrationInvitePage"));
export const loadExternalInvitePage = sharedModule(() => import("./ExternalInvitePage"));
export const loadExternalInviteLandingPage = sharedModule(() => import("./ExternalInviteLandingPage").then((module) => ({ default: module.ExternalInviteLandingPage })));
export const loadServerConnectRequestPage = sharedModule(() => import("./ServerConnectRequestPage"));
export const loadAgentConnectionCallbackPage = sharedModule(() => import("./AgentConnectionCallbackPage"));
export const loadAppSumoRedemptionPage = sharedModule(() => import("./AppSumoRedemptionPage"));
export const loadAppSumoServerCreationPage = sharedModule(() => import("./AppSumoRedemptionPage").then((module) => ({ default: module.AppSumoServerCreationPage })));
export const loadMobileDownloadChooserPage = sharedModule(() => import("./MobileDownloadChooserPage"));
export const loadChineseCommunityPage = sharedModule(() => import("./ChineseCommunityPage"));
export const loadRegisterPage = sharedModule(() => import("../components/auth/RegisterPage"));
export const loadForgotPasswordPage = sharedModule(() => import("../components/auth/ForgotPasswordPage"));
export const loadResetPasswordPage = sharedModule(() => import("../components/auth/ResetPasswordPage"));
export const loadEmailVerificationPage = sharedModule(() => import("../components/auth/EmailVerificationPage"));
export const loadAccountIdentitySetupPage = sharedModule(() => import("../components/auth/AccountIdentitySetupPage"));
export const loadInviteAcceptPage = sharedModule(() => import("../components/auth/InviteAcceptPage"));
export const loadSocialAuthCallbackPage = sharedModule(() => import("../components/auth/SocialAuthCallbackPage"));
// The sign-in page and the second step a sign-in may ask next: a signed-in
// first screen draws neither, so both stay out of its download. The step is
// taken from the sign-in page's module (its LoginPage imports the step, and
// so do the callback pages: on its own it would be a shared chunk the build
// check can't name, docs/frontend/boot-bundle.md). Once the sign-in page is
// in, the step's loader is settled too, so a password sign-in's second step
// opens without the loading line.
export const loadPendingSecondFactorSignInStep = sharedModule(() => import("../components/auth/SignInPage").then((module) => ({ default: module.PendingSecondFactorSignInStep })));
export const loadSignInPage = sharedModule(() => import("../components/auth/SignInPage").then((module) => {
  void loadPendingSecondFactorSignInStep().catch(() => {});
  return { default: module.SignInPage };
}));
export const loadSsoAuthCallbackPage = sharedModule(() => import("../components/auth/SsoAuthCallbackPage").then((module) => ({ default: module.SsoAuthCallbackPage })));

const ROUTES: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ["/login-with-raft/setup", loadHumanLoginSetupPage],
  ["/login-with-slock/setup", loadHumanLoginSetupPage],
  ["/login-with-slock-human/setup", loadHumanLoginSetupPage],
  ["/login/device", loadDeviceLoginPage],
  ["/login/app", loadAppLoginPage],
  [INTEGRATION_INVITE_ROUTE, loadIntegrationInvitePage],
  [EXTERNAL_INVITE_ROUTE, loadExternalInvitePage],
  // Signed out, the same address opens the invite's landing page first.
  [EXTERNAL_INVITE_ROUTE, loadExternalInviteLandingPage],
  [SERVER_CONNECT_REQUEST_ROUTE, loadServerConnectRequestPage],
  ["/connections/callback", loadAgentConnectionCallbackPage],
  ["/appsumo/redeem/create-server", loadAppSumoServerCreationPage],
  ["/appsumo/redeem", loadAppSumoRedemptionPage],
  ["/download", loadMobileDownloadChooserPage],
  [CHINESE_COMMUNITY_PAGE_PATH, loadChineseCommunityPage],
  ["/join/:token", loadInviteAcceptPage],
];

// Mirrors App.tsx's getUrlParams: the links whose page a query parameter picks.
const PARAMS: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ["reset", loadResetPasswordPage],
  ["revoke_device_login", loadDeviceLoginRevokePage],
  [RECOVERY_CONFIRM_PARAM, loadSecondFactorRecoveryLinkPage],
  [RECOVERY_CANCEL_PARAM, loadSecondFactorRecoveryLinkPage],
  // features/settings/account/accountDeletionApi.ts ACCOUNT_DELETION_CANCEL_PARAM (that module is the settings page's).
  ["cancel_account_deletion", loadAccountDeletionCancelLinkPage],
  ["invite", loadInviteAcceptPage],
  ["verify", loadEmailVerificationPage],
];

/** The loaders of the landing pages this address opens on (none for a server's page). */
export function landingPageLoadersFor(location: Pick<Location, "pathname" | "search">): Array<() => Promise<unknown>> {
  const loaders = new Set<() => Promise<unknown>>();
  for (const [path, load] of ROUTES) {
    if (matchPath(path, location.pathname)) loaders.add(load);
  }
  const params = new URLSearchParams(location.search);
  for (const [name, load] of PARAMS) {
    if (params.has(name)) loaders.add(load);
  }
  // /signup and /forgot-password open the sign-in page's next steps (App's initialAuthView).
  const authView = initialAuthView(location.pathname);
  if (authView === "register") loaders.add(loadRegisterPage);
  if (authView === "forgot-password") loaders.add(loadForgotPasswordPage);
  const authCallback = params.get("auth_callback");
  if (authCallback === "social") loaders.add(loadSocialAuthCallbackPage);
  if (authCallback === "sso") loaders.add(loadSsoAuthCallbackPage);
  return [...loaders];
}

/** main.tsx, at boot: start the code of the landing page the address opens on. */
export function preloadLandingPageForLocation(location: Pick<Location, "pathname" | "search">): void {
  // A failed start is retried when the page renders, where its Try again can show.
  for (const load of landingPageLoadersFor(location)) void load().catch(() => {});
}

/** A server's address (`/s/<slug>`), which a signed-out visitor opens as its Public Server page (App.tsx). */
export function isPublicServerPath(pathname: string): boolean {
  return /^\/s\/[^/]+/.test(pathname);
}

/** The query parameters that open a landing page rather than sign-in (PARAMS, and an auth callback's): the boot script mirrors them. */
export const LANDING_QUERY_PARAMS: readonly string[] = [...new Set([...PARAMS.map(([name]) => name), "auth_callback"])];

/** The addresses whose page, signed out, is the sign-in page: the root (and `/login`). The boot script mirrors it. */
export const SIGN_IN_PATHS: readonly string[] = ["/", "/login"];

/**
 * Whether this load starts the sign-in page's code before it renders: with no
 * stored session (main.tsx at boot), or once the boot's `/auth/me` turned the
 * stored one down (`hasStoredSession` false then); and only at an address
 * whose page is sign-in (SIGN_IN_PATHS, with none of the landing pages' query
 * parameters). An invite, a reset or verification link, sign-up, an Artifact
 * link or a server's address (the Public Server page, whose Sign in buttons
 * start the code on hover, focus or press: preloadSignInPage) draw something
 * else first; anywhere else the page loads when it renders. A signed-in load
 * never asks for it. Nothing waits for it: until it is in, the page draws its
 * frame (SignInPageFrame.tsx).
 */
export function startsSignInPageEarly(location: Pick<Location, "pathname" | "search">, hasStoredSession: boolean): boolean {
  if (hasStoredSession) return false;
  const path = location.pathname.replace(/(.)\/+$/, "$1");
  if (!SIGN_IN_PATHS.includes(path)) return false;
  const params = new URLSearchParams(location.search);
  return !LANDING_QUERY_PARAMS.some((name) => params.has(name));
}

/** Start the sign-in page's code (a failed start is retried when the page renders, where its recovery shows). */
export function preloadSignInPage(): Promise<void> {
  return loadSignInPage().then(() => {}, () => {});
}

/** main.tsx: at boot, and when `/auth/me` answers that the stored session is gone (authStore). */
export function preloadSignInPageEarly(location: Pick<Location, "pathname" | "search">, hasStoredSession: boolean): void {
  if (startsSignInPageEarly(location, hasStoredSession)) void preloadSignInPage();
}

/**
 * AppShell, once it knows no one is signed in: Create account and Forgot
 * password, which the sign-in, invite and Public Server pages open, start in
 * idle time, so opening one doesn't show the loading line first.
 */
export function preloadSignedOutSteps(location: Pick<Location, "pathname">): void {
  whenIdle(() => {
    // Sign-in itself too (an invite opens it), but not on a Public Server page: its buttons start it.
    if (!isPublicServerPath(location.pathname)) void preloadSignInPage();
    void loadRegisterPage().catch(() => {});
    void loadForgotPasswordPage().catch(() => {});
  });
}
