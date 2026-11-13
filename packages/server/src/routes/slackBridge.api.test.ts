import { enableTestSlackIngress } from "../test/integration/slackIngressRollout";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  type SlackBridgeProvisioningResponse,
  type SlackBridgeSetupStage,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  channels,
  externalAppCredentials,
  externalAppIngressEndpoints,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalChannelBindings,
  externalHumanIdentityLinks,
  externalIngressDiscardReceipts,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  slackVerifiedIngressEvents,
  users,
} from "../db/schema";
import { accessTokenForTest } from "../test/integration/credentials";
import { slackBridgeIngressObservationsTotal } from "../metrics";
import { ExternalAppControlPlaneError } from "../services/externalAppControlPlaneService";
import { createServer } from "../services/serverService";
import { createSlackVerifiedIngressAdmission } from "../services/slackVerifiedIngressAdmission";
import { verifyAndAdmitSlackIngress } from "../services/externalAppIngressService";
import { createSlackVerifiedIngressEnvCrypto } from "../services/slackVerifiedIngressEnvCrypto";
import {
  SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
  SLACK_OAUTH_CODE_HANDLE_SCHEMA,
  type SlackOAuthExchangeRequest,
} from "../services/slackProviderAdapter";
import { openTestApp } from "../test/integration/app";
import {
  SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
  type SlackBridgeProvisioningControlPlane,
  type SlackBridgeRouteDependencies,
} from "./slackBridge";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REVISION_6_REQUIRED_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "reactions:read",
  "reactions:write",
  "usergroups:read",
  "usergroups:write",
  "users:read",
] as const;

test("Slack OAuth scope request is exact Revision 6 manifest parity", () => {
  assert.deepEqual(
    SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
    REVISION_6_REQUIRED_BOT_SCOPES,
  );
});

async function seedControlPlane(input: {
  providerAppId?: string;
  providerOAuthClientId?: string;
} = {}) {
  const [owner] = await getDb().insert(users).values({
    email: `slack-route-${randomUUID()}@raft.test`,
    name: `slack-route-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Route Owner",
    passwordHash: "not-used",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(
    "Slack Route Test",
    `slack-route-${randomUUID()}`,
    owner.id,
  );
  const [client] = await getDb().insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-route-${randomUUID()}`,
    clientSecretHash: "not-a-real-secret",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await getDb().insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: input.providerAppId ?? "A_ROUTE_TEST",
    providerOAuthClientId: input.providerOAuthClientId ?? "111.222",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest-route-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  const [grant] = await getDb().insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-route-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  return { owner, server, registration, grant };
}

function headers(input: {
  token: string;
  serverId: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.token}`,
    "Content-Type": "application/json",
    "X-Server-Id": input.serverId,
  };
}

function runtime(input: {
  now?: Date;
  nowSequence?: Date[];
  leaseExpiresAt?: Date;
  codeExpiresAt?: Date;
  exchange?: (request: SlackOAuthExchangeRequest) =>
    ReturnType<SlackBridgeRouteDependencies["exchangeOAuth"]>;
  resolveOAuthCompletionRedirectPath?: SlackBridgeRouteDependencies["resolveOAuthCompletionRedirectPath"];
  isLaunchEnabled?: SlackBridgeRouteDependencies["isLaunchEnabled"];
  provisioning?: SlackBridgeProvisioningControlPlane;
  requestLifecycleReconcile?: SlackBridgeRouteDependencies["requestLifecycleReconcile"];
  onLifecycleError?: SlackBridgeRouteDependencies["onLifecycleError"];
  counters?: {
    leases: number;
    captures: number;
    exchanges: number;
    ingress: number;
  };
} = {}): SlackBridgeRouteDependencies {
  const counters = input.counters ?? {
    leases: 0,
    captures: 0,
    exchanges: 0,
    ingress: 0,
  };
  const now = input.now ?? new Date();
  let nowIndex = 0;
  return {
    environment: "test",
    oauthRedirectUri: "https://slack-cell.raft.test/api/slack-bridge/oauth/callback",
    eventsRequestUrl: "https://slack-cell.raft.test/api/slack-bridge/events",
    appOrigin: "https://app.raft.test",
    isLaunchEnabled: input.isLaunchEnabled ?? (async () => true),
    resolveOAuthCompletionRedirectPath: input.resolveOAuthCompletionRedirectPath
      ?? (async () => "/s/slack-route/settings/im-bridges"),
    now: () => input.nowSequence?.[
      Math.min(nowIndex++, input.nowSequence.length - 1)
    ] ?? now,
    async leaseOAuthAppCredential(leaseInput) {
      counters.leases += 1;
      return {
        handle: {
          schema: SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
          handleId: `managed-app:${leaseInput.attemptId}`,
          providerAppId: leaseInput.providerAppId,
          environment: leaseInput.environment,
        },
        leaseExpiresAt: input.leaseExpiresAt ?? new Date(now.getTime() + 60_000),
      };
    },
    async captureAuthorizationCode(captureInput) {
      counters.captures += 1;
      assert.equal(captureInput.authorizationCode, "provider-code");
      return {
        schema: SLACK_OAUTH_CODE_HANDLE_SCHEMA,
        handleId: `managed-code:${captureInput.attemptId}`,
        expiresAt: input.codeExpiresAt ?? new Date(now.getTime() + 60_000),
      };
    },
    async exchangeOAuth(request) {
      counters.exchanges += 1;
      if (input.exchange) return input.exchange(request);
      return {
        kind: "authorized",
        providerAppId: request.expectedProviderAppId,
        providerTeamId: "T_ROUTE_TEST",
        providerEnterpriseId: null,
        providerUserId: "U_ROUTE_OWNER",
        botUserId: "U_ROUTE_BOT",
        providerBotId: "B_ROUTE_BOT",
        workspaceName: "Route Test",
        // Token carries usergroups:* beyond the required contract — the
        // live staging app does this. Superset must still complete the
        // install and issue the grant receipt.
        installedScopes: [
          ...request.expectedScopes,
          "usergroups:read",
          "usergroups:write",
        ],
        sealedCredential: {
          encryptedMaterial: "sealed:route-test-token",
          envelopeKeyId: "route-test-envelope",
          aadVersion: 1,
        },
      };
    },
    secretResolver: {
      async resolveSigningSecret() {
        return "route-test-signing-secret";
      },
    },
    payloadSealer: {
      async sealNormalizedPayload() {
        return {
          encryptedPayload: "sealed:route-event",
          envelopeKeyId: "route-event-envelope",
          aadVersion: 1,
        };
      },
    },
    async admitSlackIngress(admitInput) {
      counters.ingress += 1;
      assert.equal(admitInput.requestUrl, "https://slack-cell.raft.test/api/slack-bridge/events");
      assert.equal(admitInput.environment, "test");
      if (admitInput.rawBody.toString("utf8") === '{"type":"member_joined"}') {
        admitInput.requestLifecycleRefresh?.("binding-current");
        return { kind: "event", eventInboxId: "member-receipt", duplicate: false,
          status: "committed", reason: "provider_member_joined", authority: null };
      }
      if (admitInput.rawBody.toString("utf8") === '{"type":"ordinary_message"}') {
        return {
          kind: "event", eventInboxId: "message-receipt-1",
          duplicate: admitInput.slackRetryNumHeader !== null,
          status: "queued", reason: null, authority: null,
        };
      }
      if (admitInput.rawBody.toString("utf8") === "{\"type\":\"bot_loop\"}") {
        assert.equal(admitInput.slackRetryNumHeader, null);
        assert.equal(admitInput.slackRetryReasonHeader, null);
        return {
          kind: "event",
          eventInboxId: "discard-receipt-1",
          duplicate: false,
          status: "unsupported",
          reason: "provider_loop_suppressed",
          authority: null,
        };
      }
      assert.equal(admitInput.rawBody.toString("utf8"), "{\"type\":\"url_verification\"}");
      return {
        kind: "url_verification",
        challenge: "route-challenge",
        endpointRevision: 1,
        signingSecretRevision: 1,
      };
    },
    ...(input.provisioning ? { provisioning: input.provisioning } : {}),
    ...(input.requestLifecycleReconcile
      ? { requestLifecycleReconcile: input.requestLifecycleReconcile }
      : {}),
    ...(input.onLifecycleError ? { onLifecycleError: input.onLifecycleError } : {}),
  };
}

async function beginOAuth(input: {
  baseUrl: string;
  token: string;
  serverId: string;
  registrationId: string;
  serverGrantId: string;
  grantEpoch: number;
}) {
  return fetch(`${input.baseUrl}/api/slack-bridge/oauth/start`, {
    method: "POST",
    headers: headers(input),
    body: JSON.stringify({
      registrationId: input.registrationId,
      serverGrantId: input.serverGrantId,
      grantEpoch: input.grantEpoch,
      // Client-supplied scope/intent fields must be ignored.
      requestedScopes: ["admin", "tokens:write"],
      grantIntent: "caller-controlled",
    }),
  });
}

/** The browser that started the install calls back with the start's binding cookie. */
function bindingCookie(state: string): string {
  return `raft_slack_oauth_${createHash("sha256").update(state, "utf8").digest("hex").slice(0, 16)}=${encodeURIComponent(state)}`;
}

function startingBrowserFetch(url: string, init: RequestInit = {}) {
  const state = new URL(url).searchParams.get("state") ?? "";
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Cookie: bindingCookie(state) } });
}

test("Slack routes fail closed with no provider runtime and persist no OAuth state", async () => {
  slackBridgeIngressObservationsTotal.reset();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    assert.equal(start.status, 503);
    assert.deepEqual(await start.json(), {
      ok: false,
      code: "slack_bridge_provider_unavailable",
    });
    assert.equal((await getDb().select().from(externalOAuthAttempts)).length, 0);

    const provisioning = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, {
      headers: headers({ token, serverId: seeded.server.id }),
    });
    assert.equal(provisioning.status, 503);
    assert.deepEqual(await provisioning.json(), {
      ok: false,
      code: "slack_bridge_provider_unavailable",
    });

    const callback = await fetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback?state=missing&code=provider-code`,
    );
    assert.equal(callback.status, 503);

    const events = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"type\":\"url_verification\"}",
    });
    assert.equal(events.status, 503);
    const observations = await slackBridgeIngressObservationsTotal.get();
    assert.equal(observations.values.find((sample) =>
      sample.labels.stage === "arrival"
      && sample.labels.outcome === "request"
      && sample.labels.delivery === "initial"
    )?.value, 1);
    assert.equal(observations.values.find((sample) =>
      sample.labels.stage === "terminal"
      && sample.labels.outcome === "runtime_unavailable"
      && sample.labels.delivery === "initial"
    )?.value, 1);
  } finally {
    await app.close();
  }
});

