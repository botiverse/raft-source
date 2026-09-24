import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { and, eq } from "drizzle-orm";
import {
  APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
  BasicTracer,
  CURRENT_LEGAL_ACCEPTANCE,
  MemoryTraceSink,
  currentTimeMs,
  traceEventRowsForSpan,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  emailVerifications,
  featureFlagRules,
  featureFlags,
  sessionRefreshRotationReceipts,
  sessionFamilies,
  sessions,
  userRetirementReceipts,
  userLegalAcceptances,
  users,
} from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { createSocialAuthCompletion, signSocialAuthState, verifySocialAuthState } from "../services/socialAuthService.js";
import { oauthTransactions, userAuthIdentities } from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { MAX_PROFILE_AVATAR_BYTES, PROFILE_AVATAR_TOO_LARGE_MESSAGE } from "../services/avatarService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

async function seedUser(email: string, name: string, emailVerified = true) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({
      email,
      name,
      displayName: name,
      passwordHash: await argon2.hash("password123"),
      emailVerified,
    })
    .returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  const data = await res.json() as { accessToken: string };
  return data.accessToken;
}

async function findUserByEmail(email: string) {
  const [user] = await getDb().select().from(users).where(eq(users.email, email));
  return user;
}

function fetchInputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function createTestAvatarResponse(): Response {
  return new Response(ONE_BY_ONE_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(ONE_BY_ONE_GIF.byteLength),
    },
  });
}

