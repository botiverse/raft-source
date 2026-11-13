import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
// External-agent presence: credential use (any authenticated agent-API call or
// an open wake-hint stream's heartbeat) is persisted as the credential's
// `last_used_at` — throttled per credential — served by `GET /agents` as
// `lastSeenAt` for external agents, and pushed as `agent:seen` on write.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, jointChannels, jointChannelServers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  __setAgentCredentialUseThrottleMsForTests,
  AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS,
  mintAgentCredential,
} from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";
import { addAgent, addHuman } from "../services/channelService";
import { seedJointChannel } from "../test/integration/jointFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

type Emitted = { room: string; event: string; payload: unknown };

function installFakeIo(app: { app: { set: (key: string, value: unknown) => void } }): Emitted[] {
  const emitted: Emitted[] = [];
  app.app.set("io", {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emitted.push({ room, event, payload });
        return true;
      },
    }),
  });
  return emitted;
}

async function seedFixture() {
  const suffix = randomUUID();
  const email = `presence-${suffix}@slock.test`;
  const [owner] = await getDb().insert(users).values({
    email,
    name: `presence-${suffix}`,
    displayName: "Presence Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Presence Test", `presence-${suffix}`, owner!.id);
  const external = await createAgent(server.id, "PresenceExt", { runtime: "external", model: "external" });
  const managed = await createAgent(server.id, "PresenceManaged", { runtime: "codex" });
  const externalCredential = await mintAgentCredential({
    agentId: external.id,
    scopes: ["read"],
    name: "presence-ext",
    issuedVia: "computer",
    createdByUserId: null,
  });
  const managedCredential = await mintAgentCredential({
    agentId: managed.id,
    scopes: ["read"],
    name: "presence-managed",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return {
    ownerId: owner!.id,
    ownerToken: await tokenForHuman(email),
    serverId: server.id,
    externalId: external.id,
    managedId: managed.id,
    external: externalCredential,
    managed: managedCredential,
  };
}

async function lastUsedAt(credentialId: string): Promise<number | null> {
  const [row] = await getDb()
    .select({ lastUsedAt: agentCredentials.lastUsedAt })
    .from(agentCredentials)
    .where(eq(agentCredentials.id, credentialId));
  return row?.lastUsedAt ? row.lastUsedAt.getTime() : null;
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

async function agentApiCall(baseUrl: string, apiKey: string): Promise<void> {
  const res = await fetch(`${baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
}

async function listAgents(baseUrl: string, token: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/agents`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId },
  });
  assert.equal(res.status, 200);
  return await res.json() as Array<{ id: string; lastSeenAt?: string | null }>;
}

test("credential-use writes are throttled per credential and resume after the window", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(null);
  try {
    assert.equal(AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS, 60_000);
    const f = await seedFixture();
    const emitted = installFakeIo(app);

    await agentApiCall(app.baseUrl, f.external.apiKey);
    const first = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
    assert.notEqual(first, null, "first request writes last_used_at");

    // Second request inside the 30 s window: no second write.
    await agentApiCall(app.baseUrl, f.external.apiKey);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await lastUsedAt(f.external.credentialId), first, "second request within the window must not write");
    assert.equal(emitted.filter((e) => e.event === "agent:seen").length, 1, "one write → one agent:seen push");

    // Shrink the window to 2 s so "after the window" is observable in a
    // test: one write, a request inside the window skips, the first request
    // after the window writes again.
    __setAgentCredentialUseThrottleMsForTests(2000);
    await agentApiCall(app.baseUrl, f.external.apiKey);
    const second = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null && v > first!);
    assert.ok(second !== null && second > first!);
    await agentApiCall(app.baseUrl, f.external.apiKey);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await lastUsedAt(f.external.credentialId), second, "request inside the window must not write");
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, second! + 2100 - Date.now())));
    await agentApiCall(app.baseUrl, f.external.apiKey);
    const third = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null && v > second!);
    assert.ok(third !== null && third > second!, "first request after the window writes again");
  } finally {
    __setAgentCredentialUseThrottleMsForTests(null);
  }
});

test("agent:seen is pushed to the server room for external agents only", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(null);
  const f = await seedFixture();
  const emitted = installFakeIo(app);

  await agentApiCall(app.baseUrl, f.managed.apiKey);
  await waitFor(() => lastUsedAt(f.managed.credentialId), (v) => v !== null);
  await agentApiCall(app.baseUrl, f.external.apiKey);
  const written = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
  await waitFor(async () => emitted.length, (n) => n > 0);

  const seen = emitted.filter((e) => e.event === "agent:seen");
  assert.equal(seen.length, 1, `expected one agent:seen push, got ${JSON.stringify(emitted)}`);
  assert.equal(seen[0]!.room, `server:${f.serverId}`);
  assert.deepEqual(seen[0]!.payload, { agentId: f.externalId, lastSeenAt: new Date(written!).toISOString() });
});

test("GET /agents serves lastSeenAt for external agents and omits it for managed agents", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(null);
  const f = await seedFixture();
  installFakeIo(app);

  const before = await listAgents(app.baseUrl, f.ownerToken, f.serverId);
  assert.equal(before.find((a) => a.id === f.externalId)?.lastSeenAt, null, "never-seen external agent → null");
  assert.equal("lastSeenAt" in before.find((a) => a.id === f.managedId)!, false, "managed agents carry no lastSeenAt");

  await agentApiCall(app.baseUrl, f.external.apiKey);
  await agentApiCall(app.baseUrl, f.managed.apiKey);
  const written = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
  await waitFor(() => lastUsedAt(f.managed.credentialId), (v) => v !== null);

  const after = await listAgents(app.baseUrl, f.ownerToken, f.serverId);
  assert.equal(after.find((a) => a.id === f.externalId)?.lastSeenAt, new Date(written!).toISOString());
  assert.equal("lastSeenAt" in after.find((a) => a.id === f.managedId)!, false);
});

