import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agentMigrationReceiptChannels,
  agentMigrationReceiptOutbox,
  agentMigrations,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  machines,
  messages,
  users,
} from "../db/schema.js";
import type { AgentOrchestrator, AgentMessageDeliveryResult } from "./agentOrchestrator.js";
import { createAgent } from "./agentService.js";
import {
  canAgentAccessChannel,
  canUserAccessChannel,
  findOrCreateDM,
  listDMChannels,
} from "./channelService.js";
import { registerMachine } from "./machineService.js";
import {
  getAgentResumeCatchupMessages,
  listMessages,
} from "./messageService.js";
import { createServer } from "./serverService.js";
import { searchMessagesForAgent, searchMessagesForUser } from "./searchService.js";
import {
  abortAgentMigration,
  acknowledgeAgentMigrationCancellation,
  agentMigrationGeneration,
  beginAgentMigration,
  completeAgentMigrationAutoStart,
  flipAgentMigrationMachine,
  markAgentMigrationSourceReadyForComputer,
  markAgentMigrationTargetImportArrived,
  markAgentMigrationTransportLostForComputer,
  recordAgentMigrationAutoStartFailure,
  recordAgentMigrationSourceWorkspaceArchived,
  requestAgentMigrationCancellation,
  startAgentMigrationTransfer,
  markAgentMigrationTransportLost,
} from "./agentMigrationService.js";
import {
  drainAgentMigrationReceiptOutbox,
  formatAgentMigrationCompletedReceipt,
} from "./agentMigrationReceiptService.js";


const TRANSFER_SUMMARY = {
  includedFileCount: 3,
  includedBytes: 256,
  excludedRegenerableCount: 4,
  excludedRegenerableByCategory: {
    thirdPartyDependencies: 1,
    caches: 1,
    buildArtifacts: 1,
    otherRegenerable: 1,
  },
  keyWorkspaceEntries: {
    memoryMdPresent: true,
    notesPresent: false,
  },
} as const;

afterEach(async () => {
  await closeTestDatabase();
});

function fakeIo(targets: string[] = []): SocketServer {
  const operator = {
    in: (room: string) => {
      targets.push(`in:${room}`);
      return operator;
    },
    socketsJoin: () => undefined,
    emit: () => true,
  };
  return {
    in: (room: string) => {
      targets.push(`in:${room}`);
      return operator;
    },
    to: (room: string) => {
      targets.push(`to:${room}`);
      return operator;
    },
  } as unknown as SocketServer;
}

function fakeOrchestrator(
  deliver: (agentId: string, message: Record<string, unknown>) => Promise<AgentMessageDeliveryResult>,
): AgentOrchestrator {
  return { deliverMessage: deliver } as unknown as AgentOrchestrator;
}

function rejectionContains(expected: string) {
  return (error: unknown) => {
    const cause = error instanceof Error && "cause" in error
      ? (error.cause as Error | undefined)
      : undefined;
    return (cause?.message ?? (error instanceof Error ? error.message : String(error))).includes(expected);
  };
}

