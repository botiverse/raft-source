import assert from "node:assert/strict";

import {
  getEnvironmentLabelMessageId,
  getPreviewEnvironmentDetails,
  getSlockdevSeedCommand,
  initialAuthView,
  shouldAutoDismissSlockdevAnnouncement,
  shouldAutoLoginSlockdev,
  clearSlockdevManualLogout,
  hasSlockdevManualLogout,
  markSlockdevManualLogout,
} from "../src/utils/devMode";

test("getEnvironmentLabelMessageId maps supported deployment modes to catalog ids", () => {
  assert.equal(getEnvironmentLabelMessageId("slockdev"), "env.badge.dev");
  assert.equal(getEnvironmentLabelMessageId("staging"), "env.badge.staging");
  assert.equal(getEnvironmentLabelMessageId("web-preview"), "env.badge.webPreview");
  assert.equal(getEnvironmentLabelMessageId("release-qa"), "env.badge.releaseQa");
  assert.equal(getEnvironmentLabelMessageId("production"), null);
  assert.equal(getEnvironmentLabelMessageId(undefined), null);
});

test("getPreviewEnvironmentDetails exposes branch, short SHA, and data target", () => {
  assert.equal(getPreviewEnvironmentDetails({}), null);
  assert.equal(getPreviewEnvironmentDetails({
    branch: "feature/dark-mode",
    commitSha: "3636b0b7398103fda29bf4a58841f4aeff394bcd",
    apiTarget: "prod",
  }), "feature/dark-mode · 3636b0b7 · PROD DATA");
});

test("shouldAutoLoginSlockdev is gated to an empty slockdev login screen", () => {
  const base = {
    deploymentEnv: "slockdev",
    initialized: true,
    attempted: false,
    hasUser: false,
    hasStoredSession: false,
    authView: "login" as const,
    authCallback: null,
    resetToken: null,
    inviteToken: null,
  };

  assert.equal(shouldAutoLoginSlockdev(base), true);
  assert.equal(shouldAutoLoginSlockdev({ ...base, deploymentEnv: "staging" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, attempted: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, hasUser: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, hasStoredSession: true }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, authView: "register" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, authCallback: "social" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, resetToken: "reset-token" }), false);
  assert.equal(shouldAutoLoginSlockdev({ ...base, inviteToken: "invite-token" }), false);
});

test("getSlockdevSeedCommand includes the slockdev environment name", () => {
  assert.equal(getSlockdevSeedCommand("preview-a"), "./raftdev seed preview-a");
  assert.equal(getSlockdevSeedCommand(""), "./raftdev seed <env>");
});

test("shouldAutoDismissSlockdevAnnouncement is gated to slockdev", () => {
  assert.equal(shouldAutoDismissSlockdevAnnouncement("slockdev"), true);
  assert.equal(shouldAutoDismissSlockdevAnnouncement("staging"), false);
  assert.equal(shouldAutoDismissSlockdevAnnouncement("production"), false);
  assert.equal(shouldAutoDismissSlockdevAnnouncement(undefined), false);
});

test("an explicit logout beats the dev auto-login, and signing in again retires it", () => {
  // stdrc, 2026-07-13: "log out 得真的 log out". Clicking Log out mid-onboarding handed
  // you straight back to the seeded dev account — the one thing logging out must prevent.
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };

  assert.equal(hasSlockdevManualLogout(storage), false);
  markSlockdevManualLogout(storage);
  assert.equal(hasSlockdevManualLogout(storage), true);
  clearSlockdevManualLogout(storage);
  assert.equal(hasSlockdevManualLogout(storage), false);

  // Storage being unavailable must not break auth: the auto-login is a convenience.
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  markSlockdevManualLogout(broken);
  assert.equal(hasSlockdevManualLogout(broken), false);
});

test("initialAuthView opens Create Account on /signup and Sign In everywhere else", () => {
  assert.equal(initialAuthView("/signup"), "register");
  assert.equal(initialAuthView("/signup/"), "register");
  assert.equal(initialAuthView("/"), "login");
  assert.equal(initialAuthView("/signup-later"), "login");
  assert.equal(initialAuthView("/s/acme/signup"), "login");
});

test("initialAuthView opens Forgot password on /forgot-password (the two-step lock email's reset link)", () => {
  assert.equal(initialAuthView("/forgot-password"), "forgot-password");
  assert.equal(initialAuthView("/forgot-password/"), "forgot-password");
  assert.equal(initialAuthView("/forgot-password-later"), "login");
});
