import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  slackBridgeChannelPairRemovalsRequestSchema,
  slackBridgeDisconnectRequestSchema,
} from "@botiverse/raft-shared";
import type {
  SlackBridgeProvisioningResponse,
  SlackBridgeSetupStage,
} from "@botiverse/raft-shared";
import { applyManagedSlackBridgeChannelPairs, verifyAndEnableSlackBridge } from "../src/components/settings/slackBridgeProvisioning";
import { createSlackBridgeProvisioningProvider } from "../src/components/settings/slackBridgeProvisioningApi";
import type { SlackBridgeProvisioningHttpClient } from "../src/components/settings/slackBridgeProvisioningApi";

function response(stage: SlackBridgeSetupStage): SlackBridgeProvisioningResponse {
  return {
    protocolVersion: SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
    snapshot: {
      stage,
      workspaceName: stage === "connect" ? null : "Acme Slack",
      raftChannels: [{ id: "raft-general", name: "general" }],
      slackChannels: [{ id: "C_GENERAL", name: "general" }],
      channelPairs: stage === "connect" || stage === "oauth"
        ? []
        : [{ raftChannelId: "raft-general", slackChannelId: "C_GENERAL" }],
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
        registrationId: "11111111-1111-4111-8111-111111111111",
        serverGrantId: "22222222-2222-4222-8222-222222222222",
        grantEpoch: 7,
      }
      : null,
  };
}

test("production adapter drives the typed provisioning paths and returns current OAuth authority", async () => {
  const calls: Array<{ method: string; url: string; body?: unknown; withCredentials?: boolean }> = [];
  let enabled = false;
  const client: SlackBridgeProvisioningHttpClient = {
    async get(url) {
      calls.push({ method: "GET", url });
      return { data: response(enabled ? "health" : "connect") };
    },
    async post(url, body, config) {
      calls.push({ method: "POST", url, body, ...(config ? { withCredentials: config.withCredentials } : {}) });
      if (url.endsWith("/connect")) return { data: response("oauth") };
      if (url.endsWith("/oauth/start")) {
        return {
          data: {
            authorizationUrl: "https://slack.com/oauth/v2/authorize?state=opaque",
            expiresAt: "2032-01-02T03:04:05.000Z",
          },
        };
      }
      if (url.endsWith("/preflight")) return { data: response("enable") };
      if (url.endsWith("/enable")) {
        enabled = true;
        return { data: response("health") };
      }
      if (url.endsWith("/disconnect")) {
        slackBridgeDisconnectRequestSchema.parse(body);
        return { data: response("connect") };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async put(url, body) {
      calls.push({ method: "PUT", url, body });
      return { data: response("preflight") };
    },
  };
  const provider = createSlackBridgeProvisioningProvider(client);

  assert.equal((await provider.load()).snapshot.stage, "connect");
  assert.equal((await provider.connect()).snapshot.stage, "oauth");
  assert.deepEqual(await provider.beginOAuth(), {
    kind: "redirect",
    url: "https://slack.com/oauth/v2/authorize?state=opaque",
  });
  assert.equal((await provider.saveChannelPairs([
    { raftChannelId: "raft-general", slackChannelId: "C_GENERAL" },
  ])).snapshot.stage, "preflight");
  assert.equal((await provider.runPreflight()).snapshot.stage, "enable");
  assert.equal((await provider.enable()).snapshot.stage, "health");
  assert.equal((await provider.disconnect!(7)).snapshot.stage, "connect");

  assert.deepEqual(calls, [
    { method: "GET", url: "/slack-bridge/provisioning?deliveryHealth=1&pairDeliveryHealth=1&workspaceAdminHint=1&confirmationHint=1&privateAuthorizerHint=1&attachmentSourceHealth=1&inboundRecovery=1&cardEditNotices=1" },
    { method: "POST", url: "/slack-bridge/provisioning/connect", body: undefined },
    {
      method: "POST",
      url: "/slack-bridge/oauth/start",
      body: {
        registrationId: "11111111-1111-4111-8111-111111111111",
        serverGrantId: "22222222-2222-4222-8222-222222222222",
        grantEpoch: 7,
      },
      // The start response's browser-binding cookie must be stored.
      withCredentials: true,
    },
    {
      method: "PUT",
      url: "/slack-bridge/provisioning/channel-pairs",
      body: { pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_GENERAL" }] },
    },
    { method: "POST", url: "/slack-bridge/provisioning/preflight", body: undefined },
    { method: "POST", url: "/slack-bridge/provisioning/enable", body: undefined },
    { method: "GET", url: "/slack-bridge/provisioning?deliveryHealth=1&pairDeliveryHealth=1&workspaceAdminHint=1&confirmationHint=1&privateAuthorizerHint=1&attachmentSourceHealth=1&inboundRecovery=1&cardEditNotices=1" },
    {
      method: "POST",
      url: "/slack-bridge/provisioning/disconnect",
      body: { expectedConnectionEpoch: 7 },
    },
  ]);
});

test("managed pure removal crosses the production adapter with only the strict exact-epoch payload", async () => {
  const baseline = response("health");
  baseline.snapshot.channelPairs = [{
    raftChannelId: "raft-general",
    slackChannelId: "C_GENERAL",
    bindingEpoch: 7,
  }];
  const removed = response("health");
  removed.snapshot.channelPairs = [];
  let deleteBody: unknown;
  let puts = 0;
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: baseline }; },
    async post() { throw new Error("pure removal must not POST"); },
    async put() {
      puts += 1;
      throw new Error("pure removal must not PUT");
    },
    async delete(_url, options) {
      deleteBody = options?.data;
      slackBridgeChannelPairRemovalsRequestSchema.parse(deleteBody);
      return { data: removed };
    },
  };

  const view = await applyManagedSlackBridgeChannelPairs({
    provider: createSlackBridgeProvisioningProvider(client),
    baseline: baseline.snapshot,
    desiredPairs: [],
  });

  assert.deepEqual(deleteBody, {
    pairs: [{
      raftChannelId: "raft-general",
      slackChannelId: "C_GENERAL",
      expectedBindingEpoch: 7,
    }],
  });
  assert.equal(puts, 0);
  assert.deepEqual(view.snapshot.channelPairs, []);
});