async function seedStartingMigration(driveToStarting = true) {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `migration-receipt-${suffix}@slock.test`,
    name: `migration-receipt-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Migration Receipt", `migration-receipt-${suffix}`, owner.id);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "Frozen Source");
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, "Frozen Target");
  const agent = await createAgent(server.id, "receipt-agent", {
    runtime: "codex",
    machineId: sourceMachine.id,
  });
  const startedAt = new Date("2026-07-20T12:00:00.000Z");
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: owner.id,
    now: startedAt,
  });
  assert.ok(migration.receiptChannelId);
  if (!driveToStarting) {
    return { owner, server, sourceMachine, targetMachine, agent, receiptChannelId: migration.receiptChannelId, migration };
  }
  const ready = await markAgentMigrationSourceReadyForComputer({
    migrationId: migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    manifestPath: "object-store:test/manifest.json",
    manifestSha256: "sha256:test",
    transferSummary: TRANSFER_SUMMARY,
    now: new Date("2026-07-20T12:01:00.000Z"),
  });
  await startAgentMigrationTransfer(ready.grantKey, new Date("2026-07-20T12:02:00.000Z"));
  const arriving = await flipAgentMigrationMachine(ready.grantKey, new Date("2026-07-20T12:03:00.000Z"));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    grantKey: ready.grantKey,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-20T12:03:30.000Z"),
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    grantKey: ready.grantKey,
    migrationGeneration: archived.migrationGeneration,
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-20T12:04:00.000Z"),
  });
  assert.equal(arrival.migration.state, "starting");
  const [startingMigration] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.ok(startingMigration);
  return { owner, server, sourceMachine, targetMachine, agent, receiptChannelId: migration.receiptChannelId, migration: startingMigration };
}

async function seedProjectedReceiptMigration() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `migration-projected-receipt-${suffix}@slock.test`,
    name: `migration-projected-receipt-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Migration Projected Receipt", `migration-projected-receipt-${suffix}`, owner.id);
  const storageServer = await createServer("Migration Receipt Storage", `migration-receipt-storage-${suffix}`, owner.id);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "Projected Source");
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, "Projected Target");
  const agent = await createAgent(server.id, "projected-receipt-agent", {
    runtime: "codex",
    machineId: targetMachine.id,
  });
  const now = new Date("2026-07-20T12:00:00.000Z");
  const canonicalChannelId = randomUUID();
  const receiptChannelId = randomUUID();
  const jointChannelId = randomUUID();
  const migrationId = randomUUID();
  const grantKey = `agent_migration:${randomUUID()}`;

  await db.insert(channels).values([
    {
      id: canonicalChannelId,
      serverId: storageServer.id,
      name: `migration-receipt-canonical-${suffix}`,
      description: "Canonical projected migration receipt",
      type: "dm",
      createdAt: now,
    },
    {
      id: receiptChannelId,
      serverId: storageServer.id,
      name: `migration-receipt-local-${suffix}`,
      description: "Projected migration receipt",
      type: "dm",
      createdAt: now,
    },
  ]);
  await db.insert(jointChannels).values({
    id: jointChannelId,
    canonicalChannelId,
    createdByServerId: storageServer.id,
    createdByUserId: owner.id,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(jointChannelServers).values({
    jointChannelId,
    serverId: server.id,
    localChannelId: receiptChannelId,
    role: "participant",
    status: "active",
    joinedByUserId: owner.id,
    joinedAt: now,
  });
  await db.insert(channelAgents).values({
    channelId: receiptChannelId,
    agentId: agent.id,
    addedAt: now,
  });
  const [migration] = await db.insert(agentMigrations).values({
    id: migrationId,
    serverId: server.id,
    agentId: agent.id,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    sourceMachineNameSnapshot: sourceMachine.name,
    targetMachineNameSnapshot: targetMachine.name,
    receiptChannelId,
    state: "starting",
    sourceWorkspaceArchivedAt: now,
    supportRef: `mig_projected_${suffix}`,
    contractVersion: 2,
    grantKey,
    transferSummary: TRANSFER_SUMMARY,
    prepDeadlineAt: new Date("2026-07-20T12:05:00.000Z"),
    transferDeadlineAt: new Date("2026-07-20T12:10:00.000Z"),
    arrivalDeadlineAt: new Date("2026-07-20T12:15:00.000Z"),
    createdAt: now,
    updatedAt: now,
  }).returning();
  assert.ok(migration);
  await db.insert(agentMigrationReceiptChannels).values({
    channelId: receiptChannelId,
    migrationId: migration.id,
    serverId: server.id,
    agentId: agent.id,
    createdAt: now,
  });
  return { owner, server, storageServer, sourceMachine, targetMachine, agent, receiptChannelId, jointChannelId, migration };
}

async function receiptRows() {
  const db = getDb();
  return {
    messages: await db.select().from(messages),
    facts: await db.select().from(inboxNotificationFacts),
    outbox: await db.select().from(agentMigrationReceiptOutbox),
  };
}

test("authoritative completion atomically persists one private frozen-name receipt", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await getDb().delete(machines).where(eq(machines.id, fixture.sourceMachine.id));
  await getDb().update(machines)
    .set({ name: "Renamed Target" })
    .where(eq(machines.id, fixture.targetMachine.id));

  const completed = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
    now: new Date("2026-07-20T12:05:00.000Z"),
  });
  assert.equal(completed.state, "completed");

  const rows = await receiptRows();
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.outbox.length, 1);
  assert.equal(rows.outbox[0]!.messageId, rows.messages[0]!.id);
  assert.equal(rows.messages[0]!.channelId, fixture.receiptChannelId);
  assert.equal(rows.messages[0]!.senderType, "user");
  assert.equal(rows.messages[0]!.messageType, "system");
  assert.match(rows.messages[0]!.content, /Moved from Frozen Source to Frozen Target/);
  assert.doesNotMatch(rows.messages[0]!.content, /Renamed Target/);
  assert.match(rows.messages[0]!.content, new RegExp(fixture.migration.supportRef));
  assert.match(rows.messages[0]!.content, /MEMORY\.md existed in the workspace and moved with it/);
  assert.doesNotMatch(rows.messages[0]!.content, /notes existed/);
  assert.equal(rows.messages[0]!.content.includes("object-store:test"), false);
  assert.equal(rows.messages[0]!.content.includes("manifest.json"), false);
  assert.deepEqual(
    rows.facts.map((fact) => [fact.receiverType, fact.receiverId, fact.messageId]).sort(),
    [["agent", fixture.agent.id, rows.messages[0]!.id]],
  );
  assert.equal(await canAgentAccessChannel(fixture.receiptChannelId, fixture.agent.id), true);
  assert.equal(await canUserAccessChannel(
    fixture.receiptChannelId,
    fixture.owner.id,
    asServerId(fixture.server.id),
  ), false);
  assert.equal(
    (await listDMChannels(fixture.server.id, fixture.owner.id))
      .some((channel) => channel.id === fixture.receiptChannelId),
    false,
  );
  const agentSearch = await searchMessagesForAgent({
    serverId: fixture.server.id,
    agentId: fixture.agent.id,
    query: "Migration",
  });
  assert.equal(agentSearch.results.length, 1);
  assert.equal(agentSearch.results[0]!.channelId, fixture.receiptChannelId);
  const agentRead = await listMessages(fixture.receiptChannelId, 10);
  assert.deepEqual(agentRead.map((message) => message.id), [rows.messages[0]!.id]);
  const reconnect = await getAgentResumeCatchupMessages(fixture.agent.id);
  assert.deepEqual(
    reconnect.messages.map((message) => message.message_id),
    [rows.messages[0]!.id],
  );
  const humanSearch = await searchMessagesForUser({
    serverId: fixture.server.id,
    userId: fixture.owner.id,
    query: "Migration",
  });
  assert.equal(humanSearch.results.length, 0);

  const duplicate = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  assert.equal(duplicate.id, completed.id);
  const afterDuplicate = await receiptRows();
  assert.equal(afterDuplicate.messages.length, 1);
  assert.equal(afterDuplicate.facts.length, 1);
  assert.equal(afterDuplicate.outbox.length, 1);
});

