// Task #1304: a social login whose email already has an account links the
// provider inline. The client opts in with linkOnConflict, the completion
// endpoint answers 409 account_link_required with a one-time pendingLinkToken,
// and a later sign-in to that account (password or another linked provider)
// links the identity before any session is issued.
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { oauthTransactions, sessions, userAuthIdentities, users } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { socialCompletionCookie } from "../test/integration/socialCompletionCookie";
import * as sessionService from "../services/sessionService";
import * as userService from "../services/userService";
import { vi } from "vitest";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const EXISTING_EMAIL = "existing@slock.test";

function withOAuthEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env.JWT_SECRET = "pending-link-test-secret";
  process.env.SOCIAL_AUTH_STATE_SECRET = "pending-link-state-secret";
  delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
  process.env.MOBILE_OAUTH_RETURN_URI = "raft://oauth/callback";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  process.env.SERVER_URL = "https://api.example.test";
  return fn();
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Google returns `googleEmail`; GitHub returns `githubEmail`. */
function installProviderFetch(emails: { google: string; github?: string }): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "google-access-token" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return json({ sub: "google-sub-1304", email: emails.google, email_verified: true, name: "Google Person" });
    }
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "github-access-token" });
    if (url === "https://api.github.com/user") return json({ id: 1304, login: "gh1304", name: "GitHub Person" });
    if (url === "https://api.github.com/user/emails") {
      return json([{ email: emails.github ?? emails.google, primary: true, verified: true }]);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    passwordCredentialEstablishedAt: new Date(),
    emailVerified: true,
  }).returning();
  return user;
}

async function sessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

async function identityOwner(provider: "google" | "github", providerUserId: string): Promise<string | undefined> {
  const [row] = await getDb().select({ userId: userAuthIdentities.userId }).from(userAuthIdentities).where(and(
    eq(userAuthIdentities.provider, provider),
    eq(userAuthIdentities.providerUserId, providerUserId),
  ));
  return row?.userId;
}

/** Runs the web start → provider callback and returns the app redirect. */
async function webProviderRoundTrip(baseUrl: string, provider: "google" | "github", query: string): Promise<URL> {
  const start = await fetch(`${baseUrl}/api/auth/${provider}/start${query}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(
    `${baseUrl}/api/auth/${provider}/callback?code=provider-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { Cookie: cookie } },
  );
  assert.equal(callback.status, 302);
  return new URL(callback.headers.get("location")!);
}

/** Web social completion (`/api/auth/:provider/complete`) carries the browser binding its callback left. */
function webCompletionCookie(path: string, body: unknown): Record<string, string> {
  const provider = /^\/api\/auth\/(google|github|apple)\/complete$/.exec(path)?.[1];
  const code = (body as { code?: unknown } | null)?.code;
  return provider && typeof code === "string" ? { Cookie: socialCompletionCookie(provider, code) } : {};
}

async function post(baseUrl: string, path: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...webCompletionCookie(path, body) },
    body: JSON.stringify(body),
  });
}

type LinkRequired = {
  code: string;
  pendingLinkToken: string;
  provider: string;
  email: string;
  expiresAt: string;
  signInMethods: { password: boolean; providers: string[] };
  returnTo?: string;
  returnUri?: string;
};

async function webConflictToken(baseUrl: string): Promise<LinkRequired> {
  const redirect = await webProviderRoundTrip(baseUrl, "google", "?linkOnConflict=1&returnTo=%2Fs%2Fhome");
  assert.equal(redirect.searchParams.get("error"), null, "an opted-in conflict is not an error redirect");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const complete = await post(baseUrl, "/api/auth/google/complete", { code });
  assert.equal(complete.status, 409);
  const body = await complete.json() as LinkRequired;
  assert.equal(body.code, "account_link_required");
  return body;
}

