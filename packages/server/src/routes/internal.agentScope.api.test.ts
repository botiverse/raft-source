import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function createOwner(label: string) {
  const [owner] = await getDb().insert(users).values({
    email: `scope-owner-${label}-${randomUUID()}@slock.test`,
    name: `scope-owner-${label}-${randomUUID()}`,
    displayName: `Scope Owner ${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return owner;
}

function machineHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

test("agent scope middleware checks machine ownership before scope grants", async ({ app }) => {
  const ownerA = await createOwner("a");
  const serverA = await createServer("Scope Server A", `scope-server-a-${randomUUID()}`, ownerA.id);
  const agentA = await createAgent(serverA.id, "ScopeAgentA", { runtime: "claude", model: "sonnet" });
  const channelA = await createChannel(serverA.id, "scope-room-a");
  await addHuman(channelA.id, ownerA.id);
  await addAgent(channelA.id, agentA.id);
  const { machine: machineA, apiKey: apiKeyA } = await registerMachine(serverA.id, ownerA.id, "scope-daemon-a");
  await placeAgentOnMachine(agentA.id, machineA.id);

  const ownerB = await createOwner("b");
  const serverB = await createServer("Scope Server B", `scope-server-b-${randomUUID()}`, ownerB.id);
  const agentB = await createAgent(serverB.id, "ScopeAgentB", { runtime: "claude", model: "sonnet" });
  const channelB = await createChannel(serverB.id, "scope-room-b");
  await addHuman(channelB.id, ownerB.id);
  await addAgent(channelB.id, agentB.id);

  const body = JSON.stringify({ target: `#${channelA.name}`, content: "probe" });
  const crossServerRes = await fetch(`${app.baseUrl}/internal/agent/${agentB.id}/send`, {
    method: "POST",
    headers: machineHeaders(apiKeyA),
    body,
  });
  const missingRes = await fetch(`${app.baseUrl}/internal/agent/${randomUUID()}/send`, {
    method: "POST",
    headers: machineHeaders(apiKeyA),
    body,
  });

  assert.equal(crossServerRes.status, 404);
  assert.equal(missingRes.status, 404);
  assert.deepEqual(await crossServerRes.json(), { error: "Agent not found" });
  assert.deepEqual(await missingRes.json(), { error: "Agent not found" });
});

// An agent with no Computer (cloud agent, App Bot, assistant, unplaced) can't be
// acted for over a machine key: the scope middleware (send) and the route-level
// ownership check (profile) both require the agent to be on the calling machine.
test("a machine key can't act for a same-server agent that has no Computer", async ({ app }) => {
  const owner = await createOwner("nomachine");
  const server = await createServer("Scope No Machine", `scope-no-machine-${randomUUID()}`, owner.id);
  const placed = await createAgent(server.id, "ScopePlaced", { runtime: "claude", model: "sonnet" });
  const unplaced = await createAgent(server.id, "ScopeUnplaced", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `scope-room-nm-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, unplaced.id);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "scope-daemon-nm");
  await placeAgentOnMachine(placed.id, machine.id);

  const sendRes = await fetch(`${app.baseUrl}/internal/agent/${unplaced.id}/send`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ target: `#${channel.name}`, content: "probe" }),
  });
  assert.equal(sendRes.status, 403);
  assert.deepEqual(await sendRes.json(), { error: "This agent is not assigned to your machine" });

  const profileRes = await fetch(`${app.baseUrl}/internal/agent/${unplaced.id}/profile`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ description: "rewritten" }),
  });
  assert.equal(profileRes.status, 403);
  assert.deepEqual(await profileRes.json(), { error: "This agent is not assigned to your machine" });
});