test("completion rolls back state, message, inbox facts, and outbox together", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await assert.rejects(
    completeAgentMigrationAutoStart({
      grantKey: fixture.migration.grantKey,
      agentId: fixture.agent.id,
      targetMachineId: fixture.targetMachine.id,
    }, {
      beforeOutboxInsert: () => {
        throw new Error("injected_outbox_failure");
      },
    }),
    /injected_outbox_failure/,
  );
  const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, fixture.migration.id));
  assert.equal(migration.state, "starting");
  assert.equal(migration.completedAt, null);
  assert.deepEqual(await receiptRows(), { messages: [], facts: [], outbox: [] });
});

test("legacy completion without a receipt is rejected atomically and new completion reconciles exactly once", async ({ db: database }) => {

  const fixture = await seedStartingMigration();
  const db = getDb();

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(agentMigrations)
        .set({
          state: "completed",
          completedAt: new Date("2026-07-20T12:05:00.000Z"),
          revision: fixture.migration.revision + 1,
        })
        .where(and(
          eq(agentMigrations.id, fixture.migration.id),
          eq(agentMigrations.state, "starting"),
        ));
    }),
    rejectionContains("terminal agent migration requires durable receipt"),
  );
  const [afterLegacyAttempt] = await db.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.id, fixture.migration.id));
  assert.equal(afterLegacyAttempt.state, "starting");
  assert.equal(afterLegacyAttempt.completedAt, null);
  assert.deepEqual(await receiptRows(), { messages: [], facts: [], outbox: [] });

  const completed = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
    now: new Date("2026-07-20T12:06:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  const duplicate = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
    now: new Date("2026-07-20T12:07:00.000Z"),
  });
  assert.equal(duplicate.id, completed.id);
  const rows = await receiptRows();
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.facts.length, 1);
  assert.equal(rows.outbox.length, 1);
});

