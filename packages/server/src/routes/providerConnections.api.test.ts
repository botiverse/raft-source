import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import {
  PROVIDER_CONNECTION_PROVIDER_IDS,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentProviderConnections, featureFlagRules, machines, providerConnections, serverMembers, users } from "../db/schema.js";
import { assignMachine as assignAgentMachine } from "../services/agentService.js";
import { createServer } from "../services/serverService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
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

    await getDb().update(providerConnections).set({ status: "ready" }).where(eq(providerConnections.id, created.id));
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.id, gateRuleId));
    const gatedAgent = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        name: "gated-provider-agent",
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v2" },
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
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v2" },
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
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v2" },
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
    await assignAgentMachine(agent.id, machine.id);
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
