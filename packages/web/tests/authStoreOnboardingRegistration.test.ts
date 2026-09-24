import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/domSetup";
import api from "../src/api/client";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";

const initialAuthState = useAuthStore.getInitialState();

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "cindy@example.com",
    gravatarHash: "hash",
    name: "pending_1234567890abcdef",
    displayName: null,
    description: null,
    avatarUrl: null,
    emailVerified: true,
    profileSetupCompletedAt: null,
    profileSetupSuggestedHandle: "cindyrui",
    profileSetupProvider: null,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual",
    preferredTranslationDisplay: "translated",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
    ...overrides,
  };
}

function legalAcceptance() {
  return {
    acceptTerms: true,
    termsVersion: "terms-v1",
    privacyVersion: "privacy-v1",
    legalAcceptanceSource: "signup" as const,
  };
}

test.afterEach(() => {
  localStorage.clear();
  useAuthStore.setState(initialAuthState, true);
});

test("register creates the credential account without sending identity fields", async (t) => {
  const registered = user({ emailVerified: false });
  let requestBody: unknown;

  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    assert.equal(url, "/auth/register");
    requestBody = body;
    return { data: { user: registered, accessToken: "access-1", refreshToken: "refresh-1" } };
  });

  await useAuthStore.getState().register("cindy@example.com", "password123", legalAcceptance());

  assert.deepEqual(requestBody, {
    email: "cindy@example.com",
    password: "password123",
    ...legalAcceptance(),
  });
  assert.equal(localStorage.getItem("slock_access_token"), "access-1");
  assert.equal(localStorage.getItem("slock_refresh_token"), "refresh-1");
  assert.equal(useAuthStore.getState().user?.profileSetupCompletedAt, null);
});

test("completeOnboardingProfile uploads a selected avatar before atomically completing identity", async (t) => {
  const calls: Array<{ method: "post"; url: string; body?: unknown }> = [];
  const avatarFile = new File(["avatar"], "avatar.png", { type: "image/png" });
  const withAvatar = user({ avatarUrl: "/api/avatars/users/new.webp" });
  const completed = user({
    name: "cindyrui",
    displayName: "Cindy Rui",
    avatarUrl: "/api/avatars/users/new.webp",
    profileSetupCompletedAt: "2026-07-11T01:00:00.000Z",
    profileSetupSuggestedHandle: null,
  });
  useAuthStore.setState({ user: user(), loading: false });

  t.mock.method(api, "post", async (url: string, body?: unknown) => {
    calls.push({ method: "post", url, body });
    if (url === "/auth/me/avatar") {
      assert.ok(body instanceof FormData);
      assert.equal(body.get("avatar"), avatarFile);
      return { data: withAvatar };
    }
    if (url === "/auth/me/complete-profile") {
      assert.deepEqual(body, { name: "cindyrui", displayName: "Cindy Rui" });
      return { data: completed };
    }
    throw new Error(`unexpected post ${url}`);
  });

  await useAuthStore.getState().completeOnboardingProfile("cindyrui", "Cindy Rui", avatarFile);

  assert.deepEqual(calls.map((call) => call.url), [
    "/auth/me/avatar",
    "/auth/me/complete-profile",
  ]);
  assert.equal(useAuthStore.getState().user?.name, "cindyrui");
  assert.equal(useAuthStore.getState().user?.profileSetupCompletedAt, "2026-07-11T01:00:00.000Z");
  assert.equal(useAuthStore.getState().loading, false);
});

test("completeOnboardingProfile keeps identity incomplete when avatar upload fails", async (t) => {
  const avatarFile = new File(["bad"], "bad.exe", { type: "application/octet-stream" });
  let completeCalled = false;
  useAuthStore.setState({ user: user(), loading: false });

  t.mock.method(api, "post", async (url: string) => {
    if (url === "/auth/me/avatar") {
      const err = new Error("bad avatar") as Error & { response?: unknown };
      err.response = { data: { error: "Only image files are allowed (JPEG, PNG, GIF, WebP)" } };
      throw err;
    }
    completeCalled = true;
    throw new Error(`unexpected post ${url}`);
  });

  await assert.rejects(
    () => useAuthStore.getState().completeOnboardingProfile("cindyrui", "Cindy Rui", avatarFile),
    (err: unknown) => {
      assert.equal((err as { onboardingStep?: string }).onboardingStep, "avatar");
      return true;
    },
  );

  assert.equal(completeCalled, false);
  assert.equal(useAuthStore.getState().user?.profileSetupCompletedAt, null);
  assert.equal(useAuthStore.getState().loading, false);
});