test("canceled and failed terminal migrations require exactly one durable receipt", async ({ db }) => {

  const canceledFixture = await seedStartingMigration(false);
  const canceled = await requestAgentMigrationCancellation({
    agentId: canceledFixture.agent.id,
    migrationRef: canceledFixture.migration.supportRef,
    expectedRevision: canceledFixture.migration.revision,
    initiatedByUserId: canceledFixture.owner.id,
    reason: "owner_cancel",
    now: new Date("2026-07-21T10:00:00.000Z"),
  });
  assert.equal(canceled.migration.state, "canceled_pre_flip");
  assert.deepEqual(
    (await receiptRows()).outbox.map((row) => row.receiptKind),
    ["canceled"],
  );
  const duplicateCancel = await requestAgentMigrationCancellation({
    agentId: canceledFixture.agent.id,
    migrationRef: canceledFixture.migration.supportRef,
    expectedRevision: canceledFixture.migration.revision,
    initiatedByUserId: canceledFixture.owner.id,
    reason: "duplicate",
    now: new Date("2026-07-21T10:01:00.000Z"),
  });
  assert.equal(duplicateCancel.migration.state, "canceled_pre_flip");
  assert.equal((await receiptRows()).outbox.filter((row) => row.receiptKind === "canceled").length, 1);

  const invalidFixture = await seedStartingMigration(false);
  await assert.rejects(
    getDb().transaction(async (tx) => {
      await tx.update(agentMigrations)
        .set({
          state: "canceled_pre_flip",
          canceledAt: new Date("2026-07-21T11:00:00.000Z"),
          revision: invalidFixture.migration.revision + 1,
        })
        .where(eq(agentMigrations.id, invalidFixture.migration.id));
    }),
    rejectionContains("terminal agent migration requires durable receipt"),
  );

  const failedFixture = await seedStartingMigration();
  const failed = await markAgentMigrationTransportLost({
    migrationId: failedFixture.migration.id,
    message: "transport disappeared",
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.equal(failed?.state, "failed");
  assert.equal((await receiptRows()).outbox.filter((row) => row.receiptKind === "failed").length, 1);
});

test("receipt surface audience and identity are immutable while ordinary DM changes cannot block completion", async ({ db: database }) => {

  const fixture = await seedStartingMigration();
  const db = getDb();
  const ordinaryDm = await findOrCreateDM(fixture.server.id, fixture.owner.id, fixture.agent.id);
  assert.ok(ordinaryDm);
  await db.delete(channelHumans).where(eq(channelHumans.channelId, ordinaryDm.id));
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, ordinaryDm.id));

  const intruder = await createAgent(fixture.server.id, "receipt-intruder", { runtime: "codex" });
  await assert.rejects(
    db.insert(channelHumans).values({ channelId: fixture.receiptChannelId, userId: fixture.owner.id }),
    rejectionContains("receipt channel membership is immutable"),
  );
  await assert.rejects(
    db.insert(channelAgents).values({ channelId: fixture.receiptChannelId, agentId: intruder.id }),
    rejectionContains("receipt channel membership is immutable"),
  );
  await assert.rejects(
    db.delete(channelAgents).where(eq(channelAgents.channelId, fixture.receiptChannelId)),
    rejectionContains("receipt channel membership is immutable"),
  );
  await assert.rejects(
    db.update(channels).set({ name: "mutated-receipt-surface" }).where(eq(channels.id, fixture.receiptChannelId)),
    rejectionContains("receipt channel is immutable"),
  );
  await assert.rejects(
    db.delete(agentMigrationReceiptChannels).where(eq(agentMigrationReceiptChannels.channelId, fixture.receiptChannelId)),
    rejectionContains("receipt channel identity is immutable"),
  );

  const completed = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  assert.equal(completed.state, "completed");
  const rows = await receiptRows();
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.facts.length, 1);
  assert.equal(rows.outbox.length, 1);
  await assert.rejects(
    db.update(messages).set({ content: "mutated" }).where(eq(messages.id, rows.messages[0]!.id)),
    rejectionContains("receipt message is immutable"),
  );
  await assert.rejects(
    db.delete(messages).where(eq(messages.id, rows.messages[0]!.id)),
    rejectionContains("receipt message is immutable"),
  );
});