test("partially configured provider runtime fails closed before OAuth persistence", async () => {
  const partialRuntime = {
    ...runtime(),
    exchangeOAuth: undefined,
  } as unknown as SlackBridgeRouteDependencies;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: partialRuntime });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    assert.equal(start.status, 503);
    assert.deepEqual(await start.json(), {
      ok: false,
      code: "slack_bridge_provider_unavailable",
    });
    assert.equal((await getDb().select().from(externalOAuthAttempts)).length, 0);
  } finally {
    await app.close();
  }
});

function provisioningResponse(stage: SlackBridgeSetupStage): SlackBridgeProvisioningResponse {
  return {
    protocolVersion: SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
    snapshot: {
      stage,
      workspaceName: stage === "connect" ? null : "Route Test Slack",
      raftChannels: [{ id: "raft-general", name: "general" }],
      slackChannels: [{ id: "C_ROUTE_GENERAL", name: "general" }],
      channelPairs: stage === "connect" || stage === "oauth"
        ? []
        : [{ raftChannelId: "raft-general", slackChannelId: "C_ROUTE_GENERAL" }],
      preflight: stage === "enable" || stage === "health"
        ? {
          state: "passed",
          checks: [
            { id: "oauth", state: "passed" },
            { id: "endpoint", state: "passed" },
            { id: "scope", state: "passed" },
            { id: "audience", state: "passed" },
          ],
        }
        : null,
      rawHealth: {
        install: null,
        credential: null,
        bindings: [],
        audiences: [],
        lastVerifiedAt: null,
        agentMentionSync: null,
        failingSurface: stage === "connect" ? "install" : null,
      },
    },
    oauthAuthority: stage === "oauth"
      ? {
        registrationId: randomUUID(),
        serverGrantId: randomUUID(),
        grantEpoch: 1,
      }
      : null,
  };
}

test("typed provisioning routes preserve principal authority and the 1:1 mutation chain", async () => {
  const calls: string[] = [];
  const authorities: Array<{ serverId: string; requestingUserId: string }> = [];
  let stage: SlackBridgeSetupStage = "connect";
  const record = (operation: string, authority: { serverId: string; requestingUserId: string }) => {
    calls.push(operation);
    authorities.push({
      serverId: authority.serverId,
      requestingUserId: authority.requestingUserId,
    });
  };
  const provisioning: SlackBridgeProvisioningControlPlane = {
    async load(authority) {
      record("load", authority);
      return provisioningResponse(stage);
    },
    async connect(authority) {
      record("connect", authority);
      stage = "oauth";
      return provisioningResponse(stage);
    },
    async saveChannelPairs(input) {
      record(`pairs:${input.pairs[0]?.raftChannelId}:${input.pairs[0]?.slackChannelId}`, input);
      stage = "preflight";
      return provisioningResponse(stage);
    },
    async removeChannelPairs(input) {
      record(
        `remove:${input.pairs[0]?.raftChannelId}:${input.pairs[0]?.slackChannelId}:${input.pairs[0]?.expectedBindingEpoch}`,
        input,
      );
      stage = "channels";
      return provisioningResponse(stage);
    },
    async disconnect(input) {
      record(`disconnect:${input.expectedConnectionEpoch}`, input);
      stage = "connect";
      return provisioningResponse(stage);
    },
    async runPreflight(authority) {
      record("preflight", authority);
      stage = "enable";
      return provisioningResponse(stage);
    },
    async retryDelivery(authority) {
      record(`retry:${authority.bindingEpoch}`, authority);
      return provisioningResponse("health");
    },
    async replayInbound(authority) {
      record(`replay:${authority.bindingEpoch}`, authority);
      return provisioningResponse("health");
    },
    async enable(authority) {
      record("enable", authority);
      stage = "health";
      return provisioningResponse(stage);
    },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({ provisioning }) });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const requestHeaders = headers({ token, serverId: seeded.server.id });
    const requests: Array<[string, string, unknown?]> = [
      ["GET", "/api/slack-bridge/provisioning"],
      ["POST", "/api/slack-bridge/provisioning/connect"],
      ["PUT", "/api/slack-bridge/provisioning/channel-pairs", {
        pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_ROUTE_GENERAL" }],
      }],
      ["DELETE", "/api/slack-bridge/provisioning/channel-pairs", {
        pairs: [{
          raftChannelId: "raft-general",
          slackChannelId: "C_ROUTE_GENERAL",
          expectedBindingEpoch: 1,
        }],
      }],
      ["POST", "/api/slack-bridge/provisioning/preflight"],
      ["POST", "/api/slack-bridge/provisioning/enable"],
      ["POST", "/api/slack-bridge/provisioning/retry-delivery", {
        bindingId: "11111111-1111-4111-8111-111111111111", bindingEpoch: 7,
        deliveryId: "22222222-2222-4222-8222-222222222222", expectedProviderAttempts: 3, duplicateRiskAcknowledged: true,
      }],
      ["POST", "/api/slack-bridge/provisioning/replay-inbound", {
        bindingId: "11111111-1111-4111-8111-111111111111", bindingEpoch: 7,
        eventId: "22222222-2222-4222-8222-222222222222",
      }],
      ["POST", "/api/slack-bridge/provisioning/replay-inbound", {
        bindingId: "11111111-1111-4111-8111-111111111111", bindingEpoch: 7,
        reason: "bot_identity_pending",
      }],
      ["POST", "/api/slack-bridge/provisioning/disconnect", { expectedConnectionEpoch: 7 }],
    ];
    for (const [method, path, body] of requests) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
      assert.equal((await response.json() as { protocolVersion: number }).protocolVersion, 1);
    }

    const invalidRetry = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/retry-delivery`, {
      method: "POST", headers: requestHeaders,
      body: JSON.stringify({ bindingId: "11111111-1111-4111-8111-111111111111", bindingEpoch: 7,
        deliveryId: "22222222-2222-4222-8222-222222222222" }),
    });
    assert.equal(invalidRetry.status, 400, "the retry disclosure must be acknowledged");
    const ambiguousReplay = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/replay-inbound`, {
      method: "POST", headers: requestHeaders, body: JSON.stringify({ bindingId: "11111111-1111-4111-8111-111111111111",
        bindingEpoch: 7, eventId: "not-an-id", reason: "bot_identity_pending" }),
    });
    assert.equal(ambiguousReplay.status, 400, "a malformed single-event request cannot become a batch");
    assert.deepEqual(calls, [
      "load",
      "connect",
      "pairs:raft-general:C_ROUTE_GENERAL",
      "remove:raft-general:C_ROUTE_GENERAL:1",
      "preflight",
      "enable",
      "retry:7",
      "replay:7",
      "replay:7",
      "disconnect:7",
    ]);
    assert.equal(authorities.length, calls.length);
    for (const authority of authorities) {
      assert.deepEqual(authority, {
        serverId: seeded.server.id,
        requestingUserId: seeded.owner.id,
      });
    }
  } finally {
    await app.close();
  }
});

