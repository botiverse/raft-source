import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION,
  slackBridgeChannelPairRemovalsRequestSchema,
  slackBridgeDisconnectRequestSchema,
} from "@botiverse/raft-shared";
import type {
  SlackBridgeProvisioningResponse,
  SlackBridgeSetupStage,
} from "@botiverse/raft-shared";
import { applyManagedSlackBridgeChannelPairs } from "../src/components/settings/slackBridgeProvisioning";
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
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const client: SlackBridgeProvisioningHttpClient = {
    async get(url) {
      calls.push({ method: "GET", url });
      return { data: response("connect") };
    },
    async post(url, body) {
      calls.push({ method: "POST", url, body });
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
      if (url.endsWith("/enable")) return { data: response("health") };
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
    { method: "GET", url: "/slack-bridge/provisioning" },
    { method: "POST", url: "/slack-bridge/provisioning/connect", body: undefined },
    {
      method: "POST",
      url: "/slack-bridge/oauth/start",
      body: {
        registrationId: "11111111-1111-4111-8111-111111111111",
        serverGrantId: "22222222-2222-4222-8222-222222222222",
        grantEpoch: 7,
      },
    },
    {
      method: "PUT",
      url: "/slack-bridge/provisioning/channel-pairs",
      body: { pairs: [{ raftChannelId: "raft-general", slackChannelId: "C_GENERAL" }] },
    },
    { method: "POST", url: "/slack-bridge/provisioning/preflight", body: undefined },
    { method: "POST", url: "/slack-bridge/provisioning/enable", body: undefined },
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
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: baseline }; },
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

test("production adapter fails closed on an incomplete OAuth authority response", async () => {
  let oauthStarts = 0;
  const invalid = { ...response("oauth"), oauthAuthority: null };
  const client: SlackBridgeProvisioningHttpClient = {
    async get() { return { data: invalid }; },
    async post() {
      oauthStarts += 1;
      return { data: invalid };
    },
    async put() { return { data: invalid }; },
  };
  const provider = createSlackBridgeProvisioningProvider(client);

  await assert.rejects(provider.load(), /OAuth stage requires current server-grant authority/);
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
      bindings: [{ id: "binding-one", state: "active", bindingEpoch: 1 }],
      audiences: [{ bindingId: "binding-orphan", status: "matched" }],
      lastVerifiedAt: null,
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