test("projected receipt surface resolves through joint scope without widening the agent-only audience", async ({ db }) => {

  const fixture = await seedProjectedReceiptMigration();
  assert.notEqual(
    (await getDb().select().from(channels).where(eq(channels.id, fixture.receiptChannelId)).limit(1))[0]!.serverId,
    fixture.server.id,
    "fixture must fail a raw channels.serverId = migration.serverId join",
  );

  const completed = await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
    now: new Date("2026-07-20T12:16:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  const rows = await receiptRows();
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.messages[0]!.channelId, fixture.receiptChannelId);
  assert.equal(rows.outbox.length, 1);
  assert.equal(rows.outbox[0]!.serverId, fixture.server.id);
  assert.equal(rows.outbox[0]!.agentId, fixture.agent.id);
  assert.equal(rows.outbox[0]!.channelId, fixture.receiptChannelId);
  assert.deepEqual(
    rows.facts.map((fact) => [fact.receiverType, fact.receiverId, fact.sourceChannelId, fact.messageId]),
    [["agent", fixture.agent.id, fixture.receiptChannelId, rows.messages[0]!.id]],
  );
  assert.equal(await canAgentAccessChannel(fixture.receiptChannelId, fixture.agent.id), true);
  assert.equal(await canUserAccessChannel(
    fixture.receiptChannelId,
    fixture.owner.id,
    asServerId(fixture.server.id),
  ), false);
});

test("projected receipt surface fails closed when the effective joint mapping is revoked", async ({ db }) => {

  const fixture = await seedProjectedReceiptMigration();
  await getDb().update(jointChannelServers)
    .set({ status: "disconnected" })
    .where(and(
      eq(jointChannelServers.jointChannelId, fixture.jointChannelId),
      eq(jointChannelServers.serverId, fixture.server.id),
    ));

  await assert.rejects(
    completeAgentMigrationAutoStart({
      grantKey: fixture.migration.grantKey,
      agentId: fixture.agent.id,
      targetMachineId: fixture.targetMachine.id,
    }),
    rejectionContains("MIGRATION_RECEIPT_SURFACE_INVALID"),
  );
  const rows = await receiptRows();
  assert.equal(rows.messages.length, 0);
  assert.equal(rows.facts.length, 0);
  assert.equal(rows.outbox.length, 0);
  const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, fixture.migration.id));
  assert.equal(migration!.state, "starting");
});

