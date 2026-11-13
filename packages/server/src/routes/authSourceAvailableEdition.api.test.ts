import assert from "node:assert/strict";
import { users } from "../db/schema";
import { getDb } from "../db/index";
import { isNativeAppleSignInConfigured, isSocialAuthProviderConfigured } from "../services/socialAuthService";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// The edition line export-snapshot rewrites (edition.ts), switched per test.
const edition = vi.hoisted(() => ({ value: "cloud" as "cloud" | "source-available" }));
vi.mock("../edition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../edition")>();
  return { ...actual, socialLoginAllowed: () => actual.socialLoginAllowed(edition.value) };
});

const EMAIL = "edition-owner@slock.test";
const PASSWORD = "edition-password-123";
const CODE_CHALLENGE = "abcdefghijklmnopqrstuvwxyzABCDEFGH";

/** Every provider fully configured, web and native. */
function configureEveryProvider() {
  vi.stubEnv("JWT_SECRET", "edition-route-test-secret");
  vi.stubEnv("SERVER_URL", "https://api.example.test");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv("GITHUB_CLIENT_ID", "github-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "github-client-secret");
  vi.stubEnv("APPLE_CLIENT_ID", "apple-client-id");
  vi.stubEnv("APPLE_CLIENT_SECRET", "apple-client-secret");
  vi.stubEnv("APPLE_IOS_CLIENT_ID", "apple-ios-client-id");
  vi.stubEnv("APPLE_IOS_CLIENT_SECRET", "apple-ios-client-secret");
}

afterEach(() => {
  vi.unstubAllEnvs();
  edition.value = "cloud";
});

async function seedPasswordUser() {
  await getDb().insert(users).values({
    email: EMAIL,
    name: "edition-owner",
    displayName: "edition-owner",
    passwordHash: await fixturePasswordHash(PASSWORD),
    emailVerified: true,
  });
  return tokenForHuman(EMAIL);
}

async function providersEnabled(baseUrl: string): Promise<Record<string, boolean>> {
  const response = await fetch(`${baseUrl}/api/auth/providers`);
  assert.equal(response.status, 200);
  const body = await response.json() as { providers: Array<{ id: string; enabled: boolean }> };
  return Object.fromEntries(body.providers.map((provider) => [provider.id, provider.enabled]));
}

/**
 * One request to every social route: the starts, and the routes that arrive
 * with an already-issued code or token (callback, completions, pending link).
 * Returns each route's status and error code.
 */
async function probeSocialRoutes(baseUrl: string, accessToken: string) {
  const json = (body: unknown, token?: string): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const requests: Record<string, [string, RequestInit]> = {
    "GET /google/start": ["/google/start?returnTo=/", {}],
    "POST /github/link/start": ["/github/link/start", json({ returnTo: "/settings" }, accessToken)],
    "POST /mobile/oauth/start": ["/mobile/oauth/start", json({ provider: "google", mode: "login", returnUri: "raft-debug://oauth/callback", codeChallenge: CODE_CHALLENGE })],
    "POST /mobile/oauth/github/link/start": ["/mobile/oauth/github/link/start", json({ returnUri: "raft-debug://oauth/callback", codeChallenge: CODE_CHALLENGE }, accessToken)],
    "POST /mobile/oauth/apple/native/start": ["/mobile/oauth/apple/native/start", json({ mode: "login", platform: "ios", appEnv: "staging", returnUri: "raft-debug://oauth/callback", codeChallenge: CODE_CHALLENGE, codeChallengeMethod: "S256" })],
    "POST /mobile/oauth/apple/native/authorize": ["/mobile/oauth/apple/native/authorize", json({ requestId: "r", requestToken: "t", authorizationCode: "c", identityToken: "i" })],
    "GET /google/callback": ["/google/callback?state=issued-state&code=issued-code", {}],
    "POST /apple/callback": ["/apple/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ state: "issued-state", code: "issued-code" }).toString(),
    }],
    "POST /google/complete": ["/google/complete", json({ code: "issued-completion-code" })],
    "POST /mobile/oauth/complete": ["/mobile/oauth/complete", json({ code: "issued-handoff-code", codeVerifier: "issued-verifier" })],
    "POST /mobile/oauth/github/link/complete": ["/mobile/oauth/github/link/complete", json({ code: "issued-handoff-code", codeVerifier: "issued-verifier" }, accessToken)],
    "POST /login (pending link)": ["/login", json({ email: EMAIL, password: PASSWORD, pendingLinkToken: "issued-pending-link-token" })],
  };
  const results: Record<string, { status: number; code?: string }> = {};
  for (const [name, [route, init]] of Object.entries(requests)) {
    const response = await fetch(`${baseUrl}/api/auth${route}`, { redirect: "manual", ...init });
    const body = await response.text();
    let code: string | undefined;
    try { code = (JSON.parse(body) as { code?: string }).code; } catch { code = undefined; }
    results[name] = { status: response.status, ...(code ? { code } : {}) };
  }
  return results;
}

test("the source-available edition refuses every social route and offers no provider, whatever the environment configures", async ({ app }) => {
  configureEveryProvider();
  const accessToken = await seedPasswordUser();
  edition.value = "source-available";

  for (const provider of ["google", "github", "apple"] as const) assert.equal(isSocialAuthProviderConfigured(provider), false);
  assert.equal(isNativeAppleSignInConfigured(), false);
  assert.deepEqual(await providersEnabled(app.baseUrl), { google: false, github: false, apple: false });

  const results = await probeSocialRoutes(app.baseUrl, accessToken);
  for (const [route, result] of Object.entries(results)) {
    assert.equal(result.status, 404, `${route} must refuse: ${JSON.stringify(result)}`);
    // The web starts answer an unconfigured provider without a code, as they always have.
    if (result.code !== undefined) assert.equal(result.code, "provider_not_configured", `${route}: ${JSON.stringify(result)}`);
  }

  // Password sign-in is untouched.
  const login = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
});

test("the cloud edition offers and serves social login as configured", async ({ app }) => {
  configureEveryProvider();
  const accessToken = await seedPasswordUser();

  for (const provider of ["google", "github", "apple"] as const) assert.equal(isSocialAuthProviderConfigured(provider), true);
  assert.equal(isNativeAppleSignInConfigured(), true);
  assert.deepEqual(await providersEnabled(app.baseUrl), { google: true, github: true, apple: true });

  const results = await probeSocialRoutes(app.baseUrl, accessToken);
  for (const [route, result] of Object.entries(results)) {
    assert.notEqual(result.code, "provider_not_configured", `${route} must not be refused: ${JSON.stringify(result)}`);
  }
  // The starts go to the provider; the issued (here, bogus) codes and tokens
  // reach their own validation.
  assert.equal(results["GET /google/start"]!.status, 302);
  assert.equal(results["POST /github/link/start"]!.status, 200);
  assert.equal(results["POST /mobile/oauth/start"]!.status, 201);
  assert.equal(results["POST /mobile/oauth/github/link/start"]!.status, 201);
  assert.equal(results["POST /mobile/oauth/apple/native/start"]!.status, 201);
  assert.equal(results["GET /google/callback"]!.status, 302);
  assert.equal(results["POST /apple/callback"]!.status, 302);
  assert.equal(results["POST /login (pending link)"]!.code, "pending_link_expired");
});
