import assert from "node:assert/strict";
import { loadedModule } from "../src/boot/sharedModule";
import {
  landingPageLoadersFor,
  loadAppSumoRedemptionPage,
  loadAppSumoServerCreationPage,
  loadExternalInviteLandingPage,
  loadExternalInvitePage,
  loadForgotPasswordPage,
  loadHumanLoginSetupPage,
  loadInviteAcceptPage,
  loadRegisterPage,
  loadPendingSecondFactorSignInStep,
  loadResetPasswordPage,
  loadSignInPage,
  loadSsoAuthCallbackPage,
  preloadSignInPageEarly,
  startsSignInPageEarly,
} from "../src/pages/landingPages";

// The page's own module needs a browser; what matters here is when it is asked for.
vi.mock("../src/components/auth/SignInPage", () => ({ SignInPage: () => null, PendingSecondFactorSignInStep: () => null }));

// First in this file: the loaders remember their module for the whole file.
test("the sign-in page starts early only without a stored session and off a Public Server page, and brings its second step", async () => {
  preloadSignInPageEarly({ pathname: "/", search: "" }, true);
  preloadSignInPageEarly({ pathname: "/s/acme/channel/c1", search: "" }, false);
  preloadSignInPageEarly({ pathname: "/join/abc", search: "" }, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loadedModule(loadSignInPage), undefined, "a stored session, a Public Server page or an invite downloads nothing");
  preloadSignInPageEarly({ pathname: "/", search: "" }, false);
  await loadSignInPage();
  await loadPendingSecondFactorSignInStep();
  assert.ok(loadedModule(loadPendingSecondFactorSignInStep), "the step is settled with the page");
});

test("startsSignInPageEarly: only at a sign-in address (an allow-list), and only signed out", () => {
  const at = (pathname: string, search = "", stored = false) => startsSignInPageEarly({ pathname, search }, stored);
  assert.equal(at("/"), true);
  assert.equal(at("/login"), true);
  assert.equal(at("/login/"), true);
  assert.equal(at("/settings/account"), false, "only the sign-in addresses: elsewhere the page loads when it renders");
  assert.equal(at("/download"), false);
  assert.equal(at("/login/device"), false);
  assert.equal(at("/", "", true), false, "signed in: never");
  assert.equal(at("/s/acme"), false, "a Public Server page: its Sign in starts it");
  assert.equal(at("/s/acme/channel/c1"), false);
  assert.equal(at("/artifacts/pt_1"), false, "an Artifact link: its public page first");
  assert.equal(at("/join/abc"), false, "an invite");
  assert.equal(at("/", "?reset=r1"), false, "a reset link");
  assert.equal(at("/", "?verify=v"), false);
  assert.equal(at("/signup"), false, "sign-up");
  assert.equal(at("/", "?auth_callback=social"), false);
});

const at = (pathname: string, search = "") => landingPageLoadersFor({ pathname, search });

test("a landing page's address starts that page's code at boot", () => {
  assert.deepEqual(at("/login-with-raft/setup"), [loadHumanLoginSetupPage]);
  // Signed in it is the invite page, signed out its landing page first: both start.
  assert.deepEqual(at("/external-invite/tok-1"), [loadExternalInvitePage, loadExternalInviteLandingPage]);
  assert.deepEqual(at("/signup"), [loadRegisterPage]);
  assert.deepEqual(at("/forgot-password"), [loadForgotPasswordPage]);
  assert.deepEqual(at("/appsumo/redeem"), [loadAppSumoRedemptionPage]);
  assert.deepEqual(at("/appsumo/redeem/create-server"), [loadAppSumoServerCreationPage]);
  assert.deepEqual(at("/join/abc"), [loadInviteAcceptPage]);
});

test("an email link's query parameter starts its page; one loader per page", () => {
  assert.deepEqual(at("/", "?reset=r1"), [loadResetPasswordPage]);
  assert.deepEqual(at("/join/abc", "?invite=abc"), [loadInviteAcceptPage]);
  assert.deepEqual(at("/", "?auth_callback=sso"), [loadSsoAuthCallbackPage]);
});

test("a server's page starts none: the signed-in first screen loads only its own code", () => {
  assert.deepEqual(at("/s/acme/channel/c1"), []);
  assert.deepEqual(at("/"), []);
});