test("receipt outbox validates its full identity and cannot retarget or release authority", async ({ db: database }) => {

  const fixture = await seedStartingMigration();
  const db = getDb();
  await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  const rows = await receiptRows();
  const originalMessage = rows.messages[0];
  const outbox = rows.outbox[0];
  assert.ok(originalMessage);
  assert.ok(outbox);

  const [replacementMessage] = await db.insert(messages).values({
    channelId: fixture.receiptChannelId,
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: "replacement receipt",
    searchText: "replacement receipt",
  }).returning();
  assert.ok(replacementMessage);

  await assert.rejects(
    db.update(agentMigrationReceiptOutbox)
      .set({ messageId: replacementMessage.id })
      .where(eq(agentMigrationReceiptOutbox.id, outbox.id)),
    rejectionContains("receipt outbox identity is immutable"),
  );
  await assert.rejects(
    db.update(messages)
      .set({ content: "mutated authoritative receipt" })
      .where(eq(messages.id, originalMessage.id)),
    rejectionContains("receipt message is immutable"),
  );
  await assert.rejects(
    db.delete(agentMigrationReceiptOutbox)
      .where(eq(agentMigrationReceiptOutbox.id, outbox.id)),
    rejectionContains("receipt outbox identity is immutable"),
  );
  await assert.rejects(
    db.update(agentMigrationReceiptOutbox)
      .set({ createdAt: new Date("2026-07-21T08:00:00.000Z") })
      .where(eq(agentMigrationReceiptOutbox.id, outbox.id)),
    rejectionContains("receipt outbox identity is immutable"),
  );

  const invalidFixture = await seedStartingMigration(false);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.update(agentMigrations)
        .set({
          state: "completed",
          completedAt: new Date("2026-07-21T08:00:00.000Z"),
          revision: invalidFixture.migration.revision + 1,
        })
        .where(eq(agentMigrations.id, invalidFixture.migration.id));
      await tx.insert(agentMigrationReceiptOutbox).values({
        migrationId: invalidFixture.migration.id,
        receiptKind: "completed",
        serverId: fixture.server.id,
        agentId: fixture.agent.id,
        channelId: fixture.receiptChannelId,
        messageId: replacementMessage.id,
        status: "pending",
      });
    }),
    rejectionContains("receipt outbox identity is invalid"),
  );

  const [deliveryUpdate] = await db.update(agentMigrationReceiptOutbox)
    .set({
      status: "processing",
      attemptCount: outbox.attemptCount + 1,
      lockedAt: new Date("2026-07-21T08:01:00.000Z"),
      lastError: "retryable",
      updatedAt: new Date("2026-07-21T08:01:00.000Z"),
    })
    .where(eq(agentMigrationReceiptOutbox.id, outbox.id))
    .returning();
  assert.equal(deliveryUpdate?.status, "processing");
  assert.equal(deliveryUpdate?.messageId, originalMessage.id);
});

test("outbox retries drop and crash-after-broadcast with the same durable identity", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  const identities: Array<{ id: unknown; seq: unknown }> = [];
  const socketTargets: string[] = [];
  let deliveryAttempt = 0;
  const orchestrator = fakeOrchestrator(async (agentId, message) => {
    assert.equal(agentId, fixture.agent.id);
    identities.push({ id: message.message_id, seq: message.seq });
    assert.equal(message.channel_id, fixture.receiptChannelId);
    assert.match(String(message.content), /Migration completed/);
    deliveryAttempt += 1;
    return deliveryAttempt === 1
      ? { status: "dropped", reason: "wake_failed" }
      : { status: "queued", reason: "replayable_inbox" };
  });

  assert.deepEqual(await drainAgentMigrationReceiptOutbox({ io: fakeIo(socketTargets), orchestrator }), {
    attempted: 1,
    sent: 0,
    failed: 1,
  });
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({
    io: fakeIo(socketTargets),
    orchestrator,
    afterBroadcast: () => {
      throw new Error("simulated_server_crash");
    },
  }), {
    attempted: 1,
    sent: 0,
    failed: 1,
  });
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({ io: fakeIo(socketTargets), orchestrator }), {
    attempted: 1,
    sent: 1,
    failed: 0,
  });
  assert.equal(new Set(identities.map((identity) => identity.id)).size, 1);
  assert.equal(new Set(identities.map((identity) => identity.seq)).size, 1);
  assert.equal(socketTargets.some((target) => target.includes(`user:${fixture.owner.id}`)), false);
  const rows = await receiptRows();
  assert.equal(rows.messages.length, 1);
  assert.equal(rows.facts.length, 1);
  assert.equal(rows.outbox[0]!.status, "sent");
  assert.equal(rows.outbox[0]!.attemptCount, 3);
});

