import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY,
  asServerId,
  EXTERNAL_AGENT_RUNTIME_ID,
  MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentMigrationReceiptChannels,
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  machines,
  messages,
  servers,
  users,
} from "../db/schema";
import type { AgentOrchestrator, AgentMessageDeliveryResult } from "./agentOrchestrator";
import { createAgent, deleteAgent } from "./agentService";
import {
  canAgentAccessChannel,
  canUserAccessChannel,
  findOrCreateAgentDM,
  findOrCreateDM,
  listDMChannels,
} from "./channelService";
import { registerMachine } from "./machineService";
import {
  getAgentResumeCatchupMessages,
  listMessages,
} from "./messageService";
import { createServer } from "./serverService";
import { searchMessagesForAgent, searchMessagesForUser } from "./searchService";
import {
  acknowledgeAgentMigrationCancellation,
  agentMigrationGeneration,
  completeAgentMigrationAutoStart,
  markAgentMigrationTargetImportArrived,
  markAgentMigrationTransportLostForComputer,
  recordAgentMigrationAutoStartFailure,
  recordAgentMigrationSourceWorkspaceArchived,
  requestAgentMigrationCancellation,
} from "./agentMigrationService";
import {
  beginTestAgentMigration,
  flipTestAgentMigration,
  markTestAgentMigrationReady,
  startTestAgentMigrationTransfer,
} from "../test/agentMigrationFixture";
import {
  AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS,
  agentMigrationReceiptRetryDelayMs,
  drainAgentMigrationReceiptOutbox,
  formatAgentMigrationCompletedReceipt,
  formatHostedMigrationCompletedReceipt,
  formatReceiptBytes,
  formatAgentMigrationTerminalReceipt,
} from "./agentMigrationReceiptService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withChannelDelivery } from "../test/orchestratorStub";


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
  machineStatus: (machineId: string) => "online" | "offline" = () => "online",
): AgentOrchestrator {
  return withChannelDelivery({
    deliverMessage: deliver,
    getMachineStatus: async (machineId: string) => machineStatus(machineId),
  }) as unknown as AgentOrchestrator;
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
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: owner.id,
    now: startedAt,
  });
  const { migration } = provisioning;
  assert.ok(migration.receiptChannelId);
  if (!driveToStarting) {
    return { owner, server, sourceMachine, targetMachine, agent, receiptChannelId: migration.receiptChannelId, migration };
  }
  await markTestAgentMigrationReady(provisioning, {
    now: new Date("2026-07-20T12:01:00.000Z"),
    transferSummary: TRANSFER_SUMMARY,
  });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-20T12:02:00.000Z"));
  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-20T12:03:00.000Z"));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: arriving.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-20T12:03:30.000Z"),
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    migrationId: arriving.id,
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

