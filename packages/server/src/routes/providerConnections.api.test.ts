import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import {
  AGENT_MIGRATION_CAPABILITY,
  BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS,
  PI_BUILTIN_PROVIDER_MODELS,
  PROVIDER_CONNECTION_PROVIDER_IDS,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentMigrations, agentProviderConnections, agents, featureFlagRules, integrationAuditEvents, machines, providerConnections, serverMembers, servers, users } from "../db/schema";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createServer } from "../services/serverService";
import { assertBuiltInPresetSupportedByCatalog } from "../services/builtinModelCatalogCompatibility";
import { openTestApp } from "../test/integration/app";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function enableProviderConnections(serverId: string): Promise<string> {
  const id = randomUUID();
  await getDb().insert(featureFlagRules).values({
    id,
    flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: -100,
    decision: "allow",
    values: [serverId],
  });
  return id;
}

test("provider connection migration defaults off and names only the two launch servers", () => {
  const sql = readFileSync(new URL("../../drizzle/0217_friendly_lila_cheney.sql", import.meta.url), "utf8");
  assert.match(sql, /'provider_connections_v0'[\s\S]*?'server'[\s\S]*?false/);
  assert.match(sql, /"slug" IN \('slock-android', 'botiverse'\)/);
});

test("provider connection API gates management, rejects aliases, and never returns credentials", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("provider-api-owner@raft.test", "provider-api-owner");
    const member = await seedUser("provider-api-member@raft.test", "provider-api-member");
    const server = await createServer("Provider API", "provider-api", owner.id);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);

    const gatedRead = await fetch(`${app.baseUrl}/api/provider-connections`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(gatedRead.status, 404);
    assert.equal((await gatedRead.json() as { code?: string }).code, "provider_connections_disabled");

    const gatedWrite = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Hidden", providerId: "deepseek", apiKey: "disabled-secret" }),
    });
    assert.equal(gatedWrite.status, 404);
    assert.equal((await gatedWrite.text()).includes("disabled-secret"), false);

    let gateRuleId = await enableProviderConnections(server.id);

    const forbiddenRead = await fetch(`${app.baseUrl}/api/provider-connections`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(forbiddenRead.status, 403);

    const forbiddenWrite = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ name: "Nope", providerId: "deepseek", apiKey: "member-secret" }),
    });
    assert.equal(forbiddenWrite.status, 403);
    assert.equal((await forbiddenWrite.text()).includes("member-secret"), false);

    const aliasAttempt = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Alias",
        providerId: "deepseek",
        apiKey: "write-only-secret",
        clientSecret: "unexpected-alias",
      }),
    });
    assert.equal(aliasAttempt.status, 400);
    const aliasReceipt = await aliasAttempt.text();
    assert.equal(aliasReceipt.includes("write-only-secret"), false);
    assert.equal(aliasReceipt.includes("unexpected-alias"), false);

    const createdResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Team DeepSeek", providerId: "deepseek", apiKey: "api-private-value" }),
    });
    assert.equal(createdResponse.status, 201);
    const createdText = await createdResponse.text();
    assert.equal(createdText.includes("api-private-value"), false);
    const created = JSON.parse(createdText) as { id: string; status: string; hasCredential: boolean };
    assert.equal(created.status, "unchecked");
    assert.equal(created.hasCredential, true);

    const listResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(listResponse.status, 200);
    const listText = await listResponse.text();
    assert.equal(listText.includes("api-private-value"), false);
    assert.equal(listText.includes("encryptedApiKey"), false);
    const list = JSON.parse(listText) as {
      connections: Array<{ id: string }>;
      providerOptions: Array<{ id: string; label: string; providerKind: string }>;
    };
    assert.deepEqual(list.connections.map((connection) => connection.id), [created.id]);
    assert.deepEqual(list.providerOptions.map((option) => option.id), [...PROVIDER_CONNECTION_PROVIDER_IDS]);
    assert.equal(list.providerOptions.find((option) => option.id === "google")?.providerKind, "preset");
    assert.equal(list.providerOptions.find((option) => option.id === "openai-compatible")?.providerKind, "gateway");
    assert.ok(list.providerOptions.every((option) => option.label.length > 0));

    const implicitCredentialPatch = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ apiKey: "must-not-enter-metadata", providerId: "openai-compatible" }),
    });
    assert.equal(implicitCredentialPatch.status, 400);
    assert.equal((await implicitCredentialPatch.text()).includes("must-not-enter-metadata"), false);

    const rotatedResponse = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/credentials/rotate`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ apiKey: "rotated-private-value" }),
    });
    assert.equal(rotatedResponse.status, 200);
    const rotatedText = await rotatedResponse.text();
    assert.equal(rotatedText.includes("rotated-private-value"), false);
    const rotated = JSON.parse(rotatedText) as { status: string; credentialVersion: number };
    assert.equal(rotated.status, "unchecked");
    assert.equal(rotated.credentialVersion, 2);

    const unifiedPatch = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "Patched Team DeepSeek",
        apiKey: "unified-patch-secret",
      }),
    });
    assert.equal(unifiedPatch.status, 200);
    const unifiedPatchText = await unifiedPatch.text();
    assert.equal(unifiedPatchText.includes("unified-patch-secret"), false);
    const patchedConnection = JSON.parse(unifiedPatchText) as { name: string; credentialVersion: number; status: string };
    assert.equal(patchedConnection.name, "Patched Team DeepSeek");
    assert.equal(patchedConnection.credentialVersion, 3);
    assert.equal(patchedConnection.status, "unchecked");

    await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, created.id));
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.id, gateRuleId));
    const gatedAgent = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "gated-provider-agent",
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: created.id },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    assert.equal(gatedAgent.status, 404);
    assert.equal((await gatedAgent.json() as { code?: string }).code, "provider_connections_disabled");
    gateRuleId = await enableProviderConnections(server.id);

    const incompatibleAgent = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "incompatible-provider-agent",
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: created.id },
          // Another provider's model: never compatible with a DeepSeek connection.
          model: { kind: "preset", id: "openai/gpt-5.5-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    const incompatibleText = await incompatibleAgent.text();
    assert.equal(incompatibleAgent.status, 400, incompatibleText);
    assert.equal(incompatibleText.includes("api-private-value"), false);

    // A typed DeepSeek id through the connection is compatible, as on DeepSeek
    // directly, and so goes to the target Computer's catalog check (none here).
    const typedAgent = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "typed-provider-agent",
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: created.id },
          model: { kind: "custom", name: "deepseek-v5-preview" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    assert.equal(typedAgent.status, 409);
    assert.equal((await typedAgent.json() as { code?: string }).code, "builtin_catalog_target_required");

    const compatibleAgent = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "managed-provider-agent",
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: created.id },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    assert.equal(compatibleAgent.status, 200);
    const agentText = await compatibleAgent.text();
    assert.equal(agentText.includes("api-private-value"), false);
    const agent = JSON.parse(agentText) as { id: string; runtimeConfig: { provider: Record<string, unknown> } };
    assert.deepEqual(agent.runtimeConfig.provider, { kind: "connection", connectionId: created.id });
    const assignments = await getDb().select().from(agentProviderConnections).where(eq(agentProviderConnections.agentId, agent.id));
    assert.equal(assignments.length, 1);

    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "provider-api-machine",
      apiKeyHash: "unused-provider-api-machine-hash",
      runtimes: ["builtin"],
    }).returning();
    await placeAgentOnMachine(agent.id, machine.id);
    let catalogValidationCalls = 0;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      validateBuiltInPresetForMachine: async () => {
        catalogValidationCalls += 1;
        return {
          authority: {
            connectionEpochId: "provider-api-epoch",
            replicaGeneration: "provider-api-generation",
          },
        };
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });

    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.id, gateRuleId));
    const gatedAgentUpdate = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId: created.id },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    assert.equal(gatedAgentUpdate.status, 404);
    assert.equal((await gatedAgentUpdate.json() as { code?: string }).code, "provider_connections_disabled");
    gateRuleId = await enableProviderConnections(server.id);

    const inUseDelete = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(inUseDelete.status, 409);
    assert.equal((await inUseDelete.text()).includes("api-private-value"), false);

    const inlinePatch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "preset", providerId: "deepseek", apiKey: "inline-private-value" },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    assert.equal(inlinePatch.status, 200);
    assert.equal(catalogValidationCalls, 1);
    const assignmentsAfterPatch = await getDb().select().from(agentProviderConnections).where(eq(agentProviderConnections.agentId, agent.id));
    assert.equal(assignmentsAfterPatch.length, 0);

    const deleted = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(deleted.status, 204);
    const remainingConnections = await getDb().select().from(providerConnections).where(eq(providerConnections.id, created.id));
    assert.equal(remainingConnections.length, 0);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

/** Agent creation only accepts an enabled, verified connection. */
async function markConnectionReady(connectionId: string) {
  await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, connectionId));
}

async function seedAssignedAgent(baseUrl: string, ownerToken: string, serverId: string, connectionId: string, name: string) {
  const response = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: headers(ownerToken, serverId),
    body: JSON.stringify({
      name,
      formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
      runtimeConfig: {
        version: 1,
        runtime: "builtin",
        provider: { kind: "connection", connectionId },
        model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
        mode: { kind: "default" },
        hostUserState: "forbidden",
      },
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as { id: string; name: string; displayName: string | null; runtime: string; status: string };
}

async function readAssignedAgents(baseUrl: string, token: string, serverId: string, connectionId: string) {
  const response = await fetch(`${baseUrl}/api/provider-connections/${connectionId}/agents`, {
    headers: headers(token, serverId),
  });
  return { status: response.status, text: await response.text() };
}

test("a new key or endpoint on a connection lifts paused restarts of the agents using it", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("provider-lift-owner@raft.test", "provider-lift-owner");
    const server = await createServer("Provider Lift", "provider-lift", owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    await enableProviderConnections(server.id);
    const createdResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Lift DeepSeek", providerId: "deepseek", apiKey: "lift-secret-value" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { id: string };
    await markConnectionReady(created.id);
    const agent = await seedAssignedAgent(app.baseUrl, ownerToken, server.id, created.id, "lift-provider-agent");

    const lifted: Array<{ agentId: string; runtimeValuesChanged?: boolean }> = [];
    Object.assign(app.app.get("agentOrchestrator"), {
      liftWakeBlockForConfigChange: async (agentId: string, options: { runtimeValuesChanged?: boolean } = {}) => {
        lifted.push({ agentId, ...options });
      },
    });

    const renamed = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Renamed DeepSeek" }),
    });
    assert.equal(renamed.status, 200);
    assert.deepEqual(lifted, [], "a rename changes nothing the runtime uses");

    const rotated = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/credentials/rotate`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ apiKey: "lift-rotated-value" }),
    });
    assert.equal(rotated.status, 200);
    assert.deepEqual(lifted, [{ agentId: agent.id, runtimeValuesChanged: true }]);

    const keyPatch = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ apiKey: "lift-patched-value" }),
    });
    assert.equal(keyPatch.status, 200);
    assert.equal(lifted.length, 2);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("provider connection names the Agents that block deletion without leaking credentials", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("provider-agents-owner@raft.test", "provider-agents-owner");
    const member = await seedUser("provider-agents-member@raft.test", "provider-agents-member");
    const server = await createServer("Provider Agents", "provider-agents", owner.id);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const ownerToken = await login(app.baseUrl, owner.email);
    const memberToken = await login(app.baseUrl, member.email);
    await enableProviderConnections(server.id);

    const createdResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Assigned DeepSeek", providerId: "deepseek", apiKey: "assigned-secret-value" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { id: string; assignedAgentCount: number };
    assert.equal(created.assignedAgentCount, 0);

    const unassigned = await readAssignedAgents(app.baseUrl, ownerToken, server.id, created.id);
    assert.equal(unassigned.status, 200);
    assert.deepEqual(JSON.parse(unassigned.text), { agents: [] });

    await markConnectionReady(created.id);
    const agent = await seedAssignedAgent(app.baseUrl, ownerToken, server.id, created.id, "assigned-provider-agent");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "assigned-agent-machine",
      apiKeyHash: "unused-assigned-agent-machine-hash",
      runtimes: ["builtin"],
    }).returning();
    await placeAgentOnMachine(agent.id, machine.id);

    const listed = await readAssignedAgents(app.baseUrl, ownerToken, server.id, created.id);
    assert.equal(listed.status, 200);
    assert.equal(listed.text.includes("assigned-secret-value"), false);
    assert.deepEqual(JSON.parse(listed.text), {
      agents: [{
        id: agent.id,
        name: "assigned-provider-agent",
        displayName: "assigned-provider-agent",
        runtime: "builtin",
        status: "inactive",
        computerName: "assigned-agent-machine",
        deleted: false,
      }],
    });

    const forbidden = await readAssignedAgents(app.baseUrl, memberToken, server.id, created.id);
    assert.equal(forbidden.status, 403);

    const otherServer = await createServer("Other Provider Agents", `other-provider-agents-${randomUUID()}`, owner.id);
    await enableProviderConnections(otherServer.id);
    const crossServer = await readAssignedAgents(app.baseUrl, ownerToken, otherServer.id, created.id);
    assert.equal(crossServer.status, 404);
    const unknownConnection = await readAssignedAgents(app.baseUrl, ownerToken, server.id, randomUUID());
    assert.equal(unknownConnection.status, 404);
    const malformedAgent = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/not-a-uuid`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(malformedAgent.status, 400);

    // An active Agent keeps its assignment: the Agent editor owns provider
    // changes, so this route must not become a second reassignment path.
    const activeDetach = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/${agent.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(activeDetach.status, 409);
    assert.equal((await activeDetach.json() as { code?: string }).code, "provider_connection_assignment_active");
    assert.equal(
      (await getDb().select().from(agentProviderConnections).where(eq(agentProviderConnections.agentId, agent.id))).length,
      1,
    );

    const blockedDelete = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(blockedDelete.status, 409);

    const forbiddenDetach = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/${agent.id}`, {
      method: "DELETE",
      headers: headers(memberToken, server.id),
    });
    assert.equal(forbiddenDetach.status, 403);
    const crossServerDetach = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/${agent.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, otherServer.id),
    });
    assert.equal(crossServerDetach.status, 404);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

