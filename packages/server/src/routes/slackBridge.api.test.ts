import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  type SlackBridgeProvisioningResponse,
  type SlackBridgeSetupStage,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agents,
  channels,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalHumanIdentityLinks,
  externalAuthorPolicies,
  externalChannelBindings,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  users,
} from "../db/schema.js";
import { signAccessToken } from "../middleware/auth.js";
import { slackBridgeIngressObservationsTotal } from "../metrics.js";
import { createServer } from "../services/serverService.js";
import type { ExternalAuthorPolicyRuntimeAuthority } from "../services/externalAppControlPlaneService.js";
import {
  SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
  SLACK_OAUTH_CODE_HANDLE_SCHEMA,
  type SlackOAuthExchangeRequest,
} from "../services/slackProviderAdapter.js";
import { openTestApp } from "../test/integration/app.js";
import {
  SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
  type SlackBridgeProvisioningControlPlane,
  type SlackBridgeRouteDependencies,
} from "./slackBridge.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const REVISION_5_REQUIRED_BOT_SCOPES = [
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
  "users:read",
] as const;

test("Slack OAuth scope request is exact Revision 5 manifest parity", () => {
  assert.deepEqual(
    SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
    REVISION_5_REQUIRED_BOT_SCOPES,
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
  resolveAuthorPolicyAuthority?: SlackBridgeRouteDependencies["resolveAuthorPolicyAuthority"];
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
        installedScopes: [...request.expectedScopes],
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
    ...(input.resolveAuthorPolicyAuthority
      ? { resolveAuthorPolicyAuthority: input.resolveAuthorPolicyAuthority }
      : {}),
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

async function seedAuthorPolicySurface() {
  const suffix = randomUUID();
  const seeded = await seedControlPlane({
    providerAppId: `A_ROUTE_AUTHOR_${suffix}`,
    providerOAuthClientId: `111.222.${suffix}`,
  });
  const [channel] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `slack-author-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [install] = await getDb().insert(externalAppInstalls).values({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    serverGrantId: seeded.grant.id,
    grantEpoch: seeded.grant.grantEpoch,
    state: "active",
    connectionEpoch: 3,
    scopeRevision: 2,
    credentialRevision: 4,
    installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
    providerAppId: seeded.registration.providerAppId,
    providerTeamId: "T_AUTHOR_POLICY",
    providerEnterpriseId: null,
    authorityType: "team",
    providerAuthorityId: "T_AUTHOR_POLICY",
  }).returning();
  const [binding] = await getDb().insert(externalChannelBindings).values({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_AUTHOR_POLICY",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    state: "active",
    grantEpoch: seeded.grant.grantEpoch,
    connectionEpoch: install.connectionEpoch,
    bindingEpoch: 5,
    consentedByType: "human",
    consentedById: seeded.owner.id,
    consentedAt: new Date(),
  }).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: `slack-agent-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Agent Before Rename",
    status: "active",
  }).returning();
  const [member] = await getDb().insert(users).values({
    email: `slack-member-${randomUUID()}@raft.test`,
    name: `slack-member-${randomUUID().slice(0, 8)}`,
    displayName: "Slack Ordinary Member",
    passwordHash: "not-used",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await getDb().insert(serverMembers).values({
    serverId: seeded.server.id,
    userId: member.id,
    role: "member",
  });
  return { ...seeded, channel, install, binding, agent, member };
}

async function putAuthorPolicy(input: {
  baseUrl: string;
  token: string;
  serverId: string;
  bindingId: string;
  authorType: "user" | "agent";
  authorId: string;
  state: "granted" | "revoked";
}) {
  return fetch(`${input.baseUrl}/api/slack-bridge/author-policies`, {
    method: "PUT",
    headers: headers(input),
    body: JSON.stringify({
      bindingId: input.bindingId,
      authorType: input.authorType,
      authorId: input.authorId,
      state: input.state,
    }),
  });
}

test("Slack routes fail closed with no provider runtime and persist no OAuth state", async () => {
  slackBridgeIngressObservationsTotal.reset();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const seeded = await seedControlPlane();
    const token = signAccessToken(seeded.owner.id);
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: partialRuntime });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: signAccessToken(seeded.owner.id),
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
    async enable(authority) {
      record("enable", authority);
      stage = "health";
      return provisioningResponse(stage);
    },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({ provisioning }) });
  try {
    const seeded = await seedControlPlane();
    const token = signAccessToken(seeded.owner.id);
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

    assert.deepEqual(calls, [
      "load",
      "connect",
      "pairs:raft-general:C_ROUTE_GENERAL",
      "remove:raft-general:C_ROUTE_GENERAL:1",
      "preflight",
      "enable",
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
  let authorAuthority: ExternalAuthorPolicyRuntimeAuthority | null = null;
  let authorAuthorityCalls = 0;
  const provisioning: SlackBridgeProvisioningControlPlane = {
    async load() { calls.push("load"); return provisioningResponse("connect"); },
    async connect() { calls.push("connect"); return provisioningResponse("oauth"); },
    async saveChannelPairs() { calls.push("save"); return provisioningResponse("preflight"); },
    async removeChannelPairs() { calls.push("remove"); return provisioningResponse("channels"); },
    async disconnect() { calls.push("disconnect"); return provisioningResponse("connect"); },
    async runPreflight() { calls.push("preflight"); return provisioningResponse("enable"); },
    async enable() { calls.push("enable"); return provisioningResponse("health"); },
  };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      provisioning,
      isLaunchEnabled: async () => false,
      resolveAuthorPolicyAuthority: async ({ bindingId }) => {
        authorAuthorityCalls += 1;
        return authorAuthority?.bindingId === bindingId ? authorAuthority : null;
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = signAccessToken(seeded.owner.id);
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

    const authorSurface = await seedAuthorPolicySurface();
    authorAuthority = {
      provider: "slack",
      registrationId: authorSurface.registration.id,
      installId: authorSurface.install.id,
      bindingId: authorSurface.binding.id,
      bindingEpoch: authorSurface.binding.bindingEpoch,
      consentRevision: 1,
    };
    const grant = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: signAccessToken(authorSurface.owner.id),
      serverId: authorSurface.server.id,
      bindingId: authorSurface.binding.id,
      authorType: "agent",
      authorId: authorSurface.agent.id,
      state: "granted",
    });
    assert.equal(grant.status, 403);
    assert.equal(authorAuthorityCalls, 0);
    const revoke = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: signAccessToken(authorSurface.owner.id),
      serverId: authorSurface.server.id,
      bindingId: authorSurface.binding.id,
      authorType: "agent",
      authorId: authorSurface.agent.id,
      state: "revoked",
    });
    assert.equal(revoke.status, 201);
    assert.equal(authorAuthorityCalls, 1);

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({ provisioning }) });
  try {
    const seeded = await seedControlPlane();
    const requestHeaders = headers({
      token: signAccessToken(seeded.owner.id),
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

test("owner-managed author policy grant, refresh, revoke, and replay stay binding- and revision-scoped", async () => {
  let authority: Awaited<ReturnType<NonNullable<SlackBridgeRouteDependencies["resolveAuthorPolicyAuthority"]>>> = null;
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      resolveAuthorPolicyAuthority: async ({ bindingId }) =>
        authority?.bindingId === bindingId ? authority : null,
    }) });
  try {
    const seeded = await seedAuthorPolicySurface();
    authority = {
      provider: "slack",
      registrationId: seeded.registration.id,
      installId: seeded.install.id,
      bindingId: seeded.binding.id,
      bindingEpoch: seeded.binding.bindingEpoch,
      consentRevision: 7,
    };
    const memberDenied = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: signAccessToken(seeded.member.id),
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "granted",
    });
    assert.equal(memberDenied.status, 403);
    assert.equal((await getDb().select().from(externalAuthorPolicies)).length, 0);

    const ownerToken = signAccessToken(seeded.owner.id);
    const foreignServer = await createServer(
      "Slack Author Foreign",
      `slack-author-foreign-${randomUUID()}`,
      seeded.owner.id,
    );
    const [foreignAgent] = await getDb().insert(agents).values({
      serverId: foreignServer.id,
      name: `slack-foreign-agent-${randomUUID().slice(0, 8)}`,
      displayName: "Slack Foreign Agent",
      status: "active",
    }).returning();
    const foreignDenied = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: foreignAgent.id,
      state: "granted",
    });
    assert.equal(foreignDenied.status, 403);
    assert.equal((await getDb().select().from(externalAuthorPolicies)).length, 0);

    const granted = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "granted",
    });
    assert.equal(granted.status, 201, await granted.text());
    let [policy] = await getDb().select().from(externalAuthorPolicies);
    assert.equal(policy.authorType, "agent");
    assert.equal(policy.authorId, seeded.agent.id);
    assert.equal(policy.displayName, "Slack Agent Before Rename");
    assert.equal(policy.fallbackKind, "agent");
    assert.equal(policy.consentRevision, 7);
    assert.equal(policy.state, "granted");

    const replay = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "granted",
    });
    assert.equal(replay.status, 200);
    assert.equal((await getDb().select().from(externalAuthorPolicies)).length, 1);

    await getDb().update(agents).set({ displayName: "Slack Agent After Rename" })
      .where(eq(agents.id, seeded.agent.id));
    const refreshed = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "granted",
    });
    assert.equal(refreshed.status, 200);
    [policy] = await getDb().select().from(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.authorId, seeded.agent.id));
    assert.equal(policy.displayName, "Slack Agent After Rename");

    const humanGranted = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "user",
      authorId: seeded.member.id,
      state: "granted",
    });
    assert.equal(humanGranted.status, 201);
    const [humanPolicy] = await getDb().select().from(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.authorId, seeded.member.id));
    assert.equal(humanPolicy.authorType, "user");
    assert.equal(humanPolicy.displayName, "Slack Ordinary Member");
    assert.equal(humanPolicy.fallbackKind, "human");
    assert.equal(humanPolicy.consentRevision, 7);
    assert.equal(humanPolicy.state, "granted");

    const revoked = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "revoked",
    });
    assert.equal(revoked.status, 200);
    [policy] = await getDb().select().from(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.authorId, seeded.agent.id));
    assert.equal(policy.state, "revoked");
    assert.equal((await getDb().select().from(externalAuthorPolicies)).length, 2);

    authority = { ...authority, bindingEpoch: authority.bindingEpoch + 1 };
    const staleRuntime = await putAuthorPolicy({
      baseUrl: app.baseUrl,
      token: ownerToken,
      serverId: seeded.server.id,
      bindingId: seeded.binding.id,
      authorType: "agent",
      authorId: seeded.agent.id,
      state: "granted",
    });
    assert.equal(staleRuntime.status, 403);
    [policy] = await getDb().select().from(externalAuthorPolicies)
      .where(eq(externalAuthorPolicies.authorId, seeded.agent.id));
    assert.equal(policy.state, "revoked");
  } finally {
    await app.close();
  }
});