function installExampleAvatarFetch(): typeof fetch {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    if (url.startsWith("https://example.test/")) {
      return createTestAvatarResponse();
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return originalFetch;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function startMobileOAuth(baseUrl: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function callbackMobileOAuth(url: string) {
  return fetch(url, { redirect: "manual" });
}

async function completeMobileOAuth(baseUrl: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function startMobileOAuthLink(baseUrl: string, provider: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/${provider}/link/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function completeMobileOAuthLink(baseUrl: string, provider: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/${provider}/link/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function startNativeAppleOAuth(baseUrl: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/apple/native/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function authorizeNativeAppleOAuth(baseUrl: string, body: Record<string, unknown>, token?: string) {
  return fetch(`${baseUrl}/api/auth/mobile/oauth/apple/native/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function beforeTestTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function withMobileOAuthEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.JWT_SECRET = "mobile-oauth-test-secret";
  process.env.SOCIAL_AUTH_STATE_SECRET = "mobile-oauth-state-secret";
  delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
  process.env.MOBILE_OAUTH_RETURN_URI = [
    "raft://oauth/callback",
    "raft-alpha://oauth/callback",
    "raft-beta://oauth/callback",
    "raft-debug://oauth/callback",
    "raft-dev://oauth/callback",
  ].join(",");
  delete process.env.MOBILE_OAUTH_RETURN_URI_ANDROID_DEV;
  delete process.env.MOBILE_OAUTH_RETURN_URI_IOS_DEV;
  delete process.env.MOBILE_OAUTH_RETURN_URI_OHOS_DEV;
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  process.env.SERVER_URL = "https://api.example.test";
  return fn();
}

async function getLegalAcceptanceForUser(userId: string) {
  const [acceptance] = await getDb()
    .select()
    .from(userLegalAcceptances)
    .where(eq(userLegalAcceptances.userId, userId));
  return acceptance;
}

async function readEmailAuthSideEffectCounts() {
  const db = getDb();
  const [userRows, legalRows, verificationRows, sessionRows] = await Promise.all([
    db.select({ id: users.id }).from(users),
    db.select({ id: userLegalAcceptances.id }).from(userLegalAcceptances),
    db.select({ id: emailVerifications.id }).from(emailVerifications),
    db.select({ id: sessions.id }).from(sessions),
  ]);
  return {
    users: userRows.length,
    legalAcceptances: legalRows.length,
    emailVerifications: verificationRows.length,
    sessions: sessionRows.length,
  };
}

function assertIssuePath(body: { issues?: Array<{ path?: string }> }, path: string) {
  assert.ok(
    body.issues?.some((issue) => issue.path === path),
    `expected body parser issue for ${path}`,
  );
}

async function seedAppleWebLoginGate(platforms: Array<"web" | "mobile"> = ["web"]): Promise<void> {
  const db = getDb();
  const [seeded] = await db.select().from(featureFlags)
    .where(eq(featureFlags.key, APPLE_WEB_LOGIN_FEATURE_FLAG_KEY));
  assert.ok(seeded, "Apple web login migration seed must exist");
  assert.equal(seeded.enabled, true);
  assert.equal(seeded.killSwitch, false);
  assert.equal(seeded.randomizationUnit, "user");
  assert.equal(seeded.defaultEnabled, false);
  await db.delete(featureFlagRules).where(and(
    eq(featureFlagRules.flagKey, APPLE_WEB_LOGIN_FEATURE_FLAG_KEY),
    eq(featureFlagRules.stage, "platform"),
  ));
  await db.insert(featureFlagRules).values({
    flagKey: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
    stage: "platform",
    priority: 0,
    decision: "allow",
    values: platforms,
  });
}

async function withNativeAppleOAuthEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    "JWT_SECRET",
    "SOCIAL_AUTH_STATE_SECRET",
    "NATIVE_APPLE_AUTH_STATE_SECRET",
    "APPLE_IOS_CLIENT_ID",
    "APPLE_IOS_CLIENT_SECRET",
    "APPLE_TEAM_ID",
    "APPLE_KEY_ID",
    "APPLE_PRIVATE_KEY",
    "MOBILE_OAUTH_RETURN_URI",
    "MOBILE_OAUTH_ALLOWED_RETURN_URIS",
    "SERVER_URL",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "native-apple-route-jwt-secret";
  process.env.SOCIAL_AUTH_STATE_SECRET = "native-apple-route-state-secret";
  process.env.NATIVE_APPLE_AUTH_STATE_SECRET = "native-apple-request-capability-secret";
  process.env.APPLE_IOS_CLIENT_ID = "build.raft.app";
  process.env.APPLE_IOS_CLIENT_SECRET = "native-apple-client-secret";
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_KEY_ID;
  delete process.env.APPLE_PRIVATE_KEY;
  process.env.MOBILE_OAUTH_RETURN_URI = "raft://oauth/callback,raft-debug://oauth/callback";
  delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
  process.env.SERVER_URL = "https://api.example.test";
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function signNativeAppleIdentityToken(params: {
  privateKey: KeyObject;
  kid: string;
  subject: string;
  nonce: string;
  email?: string;
  audience?: string;
  emailVerified?: boolean | "true" | "false";
}): string {
  return jwt.sign({
    sub: params.subject,
    nonce: params.nonce,
    ...(params.email ? { email: params.email } : {}),
    ...(params.email ? { email_verified: params.emailVerified ?? true } : {}),
  }, params.privateKey, {
    algorithm: "RS256",
    audience: params.audience ?? "build.raft.app",
    expiresIn: "5m",
    issuer: "https://appleid.apple.com",
    keyid: params.kid,
  });
}

test("Auth providers endpoint evaluates the requested platform gate", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;
  const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousGithubClientId = process.env.GITHUB_CLIENT_ID;
  const previousGithubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  process.env.JWT_SECRET = "auth-providers-platform-route-test-secret";
  process.env.SERVER_URL = "https://api.example.test";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const appleEnabled = async (query = "") => {
      const response = await fetch(`${app.baseUrl}/api/auth/providers${query}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { providers: Array<{ id: string; enabled: boolean }> };
      return body.providers.find((provider) => provider.id === "apple")?.enabled;
    };

    assert.equal(await appleEnabled(), false);
    assert.equal(await appleEnabled("?platform=mobile"), false);
    assert.equal(await appleEnabled("?platform=web"), false);

    const invalidPlatform = await fetch(`${app.baseUrl}/api/auth/providers?platform=desktop`);
    assert.equal(invalidPlatform.status, 400);
    const invalidBody = await invalidPlatform.json() as { code?: string };
    assert.equal(invalidBody.code, "platform_invalid");

    await seedAppleWebLoginGate();
    assert.equal(await appleEnabled(), true);
    assert.equal(await appleEnabled("?platform=web"), true);
    // A web-only allow must not leak into the mobile projection.
    assert.equal(await appleEnabled("?platform=mobile"), false);

    const db = getDb();
    await db.insert(featureFlagRules).values({
      flagKey: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      stage: "platform",
      priority: 0,
      decision: "allow",
      values: ["mobile"],
    });
    assert.equal(await appleEnabled("?platform=mobile"), true);

    // Google/GitHub are not flag-gated; they stay enabled on both platforms.
    const mobileBody = await (await fetch(`${app.baseUrl}/api/auth/providers?platform=mobile`)).json() as {
      providers: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(mobileBody.providers.find((provider) => provider.id === "google")?.enabled, true);
    assert.equal(mobileBody.providers.find((provider) => provider.id === "github")?.enabled, true);
  } finally {
    await app.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
    if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
    if (previousGithubClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = previousGithubClientId;
    if (previousGithubClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = previousGithubClientSecret;
  }
});

test("Apple web login requires the Apple web feature gate", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;

  process.env.JWT_SECRET = "apple-web-login-route-test-secret";
  process.env.SERVER_URL = "https://api.example.test";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    await seedUser("apple-link-owner@slock.test", "apple-link-owner");
    const accessToken = await login(app.baseUrl, "apple-link-owner@slock.test");

    const providersBeforeGate = await fetch(`${app.baseUrl}/api/auth/providers`);
    assert.equal(providersBeforeGate.status, 200);
    const beforeBody = await providersBeforeGate.json() as {
      providers: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(beforeBody.providers.find((provider) => provider.id === "apple")?.enabled, false);

    const startBeforeGate = await fetch(`${app.baseUrl}/api/auth/apple/start`, { redirect: "manual" });
    assert.equal(startBeforeGate.status, 404);
    const linkBeforeGate = await fetch(`${app.baseUrl}/api/auth/apple/link/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ returnTo: "/settings" }),
    });
    assert.equal(linkBeforeGate.status, 404);

    await seedAppleWebLoginGate();

    const providersAfterGate = await fetch(`${app.baseUrl}/api/auth/providers`);
    assert.equal(providersAfterGate.status, 200);
    const afterBody = await providersAfterGate.json() as {
      providers: Array<{ id: string; enabled: boolean }>;
    };
    assert.equal(afterBody.providers.find((provider) => provider.id === "apple")?.enabled, true);

    const startAfterGate = await fetch(`${app.baseUrl}/api/auth/apple/start?returnTo=/settings`, {
      redirect: "manual",
    });
    assert.equal(startAfterGate.status, 302);
    const location = startAfterGate.headers.get("location");
    assert.ok(location);
    const authorizationUrl = new URL(location);
    assert.equal(authorizationUrl.origin, "https://appleid.apple.com");
    assert.equal(authorizationUrl.pathname, "/auth/authorize");
    assert.equal(authorizationUrl.searchParams.get("client_id"), "apple-client-id");
    assert.equal(authorizationUrl.searchParams.get("response_mode"), "form_post");
    assert.ok(authorizationUrl.searchParams.get("nonce"));

    const linkAfterGate = await fetch(`${app.baseUrl}/api/auth/apple/link/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ returnTo: "/settings" }),
    });
    assert.equal(linkAfterGate.status, 200);
    const linkBody = await linkAfterGate.json() as { url: string };
    assert.equal(new URL(linkBody.url).searchParams.get("response_mode"), "form_post");

    const mobileStartWithWebOnlyGate = await startMobileOAuth(app.baseUrl, {
      provider: "apple",
      mode: "login",
      returnUri: "raft-debug://oauth/callback",
      codeChallenge: "abcdefghijklmnopqrstuvwxyzABCDEFGH",
    });
    assert.equal(mobileStartWithWebOnlyGate.status, 404);

    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    const setCookie = startAfterGate.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /SameSite=None/);
    assert.match(setCookie, /Secure/);

    const callback = await fetch(`${app.baseUrl}/api/auth/apple/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: setCookie.split(";", 1)[0]!,
      },
      body: new URLSearchParams({
        state,
        error: "user_cancelled_authorize",
      }),
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    const callbackLocation = new URL(callback.headers.get("location")!);
    assert.equal(callbackLocation.searchParams.get("provider"), "apple");
    assert.equal(callbackLocation.searchParams.get("mode"), "login");
    assert.equal(callbackLocation.searchParams.get("error"), "user_cancelled_authorize");
  } finally {
    await app.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
  }
});

test("Apple form-post link callback is non-mutating until the signed owner completes", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "apple-route-link-valid";
  jwk.alg = "RS256";
  jwk.use = "sig";
  let idToken = "";

  process.env.JWT_SECRET = "apple-link-owner-binding-secret";
  process.env.SERVER_URL = "https://api.example.test";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    await seedAppleWebLoginGate();
    const owner = await seedUser("apple-link-owner-binding@slock.test", "apple-link-owner-binding");
    const other = await seedUser("apple-link-other-binding@slock.test", "apple-link-other-binding");
    const ownerToken = signAccessToken(owner.id);
    const otherToken = signAccessToken(other.id);

    const start = await fetch(`${app.baseUrl}/api/auth/apple/link/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ returnTo: "/settings?tab=account" }),
    });
    assert.equal(start.status, 200);
    const authorizationUrl = new URL((await start.json() as { url: string }).url);
    const state = authorizationUrl.searchParams.get("state");
    const nonce = authorizationUrl.searchParams.get("nonce");
    assert.ok(state);
    assert.ok(nonce);

    idToken = jwt.sign({
      sub: "apple-route-link-sub",
      email: "apple-route-link-social@slock.test",
      email_verified: true,
      nonce,
    }, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-route-link-valid",
    });

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        return new Response(JSON.stringify({ id_token: idToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://appleid.apple.com/auth/keys") {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const callback = await fetch(`${app.baseUrl}/api/auth/apple/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "apple-route-link-code", state }),
      redirect: "manual",
    });
    assert.equal(callback.status, 302);
    const callbackLocation = new URL(callback.headers.get("location")!);
    assert.equal(callbackLocation.searchParams.get("mode"), "link");
    const completionCode = callbackLocation.searchParams.get("code");
    assert.ok(completionCode);

    const identitiesBeforeComplete = await getDb().select().from(userAuthIdentities)
      .where(eq(userAuthIdentities.provider, "apple"));
    assert.equal(identitiesBeforeComplete.length, 0, "provider callback must not mutate identities");

    const unauthenticated = await fetch(`${app.baseUrl}/api/auth/apple/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json() as { code: string }).code, "auth_required");

    const wrongUser = await fetch(`${app.baseUrl}/api/auth/apple/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(wrongUser.status, 403);
    assert.equal((await wrongUser.json() as { code: string }).code, "link_user_mismatch");
    assert.equal((await getDb().select().from(userAuthIdentities)
      .where(eq(userAuthIdentities.provider, "apple"))).length, 0);

    const ownerComplete = await fetch(`${app.baseUrl}/api/auth/apple/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(ownerComplete.status, 200);
    const ownerBody = await ownerComplete.json() as {
      mode: string;
      accessToken?: string;
      refreshToken?: string;
    };
    assert.equal(ownerBody.mode, "link");
    assert.equal(ownerBody.accessToken, undefined);
    assert.equal(ownerBody.refreshToken, undefined);

    const [identity] = await getDb().select().from(userAuthIdentities).where(and(
      eq(userAuthIdentities.userId, owner.id),
      eq(userAuthIdentities.provider, "apple"),
    ));
    assert.equal(identity.providerUserId, "apple-route-link-sub");

    const replay = await fetch(`${app.baseUrl}/api/auth/apple/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(replay.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
  }
});

test("unverified Apple email cannot persist through web or mobile link completion", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousStateSecret = process.env.SOCIAL_AUTH_STATE_SECRET;
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;
  const previousMobileReturnUri = process.env.MOBILE_OAUTH_RETURN_URI;
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "apple-route-unverified";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const tokensByCode = new Map<string, string>();

  process.env.JWT_SECRET = "apple-unverified-route-secret";
  process.env.SOCIAL_AUTH_STATE_SECRET = "apple-unverified-state-secret";
  process.env.SERVER_URL = "https://api.example.test";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";
  process.env.MOBILE_OAUTH_RETURN_URI = "raft-debug://oauth/callback";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://appleid.apple.com/auth/token") {
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      return new Response(JSON.stringify({ id_token: tokensByCode.get(body.get("code") ?? "") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "https://appleid.apple.com/auth/keys") {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    await seedAppleWebLoginGate();
    await getDb().insert(featureFlagRules).values({
      flagKey: APPLE_WEB_LOGIN_FEATURE_FLAG_KEY,
      stage: "platform",
      priority: 1,
      decision: "allow",
      values: ["mobile"],
    });
    const owner = await seedUser(
      "apple-unverified-owner@slock.test",
      "apple-unverified-owner",
      false,
    );
    const ownerToken = signAccessToken(owner.id);

    const webStart = await fetch(`${app.baseUrl}/api/auth/apple/link/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ returnTo: "/settings" }),
    });
    assert.equal(webStart.status, 200);
    const webAuthorization = new URL((await webStart.json() as { url: string }).url);
    tokensByCode.set("apple-web-unverified", jwt.sign({
      sub: "apple-web-unverified-sub",
      email: owner.email,
      email_verified: false,
      nonce: webAuthorization.searchParams.get("nonce"),
    }, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-route-unverified",
    }));

    const webCallback = await fetch(`${app.baseUrl}/api/auth/apple/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "apple-web-unverified",
        state: webAuthorization.searchParams.get("state")!,
      }),
      redirect: "manual",
    });
    assert.equal(webCallback.status, 302);
    const webCallbackLocation = new URL(webCallback.headers.get("location")!);
    assert.match(webCallbackLocation.searchParams.get("error") ?? "", /not verified/);
    assert.equal(webCallbackLocation.searchParams.get("code"), null);

    const mobileStart = await startMobileOAuthLink(app.baseUrl, "apple", {
      returnUri: "raft-debug://oauth/callback",
      codeChallenge: pkceChallenge("apple-unverified-mobile-verifier"),
    }, ownerToken);
    assert.equal(mobileStart.status, 201);
    const mobileStartBody = await mobileStart.json() as { requestId: string; authorizationUrl: string };
    const mobileAuthorization = new URL(mobileStartBody.authorizationUrl);
    tokensByCode.set("apple-mobile-unverified", jwt.sign({
      sub: "apple-mobile-unverified-sub",
      email: owner.email,
      email_verified: "false",
      nonce: mobileAuthorization.searchParams.get("nonce"),
    }, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-route-unverified",
    }));

    const mobileCallback = await fetch(`${app.baseUrl}/api/auth/apple/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "apple-mobile-unverified",
        state: mobileAuthorization.searchParams.get("state")!,
      }),
      redirect: "manual",
    });
    assert.equal(mobileCallback.status, 302);
    const mobileLocation = new URL(mobileCallback.headers.get("location")!);
    assert.equal(mobileLocation.searchParams.get("error"), "provider_exchange_failed");
    assert.equal(mobileLocation.searchParams.get("code"), null);

    const [mobileRequest] = await getDb().select().from(oauthTransactions)
      .where(eq(oauthTransactions.id, mobileStartBody.requestId));
    assert.equal(mobileRequest.status, "failed");
    assert.equal(mobileRequest.providerUserId, null);
    assert.equal((await getDb().select().from(userAuthIdentities)
      .where(eq(userAuthIdentities.provider, "apple"))).length, 0);
    const [ownerAfter] = await getDb().select().from(users).where(eq(users.id, owner.id));
    assert.equal(ownerAfter.emailVerified, false);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    if (previousStateSecret === undefined) delete process.env.SOCIAL_AUTH_STATE_SECRET;
    else process.env.SOCIAL_AUTH_STATE_SECRET = previousStateSecret;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
    if (previousMobileReturnUri === undefined) delete process.env.MOBILE_OAUTH_RETURN_URI;
    else process.env.MOBILE_OAUTH_RETURN_URI = previousMobileReturnUri;
  }
});

test("native Apple iOS login verifies both credentials and preserves the one-time legal handoff", async () => {
  await withNativeAppleOAuthEnv(async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = `native-apple-login-${randomUUID()}`;
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    const exchangedTokens = new Map<string, string>();
    const exchangeBodies: URLSearchParams[] = [];
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        assert.ok(init?.body instanceof URLSearchParams);
        exchangeBodies.push(new URLSearchParams(init.body));
        const code = init.body.get("code") ?? "";
        return new Response(JSON.stringify({ id_token: exchangedTokens.get(code) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://appleid.apple.com/auth/keys") {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const beforeGate = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("native-apple-before-gate-verifier-0123456789"),
        codeChallengeMethod: "S256",
      });
      assert.equal(beforeGate.status, 404);
      await seedAppleWebLoginGate(["mobile"]);
      delete process.env.APPLE_IOS_CLIENT_SECRET;
      const withoutNativeConfig = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("native-apple-no-config-verifier-0123456789"),
        codeChallengeMethod: "S256",
      });
      assert.equal(withoutNativeConfig.status, 404);
      process.env.APPLE_IOS_CLIENT_SECRET = "native-apple-client-secret";
      const wrongPlatform = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "android",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("native-apple-wrong-platform-verifier-012345"),
        codeChallengeMethod: "S256",
      });
      assert.equal(wrongPlatform.status, 400);
      const verifier = "native-apple-login-verifier-0123456789abcdef";
      const challenge = pkceChallenge(verifier);
      const start = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      assert.equal(start.status, 201);
      const startBody = await start.json() as {
        requestId: string;
        requestToken: string;
        returnUri: string;
        expiresAt: string;
        authorizationUrl?: string;
      };
      assert.ok(startBody.requestId);
      assert.ok(startBody.requestToken);
      assert.equal(startBody.returnUri, "raft-debug://oauth/callback");
      assert.equal(startBody.authorizationUrl, undefined, "native start must never return a browser URL");
      assert.ok(Date.parse(startBody.expiresAt) > Date.now());
      const [started] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(started.status, "pending_provider");
      assert.equal(started.codeChallenge, challenge);

      const requestCapabilityPayload = {
        kind: "native_apple_ios",
        requestId: startBody.requestId,
        mode: "login",
        codeChallenge: challenge,
      };
      const expiredRequestToken = jwt.sign(
        requestCapabilityPayload,
        "native-apple-request-capability-secret",
        {
          algorithm: "HS256",
          expiresIn: -1,
          issuer: "slock-native-apple-auth",
          audience: "native-apple-auth-request",
        },
      );
      const expiredCapability = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: startBody.requestId,
        requestToken: expiredRequestToken,
        authorizationCode: "must-not-be-exchanged",
        identityToken: "must-not-be-verified",
      });
      assert.equal(expiredCapability.status, 410);
      assert.equal((await expiredCapability.json() as { code: string }).code, "native_apple_request_expired");

      const wrongAlgorithmRequestToken = jwt.sign(
        requestCapabilityPayload,
        "native-apple-request-capability-secret",
        {
          algorithm: "HS512",
          expiresIn: "10m",
          issuer: "slock-native-apple-auth",
          audience: "native-apple-auth-request",
        },
      );
      const wrongAlgorithmCapability = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: startBody.requestId,
        requestToken: wrongAlgorithmRequestToken,
        authorizationCode: "must-not-be-exchanged",
        identityToken: "must-not-be-verified",
      });
      assert.equal(wrongAlgorithmCapability.status, 400);
      assert.equal(
        (await wrongAlgorithmCapability.json() as { code: string }).code,
        "native_apple_invalid_credential",
      );
      assert.equal(exchangeBodies.length, 0);
      const [afterCapabilityRejections] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterCapabilityRejections.status, "pending_provider");

      const unrelated = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("native-apple-unrelated-verifier-0123456789"),
        codeChallengeMethod: "S256",
      });
      assert.equal(unrelated.status, 201);
      const unrelatedBody = await unrelated.json() as { requestToken: string };
      const crossBound = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: startBody.requestId,
        requestToken: unrelatedBody.requestToken,
        authorizationCode: "must-not-be-exchanged",
        identityToken: "must-not-be-verified",
      });
      assert.equal(crossBound.status, 400);
      assert.equal((await crossBound.json() as { code: string }).code, "native_apple_invalid_credential");
      const [afterCrossBinding] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterCrossBinding.status, "pending_provider");
      assert.equal(exchangeBodies.length, 0);

      const suppliedIdentityToken = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-login-subject",
        nonce: challenge,
        email: "native-apple-login@slock.test",
      });
      exchangedTokens.set("native-apple-login-code", signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-login-subject",
        nonce: challenge,
        email: "native-apple-login@slock.test",
        emailVerified: "true",
      }));
      const authorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: startBody.requestId,
        requestToken: startBody.requestToken,
        authorizationCode: "native-apple-login-code",
        identityToken: suppliedIdentityToken,
      });
      assert.equal(authorize.status, 200);
      const authorizeBody = await authorize.json() as {
        requestId: string;
        handoffCode: string;
        provider: string;
        mode: string;
      };
      assert.equal(authorizeBody.requestId, startBody.requestId);
      assert.ok(authorizeBody.handoffCode);
      assert.equal(authorizeBody.provider, "apple");
      assert.equal(authorizeBody.mode, "login");
      assert.equal(exchangeBodies.length, 1);
      assert.equal(exchangeBodies[0]?.get("client_id"), "build.raft.app");
      assert.equal(exchangeBodies[0]?.get("client_secret"), "native-apple-client-secret");
      assert.equal(exchangeBodies[0]?.get("grant_type"), "authorization_code");
      assert.equal(exchangeBodies[0]?.get("redirect_uri"), null, "native code exchange must omit redirect_uri");

      const [authorized] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(authorized.status, "provider_completed");
      assert.equal(authorized.providerUserId, "native-apple-login-subject");
      assert.equal(authorized.providerEmail, "native-apple-login@slock.test");

      const authorizeReplay = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: startBody.requestId,
        requestToken: startBody.requestToken,
        authorizationCode: "native-apple-login-code",
        identityToken: suppliedIdentityToken,
      });
      assert.equal(authorizeReplay.status, 410);
      assert.equal((await authorizeReplay.json() as { code: string }).code, "native_apple_request_consumed");
      assert.equal(exchangeBodies.length, 1, "authorize replay must not reach Apple");

      const missingLegal = await completeMobileOAuth(app.baseUrl, {
        code: authorizeBody.handoffCode,
        codeVerifier: verifier,
        platform: "ios",
      });
      assert.equal(missingLegal.status, 422);
      assert.equal((await missingLegal.json() as { error: string }).error, "LEGAL_ACCEPTANCE_REQUIRED");
      const [afterLegalBlock] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterLegalBlock.status, "provider_completed");

      const accepted = await completeMobileOAuth(app.baseUrl, {
        code: authorizeBody.handoffCode,
        codeVerifier: verifier,
        platform: "ios",
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      });
      assert.equal(accepted.status, 200);
      const acceptedBody = await accepted.json() as {
        user: { id: string; email: string };
        accessToken: string;
        refreshToken: string;
      };
      assert.equal(acceptedBody.user.email, "native-apple-login@slock.test");
      assert.ok(acceptedBody.accessToken);
      assert.ok(acceptedBody.refreshToken);
      const [identity] = await getDb().select().from(userAuthIdentities).where(and(
        eq(userAuthIdentities.userId, acceptedBody.user.id),
        eq(userAuthIdentities.provider, "apple"),
      ));
      assert.equal(identity.providerUserId, "native-apple-login-subject");

      const handoffReplay = await completeMobileOAuth(app.baseUrl, {
        code: authorizeBody.handoffCode,
        codeVerifier: verifier,
        platform: "ios",
      });
      assert.equal(handoffReplay.status, 410);
      assert.equal((await handoffReplay.json() as { code: string }).code, "handoff_code_consumed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("native Apple authorization atomically claims concurrent route requests before provider exchange", async () => {
  await withNativeAppleOAuthEnv(async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = `native-apple-concurrent-${randomUUID()}`;
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    let exchangeCount = 0;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    let releaseExchange!: () => void;
    const exchangeRelease = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    let exchangedIdentityToken = "";

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        exchangeCount += 1;
        markExchangeStarted();
        await exchangeRelease;
        return new Response(JSON.stringify({ id_token: exchangedIdentityToken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://appleid.apple.com/auth/keys") {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await seedAppleWebLoginGate(["mobile"]);
      const verifier = "native-apple-concurrent-verifier-0123456789";
      const challenge = pkceChallenge(verifier);
      const start = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      });
      assert.equal(start.status, 201);
      const started = await start.json() as { requestId: string; requestToken: string };
      const suppliedIdentityToken = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-concurrent-subject",
        nonce: challenge,
        email: "native-apple-concurrent@slock.test",
      });
      exchangedIdentityToken = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-concurrent-subject",
        nonce: challenge,
        email: "native-apple-concurrent@slock.test",
      });
      const authorizationBody = {
        requestId: started.requestId,
        requestToken: started.requestToken,
        authorizationCode: "native-apple-concurrent-code",
        identityToken: suppliedIdentityToken,
      };

      let markConsumedBeforeRelease!: (response: Response) => void;
      const consumedBeforeRelease = new Promise<Response>((resolve) => {
        markConsumedBeforeRelease = resolve;
      });
      const authorizeAttempt = async () => {
        const response = await authorizeNativeAppleOAuth(app.baseUrl, authorizationBody);
        if (response.status === 410) markConsumedBeforeRelease(response);
        return response;
      };
      const responsePair = Promise.all([authorizeAttempt(), authorizeAttempt()]);
      let barrierFailure: unknown;
      try {
        await beforeTestTimeout(exchangeStarted, "the winning Apple code exchange");
        const rejected = await beforeTestTimeout(
          consumedBeforeRelease,
          "the losing authorize request while the winner remains in provider exchange",
        );
        assert.equal((await rejected.json() as { code: string }).code, "native_apple_request_consumed");
        assert.equal(exchangeCount, 1, "only the CAS winner may enter Apple code exchange");
      } catch (error) {
        barrierFailure = error;
      } finally {
        releaseExchange();
      }

      const responses = await responsePair;
      if (barrierFailure) throw barrierFailure;
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410]);
      assert.equal(exchangeCount, 1);
      const succeeded = responses.find((response) => response.status === 200);
      assert.ok(succeeded);
      const successBody = await succeeded.json() as { requestId: string; handoffCode: string };
      assert.equal(successBody.requestId, started.requestId);
      assert.ok(successBody.handoffCode);

      const [completed] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, started.requestId));
      assert.equal(completed.status, "provider_completed");
      assert.equal(completed.codeHash, createHash("sha256").update(successBody.handoffCode).digest("hex"));
      assert.equal(completed.providerUserId, "native-apple-concurrent-subject");
    } finally {
      releaseExchange();
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("native Apple authorization expires from the DB row while its signed capability remains valid", async () => {
  await withNativeAppleOAuthEnv(async () => {
    const originalFetch = globalThis.fetch;
    let exchangeCount = 0;
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        exchangeCount += 1;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await seedAppleWebLoginGate(["mobile"]);
      const start = await startNativeAppleOAuth(app.baseUrl, {
        mode: "login",
        platform: "ios",
        appEnv: "staging",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("native-apple-db-expiry-verifier-0123456789"),
        codeChallengeMethod: "S256",
      });
      assert.equal(start.status, 201);
      const started = await start.json() as { requestId: string; requestToken: string };
      const capability = jwt.decode(started.requestToken) as jwt.JwtPayload | null;
      assert.ok(capability?.exp);
      assert.ok(capability.exp * 1_000 > currentTimeMs(), "signed capability must still be within its JWT TTL");

      const expiredAt = new Date(currentTimeMs() - 1_000);
      await getDb().update(oauthTransactions)
        .set({ expiresAt: expiredAt })
        .where(eq(oauthTransactions.id, started.requestId));
      const [pendingExpired] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, started.requestId));
      assert.equal(pendingExpired.status, "pending_provider");
      assert.equal(pendingExpired.codeHash, null);

      const authorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: started.requestId,
        requestToken: started.requestToken,
        authorizationCode: "must-not-be-exchanged",
        identityToken: "must-not-be-verified",
      });
      assert.equal(authorize.status, 410);
      assert.equal((await authorize.json() as { code: string }).code, "native_apple_request_expired");
      assert.equal(exchangeCount, 0, "DB-expired requests must stop before Apple code exchange");

      const [expired] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, started.requestId));
      assert.equal(expired.status, "expired");
      assert.notEqual(expired.status, "provider_processing");
      assert.equal(expired.codeHash, null);
      assert.equal(expired.expiresAt.getTime(), expiredAt.getTime());
      assert.ok(expired.expiresAt.getTime() < currentTimeMs());
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("native Apple link is owner-bound and later authorization may reuse only a verified stored email", async () => {
  await withNativeAppleOAuthEnv(async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = `native-apple-link-${randomUUID()}`;
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    const exchangedTokens = new Map<string, string>();
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        assert.ok(init?.body instanceof URLSearchParams);
        return new Response(JSON.stringify({ id_token: exchangedTokens.get(init.body.get("code") ?? "") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://appleid.apple.com/auth/keys") {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const startNative = async (mode: "login" | "link", verifier: string, token?: string) => {
      const challenge = pkceChallenge(verifier);
      const response = await startNativeAppleOAuth(app.baseUrl, {
        mode,
        platform: "ios",
        appEnv: "production",
        returnUri: "raft://oauth/callback",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      }, token);
      return { response, challenge };
    };

    try {
      await seedAppleWebLoginGate(["mobile"]);
      const owner = await seedUser("native-apple-link-owner@slock.test", "native-apple-link-owner");
      const other = await seedUser("native-apple-link-other@slock.test", "native-apple-link-other");
      const ownerToken = signAccessToken(owner.id);
      const otherToken = signAccessToken(other.id);

      const unauthenticatedStart = await startNative("link", "native-apple-link-no-auth-verifier-0123456789");
      assert.equal(unauthenticatedStart.response.status, 401);

      const verifier = "native-apple-link-owner-verifier-0123456789";
      const { response: linkStart, challenge } = await startNative("link", verifier, ownerToken);
      assert.equal(linkStart.status, 201);
      const linkStartBody = await linkStart.json() as { requestId: string; requestToken: string };
      const supplied = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-linked-subject",
        nonce: challenge,
        email: owner.email,
      });
      exchangedTokens.set("native-apple-link-code", signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-linked-subject",
        nonce: challenge,
        email: owner.email,
      }));

      const noAuthAuthorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: linkStartBody.requestId,
        requestToken: linkStartBody.requestToken,
        authorizationCode: "native-apple-link-code",
        identityToken: supplied,
      });
      assert.equal(noAuthAuthorize.status, 401);
      const wrongOwnerAuthorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: linkStartBody.requestId,
        requestToken: linkStartBody.requestToken,
        authorizationCode: "native-apple-link-code",
        identityToken: supplied,
      }, otherToken);
      assert.equal(wrongOwnerAuthorize.status, 403);
      assert.equal((await getDb().select().from(userAuthIdentities)
        .where(eq(userAuthIdentities.provider, "apple"))).length, 0);

      const ownerAuthorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: linkStartBody.requestId,
        requestToken: linkStartBody.requestToken,
        authorizationCode: "native-apple-link-code",
        identityToken: supplied,
      }, ownerToken);
      assert.equal(ownerAuthorize.status, 200);
      const handoffCode = (await ownerAuthorize.json() as { handoffCode: string }).handoffCode;
      assert.ok(handoffCode);
      assert.equal((await getDb().select().from(userAuthIdentities)
        .where(eq(userAuthIdentities.provider, "apple"))).length, 0, "native credential exchange must not link early");

      const wrongFinalOwner = await completeMobileOAuthLink(app.baseUrl, "apple", {
        code: handoffCode,
        codeVerifier: verifier,
      }, otherToken);
      assert.equal(wrongFinalOwner.status, 403);
      assert.equal((await getDb().select().from(userAuthIdentities)
        .where(eq(userAuthIdentities.provider, "apple"))).length, 0);

      const ownerComplete = await completeMobileOAuthLink(app.baseUrl, "apple", {
        code: handoffCode,
        codeVerifier: verifier,
      }, ownerToken);
      assert.equal(ownerComplete.status, 200);
      const [linkedIdentity] = await getDb().select().from(userAuthIdentities).where(and(
        eq(userAuthIdentities.userId, owner.id),
        eq(userAuthIdentities.provider, "apple"),
      ));
      assert.equal(linkedIdentity.providerUserId, "native-apple-linked-subject");
      assert.equal(linkedIdentity.providerEmail, owner.email);

      const laterVerifier = "native-apple-later-login-verifier-0123456789";
      const { response: laterStart, challenge: laterChallenge } = await startNative("login", laterVerifier);
      assert.equal(laterStart.status, 201);
      const laterStartBody = await laterStart.json() as { requestId: string; requestToken: string };
      const laterSupplied = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-linked-subject",
        nonce: laterChallenge,
      });
      exchangedTokens.set("native-apple-later-code", signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-linked-subject",
        nonce: laterChallenge,
      }));
      const laterAuthorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: laterStartBody.requestId,
        requestToken: laterStartBody.requestToken,
        authorizationCode: "native-apple-later-code",
        identityToken: laterSupplied,
      });
      assert.equal(laterAuthorize.status, 200, "later Apple authorization may use its previously verified identity email");
      const laterHandoff = (await laterAuthorize.json() as { handoffCode: string }).handoffCode;
      const laterComplete = await completeMobileOAuth(app.baseUrl, {
        code: laterHandoff,
        codeVerifier: laterVerifier,
        platform: "ios",
      });
      assert.equal(laterComplete.status, 200);
      assert.equal((await laterComplete.json() as { user: { id: string } }).user.id, owner.id);

      const firstTimeVerifier = "native-apple-first-missing-email-verifier-012345";
      const { response: firstTimeStart, challenge: firstTimeChallenge } = await startNative("login", firstTimeVerifier);
      assert.equal(firstTimeStart.status, 201);
      const firstTimeBody = await firstTimeStart.json() as { requestId: string; requestToken: string };
      const firstTimeSupplied = signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-new-missing-email-subject",
        nonce: firstTimeChallenge,
      });
      exchangedTokens.set("native-apple-first-missing-email-code", signNativeAppleIdentityToken({
        privateKey,
        kid,
        subject: "native-apple-new-missing-email-subject",
        nonce: firstTimeChallenge,
      }));
      const firstTimeAuthorize = await authorizeNativeAppleOAuth(app.baseUrl, {
        requestId: firstTimeBody.requestId,
        requestToken: firstTimeBody.requestToken,
        authorizationCode: "native-apple-first-missing-email-code",
        identityToken: firstTimeSupplied,
      });
      assert.equal(firstTimeAuthorize.status, 400);
      assert.equal((await firstTimeAuthorize.json() as { code: string }).code, "native_apple_invalid_credential");
      const [failed] = await getDb().select().from(oauthTransactions)
        .where(eq(oauthTransactions.id, firstTimeBody.requestId));
      assert.equal(failed.status, "failed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("native Apple authorization fails terminally on nonce, audience, subject, email, or verification mismatch", async () => {
  await withNativeAppleOAuthEnv(async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = `native-apple-invalid-${randomUUID()}`;
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    const exchangedTokens = new Map<string, string>();
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://appleid.apple.com/auth/token") {
        assert.ok(init?.body instanceof URLSearchParams);
        return new Response(JSON.stringify({ id_token: exchangedTokens.get(init.body.get("code") ?? "") }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://appleid.apple.com/auth/keys") {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      await seedAppleWebLoginGate(["mobile"]);
      const cases = [
        {
          name: "nonce",
          supplied: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-nonce",
            nonce: `${challenge.slice(0, -1)}x`,
            email: "native-apple-invalid-nonce@slock.test",
          }),
          exchanged: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-nonce",
            nonce: challenge,
            email: "native-apple-invalid-nonce@slock.test",
          }),
        },
        {
          name: "audience",
          supplied: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-audience",
            nonce: challenge,
            email: "native-apple-invalid-audience@slock.test",
            audience: "wrong.native.app",
          }),
          exchanged: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-audience",
            nonce: challenge,
            email: "native-apple-invalid-audience@slock.test",
          }),
        },
        {
          name: "subject",
          supplied: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-subject-a",
            nonce: challenge,
            email: "native-apple-invalid-subject@slock.test",
          }),
          exchanged: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-subject-b",
            nonce: challenge,
            email: "native-apple-invalid-subject@slock.test",
          }),
        },
        {
          name: "email",
          supplied: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-email",
            nonce: challenge,
            email: "native-apple-email-a@slock.test",
          }),
          exchanged: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-invalid-email",
            nonce: challenge,
            email: "native-apple-email-b@slock.test",
          }),
        },
        {
          name: "email-verification",
          supplied: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-unverified-email",
            nonce: challenge,
            email: "native-apple-unverified-email@slock.test",
            emailVerified: false,
          }),
          exchanged: (challenge: string) => signNativeAppleIdentityToken({
            privateKey,
            kid,
            subject: "native-apple-unverified-email",
            nonce: challenge,
            email: "native-apple-unverified-email@slock.test",
          }),
        },
      ];

      for (const invalid of cases) {
        const verifier = `native-apple-invalid-${invalid.name}-verifier-0123456789`;
        const challenge = pkceChallenge(verifier);
        const start = await startNativeAppleOAuth(app.baseUrl, {
          mode: "login",
          platform: "ios",
          appEnv: "production",
          returnUri: "raft://oauth/callback",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
        });
        assert.equal(start.status, 201, invalid.name);
        const started = await start.json() as { requestId: string; requestToken: string };
        const authorizationCode = `native-apple-invalid-${invalid.name}-code`;
        exchangedTokens.set(authorizationCode, invalid.exchanged(challenge));
        const authorize = await authorizeNativeAppleOAuth(app.baseUrl, {
          requestId: started.requestId,
          requestToken: started.requestToken,
          authorizationCode,
          identityToken: invalid.supplied(challenge),
        });
        assert.equal(authorize.status, 400, invalid.name);
        assert.equal((await authorize.json() as { code: string }).code, "native_apple_invalid_credential", invalid.name);
        const [failed] = await getDb().select().from(oauthTransactions)
          .where(eq(oauthTransactions.id, started.requestId));
        assert.equal(failed.status, "failed", invalid.name);

        const replay = await authorizeNativeAppleOAuth(app.baseUrl, {
          requestId: started.requestId,
          requestToken: started.requestToken,
          authorizationCode,
          identityToken: invalid.supplied(challenge),
        });
        assert.equal(replay.status, 410, invalid.name);
      }
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

const malformedRegisterBodies: Array<{
  name: string;
  issuePath: string;
  body: Record<string, unknown>;
}> = [
  {
    name: "object email",
    issuePath: "email",
    body: {
      email: { address: "register-object-email@slock.test" },
      password: "password123",
      name: "register-object-email",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
  },
  {
    name: "object password",
    issuePath: "password",
    body: {
      email: "register-object-password@slock.test",
      password: { raw: "password123" },
      name: "register-object-password",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
  },
  {
    name: "object name",
    issuePath: "name",
    body: {
      email: "register-object-name@slock.test",
      password: "password123",
      name: { display: "register-object-name" },
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
  },
];

for (const malformed of malformedRegisterBodies) {
  test(`POST /api/auth/register malformed ${malformed.name} fails before side effects`, async ({ app }) => {
    const before = await readEmailAuthSideEffectCounts();

    const res = await fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed.body),
    });

    const responseBody = await res.json() as { code?: string; issues?: Array<{ path?: string }> };
    const after = await readEmailAuthSideEffectCounts();

    assert.equal(res.status, 400);
    assert.equal(responseBody.code, "email_register_body_invalid");
    assertIssuePath(responseBody, malformed.issuePath);
    assert.deepEqual(after, before, `${malformed.name} must not create users, legal acceptances, verification rows, or sessions`);
  });
}

const malformedLoginBodies: Array<{
  name: string;
  issuePath: string;
  buildBody: (email: string) => Record<string, unknown>;
}> = [
  {
    name: "object email",
    issuePath: "email",
    buildBody: (_email) => ({ email: { address: "login-object-email@slock.test" }, password: "password123" }),
  },
  {
    name: "object password",
    issuePath: "password",
    buildBody: (email) => ({ email, password: { raw: "password123" } }),
  },
];

for (const malformed of malformedLoginBodies) {
  test(`POST /api/auth/login malformed ${malformed.name} fails before session side effects`, async ({ app }) => {
    const user = await seedUser(`malformed-${malformed.issuePath}@slock.test`, `malformed-${malformed.issuePath}`);
    const before = await readEmailAuthSideEffectCounts();

    const res = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(malformed.buildBody(user.email)),
    });

    const responseBody = await res.json() as { code?: string; issues?: Array<{ path?: string }> };
    const after = await readEmailAuthSideEffectCounts();

    assert.equal(res.status, 400);
    assert.equal(responseBody.code, "email_login_body_invalid");
    assertIssuePath(responseBody, malformed.issuePath);
    assert.deepEqual(after, before, `${malformed.name} must not create users, legal acceptances, verification rows, or sessions`);
  });
}

test("POST /api/auth/login returns a stable code for incorrect credentials", async ({ app }) => {
  const user = await seedUser("wrong-password@slock.test", "wrong-password");

  const res = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "not-the-password" }),
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    code: "AUTH_INVALID_CREDENTIALS",
    error: "Invalid email or password",
  });
});

test("staging self-account retirement is owner-bound, durable, idempotent, and nonsecret", async ({ app }) => {

  const previousBranch = process.env.SLOCK_RELEASE_BRANCH;
  try {
    process.env.SLOCK_RELEASE_BRANCH = "staging";
    const other = await seedUser("retire-other@mail.build", "retire-other");
    const capability = "retirement-capability-owner-1234567890";
    const registration = await fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        email: "retire-owner@mail.build", password: "password123", name: "retire-owner",
        acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
        stagingSelfAccountCapability: capability,
      }),
    });
    assert.equal(registration.status, 200);
    const registered = await registration.json() as { user: { id: string; email: string } };
    const owner = await findUserByEmail(registered.user.email);
    assert.ok(owner);
    assert.equal(owner.stagingSelfAccountCapabilityHash, createHash("sha256").update(capability).digest("hex"));
    await getDb().update(users).set({ emailVerified: true }).where(eq(users.id, owner.id));
    const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: "password123" }),
    });
    const loginBody = await loginResponse.json() as { accessToken: string; refreshToken: string };

    const crossUser = await fetch(`${app.baseUrl}/api/auth/staging-self-account/retire`, {
      method: "POST", headers: { Authorization: `Bearer ${loginBody.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: other.id, capability }),
    });
    assert.equal(crossUser.status, 403);
    assert.equal((await getDb().select().from(userRetirementReceipts)).length, 0);

    const wrongCapability = await fetch(`${app.baseUrl}/api/auth/staging-self-account/retire`, {
      method: "POST", headers: { Authorization: `Bearer ${loginBody.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: owner.id, capability: "wrong-capability-12345678901234567890" }),
    });
    assert.equal(wrongCapability.status, 403);
    assert.equal((await getDb().select().from(userRetirementReceipts)).length, 0);

    const noCapabilityLogin = await login(app.baseUrl, other.email);
    const sharedAccount = await fetch(`${app.baseUrl}/api/auth/staging-self-account/retire`, {
      method: "POST", headers: { Authorization: `Bearer ${noCapabilityLogin}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: other.id, capability }),
    });
    assert.equal(sharedAccount.status, 403);
    assert.equal((await getDb().select().from(userRetirementReceipts)).length, 0);

    const retire = () => fetch(`${app.baseUrl}/api/auth/staging-self-account/retire`, {
      method: "POST", headers: { Authorization: `Bearer ${loginBody.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: owner.id, capability }),
    });
    const first = await retire();
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    const second = await retire();
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), firstBody);
    assert.equal(JSON.stringify(firstBody).includes(owner.email), false);
    assert.equal(JSON.stringify(firstBody).includes(loginBody.refreshToken), false);

    const [retired] = await getDb().select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, owner.id));
    assert.ok(retired.retiredAt);
    assert.equal((await getDb().select().from(sessions).where(eq(sessions.userId, owner.id))).length, 0);
    const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, owner.id));
    assert.ok(families.every((family) => family.revokedAt));

    const passwordDenied = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: "password123" }),
    });
    assert.equal(passwordDenied.status, 401);
    const refreshDenied = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(refreshDenied.status, 401);
    const oldAccessDenied = await fetch(`${app.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
    });
    assert.equal(oldAccessDenied.status, 401);
  } finally {
    if (previousBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH;
    else process.env.SLOCK_RELEASE_BRANCH = previousBranch;
    await app.close();
  }
});

