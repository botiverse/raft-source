// GET /api/agent-migrations/log: every move of the server's live agents, for
// owners and admins only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentMigrationLogResponseSchema, type AgentMigrationLogResponse } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentMigrations, agents, serverMembers, users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import { listAgentMigrationLog } from "../services/agentMigrationLogService";
import { createServer } from "../services/serverService";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: `${name} display`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

const deadline = new Date("2026-12-01T00:00:00Z");
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

type MigrationInsert = typeof agentMigrations.$inferInsert;

async function insertMigration(values: Omit<MigrationInsert, "contractVersion" | "grantKey" | "prepDeadlineAt" | "transferDeadlineAt" | "arrivalDeadlineAt" | "sourceMachineNameSnapshot"> & { sourceMachineNameSnapshot?: string }) {
  // Historical rows for the log: a terminal state normally needs its receipt DM
  // (agent_migration_completed_receipt_required), which the receipt tests own.
  const db = getDb();
  await db.execute(sql`ALTER TABLE agent_migrations DISABLE TRIGGER agent_migration_completed_receipt_required`);
  try {
    const [row] = await db.insert(agentMigrations).values({
      contractVersion: 2,
      grantKey: `log-test:${randomUUID()}`,
      prepDeadlineAt: deadline,
      transferDeadlineAt: deadline,
      arrivalDeadlineAt: deadline,
      sourceMachineNameSnapshot: "laptop",
      ...values,
    }).returning();
    return row;
  } finally {
    await db.execute(sql`ALTER TABLE agent_migrations ENABLE TRIGGER agent_migration_completed_receipt_required`);
  }
}