test("concurrent outbox drainers claim one row and dispatch once", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await completeAgentMigrationAutoStart({
    grantKey: fixture.migration.grantKey,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  const deliveredIds: unknown[] = [];
  const orchestrator = fakeOrchestrator(async (_agentId, message) => {
    deliveredIds.push(message.message_id);
    return { status: "queued", reason: "replayable_inbox" };
  });
  const results = await Promise.all([
    drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator }),
    drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator }),
  ]);
  assert.equal(results.reduce((total, result) => total + result.attempted, 0), 1);
  assert.equal(results.reduce((total, result) => total + result.sent, 0), 1);
  assert.equal(deliveredIds.length, 1);
});

test("auto-start-failed and aborted migrations create no receipt while failed and canceled terminalize with one receipt", async ({ db }) => {

  const failedFixture = await seedStartingMigration();
  await recordAgentMigrationAutoStartFailure({
    grantKey: failedFixture.migration.grantKey,
    agentId: failedFixture.agent.id,
    targetMachineId: failedFixture.targetMachine.id,
    stage: "start_agent",
    code: "start_not_dispatched",
  });
  assert.deepEqual(await receiptRows(), { messages: [], facts: [], outbox: [] });

  await closeTestDatabase();
  await openTestDatabase("pglite://");
  const transportFixture = await seedStartingMigration(false);
  const failed = await markAgentMigrationTransportLostForComputer({
    migrationId: transportFixture.migration.id,
    serverId: transportFixture.server.id,
    machineId: transportFixture.sourceMachine.id,
    message: "test_transport_failed",
  });
  assert.equal(failed.state, "failed");
  assert.deepEqual(
    (await receiptRows()).outbox.map((row) => row.receiptKind),
    ["failed"],
  );

  await closeTestDatabase();
  await openTestDatabase("pglite://");
  const abortFixture = await seedStartingMigration(false);
  await abortAgentMigration({ grantKey: abortFixture.migration.grantKey, reason: "test_abort" });
  assert.deepEqual(await receiptRows(), { messages: [], facts: [], outbox: [] });

  await closeTestDatabase();
  await openTestDatabase("pglite://");
  const canceledFixture = await seedStartingMigration(false);
  const requested = await requestAgentMigrationCancellation({
    agentId: canceledFixture.agent.id,
    migrationRef: canceledFixture.migration.supportRef,
    expectedRevision: canceledFixture.migration.revision,
    initiatedByUserId: canceledFixture.owner.id,
    reason: "test_cancel",
  });
  assert.ok(requested.migration.cancelGeneration);
  assert.ok(requested.migration.cancelTransportGeneration);
  await acknowledgeAgentMigrationCancellation({
    migrationId: canceledFixture.migration.id,
    migrationRef: canceledFixture.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration,
    cancelGeneration: requested.migration.cancelGeneration,
    serverId: canceledFixture.server.id,
    machineId: canceledFixture.sourceMachine.id,
    role: "source",
    outcome: "cleaned",
  });
  const canceled = await acknowledgeAgentMigrationCancellation({
    migrationId: canceledFixture.migration.id,
    migrationRef: canceledFixture.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration,
    cancelGeneration: requested.migration.cancelGeneration,
    serverId: canceledFixture.server.id,
    machineId: canceledFixture.targetMachine.id,
    role: "target",
    outcome: "cleaned",
  });
  assert.equal(canceled.state, "canceled_pre_flip");
  assert.deepEqual(
    (await receiptRows()).outbox.map((row) => row.receiptKind),
    ["canceled"],
  );
});

test("receipt copy conditionally names key workspace entries and never serializes metadata", () => {
  const noEntries = formatAgentMigrationCompletedReceipt({
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    summary: {
      includedFileCount: 0,
      includedBytes: 0,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
    },
  });
  assert.match(noEntries, /Moved from Source to Target/);
  assert.doesNotMatch(noEntries, /existed in the workspace/);
  assert.doesNotMatch(noEntries, /sourcePath|ignore|hint|secret|grant/i);
});