test("staging self-account registration opt-in fails closed outside staging with zero mutation", async ({ app }) => {

  const previousBranch = process.env.SLOCK_RELEASE_BRANCH;
  try {
    delete process.env.SLOCK_RELEASE_BRANCH;
    const email = "production-opt-in@mail.build";
    const response = await fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        email, password: "password123", name: "production-opt-in",
        acceptTerms: true, termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
        stagingSelfAccountCapability: "production-opt-in-capability-1234567890",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(await findUserByEmail(email), undefined);
  } finally {
    if (previousBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH;
    else process.env.SLOCK_RELEASE_BRANCH = previousBranch;
    await app.close();
  }
});

for (const scenario of [
  {
    name: "unknown user",
    reason: "user_missing",
    async credentials() {
      return {
        email: "missing-login-user@slock.test",
        password: "not-the-password",
      };
    },
  },
  {
    name: "password mismatch",
    reason: "password_mismatch",
    async credentials() {
      const user = await seedUser("login-password-mismatch@slock.test", "login-password-mismatch");
      return {
        email: user.email,
        password: "not-the-password",
      };
    },
  },
] as const) {
  test(`POST /api/auth/login traces ${scenario.name} without leaking credentials`, async ({ app }) => {

    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({
      sink,
      traceIdGenerator: () => "c".repeat(32),
      spanIdGenerator: () => "d".repeat(16),
    }));
    try {
      const credentials = await scenario.credentials();
      const res = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });

      assert.equal(res.status, 401);
      assert.equal(res.headers.get("x-slock-trace-id"), "c".repeat(32));
      assert.deepEqual(await res.json(), {
        code: "AUTH_INVALID_CREDENTIALS",
        error: "Invalid email or password",
      });

      const requestSpan = sink.getAllSpans().find((span) =>
        span.name === "server.http.request"
        && span.attrs?.route_pattern === "/api/auth/login"
      );
      assert.ok(requestSpan);
      assert.equal(requestSpan.context.traceId, res.headers.get("x-slock-trace-id"));
      assert.equal(requestSpan.attrs?.auth_trace_source, "email_login");
      assert.equal(requestSpan.attrs?.auth_trace_reason, scenario.reason);
      assert.equal(requestSpan.attrs?.user_id_present, false);
      assert.equal(requestSpan.attrs?.session_id_present, false);

      const rejectionRow = traceEventRowsForSpan(requestSpan, {
        serviceName: "slock-server",
        deploymentEnvironment: "test",
      }).find((row) => row.event_name === "auth.login.rejected");
      assert.ok(rejectionRow);
      assert.equal(rejectionRow.reason, scenario.reason);
      assert.equal(rejectionRow.source, "email_login");
      assert.equal(rejectionRow.trace_id, res.headers.get("x-slock-trace-id"));
      assert.equal(rejectionRow.session_id, null);
      assert.equal(rejectionRow.request_id, null);

      const serializedTrace = JSON.stringify(requestSpan);
      assert.equal(serializedTrace.includes(credentials.email), false);
      assert.equal(serializedTrace.includes(credentials.password), false);
    } finally {
      await app.close();
    }
  });
}