test("deleteAgent succeeds for a migrated agent and leaves receipt surfaces intact", async ({ db }) => {
  const fixture = await seedStartingMigration(false);
  const peer = await createAgent(fixture.server.id, "receipt-peer", { runtime: "codex" });
  const dm = await findOrCreateAgentDM(fixture.server.id, fixture.agent.id, peer.id);
  assert.ok(dm, "expected an agent-to-agent DM");

  await deleteAgent(fixture.agent.id);

  const [deleted] = await db.select({
    deletedAt: agents.deletedAt,
    status: agents.status,
  }).from(agents).where(eq(agents.id, fixture.agent.id));
  assert.ok(deleted?.deletedAt, "agent should be soft-deleted");
  assert.equal(deleted?.status, "inactive");

  const receipts = await db.select().from(agentMigrationReceiptChannels)
    .where(eq(agentMigrationReceiptChannels.agentId, fixture.agent.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.channelId, fixture.receiptChannelId);

  const [receiptChannel] = await db.select({
    deletedAt: channels.deletedAt,
  }).from(channels).where(eq(channels.id, fixture.receiptChannelId));
  assert.equal(receiptChannel?.deletedAt, null);

  const receiptMembership = await db.select().from(channelAgents).where(and(
    eq(channelAgents.agentId, fixture.agent.id),
    eq(channelAgents.channelId, fixture.receiptChannelId),
  ));
  assert.equal(receiptMembership.length, 1);

  const leftoverPeerDm = await db.select().from(channelAgents).where(and(
    eq(channelAgents.agentId, fixture.agent.id),
    eq(channelAgents.channelId, dm.id),
  ));
  assert.equal(leftoverPeerDm.length, 0);
});

test("authoritative completion atomically persists one private frozen-name receipt", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await getDb().delete(machines).where(eq(machines.id, fixture.sourceMachine.id));
  await getDb().update(machines)
    .set({ name: "Renamed Target" })
    .where(eq(machines.id, fixture.targetMachine.id));

  const completed = await completeAgentMigrationAutoStart({
    migrationId: fixture.migration.id,
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
    historyCutoff: undefined,
  });
  assert.equal(agentSearch.results.length, 1);
  assert.equal(agentSearch.results[0]!.channelId, fixture.receiptChannelId);
  const agentRead = await listMessages(fixture.receiptChannelId, 10);
  assert.deepEqual(agentRead.map((message) => message.id), [rows.messages[0]!.id]);
  // The fixture clock dates the receipt 2026-07-20; the chain drops a free-plan
  // conversation whose latest message is older than 30 days, so lift the window.
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fixture.server.id));
  const reconnect = await getAgentResumeCatchupMessages(fixture.agent.id, undefined, { chain: await referenceAgentInboxChain(fixture.agent.id) });
  assert.deepEqual(
    reconnect.messages.map((message) => message.message_id),
    [rows.messages[0]!.id],
  );
  const humanSearch = await searchMessagesForUser({
    serverId: fixture.server.id,
    userId: fixture.owner.id,
    query: "Migration",
    historyCutoff: undefined,
  });
  assert.equal(humanSearch.results.length, 0);

  const duplicate = await completeAgentMigrationAutoStart({
    migrationId: fixture.migration.id,
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
      migrationId: fixture.migration.id,
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
    migrationId: fixture.migration.id,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
    now: new Date("2026-07-20T12:06:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  const duplicate = await completeAgentMigrationAutoStart({
    migrationId: fixture.migration.id,
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
  const failed = await markAgentMigrationTransportLostForComputer({
    migrationId: failedFixture.migration.id,
    serverId: failedFixture.server.id,
    machineId: failedFixture.targetMachine.id,
    message: "transport disappeared",
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.equal(failed.state, "failed");
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
    migrationId: fixture.migration.id,
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
    migrationId: fixture.migration.id,
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
  // The fixture's local surface row lives in another server than the agent's
  // (the raw-join trap above), and canAgentAccessChannel is pinned to the
  // channel's own server: the receipt resolves through joint scope, but no
  // channel read widens to it either.
  assert.equal(await canAgentAccessChannel(fixture.receiptChannelId, fixture.agent.id), false);
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
      migrationId: fixture.migration.id,
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
    migrationId: fixture.migration.id,
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
    migrationId: fixture.migration.id,
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

  const t0 = new Date();
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({ io: fakeIo(socketTargets), orchestrator, now: t0 }), {
    attempted: 1,
    sent: 0,
    failed: 1,
  });
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({
    io: fakeIo(socketTargets),
    orchestrator,
    now: new Date(t0.getTime() + 5_000),
    afterBroadcast: () => {
      throw new Error("simulated_server_crash");
    },
  }), {
    attempted: 1,
    sent: 0,
    failed: 1,
  });
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({
    io: fakeIo(socketTargets),
    orchestrator,
    now: new Date(t0.getTime() + 15_000),
  }), {
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

async function seedPendingCompletedReceipt() {
  const fixture = await seedStartingMigration();
  await completeAgentMigrationAutoStart({
    migrationId: fixture.migration.id,
    agentId: fixture.agent.id,
    targetMachineId: fixture.targetMachine.id,
  });
  const [row] = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, fixture.migration.id));
  assert.ok(row);
  return { fixture, row };
}

async function outboxRow(id: string) {
  const [row] = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.id, id));
  assert.ok(row);
  return row;
}