test("web: a Google conflict links Google once the existing account signs in with its password", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const other = await seedUser("other@slock.test", "other");

      const pending = await webConflictToken(app.baseUrl);
      assert.equal(pending.provider, "google");
      assert.equal(pending.email, EXISTING_EMAIL);
      assert.equal(pending.returnTo, "/s/home");
      assert.deepEqual(pending.signInMethods, { password: true, providers: [] });
      assert.ok(pending.pendingLinkToken.length >= 32);
      assert.equal(await sessionCount(existing.id), 0, "the conflict itself signs nobody in");
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined);

      // Wrong password: the ordinary 401, and the token is still usable.
      const wrongPassword = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "nope", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(wrongPassword.status, 401);
      assert.equal((await wrongPassword.json() as { code: string }).code, "AUTH_INVALID_CREDENTIALS");

      // Another account: refused before a session, token still usable.
      const wrongAccount = await post(app.baseUrl, "/api/auth/login", {
        email: "other@slock.test", password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(wrongAccount.status, 403);
      assert.equal((await wrongAccount.json() as { code: string }).code, "pending_link_account_mismatch");
      assert.equal(await sessionCount(other.id), 0, "a refused link issues no session");
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined);

      const signedIn = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(signedIn.status, 200);
      const signedInBody = await signedIn.json() as { user: { id: string }; accessToken: string; linkedProvider: string };
      assert.equal(signedInBody.user.id, existing.id);
      assert.ok(signedInBody.accessToken);
      assert.equal(signedInBody.linkedProvider, "google");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);

      // One-time.
      const replay = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(replay.status, 410);
      assert.equal((await replay.json() as { code: string }).code, "pending_link_expired");
      assert.equal(await sessionCount(existing.id), 1, "the replay issued no second session");

      // Google now signs straight in to the existing account.
      const again = await webProviderRoundTrip(app.baseUrl, "google", "?linkOnConflict=1");
      const direct = await post(app.baseUrl, "/api/auth/google/complete", { code: again.searchParams.get("code") });
      assert.equal(direct.status, 200);
      assert.ok((await direct.json() as { accessToken?: string }).accessToken);
      assert.equal(await sessionCount(existing.id), 2);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("web: without linkOnConflict the conflict stays the old error redirect", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      await seedUser(EXISTING_EMAIL, "existing");
      const redirect = await webProviderRoundTrip(app.baseUrl, "google", "");
      assert.equal(redirect.searchParams.get("code"), null);
      assert.match(redirect.searchParams.get("error") ?? "", /email already exists/);
      assert.equal((await getDb().select().from(oauthTransactions)).length, 0, "nothing is kept for an old client");
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("web: the conflict completion carries no userId, so an older server cannot sign it in", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      await seedUser(EXISTING_EMAIL, "existing");
      const redirect = await webProviderRoundTrip(app.baseUrl, "google", "?linkOnConflict=1");
      assert.ok(redirect.searchParams.get("code"));
      const [row] = await getDb().select().from(oauthTransactions);
      assert.equal(row.mode, "login");
      assert.equal(row.intendedAction, "link");
      assert.equal(row.status, "provider_completed");
      assert.equal(row.userId, null);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("web: signing in with another linked provider completes the pending link", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      await getDb().insert(userAuthIdentities).values({
        userId: existing.id, provider: "github", providerUserId: "1304", providerEmail: EXISTING_EMAIL,
      });

      const pending = await webConflictToken(app.baseUrl);
      assert.deepEqual(pending.signInMethods.providers, ["github"]);

      const github = await webProviderRoundTrip(app.baseUrl, "github", "?linkOnConflict=1");
      const complete = await post(app.baseUrl, "/api/auth/github/complete", {
        code: github.searchParams.get("code"), pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(complete.status, 200);
      const body = await complete.json() as { accessToken?: string; linkedProvider?: string };
      assert.ok(body.accessToken);
      assert.equal(body.linkedProvider, "google");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("web: a provider sign-in to a different account is refused before its completion code is spent", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL, github: "other@slock.test" });
    try {
      await seedUser(EXISTING_EMAIL, "existing");
      const other = await seedUser("other@slock.test", "other");
      await getDb().insert(userAuthIdentities).values({
        userId: other.id, provider: "github", providerUserId: "1304", providerEmail: "other@slock.test",
      });

      const pending = await webConflictToken(app.baseUrl);
      const github = await webProviderRoundTrip(app.baseUrl, "github", "");
      const code = github.searchParams.get("code");
      const refused = await post(app.baseUrl, "/api/auth/github/complete", { code, pendingLinkToken: pending.pendingLinkToken });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json() as { code: string }).code, "pending_link_account_mismatch");
      assert.equal(await sessionCount(other.id), 0);

      // The GitHub code was not spent, so signing in without the link still works.
      const plain = await post(app.baseUrl, "/api/auth/github/complete", { code });
      assert.equal(plain.status, 200);
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("cancel drops the pending link", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const pending = await webConflictToken(app.baseUrl);
      const cancel = await post(app.baseUrl, "/api/auth/pending-link/cancel", { pendingLinkToken: pending.pendingLinkToken });
      assert.equal(cancel.status, 204);
      const cancelAgain = await post(app.baseUrl, "/api/auth/pending-link/cancel", { pendingLinkToken: pending.pendingLinkToken });
      assert.equal(cancelAgain.status, 204);

      const login = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(login.status, 410);
      assert.equal(await sessionCount(existing.id), 0);
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("an expired pending link issues no session", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const pending = await webConflictToken(app.baseUrl);
      await getDb().update(oauthTransactions).set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(oauthTransactions.status, "pending_link"));
      const login = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(login.status, 410);
      assert.equal((await login.json() as { code: string }).code, "pending_link_expired");
      assert.equal(await sessionCount(existing.id), 0);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("desktop/mobile: the conflict returns a code, and PKCE complete answers account_link_required", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const verifier = "pending-link-desktop-verifier-0123456789";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const returnUri = "http://127.0.0.1:49152/auth/done#state=desktop_nonce_0123456789abcdef";
      const start = await post(app.baseUrl, "/api/auth/mobile/oauth/start", {
        provider: "google", mode: "login", returnUri, codeChallenge: challenge, linkOnConflict: true,
      });
      assert.equal(start.status, 201);
      const { authorizationUrl, requestId } = await start.json() as { authorizationUrl: string; requestId: string };
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      const callback = await fetch(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      assert.equal(callback.status, 302);
      const returned = new URL(callback.headers.get("location")!);
      assert.equal(returned.searchParams.get("error"), null);
      const code = returned.searchParams.get("code");
      assert.ok(code);
      const [row] = await getDb().select().from(oauthTransactions).where(eq(oauthTransactions.id, requestId));
      assert.equal(row.intendedAction, "link");
      assert.equal(row.userId, null, "an older server must not sign this completion in");

      const wrongVerifier = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", { code, codeVerifier: "wrong-verifier-0123456789012345" });
      assert.equal(wrongVerifier.status, 400, "the link token is only for the PKCE holder");

      // A fresh start, since a wrong verifier fails the request.
      const start2 = await post(app.baseUrl, "/api/auth/mobile/oauth/start", {
        provider: "google", mode: "login", returnUri, codeChallenge: challenge, linkOnConflict: true,
      });
      const state2 = new URL((await start2.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
      const callback2 = await fetch(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(state2)}`,
        { redirect: "manual" },
      );
      const code2 = new URL(callback2.headers.get("location")!).searchParams.get("code");
      const complete = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", { code: code2, codeVerifier: verifier });
      assert.equal(complete.status, 409);
      const pending = await complete.json() as LinkRequired;
      assert.equal(pending.code, "account_link_required");
      assert.equal(pending.email, EXISTING_EMAIL);
      assert.equal(pending.returnUri, returnUri);
      assert.equal(await sessionCount(existing.id), 0);

      const replayHandoff = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", { code: code2, codeVerifier: verifier });
      assert.notEqual(replayHandoff.status, 200, "the handoff code was swapped for the link token");
      assert.notEqual(replayHandoff.status, 409);

      const login = await post(app.baseUrl, "/api/auth/login", {
        email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(login.status, 200);
      assert.equal((await login.json() as { linkedProvider: string }).linkedProvider, "google");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("desktop/mobile: without linkOnConflict the callback still reports account_conflict", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      await seedUser(EXISTING_EMAIL, "existing");
      const challenge = createHash("sha256").update("old-client-verifier-0123456789abcdef").digest("base64url");
      const start = await post(app.baseUrl, "/api/auth/mobile/oauth/start", {
        provider: "google", mode: "login", returnUri: "raft://oauth/callback", codeChallenge: challenge,
      });
      const state = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
      const callback = await fetch(
        `${app.baseUrl}/api/auth/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      const returned = new URL(callback.headers.get("location")!);
      assert.equal(returned.searchParams.get("error"), "account_conflict");
      assert.equal(returned.searchParams.get("code"), null);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("desktop/mobile: signing in with another linked provider over PKCE completes the pending link", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      await getDb().insert(userAuthIdentities).values({
        userId: existing.id, provider: "github", providerUserId: "1304", providerEmail: EXISTING_EMAIL,
      });
      const verifier = "pending-link-mobile-provider-verifier-0123";
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      async function mobileRoundTrip(provider: "google" | "github"): Promise<string> {
        const start = await post(app.baseUrl, "/api/auth/mobile/oauth/start", {
          provider, mode: "login", returnUri: "raft://oauth/callback", codeChallenge: challenge, linkOnConflict: true,
        });
        assert.equal(start.status, 201);
        const state = new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
        const callback = await fetch(
          `${app.baseUrl}/api/auth/${provider}/callback?code=provider-code&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        const code = new URL(callback.headers.get("location")!).searchParams.get("code");
        assert.ok(code);
        return code;
      }

      const conflict = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", { code: await mobileRoundTrip("google"), codeVerifier: verifier });
      assert.equal(conflict.status, 409);
      const pending = await conflict.json() as LinkRequired;
      assert.deepEqual(pending.signInMethods.providers, ["github"]);

      const complete = await post(app.baseUrl, "/api/auth/mobile/oauth/complete", {
        code: await mobileRoundTrip("github"), codeVerifier: verifier, pendingLinkToken: pending.pendingLinkToken,
      });
      assert.equal(complete.status, 200);
      const body = await complete.json() as { user: { id: string }; accessToken?: string; linkedProvider?: string };
      assert.equal(body.user.id, existing.id);
      assert.ok(body.accessToken);
      assert.equal(body.linkedProvider, "google");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);
    } finally {
      restoreFetch();
      await app.close();
    }
  });
});

test("password: a session issuance failure rolls the link back and keeps the token usable", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const pending = await webConflictToken(app.baseUrl);
      const create = vi.spyOn(sessionService, "createSession").mockRejectedValueOnce(new Error("injected session issuance failure"));
      const result = await post(app.baseUrl, "/api/auth/login", { email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken });
      assert.equal(result.status, 500);
      const body = await result.json() as { accessToken?: string; refreshToken?: string };
      assert.equal(body.accessToken, undefined);
      assert.equal(body.refreshToken, undefined);
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined, "the link rolled back with the session");
      assert.equal(await sessionCount(existing.id), 0);
      create.mockRestore();
      const retry = await post(app.baseUrl, "/api/auth/login", { email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken });
      assert.equal(retry.status, 200, "the token was not spent");
      assert.equal((await retry.json() as { linkedProvider?: string }).linkedProvider, "google");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);
      assert.equal(await sessionCount(existing.id), 1);
    } finally { vi.restoreAllMocks(); restoreFetch(); await app.close(); }
  });
});

test("password: a password changed after the first check links nothing and spends no token", async () => {
  await withOAuthEnv(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const restoreFetch = installProviderFetch({ google: EXISTING_EMAIL });
    try {
      const existing = await seedUser(EXISTING_EMAIL, "existing");
      const pending = await webConflictToken(app.baseUrl);
      // The owner changes the password between the Argon2 check (outside the
      // lock) and the locked revalidation.
      const prepare = userService.prepareSocialLink;
      const spy = vi.spyOn(userService, "prepareSocialLink").mockImplementationOnce(async (...args) => {
        await getDb().update(users).set({ passwordHash: await argon2.hash("changed-password") }).where(eq(users.id, existing.id));
        return prepare(...args);
      });
      const stale = await post(app.baseUrl, "/api/auth/login", { email: EXISTING_EMAIL, password: "password123", pendingLinkToken: pending.pendingLinkToken });
      assert.equal(spy.mock.calls.length, 1, "the change landed inside the window");
      assert.equal(stale.status, 401);
      assert.equal((await stale.json() as { code: string }).code, "AUTH_INVALID_CREDENTIALS");
      assert.equal(await sessionCount(existing.id), 0);
      assert.equal(await identityOwner("google", "google-sub-1304"), undefined, "a rejected credential links nothing");
      spy.mockRestore();
      const current = await post(app.baseUrl, "/api/auth/login", { email: EXISTING_EMAIL, password: "changed-password", pendingLinkToken: pending.pendingLinkToken });
      assert.equal(current.status, 200, "the token was not spent");
      assert.equal(await identityOwner("google", "google-sub-1304"), existing.id);
    } finally { vi.restoreAllMocks(); restoreFetch(); await app.close(); }
  });
});
