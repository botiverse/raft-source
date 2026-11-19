import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { __setEmailDeliveryObserverForTests } from "../services/emailService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { signupReferrerSite } from "../services/signupReferrerSite";
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

// artin / Edgar, 2026-11-13 (#triage:#363): a web sign-up that arrived by a
// campaign link says which one. A value that is not a campaign value is left
// out; it never refuses the sign-up nor loses the event.
test("account_created: a web sign-up carries its campaign link's utm values, valid ones only", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  // Each sign-up names itself by its client header, so rows are found by it, not by arrival order.
  const register = (platform: string, email: string, name: string, extra: Record<string, unknown>) =>
    fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": platform },
      body: JSON.stringify({ email, password: "password123", name, ...LEGAL, ...extra }),
    });

  assert.equal((await register("desktop_app", "campaign-repo@slock.test", "campaign-repo", {
    utm_source: "Stamp", utm_medium: "public_repo", utm_campaign: " Acme/Widgets.js ",
  })).status, 200);
  assert.equal((await register("pwa", "campaign-email@slock.test", "campaign-email", {
    utm_source: "stamp", utm_medium: "public repo", utm_campaign: "someone@example.com",
  })).status, 200, "an invalid value never refuses the sign-up");
  assert.equal((await register("ios", "campaign-odd@slock.test", "campaign-odd", {
    utm_source: 42, utm_medium: ["public_repo"], utm_campaign: { owner: "acme" }, utm_term: "raft",
  })).status, 200);
  assert.equal((await register("android", "campaign-token@slock.test", "campaign-token", { utm_campaign: "spring_launch" })).status, 200);

  const code = await createSocialAuthCompletion({
    provider: "google",
    mode: "login",
    intendedAction: "login",
    providerUserId: "google-account-created-campaign",
    providerEmail: "campaign-google@slock.test",
    providerDisplayName: "Campaign Google",
    providerAvatarUrl: null,
    providerEmailVerified: true,
    returnTo: "/",
  });
  const social = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "harmonyos", Cookie: socialCompletionCookie("google", code) },
    body: JSON.stringify({ code, ...LEGAL, utm_source: "stamp", utm_medium: "public_repo", utm_campaign: "acme/widgets", utm_content: "someone@example.com" }),
  });
  assert.equal(social.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const created = store.rows.filter((row) => row.event === "account_created");
  assert.equal(created.length, 5);
  const byPlatform = (platform: string) => {
    const rows = created.filter((row) => row.properties.platform === platform);
    assert.equal(rows.length, 1, platform);
    return rows[0]!.properties;
  };
  assert.deepEqual(byPlatform("desktop_app"), { platform: "desktop_app", method: "email", invited: false, utm_source: "stamp", utm_medium: "public_repo", utm_campaign: "acme/widgets.js" });
  assert.deepEqual(byPlatform("pwa"), { platform: "pwa", method: "email", invited: false, utm_source: "stamp" });
  assert.deepEqual(byPlatform("ios"), { platform: "ios", method: "email", invited: false });
  assert.deepEqual(byPlatform("android"), { platform: "android", method: "email", invited: false, utm_campaign: "spring_launch" });
  assert.deepEqual(byPlatform("harmonyos"), { platform: "harmonyos", method: "google", invited: false, utm_source: "stamp", utm_medium: "public_repo", utm_campaign: "acme/widgets" });
  assert.equal(JSON.stringify(created).includes("example.com"), false, "no address");
});