test("deleted Agents stop blocking provider connection deletion", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 10).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("provider-detach-owner@raft.test", "provider-detach-owner");
    const server = await createServer("Provider Detach", "provider-detach", owner.id);
    const ownerToken = await login(app.baseUrl, owner.email);
    await enableProviderConnections(server.id);

    const createdResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Orphaned DeepSeek", providerId: "deepseek", apiKey: "detach-secret-value" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { id: string };
    await markConnectionReady(created.id);
    const agent = await seedAssignedAgent(app.baseUrl, ownerToken, server.id, created.id, "orphaned-provider-agent");

    // Legacy orphan: an Agent soft-deleted before the delete path released its
    // assignment. The row is unreachable from the Agent surface, so the
    // connection would stay undeletable forever without an explicit detach.
    await getDb().update(agents).set({ deletedAt: new Date(), machineId: null }).where(eq(agents.id, agent.id));

    const orphaned = await readAssignedAgents(app.baseUrl, ownerToken, server.id, created.id);
    assert.equal(orphaned.status, 200);
    assert.deepEqual(JSON.parse(orphaned.text), {
      agents: [{
        id: agent.id,
        name: "orphaned-provider-agent",
        displayName: "orphaned-provider-agent",
        runtime: "builtin",
        status: "inactive",
        computerName: null,
        deleted: true,
      }],
    });

    const detach = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/${agent.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(detach.status, 204);
    assert.equal(
      (await getDb().select().from(agentProviderConnections).where(eq(agentProviderConnections.agentId, agent.id))).length,
      0,
    );

    const audits = await getDb().select().from(integrationAuditEvents).where(and(
      eq(integrationAuditEvents.eventType, "provider_connection.assignment_detached"),
      eq(integrationAuditEvents.serverId, server.id),
    ));
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.targetId, created.id);
    assert.equal(audits[0]?.subjectId, agent.id);
    assert.equal((audits[0]?.metadata as { reason?: string }).reason, "agent_deleted");

    const catalog = await fetch(`${app.baseUrl}/api/provider-connections`, { headers: headers(ownerToken, server.id) });
    const { connections } = (await catalog.json()) as { connections: Array<{ id: string; assignedAgentCount: number }> };
    assert.equal(connections.find((connection) => connection.id === created.id)?.assignedAgentCount, 0);

    const repeatDetach = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}/agents/${agent.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(repeatDetach.status, 404);

    const deleted = await fetch(`${app.baseUrl}/api/provider-connections/${created.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(deleted.status, 204);

    // Deleting an Agent now releases its assignment in the same transaction, so
    // the orphan above cannot be recreated through the product path.
    const secondConnectionResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ name: "Released DeepSeek", providerId: "deepseek", apiKey: "release-secret-value" }),
    });
    assert.equal(secondConnectionResponse.status, 201);
    const secondConnection = (await secondConnectionResponse.json()) as { id: string };
    await markConnectionReady(secondConnection.id);
    const secondAgent = await seedAssignedAgent(app.baseUrl, ownerToken, server.id, secondConnection.id, "released-provider-agent");

    const agentDelete = await fetch(`${app.baseUrl}/api/agents/${secondAgent.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(agentDelete.status, 200);
    assert.equal(
      (await getDb().select().from(agentProviderConnections).where(eq(agentProviderConnections.agentId, secondAgent.id))).length,
      0,
    );
    const released = await readAssignedAgents(app.baseUrl, ownerToken, server.id, secondConnection.id);
    assert.deepEqual(JSON.parse(released.text), { agents: [] });

    const releaseAudit = await getDb().select().from(integrationAuditEvents).where(and(
      eq(integrationAuditEvents.eventType, "provider_connection.assignment_detached"),
      eq(integrationAuditEvents.targetId, secondConnection.id),
    ));
    assert.equal(releaseAudit.length, 1);
    assert.equal(releaseAudit[0]?.actorType, "system");

    const secondDelete = await fetch(`${app.baseUrl}/api/provider-connections/${secondConnection.id}`, {
      method: "DELETE",
      headers: headers(ownerToken, server.id),
    });
    assert.equal(secondDelete.status, 204);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// A saved preset connection behaves like its provider chosen directly: a typed
// model id and the limits are accepted on the same terms (the v2 form submit
// builds them as the direct path does), and the target Computer must run a
// typed id through a connection (customModelConnectionProviderIds). One that
// runs a typed id only on a direct preset (customModelProviderIds: every
// released Computer that reports OpenRouter) is refused, as an older Computer
// is for a direct typed id. The stub runs the real catalog check.
test("a saved preset connection takes a typed id and limits when the target Computer runs one through a connection", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("provider-typed-owner@raft.test", "provider-typed-owner");
    const server = await createServer("Provider Typed", "provider-typed", owner.id);
    const token = await login(app.baseUrl, owner.email);
    await enableProviderConnections(server.id);
    const createdResponse = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ name: "Team DeepSeek", providerId: "deepseek", apiKey: "typed-private-value" }),
    });
    assert.equal(createdResponse.status, 201);
    const connection = (await createdResponse.json()) as { id: string };
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "provider-typed-machine",
      apiKeyHash: "unused-provider-typed-machine-hash",
      runtimes: ["builtin"],
    }).returning();

    let catalog: Record<string, unknown> = {};
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      validateBuiltInPresetForMachine: async (machineId: string, config: Parameters<typeof assertBuiltInPresetSupportedByCatalog>[0], connectionProviderId: string | null) => {
        const validation = assertBuiltInPresetSupportedByCatalog(
          config,
          {
            kind: "live",
            value: {
              models: [{ id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
              catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "1.5.0", ...catalog },
            },
          },
          { machineId, daemonVersion: "1.25.0", computerVersion: "1.25.0" },
          connectionProviderId,
        );
        return validation ? { ...validation, authority: { connectionEpochId: "e", replicaGeneration: "g" } } : null;
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });
    const create = (name: string, formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({
        name,
        machineId: machine.id,
        formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
        formValues: { providerId: `connection:${connection.id}`, ...formValues },
      }),
    });
    const typed = { model: "deepseek-v5-preview", contextWindow: "128000", maxOutputTokens: "8000" };

    catalog = { customModelProviderIds: ["deepseek"] };
    const older = await create("typed-older", typed);
    const olderText = await older.text();
    assert.equal(older.status, 409, olderText);
    assert.equal((JSON.parse(olderText) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal(olderText.includes("typed-private-value"), false);

    catalog = { customModelProviderIds: ["deepseek"], customModelConnectionProviderIds: ["deepseek"] };
    const accepted = await create("typed-current", typed);
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 200, acceptedText);
    const agent = JSON.parse(acceptedText) as { runtimeConfig: { provider: unknown; model: unknown } };
    assert.deepEqual(agent.runtimeConfig.provider, { kind: "connection", connectionId: connection.id });
    assert.deepEqual(agent.runtimeConfig.model, { kind: "custom", name: "deepseek-v5-preview", contextWindow: 128_000, maxOutputTokens: 8_000 });

    // A listed model with a limit is that model's DeepSeek id, as on DeepSeek directly; without one it stays the preset.
    const listedOverride = await create("listed-override", { model: "deepseek/deepseek-v4-pro", contextWindow: "64000" });
    const listedOverrideText = await listedOverride.text();
    assert.equal(listedOverride.status, 200, listedOverrideText);
    assert.deepEqual((JSON.parse(listedOverrideText) as { runtimeConfig: { model: unknown } }).runtimeConfig.model, { kind: "custom", name: "deepseek-v4-pro", contextWindow: 64_000 });
    const listed = await create("listed", { model: "deepseek/deepseek-v4-pro", contextWindow: "" });
    const listedText = await listed.text();
    assert.equal(listed.status, 200, listedText);
    assert.deepEqual((JSON.parse(listedText) as { runtimeConfig: { model: unknown } }).runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-v4-pro" });
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

/**
 * A live Built-in catalog from the target Computer, for both the form routes
 * (model probe) and the write routes (catalog check), from one setting.
 */
function stubBuiltInCatalog(app: { app: { get(name: string): unknown } }, catalogOf: (machineId: string) => Record<string, unknown>) {
  const live = (machineId: string) => ({
    kind: "live" as const,
    value: {
      models: Object.values(PI_BUILTIN_PROVIDER_MODELS).flat(),
      catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "1.5.0", ...catalogOf(machineId) },
    },
  });
  Object.assign(app.app.get("agentOrchestrator") as object, {
    hasMachineLocally: () => true,
    detectMachineRuntimeModelsWithAuthority: async (machineId: string) => ({
      outcome: live(machineId),
      authority: { connectionEpochId: "e", replicaGeneration: "g" },
      daemonVersion: "1.25.0",
      computerVersion: "1.25.0",
    }),
    validateBuiltInPresetForMachine: async (machineId: string, config: Parameters<typeof assertBuiltInPresetSupportedByCatalog>[0], connectionProviderId: string | null) => {
      const validation = assertBuiltInPresetSupportedByCatalog(config, live(machineId) as Parameters<typeof assertBuiltInPresetSupportedByCatalog>[1], { machineId, daemonVersion: "1.25.0", computerVersion: "1.25.0" }, connectionProviderId);
      return validation ? { ...validation, authority: { connectionEpochId: "e", replicaGeneration: "g" } } : null;
    },
    acquireBuiltInCatalogAuthority: () => () => undefined,
  });
}

async function openConnectionsApp(slug: string) {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const owner = await seedUser(`${slug}-owner@raft.test`, `${slug}-owner`);
  const server = await createServer(slug, slug, owner.id);
  const token = await login(app.baseUrl, owner.email);
  await enableProviderConnections(server.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: `${slug}-machine`,
    apiKeyHash: `unused-${slug}-machine-hash`,
    runtimes: ["builtin"],
  }).returning();
  const connect = async (providerId: string) => {
    const response = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ name: `Team ${providerId}`, providerId, apiKey: `${providerId}-private-value` }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: string }).id;
  };
  return { app, server, token, machine, connect };
}