test("launch gate fail-closes new setup and OAuth while preserving removal and disconnect", async () => {
  const calls: string[] = [];
  const provisioning: SlackBridgeProvisioningControlPlane = {
    async load() { calls.push("load"); return provisioningResponse("connect"); },
    async connect() { calls.push("connect"); return provisioningResponse("oauth"); },
    async saveChannelPairs() { calls.push("save"); return provisioningResponse("preflight"); },
    async removeChannelPairs() { calls.push("remove"); return provisioningResponse("channels"); },
    async disconnect() { calls.push("disconnect"); return provisioningResponse("connect"); },
    async runPreflight() { calls.push("preflight"); return provisioningResponse("enable"); },
    async enable() { calls.push("enable"); return provisioningResponse("health"); },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      provisioning,
      isLaunchEnabled: async () => false,
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const requestHeaders = headers({ token, serverId: seeded.server.id });
    const blockedRequests: Array<[string, string, unknown?]> = [
      ["GET", "/api/slack-bridge/provisioning"],
      ["POST", "/api/slack-bridge/provisioning/connect"],
      ["PUT", "/api/slack-bridge/provisioning/channel-pairs", {
        pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_ROUTE_GENERAL" }],
      }],
      ["POST", "/api/slack-bridge/provisioning/preflight"],
      ["POST", "/api/slack-bridge/provisioning/enable"],
    ];
    for (const [method, path, body] of blockedRequests) {
      const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { ok: false, code: "slack_bridge_disabled" });
    }
    assert.deepEqual(calls, []);

    const oauth = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: seeded.grant.grantEpoch,
    });
    assert.equal(oauth.status, 403);
    assert.deepEqual(await oauth.json(), { ok: false, code: "slack_bridge_disabled" });
    assert.equal((await getDb().select().from(externalOAuthAttempts)).length, 0);

    const removal = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "DELETE",
      headers: requestHeaders,
      body: JSON.stringify({
        pairs: [{
          raftChannelId: "raft-general",
          slackChannelId: "C_ROUTE_GENERAL",
          expectedBindingEpoch: 1,
        }],
      }),
    });
    assert.equal(removal.status, 200);
    const disconnect = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/disconnect`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ expectedConnectionEpoch: 7 }),
    });
    assert.equal(disconnect.status, 200);
    assert.deepEqual(calls, ["remove", "disconnect"]);
  } finally {
    await app.close();
  }
});

test("provisioning rejects malformed pairs and invalid backend projections without advancing authority", async () => {
  let pairCalls = 0;
  const provisioning: SlackBridgeProvisioningControlPlane = {
    async load() {
      return {
        ...provisioningResponse("health"),
        snapshot: { ...provisioningResponse("health").snapshot, stage: "unknown" },
      } as unknown as SlackBridgeProvisioningResponse;
    },
    async connect() { return provisioningResponse("oauth"); },
    async saveChannelPairs() {
      pairCalls += 1;
      return provisioningResponse("preflight");
    },
    async removeChannelPairs() {
      pairCalls += 1;
      return provisioningResponse("channels");
    },
    async disconnect() {
      pairCalls += 1;
      return provisioningResponse("connect");
    },
    async runPreflight() { return provisioningResponse("enable"); },
    async enable() { return provisioningResponse("health"); },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({ provisioning }) });
  try {
    const seeded = await seedControlPlane();
    const requestHeaders = headers({
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
    });
    const malformed = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({ pairs: [] }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(pairCalls, 0);

    const duplicate = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
      method: "PUT",
      headers: requestHeaders,
      body: JSON.stringify({
        pairs: [
          { raftChannelId: "raft-general", slackChannelId: "C_ONE" },
          { raftChannelId: "raft-general", slackChannelId: "C_TWO" },
        ],
      }),
    });
    assert.equal(duplicate.status, 400);
    assert.equal(pairCalls, 0);

    const removalWithoutEpoch = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers: requestHeaders,
        body: JSON.stringify({
          pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_ONE" }],
        }),
      },
    );
    assert.equal(removalWithoutEpoch.status, 400);
    assert.equal(pairCalls, 0);

    const duplicateRemoval = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`,
      {
        method: "DELETE",
        headers: requestHeaders,
        body: JSON.stringify({
          pairs: [
            { raftChannelId: "raft-general", slackChannelId: "C_ONE", expectedBindingEpoch: 1 },
            { raftChannelId: "raft-general", slackChannelId: "C_TWO", expectedBindingEpoch: 1 },
          ],
        }),
      },
    );
    assert.equal(duplicateRemoval.status, 400);
    assert.equal(pairCalls, 0);

    const malformedDisconnect = await fetch(
      `${app.baseUrl}/api/slack-bridge/provisioning/disconnect`,
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ expectedConnectionEpoch: "1" }),
      },
    );
    assert.equal(malformedDisconnect.status, 400);
    assert.equal(pairCalls, 0);

    const invalidProjection = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning`, {
      headers: requestHeaders,
    });
    assert.equal(invalidProjection.status, 503);
    assert.deepEqual(await invalidProjection.json(), {
      ok: false,
      code: "slack_bridge_provider_unavailable",
    });
  } finally {
    await app.close();
  }
});

test("an OAuth callback from a browser that did not start the install is fenced before any provider call", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      async resolveOAuthCompletionRedirectPath() {
        return "/s/slack-route/settings/im-bridges";
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const startState = async () => {
      const start = await beginOAuth({
        baseUrl: app.baseUrl, token, serverId: seeded.server.id, registrationId: seeded.registration.id,
        serverGrantId: seeded.grant.id, grantEpoch: 1,
      });
      assert.equal(start.status, 201);
      return new URL((await start.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get("state")!;
    };
    const otherInstallCookie = bindingCookie(await startState());
    // ⭐ Someone else opening the authorization link: no cookie, another install's cookie, or a forged value.
    for (const cookieFor of [
      (_state: string) => undefined,
      (_state: string) => otherInstallCookie,
      (state: string) => `${bindingCookie(state).split("=")[0]}=not-the-state`,
    ]) {
      const state = await startState();
      const cookie = cookieFor(state);
      const callback = await fetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback?state=${encodeURIComponent(state)}&code=attacker-workspace-code`,
        { redirect: "manual", ...(cookie ? { headers: { Cookie: cookie } } : {}) },
      );
      assert.equal(callback.status, 400, `callback with cookie ${cookie ?? "(none)"}`);
      assert.deepEqual(await callback.json(), { ok: false, code: "slack_oauth_callback_unbound" });
      assert.match(callback.headers.getSetCookie()[0] ?? "", /^raft_slack_oauth_[0-9a-f]{16}=; Path=\/api\/slack-bridge\/oauth\/callback; Max-Age=0/u);
      // The state is spent: the starter cannot be raced into finishing it later either.
      const replay = await startingBrowserFetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback?state=${encodeURIComponent(state)}&code=provider-code`,
        { redirect: "manual" },
      );
      assert.equal(replay.status, 400);
    }
    assert.deepEqual([counters.leases, counters.captures, counters.exchanges], [0, 0, 0], "no provider call for an unbound callback");
    assert.equal((await getDb().select().from(externalAppInstalls)).length, 0, "no workspace connected");
    const attempts = await getDb().select({ status: externalOAuthAttempts.status }).from(externalOAuthAttempts);
    assert.equal(attempts.filter((attempt) => attempt.status === "exchange_unknown").length, 3);
  } finally {
    await app.close();
  }
});

test("OAuth route fixes scopes, uses one-time state, leases managed handles, and redirects to trusted IM Bridges", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const resolvedServerIds: string[] = [];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      async resolveOAuthCompletionRedirectPath({ serverId }) {
        resolvedServerIds.push(serverId);
        return "/s/slack-route/settings/im-bridges";
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const startText = await start.text();
    assert.equal(start.status, 201, startText);
    const startBody = JSON.parse(startText) as {
      authorizationUrl: string;
      expiresAt: string;
    };
    const authorizationUrl = new URL(startBody.authorizationUrl);
    assert.equal(authorizationUrl.origin, "https://slack.com");
    assert.equal(authorizationUrl.pathname, "/oauth/v2/authorize");
    assert.equal(authorizationUrl.searchParams.get("client_id"), "111.222");
    assert.equal(
      authorizationUrl.searchParams.get("scope"),
      SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
    );
    assert.equal(
      authorizationUrl.searchParams.get("redirect_uri"),
      "https://slack-cell.raft.test/api/slack-bridge/oauth/callback",
    );
    assert.equal(
      authorizationUrl.searchParams.has("team"),
      false,
      "the provider must let the installer choose any eligible workspace",
    );
    const state = authorizationUrl.searchParams.get("state");
    assert.ok(state);
    assert.equal(startText.includes(state), true, "state exists only inside the provider URL");
    // The install is bound to the starting browser by an HttpOnly cookie scoped to the callback.
    const [binding] = start.headers.getSetCookie();
    assert.equal(binding?.split(";")[0], bindingCookie(state));
    assert.match(binding!, /; Path=\/api\/slack-bridge\/oauth\/callback; Max-Age=\d+; HttpOnly; SameSite=Lax/u);

    const [attempt] = await getDb().select().from(externalOAuthAttempts);
    assert.notEqual(attempt.stateHash, state);
    assert.deepEqual(attempt.requestedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]);

    const callback = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`
      + "&return_to=https%3A%2F%2Fevil.example%2Fsteal",
      { redirect: "manual" },
    );
    const callbackText = await callback.text();
    assert.equal(callback.status, 302, callbackText);
    assert.equal(
      callback.headers.get("location"),
      "https://app.raft.test/s/slack-route/settings/im-bridges",
    );
    assert.equal(callbackText.includes("installId"), false, "completion details stay out of the browser response");
    assert.deepEqual(resolvedServerIds, [seeded.server.id]);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 1);
    assert.equal(callbackText.includes("provider-code"), false);
    assert.equal(callbackText.includes("sealed:route-test-token"), false);

    const [install] = await getDb().select().from(externalAppInstalls);
    assert.equal(install.providerAuthorityId, "T_ROUTE_TEST");
    assert.deepEqual([...install.installedScopes].sort(), [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES].sort());
    // Per-member OAuth identity links are no longer created at connect
    // (task #241): pairing authority comes from the binding itself.
    assert.equal((await getDb().select().from(externalHumanIdentityLinks)).length, 0);

    const replay = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
    );
    assert.equal(replay.status, 400);
    assert.equal(counters.exchanges, 1, "single-use state prevents a second provider call");

    const rejectedStart = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const rejectedState = new URL(
      (await rejectedStart.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const rejected = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(rejectedState)}`
      + "&error=access_denied&error_description=provider-private-detail",
      { redirect: "manual" },
    );
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 302, rejectedText);
    assert.equal(
      rejected.headers.get("location"),
      "https://app.raft.test/s/slack-route/settings/im-bridges?slack_oauth=error&code=slack_oauth_provider_rejected",
    );
    assert.equal(rejectedText.includes("access_denied"), false);
    assert.equal(rejectedText.includes("provider-private-detail"), false);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 1);

    const missingCodeStart = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const missingCodeState = new URL(
      (await missingCodeStart.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const missingCode = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(missingCodeState)}`,
      { redirect: "manual" },
    );
    assert.equal(missingCode.status, 302);
    assert.equal(
      missingCode.headers.get("location"),
      "https://app.raft.test/s/slack-route/settings/im-bridges?slack_oauth=error&code=slack_oauth_provider_rejected",
    );
    assert.equal(counters.leases, 1, "missing-code rejection must not lease credentials");
    assert.equal(counters.captures, 1, "missing-code rejection must not capture a code");
    assert.equal(counters.exchanges, 1, "missing-code rejection must not call the provider");
    const missingCodeReplay = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(missingCodeState)}`,
      { redirect: "manual" },
    );
    assert.equal(missingCodeReplay.status, 400, "the missing-code callback remains single-use");
  } finally {
    await app.close();
  }
});

test("reauthorization URL selects the current team and a different returned team leaves authority unchanged", async () => {
  let returnedTeamId = "T_ROUTE_TEST";
  const base = runtime();
  const deps = runtime({ exchange: async (request) => {
    const result = await base.exchangeOAuth(request);
    return result.kind === "authorized" ? { ...result, providerTeamId: returnedTeamId } : result;
  } });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: deps });
  try {
    const seeded = await seedControlPlane();
    const start = async () => {
      const response = await beginOAuth({ baseUrl: app.baseUrl, token: await accessTokenForTest(seeded.owner.id),
        serverId: seeded.server.id, registrationId: seeded.registration.id,
        serverGrantId: seeded.grant.id, grantEpoch: 1 });
      assert.equal(response.status, 201);
      return new URL((await response.json() as { authorizationUrl: string }).authorizationUrl);
    };
    const callback = (url: URL) => startingBrowserFetch(`${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=provider-code`, { redirect: "manual" });
    const initial = await start();
    assert.equal(initial.searchParams.has("team"), false, "a first install can select its workspace");
    assert.equal((await callback(initial)).status, 302);
    const snapshot = async () => ({
      installs: await getDb().select().from(externalAppInstalls),
      credentials: await getDb().select().from(externalAppCredentials),
      associations: await getDb().select().from(externalAppInstallServerGrants),
    });
    const before = await snapshot();
    const reauthorization = await start();
    assert.equal(reauthorization.searchParams.get("team"), "T_ROUTE_TEST");
    // Same workspace display name, different provider team: names cannot be authority.
    returnedTeamId = "T_ANOTHER_WORKSPACE";
    const rejected = await callback(reauthorization);
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      ok: false, code: "external_app_workspace_mismatch",
      message: "You selected another Slack workspace. Reauthorize the connected workspace, or disconnect it before switching.",
    });
    assert.deepEqual(await snapshot(), before, "a wrong workspace cannot write an install, credential or association");
    const attempts = await getDb().select().from(externalOAuthAttempts);
    assert.equal(attempts.filter((attempt) => attempt.status === "exchange_unknown").length, 1,
      "the rejected provider exchange must still be fenced from automatic reuse");
  } finally { await app.close(); }
});

test("invalid completion redirect paths fence OAuth before managed handles or provider exchange", async () => {
  for (const redirectPath of [
    null,
    "https://evil.example/s/slack-route/settings/im-bridges",
    "//evil.example/s/slack-route/settings/im-bridges",
    "/s/slack-route/settings/im-bridges?next=https://evil.example",
    "/s/slack-route/settings/im-bridges%5c%2e%2e%2f%2f",
    "/s/slack-route/settings/im-bridges\u0000",
    "/s/slack-route/settings/other",
  ]) {
    const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
        counters,
        resolveOAuthCompletionRedirectPath: async () => redirectPath,
      }) });
    try {
      const seeded = await seedControlPlane();
      const start = await beginOAuth({
        baseUrl: app.baseUrl,
        token: await accessTokenForTest(seeded.owner.id),
        serverId: seeded.server.id,
        registrationId: seeded.registration.id,
        serverGrantId: seeded.grant.id,
        grantEpoch: 1,
      });
      const state = new URL(
        (await start.json() as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state");
      assert.ok(state);

      const callback = await startingBrowserFetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback`
        + `?state=${encodeURIComponent(state)}&code=provider-code`,
        { redirect: "manual" },
      );
      assert.equal(callback.status, 503, `${redirectPath ?? "null"} must fail closed`);
      assert.equal(callback.headers.get("location"), null);
      assert.deepEqual(counters, { leases: 0, captures: 0, exchanges: 0, ingress: 0 });
      const [attempt] = await getDb().select().from(externalOAuthAttempts);
      assert.equal(attempt.status, "exchange_unknown");

      const replay = await startingBrowserFetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback`
        + `?state=${encodeURIComponent(state)}&code=provider-code`,
      );
      assert.equal(replay.status, 400);
      assert.deepEqual(counters, { leases: 0, captures: 0, exchanges: 0, ingress: 0 });
    } finally {
      await app.close();
    }
  }
});

test("throwing completion redirect resolution fences OAuth before managed handles", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      resolveOAuthCompletionRedirectPath: async () => {
        throw new Error("redirect lookup unavailable");
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    assert.ok(state);

    const callback = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
      { redirect: "manual" },
    );
    assert.equal(callback.status, 503);
    assert.deepEqual(counters, { leases: 0, captures: 0, exchanges: 0, ingress: 0 });
    const [attempt] = await getDb().select().from(externalOAuthAttempts);
    assert.equal(attempt.status, "exchange_unknown");
  } finally {
    await app.close();
  }
});

test("outcome-unknown OAuth callback is terminal reconciliation, never a retry response", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      exchange: async () => ({ kind: "outcome_unknown" }),
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callbackUrl = `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`;
    const callback = await startingBrowserFetch(callbackUrl, { redirect: "manual" });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.has("retry-after"), false);
    assert.equal(
      callback.headers.get("location"),
      "https://app.raft.test/s/slack-route/settings/im-bridges?slack_oauth=error&code=slack_oauth_reconciliation_required",
    );
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 1);
    assert.equal(
      (await getDb().select().from(externalOAuthAttempts))[0].status,
      "exchange_unknown",
    );

    const replay = await fetch(callbackUrl);
    assert.equal(replay.status, 400);
    assert.equal(counters.exchanges, 1);
  } finally {
    await app.close();
  }
});

test("deterministic OAuth rejection surfaces the provider error for diagnosis", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      exchange: async () => ({
        kind: "deterministic_failure",
        reason: "provider_rejected",
        providerError: "bad_client_secret",
      }),
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callback = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
      { redirect: "manual" },
    );
    // The installer lands back on the settings page, not on raw JSON. The
    // provider's own refusal stays visible for diagnosis; without it every
    // Slack rejection collapses to an undiagnosable slack_oauth_rejected.
    assert.equal(callback.status, 302);
    assert.equal(
      callback.headers.get("location"),
      "https://app.raft.test/s/slack-route/settings/im-bridges"
        + "?slack_oauth=error&code=slack_oauth_rejected&reason=provider_rejected&provider_error=bad_client_secret",
    );
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 1);
    assert.equal(
      (await getDb().select().from(externalOAuthAttempts))[0].status,
      "exchange_unknown",
    );
  } finally {
    await app.close();
  }
});

test("a Slack provider error reaches the settings page only when it is a plain identifier", async () => {
  for (const [providerError, expectedSuffix] of [
    ["invalid_team_for_non_distributed_app", "&provider_error=invalid_team_for_non_distributed_app"],
    ["missing=usergroups:read", ""],
  ] as const) {
    const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
        counters,
        exchange: async () => ({
          kind: "deterministic_failure",
          reason: "provider_rejected",
          providerError,
        }),
      }) });
    try {
      const seeded = await seedControlPlane();
      const start = await beginOAuth({
        baseUrl: app.baseUrl,
        token: await accessTokenForTest(seeded.owner.id),
        serverId: seeded.server.id,
        registrationId: seeded.registration.id,
        serverGrantId: seeded.grant.id,
        grantEpoch: 1,
      });
      const state = new URL(
        (await start.json() as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state")!;

      const callback = await startingBrowserFetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback`
        + `?state=${encodeURIComponent(state)}&code=provider-code`,
        { redirect: "manual" },
      );
      assert.equal(callback.status, 302);
      assert.equal(
        callback.headers.get("location"),
        "https://app.raft.test/s/slack-route/settings/im-bridges"
          + "?slack_oauth=error&code=slack_oauth_rejected&reason=provider_rejected" + expectedSuffix,
      );
    } finally {
      await app.close();
    }
  }
});