test("OAuth route fixes scopes, uses one-time state, leases managed handles, and redirects to trusted IM Bridges", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const resolvedServerIds: string[] = [];
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      counters,
      async resolveOAuthCompletionRedirectPath({ serverId }) {
        resolvedServerIds.push(serverId);
        return "/s/slack-route/settings/im-bridges";
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = signAccessToken(seeded.owner.id);
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

    const [attempt] = await getDb().select().from(externalOAuthAttempts);
    assert.notEqual(attempt.stateHash, state);
    assert.deepEqual(attempt.requestedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]);

    const callback = await fetch(
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
    assert.deepEqual(install.installedScopes, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]);
    const [identityLink] = await getDb().select().from(externalHumanIdentityLinks);
    assert.equal(identityLink.serverId, seeded.server.id);
    assert.equal(identityLink.installId, install.id);
    assert.equal(identityLink.userId, seeded.owner.id);
    assert.equal(identityLink.providerAuthorityId, "T_ROUTE_TEST");
    assert.equal(identityLink.providerUserId, "U_ROUTE_OWNER");
    assert.equal(identityLink.state, "active");
    assert.equal(identityLink.linkEpoch, 1);
    assert.equal(identityLink.observedConnectionEpoch, 1);

    const replay = await fetch(
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
    const rejected = await fetch(
      `${app.baseUrl}/api/slack-bridge/oauth/callback`
      + `?state=${encodeURIComponent(rejectedState)}`
      + "&error=access_denied&error_description=provider-private-detail",
    );
    const rejectedText = await rejected.text();
    assert.equal(rejected.status, 400);
    assert.deepEqual(JSON.parse(rejectedText), {
      ok: false,
      code: "slack_oauth_provider_rejected",
    });
    assert.equal(rejectedText.includes("access_denied"), false);
    assert.equal(rejectedText.includes("provider-private-detail"), false);
    assert.equal(counters.leases, 1);
    assert.equal(counters.captures, 1);
    assert.equal(counters.exchanges, 1);
  } finally {
    await app.close();
  }
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
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
        counters,
        resolveOAuthCompletionRedirectPath: async () => redirectPath,
      }) });
    try {
      const seeded = await seedControlPlane();
      const start = await beginOAuth({
        baseUrl: app.baseUrl,
        token: signAccessToken(seeded.owner.id),
        serverId: seeded.server.id,
        registrationId: seeded.registration.id,
        serverGrantId: seeded.grant.id,
        grantEpoch: 1,
      });
      const state = new URL(
        (await start.json() as { authorizationUrl: string }).authorizationUrl,
      ).searchParams.get("state");
      assert.ok(state);

      const callback = await fetch(
        `${app.baseUrl}/api/slack-bridge/oauth/callback`
        + `?state=${encodeURIComponent(state)}&code=provider-code`,
        { redirect: "manual" },
      );
      assert.equal(callback.status, 503, `${redirectPath ?? "null"} must fail closed`);
      assert.equal(callback.headers.get("location"), null);
      assert.deepEqual(counters, { leases: 0, captures: 0, exchanges: 0, ingress: 0 });
      const [attempt] = await getDb().select().from(externalOAuthAttempts);
      assert.equal(attempt.status, "exchange_unknown");

      const replay = await fetch(
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      counters,
      resolveOAuthCompletionRedirectPath: async () => {
        throw new Error("redirect lookup unavailable");
      },
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: signAccessToken(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state");
    assert.ok(state);

    const callback = await fetch(
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      counters,
      exchange: async () => ({ kind: "outcome_unknown" }),
    }) });
  try {
    const seeded = await seedControlPlane();
    const start = await beginOAuth({
      baseUrl: app.baseUrl,
      token: signAccessToken(seeded.owner.id),
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
    const callback = await fetch(callbackUrl);
    assert.equal(callback.status, 202);
    assert.equal(callback.headers.has("retry-after"), false);
    assert.deepEqual(await callback.json(), {
      ok: false,
      code: "slack_oauth_reconciliation_required",
    });
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

test("stale state and expired managed lease stop before code capture or provider I/O", async () => {
  const counters = { leases: 0, captures: 0, exchanges: 0, ingress: 0 };
  const now = new Date();
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
      counters,
      now,
      leaseExpiresAt: now,
    }) });
  try {
    const seeded = await seedControlPlane();
    const token = signAccessToken(seeded.owner.id);
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

    const expiredLease = await fetch(
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

    const stale = await fetch(
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
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
      token: signAccessToken(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callback = await fetch(
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
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
      token: signAccessToken(seeded.owner.id),
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
    });
    const state = new URL(
      (await start.json() as { authorizationUrl: string }).authorizationUrl,
    ).searchParams.get("state")!;

    const callback = await fetch(
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({
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
    assert.equal(lifecycleCalls, 1, "durably admitted events trigger lifecycle reconciliation");
    assert.equal(lifecycleErrors.length, 1);
    assert.match(String(lifecycleErrors[0]), /lifecycle-test-failure/);

    const observations = await slackBridgeIngressObservationsTotal.get();
    const count = (stage: string, outcome: string, delivery = "initial") =>
      observations.values.find((sample) =>
        sample.labels.stage === stage
        && sample.labels.outcome === outcome
        && sample.labels.delivery === delivery
      )?.value ?? 0;
    assert.equal(count("arrival", "request"), 3);
    assert.equal(count("arrival", "request", "retry"), 1);
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, slackBridge: runtime({ counters }) });
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