test("outbox skips rows whose computer is offline without spending attempts", async ({ db }) => {
  const { fixture, row } = await seedPendingCompletedReceipt();
  let online = false;
  let deliveries = 0;
  const statusChecks: string[] = [];
  const orchestrator = fakeOrchestrator(async () => {
    deliveries += 1;
    return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
  }, (machineId) => {
    statusChecks.push(machineId);
    return online ? "online" : "offline";
  });
  const t0 = new Date(row.updatedAt.getTime() + 1_000);

  for (let tick = 0; tick < 3; tick += 1) {
    assert.deepEqual(await drainAgentMigrationReceiptOutbox({
      io: fakeIo(),
      orchestrator,
      now: new Date(t0.getTime() + tick * 5_000),
    }), { attempted: 0, sent: 0, failed: 0 });
  }
  assert.equal(deliveries, 0);
  assert.deepEqual(new Set(statusChecks), new Set([fixture.targetMachine.id]), "checks the agent's current computer");
  const idle = await outboxRow(row.id);
  assert.equal(idle.attemptCount, 0);
  assert.equal(idle.status, "pending");
  assert.equal(idle.updatedAt.getTime(), row.updatedAt.getTime(), "a skipped row is not written");

  // Back online: delivered at once, failure counted.
  online = true;
  const t1 = new Date(t0.getTime() + 60_000);
  assert.deepEqual(await drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator, now: t1 }), {
    attempted: 1,
    sent: 0,
    failed: 1,
  });
  assert.equal((await outboxRow(row.id)).attemptCount, 1);

  // Offline again: the earlier failure is forgotten (one write), then the row idles.
  online = false;
  await drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator, now: new Date(t1.getTime() + 10_000) });
  const reset = await outboxRow(row.id);
  assert.equal(reset.attemptCount, 0);
  await drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator, now: new Date(t1.getTime() + 20_000) });
  assert.equal((await outboxRow(row.id)).updatedAt.getTime(), reset.updatedAt.getTime());
  assert.equal(deliveries, 1);
});

test("outbox delivers to an agent that moved to the cloud without a computer or queue receipt", async ({ db }) => {
  const { fixture, row } = await seedPendingCompletedReceipt();
  await db.update(agents).set({ machineId: null, runtime: EXTERNAL_AGENT_RUNTIME_ID }).where(eq(agents.id, fixture.agent.id));
  const statusChecks: string[] = [];
  const orchestrator = fakeOrchestrator(async () => ({ status: "dropped", reason: "cross_replica_receipt_unavailable" }), (machineId) => {
    statusChecks.push(machineId);
    return "offline";
  });
  const result = await drainAgentMigrationReceiptOutbox({ io: fakeIo(), orchestrator, now: new Date(row.updatedAt.getTime() + 1_000) });
  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.deepEqual(statusChecks, [], "a cloud agent has no computer to check");
  assert.equal((await outboxRow(row.id)).status, "sent");
});