test("stale state and expired managed lease stop before code capture or provider I/O", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const now = new Date();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      now,
      leaseExpiresAt: now,
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = await accessTokenForTest(seeded.owner.id);
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const expiredLease = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
    );
    assert.equal(expiredLease.status, 503);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 0);
    assert.equal(counters.exchanges, 0);
    assert.equal((await getDb().select().from(externalOAuthAttempts))[0].status, "exchange_unknown");

    const secondStart = await beginOAuth({
      baseUrl: app.baseUrl,
      token,
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const staleState = new URL(
      (await secondStart.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;
    const [pending] = await getDb().select().from(externalOAuthAttempts)
      .where(eq(externalOAuthAttempts.status, "pending"));
    await getDb().update(externalOAuthAttempts)
      .set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(externalOAuthAttempts.id, pending.id));

    const stale = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(staleState)}&code=provider-code`,
    );
    assert.equal(stale.status, 400);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 0);
    assert.equal(counters.exchanges, 0);
  } finally {
    await app.close();
  }
});

test("lease expiry during managed resolution stops before code capture or provider I/O", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const t0 = new Date();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      now: t0,
      nowSequence: [
        t0,
        new Date(t0.getTime() + 1_000),
        new Date(t0.getTime() + 1_000),
        new Date(t0.getTime() + 2_000),
      ],
      leaseExpiresAt: new Date(t0.getTime() + 1_500),
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callback = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
    );
    assert.equal(callback.status, 503);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 0);
    assert.equal(counters.exchanges, 0);
    assert.equal(
      (await getDb().select().from(externalOAuthAttempts))[0].status,
      "exchange_unknown",
    );
  } finally {
    await app.close();
  }
});

test("code-handle expiry during managed capture stops before provider I/O", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const t0 = new Date();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      now: t0,
      nowSequence: [
        t0,
        new Date(t0.getTime() + 1_000),
        new Date(t0.getTime() + 1_000),
        new Date(t0.getTime() + 1_200),
        new Date(t0.getTime() + 3_000),
      ],
      leaseExpiresAt: new Date(t0.getTime() + 60_000),
      codeExpiresAt: new Date(t0.getTime() + 2_500),
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: await accessTokenForTest(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callback = await startingBrowserFetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(state)}&code=provider-code`,
    );
    assert.equal(callback.status, 503);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 0);
    assert.equal(
      (await getDb().select().from(externalOAuthAttempts))[0].status,
      "exchange_unknown",
    );
  } finally {
    await app.close();
  }
});