test("managed replacement crosses strict DELETE before PUT, preflight, and enable", async () => {
  const baseline = response("health");
  baseline.snapshot.slackChannels.push({ id: "C_REPLACEMENT", name: "replacement" });
  baseline.snapshot.channelPairs = [{
    raftChannelId: "raft-general",
    slackChannelId: "C_GENERAL",
    bindingEpoch: 11,
  }];
  const removed = response("health");
  removed.snapshot.slackChannels.push({ id: "C_REPLACEMENT", name: "replacement" });
  removed.snapshot.channelPairs = [];
  const saved = response("preflight");
  saved.snapshot.slackChannels.push({ id: "C_REPLACEMENT", name: "replacement" });
  saved.snapshot.channelPairs = [{ raftChannelId: "raft-general", slackChannelId: "C_REPLACEMENT" }];
  const preflight = response("enable");
  preflight.snapshot.slackChannels.push({ id: "C_REPLACEMENT", name: "replacement" });
  preflight.snapshot.channelPairs = saved.snapshot.channelPairs;
  const enabled = response("health");
  enabled.snapshot.slackChannels.push({ id: "C_REPLACEMENT", name: "replacement" });
  enabled.snapshot.channelPairs = [{
    raftChannelId: "raft-general",
    slackChannelId: "C_REPLACEMENT",
    bindingEpoch: 12,
  }];
  const calls: Array<{ method: string; body?: unknown }> = [];
  let didEnable = false;
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: didEnable ? enabled : baseline }; },
    async delete(_url, options) {
      calls.push({ method: "DELETE", body: options?.data });
      slackBridgeChannelPairRemovalsRequestSchema.parse(options?.data);
      return { data: removed };
    },
    async put(_url, body) {
      calls.push({ method: "PUT", body });
      return { data: saved };
    },
    async post(url) {
      if (url.endsWith("/preflight")) {
        calls.push({ method: "PREFLIGHT" });
        return { data: preflight };
      }
      if (url.endsWith("/enable")) {
        calls.push({ method: "ENABLE" });
        didEnable = true;
        return { data: enabled };
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const view = await applyManagedSlackBridgeChannelPairs({
    provider: createSlackBridgeProvisioningProvider(client),
    baseline: baseline.snapshot,
    desiredPairs: [{ raftChannelId: "raft-general", slackChannelId: "C_REPLACEMENT" }],
  });

  assert.deepEqual(calls, [
    {
      method: "DELETE",
      body: {
        pairs: [{
          raftChannelId: "raft-general",
          slackChannelId: "C_GENERAL",
          expectedBindingEpoch: 11,
        }],
      },
    },
    {
      method: "PUT",
      body: { pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_REPLACEMENT" }] },
    },
    { method: "PREFLIGHT" },
    { method: "ENABLE" },
  ]);
  assert.deepEqual(view.snapshot.channelPairs, enabled.snapshot.channelPairs);
});

test("production adapter shows a read-only OAuth stage without authority and never starts OAuth", async () => {
  let oauthStarts = 0;
  const readOnly = { ...response("oauth"), oauthAuthority: null };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: readOnly }; },
    async post() {
      oauthStarts += 1;
      return { data: readOnly };
    },
    async put() { return { data: readOnly }; },
  };
  const provider = createSlackBridgeProvisioningProvider(client);

  assert.equal((await provider.load()).snapshot.stage, "oauth");
  assert.equal((await provider.beginOAuth()).kind, "view");
  assert.equal((await provider.beginReauthorization!()).kind, "view");
  assert.equal(oauthStarts, 0);
});