test("PATCH /api/auth/me returns a stable code for incorrect current password", async ({ app }) => {
  const user = await seedUser("current-password@slock.test", "current-password");
  const token = await login(app.baseUrl, user.email);

  const res = await fetch(`${app.baseUrl}/api/auth/me`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ currentPassword: "wrong-password", newPassword: "new-password-123" }),
  });

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), {
    code: "AUTH_CURRENT_PASSWORD_INCORRECT",
    error: "Current password is incorrect",
  });
});

test("PATCH /api/auth/me display language: normalizes+persists supported, clears null, rejects unrenderable", async ({ app }) => {
  const user = await seedUser("display-language@slock.test", "current-password");
  const token = await login(app.baseUrl, user.email);
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const patchDisplay = (displayLanguage: unknown) =>
    fetch(`${app.baseUrl}/api/auth/me`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ displayLanguage }),
    });
  const getMe = async () => {
    const res = await fetch(`${app.baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return (await res.json()) as { displayLanguage: string | null };
  };

  // Supported tag → normalized to the canonical display locale and read back.
  const setRes = await patchDisplay("zh-Hans");
  assert.equal(setRes.status, 200);
  assert.equal(((await setRes.json()) as { displayLanguage: string | null }).displayLanguage, "zh-cn");
  assert.equal((await getMe()).displayLanguage, "zh-cn", "read-back is consistent");

  // Region variant of the same base normalizes too.
  await patchDisplay("en-US");
  assert.equal((await getMe()).displayLanguage, "en");

  // Unrenderable tag (translation taxonomy would accept it) → 400, prior value unchanged.
  const badRes = await patchDisplay("fr-FR");
  assert.equal(badRes.status, 400, "fr-FR is not a shipped UI locale");
  assert.equal((await getMe()).displayLanguage, "en", "rejected write leaves the stored value intact");

  // zh-TW (Traditional) is also rejected — we ship only Simplified.
  assert.equal((await patchDisplay("zh-TW")).status, 400);
  assert.equal((await getMe()).displayLanguage, "en");

  // Explicit null clears the preference.
  const clearRes = await patchDisplay(null);
  assert.equal(clearRes.status, 200);
  assert.equal((await getMe()).displayLanguage, null, "null clears the preference");
});

test("POST /api/auth/register requires legal acceptance", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "legal-missing@slock.test",
      password: "password123",
      name: "legal-missing",
    }),
  });
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string; legal: { termsVersion: string; privacyVersion: string } };
  assert.equal(body.error, "LEGAL_ACCEPTANCE_REQUIRED");
  assert.equal(body.legal.termsVersion, CURRENT_LEGAL_ACCEPTANCE.termsVersion);
  assert.equal(await findUserByEmail("legal-missing@slock.test"), undefined);
});

test("POST /api/auth/register writes append-only legal acceptance for current versions", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "legal-test-agent",
      "Accept-Language": "en-US",
    },
    body: JSON.stringify({
      email: "legal-ok@slock.test",
      password: "password123",
      name: "legal-ok",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { user: { id: string } };

  const acceptance = await getLegalAcceptanceForUser(body.user.id);
  assert.equal(acceptance?.termsVersion, CURRENT_LEGAL_ACCEPTANCE.termsVersion);
  assert.equal(acceptance?.privacyVersion, CURRENT_LEGAL_ACCEPTANCE.privacyVersion);
  assert.equal(acceptance?.termsUrl, CURRENT_LEGAL_ACCEPTANCE.termsUrl);
  assert.equal(acceptance?.privacyUrl, CURRENT_LEGAL_ACCEPTANCE.privacyUrl);
  assert.equal(acceptance?.source, "signup");
  assert.ok(acceptance?.userAgentHash, "user agent evidence is hashed, not stored raw");
  assert.equal(acceptance?.locale, "en-US");
});

test("POST /api/auth/register accepts duplicate final handles as pending identity-setup accounts", async ({ app }) => {
  const before = await readEmailAuthSideEffectCounts();
  const username = `exact-race-${randomUUID().slice(0, 8)}`;
  const register = (email: string) => fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password123",
      name: username,
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });

  const responses = await Promise.all([
    register(`exact-race-a-${randomUUID()}@slock.test`),
    register(`exact-race-b-${randomUUID()}@slock.test`),
  ]);
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{
    user: {
      id: string;
      name: string;
      profileSetupCompletedAt: string | null;
      profileSetupSuggestedHandle: string | null;
    };
  }>));

  assert.deepEqual(statuses, [200, 200]);
  assert.equal(new Set(bodies.map((body) => body.user.id)).size, 2);
  assert.ok(bodies.every((body) => /^pending_[0-9a-f]{20}$/.test(body.user.name)));
  assert.ok(bodies.every((body) => body.user.profileSetupCompletedAt === null));
  assert.ok(bodies.every((body) => body.user.profileSetupSuggestedHandle?.startsWith(username)));

  const after = await readEmailAuthSideEffectCounts();
  assert.deepEqual(after, {
    users: before.users + 2,
    legalAcceptances: before.legalAcceptances + 2,
    emailVerifications: before.emailVerifications + 2,
    sessions: before.sessions + 2,
  }, "identity setup defers final handle uniqueness until profile completion");
});

test("POST /api/auth/register preserves case-sensitive username uniqueness", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const register = (email: string, name: string) => fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "password123",
      name,
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });

  const lower = await register(`case-lower-${randomUUID()}@slock.test`, `case-${suffix}`);
  const upper = await register(`case-upper-${randomUUID()}@slock.test`, `Case-${suffix}`);

  assert.equal(lower.status, 200);
  assert.equal(upper.status, 200);
});

test("POST /api/auth/register records invite source for invite account creation", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "legal-invite@slock.test",
      password: "password123",
      name: "legal-invite",
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      legalAcceptanceSource: "invite",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { user: { id: string } };
  const acceptance = await getLegalAcceptanceForUser(body.user.id);
  assert.equal(acceptance?.source, "invite");
});

test("POST /api/auth/register rejects stale legal versions before creating user", async ({ app }) => {
  const res = await fetch(`${app.baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "legal-stale@slock.test",
      password: "password123",
      name: "legal-stale",
      acceptTerms: true,
      termsVersion: "old-terms",
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    }),
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { error: string };
  assert.equal(body.error, "TERMS_CHANGED");
  assert.equal(await findUserByEmail("legal-stale@slock.test"), undefined);
});