// cindyz, 2026-11-13 (#proj-analytics:72b5e0e2): the site the visitor was on
// before Raft's landing site, as its `ref_domain` link parameter said. Kept as
// the registrable domain, never one of Raft's own hosts; a value that is not a
// host name is left out and never refuses the sign-up.
test("account_created: a web sign-up carries its referring site, an outside host name only", async ({ app }) => {
  const store = memoryProductEventSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const register = (platform: string, name: string, extra: Record<string, unknown>) =>
    fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": platform },
      body: JSON.stringify({ email: `${name}@slock.test`, password: "password123", name, ...LEGAL, ...extra }),
    });

  assert.equal((await register("desktop_app", "referrer-host", { referrer_domain: " WWW.News.YCombinator.com ", utm_source: "hn" })).status, 200);
  assert.equal((await register("pwa", "referrer-url", { referrer_domain: "https://x.com/someone/status/1" })).status, 200, "an invalid value never refuses the sign-up");
  assert.equal((await register("ios", "referrer-own", { referrer_domain: "docs.raft.build" })).status, 200);
  assert.equal((await register("android", "referrer-odd", { referrer_domain: ["x.com"], ref_domain: "x.com" })).status, 200);

  const code = await createSocialAuthCompletion({
    provider: "google",
    mode: "login",
    intendedAction: "login",
    providerUserId: "google-account-created-referrer",
    providerEmail: "referrer-google@slock.test",
    providerDisplayName: "Referrer Google",
    providerAvatarUrl: null,
    providerEmailVerified: true,
    returnTo: "/",
  });
  const social = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Raft-Client-Platform": "harmonyos", Cookie: socialCompletionCookie("google", code) },
    body: JSON.stringify({ code, ...LEGAL, referrer_domain: "x.com" }),
  });
  assert.equal(social.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 50));
  const created = store.rows.filter((row) => row.event === "account_created");
  assert.equal(created.length, 5);
  const byPlatform = (platform: string) => {
    const rows = created.filter((row) => row.properties.platform === platform);
    assert.equal(rows.length, 1, platform);
    return rows[0]!.properties;
  };
  assert.deepEqual(byPlatform("desktop_app"), { platform: "desktop_app", method: "email", invited: false, utm_source: "hn", referrer_domain: "ycombinator.com" });
  assert.deepEqual(byPlatform("pwa"), { platform: "pwa", method: "email", invited: false });
  assert.deepEqual(byPlatform("ios"), { platform: "ios", method: "email", invited: false });
  assert.deepEqual(byPlatform("android"), { platform: "android", method: "email", invited: false });
  assert.deepEqual(byPlatform("harmonyos"), { platform: "harmonyos", method: "google", invited: false, referrer_domain: "x.com" });
});

test("signupReferrerSite keeps an outside site's registrable domain and drops Raft's own hosts and anything that is not a host name", () => {
  const previous = process.env.APP_URL;
  process.env.APP_URL = "https://chat.acme-selfhosted.com";
  try {
    const cases: Array<[unknown, string | null]> = [
      ["x.com", "x.com"],
      ["WWW.Google.co.uk", "google.co.uk"],
      ["news.ycombinator.com", "ycombinator.com"],
      ["alice.github.io", "github.io"],
      ["wiki.corp.acme.com", "acme.com"],
      // Raft's own: the landing site and its subdomains, the canonical app host, this deployment's, the earlier hosts.
      ["raft.build", null],
      ["www.raft.build", null],
      ["app.raft.build", null],
      ["docs.raft.build", null],
      ["chat.acme-selfhosted.com", null],
      ["app.slock.ai", null],
      ["RAFT.BUILD", null],
      ["notraft.build", "notraft.build"],
      // A host that only starts like Raft's is somebody else's.
      ["raft.build.evil.com", "evil.com"],
      // Punycode is an ASCII host name like any other.
      ["xn--bcher-kva.com", "xn--bcher-kva.com"],
      ["blog.xn--bcher-kva.com", "xn--bcher-kva.com"],
      // Dropped, not normalised: a trailing dot, a Unicode host, a host over 253 characters.
      ["raft.build.", null],
      ["x.com.", null],
      ["b\u00fccher.com", null],
      [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`, null],
      [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`, "d".repeat(57) + ".com"],
      // Not a bare host name, or no known public suffix.
      ["https://x.com", null],
      ["x.com/someone", null],
      ["x.com:8080", null],
      ["someone@example.com", null],
      ["192.168.1.10", null],
      ["jira.corp.internal", null],
      ["localhost", null],
      ["", null],
      [null, null],
      [undefined, null],
      [42, null],
      [["x.com"], null],
    ];
    for (const [raw, site] of cases) assert.equal(signupReferrerSite(raw), site, String(raw));
    // An app served from a `www.` host is its own site with and without it; its other hosts are not.
    process.env.APP_URL = "https://www.acme-selfhosted.com";
    const www: Array<[unknown, string | null]> = [
      ["www.acme-selfhosted.com", null],
      ["WWW.Acme-Selfhosted.com", null],
      ["acme-selfhosted.com", null],
      ["blog.acme-selfhosted.com", "acme-selfhosted.com"],
      ["chat.acme-selfhosted.com", "acme-selfhosted.com"],
      ["x.com", "x.com"],
    ];
    for (const [raw, site] of www) assert.equal(signupReferrerSite(raw), site, `www app host: ${String(raw)}`);
  } finally {
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
  }
});
