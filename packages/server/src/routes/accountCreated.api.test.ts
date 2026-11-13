import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { createSocialAuthCompletion } from "../services/socialAuthService";
import { socialCompletionCookie } from "../test/integration/socialCompletionCookie";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function memoryProductEventSink() {
  const rows: ProductEventRow[] = [];
  return {
    rows,
    sink: {
      enqueue(batch: readonly ProductEventRow[]) {
        rows.push(...batch);
      },
      async flush() {},
    } satisfies ProductEventSink,
  };
}

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const LEGAL = {
  acceptTerms: true,
  termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
  privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
};

// xxchan, 2026-10-22 (task #13): every new account records on which client it
// signed up, how, and whether an invite brought it; nothing that identifies the person.
test("account_created: a signup records its client, method and invite, without the email or user id", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const register = (email: string, name: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
    fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email, password: "password123", name, ...LEGAL, ...extra }),
    });

  assert.equal((await register("signup-phone@slock.test", "signup-phone", { "X-Raft-Client-Platform": "browser", "User-Agent": IPHONE_SAFARI })).status, 200);
  assert.equal((await register("signup-desktop@slock.test", "signup-desktop", { "X-Raft-Client-Platform": "desktop_app" }, { legalAcceptanceSource: "invite" })).status, 200);
  assert.equal((await register("signup-old-client@slock.test", "signup-old-client", {})).status, 200);
  assert.equal((await register("signup-odd@slock.test", "signup-odd", { "X-Raft-Client-Platform": "toaster" })).status, 200);

  const code = await createSocialAuthCompletion({
    provider: "google",
    mode: "login",
    intendedAction: "login",
    providerUserId: "google-account-created",
    providerEmail: "signup-google@slock.test",
    providerDisplayName: "Signup Google",
    providerAvatarUrl: null,
    providerEmailVerified: true,
    returnTo: "/",
  });
  const social = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "pwa", Cookie: socialCompletionCookie("google", code) },
    body: JSON.stringify({ code, ...LEGAL }),
  });
  assert.equal(social.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const created = store.rows.filter((row) => row.event === "account_created");
  assert.deepEqual(created.map((row) => row.properties), [
    { platform: "mobile_web", method: "email", invited: false },
    { platform: "desktop_app", method: "email", invited: true },
    { platform: "unknown", method: "email", invited: false },
    { platform: "unknown", method: "email", invited: false },
    { platform: "pwa", method: "google", invited: false },
  ]);
  for (const row of created) {
    assert.equal(row.source, "server");
    assert.equal(row.server_id, null, "an account-level fact");
    assert.match(String(row.analytics_id), /^[0-9a-f-]{36}$/, "told at signup: shares by default");
  }
  const stored = JSON.stringify(created);
  assert.equal(stored.includes("@slock.test"), false, "no email");
  assert.equal(stored.includes("signup-"), false, "no name");
});

// Task #55 (Nova, AndyLok's trace): the account row is committed before the
// verification email goes out. When the provider refuses it, signup used to
// answer 500 "Registration failed" (and the retry "already registered") with no
// account_created. Now the signup completes and the user can resend.
test("account_created: a refused verification email still completes the signup", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  __setEmailDeliveryObserverForTests(() => {
    throw new Error("Failed to send email");
  });
  try {
    const response = await fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "browser" },
      body: JSON.stringify({ email: "signup-refused@slock.test", password: "password123", name: "signup-refused", ...LEGAL }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { user: { id: string; emailVerified: boolean }; accessToken: string; refreshToken: string };
    assert.ok(body.accessToken && body.refreshToken, "a session is issued");
    assert.equal(body.user.emailVerified, false, "lands on the verify-email screen");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      store.rows.filter((row) => row.event === "account_created").map((row) => row.properties),
      [{ platform: "web", method: "email", invited: false }],
    );
  } finally {
    __setEmailDeliveryObserverForTests(null);
  }
});
