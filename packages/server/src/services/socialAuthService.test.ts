import assert from "node:assert/strict";
import { test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  buildAuthorizationUrl,
  buildSocialAuthCallbackUrl,
  buildStateCookie,
  clearStateCookie,
  createSocialAuthCompletion,
  exchangeProviderCode,
  fetchSocialAuthProfile,
  getSocialAuthProvider,
  getSocialAuthRedirectUri,
  isSocialAuthProviderConfigured,
  parseCookieHeader,
  readStateCookie,
  sanitizeReturnTo,
  signSocialAuthState,
  validateMobileOAuthReturnUri,
  validateSocialAuthCallbackState,
  verifySocialAuthState,
} from "./socialAuthService.js";

test("social auth state round-trip preserves provider, mode, and nonce", () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.SOCIAL_AUTH_STATE_SECRET;
  process.env.JWT_SECRET = "test-secret";

  const token = signSocialAuthState({
    provider: "google",
    mode: "login",
    nonce: "nonce-123",
    returnTo: "/s/dev?tab=chat",
  });
  const state = verifySocialAuthState(token);

  assert.equal(state.provider, "google");
  assert.equal(state.mode, "login");
  assert.equal(state.nonce, "nonce-123");
  assert.equal(state.returnTo, "/s/dev?tab=chat");

  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
});