test("social first-login account creation requires legal acceptance", async ({ app }) => {
  const originalFetch = installExampleAvatarFetch();
  try {
    const code = await createSocialAuthCompletion({
      provider: "google",
      mode: "login",
      intendedAction: "login",
      providerUserId: "google-legal-user",
      providerEmail: "google-legal@slock.test",
      providerDisplayName: "Google Legal",
      providerAvatarUrl: "https://example.test/avatar.png",
      providerEmailVerified: true,
      returnTo: "/",
    });

    const missing = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(missing.status, 422);
    assert.equal(await findUserByEmail("google-legal@slock.test"), undefined);

    const accepted = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      }),
    });
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as { accessToken: string; refreshToken: string };
    assert.ok(body.accessToken);
    assert.ok(body.refreshToken);

    const user = await findUserByEmail("google-legal@slock.test");
    assert.ok(user);
    const [acceptance] = await getDb()
      .select()
      .from(userLegalAcceptances)
      .where(and(
        eq(userLegalAcceptances.userId, user.id),
        eq(userLegalAcceptances.source, "oauth"),
      ));
    assert.equal(acceptance?.termsVersion, CURRENT_LEGAL_ACCEPTANCE.termsVersion);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web social auth completion remains web-shaped on the unified transaction table", async ({ app }) => {
  const originalFetch = installExampleAvatarFetch();
  try {
    const user = await seedUser("web-unified@slock.test", "web-unified");
    const code = await createSocialAuthCompletion({
      provider: "google",
      mode: "login",
      intendedAction: "login",
      userId: user.id,
      providerUserId: "google-web-unified-user",
      providerEmail: user.email,
      providerDisplayName: "Web Unified",
      providerAvatarUrl: "https://example.test/web-unified.png",
      providerEmailVerified: true,
      returnTo: "/s/dev",
    });

    const [before] = await getDb()
      .select()
      .from(oauthTransactions)
      .where(eq(oauthTransactions.providerEmail, user.email));
    assert.ok(before);
    assert.ok(before.codeHash, "web rows still use completion code hashes");
    assert.equal(before.status, "provider_completed");
    assert.equal(before.mode, "login");
    assert.equal(before.intendedAction, "login");
    assert.equal(before.returnTo, "/s/dev");
    assert.equal(before.codeChallenge, null);

    const complete = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    assert.equal(complete.status, 200);
    const completeBody = await complete.json() as {
      provider: string;
      mode: string;
      returnTo: string;
      accessToken: string;
      refreshToken: string;
    };
    assert.equal(completeBody.provider, "google");
    assert.equal(completeBody.mode, "login");
    assert.equal(completeBody.returnTo, "/s/dev");
    assert.ok(completeBody.accessToken);
    assert.ok(completeBody.refreshToken);

    const remaining = await getDb()
      .select()
      .from(oauthTransactions)
      .where(eq(oauthTransactions.id, before.id));
    assert.equal(remaining.length, 0, "web completion exchange still deletes the one-time row");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web link completion is owner-bound and one-time under concurrent Google and GitHub exchange", async ({ app }) => {
  for (const provider of ["google", "github"] as const) {
    const owner = await seedUser(
      `${provider}-web-link-race-${randomUUID()}@slock.test`,
      `${provider}-web-link-race-${randomUUID()}`,
    );
    const ownerToken = signAccessToken(owner.id);
    const code = await createSocialAuthCompletion({
      provider,
      mode: "link",
      intendedAction: "link",
      userId: owner.id,
      providerUserId: `${provider}-web-link-race-provider-id`,
      providerEmail: `${provider}-web-link-race-social@slock.test`,
      providerEmailVerified: true,
      returnTo: "/settings?tab=account",
    });

    const complete = () => fetch(`${app.baseUrl}/api/auth/${provider}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    const responses = await Promise.all([complete(), complete()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);

    const identities = await getDb().select().from(userAuthIdentities).where(and(
      eq(userAuthIdentities.userId, owner.id),
      eq(userAuthIdentities.provider, provider),
    ));
    assert.equal(identities.length, 1);
    assert.equal(identities[0]?.providerUserId, `${provider}-web-link-race-provider-id`);
  }
});

test("web link completion survives an expired access token after one same-owner refresh", async () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "web-link-refresh-route-secret";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedUser(
      `web-link-refresh-${randomUUID()}@slock.test`,
      `web-link-refresh-${randomUUID()}`,
    );
    const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: "password123" }),
    });
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json() as { refreshToken: string };
    const expiredAccessToken = jwt.sign({ sub: owner.id, type: "access" }, process.env.JWT_SECRET, {
      expiresIn: -1,
    });
    const completionCode = await createSocialAuthCompletion({
      provider: "github",
      mode: "link",
      intendedAction: "link",
      userId: owner.id,
      providerUserId: "github-web-link-refresh-provider-id",
      providerEmail: "github-web-link-refresh-social@slock.test",
      providerEmailVerified: true,
      returnTo: "/settings?tab=account",
    });

    const expiredComplete = await fetch(`${app.baseUrl}/api/auth/github/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${expiredAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(expiredComplete.status, 401);
    assert.equal((await expiredComplete.json() as { code: string }).code, "auth_required");

    const refresh = await fetch(`${app.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: loginBody.refreshToken }),
    });
    assert.equal(refresh.status, 200);
    const refreshedAccessToken = (await refresh.json() as { accessToken: string }).accessToken;

    const refreshedComplete = await fetch(`${app.baseUrl}/api/auth/github/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshedAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: completionCode }),
    });
    assert.equal(refreshedComplete.status, 200);
    assert.equal((await getDb().select().from(userAuthIdentities).where(and(
      eq(userAuthIdentities.userId, owner.id),
      eq(userAuthIdentities.provider, "github"),
    ))).length, 1);
  } finally {
    await app.close();
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("durable refresh replay returns one encrypted successor only to the exact attempt and installation", async ({ app }) => {
  const owner = await seedUser(
    `durable-refresh-${randomUUID()}@slock.test`,
    `durable-refresh-${randomUUID()}`,
  );
  const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: "password123" }),
  });
  assert.equal(loginResponse.status, 200);
  const predecessor = (await loginResponse.json() as { refreshToken: string }).refreshToken;
  const attemptId = "arf_1234567890abcdef";
  const installationId = "ari_1234567890abcdef1234567890abcdef";
  const durableHeaders = {
    "Content-Type": "application/json",
    "X-Slock-Auth-Refresh-Attempt-Id": attemptId,
    "X-Slock-Auth-Installation-Id": installationId,
  };
  const rotate = () => fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: durableHeaders,
    body: JSON.stringify({ refreshToken: predecessor }),
  });

  // Models two handlers racing before either response is durable on the
  // client. Exactly one consumes the predecessor; both must converge on its
  // child rather than forking or returning a transient 401.
  const concurrentResponses = await Promise.all([rotate(), rotate()]);
  assert.deepEqual(concurrentResponses.map((response) => response.status), [200, 200]);
  const concurrentBodies = await Promise.all(
    concurrentResponses.map((response) => response.json() as Promise<{ refreshToken: string }>),
  );
  assert.equal(concurrentBodies[1]?.refreshToken, concurrentBodies[0]?.refreshToken);
  const first = concurrentBodies[0]!;

  // Models commit-before-response loss: discard the first response, then
  // cold-start with the persisted pair and predecessor.
  const retryResponse = await rotate();
  assert.equal(retryResponse.status, 200);
  const retry = await retryResponse.json() as { refreshToken: string };
  assert.equal(retry.refreshToken, first.refreshToken);

  const [receipt] = await getDb().select().from(sessionRefreshRotationReceipts);
  assert.ok(receipt);
  assert.equal(receipt.attemptId, attemptId);
  assert.equal(receipt.installationId, installationId);
  assert.notEqual(receipt.successorTokenCiphertext, first.refreshToken);
  assert.equal(receipt.successorTokenCiphertext.includes(first.refreshToken), false);

  const wrongAttempt = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { ...durableHeaders, "X-Slock-Auth-Refresh-Attempt-Id": "arf_fedcba0987654321" },
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(wrongAttempt.status, 401);

  const wrongInstallation = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: {
      ...durableHeaders,
      "X-Slock-Auth-Installation-Id": "ari_fedcba0987654321fedcba0987654321",
    },
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(wrongInstallation.status, 401);

  const omittedBinding = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(omittedBinding.status, 401, "omitting headers cannot recover a bound successor");
  assert.equal((await rotate()).status, 200, "legitimate retry remains usable");

  const logout = await fetch(`${app.baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Models explicit logout while the crashed client still only knows the
    // consumed predecessor. This must revoke the receipt's whole family.
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(logout.status, 200);
  const afterRevoke = await rotate();
  assert.equal(afterRevoke.status, 401, "family revocation must take precedence over recovery");
});

test("durable refresh replay rejects malformed binding without consuming the predecessor and expires closed", async ({ app }) => {
  const owner = await seedUser(
    `durable-refresh-expiry-${randomUUID()}@slock.test`,
    `durable-refresh-expiry-${randomUUID()}`,
  );
  const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: owner.email, password: "password123" }),
  });
  const predecessor = (await loginResponse.json() as { refreshToken: string }).refreshToken;
  const attemptId = "arf_0011223344556677";
  const installationId = "ari_00112233445566778899aabbccddeeff";

  const malformed = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slock-Auth-Refresh-Attempt-Id": attemptId,
      "X-Slock-Auth-Installation-Id": "ari_not-an-installation",
    },
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(malformed.status, 400);

  const exactHeaders = {
    "Content-Type": "application/json",
    "X-Slock-Auth-Refresh-Attempt-Id": attemptId,
    "X-Slock-Auth-Installation-Id": installationId,
  };
  const first = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: exactHeaders,
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(first.status, 200, "invalid binding must have zero token mutation");

  await getDb().update(sessionRefreshRotationReceipts)
    .set({ expiresAt: new Date(Date.now() - 1_000) });
  const expired = await fetch(`${app.baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: exactHeaders,
    body: JSON.stringify({ refreshToken: predecessor }),
  });
  assert.equal(expired.status, 401);
});

