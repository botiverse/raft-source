import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { createChannel, addAgent, addHuman } from "../services/channelService.js";
import { registerMachine } from "../services/machineService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
  await assignMachine(agentA.id, machineA.id);

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