test("production adapter rejects non-UUID OAuth authority before calling the OAuth endpoint", async () => {
  let oauthStarts = 0;
  const invalid = {
    ...response("oauth"),
    oauthAuthority: {
      registrationId: `registration-${randomUUID()}`,
      serverGrantId: randomUUID(),
      grantEpoch: 7,
    },
  };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: invalid }; },
    async post() {
      oauthStarts += 1;
      return { data: invalid };
    },
    async put() { return { data: invalid }; },
  };

  await assert.rejects(createSlackBridgeProvisioningProvider(client).load());
  assert.equal(oauthStarts, 0);
});

test("production adapter rejects malformed health and never upgrades it to connected", async () => {
  const malformed = response("health") as unknown as Record<string, unknown>;
  malformed.snapshot = {
    ...(malformed.snapshot as Record<string, unknown>),
    rawHealth: {
      install: { state: "active", epochs: { grant: "g", connection: "c", scope: "s", credential: "k" } },
      credential: { state: "active" },
      bindings: [{ id: "binding", state: "mystery" }],
      audiences: [],
      lastVerifiedAt: "2032-01-02T03:04:05.000Z",
      agentMentionSync: null,
      failingSurface: null,
    },
  };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: malformed }; },
    async post() { return { data: malformed }; },
    async put() { return { data: malformed }; },
  };

  await assert.rejects(createSlackBridgeProvisioningProvider(client).load());
});

test("production adapter rejects a passed aggregate without the closed passed preflight set", async () => {
  const malformed = response("enable") as unknown as Record<string, unknown>;
  malformed.snapshot = {
    ...(malformed.snapshot as Record<string, unknown>),
    preflight: {
      state: "passed",
      checks: [
        { id: "oauth", state: "passed" },
        { id: "endpoint", state: "passed" },
        { id: "scope", state: "failed" },
      ],
    },
  };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: malformed }; },
    async post() { return { data: malformed }; },
    async put() { return { data: malformed }; },
  };

  await assert.rejects(createSlackBridgeProvisioningProvider(client).load(), /closed passed check set/);
});

test("production adapter rejects channel pairs outside the returned option authority", async () => {
  const malformed = response("channels") as unknown as Record<string, unknown>;
  malformed.snapshot = {
    ...(malformed.snapshot as Record<string, unknown>),
    channelPairs: [{ raftChannelId: "raft-unknown", slackChannelId: "C_GENERAL" }],
  };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: malformed }; },
    async post() { return { data: malformed }; },
    async put() { return { data: malformed }; },
  };

  await assert.rejects(createSlackBridgeProvisioningProvider(client).load(), /returned Raft channel/);
});

test("production adapter rejects duplicate or orphan health authority", async () => {
  const malformed = response("health") as unknown as Record<string, unknown>;
  malformed.snapshot = {
    ...(malformed.snapshot as Record<string, unknown>),
    rawHealth: {
      install: null,
      credential: null,
      bindings: [{
        id: "binding-one",
        state: "active",
        bindingEpoch: 1,
        stateReason: null,
        recoveryAction: "none",
      }],
      audiences: [{ bindingId: "binding-orphan", status: "matched" }],
      lastVerifiedAt: null,
      agentMentionSync: null,
      failingSurface: "audience",
    },
  };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: malformed }; },
    async post() { return { data: malformed }; },
    async put() { return { data: malformed }; },
  };

  await assert.rejects(createSlackBridgeProvisioningProvider(client).load(), /returned binding/);
});

test("re-authorization starts OAuth from a connected snapshot and never from setup stages", async () => {
  const authority = {
    registrationId: "11111111-1111-4111-8111-111111111111",
    serverGrantId: "22222222-2222-4222-8222-222222222222",
    grantEpoch: 7,
  };
  let current: SlackBridgeProvisioningResponse = { ...response("health"), oauthAuthority: authority };
  const posts: Array<{ url: string; body?: unknown; withCredentials?: boolean }> = [];
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: current }; },
    async post(url, body, config) {
      posts.push({ url, body, ...(config ? { withCredentials: config.withCredentials } : {}) });
      return {
        data: {
          authorizationUrl: "https://slack.com/oauth/v2/authorize?state=reauth",
          expiresAt: "2032-01-02T03:04:05.000Z",
        },
      };
    },
    async put() { return { data: current }; },
  };
  const provider = createSlackBridgeProvisioningProvider(client);

  assert.deepEqual(await provider.beginReauthorization!(), {
    kind: "redirect",
    url: "https://slack.com/oauth/v2/authorize?state=reauth",
  });
  assert.deepEqual(posts, [{ url: "/slack-bridge/oauth/start", body: authority, withCredentials: true }]);

  current = response("connect");
  const view = await provider.beginReauthorization!();
  assert.equal(view.kind, "view");
  assert.equal(posts.length, 1, "a disconnected workspace must use Connect, not re-authorization");
});