type V3Rule = { scope: string; condition: { schema: { enum?: string[] } } };
const limitRuleValues = (form: { uiSchema?: { rules?: V3Rule[] } }) =>
  (form.uiSchema?.rules ?? []).find((rule) => rule.scope === "#/properties/contextWindow")?.condition.schema.enum ?? [];

// The shipped state: every released Computer runs a typed id on a preset
// provider directly (customModelProviderIds) but not through a saved
// connection. v3 then shows the limit fields for the provider and never for
// its connection, whose save would refuse them; a current Computer shows
// them for both.
test("v3 shows the limit fields on a saved preset connection only on a Computer that runs a typed id through one", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-v3-limits");
  try {
    const connectionId = await connect("deepseek");
    let catalog: Record<string, unknown> = { customModelProviderIds: ["deepseek"] };
    stubBuiltInCatalog(app, () => catalog);
    const definition = async () => {
      const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin?clientCapabilities=runtime_form.v3`, {
        headers: headers(token, server.id),
      });
      assert.equal(response.status, 200);
      return limitRuleValues(await response.json() as { uiSchema?: { rules?: V3Rule[] } });
    };

    const shipped = await definition();
    assert.ok(shipped.includes("deepseek"), "DeepSeek chosen directly shows them");
    assert.equal(shipped.includes(`connection:${connectionId}`), false, "its saved connection does not");

    catalog = { customModelProviderIds: ["deepseek"], customModelConnectionProviderIds: ["deepseek"] };
    const current = await definition();
    assert.ok(current.includes("deepseek"));
    assert.ok(current.includes(`connection:${connectionId}`));
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// A listed model saved with a limit through a connection reads back as that
// listed model (not its stored API id), so saving the edit form unchanged
// stores the same config; with a reasoning effort on OpenAI, whose typed ids
// take none, it is not mistaken for a typed id.
test("a listed model saved with a limit through a saved connection round-trips through the edit form unchanged", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-edit-roundtrip");
  try {
    const connectionId = await connect("openai");
    stubBuiltInCatalog(app, () => ({ customModelProviderIds: ["openai"], customModelConnectionProviderIds: ["openai"] }));
    const created = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({
        name: "listed-override",
        machineId: machine.id,
        formDefinitionRef: { protocolVersion: 3, runtimeId: "builtin" },
        formValues: { providerId: `connection:${connectionId}`, model: "openai/gpt-5.5-pro", contextWindow: "64000", reasoningEffort: "high" },
      }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const agent = JSON.parse(createdText) as { id: string; runtimeConfig: { model: unknown; reasoningEffort: unknown } };
    assert.deepEqual(agent.runtimeConfig.model, { kind: "custom", name: "gpt-5.5-pro", contextWindow: 64_000 });

    const editForm = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form?clientCapabilities=runtime_form.v3`, {
      headers: headers(token, server.id),
    });
    assert.equal(editForm.status, 200);
    const edit = await editForm.json() as { values: Record<string, unknown>; uiSchema?: { rules?: V3Rule[] } };
    assert.equal(edit.values.model, "openai/gpt-5.5-pro", "shown as the listed model");
    assert.equal(edit.values.contextWindow, "64000");
    assert.ok(limitRuleValues(edit).includes(`connection:${connectionId}`), "its limit field is shown");

    const saved = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: headers(token, server.id),
      body: JSON.stringify({ formDefinitionRef: { protocolVersion: 3, runtimeId: "builtin" }, formValues: edit.values }),
    });
    const savedText = await saved.text();
    assert.equal(saved.status, 200, savedText);
    const after = (await getDb().select().from(agents).where(eq(agents.id, agent.id)))[0]!;
    const stored = after.runtimeConfig as { model: unknown; reasoningEffort: unknown };
    assert.deepEqual(stored.model, agent.runtimeConfig.model);
    assert.equal(stored.reasoningEffort, "high");
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// Every Built-in preset provider takes a typed id today (Google included), so
// the route-level refusals for a connection's typed id are: a name not stored
// as its provider stores it (Raft's `<provider>/` namespace), and a Computer
// that does not run that provider's typed id through a connection.
test("a typed id through a Google connection is refused in Raft's namespace and on a Computer that does not run it through a connection", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-google-typed");
  try {
    const connectionId = await connect("google");
    stubBuiltInCatalog(app, () => ({ customModelProviderIds: ["google"], customModelConnectionProviderIds: ["deepseek"] }));
    const create = (name: string, model: unknown) => fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({
        name,
        machineId: machine.id,
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "connection", connectionId },
          model,
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    const namespaced = await create("google-namespaced", { kind: "custom", name: "google/gemini-raft-test" });
    assert.equal(namespaced.status, 400, await namespaced.clone().text());
    assert.equal((await namespaced.json() as { code?: string }).code, "provider_connection_invalid");

    const notThroughConnection = await create("google-typed", { kind: "custom", name: "gemini-raft-test" });
    assert.equal(notThroughConnection.status, 409, await notThroughConnection.clone().text());
    assert.equal((await notThroughConnection.json() as { code?: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal((await getDb().select().from(agents).where(eq(agents.serverId, server.id))).length, 0, "nothing created");
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

/** A released Computer: typed ids on every preset provider directly, none through a saved connection. */
const RELEASED_COMPUTER = { customModelProviderIds: [...BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS] };
const CURRENT_COMPUTER = { ...RELEASED_COMPUTER, customModelConnectionProviderIds: [...BUILTIN_RUNTIME_CUSTOM_MODEL_PRESET_PROVIDER_IDS] };
const LIMITS_MESSAGE = "This Computer is too old to run this model with a context window or max output tokens set. Upgrade the Computer, or clear Context window and Max output tokens.";

// An old app on a released Computer shows the limit fields on a saved preset
// connection (by its underlyingProviderId). Filling one on a listed model is
// refused with the way out that fits: the limits, not another model.
test("adding a limit to a listed model on a saved preset connection is refused on a released Computer, naming the limits", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-patch-limit");
  try {
    const connectionId = await connect("deepseek");
    stubBuiltInCatalog(app, () => RELEASED_COMPUTER);
    const formValues = { providerId: `connection:${connectionId}`, model: "deepseek/deepseek-v4-pro" };
    const created = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ name: "listed", machineId: machine.id, formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const agent = JSON.parse(createdText) as { id: string; runtimeConfig: { model: unknown } };
    assert.deepEqual(agent.runtimeConfig.model, { kind: "preset", id: "deepseek/deepseek-v4-pro" });

    const patch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: headers(token, server.id),
      body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { ...formValues, contextWindow: "64000" } }),
    });
    const patchBody = await patch.json() as { code?: string; error?: string };
    assert.equal(patch.status, 409, JSON.stringify(patchBody));
    assert.equal(patchBody.code, "builtin_custom_model_upgrade_required");
    assert.equal(patchBody.error, LIMITS_MESSAGE);
    const after = (await getDb().select().from(agents).where(eq(agents.id, agent.id)))[0]!;
    assert.deepEqual((after.runtimeConfig as { model: unknown }).model, agent.runtimeConfig.model, "the stored model is untouched");
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// An agent saved with a typed id, or a listed model with a limit, through a
// saved preset connection on a current Computer cannot move to a released one.
test("migrating an agent with a typed id or a limit through a saved preset connection to a released Computer is refused", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-migrate");
  try {
    const db = getDb();
    const connectionId = await connect("deepseek");
    const now = new Date();
    await db.update(machines).set({ daemonVersion: "1.26.0", lastHeartbeat: now }).where(eq(machines.id, machine.id));
    const [target] = await db.insert(machines).values({
      serverId: server.id,
      userId: (await db.select().from(machines).where(eq(machines.id, machine.id)))[0]!.userId,
      name: "provider-migrate-target",
      apiKeyHash: "unused-provider-migrate-target-hash",
      runtimes: ["builtin"],
      daemonVersion: "1.25.0",
      lastHeartbeat: now,
    }).returning();
    // The source runs typed ids through a connection; the target is a released Computer.
    stubBuiltInCatalog(app, (machineId) => (machineId === target!.id ? RELEASED_COMPUTER : CURRENT_COMPUTER));
    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
    Object.assign(app.app.get("agentOrchestrator") as object, {
      getMachineStatus: async () => "online",
      getMachineDaemonVersion: () => "1.25.0",
      getMachineMigrationTransport: async () => ({ capabilities: [AGENT_MIGRATION_CAPABILITY] }),
      sendAgentMigrationTransportLease: async () => undefined,
    });
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
      provider: "object_store" as const,
      sessionId: "provider-migrate-session",
      leaseMs: 60 * 60 * 1000,
      maxBytes: 123_456,
    }));
    for (const [name, formValues, message] of [
      ["typed", { model: "deepseek-v5-preview" }, "This Computer is too old to run a model ID that is not in its list. Upgrade the Computer, or choose a model from the list."],
      ["listed-limit", { model: "deepseek/deepseek-v4-pro", contextWindow: "64000" }, LIMITS_MESSAGE],
    ] as const) {
      const created = await fetch(`${app.baseUrl}/api/agents`, {
        method: "POST",
        headers: headers(token, server.id),
        body: JSON.stringify({
          name,
          machineId: machine.id,
          formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
          formValues: { providerId: `connection:${connectionId}`, ...formValues },
        }),
      });
      const createdText = await created.text();
      assert.equal(created.status, 200, createdText);
      const agent = JSON.parse(createdText) as { id: string; runtimeConfig: { model: { kind: string } } };
      assert.equal(agent.runtimeConfig.model.kind, "custom", name);
      const migrate = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
        method: "POST",
        headers: headers(token, server.id),
        body: JSON.stringify({ targetComputer: target!.id }),
      });
      const body = await migrate.json() as { code?: string; error?: string };
      assert.equal(migrate.status, 409, `${name}: ${JSON.stringify(body)}`);
      assert.equal(body.code, "builtin_custom_model_upgrade_required", name);
      assert.equal(body.error, message, name);
      assert.equal((await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length, 0, `${name}: no migration granted`);
    }
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// Credential boundary: a connection id from another server is never resolved
// here, whatever model it is asked for, and its key never leaves its server.
test("creating an agent with another server's saved connection is refused", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine } = await openConnectionsApp("provider-cross-server");
  try {
    const owner = await seedUser("provider-cross-other-owner@raft.test", "provider-cross-other-owner");
    const other = await createServer("Provider Cross Other", "provider-cross-other", owner.id);
    await enableProviderConnections(other.id);
    const otherToken = await login(app.baseUrl, owner.email);
    const otherConnection = await fetch(`${app.baseUrl}/api/provider-connections`, {
      method: "POST",
      headers: headers(otherToken, other.id),
      body: JSON.stringify({ name: "Other DeepSeek", providerId: "deepseek", apiKey: "other-server-private-value" }),
    });
    assert.equal(otherConnection.status, 201);
    const otherConnectionId = ((await otherConnection.json()) as { id: string }).id;
    stubBuiltInCatalog(app, () => CURRENT_COMPUTER);
    for (const model of ["deepseek/deepseek-v4-pro", "deepseek-v5-preview"]) {
      const created = await fetch(`${app.baseUrl}/api/agents`, {
        method: "POST",
        headers: headers(token, server.id),
        body: JSON.stringify({
          name: "cross-server",
          machineId: machine.id,
          formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
          formValues: { providerId: `connection:${otherConnectionId}`, model },
        }),
      });
      const text = await created.text();
      assert.equal(created.status, 409, text);
      assert.equal((JSON.parse(text) as { code?: string }).code, "provider_connection_unavailable", model);
      assert.equal(text.includes("other-server-private-value"), false);
    }
    assert.equal((await getDb().select().from(agents).where(eq(agents.serverId, server.id))).length, 0, "nothing created");
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});

// Binding a saved connection hands the agent the team's key: the form lists
// connections only to `manageExternalAuth`, and a connection id is visible in
// other agents' runtimeConfig. A member who may edit an agent (its creator)
// keeps the connection it has, but cannot bind another by id.
test("binding another saved connection on edit needs manageExternalAuth; keeping the stored one does not", async () => {
  const originalKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 8).toString("base64");
  const { app, server, token, machine, connect } = await openConnectionsApp("provider-bind-auth");
  try {
    const stored = await connect("deepseek");
    const other = await connect("openrouter");
    stubBuiltInCatalog(app, () => CURRENT_COMPUTER);
    const formRef = { protocolVersion: 2, runtimeId: "builtin" };
    const created = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ name: "bound", machineId: machine.id, formDefinitionRef: formRef, formValues: { providerId: `connection:${stored}`, model: "deepseek/deepseek-v4-pro" } }),
    });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const agent = JSON.parse(createdText) as { id: string };

    const member = await seedUser("provider-bind-auth-member@raft.test", "provider-bind-auth-member");
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    await getDb().update(agents).set({ creatorType: "user", creatorId: member.id }).where(eq(agents.id, agent.id));
    const memberToken = await login(app.baseUrl, member.email);
    const edit = (as: string, formValues: Record<string, string>) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: headers(as, server.id),
      body: JSON.stringify({ formDefinitionRef: formRef, formValues }),
    });
    const boundTo = async () => ((await getDb().select().from(agents).where(eq(agents.id, agent.id)))[0]!.runtimeConfig as { provider: { connectionId?: string } }).provider.connectionId;

    const kept = await edit(memberToken, { providerId: `connection:${stored}`, model: "deepseek/deepseek-flash" });
    assert.equal(kept.status, 200, await kept.text());

    const rebound = await edit(memberToken, { providerId: `connection:${other}`, model: "openrouter/moonshotai/kimi-k2.7-code" });
    const reboundText = await rebound.text();
    assert.equal(rebound.status, 403, reboundText);
    assert.equal((JSON.parse(reboundText) as { code?: string }).code, "provider_connection_manage_auth_required");
    assert.equal(await boundTo(), stored, "the stored connection is untouched");

    const byOwner = await edit(token, { providerId: `connection:${other}`, model: "openrouter/moonshotai/kimi-k2.7-code" });
    assert.equal(byOwner.status, 200, await byOwner.text());
    assert.equal(await boundTo(), other);
  } finally {
    await app.close();
    if (originalKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
    else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = originalKey;
  }
});
