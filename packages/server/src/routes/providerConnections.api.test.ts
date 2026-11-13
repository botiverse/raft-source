import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import {
  PROVIDER_CONNECTION_PROVIDER_IDS,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentProviderConnections, agents, featureFlagRules, integrationAuditEvents, machines, providerConnections, serverMembers, users } from "../db/schema";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createServer } from "../services/serverService";
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
          model: { kind: "custom", name: "wrong-model-shape" },
          mode: { kind: "default" },
          hostUserState: "forbidden",
        },
      }),
    });
    const incompatibleText = await incompatibleAgent.text();
    assert.equal(incompatibleAgent.status, 400, incompatibleText);
    assert.equal(incompatibleText.includes("api-private-value"), false);

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