test("delivery recovery sends the page's observed attempt version with its duplicate disclosure", async () => {
  let sent: unknown;
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: response("health") }; },
    async put() { throw new Error("unexpected put"); },
    async post(url, body) {
      assert.equal(url, "/slack-bridge/provisioning/retry-delivery");
      sent = body;
      return { data: response("health") };
    },
  };
  const provider = createSlackBridgeProvisioningProvider(client);
  await provider.retryDelivery!({ bindingId: "binding-1", bindingEpoch: 3, deliveryId: "delivery-1", providerAttempts: 4 });
  assert.deepEqual(sent, { bindingId: "binding-1", bindingEpoch: 3, deliveryId: "delivery-1",
    expectedProviderAttempts: 4, duplicateRiskAcknowledged: true });
});


test("verification re-reads opted-in delivery health before returning its successful view", async () => {
  const stalled = response("health");
  stalled.snapshot.rawHealth.bindings = [{
    id: "binding-1", state: "active", bindingEpoch: 7,
    stateReason: null, recoveryAction: "none",
  }];
  stalled.snapshot.channelPairs[0]!.bindingEpoch = 7;
  stalled.snapshot.rawHealth.outboundDeliveries = [{
    bindingId: "binding-1", bindingEpoch: 7, raftChannelId: "raft-general",
    deliveryId: "delivery-1", providerAttempts: 1, state: "dead", retryRequested: false,
  }];
  stalled.snapshot.rawHealth.failingSurface = "delivery";
  const calls: string[] = [];
  const provider = createSlackBridgeProvisioningProvider({
    async get(url) {
      calls.push(url);
      return { data: stalled };
    },
    async post(url) {
      calls.push(url);
      return { data: response(url.endsWith("/preflight") ? "enable" : "health") };
    },
    async put() { throw new Error("unexpected put"); },
  });
  const view = await verifyAndEnableSlackBridge(provider);
  assert.deepEqual(view.snapshot.rawHealth.outboundDeliveries, stalled.snapshot.rawHealth.outboundDeliveries);
  assert.equal(view.snapshot.rawHealth.failingSurface, "delivery");
  assert.deepEqual(calls, [
    "/slack-bridge/provisioning/preflight",
    "/slack-bridge/provisioning/enable",
    "/slack-bridge/provisioning?deliveryHealth=1&pairDeliveryHealth=1&workspaceAdminHint=1&confirmationHint=1&privateAuthorizerHint=1&attachmentSourceHealth=1&inboundRecovery=1&cardEditNotices=1",
  ]);
});

test("inbound recovery requests negotiated health and replays only the selected event", async () => {
  let read = ""; let sent: unknown;
  const client: SlackBridgeProvisioningHttpClient = {
    async get(url) { read = url; return { data: response("health") }; },
    async put() { throw new Error("unexpected put"); },
    async post(url, body) {
      assert.equal(url, "/slack-bridge/provisioning/replay-inbound");
      sent = body; return { data: response("health") };
    },
  };
  const provider = createSlackBridgeProvisioningProvider(client);
  await provider.load(); assert.match(read, /(?:\?|&)inboundRecovery=1(?:&|$)/);
  await provider.replayInbound!({ bindingId: "binding-1", bindingEpoch: 3, eventId: "event-1" });
  assert.deepEqual(sent, { bindingId: "binding-1", bindingEpoch: 3, eventId: "event-1" });
  await provider.replayInbound!({ bindingId: "binding-1", bindingEpoch: 3, reason: "bot_identity_pending" });
  assert.deepEqual(sent, { bindingId: "binding-1", bindingEpoch: 3, reason: "bot_identity_pending" });
});

test("production adapter accepts a connected workflow without a health snapshot", async () => {
  const value = response("connect");
  value.snapshot.rawHealth = null;
  const provider = createSlackBridgeProvisioningProvider({ async get() { return { data: value }; },
    async post() { throw new Error("unexpected post"); }, async put() { throw new Error("unexpected put"); } });
  assert.equal((await provider.load()).snapshot.rawHealth, null);
});