test("an open wake-hint stream keeps the external agent seen on heartbeat ticks", async ({ app }) => {
  process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS = "300";
  __setAgentCredentialUseThrottleMsForTests(100);
  const controller = new AbortController();
  try {
    const f = await seedFixture();
    app.app.set("agentOrchestrator", new AgentOrchestrator());
    const emitted = installFakeIo(app);

    const res = await fetch(`${app.baseUrl}/internal/agent-api/wake-hints/stream`, {
      headers: { Authorization: `Bearer ${f.external.apiKey}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const opened = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
    assert.notEqual(opened, null, "stream open counts as seen");

    // No further requests: only heartbeat ticks can advance last_used_at.
    const refreshed = await waitFor(
      () => lastUsedAt(f.external.credentialId),
      (v) => v !== null && v > opened!,
      3000,
    );
    assert.ok(refreshed !== null && refreshed > opened!, "heartbeat tick refreshes last_used_at");
    assert.ok(emitted.filter((e) => e.event === "agent:seen").length >= 2, "heartbeat writes are pushed too");
  } finally {
    controller.abort();
    delete process.env.SLOCK_WAKE_STREAM_HEARTBEAT_MS;
    __setAgentCredentialUseThrottleMsForTests(null);
  }
});

// Joint channels: people on another server see the external agent's presence.
async function seedJointPresenceFixture() {
  const f = await seedFixture();
  const peer = await createServer("Presence Peer", `presence-peer-${randomUUID()}`, f.ownerId);
  const seedJoint = async (name: string) => {
    const joint = await seedJointChannel({ name, serverIds: [peer.id, f.serverId], createdByUserId: f.ownerId });
    const [peerProjection, homeProjection] = joint.projections;
    await addHuman(peerProjection!.id, f.ownerId);
    await addAgent(homeProjection!.id, f.externalId);
    await addAgent(homeProjection!.id, f.managedId);
    return { jointChannelId: joint.jointChannelId, peerChannelId: peerProjection!.id };
  };
  const active = await seedJoint(`presence-active-${randomUUID().slice(0, 8)}`);
  const disconnected = await seedJoint(`presence-disc-${randomUUID().slice(0, 8)}`);
  await getDb().update(jointChannelServers).set({ status: "disconnected", disconnectedAt: new Date() })
    .where(and(eq(jointChannelServers.jointChannelId, disconnected.jointChannelId), eq(jointChannelServers.serverId, peer.id)));
  const closed = await seedJoint(`presence-closed-${randomUUID().slice(0, 8)}`);
  await getDb().update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, closed.jointChannelId));
  return { ...f, peerServerId: peer.id, active, disconnected, closed };
}

test("agent:seen also reaches active joint channels' other-server projection rooms", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(null);
  const f = await seedJointPresenceFixture();
  const emitted = installFakeIo(app);

  await agentApiCall(app.baseUrl, f.external.apiKey);
  const written = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
  await waitFor(async () => emitted.filter((e) => e.event === "agent:seen").length, (n) => n >= 2);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const payload = { agentId: f.externalId, lastSeenAt: new Date(written!).toISOString() };
  const seen = emitted.filter((e) => e.event === "agent:seen");
  assert.deepEqual(
    seen.map((e) => e.room).sort(),
    [`channel:${f.active.peerChannelId}`, `server:${f.serverId}`].sort(),
    `home server room + the active peer projection only, got ${JSON.stringify(seen)}`,
  );
  for (const e of seen) assert.deepEqual(e.payload, payload, "only agentId and lastSeenAt");
});

test("a joint channel roster serves lastSeenAt for another server's external agent", async ({ app }) => {
  __setAgentCredentialUseThrottleMsForTests(null);
  const f = await seedJointPresenceFixture();
  installFakeIo(app);
  const roster = async () => {
    const res = await fetch(`${app.baseUrl}/api/channels/${f.active.peerChannelId}/members`, {
      headers: { Authorization: `Bearer ${f.ownerToken}`, "X-Server-Id": f.peerServerId },
    });
    assert.equal(res.status, 200);
    return (await res.json() as { agents: Array<{ id: string; external?: boolean; lastSeenAt?: string | null }> }).agents;
  };

  const before = await roster();
  const externalBefore = before.find((a) => a.id === f.externalId);
  assert.equal(externalBefore?.external, true);
  assert.equal(externalBefore?.lastSeenAt, null, "never-seen external agent → null");
  const managed = before.find((a) => a.id === f.managedId)!;
  assert.ok(managed, "the managed agent is listed");
  assert.equal("lastSeenAt" in managed, false, "managed agents carry no lastSeenAt");
  assert.equal("external" in managed, false);

  await agentApiCall(app.baseUrl, f.external.apiKey);
  const written = await waitFor(() => lastUsedAt(f.external.credentialId), (v) => v !== null);
  const after = await roster();
  assert.equal(after.find((a) => a.id === f.externalId)?.lastSeenAt, new Date(written!).toISOString());
});
