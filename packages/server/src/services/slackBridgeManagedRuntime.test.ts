import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSlackBridgeManagedRuntime,
  type SlackBridgeManagedRuntimeDependencies,
} from "./slackBridgeManagedRuntime.js";

const NOW = new Date("2026-08-10T17:45:00.000Z");

function dependencies(input: {
  fetch: typeof fetch;
  handleIds?: string[];
  sealed?: string[];
}): SlackBridgeManagedRuntimeDependencies {
  const handleIds = input.handleIds ?? ["app-1", "code-1"];
  return {
    environment: "test",
    oauthRedirectUri: "https://bridge.test/api/slack-bridge/oauth/callback",
    eventsRequestUrl: "https://bridge.test/api/slack-bridge/events",
    appOrigin: "https://bridge.test",
    isLaunchEnabled: async () => true,
    resolveOAuthCompletionRedirectPath: async ({ serverId }) =>
      `/s/${serverId}/settings/im-bridges`,
    appSecrets: {
      async lease(request) {
        assert.equal(request.registrationId, "registration-1");
        assert.equal(request.attemptId, "attempt-1");
        assert.equal(request.audience, "slack-oauth-exchange");
        return {
          providerOAuthClientId: "client-1",
          clientSecret: "client-secret-1",
          expiresAt: new Date(NOW.getTime() + 60_000),
        };
      },
    },
    credentialSealer: {
      async seal(request) {
        assert.equal(request.accessToken, "xoxb-secret-token");
        input.sealed?.push(request.accessToken);
        return {
          encryptedMaterial: "sealed:credential:v1",
          envelopeKeyId: "kms-key-1",
          aadVersion: 1,
        };
      },
    },
    secretResolver: {
      async resolveSigningSecret() {
        return "signing-secret";
      },
    },
    payloadSealer: {
      async sealNormalizedPayload() {
        return {
          encryptedPayload: "sealed:payload:v1",
          envelopeKeyId: "kms-key-1",
          aadVersion: 1,
        };
      },
    },
    fetch: input.fetch,
    oauthEndpoint: "https://slack.test/api/oauth.v2.access",
    randomHandleId: () => {
      const next = handleIds.shift();
      if (!next) throw new Error("handle double exhausted");
      return next;
    },
    now: () => NOW,
  };
}

test("managed runtime composes one-use OAuth exchange without route-visible secrets", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const sealed: string[] = [];
  const runtime = createSlackBridgeManagedRuntime(dependencies({
    sealed,
    fetch: (async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (String(url) === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_APP",
          team_id: "T_TEAM",
          user_id: "U_BOT",
          bot_id: "B_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": "chat:write, channels:history",
            "x-accepted-oauth-scopes": "users:read",
          },
        });
      }
      assert.equal(String(url), "https://slack.test/api/oauth.v2.access");
      return new Response(JSON.stringify({
        ok: true,
        app_id: "A_APP",
        access_token: "xoxb-secret-token",
        token_type: "bot",
        bot_user_id: "U_BOT",
        authed_user: { id: "U_HUMAN" },
        bot_id: "B_BOT",
        scope: "chat:write,channels:history",
        team: { id: "T_TEAM", name: "Raft Test" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  }));

  const appLease = await runtime.leaseOAuthAppCredential({
    registrationId: "registration-1",
    providerAppId: "A_APP",
    providerOAuthClientId: "client-1",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-1",
    now: NOW,
  });
  assert.ok(appLease);
  const codeHandle = await runtime.captureAuthorizationCode({
    attemptId: "attempt-1",
    providerOAuthClientId: "client-1",
    authorizationCode: "authorization-code-1",
    now: NOW,
  });
  const routeVisible = JSON.stringify({ appLease, codeHandle });
  assert.doesNotMatch(routeVisible, /client-secret-1|authorization-code-1/);

  const request = {
    serverId: "11111111-1111-4111-8111-111111111111",
    authorizationCode: codeHandle,
    appCredential: appLease.handle,
    redirectUri: runtime.oauthRedirectUri,
    expectedProviderAppId: "A_APP",
    expectedScopes: ["channels:history", "chat:write"],
    now: NOW,
  };
  const outcome = await runtime.exchangeOAuth(request);
  assert.equal(outcome.kind, "authorized");
  assert.deepEqual(sealed, ["xoxb-secret-token"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "https://slack.test/api/oauth.v2.access");
  assert.equal(calls[1]?.url, "https://slack.com/api/auth.test");
  const providerBody = new URLSearchParams(calls[0]?.body);
  assert.equal(providerBody.get("client_secret"), "client-secret-1");
  assert.equal(providerBody.get("code"), "authorization-code-1");
  assert.equal(JSON.stringify(outcome).includes("xoxb-secret-token"), false);

  assert.deepEqual(await runtime.exchangeOAuth(request), {
    kind: "preflight_rejected",
  });
  assert.equal(calls.length, 2);
});

test("managed runtime stop erases outstanding handles and rejects new capture", async () => {
  const runtime = createSlackBridgeManagedRuntime(dependencies({
    fetch: (async () => assert.fail("provider transport must not run")) as typeof fetch,
  }));
  const appLease = await runtime.leaseOAuthAppCredential({
    registrationId: "registration-1",
    providerAppId: "A_APP",
    providerOAuthClientId: "client-1",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-1",
    now: NOW,
  });
  assert.ok(appLease);
  runtime.stop();

  assert.equal(await runtime.leaseOAuthAppCredential({
    registrationId: "registration-1",
    providerAppId: "A_APP",
    providerOAuthClientId: "client-1",
    environment: "test",
    audience: "slack-oauth-exchange",
    attemptId: "attempt-2",
    now: NOW,
  }), null);
  await assert.rejects(runtime.captureAuthorizationCode({
    attemptId: "attempt-1",
    providerOAuthClientId: "client-1",
    authorizationCode: "authorization-code-1",
    now: NOW,
  }), /capture rejected/);
});
