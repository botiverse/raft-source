import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  inboxNotificationFacts,
  machines,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService.js";
import {
  beginAgentMigration,
  flipAgentMigrationMachine,
  startAgentMigrationTransfer,
} from "../services/agentMigrationService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type MigrationFixture = {
  agentId: string;
  ownerId: string;
  targetMachineId: string;
  serverKey: string;
  readKey: string;
};

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Raft-Client": "cli",
  };
}

async function mintAgentKey(agentId: string, scopes: readonly AgentCapability[]): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes,
    name: `migration-route-test-${scopes.join("-")}`,
    createdByUserId: null,
  });
  return minted.apiKey;
}

async function seedMigrationFixture(): Promise<MigrationFixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    id: randomUUID(),
    email: `agent-migration-${suffix}@slock.test`,
    name: `agent-migration-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: randomUUID(),
    name: "Agent Migration API Test",
    slug: `agent-migration-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [sourceMachine] = await db.insert(machines).values({
    id: randomUUID(),
    serverId: server.id,
    userId: owner.id,
    name: `source-${suffix}`,
    apiKeyHash: "hash-source",
  }).returning();
  const [targetMachine] = await db.insert(machines).values({
    id: randomUUID(),
    serverId: server.id,
    userId: owner.id,
    name: `target-${suffix}`,
    apiKeyHash: "hash-target",
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: randomUUID(),
    serverId: server.id,
    name: `MigrationBot${suffix.slice(0, 8)}`,
    status: "active",
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
    machineId: sourceMachine.id,
  }).returning();

  return {
    agentId: agent.id,
    ownerId: owner.id,
    targetMachineId: targetMachine.id,
    serverKey: await mintAgentKey(agent.id, ["server", "read"]),
    readKey: await mintAgentKey(agent.id, ["read"]),
  };
}

test("agent-api migration callbacks cannot bypass Computer completion receipts", async ({ app }) => {
  const fixture = await seedMigrationFixture();
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  app.app.set("io", {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
    }),
  });
  const seeded = await beginAgentMigration({
    agentId: fixture.agentId,
    targetMachineId: fixture.targetMachineId,
    prepDeadlineMs: 600000,
  });

  const status = await fetch(`${app.baseUrl}/internal/agent-api/migrations/current`, {
    headers: jsonHeaders(fixture.readKey),
  });
  assert.equal(status.status, 200);
  const statusBody = await status.json() as {
    migration?: {
      id?: string;
      agentId?: string;
      state?: string;
      targetMachineId?: string;
      grantKey?: string;
    };
  };
  assert.equal(statusBody.migration?.id, seeded.id);
  assert.equal(statusBody.migration?.agentId, fixture.agentId);
  assert.equal(statusBody.migration?.state, "prep");
  assert.equal(statusBody.migration?.targetMachineId, fixture.targetMachineId);
  assert.equal(statusBody.migration?.grantKey, undefined);
  assert.doesNotMatch(JSON.stringify(statusBody), /agent_migration:/);

  const ready = await fetch(`${app.baseUrl}/internal/agent-api/migrations/ready`, {
    method: "POST",
    headers: jsonHeaders(fixture.readKey),
    body: JSON.stringify({ manifestPath: "MIGRATION-MANIFEST.json", manifestSha256: "sha256:manifest" }),
  });
  assert.equal(ready.status, 200);
  const readyBody = await ready.json() as { migration?: { state?: string; manifestPath?: string; grantKey?: string } };
  assert.equal(readyBody.migration?.state, "ready");
  assert.equal(readyBody.migration?.manifestPath, "MIGRATION-MANIFEST.json");
  assert.equal(readyBody.migration?.grantKey, undefined);

  const [migrationRow] = await getDb()
    .select()
    .from(agentMigrations)
    .where(eq(agentMigrations.id, seeded.id));
  assert.ok(migrationRow);
  await startAgentMigrationTransfer(migrationRow.grantKey);
  await flipAgentMigrationMachine(migrationRow.grantKey);

  const callLegacyArrival = () => fetch(`${app.baseUrl}/internal/agent-api/migrations/arrived`, {
    method: "POST",
    headers: jsonHeaders(fixture.readKey),
    body: JSON.stringify({ reportPath: "MIGRATION-ARRIVED.json", reportSha256: "sha256:arrived" }),
  });
  const attempts = await Promise.all([callLegacyArrival(), callLegacyArrival()]);
  for (const arrived of attempts) {
    assert.equal(arrived.status, 409);
    const body = await arrived.json() as { code?: string };
    assert.equal(body.code, "MIGRATION_REQUIRES_COMPUTER_PROTOCOL");
  }
  const [afterLegacyArrival] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, seeded.id));
  assert.equal(afterLegacyArrival.state, "arriving");
  assert.equal(afterLegacyArrival.completedAt, null);
  assert.equal(emitted.some((entry) =>
    entry.event === "agent:migration-updated"
    && (entry.payload as { state?: string }).state === "completed"
  ), false);
  assert.equal((await getDb().select().from(messages)).length, 0);
  assert.equal((await getDb().select().from(inboxNotificationFacts)).length, 0);
  assert.equal((await getDb().select().from(agentMigrationReceiptOutbox)).length, 0);
});

test("agent-api migration begin is not supported for agent credentials", async ({ app }) => {
  const fixture = await seedMigrationFixture();
  const denied = await fetch(`${app.baseUrl}/internal/agent-api/migrations`, {
    method: "POST",
    headers: jsonHeaders(fixture.serverKey),
    body: JSON.stringify({ targetMachineId: fixture.targetMachineId }),
  });

  assert.equal(denied.status, 403);
  const body = await denied.json() as { code?: string; error?: string };
  assert.equal(body.code, "not_supported");
  assert.match(body.error ?? "", /human creator/);
  assert.match(body.error ?? "", /migrateAgents/);
  assert.doesNotMatch(body.error ?? "", /owner|admin/i);
});