test("outbox backs off exponentially, parks after the cap with one report, and revives after the computer returns", async ({ db }) => {
  const { row } = await seedPendingCompletedReceipt();
  let online = true;
  let deliveries = 0;
  const orchestrator = fakeOrchestrator(async () => {
    deliveries += 1;
    return { status: "dropped", reason: "cross_replica_receipt_unavailable" };
  }, () => (online ? "online" : "offline"));
  const exhausted: Array<{ outboxId: string; attemptCount: number; lastError: string | null }> = [];
  const drain = (now: Date) => drainAgentMigrationReceiptOutbox({
    io: fakeIo(),
    orchestrator,
    now,
    onRetryExhausted: (parked) => exhausted.push(parked),
  });

  assert.equal(agentMigrationReceiptRetryDelayMs(1), 5_000);
  assert.equal(agentMigrationReceiptRetryDelayMs(2), 10_000);
  assert.equal(agentMigrationReceiptRetryDelayMs(7), 300_000);
  assert.equal(agentMigrationReceiptRetryDelayMs(19), 300_000);

  let now = new Date(row.updatedAt.getTime() + 1_000);
  assert.equal((await drain(now)).attempted, 1);
  for (let attempts = 1; attempts < AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS; attempts += 1) {
    const delay = agentMigrationReceiptRetryDelayMs(attempts);
    assert.equal((await drain(new Date(now.getTime() + delay - 1))).attempted, 0, `still backing off after ${attempts}`);
    now = new Date(now.getTime() + delay);
    assert.equal((await drain(now)).attempted, 1, `retried after ${attempts}`);
  }
  assert.equal(deliveries, AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS);
  const parked = await outboxRow(row.id);
  assert.equal(parked.status, "pending");
  assert.equal(parked.attemptCount, AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS);
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]!.outboxId, row.id);
  assert.equal(exhausted[0]!.attemptCount, AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS);
  assert.match(exhausted[0]!.lastError ?? "", /cross_replica_receipt_unavailable/);

  // Parked: no more attempts, however long it waits, while the computer stays up.
  assert.equal((await drain(new Date(now.getTime() + 24 * 60 * 60_000))).attempted, 0);
  assert.equal(exhausted.length, 1);

  // The computer drops and comes back: the row gets a fresh budget.
  online = false;
  await drain(new Date(now.getTime() + 25 * 60 * 60_000));
  assert.equal((await outboxRow(row.id)).attemptCount, 0);
  online = true;
  assert.equal((await drain(new Date(now.getTime() + 26 * 60 * 60_000))).attempted, 1);
  assert.equal(deliveries, AGENT_MIGRATION_RECEIPT_MAX_ATTEMPTS + 1);
});