test("desktop loopback callback rejects a signed nonce that differs from the stored return target", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    let providerExchangeCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        providerExchangeCalls += 1;
        throw new Error("provider exchange must not run for a mismatched desktop nonce");
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const returnUri = "http://127.0.0.1:49152/auth/done#state=desktop_nonce_0123456789abcdef";
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri,
        codeChallenge: pkceChallenge("desktop-nonce-binding-verifier"),
      });
      assert.equal(start.status, 201);
      const startBody = await start.json() as { requestId: string; authorizationUrl: string };
      const originalState = verifySocialAuthState(new URL(startBody.authorizationUrl).searchParams.get("state")!);
      const tamperedState = signSocialAuthState({
        provider: originalState.provider,
        mode: originalState.mode,
        nonce: originalState.nonce,
        kind: originalState.kind,
        mobileRequestId: originalState.mobileRequestId,
        desktopNonce: "different_nonce_0123456789abcdef",
      });

      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(tamperedState)}`,
      );
      assert.equal(callback.status, 400);
      assert.equal(await callback.text(), "Invalid mobile OAuth request");
      assert.equal(providerExchangeCalls, 0);

      const [request] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(request.status, "pending_provider");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("native OAuth login preserves desktop loopback state through provider handoff and one-time PKCE complete", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-mobile-user",
          email: "mobile-login@slock.test",
          email_verified: true,
          name: "Mobile Login",
          picture: "https://example.test/mobile.png",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://example.test/mobile.png") {
        return createTestAvatarResponse();
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const verifier = "mobile-login-verifier-0123456789";
      const desktopState = "desktop_nonce_0123456789abcdef";
      const desktopReturnUri = `http://127.0.0.1:49152/auth/done#state=${desktopState}`;
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: desktopReturnUri,
        codeChallenge: pkceChallenge(verifier),
      });
      assert.equal(start.status, 201);
      const startBody = await start.json() as { requestId: string; authorizationUrl: string; returnUri: string };
      assert.equal(startBody.returnUri, desktopReturnUri);
      const [startedRequest] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(startedRequest.returnTo, desktopReturnUri);
      const authorizationUrl = new URL(startBody.authorizationUrl);
      assert.equal(authorizationUrl.origin, "https://accounts.google.com");
      assert.equal(verifySocialAuthState(authorizationUrl.searchParams.get("state")!).desktopNonce, desktopState);

      process.env.MOBILE_OAUTH_RETURN_URI = "raft-changed://oauth/callback";
      const callbackUrl = `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`;
      const callback = await callbackMobileOAuth(callbackUrl);
      assert.equal(callback.status, 302);
      const location = callback.headers.get("location");
      assert.ok(location);
      const returned = new URL(location);
      assert.equal(`${returned.protocol}//${returned.host}${returned.pathname}`, "http://127.0.0.1:49152/auth/done");
      assert.equal(returned.hash, `#state=${desktopState}`);
      const handoffCode = returned.searchParams.get("code");
      assert.ok(handoffCode);

      const browserExchange = await fetch(`${app.baseUrl}/api/auth/google/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: handoffCode }),
      });
      assert.equal(browserExchange.status, 400);
      const [afterBrowserExchangeAttempt] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterBrowserExchangeAttempt.status, "provider_completed");
      assert.ok(afterBrowserExchangeAttempt.codeHash);

      const complete = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: verifier,
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      });
      assert.equal(complete.status, 200);
      const completeBody = await complete.json() as {
        user: {
          id: string;
          email: string;
          name: string;
          profileSetupCompletedAt: string | null;
          profileSetupProvider: "google" | "github" | "apple" | null;
        };
        accessToken: string;
        refreshToken: string;
        mode: string;
        returnUri: string;
      };
      assert.equal(completeBody.user.email, "mobile-login@slock.test");
      assert.match(completeBody.user.name, /^pending_[0-9a-f]{20}$/);
      assert.equal(completeBody.user.profileSetupCompletedAt, null);
      assert.equal(completeBody.user.profileSetupProvider, "google");
      assert.ok(completeBody.accessToken);
      assert.ok(completeBody.refreshToken);
      assert.equal(completeBody.mode, "login");
      assert.equal(completeBody.returnUri, desktopReturnUri);
      assert.equal((await findUserByEmail("mobile-login@slock.test"))?.id, completeBody.user.id);

      const replay = await completeMobileOAuth(app.baseUrl, { code: handoffCode, codeVerifier: verifier });
      assert.equal(replay.status, 410);
      assert.equal((await replay.json() as { code: string }).code, "handoff_code_consumed");

      const [request] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(request.status, "completed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth legal retry does not consume the unified-table handoff before acceptance", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-legal-retry-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-mobile-legal-retry-user",
          email: "mobile-legal-retry@slock.test",
          email_verified: true,
          name: "Mobile Legal Retry",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const verifier = "mobile-legal-retry-verifier-123456789";
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      });
      assert.equal(start.status, 201);
      const startBody = await start.json() as { requestId: string; authorizationUrl: string };
      const started = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(started[0]?.status, "pending_provider");
      assert.equal(started[0]?.codeHash, null);
      assert.equal(started[0]?.codeChallenge, pkceChallenge(verifier));

      const authorizationUrl = new URL(startBody.authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const handoffCode = new URL(callback.headers.get("location")!).searchParams.get("code");
      assert.ok(handoffCode);

      const missingLegal = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: verifier,
      });
      assert.equal(missingLegal.status, 422);
      assert.equal((await missingLegal.json() as { error: string }).error, "LEGAL_ACCEPTANCE_REQUIRED");
      assert.equal(await findUserByEmail("mobile-legal-retry@slock.test"), undefined);
      const [afterLegalBlock] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterLegalBlock.status, "provider_completed");
      assert.ok(afterLegalBlock.codeHash);

      const accepted = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: verifier,
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      });
      assert.equal(accepted.status, 200);
      const acceptedBody = await accepted.json() as {
        user: { id: string; email: string };
        accessToken: string;
        refreshToken: string;
      };
      assert.equal(acceptedBody.user.email, "mobile-legal-retry@slock.test");
      assert.ok(acceptedBody.accessToken);
      assert.ok(acceptedBody.refreshToken);
      const [afterAccepted] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(afterAccepted.status, "completed");

      const replay = await completeMobileOAuth(app.baseUrl, { code: handoffCode, codeVerifier: verifier });
      assert.equal(replay.status, 410);
      assert.equal((await replay.json() as { code: string }).code, "handoff_code_consumed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth GitHub login completes through the shared handoff contract", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "github-mobile-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({
          id: 98765,
          login: "github-mobile",
          name: "GitHub Mobile",
          avatar_url: "https://example.test/github-mobile.png",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(JSON.stringify([
          {
            email: "mobile-github@slock.test",
            primary: true,
            verified: true,
          },
        ]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://example.test/github-mobile.png") {
        return createTestAvatarResponse();
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const verifier = "mobile-github-verifier-0123456789";
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "github",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      });
      assert.equal(start.status, 201);
      const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
      assert.equal(authorizationUrl.origin, "https://github.com");

      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/github/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const handoffCode = new URL(callback.headers.get("location")!).searchParams.get("code");
      assert.ok(handoffCode);

      const complete = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: verifier,
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      });
      assert.equal(complete.status, 200);
      const completeBody = await complete.json() as {
        user: {
          id: string;
          email: string;
          name: string;
          profileSetupCompletedAt: string | null;
          profileSetupProvider: "google" | "github" | "apple" | null;
        };
        accessToken: string;
        refreshToken: string;
        mode: string;
      };
      assert.equal(completeBody.user.email, "mobile-github@slock.test");
      assert.match(completeBody.user.name, /^pending_[0-9a-f]{20}$/);
      assert.equal(completeBody.user.profileSetupCompletedAt, null);
      assert.equal(completeBody.user.profileSetupProvider, "github");
      assert.ok(completeBody.accessToken);
      assert.ok(completeBody.refreshToken);
      assert.equal(completeBody.mode, "login");

      const refresh = await fetch(`${app.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: completeBody.refreshToken }),
      });
      assert.equal(refresh.status, 200);
      const refreshedAccessToken = (await refresh.json() as { accessToken: string }).accessToken;
      const recovered = await fetch(`${app.baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${refreshedAccessToken}` },
      });
      assert.equal(recovered.status, 200);
      const recoveredUser = await recovered.json() as {
        name: string;
        profileSetupCompletedAt: string | null;
        profileSetupProvider: "google" | "github" | "apple" | null;
      };
      assert.match(recoveredUser.name, /^pending_[0-9a-f]{20}$/);
      assert.equal(recoveredUser.profileSetupCompletedAt, null);
      assert.equal(recoveredUser.profileSetupProvider, "github");

      const user = await findUserByEmail("mobile-github@slock.test");
      assert.ok(user);
      assert.equal(user.id, completeBody.user.id);
      const [identity] = await getDb().select().from(userAuthIdentities).where(and(
        eq(userAuthIdentities.userId, user.id),
        eq(userAuthIdentities.provider, "github"),
      ));
      assert.equal(identity.providerUserId, "98765");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth start fails closed for disabled return target", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "https://evil.example.test/oauth/callback",
        codeChallenge: pkceChallenge("disabled-return-verifier"),
      });
      assert.equal(start.status, 400);
      assert.equal((await start.json() as { code: string }).code, "return_uri_not_allowed");
    } finally {
      await app.close();
    }
  });
});

