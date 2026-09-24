import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { oauthAccessRequests, serverMembers, users } from "../db/schema.js";
import { createOAuthClient } from "../services/oauthService.js";
import { decodeOidcAuthorizationCode } from "../services/oidcService.js";
import { createServer } from "../services/serverService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function base64UrlJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function parseJwt(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split(".");
  assert.ok(encodedHeader && encodedPayload && encodedSignature);
  assert.equal(extra, undefined);
  return {
    header: base64UrlJson(encodedHeader),
    payload: base64UrlJson(encodedPayload),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function assertInvalidGrant(response: Response): Promise<void> {
  assert.equal(response.status, 400);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.error, "invalid_grant");
  assert.equal("next_action" in body, false);
}

test("standard OIDC discovery, authorization, PKCE, ID token, JWKS, and email claims interoperate", async () => {
  const previousServerUrl = process.env.SERVER_URL;
  const previousAppUrl = process.env.APP_URL;
  process.env.SERVER_URL = "https://api.raft.test";
  process.env.APP_URL = "https://app.raft.test";

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const suffix = randomUUID();
    const email = `oidc-owner-${suffix}@raft.test`;
    const name = `oidc-owner-${suffix}`;
    const [owner] = await getDb().insert(users).values({
      email,
      name,
      displayName: "OIDC Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    const server = await createServer("OIDC Server", `oidc-${suffix}`, owner.id);
    const otherServer = await createServer("Other OIDC Server", `other-oidc-${suffix}`, owner.id);
    const redirectUri = "https://open-webui.example.test/oauth/oidc/callback";
    const { client, clientSecret } = await createOAuthClient({
      serverId: server.id,
      createdByUserId: owner.id,
      clientId: `oidc-${suffix.slice(0, 8)}`,
      name: "Open WebUI",
      returnUrl: redirectUri,
      allowedScopes: ["openid", "profile", "email"],
    });

    const login = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    assert.equal(login.status, 200);
    const { accessToken: humanAccessToken } = await login.json() as { accessToken: string };

    const lookupClient = (clientIdentifier: string, serverId = server.id) => fetch(
      `${app.baseUrl}/api/oauth/clients/lookup?${new URLSearchParams({
        client_id: clientIdentifier,
        server_id: serverId,
      })}`,
      { headers: { Authorization: `Bearer ${humanAccessToken}` } },
    );
    const [keyLookup, uuidLookup] = await Promise.all([
      lookupClient(client.clientId),
      lookupClient(client.id),
    ]);
    assert.equal(keyLookup.status, 200);
    assert.equal(uuidLookup.status, 404);
    const keyLookupBody = await keyLookup.json() as Record<string, unknown>;
    assert.equal(keyLookupBody.clientId, client.clientId);
    assert.equal(keyLookupBody.availability, "ready");
    const unknownUuidLookup = await lookupClient(randomUUID());
    assert.equal(unknownUuidLookup.status, 404);

    const [rootDiscovery, nestedDiscovery] = await Promise.all([
      fetch(`${app.baseUrl}/.well-known/openid-configuration`),
      fetch(`${app.baseUrl}/api/oauth/.well-known/openid-configuration`),
    ]);
    assert.equal(rootDiscovery.status, 200);
    assert.equal(nestedDiscovery.status, 200);
    const discovery = await rootDiscovery.json() as Record<string, unknown>;
    assert.deepEqual(await nestedDiscovery.json(), discovery);
    assert.equal(discovery.issuer, "https://api.raft.test");
    assert.equal(discovery.authorization_endpoint, "https://api.raft.test/api/oauth/authorize");
    assert.equal(discovery.token_endpoint, "https://api.raft.test/api/oauth/token");
    assert.equal(discovery.userinfo_endpoint, "https://api.raft.test/api/oauth/userinfo");
    assert.equal(discovery.jwks_uri, "https://api.raft.test/api/oauth/jwks");
    assert.deepEqual(discovery.response_types_supported, ["code"]);
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["ES256"]);
    assert.deepEqual(discovery.code_challenge_methods_supported, ["S256"]);
    assert.ok((discovery.scopes_supported as string[]).includes("email"));

    const jwksResponse = await fetch(`${app.baseUrl}/api/oauth/jwks`);
    assert.equal(jwksResponse.status, 200);
    const jwks = await jwksResponse.json() as {
      keys: Array<Record<string, unknown>>;
    };
    assert.equal(jwks.keys.length, 1);
    assert.deepEqual(
      {
        kty: jwks.keys[0]?.kty,
        crv: jwks.keys[0]?.crv,
        use: jwks.keys[0]?.use,
        alg: jwks.keys[0]?.alg,
      },
      { kty: "EC", crv: "P-256", use: "sig", alg: "ES256" },
    );
    assert.equal("d" in jwks.keys[0]!, false);

    const verifier = "oidc-standard-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    const challenge = codeChallenge(verifier);
    const state = "open-webui-state";
    const nonce = "open-webui-nonce";
    const authorizeUrl = new URL(`${app.baseUrl}/api/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      server: server.slug,
    }).toString();
    const browserStart = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(browserStart.status, 302);
    const setupUrl = new URL(browserStart.headers.get("location")!);
    assert.equal(setupUrl.origin, "https://app.raft.test");
    assert.equal(setupUrl.pathname, "/login-with-raft/setup");
    assert.equal(setupUrl.searchParams.get("flow"), "oidc");
    assert.equal(setupUrl.searchParams.get("client_id"), client.clientId);
    assert.equal(setupUrl.searchParams.get("return_to"), redirectUri);
    assert.equal(setupUrl.searchParams.get("scope"), "openid profile email");
    assert.equal(setupUrl.searchParams.get("state"), state);
    assert.equal(setupUrl.searchParams.get("nonce"), nonce);
    assert.equal(setupUrl.searchParams.get("code_challenge"), challenge);
    assert.equal(setupUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(setupUrl.searchParams.get("server"), server.slug);

    const fragmentRedirectUrl = new URL(authorizeUrl);
    fragmentRedirectUrl.searchParams.set("redirect_uri", `${redirectUri}#fragment`);
    const fragmentRedirect = await fetch(fragmentRedirectUrl, { redirect: "manual" });
    assert.equal(fragmentRedirect.status, 400);
    assert.equal(
      (await fragmentRedirect.json() as { error: string }).error,
      "invalid_request",
    );

    const malformedPkceUrl = new URL(authorizeUrl);
    malformedPkceUrl.searchParams.set("code_challenge", "not-a-sha256-challenge");
    const malformedPkce = await fetch(malformedPkceUrl, { redirect: "manual" });
    assert.equal(malformedPkce.status, 400);
    assert.equal(
      (await malformedPkce.json() as { error: string }).error,
      "invalid_request",
    );

    const oversizedNonceUrl = new URL(authorizeUrl);
    oversizedNonceUrl.searchParams.set("nonce", "n".repeat(513));
    const oversizedNonce = await fetch(oversizedNonceUrl, { redirect: "manual" });
    assert.equal(oversizedNonce.status, 400);
    assert.equal(
      (await oversizedNonce.json() as { error: string }).error,
      "invalid_request",
    );

    const mismatchedHintAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: server.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile", "email"],
        oidc: true,
        server: otherServer.slug,
      }),
    });
    assert.equal(mismatchedHintAuthorize.status, 400);
    assert.equal(
      (await mismatchedHintAuthorize.json() as { error: string }).error,
      "server does not match the selected Server",
    );

    const wrongServerAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: otherServer.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile", "email"],
        oidc: true,
        nonce,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        server: otherServer.slug,
      }),
    });
    assert.equal(wrongServerAuthorize.status, 404);
    assert.equal((await wrongServerAuthorize.json() as { error: string }).error, "OAuth client not found for server");

    const uuidAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.id,
        serverId: server.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile", "email"],
        oidc: true,
        nonce,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        server: server.slug,
      }),
    });
    assert.equal(uuidAuthorize.status, 404);
    assert.equal((await uuidAuthorize.json() as { error: string }).error, "OAuth client not found for server");

    const authorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: server.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile", "email"],
        oidc: true,
        nonce,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        server: server.slug,
      }),
    });
    assert.equal(authorize.status, 200);
    const { code } = await authorize.json() as { code: string };
    assert.match(code, /^raft_oidc_/);

    const exchangeOidcCode = (
      authorizationCode: string,
      clientIdentifier: string,
      params: Record<string, string> = {},
    ) => fetch(`${app.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientIdentifier}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...params,
      }),
    });
    const exchange = (params: Record<string, string>) => exchangeOidcCode(code, client.clientId, params);

    const uuidExchange = await exchangeOidcCode(code, client.id);
    assert.equal(uuidExchange.status, 401);
    assert.equal((await uuidExchange.json() as { error: string }).error, "Invalid client credentials");

    const wrongRedirect = await exchange({ redirect_uri: "https://attacker.example.test/callback" });
    assert.equal(wrongRedirect.status, 400);
    assert.equal((await wrongRedirect.json() as { error: string }).error, "invalid_grant");

    const wrongVerifier = await exchange({ code_verifier: `${verifier}x` });
    assert.equal(wrongVerifier.status, 400);
    assert.equal((await wrongVerifier.json() as { error: string }).error, "invalid_grant");

    const tokenResponse = await exchange({});
    assert.equal(tokenResponse.status, 200);
    assert.match(tokenResponse.headers.get("cache-control") ?? "", /no-store/);
    const token = await tokenResponse.json() as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
      id_token: string;
    };
    assert.equal(token.token_type, "Bearer");
    assert.deepEqual(token.scope.split(" "), ["email", "openid", "profile"]);
    assert.ok(token.expires_in > 0);

    const jwt = parseJwt(token.id_token);
    assert.equal(jwt.header.alg, "ES256");
    assert.equal(jwt.header.kid, jwks.keys[0]!.kid);
    assert.equal(jwt.payload.iss, "https://api.raft.test");
    assert.equal(jwt.payload.sub, owner.id);
    assert.equal(jwt.payload.aud, client.clientId);
    assert.equal(jwt.payload.nonce, nonce);
    assert.equal(jwt.payload.name, "OIDC Owner");
    assert.equal(jwt.payload.preferred_username, name);
    assert.equal(jwt.payload.email, email);
    assert.equal(jwt.payload.email_verified, true);
    assert.equal(jwt.payload.server_id, server.id);
    assert.equal(jwt.payload.server_slug, server.slug);
    assert.ok(typeof jwt.payload.iat === "number");
    assert.ok(typeof jwt.payload.exp === "number");
    assert.ok((jwt.payload.exp as number) > (jwt.payload.iat as number));
    const publicKey = createPublicKey({ key: jwks.keys[0]!, format: "jwk" });
    assert.equal(verify("sha256", Buffer.from(jwt.signingInput, "ascii"), {
      key: publicKey,
      dsaEncoding: "ieee-p1363",
    }, jwt.signature), true);

    await assertInvalidGrant(await exchange({}));

    const userinfo = await fetch(`${app.baseUrl}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    assert.equal(userinfo.status, 200);
    const claims = await userinfo.json() as Record<string, unknown>;
    assert.equal(claims.sub, owner.id);
    assert.equal(claims.email, email);
    assert.equal(claims.email_verified, true);

    const authorizeWithoutEmail = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: server.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile"],
        oidc: true,
        nonce: "no-email-nonce",
        server: server.id,
      }),
    });
    assert.equal(authorizeWithoutEmail.status, 200);
    const noEmailCode = (await authorizeWithoutEmail.json() as { code: string }).code;
    const noEmailTokenResponse = await exchangeOidcCode(noEmailCode, client.clientId, {
      code_verifier: "",
    });
    assert.equal(noEmailTokenResponse.status, 200);
    const noEmailToken = await noEmailTokenResponse.json() as { access_token: string; id_token: string };
    const noEmailJwt = parseJwt(noEmailToken.id_token);
    assert.equal(noEmailJwt.payload.aud, client.clientId);
    assert.equal(verify("sha256", Buffer.from(noEmailJwt.signingInput, "ascii"), {
      key: publicKey,
      dsaEncoding: "ieee-p1363",
    }, noEmailJwt.signature), true);
    assert.equal("email" in noEmailJwt.payload, false);
    assert.equal("email_verified" in noEmailJwt.payload, false);
    const noEmailUserinfo = await fetch(`${app.baseUrl}/api/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${noEmailToken.access_token}` },
    });
    assert.equal(noEmailUserinfo.status, 200);
    const noEmailClaims = await noEmailUserinfo.json() as Record<string, unknown>;
    assert.equal("email" in noEmailClaims, false);
    assert.equal("email_verified" in noEmailClaims, false);

    const issueKeyOidcCode = async (testNonce: string): Promise<string> => {
      const response = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${humanAccessToken}`,
        },
        body: JSON.stringify({
          clientId: client.clientId,
          serverId: server.id,
          returnUrl: redirectUri,
          scopes: ["openid", "profile"],
          oidc: true,
          nonce: testNonce,
          server: server.id,
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json() as { code: string }).code;
    };

    const expiredCode = await issueKeyOidcCode("expired-code-nonce");
    const expiredContext = decodeOidcAuthorizationCode(expiredCode);
    assert.ok(expiredContext);
    await getDb().update(oauthAccessRequests).set({ createdAt: new Date(0) }).where(
      eq(oauthAccessRequests.id, expiredContext.requestId),
    );
    await assertInvalidGrant(await exchangeOidcCode(expiredCode, client.clientId, {
      code_verifier: "",
    }));

    const missingCode = await issueKeyOidcCode("missing-code-nonce");
    const missingContext = decodeOidcAuthorizationCode(missingCode);
    assert.ok(missingContext);
    await getDb().delete(oauthAccessRequests).where(eq(oauthAccessRequests.id, missingContext.requestId));
    await assertInvalidGrant(await exchangeOidcCode(missingCode, client.clientId, {
      code_verifier: "",
    }));

    const membershipBoundAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanAccessToken}`,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        serverId: server.id,
        returnUrl: redirectUri,
        scopes: ["openid", "profile"],
        oidc: true,
        nonce: "membership-bound-nonce",
        server: server.id,
      }),
    });
    assert.equal(membershipBoundAuthorize.status, 200);
    const membershipBoundCode = (await membershipBoundAuthorize.json() as { code: string }).code;
    await getDb().delete(serverMembers).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, owner.id),
    ));
    const exchangeMembershipBoundCode = () => fetch(`${app.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: membershipBoundCode,
        redirect_uri: redirectUri,
      }),
    });
    const missingMembershipExchange = await exchangeMembershipBoundCode();
    assert.equal(missingMembershipExchange.status, 400);
    assert.equal((await missingMembershipExchange.json() as { error: string }).error, "invalid_grant");
    await getDb().insert(serverMembers).values({
      serverId: server.id,
      userId: owner.id,
      role: "owner",
    });
    const restoredMembershipExchange = await exchangeMembershipBoundCode();
    assert.equal(restoredMembershipExchange.status, 200);
  } finally {
    await app.close();
    if (previousServerUrl === undefined) delete process.env.SERVER_URL;
    else process.env.SERVER_URL = previousServerUrl;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});
