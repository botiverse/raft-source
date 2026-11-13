// Per-agent grants on the Agent API.
//
// Protected property: a human-saved custom grant set denies an operation on
// `/internal/agent-api/*` exactly as it denies the legacy `/internal/agent/:id/*`
// counterpart, even when the credential carries the coarse capability; and an
// agent still on the default profile (no `agent_scopes` row, or reset) keeps
// every operation working.

import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { AGENT_GRANTABLE_SCOPES, type AgentGrantableScope } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agentScopes, channelAgents, tasks, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { resetAgentScopesToDefault, updateAgentScopes } from "../services/agentScopesService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedGrantFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-api-grants-${suffix}@slock.test`,
    name: `agent-api-grants-${suffix}`,
    displayName: "Agent API Grants Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Agent API Grants", `agent-api-grants-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "AgentApiGrantsBot", { runtime: "claude", model: "sonnet" });
  const taskChannel = await createChannel(server.id, `grants-tasks-${suffix.slice(0, 8)}`);
  await addHuman(taskChannel.id, owner.id);
  await addAgent(taskChannel.id, agent.id);
  const joinChannel = await createChannel(server.id, `grants-join-${suffix.slice(0, 8)}`);
  await addHuman(joinChannel.id, owner.id);
  const { machine, apiKey: machineApiKey } = await registerMachine(server.id, owner.id, "agent-api-grants-machine");
  await placeAgentOnMachine(agent.id, machine.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["channels", "tasks"],
    name: "grants-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return {
    ownerId: owner.id,
    agentId: agent.id,
    taskChannelName: taskChannel.name,
    taskChannelId: taskChannel.id,
    joinChannelId: joinChannel.id,
    machineApiKey,
    agentApiKey: minted.apiKey,
  };
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function everyGrantExcept(scope: AgentGrantableScope): AgentGrantableScope[] {
  return AGENT_GRANTABLE_SCOPES.filter((s) => s !== scope);
}

type Fixture = Awaited<ReturnType<typeof seedGrantFixture>>;

function joinViaAgentApi(baseUrl: string, f: Fixture) {
  return fetch(`${baseUrl}/internal/agent-api/channels/${f.joinChannelId}/join`, {
    method: "POST",
    headers: headers(f.agentApiKey),
    body: "{}",
  });
}

function joinViaLegacy(baseUrl: string, f: Fixture) {
  return fetch(`${baseUrl}/internal/agent/${f.agentId}/channels/${f.joinChannelId}/join`, {
    method: "POST",
    headers: headers(f.machineApiKey),
    body: "{}",
  });
}

function createTaskViaAgentApi(baseUrl: string, f: Fixture, title: string) {
  return fetch(`${baseUrl}/internal/agent-api/tasks`, {
    method: "POST",
    headers: headers(f.agentApiKey),
    body: JSON.stringify({ channel: `#${f.taskChannelName}`, tasks: [{ title }] }),
  });
}

function createTaskViaLegacy(baseUrl: string, f: Fixture, title: string) {
  return fetch(`${baseUrl}/internal/agent/${f.agentId}/tasks`, {
    method: "POST",
    headers: headers(f.machineApiKey),
    body: JSON.stringify({ channel: `#${f.taskChannelName}`, tasks: [{ title }] }),
  });
}

async function joinedRows(f: Fixture) {
  return getDb().select().from(channelAgents)
    .where(and(eq(channelAgents.channelId, f.joinChannelId), eq(channelAgents.agentId, f.agentId)));
}

async function taskRows(f: Fixture) {
  return getDb().select().from(tasks).where(eq(tasks.channelId, f.taskChannelId));
}

test("default grants (no agent_scopes row) keep channel join and task create working", async ({ app }) => {
  const f = await seedGrantFixture();
  assert.equal((await getDb().select().from(agentScopes).where(eq(agentScopes.agentId, f.agentId))).length, 0);

  const join = await joinViaAgentApi(app.baseUrl, f);
  assert.equal(join.status, 200, await join.text());
  assert.equal((await joinedRows(f)).length, 1);

  const create = await createTaskViaAgentApi(app.baseUrl, f, "default grants task");
  assert.ok(create.status < 300, await create.text());
  assert.equal((await taskRows(f)).length, 1);
});

test("a custom grant set without channel:join denies join on both APIs and writes nothing", async ({ app }) => {
  const f = await seedGrantFixture();
  await updateAgentScopes({ agentId: f.agentId, scopes: everyGrantExcept("channel:join"), updatedByUserId: f.ownerId });

  const denied = await joinViaAgentApi(app.baseUrl, f);
  assert.equal(denied.status, 403);
  // Same wire shape as the legacy middleware so older CLIs/daemons render it the same way.
  assert.deepEqual(await denied.json(), {
    error: "missing required scope",
    requiredScope: "channel:join",
    reason: "missing_scope",
  });
  assert.equal((await joinedRows(f)).length, 0);

  const legacyDenied = await joinViaLegacy(app.baseUrl, f);
  assert.equal(legacyDenied.status, 403);
  assert.deepEqual(await legacyDenied.json(), {
    error: "missing required scope",
    requiredScope: "channel:join",
    reason: "missing_scope",
  });
  assert.equal((await joinedRows(f)).length, 0);

  // Other grants still work under the same custom set.
  const create = await createTaskViaAgentApi(app.baseUrl, f, "task while join revoked");
  assert.ok(create.status < 300, await create.text());

  await resetAgentScopesToDefault({ agentId: f.agentId, updatedByUserId: f.ownerId });
  const allowed = await joinViaAgentApi(app.baseUrl, f);
  assert.equal(allowed.status, 200, await allowed.text());
  assert.equal((await joinedRows(f)).length, 1);
});

test("a custom grant set without task:write denies task create on both APIs and writes nothing", async ({ app }) => {
  const f = await seedGrantFixture();
  await updateAgentScopes({ agentId: f.agentId, scopes: everyGrantExcept("task:write"), updatedByUserId: f.ownerId });

  const denied = await createTaskViaAgentApi(app.baseUrl, f, "should not exist");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), {
    error: "missing required scope",
    requiredScope: "task:write",
    reason: "missing_scope",
  });
  assert.equal((await taskRows(f)).length, 0);

  const legacyDenied = await createTaskViaLegacy(app.baseUrl, f, "should not exist either");
  assert.equal(legacyDenied.status, 403);
  assert.deepEqual(await legacyDenied.json(), {
    error: "missing required scope",
    requiredScope: "task:write",
    reason: "missing_scope",
  });
  assert.equal((await taskRows(f)).length, 0);

  // task:read is still granted, so listing works while writing does not.
  const list = await fetch(`${app.baseUrl}/internal/agent-api/tasks?channel=${encodeURIComponent(`#${f.taskChannelName}`)}`, {
    headers: headers(f.agentApiKey),
  });
  assert.equal(list.status, 200, await list.text());

  await resetAgentScopesToDefault({ agentId: f.agentId, updatedByUserId: f.ownerId });
  const allowed = await createTaskViaAgentApi(app.baseUrl, f, "after reset");
  assert.ok(allowed.status < 300, await allowed.text());
  assert.equal((await taskRows(f)).length, 1);
});