test("raw-body Events route rejects missing signatures before admission and exposes only Slack ACKs", async () => {
  slackBridgeIngressObservationsTotal.reset();
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  let lifecycleCalls = 0;
  const lifecycleErrors: unknown[] = [];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
      counters,
      requestLifecycleReconcile() {
        lifecycleCalls += 1;
        return Promise.reject(new Error("lifecycle-test-failure"));
      },
      onLifecycleError(error) {
        lifecycleErrors.push(error);
      },
    }) });
  try {
    const rawBody = "{\"type\":\"url_verification\"}";
    const missingSignature = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    });
    assert.equal(missingSignature.status, 401);
    assert.deepEqual(await missingSignature.json(), {
      ok: false,
      code: "external_ingress_signature_invalid",
    });
    assert.equal(counters.ingress, 0);

    const retryMissingSignature = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Retry-Num": "1",
        "X-Slack-Retry-Reason": "http_error",
      },
      body: rawBody,
    });
    assert.equal(retryMissingSignature.status, 401);
    assert.deepEqual(await retryMissingSignature.json(), {
      ok: false,
      code: "external_ingress_signature_invalid",
    });
    assert.equal(counters.ingress, 0);

    const verified = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": "1770000000",
        "X-Slack-Signature": "v0=test-signature",
      },
      body: rawBody,
    });
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { challenge: "route-challenge" });
    assert.equal(counters.ingress, 1);
    assert.equal(lifecycleCalls, 0, "URL verification is not a lifecycle event");

    const intentionalDiscard = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": "1770000000",
        "X-Slack-Signature": "v0=test-signature",
      },
      body: "{\"type\":\"bot_loop\"}",
    });
    assert.equal(intentionalDiscard.status, 200);
    assert.deepEqual(await intentionalDiscard.json(), { ok: true });
    assert.equal(counters.ingress, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lifecycleCalls, 0, "ordinary ingress must not start a full lifecycle refresh");
    assert.equal(lifecycleErrors.length, 0);

    for (const retry of [false, true]) {
      const message = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slack-Request-Timestamp": "1770000000",
          "X-Slack-Signature": "v0=test-signature",
          ...(retry ? { "X-Slack-Retry-Num": "1", "X-Slack-Retry-Reason": "http_timeout" } : {}),
        },
        body: '{"type":"ordinary_message"}',
      });
      assert.equal(message.status, 200);
      assert.deepEqual(await message.json(), { ok: true });
    }
    assert.equal(lifecycleCalls, 0, "normal messages and duplicate retries do not trigger a full refresh");

    const observations = await slackBridgeIngressObservationsTotal.get();
    const count = (stage: string, outcome: string, delivery = "initial") =>
      observations.values.find((sample) =>
        sample.labels.stage === stage
        && sample.labels.outcome === outcome
        && sample.labels.delivery === delivery
      )?.value ?? 0;
    assert.equal(count("arrival", "request"), 4);
    assert.equal(count("arrival", "request", "retry"), 2);
    assert.equal(count("terminal", "external_ingress_signature_invalid"), 1);
    assert.equal(count("terminal", "external_ingress_signature_invalid", "retry"), 1);
    assert.equal(count("terminal", "url_verification"), 1);
    assert.equal(count("terminal", "event_unsupported"), 1);
    assert.equal(
      observations.values.some((sample) =>
        Object.values(sample.labels).some((value) =>
          /route-test|test-signature|sealed|discard-receipt|http_error/i.test(String(value))
        )
      ),
      false,
      "metric labels expose only closed stage/outcome/delivery values",
    );
  } finally {
    await app.close();
  }
});