test("social auth cookies are scoped to provider callback path", () => {
  const previousServerUrl = process.env.SERVER_URL;
  process.env.SERVER_URL = "https://app.example.com";

  const cookie = buildStateCookie("google", "nonce-abc");
  const clearedCookie = clearStateCookie("google");

  assert.match(cookie, /slock_google_oauth_nonce=nonce-abc/);
  assert.match(cookie, /Path=\/api\/auth\/google\/callback/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  const cookies = parseCookieHeader(cookie);
  assert.equal(cookies.slock_google_oauth_nonce, "nonce-abc");
  assert.equal(readStateCookie("google", cookie), "nonce-abc");
  assert.match(clearedCookie, /Expires=/);

  if (previousServerUrl === undefined) {
    delete process.env.SERVER_URL;
  } else {
    process.env.SERVER_URL = previousServerUrl;
  }
});

test("login callback state requires a matching nonce cookie", () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.SOCIAL_AUTH_STATE_SECRET;
  process.env.JWT_SECRET = "test-secret";

  const stateToken = signSocialAuthState({
    provider: "google",
    mode: "login",
    nonce: "nonce-login",
    returnTo: "/settings",
  });

  assert.throws(
    () => validateSocialAuthCallbackState("google", stateToken, undefined),
    /browser state mismatch/,
  );

  const validated = validateSocialAuthCallbackState(
    "google",
    stateToken,
    buildStateCookie("google", "nonce-login"),
  );
  assert.equal(validated.state.mode, "login");
  assert.equal(validated.returnTo, "/settings");

  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

test("link callback state can create a non-mutating handoff without a nonce cookie", () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.SOCIAL_AUTH_STATE_SECRET;
  process.env.JWT_SECRET = "test-secret";

  const stateToken = signSocialAuthState({
    provider: "github",
    mode: "link",
    nonce: "nonce-link",
    linkUserId: "user-123",
    returnTo: "/settings?tab=account",
  });

  const validated = validateSocialAuthCallbackState("github", stateToken, undefined);
  assert.equal(validated.state.mode, "link");
  assert.equal(validated.state.linkUserId, "user-123");
  assert.equal(validated.returnTo, "/settings?tab=account");

  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

test("web callback rejects mobile state tokens before browser nonce handling", () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  delete process.env.SOCIAL_AUTH_STATE_SECRET;
  process.env.JWT_SECRET = "test-secret";

  const stateToken = signSocialAuthState({
    kind: "mobile",
    provider: "google",
    mode: "login",
    nonce: "nonce-mobile",
    mobileRequestId: "request-123",
  });

  assert.throws(
    () => validateSocialAuthCallbackState("google", stateToken, undefined),
    /browser state mismatch/,
  );

  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
});

test("native OAuth return URI allows exact configured targets and a strict desktop loopback", () => {
  const previousGlobalAllowed = process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
  const previousReturnUri = process.env.MOBILE_OAUTH_RETURN_URI;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
    process.env.MOBILE_OAUTH_RETURN_URI = [
      "raft-debug://oauth/callback",
      "raft-alpha://oauth/callback",
      "https://android.example.test/oauth/callback",
    ].join(",");

    process.env.NODE_ENV = "test";
    assert.equal(
      validateMobileOAuthReturnUri("raft-debug://oauth/callback"),
      "raft-debug://oauth/callback",
    );
    assert.throws(
      () => validateMobileOAuthReturnUri("raft-debug://oauth/callback?extra=1"),
      /return_uri_not_allowed/,
    );
    assert.equal(
      validateMobileOAuthReturnUri("raft-alpha://oauth/callback"),
      "raft-alpha://oauth/callback",
    );

    process.env.MOBILE_OAUTH_RETURN_URI = "";
    process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS = "raft-beta://oauth/callback";
    assert.equal(
      validateMobileOAuthReturnUri("raft-beta://oauth/callback"),
      "raft-beta://oauth/callback",
    );
    assert.throws(
      () => validateMobileOAuthReturnUri("raft-alpha://oauth/callback"),
      /return_uri_not_allowed/,
    );

    delete process.env.MOBILE_OAUTH_RETURN_URI;
    delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
    assert.equal(
      validateMobileOAuthReturnUri("raft://oauth/callback"),
      "raft://oauth/callback",
    );
    assert.equal(
      validateMobileOAuthReturnUri("raft-debug://oauth/callback"),
      "raft-debug://oauth/callback",
    );
    assert.equal(
      validateMobileOAuthReturnUri("raft-alpha://oauth/callback"),
      "raft-alpha://oauth/callback",
    );
    assert.equal(
      validateMobileOAuthReturnUri("raft-beta://oauth/callback"),
      "raft-beta://oauth/callback",
    );
    assert.throws(
      () => validateMobileOAuthReturnUri("raft-connectedtest://oauth/callback"),
      /return_uri_not_allowed/,
    );
    assert.equal(
      validateMobileOAuthReturnUri("raft-dev://oauth/callback"),
      "raft-dev://oauth/callback",
    );
    process.env.MOBILE_OAUTH_RETURN_URI = "raft-debug://oauth/callback,https://android.example.test/oauth/callback";

    process.env.NODE_ENV = "production";
    assert.equal(
      validateMobileOAuthReturnUri("raft-debug://oauth/callback"),
      "raft-debug://oauth/callback",
    );
    assert.equal(
      validateMobileOAuthReturnUri("https://android.example.test/oauth/callback"),
      "https://android.example.test/oauth/callback",
    );

    const desktopReturnUri = "http://127.0.0.1:49152/auth/done#state=desktop_nonce_0123456789abcdef";
    assert.equal(validateMobileOAuthReturnUri(desktopReturnUri), desktopReturnUri);
    for (const deniedReturnUri of [
      "http://localhost:49152/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.2:49152/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://[::1]:49152/auth/done#state=desktop_nonce_0123456789abcdef",
      "https://127.0.0.1:49152/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://user@127.0.0.1:49152/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.1/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.1:1023/auth/done#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.1:49152/oauth/callback#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.1:49152/auth/done?next=1#state=desktop_nonce_0123456789abcdef",
      "http://127.0.0.1:49152/auth/done",
      "http://127.0.0.1:49152/auth/done#state=short",
      "http://127.0.0.1:49152/auth/done#state=desktop%20nonce%200123456789abcdef",
      "http://127.0.0.1:49152/auth/done#nonce=desktop_nonce_0123456789abcdef",
    ]) {
      assert.throws(() => validateMobileOAuthReturnUri(deniedReturnUri), /return_uri_not_allowed/);
    }
  } finally {
    if (previousGlobalAllowed === undefined) delete process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS;
    else process.env.MOBILE_OAUTH_ALLOWED_RETURN_URIS = previousGlobalAllowed;
    if (previousReturnUri === undefined) delete process.env.MOBILE_OAUTH_RETURN_URI;
    else process.env.MOBILE_OAUTH_RETURN_URI = previousReturnUri;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("social auth callback URL and provider exposure follow configured provider env", () => {
  const previousAppUrl = process.env.APP_URL;
  const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousGithubClientId = process.env.GITHUB_CLIENT_ID;
  const previousGithubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleTeamId = process.env.APPLE_TEAM_ID;
  const previousAppleKeyId = process.env.APPLE_KEY_ID;
  const previousApplePrivateKey = process.env.APPLE_PRIVATE_KEY;

  process.env.APP_URL = "https://app.example.com";
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_TEAM_ID = "apple-team-id";
  process.env.APPLE_KEY_ID = "apple-key-id";
  process.env.APPLE_PRIVATE_KEY = "apple-private-key";

  const callbackUrl = buildSocialAuthCallbackUrl({
    provider: "google",
    mode: "login",
    returnTo: "/s/dev",
    code: "code-123",
  });

  assert.match(callbackUrl, /auth_callback=social/);
  assert.match(callbackUrl, /provider=google/);
  assert.match(callbackUrl, /mode=login/);
  assert.equal(getSocialAuthProvider("google")?.label, "Google");
  assert.equal(getSocialAuthProvider("github")?.label, "GitHub");
  assert.equal(getSocialAuthProvider("apple")?.label, "Apple");
  assert.equal(isSocialAuthProviderConfigured("google"), true);
  assert.equal(isSocialAuthProviderConfigured("github"), true);
  assert.equal(isSocialAuthProviderConfigured("apple"), true);

  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
  if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
  if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
  if (previousGithubClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = previousGithubClientId;
  if (previousGithubClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = previousGithubClientSecret;
  if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
  else process.env.APPLE_CLIENT_ID = previousAppleClientId;
  if (previousAppleTeamId === undefined) delete process.env.APPLE_TEAM_ID;
  else process.env.APPLE_TEAM_ID = previousAppleTeamId;
  if (previousAppleKeyId === undefined) delete process.env.APPLE_KEY_ID;
  else process.env.APPLE_KEY_ID = previousAppleKeyId;
  if (previousApplePrivateKey === undefined) delete process.env.APPLE_PRIVATE_KEY;
  else process.env.APPLE_PRIVATE_KEY = previousApplePrivateKey;
});

test("sanitizeReturnTo only accepts app-local paths", () => {
  assert.equal(
    sanitizeReturnTo("/settings?tab=account#connected-apps"),
    "/settings?tab=account#connected-apps",
  );
  assert.equal(sanitizeReturnTo("https://evil.example.com"), "/");
  assert.equal(sanitizeReturnTo("//evil.example.com"), "/");
  assert.equal(sanitizeReturnTo("/\\evil.example.com"), "/");
  assert.equal(sanitizeReturnTo("/%5cevil.example.com"), "/");
  assert.equal(sanitizeReturnTo("settings"), "/");
});

test("durable web completion rejects an unverified provider email before persistence", async () => {
  await assert.rejects(
    createSocialAuthCompletion({
      provider: "apple",
      mode: "link",
      intendedAction: "link",
      userId: "00000000-0000-4000-8000-000000000001",
      providerUserId: "apple-unverified-provider-user",
      providerEmail: "apple-unverified@example.com",
      providerEmailVerified: false,
      returnTo: "/settings",
    }),
    /email is not verified/,
  );
});

test("GitHub authorization URL includes redirect URI and required scopes", () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousGithubClientId = process.env.GITHUB_CLIENT_ID;
  const previousGithubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  process.env.SERVER_URL = "https://api.example.com";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";

  const authorizationUrl = new URL(buildAuthorizationUrl("github", "state-123", "login", "nonce-123"));

  assert.equal(authorizationUrl.origin, "https://github.com");
  assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "github-client-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), getSocialAuthRedirectUri("github"));
  assert.equal(authorizationUrl.searchParams.get("scope"), "read:user user:email");
  assert.equal(authorizationUrl.searchParams.get("state"), "state-123");

  if (previousServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = previousServerUrl;
  if (previousGithubClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = previousGithubClientId;
  if (previousGithubClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = previousGithubClientSecret;
});

test("Apple authorization URL includes redirect URI and OpenID response settings", () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;

  process.env.SERVER_URL = "https://api.example.com";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";

  const authorizationUrl = new URL(buildAuthorizationUrl("apple", "state-apple", "login", "nonce-apple"));

  assert.equal(authorizationUrl.origin, "https://appleid.apple.com");
  assert.equal(authorizationUrl.pathname, "/auth/authorize");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "apple-client-id");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), getSocialAuthRedirectUri("apple"));
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("response_mode"), "form_post");
  assert.equal(authorizationUrl.searchParams.get("scope"), "email");
  assert.equal(authorizationUrl.searchParams.get("state"), "state-apple");
  assert.equal(authorizationUrl.searchParams.get("nonce"), "nonce-apple");

  if (previousServerUrl === undefined) delete process.env.SERVER_URL;
  else process.env.SERVER_URL = previousServerUrl;
  if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
  else process.env.APPLE_CLIENT_ID = previousAppleClientId;
  if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
  else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
});

test("Apple dynamic client secret is a short-lived ES256 JWT with the configured identity", async () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;
  const previousAppleTeamId = process.env.APPLE_TEAM_ID;
  const previousAppleKeyId = process.env.APPLE_KEY_ID;
  const previousApplePrivateKey = process.env.APPLE_PRIVATE_KEY;
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  let observedClientSecret = "";

  process.env.SERVER_URL = "https://api.example.com";
  process.env.APPLE_CLIENT_ID = "apple-services-id";
  delete process.env.APPLE_CLIENT_SECRET;
  process.env.APPLE_TEAM_ID = "APPLETEAMID";
  process.env.APPLE_KEY_ID = "APPLEKEYID";
  process.env.APPLE_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.equal(url, "https://appleid.apple.com/auth/token");
    const body = init?.body;
    assert.ok(body instanceof URLSearchParams);
    observedClientSecret = body.get("client_secret") ?? "";
    return new Response(JSON.stringify({ id_token: "apple-id-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await exchangeProviderCode("apple", "apple-provider-code");
    const decoded = jwt.decode(observedClientSecret, { complete: true });
    assert.ok(decoded && typeof decoded === "object");
    assert.equal(decoded.header.alg, "ES256");
    assert.equal(decoded.header.kid, "APPLEKEYID");

    const payload = jwt.verify(observedClientSecret, publicKey, {
      algorithms: ["ES256"],
      audience: "https://appleid.apple.com",
      issuer: "APPLETEAMID",
      subject: "apple-services-id",
    }) as jwt.JwtPayload;
    assert.equal(payload.iss, "APPLETEAMID");
    assert.equal(payload.sub, "apple-services-id");
    assert.equal(payload.aud, "https://appleid.apple.com");
    assert.equal(typeof payload.iat, "number");
    assert.equal(typeof payload.exp, "number");
    assert.ok(payload.exp! > payload.iat!);
    assert.ok(payload.exp! - payload.iat! <= 5 * 60);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
    if (previousAppleTeamId === undefined) delete process.env.APPLE_TEAM_ID;
    else process.env.APPLE_TEAM_ID = previousAppleTeamId;
    if (previousAppleKeyId === undefined) delete process.env.APPLE_KEY_ID;
    else process.env.APPLE_KEY_ID = previousAppleKeyId;
    if (previousApplePrivateKey === undefined) delete process.env.APPLE_PRIVATE_KEY;
    else process.env.APPLE_PRIVATE_KEY = previousApplePrivateKey;
  }
});

test("Apple token exchange and profile fetch use Apple id token subject as provider identity", async () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppleClientId = process.env.APPLE_CLIENT_ID;
  const previousAppleClientSecret = process.env.APPLE_CLIENT_SECRET;
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  jwk.kid = "apple-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  let appleKeys = [jwk];

  process.env.SERVER_URL = "https://api.example.com";
  process.env.APPLE_CLIENT_ID = "apple-client-id";
  process.env.APPLE_CLIENT_SECRET = "apple-client-secret";

  const idToken = jwt.sign({
    sub: "apple-user-sub-123",
    email: "apple-user@example.com",
    email_verified: "true",
    nonce: "nonce-apple",
  }, privateKey, {
    algorithm: "RS256",
    audience: "apple-client-id",
    expiresIn: "5m",
    issuer: "https://appleid.apple.com",
    keyid: "apple-key-1",
  });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });

    if (url === "https://appleid.apple.com/auth/token") {
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://appleid.apple.com/auth/keys") {
      return new Response(JSON.stringify({ keys: appleKeys }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const token = await exchangeProviderCode("apple", "apple-code-123");
    assert.equal(token.accessToken, idToken);

    const tokenExchangeBody = fetchCalls[0]?.init?.body;
    assert.ok(tokenExchangeBody instanceof URLSearchParams);
    assert.equal(tokenExchangeBody.get("client_id"), "apple-client-id");
    assert.equal(tokenExchangeBody.get("client_secret"), "apple-client-secret");
    assert.equal(tokenExchangeBody.get("code"), "apple-code-123");
    assert.equal(tokenExchangeBody.get("redirect_uri"), "https://api.example.com/api/auth/apple/callback");
    assert.equal(tokenExchangeBody.get("grant_type"), "authorization_code");

    const profile = await fetchSocialAuthProfile("apple", token.accessToken, "nonce-apple");
    assert.deepEqual(profile, {
      provider: "apple",
      providerUserId: "apple-user-sub-123",
      email: "apple-user@example.com",
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    });

    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedJwk = rotated.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    rotatedJwk.kid = "apple-key-2";
    rotatedJwk.alg = "RS256";
    rotatedJwk.use = "sig";
    appleKeys = [jwk, rotatedJwk];
    const rotatedIdToken = jwt.sign({
      sub: "apple-user-sub-rotated",
      email: "apple-rotated@example.com",
      email_verified: true,
      nonce: "nonce-rotated",
    }, rotated.privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-2",
    });

    const rotatedProfile = await fetchSocialAuthProfile("apple", rotatedIdToken, "nonce-rotated");
    assert.equal(rotatedProfile.providerUserId, "apple-user-sub-rotated");
    assert.equal(fetchCalls.filter((call) => call.url === "https://appleid.apple.com/auth/keys").length, 2);
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", rotatedIdToken, "wrong-nonce"),
      /nonce does not match/,
    );

    const commonClaims = {
      sub: "apple-negative-table-user",
      email: "apple-negative-table@example.com",
      email_verified: true,
      nonce: "nonce-negative-table",
    };
    const wrongIssuer = jwt.sign(commonClaims, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://issuer.example.test",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", wrongIssuer, commonClaims.nonce),
      /jwt issuer invalid/,
    );

    const wrongAudience = jwt.sign(commonClaims, privateKey, {
      algorithm: "RS256",
      audience: "wrong-apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", wrongAudience, commonClaims.nonce),
      /jwt audience invalid/,
    );

    const expired = jwt.sign(commonClaims, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: -1,
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", expired, commonClaims.nonce),
      /jwt expired/,
    );

    const unsignedExpiry = jwt.sign(commonClaims, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", unsignedExpiry, commonClaims.nonce),
      /missing an expiration/,
    );

    const attackerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const badSignature = jwt.sign(commonClaims, attackerKeys.privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", badSignature, commonClaims.nonce),
      /invalid signature/,
    );

    const nonRs256 = jwt.sign(commonClaims, "not-an-apple-signing-key", {
      algorithm: "HS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-1",
    });
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", nonRs256, commonClaims.nonce),
      /invalid algorithm/,
    );

    const unknownKid = jwt.sign(commonClaims, privateKey, {
      algorithm: "RS256",
      audience: "apple-client-id",
      expiresIn: "5m",
      issuer: "https://appleid.apple.com",
      keyid: "apple-key-unknown",
    });
    const jwksFetchesBeforeUnknownKid = fetchCalls
      .filter((call) => call.url === "https://appleid.apple.com/auth/keys").length;
    await assert.rejects(
      () => fetchSocialAuthProfile("apple", unknownKid, commonClaims.nonce),
      /key is not recognized/,
    );
    assert.equal(
      fetchCalls.filter((call) => call.url === "https://appleid.apple.com/auth/keys").length,
      jwksFetchesBeforeUnknownKid + 1,
      "an unknown kid forces exactly one refresh before rejection",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = previousAppleClientId;
    if (previousAppleClientSecret === undefined) delete process.env.APPLE_CLIENT_SECRET;
    else process.env.APPLE_CLIENT_SECRET = previousAppleClientSecret;
  }
});

test("GitHub token exchange and profile fetch use GitHub OAuth endpoints", async () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousGithubClientId = process.env.GITHUB_CLIENT_ID;
  const previousGithubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  process.env.SERVER_URL = "https://api.example.com";
  process.env.GITHUB_CLIENT_ID = "github-client-id";
  process.env.GITHUB_CLIENT_SECRET = "github-client-secret";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init });

    if (url === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: "github-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({
        id: 12345,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.example.com/u/12345",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify([
        { email: "secondary@example.com", verified: true, primary: false },
        { email: "primary@example.com", verified: true, primary: true },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const token = await exchangeProviderCode("github", "oauth-code-123");
    assert.equal(token.accessToken, "github-access-token");

    const tokenExchangeBody = fetchCalls[0]?.init?.body;
    assert.ok(tokenExchangeBody instanceof URLSearchParams);
    assert.equal(tokenExchangeBody.get("client_id"), "github-client-id");
    assert.equal(tokenExchangeBody.get("client_secret"), "github-client-secret");
    assert.equal(tokenExchangeBody.get("code"), "oauth-code-123");
    assert.equal(tokenExchangeBody.get("redirect_uri"), "https://api.example.com/api/auth/github/callback");

    const profile = await fetchSocialAuthProfile("github", token.accessToken);
    assert.deepEqual(profile, {
      provider: "github",
      providerUserId: "12345",
      email: "primary@example.com",
      emailVerified: true,
      displayName: "The Octocat",
      avatarUrl: "https://avatars.example.com/u/12345",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousGithubClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = previousGithubClientId;
    if (previousGithubClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = previousGithubClientSecret;
  }
});

test("GitHub profile fetch fails when there is no verified primary email", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({
        id: 12345,
        login: "octocat",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "https://api.github.com/user/emails") {
      return new Response(JSON.stringify([
        { email: "primary@example.com", verified: false, primary: true },
        { email: "secondary@example.com", verified: true, primary: false },
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchSocialAuthProfile("github", "github-access-token"),
      /GitHub account does not have a verified primary email/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