async function setup(prefix: string) {
  const db = getDb();
  const owner = await seedUser(`${prefix}-owner@slock.test`, `${prefix}-owner`);
  const admin = await seedUser(`${prefix}-admin@slock.test`, `${prefix}-admin`);
  const member = await seedUser(`${prefix}-member@slock.test`, `${prefix}-member`);
  const server = await createServer(`${prefix} server`, `${prefix}-server`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  return { owner, admin, member, server };
}

async function getLog(baseUrl: string, email: string, serverId: string) {
  return await fetch(`${baseUrl}/api/agent-migrations/log`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
}

test("owners and admins read every live agent's moves, oldest first, mapped for people", async ({ app }) => {
  const db = getDb();
  const { owner, admin, member, server } = await setup("miglog-map");
  const agent = await createAgent(server.id, "miglog-mover", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const gone = await createAgent(server.id, "miglog-gone", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const laptop = randomUUID();
  const desktop = randomUUID();

  const completed = await insertMigration({
    serverId: server.id,
    agentId: agent.id,
    sourceMachineId: laptop,
    targetMachineId: desktop,
    targetMachineNameSnapshot: "desktop",
    state: "completed",
    initiatedByUserId: owner.id,
    transferSummary: {
      includedFileCount: 42,
      includedBytes: 123_456,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: { thirdPartyDependencies: 0, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
      keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
    },
    sourceBuildProgress: { phase: "hashing", files: 1, bytes: 1, reportedAt: at(1).toISOString() },
    createdAt: at(0),
    completedAt: at(4),
  });
  const tooLarge = await insertMigration({
    serverId: server.id,
    agentId: agent.id,
    sourceMachineId: desktop,
    sourceMachineNameSnapshot: "desktop",
    targetMachineId: laptop,
    targetMachineNameSnapshot: "laptop",
    state: "failed",
    initiatedByUserId: member.id,
    failureReason: "MIGRATION_CONTROL_MANIFEST_INVALID",
    transportErrorCode: "JS_ZodError",
    transportErrorMessage: "transferSummary.includedBytes: Number must be less than or equal to 10737418240",
    sourceBuildProgress: { phase: "packing", files: 900, bytes: 20_000_000_000, reportedAt: at(11).toISOString() },
    createdAt: at(10),
    abortedAt: at(12),
  });
  const canceled = await insertMigration({
    serverId: server.id,
    agentId: agent.id,
    sourceMachineId: desktop,
    sourceMachineNameSnapshot: "desktop",
    targetKind: "hosted",
    targetMachineId: null,
    targetMachineNameSnapshot: null,
    state: "canceled_pre_flip",
    initiatedByUserId: null,
    failureReason: "SHOULD_NOT_SHOW",
    createdAt: at(20),
    canceledAt: at(21),
  });
  // A deleted agent's moves are not listed.
  await insertMigration({
    serverId: server.id,
    agentId: gone.id,
    sourceMachineId: laptop,
    targetMachineId: desktop,
    targetMachineNameSnapshot: "desktop",
    state: "completed",
    initiatedByUserId: owner.id,
    createdAt: at(5),
    completedAt: at(6),
  });
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, gone.id));

  const res = await getLog(app.baseUrl, owner.email, server.id);
  assert.equal(res.status, 200, await res.clone().text());
  const body: AgentMigrationLogResponse = agentMigrationLogResponseSchema.parse(await res.json());
  assert.equal(body.truncated, false);
  assert.deepEqual(body.migrations.map((m) => m.migrationRef), [completed.supportRef, tooLarge.supportRef, canceled.supportRef]);

  assert.deepEqual(body.migrations[0], {
    migrationRef: completed.supportRef,
    agentId: agent.id,
    sourceMachineId: laptop,
    sourceMachineName: "laptop",
    targetKind: "computer",
    targetMachineId: desktop,
    targetMachineName: "desktop",
    initiatedBy: { id: owner.id, name: owner.name, displayName: owner.displayName },
    outcome: "completed",
    startedAt: at(0).toISOString(),
    endedAt: at(4).toISOString(),
    bytes: 123_456,
    files: 42,
    failureKind: null,
    failureCode: null,
  });
  assert.deepEqual(body.migrations[1], {
    migrationRef: tooLarge.supportRef,
    agentId: agent.id,
    sourceMachineId: desktop,
    sourceMachineName: "desktop",
    targetKind: "computer",
    targetMachineId: laptop,
    targetMachineName: "laptop",
    initiatedBy: { id: member.id, name: member.name, displayName: member.displayName },
    outcome: "failed",
    startedAt: at(10).toISOString(),
    endedAt: at(12).toISOString(),
    bytes: 20_000_000_000,
    files: 900,
    failureKind: "too_large",
    failureCode: "JS_ZodError",
  });
  assert.deepEqual(body.migrations[2], {
    migrationRef: canceled.supportRef,
    agentId: agent.id,
    sourceMachineId: desktop,
    sourceMachineName: "desktop",
    targetKind: "hosted",
    targetMachineId: null,
    targetMachineName: null,
    initiatedBy: null,
    outcome: "canceled",
    startedAt: at(20).toISOString(),
    endedAt: at(21).toISOString(),
    bytes: null,
    files: null,
    failureKind: null,
    failureCode: null,
  });

  // Over the limit, the newest are kept (still oldest first) and the cut is flagged.
  const cut = await listAgentMigrationLog(server.id, 2);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.migrations.map((m) => m.migrationRef), [tooLarge.supportRef, canceled.supportRef]);

  const adminRes = await getLog(app.baseUrl, admin.email, server.id);
  assert.equal(adminRes.status, 200, await adminRes.clone().text());
  assert.equal((await adminRes.json() as AgentMigrationLogResponse).migrations.length, 3);

  // Someone who has since left the server is not named.
  await db.delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  const afterLeave = agentMigrationLogResponseSchema.parse(await (await getLog(app.baseUrl, owner.email, server.id)).json());
  assert.equal(afterLeave.migrations[1].initiatedBy, null);
  assert.deepEqual(afterLeave.migrations[0].initiatedBy, { id: owner.id, name: owner.name, displayName: owner.displayName });
});

test("ordinary members cannot read the log", async ({ app }) => {
  const { owner, member, server } = await setup("miglog-member");
  const agent = await createAgent(server.id, "miglog-member-agent", { runtime: "codex", creatorType: "user", creatorId: member.id });
  await insertMigration({
    serverId: server.id,
    agentId: agent.id,
    sourceMachineId: randomUUID(),
    targetMachineId: randomUUID(),
    targetMachineNameSnapshot: "desktop",
    state: "completed",
    initiatedByUserId: owner.id,
    completedAt: new Date(),
  });
  const res = await getLog(app.baseUrl, member.email, server.id);
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { code?: string }).code, "not_supported");
});
