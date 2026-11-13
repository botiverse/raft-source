import assert from "node:assert/strict";
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
  loadResetPasswordPage,
  loadSsoAuthCallbackPage,
} from "../src/pages/landingPages";

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