test("raw-body Events route observes parser rejection before handler admission", async () => {
  slackBridgeIngressObservationsTotal.reset();
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({ counters }) });
  try {
    const response = await fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat((1024 * 1024) + 1),
    });
    assert.equal(response.status, 413);
    assert.equal(counters.ingress, 0, "body parser rejection never enters Slack admission");

    const observations = await slackBridgeIngressObservationsTotal.get();
    const count = (stage: string, outcome: string) =>
      observations.values.find((sample) =>
        sample.labels.stage === stage
        && sample.labels.outcome === outcome
        && sample.labels.delivery === "initial"
      )?.value ?? 0;
    assert.equal(count("arrival", "request"), 1);
    assert.equal(count("terminal", "raw_body_too_large"), 1);
    assert.equal(
      observations.values.filter((sample) => sample.labels.stage === "terminal")
        .reduce((total, sample) => total + sample.value, 0),
      1,
      "parser rejection has exactly one route-local terminal observation",
    );
  } finally {
    await app.close();
  }
});

test("channel-pair failures return bounded recovery reasons and keep the legacy error code", async () => {
  let failureReason: "privacy_mismatch" | "not_member" | "channel_unavailable" | "provider_unavailable" | undefined;
  const provisioning: SlackBridgeProvisioningControlPlane = {
    async load() { return provisioningResponse("channels"); },
    async connect() { return provisioningResponse("oauth"); },
    async saveChannelPairs() {
      throw new ExternalAppControlPlaneError("private provider body must never reach the browser", "external_app_invalid_state", failureReason);
    },
    async removeChannelPairs() { return provisioningResponse("channels"); },
    async disconnect() { return provisioningResponse("connect"); },
    async runPreflight() { return provisioningResponse("enable"); },
    async enable() { return provisioningResponse("health"); },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({ provisioning }) });
  try {
    const seeded = await seedControlPlane();
    for (const reason of ["privacy_mismatch", "not_member", "channel_unavailable", "provider_unavailable", undefined] as const) {
      failureReason = reason;
      const response = await fetch(`${app.baseUrl}/api/slack-bridge/provisioning/channel-pairs`, {
        method: "PUT",
        headers: headers({ token: await accessTokenForTest(seeded.owner.id), serverId: seeded.server.id }),
        body: JSON.stringify({ pairs: [{ raftChannelId: randomUUID(), slackChannelId: "C_SELECTED" }] }),
      });
      assert.equal(response.status, 400);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.deepEqual(await response.json(), {
        ok: false, code: "external_app_invalid_state", ...(reason ? { reason } : {}),
      });
    }
  } finally { await app.close(); }
});