test("concurrent outbox drainers claim one row and dispatch once", async ({ db }) => {

  const fixture = await seedStartingMigration();
  await completeAgentMigrationAutoStart({
    migrationId: fixture.migration.id,
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

test("auto-start-failed migrations create no receipt while failed and canceled terminalize with one receipt", async ({ db }) => {

  const failedFixture = await seedStartingMigration();
  await recordAgentMigrationAutoStartFailure({
    migrationId: failedFixture.migration.id,
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

test("legacy migrations without a transfer summary still get a completed receipt", () => {
  const legacy = formatAgentMigrationCompletedReceipt({
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    summary: null,
  });
  assert.match(legacy, /Migration completed\. Moved from Source to Target\./);
  assert.match(legacy, /Transfer details are unavailable for this legacy migration\./);
  assert.doesNotMatch(legacy, /Moved \d+ files/);
});

test("completed receipt lists paths left out by .raftmigrateignore and where to recover them", () => {
  const summary = {
    includedFileCount: 3,
    includedBytes: 30,
    excludedRegenerableCount: 0,
    excludedRegenerableByCategory: {
      thirdPartyDependencies: 0,
      caches: 0,
      buildArtifacts: 0,
      otherRegenerable: 0,
    },
    keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
  };
  const text = formatAgentMigrationCompletedReceipt({
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    summary: {
      ...summary,
      excludedIgnored: {
        count: 2,
        fileCount: 7,
        bytes: 1_050,
        largest: [{ path: "datasets", bytes: 1_000 }, { path: "cache.sqlite", bytes: 50 }],
      },
    },
  });
  assert.match(text, /Not moved, as listed in \.raftmigrateignore: 2 paths, 7 files \(1 KB\); largest: datasets \(1000 bytes\), cache\.sqlite \(50 bytes\)\./);
  assert.match(text, /archived on Source and kept for up to 7 days, so anything missing can be recovered from there\./);
  assert.match(text, /按 \.raftmigrateignore 未迁移：2 个路径/);
  assert.match(text, /旧工作区归档在 Source 上，最多保留 7 天，缺了可以从那里找回。/);
  assert.doesNotMatch(text, /30 (?:days|天)/);
  const withoutIgnores = formatAgentMigrationCompletedReceipt({
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    summary,
  });
  assert.doesNotMatch(withoutIgnores, /raftmigrateignore|kept for up to/);
});

test("hosted completed receipt promises the 7-day archive only when files were left out", () => {
  const base = { sourceMachineName: "Source", supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA" };
  const skipped = formatHostedMigrationCompletedReceipt({
    ...base,
    summary: {
      importedFileCount: 3,
      importedBytes: 300,
      skipped: [{ reason: "file_too_large", count: 1, bytes: 2_048, largestPaths: ["video.mp4"] }],
    },
  });
  assert.match(skipped, /The old workspace is archived on Source and kept for up to 7 days, so anything missing can be recovered from there\./);
  assert.doesNotMatch(skipped, /30 days/);
  assert.doesNotMatch(formatHostedMigrationCompletedReceipt({ ...base, summary: null }), /kept for up to/);
});

test("completed receipt names each ignore file and marks a count at the bound as a lower bound", () => {
  const base = {
    includedFileCount: 3,
    includedBytes: 30,
    excludedRegenerableCount: 0,
    excludedRegenerableByCategory: {
      thirdPartyDependencies: 0,
      caches: 0,
      buildArtifacts: 0,
      otherRegenerable: 0,
    },
    keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
  };
  const none = { count: 0, fileCount: 0, bytes: 0 };
  const receipt = (summary: Parameters<typeof formatAgentMigrationCompletedReceipt>[0]["summary"]) =>
    formatAgentMigrationCompletedReceipt({
      sourceMachineName: "Source",
      targetMachineName: "Target",
      supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
      summary,
    });

  const twoFiles = receipt({
    ...base,
    excludedIgnored: { count: 4, fileCount: 9, bytes: 2_048, largest: [] },
    excludedIgnoredBySource: {
      userFile: none,
      agentFile: { count: 3, fileCount: 8, bytes: 2_000 },
      legacyFile: { count: 1, fileCount: 1, bytes: 48 },
      wildcard: { count: 2, fileCount: 6, bytes: 1_500 },
    },
  });
  assert.match(twoFiles, /Not moved, as listed in \.raftbackupignore and \.raftmigrateignore: 4 paths \(\.raftbackupignore 3, \.raftmigrateignore 1; of which 2 through \*\*\/ patterns\), 9 files \(2 KB\)\./);
  assert.match(twoFiles, /按 \.raftbackupignore 和 \.raftmigrateignore 未迁移：4 个路径（\.raftbackupignore 3，\.raftmigrateignore 1；其中 2 个来自 \*\*\/ 通配），9 个文件（2 KB）。/);
  assert.doesNotMatch(twoFiles, /at least|至少/);

  const oneFile = receipt({
    ...base,
    excludedIgnored: { count: 2, fileCount: 5, bytes: 10, largest: [] },
    excludedIgnoredBySource: {
      userFile: none,
      agentFile: { count: 2, fileCount: 5, bytes: 10 },
      legacyFile: none,
      wildcard: none,
    },
  });
  assert.match(oneFile, /Not moved, as listed in \.raftbackupignore: 2 paths, 5 files \(10 bytes\)\./);
  assert.doesNotMatch(oneFile, /raftmigrateignore|patterns/);

  const allFiles = receipt({
    ...base,
    excludedIgnored: { count: 3, fileCount: 1, bytes: 1, largest: [] },
    excludedIgnoredBySource: {
      userFile: { count: 1, fileCount: 1, bytes: 1 },
      agentFile: { count: 1, fileCount: 0, bytes: 0 },
      legacyFile: { count: 1, fileCount: 0, bytes: 0 },
      wildcard: none,
    },
  });
  assert.match(allFiles, /as listed in \.raftbackupignore\.user, \.raftbackupignore and \.raftmigrateignore: 3 paths \(\.raftbackupignore\.user 1, \.raftbackupignore 1, \.raftmigrateignore 1\), 1 file \(1 bytes\)\./);
  assert.match(allFiles, /按 \.raftbackupignore\.user、\.raftbackupignore 和 \.raftmigrateignore 未迁移/);

  const wildcardOnly = receipt({
    ...base,
    excludedIgnored: { count: 4, fileCount: 4, bytes: 4, largest: [] },
    excludedIgnoredBySource: {
      userFile: none,
      agentFile: { count: 4, fileCount: 4, bytes: 4 },
      legacyFile: none,
      wildcard: { count: 2, fileCount: 2, bytes: 2 },
    },
  });
  assert.match(wildcardOnly, /as listed in \.raftbackupignore: 4 paths \(2 through \*\*\/ patterns\), 4 files/);
  assert.match(wildcardOnly, /4 个路径（其中 2 个来自 \*\*\/ 通配），4 个文件/);

  const atBound = receipt({
    ...base,
    excludedIgnored: { count: 1, fileCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT, bytes: 3 * 1024 ** 3, largest: [] },
  });
  assert.match(atBound, new RegExp(`as listed in \\.raftmigrateignore: 1 path, at least ${MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT} files \\(3 GB or more\\)\\.`));
  assert.match(atBound, new RegExp(`至少 ${MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT} 个文件（3 GB 以上）`));
});

test("receipt sizes are readable binary units", () => {
  assert.equal(formatReceiptBytes(0), "0 bytes");
  assert.equal(formatReceiptBytes(1023), "1023 bytes");
  assert.equal(formatReceiptBytes(1536), "1.5 KB");
  assert.equal(formatReceiptBytes(2.3 * 1024 ** 3), "2.3 GB");
  assert.equal(formatReceiptBytes(42 * 1024 ** 2 + 1), "42 MB");
});

test("completed receipt notes pending source cleanup only while the archive is outstanding", () => {
  const base = {
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    summary: null,
  };
  assert.match(
    formatAgentMigrationCompletedReceipt({ ...base, sourceCleanupPending: true }),
    /The old copy on Source is still being cleaned up in the background/,
  );
  assert.doesNotMatch(formatAgentMigrationCompletedReceipt(base), /cleaned up/);
});

test("aborted receipt names the deadline and releases the migration gate", () => {
  const text = formatAgentMigrationTerminalReceipt({
    kind: "aborted",
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    reason: "prep-deadline",
  });
  assert.match(text, /^Migration aborted\. The migration from Source to Target ran out of time/);
  assert.match(text, /Reason: prep-deadline\./);
  assert.match(text, /no longer the active gate/);
  assert.match(text, /You are still on Source; your workspace there was not changed\./);
});

test("failed receipt says where the agent is now", () => {
  const base = {
    kind: "failed" as const,
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    reason: "MIGRATION_TRANSPORT_LOST",
  };
  const beforeFlip = formatAgentMigrationTerminalReceipt({ ...base, flipped: false });
  assert.match(beforeFlip, /\nYou are still on Source; your workspace there was not changed\.\n/);
  assert.match(beforeFlip, /This migration has ended; a new migration can be started separately\./);
  const afterFlip = formatAgentMigrationTerminalReceipt({ ...base, reason: "auto_start_failed", flipped: true });
  assert.match(afterFlip, /\nYour workspace is now on Target\.\n/);
  assert.doesNotMatch(afterFlip, /still on Source/);
});

test("failed receipt states the measured workspace size for size-limit failures only", () => {
  const base = {
    kind: "failed" as const,
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    reason: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  };
  const entries = formatAgentMigrationTerminalReceipt({
    ...base,
    detail: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=1060088:maxEntries=250000:topPathCounts=worktrees%2F,565351;repos%2F,293174;bad%0A,1",
  });
  assert.match(entries, /The workspace has 1060088 files and folders; the limit is 250000\. Largest: worktrees\/ \(565351\), repos\/ \(293174\)\./);
  assert.match(entries, /To move it, delete what you no longer need or list it in \.raftmigrateignore \(listed paths are not moved\), then ask for the migration to be retried\./);

  const bytes = formatAgentMigrationTerminalReceipt({
    ...base,
    detail: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=12884901888:maxBytes=10737418240:topEntries=data%2F,8589934592",
  });
  assert.match(bytes, /The workspace is over the 10 GB limit\. Largest, before compression: data\/ \(8 GB\)\./);
  assert.match(bytes, /list it in \.raftmigrateignore/);

  for (const detail of [null, "MIGRATION_TRANSPORT_LOST", "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=x"]) {
    assert.doesNotMatch(formatAgentMigrationTerminalReceipt({ ...base, detail }), /raftmigrateignore/);
  }
});

test("a size failure names .raftbackupignore only for a source that advertises the user-ignore capability", () => {
  const base = {
    kind: "failed" as const,
    sourceMachineName: "Source",
    targetMachineName: "Target",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    reason: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    detail: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=12884901888:maxBytes=10737418240:topEntries=data%2F,8589934592",
  };
  const oldWording = "To move it, delete what you no longer need or list it in .raftmigrateignore (listed paths are not moved), then ask for the migration to be retried.";
  const newWording = "To move it, delete what you no longer need or list it in .raftbackupignore (listed paths are not moved; a `**/<name>` line skips every folder with that name), then ask for the migration to be retried.";

  const newer = formatAgentMigrationTerminalReceipt({
    ...base,
    sourceCapabilities: [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY],
  });
  assert.ok(newer.split("\n").includes(newWording), newer);
  assert.doesNotMatch(newer, /raftmigrateignore/);

  // Older sources, and callers that don't know the source's capabilities, keep today's wording exactly.
  for (const sourceCapabilities of [undefined, null, [], [AGENT_MIGRATION_CAPABILITY]]) {
    const text = formatAgentMigrationTerminalReceipt({ ...base, sourceCapabilities });
    assert.ok(text.split("\n").includes(oldWording), text);
    assert.doesNotMatch(text, /raftbackupignore/);
  }

  // Not a size failure: no ignore file named, whatever the source supports.
  assert.doesNotMatch(
    formatAgentMigrationTerminalReceipt({ ...base, detail: "MIGRATION_TRANSPORT_LOST", sourceCapabilities: [AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY] }),
    /raftbackupignore|raftmigrateignore/,
  );
});

test("failed size receipt offers the agent's own retry only when the source supports it and this was not the retry", () => {
  const base = {
    kind: "failed" as const,
    sourceMachineName: "Source",
    targetMachineName: "Studio",
    supportRef: "mig_AAAAAAAAAAAAAAAAAAAAAA",
    reason: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    detail: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=1060088:maxEntries=250000:topPathCounts=worktrees%2F,565351",
  };
  const retryable = formatAgentMigrationTerminalReceipt({ ...base, sourceCapabilities: [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY] });
  assert.match(retryable, /list it in \.raftmigrateignore \(listed paths are not moved\), then run `raft migration retry` \(once; it moves you to Studio again\)\./);
  assert.doesNotMatch(retryable, /ask for the migration to be retried/);
  // A source with both capabilities names .raftbackupignore and the retry command together.
  const both = formatAgentMigrationTerminalReceipt({ ...base, sourceCapabilities: [AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY] });
  assert.match(both, /list it in \.raftbackupignore \(listed paths are not moved; a `\*\*\/<name>` line skips every folder with that name\), then run `raft migration retry` \(once; it moves you to Studio again\)\./);

  // A source without the capability (or unknown capabilities): the wording every version supports.
  for (const sourceCapabilities of [[AGENT_MIGRATION_CAPABILITY], null, undefined]) {
    const text = formatAgentMigrationTerminalReceipt({ ...base, sourceCapabilities });
    assert.match(text, /then ask for the migration to be retried\./);
    assert.doesNotMatch(text, /raft migration retry/);
  }

  // The failed migration was the agent's one retry: a person starts the next one.
  const retryFailed = formatAgentMigrationTerminalReceipt({ ...base, sourceCapabilities: [AGENT_MIGRATION_AGENT_RETRY_CAPABILITY], isRetry: true });
  assert.match(retryFailed, /list it in \.raftmigrateignore \(listed paths are not moved\)\. The automatic retry also failed; a person needs to start the next migration\./);
  assert.doesNotMatch(retryFailed, /raft migration retry|ask for the migration to be retried/);
  // A retry that failed for another reason says so too.
  const retryLost = formatAgentMigrationTerminalReceipt({ ...base, reason: "MIGRATION_TRANSPORT_LOST", detail: "MIGRATION_TRANSPORT_LOST", isRetry: true });
  assert.match(retryLost, /^The automatic retry also failed; a person needs to start the next migration\.$/m);
});
