import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { and, eq } from "drizzle-orm";
import express from "express";
import { asServerId } from "@botiverse/raft-shared";

import { channelAgents, channelHumans, serverAgentMembers, serverMembers, users } from "../db/schema.js";
import { getDb } from "../db/index.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { addAgent, addHuman, createChannel } from "../services/channelService.js";
import { registerMachine } from "../services/machineService.js";
import { createServer } from "../services/serverService.js";
import { channelRouter } from "./channels.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function isHumanInChannel(channelId: string, userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ channelId: channelHumans.channelId })
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channelId), eq(channelHumans.userId, userId)));
  return !!row;
}

async function isAgentInChannel(channelId: string, agentId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId)));
  return !!row;
}

test("human public-channel self-join reads joinPublicChannels from the caller's server role", async ({ app }) => {

  let routeServer: HttpServer | undefined;
  try {
    const owner = await seedUser("join-capability-owner");
    const outsider = await seedUser("join-capability-outsider");
    const server = await createServer("Join Capability", "join-capability", owner.id);
    const channel = await createChannel(server.id, "join-capability-public");

    // Mount the production router behind a minimal actor adapter so this test
    // isolates the route's own capability decision from requireServer. The
    // caller intentionally has no server role, which is the current runtime
    // representative for any future role whose capability is false.
    const routeApp = express();
    routeApp.use((req, _res, next) => {
      req.userId = outsider.id;
      req.serverId = asServerId(server.id);
      next();
    });
    routeApp.use("/api/channels", channelRouter);
    routeServer = routeApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      routeServer!.once("listening", resolve);
      routeServer!.once("error", reject);
    });
    const { port } = routeServer.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/channels/${channel.id}/join`, {
      method: "POST",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Server role cannot join public channels" });
    assert.equal(await isHumanInChannel(channel.id, outsider.id), false);
  } finally {
    if (routeServer) {
      await new Promise<void>((resolve, reject) => routeServer!.close((error) => error ? reject(error) : resolve()));
    }
    await app.close();
  }
});

test("agent credential public-channel self-join requires joinPublicChannels", async ({ app }) => {
  const owner = await seedUser("join-capability-agent-owner");
  const server = await createServer("Agent Join Capability", "agent-join-capability", owner.id);
  const agent = await createAgent(server.id, "join-capability-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "agent-join-capability-public");
  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["channels"],
    name: "join-capability-test",
    createdByUserId: owner.id,
  });
  await getDb().delete(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));

  const response = await fetch(`${app.baseUrl}/internal/agent-api/channels/${channel.id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Server role cannot join public channels" });
  assert.equal(await isAgentInChannel(channel.id, agent.id), false);
});

test("legacy machine-on-behalf public-channel self-join requires joinPublicChannels", async ({ app }) => {
  const owner = await seedUser("join-capability-legacy-owner");
  const server = await createServer("Legacy Join Capability", "legacy-join-capability", owner.id);
  const agent = await createAgent(server.id, "join-capability-legacy-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "legacy-join-capability-public");
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "join-capability-machine");
  await assignMachine(agent.id, machine.id);
  await getDb().delete(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));

  const response = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Server role cannot join public channels" });
  assert.equal(await isAgentInChannel(channel.id, agent.id), false);
});

test("human already-member self-join is an idempotent success before capability denial", async ({ app }) => {

  let routeServer: HttpServer | undefined;
  try {
    const owner = await seedUser("join-capability-idempotent-human-owner");
    const member = await seedUser("join-capability-idempotent-human-member");
    const server = await createServer("Idempotent Human Join", "idempotent-human-join", owner.id);
    const channel = await createChannel(server.id, "idempotent-human-join-public");
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    await addHuman(channel.id, member.id);
    await getDb().delete(serverMembers).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, member.id),
    ));

    const routeApp = express();
    routeApp.use((req, _res, next) => {
      req.userId = member.id;
      req.serverId = asServerId(server.id);
      next();
    });
    routeApp.use("/api/channels", channelRouter);
    routeServer = routeApp.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      routeServer!.once("listening", resolve);
      routeServer!.once("error", reject);
    });
    const { port } = routeServer.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/channels/${channel.id}/join`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(await isHumanInChannel(channel.id, member.id), true);
  } finally {
    if (routeServer) {
      await new Promise<void>((resolve, reject) => routeServer!.close((error) => error ? reject(error) : resolve()));
    }
    await app.close();
  }
});

test("agent credential already-member self-join is an idempotent success before capability denial", async ({ app }) => {
  const owner = await seedUser("join-capability-idempotent-agent-owner");
  const server = await createServer("Idempotent Agent Join", "idempotent-agent-join", owner.id);
  const agent = await createAgent(server.id, "idempotent-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "idempotent-agent-join-public");
  await addAgent(channel.id, agent.id);
  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["channels"],
    name: "idempotent-agent-join-test",
    createdByUserId: owner.id,
  });
  await getDb().delete(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));

  const response = await fetch(`${app.baseUrl}/internal/agent-api/channels/${channel.id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.apiKey}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await isAgentInChannel(channel.id, agent.id), true);
});

test("legacy machine already-member self-join is an idempotent success before capability denial", async ({ app }) => {
  const owner = await seedUser("join-capability-idempotent-legacy-owner");
  const server = await createServer("Idempotent Legacy Join", "idempotent-legacy-join", owner.id);
  const agent = await createAgent(server.id, "idempotent-legacy-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "idempotent-legacy-join-public");
  await addAgent(channel.id, agent.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "idempotent-legacy-machine");
  await assignMachine(agent.id, machine.id);
  await getDb().delete(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, server.id),
    eq(serverAgentMembers.agentId, agent.id),
  ));

  const response = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/channels/${channel.id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(await isAgentInChannel(channel.id, agent.id), true);
});