test("signed lifecycle callback selects the live pair even when revoked history exists", async () => {
  const now = new Date("2026-08-05T12:00:00.000Z");
  const dependencies = runtime({ now });
  dependencies.admitSlackIngress = undefined;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: dependencies });
  try {
    const fixture = await seedControlPlane();
    await getDb().insert(externalAppRegistrationSecrets).values({ registrationId: fixture.registration.id,
      purpose: "signing_secret", encryptedSecretRef: "test-reference", envelopeKeyId: "test-key", secretRevision: 1, aadVersion: 1 });
    await getDb().insert(externalAppIngressEndpoints).values({ registrationId: fixture.registration.id,
      environment: "test", exactRequestUrl: dependencies.eventsRequestUrl, endpointRevision: 1, signingSecretRevision: 1 });
    const [install] = await getDb().insert(externalAppInstalls).values({ serverId: fixture.server.id,
      registrationId: fixture.registration.id, serverGrantId: fixture.grant.id, grantEpoch: 1,
      state: "active", connectionEpoch: 2, scopeRevision: 1, credentialRevision: 1,
      installedScopes: ["channels:read"], providerAppId: fixture.registration.providerAppId,
      providerTeamId: "T_ROUTE", providerEnterpriseId: null, authorityType: "team", providerAuthorityId: "T_ROUTE",
      botUserId: "U_BOT", providerBotId: "B_BOT", workspaceName: "Route Test", lastVerifiedAt: now }).returning();
    await getDb().insert(externalAppInstallServerGrants).values({ installId: install.id, serverId: fixture.server.id,
      registrationId: fixture.registration.id, serverGrantId: fixture.grant.id, grantEpoch: fixture.grant.grantEpoch,
      state: "active", authorizedByType: "human", authorizedById: fixture.owner.id });
    const [channel] = await getDb().insert(channels).values({ serverId: fixture.server.id,
      name: `lifecycle-${randomUUID()}`, type: "channel" }).returning();
    const pair = { serverId: fixture.server.id, registrationId: fixture.registration.id, installId: install.id,
      channelId: channel.id, providerConversationId: "C_ROUTE", providerConversationKind: "public_channel" as const,
      privacyClass: "public" as const, grantEpoch: 1, connectionEpoch: 2, bindingEpoch: 1,
      consentedByType: "human" as const, consentedById: fixture.owner.id, consentedAt: now };
    const [old] = await getDb().insert(externalChannelBindings).values({ ...pair, state: "revoked", stateReason: "binding_removed" }).returning();
    const [current] = await getDb().insert(externalChannelBindings).values({ ...pair, state: "active" }).returning();
    const timestamp = String(Math.floor(now.getTime() / 1_000));
    const send = async (type: "channel_archive" | "channel_deleted") => {
      const body = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
        team_id: "T_ROUTE", event_id: `Ev_${type}`, event: { type, channel: "C_ROUTE" } });
      const signature = `v0=${createHmac("sha256", "route-test-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return fetch(`${app.baseUrl}/api/slack-bridge/events`, { method: "POST", body,
        headers: { "Content-Type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
    };
    const archive = await send("channel_archive");
    assert.equal(archive.status, 200);
    assert.deepEqual(await archive.json(), { ok: true });
    assert.equal((await send("channel_deleted")).status, 200);
    const [updated] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, current.id));
    const [historical] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, old.id));
    assert.equal(updated.state, "paused");
    assert.equal(updated.stateReason, "provider_channel_deleted");
    assert.equal(updated.bindingEpoch, 3);
    assert.equal(historical.state, "revoked");
    assert.equal(historical.bindingEpoch, 1);
  } finally { await app.close(); }
});

test("signed Events route durably accepts a message before current binding or sender lookup", async () => {
  const at = new Date("2026-08-05T12:00:00.000Z");
  const dependencies = runtime({ now: at });
  dependencies.admitSlackIngress = undefined;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: dependencies });
  try {
    const fixture = await seedControlPlane();
    await getDb().insert(externalAppRegistrationSecrets).values({ registrationId: fixture.registration.id,
      purpose: "signing_secret", encryptedSecretRef: "test-reference", envelopeKeyId: "test-key", secretRevision: 1, aadVersion: 1 });
    await getDb().insert(externalAppIngressEndpoints).values({ registrationId: fixture.registration.id,
      environment: "test", exactRequestUrl: dependencies.eventsRequestUrl, endpointRevision: 1, signingSecretRevision: 1 });
    await enableTestSlackIngress();
    const crypto = createSlackVerifiedIngressEnvCrypto({ key: Buffer.alloc(32, 9), keyId: "test-payload-key",
      registrationId: fixture.registration.id, environment: "test", providerAppId: fixture.registration.providerAppId });
    dependencies.verifiedIngressCrypto = crypto;
    const body = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
      team_id: "T_ROUTE", event_id: "Ev_ROUTE", token: "legacy-token-must-not-be-stored",
      event: { type: "message", channel: "C_ROUTE", user: "U_UNKNOWN", ts: "1785931200.000001", text: "private body" } });
    const timestamp = String(Math.floor(at.getTime() / 1_000));
    const signature = `v0=${createHmac("sha256", "route-test-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    const post = (eventBody: string, eventSignature: string) => fetch(`${app.baseUrl}/api/slack-bridge/events`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-slack-request-timestamp": timestamp,
        "x-slack-signature": eventSignature }, body: eventBody,
    });
    assert.equal((await post(body, `v0=${"0".repeat(64)}`)).status, 401);
    assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 0);
    const first = await post(body, signature);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    const [firstStored] = await getDb().select().from(slackVerifiedIngressEvents);
    const retry = await post(body, signature);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true });
    const rows = await getDb().select().from(slackVerifiedIngressEvents);
    assert.equal(rows.length, 1);
    const [stored] = rows;
    assert.equal(stored.id, firstStored.id);
    assert.ok(stored.encryptedPayload && !stored.encryptedPayload.includes("private body"));
    const decoded = await crypto.open({ encryptedPayload: stored.encryptedPayload!, envelopeKeyId: stored.envelopeKeyId!,
      aad: { purpose: "slack-verified-ingress", version: 1, registrationId: fixture.registration.id,
        environment: "test", providerAppId: fixture.registration.providerAppId, providerAuthorityId: "T_ROUTE",
        providerEventId: "Ev_ROUTE", providerConversationId: "C_ROUTE" } });
    assert.ok(!decoded.toString("utf8").includes("legacy-token-must-not-be-stored"));
    assert.equal((JSON.parse(decoded.toString("utf8")) as { event: { text: string } }).event.text, "private body");
    dependencies.verifiedIngressCrypto = { ...crypto, async seal() { throw new Error("seal unavailable"); } };
    const other = body.replace("Ev_ROUTE", "Ev_OTHER");
    const otherSignature = `v0=${createHmac("sha256", "route-test-signing-secret").update(`v0:${timestamp}:${other}`).digest("hex")}`;
    assert.equal((await post(other, otherSignature)).status, 503);
    assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 1);
    dependencies.verifiedIngressCrypto = { ...crypto, async seal() {
      return { encryptedPayload: "private body", envelopeKeyId: "test-payload-key" };
    } };
    assert.equal((await post(other, otherSignature)).status, 503, "a broken sealer must not persist plaintext");
    assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 1);
    dependencies.verifiedIngressCrypto = crypto;
    const unknown = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
      team_id: "T_ROUTE", event_id: "Ev_FUTURE", event: { type: "future_event", data: "future private data" } });
    const sign = (value: string) => `v0=${createHmac("sha256", "route-test-signing-secret").update(`v0:${timestamp}:${value}`).digest("hex")}`;
    assert.equal((await post(unknown, sign(unknown))).status, 200);
    const [unknownStored] = await getDb().select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.providerEventId, "Ev_FUTURE"));
    assert.ok(unknownStored?.encryptedPayload && !unknownStored.encryptedPayload.includes("future private data"));
    const unknownDecoded = await crypto.open({ encryptedPayload: unknownStored.encryptedPayload!, envelopeKeyId: unknownStored.envelopeKeyId!,
      aad: { purpose: "slack-verified-ingress", version: 1, registrationId: fixture.registration.id,
        environment: "test", providerAppId: fixture.registration.providerAppId, providerAuthorityId: "T_ROUTE",
        providerEventId: "Ev_FUTURE", providerConversationId: null } });
    assert.equal(JSON.parse(unknownDecoded.toString("utf8")).event.data, "future private data");
    const sharedFile = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
      team_id: "T_ROUTE", event_id: "Ev_FILE_SHARED", event: { type: "file_shared", channel_id: "C_ROUTE", file_id: "F_ROUTE" } });
    assert.equal((await post(sharedFile, sign(sharedFile))).status, 200);
    const [storedFile] = await getDb().select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.providerEventId, "Ev_FILE_SHARED"));
    assert.ok(storedFile?.encryptedPayload);
    const decodedFile = await crypto.open({ encryptedPayload: storedFile.encryptedPayload!, envelopeKeyId: storedFile.envelopeKeyId!,
      aad: { purpose: "slack-verified-ingress", version: 1, registrationId: fixture.registration.id,
        environment: "test", providerAppId: fixture.registration.providerAppId, providerAuthorityId: "T_ROUTE",
        providerEventId: "Ev_FILE_SHARED", providerConversationId: "C_ROUTE" } });
    assert.equal(JSON.parse(decodedFile.toString("utf8")).event.channel_id, "C_ROUTE");
    assert.equal(storedFile.partitionId, firstStored.partitionId, "file event shares the exact channel queue");
    const malformed = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
      team_id: "T_ROUTE", event_id: "Ev_MALFORMED", event: {} });
    assert.equal((await post(malformed, sign(malformed))).status, 400);
    assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 3);
  } finally {
    await app.close();
  }
});