test("mobile OAuth start falls back to legacy allowed return URI env", async () => {
  await withMobileOAuthEnv(async () => {
    delete process.env.MOBILE_OAUTH_RETURN_URI;
    process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS = "raft-legacy://oauth/callback";
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-legacy://oauth/callback",
        codeChallenge: pkceChallenge("legacy-return-verifier"),
      });
      assert.equal(start.status, 201);
      assert.equal((await start.json() as { returnUri: string }).returnUri, "raft-legacy://oauth/callback");

      const disabledDefaultReturn = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("legacy-return-default-disabled-verifier"),
      });
      assert.equal(disabledDefaultReturn.status, 400);
      assert.equal((await disabledDefaultReturn.json() as { code: string }).code, "return_uri_not_allowed");
    } finally {
      await app.close();
    }
  });
});

test("mobile OAuth start accepts an allowlisted variant return URI", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const allowlistedBetaReturn = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-beta://oauth/callback",
        codeChallenge: pkceChallenge("allowlisted-return-verifier"),
      });
      assert.equal(allowlistedBetaReturn.status, 201);
      assert.equal((await allowlistedBetaReturn.json() as { returnUri: string }).returnUri, "raft-beta://oauth/callback");

      const missingReturnUri = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        codeChallenge: pkceChallenge("missing-return-verifier"),
      });
      assert.equal(missingReturnUri.status, 400);
      assert.equal((await missingReturnUri.json() as { code: string }).code, "return_uri_not_allowed");
    } finally {
      await app.close();
    }
  });
});

test("mobile OAuth provider cancel returns app error and terminal failed state", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("provider-cancel-verifier"),
      });
      const startBody = await start.json() as { requestId: string; authorizationUrl: string };
      const authorizationUrl = new URL(startBody.authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const returned = new URL(callback.headers.get("location")!);
      assert.equal(returned.searchParams.get("error"), "access_denied");
      const [request] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(request.status, "failed");
    } finally {
      await app.close();
    }
  });
});

test("mobile OAuth provider exchange failure returns app error without web fallback", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("provider-failure-verifier"),
      });
      const startBody = await start.json() as { requestId: string; authorizationUrl: string };
      const authorizationUrl = new URL(startBody.authorizationUrl);

      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=bad-provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const returned = new URL(callback.headers.get("location")!);
      assert.equal(`${returned.protocol}//${returned.host}${returned.pathname}`, "raft-debug://oauth/callback");
      assert.equal(returned.searchParams.get("error"), "provider_exchange_failed");
      const [request] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(request.status, "failed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth invalid mobile state fails closed without web callback redirect", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const state = signSocialAuthState({
        kind: "mobile",
        provider: "google",
        mode: "login",
        nonce: "nonce",
        mobileRequestId: randomUUID(),
      });

      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      );
      assert.equal(callback.status, 400);
      assert.equal(callback.headers.get("location"), null);
    } finally {
      await app.close();
    }
  });
});

test("mobile OAuth complete rejects expired handoff codes", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-expired-token" }), { status: 200 });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-expired-user",
          email: "mobile-expired@slock.test",
          email_verified: true,
        }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const verifier = "mobile-expired-verifier-123456789";
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      });
      const startBody = await start.json() as { requestId: string; authorizationUrl: string };
      const authorizationUrl = new URL(startBody.authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      const handoffCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;

      await getDb()
        .update(oauthTransactions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(oauthTransactions.id, startBody.requestId));

      const complete = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: verifier,
      });
      assert.equal(complete.status, 410);
      assert.equal((await complete.json() as { code: string }).code, "handoff_code_expired");
      assert.equal(await findUserByEmail("mobile-expired@slock.test"), undefined);
      const [request] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, startBody.requestId));
      assert.equal(request.status, "expired");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth complete rejects PKCE mismatch and does not issue a session", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), { status: 200 });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-pkce-user",
          email: "mobile-pkce@slock.test",
          email_verified: true,
        }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge("correct-verifier-123456789"),
      });
      const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      const handoffCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;
      const complete = await completeMobileOAuth(app.baseUrl, {
        code: handoffCode,
        codeVerifier: "wrong-verifier-123456789",
      });
      assert.equal(complete.status, 400);
      assert.equal((await complete.json() as { code: string }).code, "pkce_mismatch");
      assert.equal(await findUserByEmail("mobile-pkce@slock.test"), undefined);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth explicit link contract requires bearer, links identity, and returns no login session", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-link-token" }), { status: 200 });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-link-user",
          email: "mobile-link-social@slock.test",
          email_verified: true,
        }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const owner = await seedUser(`mobile-link-owner-${randomUUID()}@slock.test`, `mobile-link-owner-${randomUUID()}`);
      const other = await seedUser(`mobile-link-other-${randomUUID()}@slock.test`, `mobile-link-other-${randomUUID()}`);
      const ownerToken = signAccessToken(owner.id);
      const otherToken = signAccessToken(other.id);
      const verifier = "mobile-link-verifier-123456789";

      const unauthenticatedStart = await startMobileOAuthLink(app.baseUrl, "google", {
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      });
      assert.equal(unauthenticatedStart.status, 401);

      const start = await startMobileOAuthLink(app.baseUrl, "google", {
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      }, ownerToken);
      assert.equal(start.status, 201);
      const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const callbackLocation = new URL(callback.headers.get("location")!);
      assert.equal(callbackLocation.searchParams.get("provider"), "google");
      assert.equal(callbackLocation.searchParams.get("mode"), "link");
      const handoffCode = callbackLocation.searchParams.get("code")!;

      const mismatch = await completeMobileOAuthLink(app.baseUrl, "google", {
        code: handoffCode,
        codeVerifier: verifier,
      }, otherToken);
      assert.equal(mismatch.status, 403);
      assert.equal((await mismatch.json() as { code: string }).code, "link_user_mismatch");

      const ok = await completeMobileOAuthLink(app.baseUrl, "google", {
        code: handoffCode,
        codeVerifier: verifier,
      }, ownerToken);
      assert.equal(ok.status, 200);
      const okBody = await ok.json() as {
        provider: string;
        mode: string;
        identities: Array<{ provider: string; providerEmail: string }>;
        accessToken?: string;
        refreshToken?: string;
      };
      assert.equal(okBody.provider, "google");
      assert.equal(okBody.mode, "link");
      assert.equal(okBody.accessToken, undefined);
      assert.equal(okBody.refreshToken, undefined);
      assert.deepEqual(okBody.identities, [{
        provider: "google",
        providerEmail: "mobile-link-social@slock.test",
      }]);
      const [identity] = await getDb().select().from(userAuthIdentities).where(and(
        eq(userAuthIdentities.userId, owner.id),
        eq(userAuthIdentities.provider, "google"),
      ));
      assert.equal(identity.providerUserId, "google-link-user");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("mobile OAuth explicit link complete rejects login handoff codes", async () => {
  await withMobileOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-login-token" }), { status: 200 });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(JSON.stringify({
          sub: "google-login-mode-user",
          email: "mobile-link-login-mode@slock.test",
          email_verified: true,
        }), { status: 200 });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const owner = await seedUser(`mobile-link-mode-owner-${randomUUID()}@slock.test`, `mobile-link-mode-owner-${randomUUID()}`);
      const ownerToken = signAccessToken(owner.id);
      const verifier = "mobile-link-mode-verifier-123456789";
      const start = await startMobileOAuth(app.baseUrl, {
        provider: "google",
        mode: "login",
        returnUri: "raft-debug://oauth/callback",
        codeChallenge: pkceChallenge(verifier),
      });
      assert.equal(start.status, 201);
      const authorizationUrl = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl);
      const callback = await callbackMobileOAuth(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(authorizationUrl.searchParams.get("state")!)}`,
      );
      assert.equal(callback.status, 302);
      const handoffCode = new URL(callback.headers.get("location")!).searchParams.get("code")!;

      const linkComplete = await completeMobileOAuthLink(app.baseUrl, "google", {
        code: handoffCode,
        codeVerifier: verifier,
      }, ownerToken);
      assert.equal(linkComplete.status, 400);
      assert.equal((await linkComplete.json() as { code: string }).code, "mode_mismatch");
      assert.equal(await findUserByEmail("mobile-link-login-mode@slock.test"), undefined);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

test("POST /api/auth/me/avatar uploads current user avatar", async ({ app }) => {
  const user = await seedUser("human-avatar@slock.test", "human-avatar");
  const token = await login(app.baseUrl, user.email);

  const formData = new FormData();
  formData.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "avatar.gif");

  const res = await fetch(`${app.baseUrl}/api/auth/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { avatarUrl: string | null };
  assert.match(body.avatarUrl ?? "", /^\/api\/avatars\/users\/[0-9a-f]+\.webp$/);

  const getRes = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(getRes.status, 200);
  const getBody = await getRes.json() as { avatarUrl: string | null };
  assert.equal(getBody.avatarUrl, body.avatarUrl);
});

test("POST /api/auth/me/avatar rejects oversized avatars with a clear limit error", async ({ app }) => {
  const user = await seedUser("human-avatar-large@slock.test", "human-avatar-large");
  const token = await login(app.baseUrl, user.email);

  const formData = new FormData();
  formData.set("avatar", new Blob([new Uint8Array(MAX_PROFILE_AVATAR_BYTES + 1)], { type: "image/png" }), "huge.png");

  const res = await fetch(`${app.baseUrl}/api/auth/me/avatar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; errorCode: string; maxBytes: number };
  assert.equal(body.error, PROFILE_AVATAR_TOO_LARGE_MESSAGE);
  assert.equal(body.errorCode, "PROFILE_AVATAR_TOO_LARGE");
  assert.equal(body.maxBytes, MAX_PROFILE_AVATAR_BYTES);
});

test("GET /api/auth/me returns current user's gravatar hash", async ({ app }) => {
  const user = await seedUser("gravatar-self@slock.test", "gravatar-self");
  const token = await login(app.baseUrl, user.email);

  const res = await fetch(`${app.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { gravatarHash: string };
  assert.equal(
    body.gravatarHash,
    createHash("sha256").update(user.email.trim().toLowerCase()).digest("hex"),
  );
});