for (const [label, eventFields, discardReason] of [
  ["unsupported subtype", { subtype: "channel_join" }, "unsupported_message_subtype"],
  ["provider loop", { bot_id: "B_OTHER", app_id: "A_OTHER" }, "provider_loop_suppressed"],
] as const) {
  test(`signed legacy ${label} completion retries through durable custody after cutover`, async () => {
    const at = new Date("2026-08-05T12:00:00.000Z");
    let delegate: NonNullable<SlackBridgeRouteDependencies["admitSlackIngress"]>;
    const dependencies = runtime({ now: at });
    dependencies.admitSlackIngress = request => delegate(request);
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: dependencies });
    let release!: () => void;
    let arrived!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const legacyWritten = new Promise<void>(resolve => { arrived = resolve; });
    let oldRequest: Promise<Response> | undefined;
    try {
      const fixture = await seedControlPlane();
      await getDb().insert(externalAppRegistrationSecrets).values({ registrationId: fixture.registration.id,
        purpose: "signing_secret", encryptedSecretRef: "test-reference", envelopeKeyId: "test-key", secretRevision: 1, aadVersion: 1 });
      await getDb().insert(externalAppIngressEndpoints).values({ registrationId: fixture.registration.id,
        environment: "test", exactRequestUrl: dependencies.eventsRequestUrl, endpointRevision: 1, signingSecretRevision: 1 });
      const crypto = createSlackVerifiedIngressEnvCrypto({ key: Buffer.alloc(32, 9), keyId: "test-payload-key",
        registrationId: fixture.registration.id, environment: "test", providerAppId: fixture.registration.providerAppId });
      // Install the production admission adapter before HTTP route composition.
      // The route's callback was composed from this stable delegate below.
      delegate = createSlackVerifiedIngressAdmission({ getFenceDb: getDb, crypto, admit: async request => {
        const result = await verifyAndAdmitSlackIngress(request);
        if (!request.verifiedIngressCrypto) { arrived(); await held; }
        return result;
      } });
      const body = JSON.stringify({ type: "event_callback", api_app_id: fixture.registration.providerAppId,
        team_id: "T_ROUTE", event_id: "Ev_CUTOVER", event: { type: "message", channel: "C_ROUTE", user: "U_OTHER",
          ts: "1785931200.000001", text: "synthetic cutover body", ...eventFields } });
      const timestamp = String(Math.floor(at.getTime() / 1_000));
      const signature = `v0=${createHmac("sha256", "route-test-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
      const post = () => fetch(`${app.baseUrl}/api/slack-bridge/events`, { method: "POST", body,
        headers: { "Content-Type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
      oldRequest = post();
      await Promise.race([legacyWritten, oldRequest.then(response => {
        throw new Error(`Legacy request completed before its recorded discard barrier: ${response.status}`);
      })]);
      const [discard] = await getDb().select().from(externalIngressDiscardReceipts);
      assert.equal(discard.outcomeReason, discardReason);
      assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 0);
      await enableTestSlackIngress();
      release();
      assert.equal((await oldRequest).status, 503, "a completed legacy discard cannot acknowledge across cutover");
      const retry = await post(); assert.equal(retry.status, 200);
      const [stored] = await getDb().select().from(slackVerifiedIngressEvents);
      assert.equal(stored.state, "queued"); assert.equal(stored.materializedInboundEventId, null);
      const decoded = await crypto.open({ encryptedPayload: stored.encryptedPayload!, envelopeKeyId: stored.envelopeKeyId!,
        aad: { purpose: "slack-verified-ingress", version: 1, registrationId: fixture.registration.id,
          environment: "test", providerAppId: fixture.registration.providerAppId, providerAuthorityId: "T_ROUTE",
          providerEventId: "Ev_CUTOVER", providerConversationId: "C_ROUTE" } });
      assert.equal(JSON.parse(decoded.toString("utf8")).event.text, "synthetic cutover body"); decoded.fill(0);
      assert.equal((await post()).status, 200);
      assert.equal((await getDb().select().from(slackVerifiedIngressEvents)).length, 1);
    } finally { release(); await oldRequest?.catch(() => {}); await app.close(); }
  });
}

test("admitted lifecycle hints reach the targeted runtime without changing Slack acknowledgments", async () => {
  const calls: (string | undefined)[] = []; const errors: unknown[] = [];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, slackBridge: runtime({
    requestLifecycleReconcile(bindingId) { calls.push(bindingId); return Promise.reject(new Error("synthetic refresh failure")); },
    onLifecycleError(error) { errors.push(error); },
  }) });
  try {
    const response = await fetch(`${app.baseUrl}/api/slack-bridge/events`, { method: "POST", body: '{"type":"member_joined"}',
      headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": "1770000000", "X-Slack-Signature": "v0=test-signature" } });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["binding-current"]); assert.equal(errors.length, 1);
  } finally { await app.close(); }
});
