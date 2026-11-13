import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_DEFAULT_CHUNK_BYTES,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_MAX_MS,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  BasicTracer,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  MemoryTraceSink,
  type AgentMigrationControlManifest,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agentMigrationHostedTargets,
  agentMigrationReceiptChannels,
  agentMigrationReceiptOutbox,
  agentMigrations,
  agentRuntimeProfiles,
  agents,
  channelAgents,
  channels,
  machines,
  servers,
  users,
} from "../db/schema";
import {
  AGENT_MIGRATION_AUTO_START_LEASE_MS,
  AGENT_MIGRATION_MAX_DURATION_MS,
  AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS,
  AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS,
  AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS,
  DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES,
  agentMigrationGeneration,
  agentMigrationTransportLostCode,
  beginAgentMigrationProvisioning,
  buildAgentMigrationCancellationDeliveries,
  claimAgentMigrationAutoStartRemediation,
  claimAgentMigrationCancellationCleanup,
  completeAgentMigrationResumableUpload,
  completeAgentMigrationAutoStart,
  createAgentMigrationLifecycleEvent,
  evaluateAgentMigrationTransferLeaseReady,
  getActiveAgentMigration,
  getAgentMigrationGateStatus,
  getLatestAgentMigration,
  markAgentMigrationTargetImportArrived,
  markAgentMigrationTransportLostForComputer,
  planZenMigratingDelivery,
  getAgentMigrationResumableControl,
  planAgentMigrationChunkTransfers,
  projectAgentMigrationUpdatedPayload,
  provisionAgentMigrationObjectStoreTransfer,
  getAgentMigrationTransferProgress,
  recordAgentMigrationChunkReceipt,
  recordAgentMigrationSourceWorkspaceArchived,
  recordAgentMigrationSourceBuildProgress,
  recordAgentMigrationSourceQuiesced,
  sourceBuildProgressOf,
  sourceDrainOf,
  recordAgentMigrationAutoStartFailure,
  requestAgentMigrationCancellation,
  acknowledgeAgentMigrationCancellation,
  prepareAgentMigrationStreamedChunk,
  registerAgentMigrationControlManifest,
  sweepElapsedAgentMigrationDeadline,
  AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_ATTEMPTS,
  claimAgentMigrationSourceArchiveRetry,
  recordAgentMigrationSourceArchiveAttemptFailed,
  recordAgentMigrationSourceWorkspaceArchivedById,
  AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS,
  reprovisionAgentMigrationTransport,
  reissueAgentMigrationTargetLease,
  agentMigrationLostRunRecovery,
  isComputerTargetMigration,
  requireComputerTarget,
} from "./agentMigrationService";
import {
  beginTestAgentMigration,
  flipTestAgentMigration,
  markTestAgentMigrationReady,
  startTestAgentMigrationTransfer,
} from "../test/agentMigrationFixture";
import {
  drainAgentMigrationRemediation,
  startAgentMigrationRemediationWorker,
} from "./agentMigrationRemediationWorker";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createMessage, deliverMessageToAgent } from "./messageService";
import type { ReplicaStateStore } from "./replicaStateStore";


afterEach(async () => {
  vi.useRealTimers();
  await closeTestDatabase();
});

const TEST_TRANSFER_SUMMARY = {
  includedFileCount: 2,
  includedBytes: 128,
  excludedRegenerableCount: 4,
  excludedRegenerableByCategory: {
    thirdPartyDependencies: 1,
    caches: 1,
    buildArtifacts: 1,
    otherRegenerable: 1,
  },
  keyWorkspaceEntries: {
    memoryMdPresent: true,
    notesPresent: true,
  },
} as const;

type MigrationSnapshot = Pick<typeof agentMigrations.$inferSelect,
  | "state"
  | "revision"
  | "failureReason"
  | "autoStartFailureStage"
  | "autoStartFailureCode"
  | "autoStartRetryAttempts"
  | "autoStartRetryDeadlineAt"
  | "autoStartLastRetryAt"
  | "autoStartRemediationLeaseId"
  | "autoStartRemediationLeaseExpiresAt"
  | "cancelDispatchAttempts"
  | "cancelLastDispatchAt"
  | "cancelAttentionDeadlineAt"
  | "cancelCleanupLeaseId"
  | "cancelCleanupLeaseExpiresAt"
  | "updatedAt"
  | "completedAt"
  | "transportTeardownAt"
>;

function migrationSnapshot(row: typeof agentMigrations.$inferSelect): MigrationSnapshot {
  return {
    state: row.state,
    revision: row.revision,
    failureReason: row.failureReason,
    autoStartFailureStage: row.autoStartFailureStage,
    autoStartFailureCode: row.autoStartFailureCode,
    autoStartRetryAttempts: row.autoStartRetryAttempts,
    autoStartRetryDeadlineAt: row.autoStartRetryDeadlineAt,
    autoStartLastRetryAt: row.autoStartLastRetryAt,
    autoStartRemediationLeaseId: row.autoStartRemediationLeaseId,
    autoStartRemediationLeaseExpiresAt: row.autoStartRemediationLeaseExpiresAt,
    cancelDispatchAttempts: row.cancelDispatchAttempts,
    cancelLastDispatchAt: row.cancelLastDispatchAt,
    cancelAttentionDeadlineAt: row.cancelAttentionDeadlineAt,
    cancelCleanupLeaseId: row.cancelCleanupLeaseId,
    cancelCleanupLeaseExpiresAt: row.cancelCleanupLeaseExpiresAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    transportTeardownAt: row.transportTeardownAt,
  };
}

function fakeIo() {
  return { to: () => ({ emit: () => {} }) };
}

function makeFakeMachineWs() {
  return {
    readyState: 1,
    send: () => {},
    close() {
      this.readyState = 3;
    },
    terminate() {
      this.readyState = 3;
    },
  };
}

function makeAvailableReplicaStateStore(): ReplicaStateStore {
  let statusVersion = 0;

  return {
    isAvailable: () => true,
    registerMachineReplica: async () => "test-generation",
    restoreMachineReplicaGeneration: async () => {},
    unregisterMachineReplica: async () => {},
    refreshMachineReplica: async () => {},
    hasMachineReplica: async () => true,
    getMachineReplicaOwner: async () => "test-replica",
    bumpMachineStatusVersion: async () => {
      statusVersion += 1;
      return statusVersion;
    },
    getMachineStatusVersion: async () => statusVersion,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => {},
    setAgentActivity: async () => {},
    getAgentActivity: async () => null,
    getWakeCrashLoopState: async () => null,
    compareAndSetWakeCrashLoopState: async () => true,
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
    setAgentContextViewAvailability: async () => {},
    getAgentContextViewAvailability: async () => null,
    clearAgentContextViewAvailability: async () => {},
    setMachineMeta: async () => {},
    getMachineMeta: async () => null,
    clearMachineMeta: async () => {},
  };
}

class TestAgentOrchestrator extends AgentOrchestrator {
  readonly deliverMessageCalls: string[] = [];

  constructor() {
    super(makeAvailableReplicaStateStore());
  }

  override deliverMessage(
    agentId: Parameters<AgentOrchestrator["deliverMessage"]>[0],
    message: Parameters<AgentOrchestrator["deliverMessage"]>[1],
    options: Parameters<AgentOrchestrator["deliverMessage"]>[2] = {},
  ): ReturnType<AgentOrchestrator["deliverMessage"]> {
    assert.ok(message.message_id);
    this.deliverMessageCalls.push(message.message_id);
    return super.deliverMessage(agentId, message, options);
  }

  protected override async sendAgentDeliveryWithAckRetry(
    _machineId: string,
    _msg: Extract<ServerToMachineMessage, { type: "agent:deliver" }>,
    _errorContext: string,
  ): Promise<boolean> {
    return true;
  }
}

/** Whether ordinary deliveries to the agent are queued behind its active migration. */
async function zenMigrating(agentId: string, now?: Date): Promise<boolean> {
  const migration = await getActiveAgentMigration(agentId, getDb(), now);
  return planZenMigratingDelivery({ migration, now }).action === "queue";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedMigrationFixture() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "migration-owner@example.com",
    name: "migration-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Migration Server",
    slug: "migration-server",
    ownerId: user.id,
  }).returning();
  const [sourceMachine] = await db.insert(machines).values({
    id: "33333333-3333-3333-3333-333333333333",
    serverId: server.id,
    userId: user.id,
    name: "source-mac",
    apiKeyHash: "hash-source",
  }).returning();
  const [targetMachine] = await db.insert(machines).values({
    id: "44444444-4444-4444-4444-444444444444",
    serverId: server.id,
    userId: user.id,
    name: "target-mac",
    apiKeyHash: "hash-target",
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: "55555555-5555-5555-5555-555555555555",
    serverId: server.id,
    name: "migration-agent",
    status: "active",
    sessionId: "source-native-session",
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
    machineId: sourceMachine.id,
  }).returning();
  return { user, server, sourceMachine, targetMachine, agent };
}

test("progress slides the transfer and arrival deadlines, never past six hours from creation", async ({ db }) => {
  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T17:00:00.000Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const minutes = (count: number) => count * 60 * 1000;
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-deadline-slide",
  });
  // The lease outlives the longest migration; the deadlines stop a stalled one.
  assert.equal(provisioned.migration.transportExpiresAt?.getTime(), at(AGENT_MIGRATION_MAX_DURATION_MS).getTime());
  assert.equal(provisioned.migration.transferDeadlineAt.getTime(), at(minutes(60)).getTime());
  const arrivalWindow = provisioned.migration.arrivalDeadlineAt.getTime() - provisioned.migration.transferDeadlineAt.getTime();
  const sourceActor = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    transportToken: provisioned.source.message.bearerToken,
  };
  const generation = provisioned.source.message.transportGeneration!;
  await recordAgentMigrationSourceQuiesced({
    ...sourceActor,
    receipt: {
      schemaVersion: "agent-migration-quiesce/v1",
      migrationId: provisioned.migration.id,
      migrationGeneration: generation,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      sourceRuntimeState: "stopped",
      stoppedAt: at(1_000).toISOString(),
      actor: "migration",
      launchSessionIdentity: "launch:launch-1:session:session-1",
      expectedRuntimeRevision: String(provisioned.source.message.expectedMigrationRevision),
    },
    now: at(1_000),
  });
  let files = 0;
  const progressAt = async (ms: number) => {
    files += 1;
    const result = await recordAgentMigrationSourceBuildProgress({
      ...sourceActor,
      report: { migrationGeneration: generation, phase: "packing", files, bytes: files },
      now: at(ms),
    });
    assert.equal(result.advanced, true);
    return result.migration;
  };

  const early = await progressAt(minutes(20));
  assert.equal(early.transferDeadlineAt.getTime(), at(minutes(60)).getTime(), "progress never shortens the transfer deadline");
  const late = await progressAt(minutes(55));
  assert.equal(late.transferDeadlineAt.getTime(), at(minutes(85)).getTime(), "one transfer idle window after progress");
  assert.equal(late.arrivalDeadlineAt.getTime() - late.transferDeadlineAt.getTime(), arrivalWindow);
  assert.equal(late.prepDeadlineAt.getTime(), at(minutes(65)).getTime());
  assert.equal(late.revision, early.revision, "sliding deadlines does not bump revision");

  const nearCap = await progressAt(minutes(5 * 60 + 45));
  assert.equal(nearCap.transferDeadlineAt.getTime(), at(AGENT_MIGRATION_MAX_DURATION_MS).getTime(), "capped six hours after creation");
  assert.equal(nearCap.arrivalDeadlineAt.getTime() - nearCap.transferDeadlineAt.getTime(), arrivalWindow);
  const atCap = await progressAt(minutes(5 * 60 + 55));
  assert.equal(atCap.transferDeadlineAt.getTime(), at(AGENT_MIGRATION_MAX_DURATION_MS).getTime());
  assert.equal(atCap.prepDeadlineAt.getTime(), at(AGENT_MIGRATION_MAX_DURATION_MS).getTime(), "prep never outlasts the transfer deadline");
});

test("contract-v1 begin is rejected before migration or receipt-surface mutation", async ({ db: database }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const db = getDb();
  const before = {
    migrations: Number((await db.select({ count: sql`count(*)` }).from(agentMigrations))[0]?.count),
    channels: Number((await db.select({ count: sql`count(*)` }).from(channels))[0]?.count),
    receipts: Number((await db.select({ count: sql`count(*)` }).from(agentMigrationReceiptChannels))[0]?.count),
  };

  await assert.rejects(
    db.insert(agentMigrations).values({
      serverId: server.id,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      targetMachineId: targetMachine.id,
      sourceMachineNameSnapshot: sourceMachine.name,
      targetMachineNameSnapshot: targetMachine.name,
      state: "prep",
      supportRef: "mig_contract_v1_rejected",
      contractVersion: 1,
      grantKey: "contract-v1-rejected",
      prepDeadlineAt: new Date("2026-07-21T01:00:00.000Z"),
      transferDeadlineAt: new Date("2026-07-21T02:00:00.000Z"),
      arrivalDeadlineAt: new Date("2026-07-21T03:00:00.000Z"),
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      error.cause.message.includes(
        "agent_migrations_receipt_contract_version_check",
      ),
  );

  assert.deepEqual({
    migrations: Number((await db.select({ count: sql`count(*)` }).from(agentMigrations))[0]?.count),
    channels: Number((await db.select({ count: sql`count(*)` }).from(channels))[0]?.count),
    receipts: Number((await db.select({ count: sql`count(*)` }).from(agentMigrationReceiptChannels))[0]?.count),
  }, before);
});

async function completeArrivingMigration(input: {
  migrationId: string;
  agentId: string;
  targetMachineId: string;
  initiatedByUserId: string;
  reportPath?: string;
  reportSha256?: string;
  now: Date;
}) {
  const db = getDb();
  const [migration] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, input.migrationId));
  assert.ok(migration);
  await db.update(agentMigrations).set({
    initiatedByUserId: input.initiatedByUserId,
    transferSummary: TEST_TRANSFER_SUMMARY,
  }).where(eq(agentMigrations.id, migration.id));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: input.migrationId,
    migrationGeneration: agentMigrationGeneration(migration),
    serverId: migration.serverId,
    targetMachineId: input.targetMachineId,
    now: input.now,
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    migrationId: input.migrationId,
    migrationGeneration: archived.migrationGeneration,
    serverId: migration.serverId,
    targetMachineId: input.targetMachineId,
    reportPath: input.reportPath,
    reportSha256: input.reportSha256,
    now: input.now,
  });
  assert.equal(arrival.migration.state, "starting");
  return await completeAgentMigrationAutoStart({
    migrationId: input.migrationId,
    agentId: input.agentId,
    targetMachineId: input.targetMachineId,
    now: input.now,
  });
}

async function seedAutoStartFailedMigration(input: {
  now?: Date;
  stage?: "orchestrator" | "start_agent";
  code?: "orchestrator_unavailable" | "start_not_dispatched" | "start_threw";
} = {}) {
  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const startedAt = input.now ?? new Date("2026-07-05T14:00:00.000Z");
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: startedAt,
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date(startedAt.getTime() + 60_000) });
  await startTestAgentMigrationTransfer(migration.id, new Date(startedAt.getTime() + 120_000));
  const arriving = await flipTestAgentMigration(migration.id, new Date(startedAt.getTime() + 180_000));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: migration.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(startedAt.getTime() + 210_000),
  });
  await markAgentMigrationTargetImportArrived({
    migrationId: migration.id,
    migrationGeneration: archived.migrationGeneration,
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(startedAt.getTime() + 240_000),
  });
  const failed = await recordAgentMigrationAutoStartFailure({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    stage: input.stage ?? "start_agent",
    code: input.code ?? "start_not_dispatched",
    now: new Date(startedAt.getTime() + 241_000),
  });
  return { user, server, sourceMachine, targetMachine, agent, migration: failed };
}

test("a daemon's own summary failing validation is reported as such, not as a lost connection", async () => {
  // Kirby's prod message (Computer 1.0.59), as the route stores it.
  const zod = '[\n  {\n    "origin": "number",\n    "code": "too_big",\n    "maximum": 1000000,\n    "inclusive": true,\n    "path": [\n      "excludedIgnored",\n      "fileCount"\n    ]';
  assert.deepEqual(
    agentMigrationTransportLostCode({ code: "MIGRATION_TRANSPORT_LOST", detailCode: "JS_ZodError", message: zod }),
    { failureReason: "MIGRATION_TRANSFER_SUMMARY_INVALID", transportErrorCode: "MIGRATION_TRANSFER_SUMMARY_INVALID" },
  );
  // Any other ZodError, or a summary field named by a different error, keeps today's codes.
  assert.deepEqual(
    agentMigrationTransportLostCode({ code: "MIGRATION_TRANSPORT_LOST", detailCode: "JS_ZodError", message: '"path": ["chunks", 0, "sha256"]' }),
    { failureReason: "MIGRATION_TRANSPORT_LOST", transportErrorCode: "JS_ZodError" },
  );
  assert.deepEqual(
    agentMigrationTransportLostCode({ code: "MIGRATION_TRANSPORT_LOST", detailCode: "FETCH_ECONNRESET", message: zod }),
    { failureReason: "MIGRATION_TRANSPORT_LOST", transportErrorCode: "FETCH_ECONNRESET" },
  );
  assert.deepEqual(
    agentMigrationTransportLostCode({ code: "MIGRATION_OBJECT_STORE_UNREACHABLE" }),
    { failureReason: "MIGRATION_OBJECT_STORE_UNREACHABLE", transportErrorCode: "MIGRATION_OBJECT_STORE_UNREACHABLE" },
  );
});

test("a source that could not write the user's ignore additions keeps its code and reason", () => {
  assert.deepEqual(
    agentMigrationTransportLostCode({ code: "MIGRATION_USER_IGNORE_WRITE_FAILED", detailCode: "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink" }),
    { failureReason: "MIGRATION_USER_IGNORE_WRITE_FAILED", transportErrorCode: "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink" },
  );
});

test("object-store transfer provisioner presigns no whole-bundle URL", async () => {
  const calls: Array<{ kind: string; key: string; expiresIn?: number }> = [];
  const storage = {
    put: async () => undefined,
    get: async () => {
      throw new Error("not used");
    },
    delete: async () => undefined,
    getPresignedPutUrl: async (key: string, options?: { expiresIn?: number }) => {
      calls.push({ kind: "put", key, expiresIn: options?.expiresIn });
      return `https://r2.example.test/${key}?put=1`;
    },
    getPresignedUrl: async (key: string, options?: { expiresIn?: number }) => {
      calls.push({ kind: "get", key, expiresIn: options?.expiresIn });
      return `https://r2.example.test/${key}?get=1`;
    },
  };

  const provision = await provisionAgentMigrationObjectStoreTransfer({
    sessionId: "session-test",
    leaseMs: 120_000,
    maxBytes: 4096,
    storage,
  });
  assert.equal(provision.provider, "object_store");
  assert.equal(provision.sessionId, "session-test");
  assert.equal(provision.maxBytes, 4096);
  assert.deepEqual(calls, [], "chunks are presigned per transfer");
});

test("object-store transfer provisioner defaults to the 10 GiB compressed-bundle cap", async () => {
  const storage = {
    put: async () => undefined,
    get: async () => {
      throw new Error("not used");
    },
    delete: async () => undefined,
    getPresignedPutUrl: async () => "https://r2.example.test/default-cap?put=1",
    getPresignedUrl: async () => "https://r2.example.test/default-cap?get=1",
  };

  const provision = await provisionAgentMigrationObjectStoreTransfer({
    sessionId: "session-default-cap",
    storage,
  });
  assert.equal(DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES, MAX_AGENT_MIGRATION_TRANSPORT_BYTES);
  assert.equal(provision.maxBytes, DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES);
});

test("resumable migration persists the source fence and plans only chunks missing for each side", async ({ db }) => {

  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T14:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-resumable",
    transportLeaseMs: 60 * 60 * 1000,
    transportMaxBytes: 10_000,
  });
  const generation = provisioned.source.message.transportGeneration!;
  const leaseId = provisioned.source.message.leaseId!;
  const expectedRevision = provisioned.source.message.expectedMigrationRevision!;
  assert.equal(expectedRevision, provisioned.migration.transportExpectedMigrationRevision);
  const control: AgentMigrationControlManifest = {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: provisioned.migration.id,
      migrationGeneration: generation,
      leaseId,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      targetMachineId: targetMachine.id,
    },
    capability: { required: [AGENT_MIGRATION_CAPABILITY] },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      totalBytes: 7,
      sha256: "c".repeat(64),
      chunkSizeBytes: 1024 * 1024,
      chunks: [
        { index: 0, offsetBytes: 0, sizeBytes: 4, sha256: "a".repeat(64) },
        { index: 1, offsetBytes: 4, sizeBytes: 3, sha256: "b".repeat(64) },
      ],
    },
    archive: {
      format: "tar+gzip",
      entryCount: 1,
      expandedBytes: 1,
      maxEntryBytes: 1,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: {
      includedFileCount: 1,
      includedBytes: 1,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
      // Stored and returned without loss (newer Computers send the per-source split).
      excludedIgnored: { count: 2, fileCount: 3, bytes: 30, largest: [{ path: "datasets", bytes: 20 }] },
      excludedIgnoredBySource: {
        userFile: { count: 1, fileCount: 1, bytes: 10 },
        agentFile: { count: 1, fileCount: 2, bytes: 20 },
        legacyFile: { count: 0, fileCount: 0, bytes: 0 },
        wildcard: { count: 1, fileCount: 2, bytes: 20 },
      },
    },
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  };
  const sourceActor = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    transportToken: provisioned.source.message.bearerToken,
  };
  await assert.rejects(
    () => registerAgentMigrationControlManifest({ ...sourceActor, control, now: new Date(t0.getTime() + 1_000) }),
    /MIGRATION_SOURCE_NOT_QUIESCED/,
  );
  const receipt = {
    schemaVersion: "agent-migration-quiesce/v1" as const,
    migrationId: provisioned.migration.id,
    migrationGeneration: generation,
    agentId: agent.id,
    sourceMachineId: sourceMachine.id,
    sourceRuntimeState: "stopped" as const,
    stoppedAt: new Date(t0.getTime() + 2_000).toISOString(),
    actor: "migration" as const,
    launchSessionIdentity: "launch:launch-1:session:session-1",
    expectedRuntimeRevision: String(expectedRevision),
  };
  await assert.rejects(
    () => recordAgentMigrationSourceQuiesced({
      ...sourceActor,
      receipt: { ...receipt, expectedRuntimeRevision: String(expectedRevision + 1) },
      now: new Date(t0.getTime() + 2_000),
    }),
    /MIGRATION_SOURCE_QUIESCE_RECEIPT_INVALID/,
  );
  const quiesced = await recordAgentMigrationSourceQuiesced({
    ...sourceActor,
    receipt,
    now: new Date(t0.getTime() + 2_000),
  });
  // The source builds the whole bundle after quiescing and reports nothing until
  // control registration, so the quiesce slides the prep window by the longer
  // bundle-build window, capped by the transfer deadline.
  const bundleWindowDeadline = Math.min(
    t0.getTime() + 2_000 + 30 * 60 * 1000,
    quiesced.transferDeadlineAt.getTime(),
  );
  assert.ok(bundleWindowDeadline > t0.getTime() + 10 * 60 * 1000, "bundle window outlasts the default prep window");
  assert.equal(quiesced.prepDeadlineAt.getTime(), bundleWindowDeadline);

  // Bundle-build progress between quiesce and registration: only a report that
  // moved forward is stored and slides the deadline by one idle window.
  const progressAt = (ms: number) => new Date(t0.getTime() + ms);
  const report = (phase: "scanning" | "packing" | "hashing", files: number, bytes: number, migrationGeneration = generation) =>
    ({ migrationGeneration, phase, files, bytes });
  await assert.rejects(
    () => recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: { ...report("scanning", 1, 1), extra: true }, now: progressAt(2_050) }),
    /MIGRATION_SOURCE_PROGRESS_INVALID/,
  );
  await assert.rejects(
    () => recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: report("scanning", 1, 1, "stale-generation"), now: progressAt(2_050) }),
    /MIGRATION_GENERATION_STALE/,
  );
  // Pretend the build window is almost over so a slide is observable.
  await getDb().update(agentMigrations)
    .set({ prepDeadlineAt: progressAt(2_100) })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  const first = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: report("packing", 10, 1_000), now: progressAt(2_200) });
  assert.equal(first.advanced, true);
  assert.equal(first.migration.prepDeadlineAt.getTime(), progressAt(2_200).getTime() + 10 * 60 * 1000);
  assert.deepEqual(first.migration.sourceBuildProgress, {
    phase: "packing",
    files: 10,
    bytes: 1_000,
    reportedAt: progressAt(2_200).toISOString(),
  });
  assert.equal(first.migration.revision, quiesced.revision, "progress does not bump revision");
  assert.equal(first.migration.userIgnoreReceipt, null, "a report without a receipt stores none");
  for (const stale of [report("packing", 10, 1_000), report("packing", 9, 900), report("scanning", 50, 5_000)]) {
    const repeated = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: stale, now: progressAt(2_400) });
    assert.equal(repeated.advanced, false, `${stale.phase} ${stale.files}/${stale.bytes} is not progress`);
    assert.equal(repeated.migration.prepDeadlineAt.getTime(), first.migration.prepDeadlineAt.getTime());
  }

  // The user-ignore receipt rides the source's immediate `scanning` 0/0 report:
  // stored even though that report is not progress, and the first one stands.
  const userIgnoreReceipt = {
    written: 2,
    alreadyPresent: 1,
    rejected: [{ path: "MEMORY.md", reason: "forced_keep" as const }],
  };
  await assert.rejects(
    () => recordAgentMigrationSourceBuildProgress({
      ...sourceActor,
      report: { ...report("scanning", 0, 0), userIgnoreAdditions: { ...userIgnoreReceipt, extra: true } },
      now: progressAt(2_410),
    }),
    /MIGRATION_SOURCE_PROGRESS_INVALID/,
    "a malformed receipt is a malformed report",
  );
  await assert.rejects(
    () => recordAgentMigrationSourceBuildProgress({
      ...sourceActor,
      report: { ...report("scanning", 0, 0, "stale-generation"), userIgnoreAdditions: userIgnoreReceipt },
      now: progressAt(2_410),
    }),
    /MIGRATION_GENERATION_STALE/,
  );
  const [beforeReceipt] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(beforeReceipt.userIgnoreReceipt, null, "a rejected report stores no receipt");
  const withReceipt = await recordAgentMigrationSourceBuildProgress({
    ...sourceActor,
    report: { ...report("scanning", 0, 0), userIgnoreAdditions: userIgnoreReceipt },
    now: progressAt(2_420),
  });
  assert.equal(withReceipt.advanced, false);
  assert.deepEqual(withReceipt.migration.userIgnoreReceipt, userIgnoreReceipt);
  assert.deepEqual(withReceipt.migration.sourceBuildProgress, first.migration.sourceBuildProgress);
  assert.equal(withReceipt.migration.prepDeadlineAt.getTime(), first.migration.prepDeadlineAt.getTime());
  assert.equal(withReceipt.migration.revision, quiesced.revision, "the receipt does not bump revision");
  const resent = await recordAgentMigrationSourceBuildProgress({
    ...sourceActor,
    report: { ...report("scanning", 0, 0), userIgnoreAdditions: { written: 0, alreadyPresent: 3, rejected: [] } },
    now: progressAt(2_430),
  });
  assert.deepEqual(resent.migration.userIgnoreReceipt, userIgnoreReceipt, "a re-sent lease's receipt does not overwrite the first");
  const later = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: report("hashing", 0, 1), now: progressAt(2_500) });
  assert.equal(later.advanced, true, "a later phase is progress even with smaller counts");
  assert.equal(later.migration.prepDeadlineAt.getTime(), progressAt(2_500).getTime() + 10 * 60 * 1000);
  const legacyV1Control = {
    ...control,
    schemaVersion: "agent-migration-control/v1",
  } as unknown as AgentMigrationControlManifest;
  await assert.rejects(
    () => registerAgentMigrationControlManifest({
      ...sourceActor,
      control: legacyV1Control,
      now: new Date(t0.getTime() + 2_250),
    }),
    /MIGRATION_CONTROL_MANIFEST_INVALID/,
  );
  const [afterLegacyRegistration] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(afterLegacyRegistration.state, "provisioning");
  assert.equal(afterLegacyRegistration.transportControlManifest, null);
  assert.equal(afterLegacyRegistration.transferSummary, null);
  const malformedControl: AgentMigrationControlManifest = {
    ...control,
    transferSummary: { ...control.transferSummary, includedBytes: 2 },
  };
  await assert.rejects(
    () => registerAgentMigrationControlManifest({
      ...sourceActor,
      control: malformedControl,
      now: new Date(t0.getTime() + 2_500),
    }),
    /MIGRATION_CONTROL_MANIFEST_INVALID/,
  );
  const [afterMalformedRegistration] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(afterMalformedRegistration.state, "provisioning");
  assert.equal(afterMalformedRegistration.transportControlManifest, null);
  assert.equal(afterMalformedRegistration.transferSummary, null);
  const registered = await registerAgentMigrationControlManifest({
    ...sourceActor,
    control,
    now: new Date(t0.getTime() + 3_000),
  });
  assert.deepEqual(registered.missingChunkIndexes, [0, 1]);
  // Registering the control manifest is source progress: the prep window slides
  // to one idle window after it, capped by the transfer deadline, but never
  // shrinks an earlier window.
  const [afterRegistration] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(
    afterRegistration.prepDeadlineAt.getTime(),
    Math.max(
      later.migration.prepDeadlineAt.getTime(),
      Math.min(t0.getTime() + 3_000 + 10 * 60 * 1000, afterRegistration.transferDeadlineAt.getTime()),
    ),
  );
  const afterRegistrationReport = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: report("hashing", 1, 99), now: progressAt(3_100) });
  assert.equal(afterRegistrationReport.advanced, false, "progress after registration is ignored");
  assert.equal(afterRegistration.revision, registered.migration.revision, "deadline slide does not bump revision");

  const storage = {
    put: async () => undefined,
    get: async () => { throw new Error("not used"); },
    delete: async () => undefined,
    getPresignedPutUrl: async (key: string) => `https://r2.example.test/${key}?put=1`,
    getPresignedUrl: async (key: string) => `https://r2.example.test/${key}?get=1`,
  };
  const sourcePlan = await planAgentMigrationChunkTransfers({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    transportToken: provisioned.source.message.bearerToken,
    storage,
  });
  assert.deepEqual(sourcePlan.chunks.map((chunk) => chunk.index), [0, 1]);

  const chunk0 = control.bundle.chunks[0];
  const sourceChunk0 = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source" as const,
    transportToken: provisioned.source.message.bearerToken,
    migrationGeneration: generation,
    leaseId,
    chunkIndex: chunk0.index,
    sizeBytes: chunk0.sizeBytes,
    sha256: chunk0.sha256,
  };
  assert.equal((await recordAgentMigrationChunkReceipt(sourceChunk0)).outcome, "recorded");
  assert.equal((await recordAgentMigrationChunkReceipt(sourceChunk0)).outcome, "reused");
  assert.deepEqual((await planAgentMigrationChunkTransfers({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    transportToken: provisioned.source.message.bearerToken,
    storage,
  })).chunks.map((chunk) => chunk.index), [1]);
  await assert.rejects(
    () => planAgentMigrationChunkTransfers({
      migrationId: provisioned.migration.id,
      serverId: server.id,
      machineId: targetMachine.id,
      role: "target",
      transportToken: provisioned.target.message.bearerToken,
      storage,
    }),
    /MIGRATION_NOT_READY/,
  );
  await assert.rejects(
    () => recordAgentMigrationChunkReceipt({ ...sourceChunk0, migrationGeneration: "stale-generation" }),
    /MIGRATION_GENERATION_STALE/,
  );
  await assert.rejects(
    () => completeAgentMigrationResumableUpload({
      ...sourceActor,
      migrationGeneration: generation,
      leaseId,
      controlSha256: registered.controlSha256,
      now: new Date(t0.getTime() + 4_000),
    }),
    /MIGRATION_CHUNKS_MISSING/,
  );
  const chunk1 = control.bundle.chunks[1];
  await recordAgentMigrationChunkReceipt({
    ...sourceChunk0,
    chunkIndex: chunk1.index,
    sizeBytes: chunk1.sizeBytes,
    sha256: chunk1.sha256,
  });
  await getDb().update(agentMigrations)
    .set({ transportControlManifest: malformedControl })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  await assert.rejects(
    () => completeAgentMigrationResumableUpload({
      ...sourceActor,
      migrationGeneration: generation,
      leaseId,
      controlSha256: registered.controlSha256,
      now: new Date(t0.getTime() + 4_500),
    }),
    /MIGRATION_CONTROL_MANIFEST_INVALID/,
  );
  const [afterMalformedCompletion] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(afterMalformedCompletion.state, "provisioning");
  // No download progress while the source is still uploading.
  assert.equal(await getAgentMigrationTransferProgress(afterMalformedCompletion), null);
  assert.equal(afterMalformedCompletion.transportUploadCompletedAt, null);
  assert.equal(afterMalformedCompletion.transferSummary, null);
  await getDb().update(agentMigrations)
    .set({ transportControlManifest: control })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  const complete = await completeAgentMigrationResumableUpload({
    ...sourceActor,
    migrationGeneration: generation,
    leaseId,
    controlSha256: registered.controlSha256,
    now: new Date(t0.getTime() + 5_000),
  });
  assert.equal(complete.state, "ready");
  assert.ok(complete.transportUploadCompletedAt);
  assert.deepEqual(complete.transferSummary, control.transferSummary);
  const totalBytes = control.bundle.totalBytes;
  assert.deepEqual(await getAgentMigrationTransferProgress(complete), {
    receivedBytes: 0,
    totalBytes,
    receivedChunks: 0,
    totalChunks: 2,
  });
  const replayedComplete = await completeAgentMigrationResumableUpload({
    ...sourceActor,
    migrationGeneration: generation,
    leaseId,
    controlSha256: registered.controlSha256,
    now: new Date(t0.getTime() + 5_500),
  });
  assert.equal(replayedComplete.revision, complete.revision);
  assert.deepEqual(replayedComplete.transferSummary, control.transferSummary);
  assert.deepEqual((await planAgentMigrationChunkTransfers({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    transportToken: provisioned.target.message.bearerToken,
    storage,
  })).chunks.map((chunk) => chunk.index), [0, 1]);
  const targetChunk0 = {
    ...sourceChunk0,
    machineId: targetMachine.id,
    role: "target" as const,
    transportToken: provisioned.target.message.bearerToken,
  };
  assert.equal((await recordAgentMigrationChunkReceipt({
    ...targetChunk0,
    now: new Date(t0.getTime() + 55 * 60 * 1000),
  })).outcome, "recorded");
  // Target download progress slides the transfer deadline too.
  const [afterTargetReceipt] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(afterTargetReceipt.transferDeadlineAt.getTime(), t0.getTime() + 85 * 60 * 1000);
  // Only the target's receipts count as downloaded; the source already has both.
  assert.deepEqual(await getAgentMigrationTransferProgress(afterTargetReceipt), {
    receivedBytes: chunk0.sizeBytes,
    totalBytes,
    receivedChunks: 1,
    totalChunks: 2,
  });
  assert.equal((await recordAgentMigrationChunkReceipt(targetChunk0)).outcome, "reused");
  assert.deepEqual((await planAgentMigrationChunkTransfers({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    transportToken: provisioned.target.message.bearerToken,
    storage,
  })).chunks.map((chunk) => chunk.index), [1]);
  await getDb().update(agentMigrations)
    .set({ transportExpiresAt: new Date("2000-01-01T00:00:00.000Z") })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  await assert.rejects(
    () => planAgentMigrationChunkTransfers({
      migrationId: provisioned.migration.id,
      serverId: server.id,
      machineId: targetMachine.id,
      role: "target",
      transportToken: provisioned.target.message.bearerToken,
      storage,
    }),
    /MIGRATION_LEASE_EXPIRED/,
  );
  await getDb().update(agentMigrations)
    .set({ transportExpiresAt: new Date("2100-01-01T00:00:00.000Z") })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  const targetChunk1 = {
    ...targetChunk0,
    chunkIndex: chunk1.index,
    sizeBytes: chunk1.sizeBytes,
    sha256: chunk1.sha256,
  };
  assert.equal((await recordAgentMigrationChunkReceipt(targetChunk1)).outcome, "recorded");
  const [afterAllTargetReceipts] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, provisioned.migration.id));
  assert.deepEqual(await getAgentMigrationTransferProgress(afterAllTargetReceipts), {
    receivedBytes: totalBytes,
    totalBytes,
    receivedChunks: 2,
    totalChunks: 2,
  });
  await startTestAgentMigrationTransfer(provisioned.migration.id, new Date(t0.getTime() + 6_000));
  const arriving = await flipTestAgentMigration(provisioned.migration.id, new Date(t0.getTime() + 7_000));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: provisioned.migration.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 7_500),
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    migrationId: provisioned.migration.id,
    migrationGeneration: archived.migrationGeneration,
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 8_000),
  });
  assert.equal(arrival.migration.state, "starting");
  const completed = await completeAgentMigrationAutoStart({
    migrationId: provisioned.migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 9_000),
  });
  assert.equal(completed.state, "completed");
  const completedReplay = await completeAgentMigrationAutoStart({
    migrationId: provisioned.migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 10_000),
  });
  assert.equal(completedReplay.revision, completed.revision);
  const outboxRows = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, provisioned.migration.id));
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0]?.receiptKind, "completed");
});

test("streamed source uploads each chunk before the control and is held to the migration's entry limit", async ({ db }) => {
  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T15:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-streamed",
    transportLeaseMs: 60 * 60 * 1000,
    transportMaxBytes: 10_000,
  });
  assert.equal(provisioned.migration.transportMaxArchiveEntries, AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES);
  const generation = provisioned.source.message.transportGeneration!;
  const leaseId = provisioned.source.message.leaseId!;
  const sourceActor = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    transportToken: provisioned.source.message.bearerToken,
  };
  const storage = {
    put: async () => undefined,
    get: async () => { throw new Error("not used"); },
    delete: async () => undefined,
    getPresignedPutUrl: async (key: string) => `https://r2.example.test/${key}?put=1`,
    getPresignedUrl: async (key: string) => `https://r2.example.test/${key}?get=1`,
  };
  const chunks = [
    { index: 0, offsetBytes: 0, sizeBytes: 4, sha256: "a".repeat(64) },
    { index: 1, offsetBytes: 4, sizeBytes: 3, sha256: "b".repeat(64) },
  ];
  const stream = (chunk: (typeof chunks)[number], overrides: Partial<{ sha256: string; sizeBytes: number; chunkIndex: number; migrationGeneration: string }> = {}) =>
    prepareAgentMigrationStreamedChunk({
      ...sourceActor,
      migrationGeneration: generation,
      leaseId,
      chunkIndex: chunk.index,
      sizeBytes: chunk.sizeBytes,
      sha256: chunk.sha256,
      storage,
      ...overrides,
    });

  await assert.rejects(() => stream(chunks[0]), /MIGRATION_SOURCE_NOT_QUIESCED/);
  await recordAgentMigrationSourceQuiesced({
    ...sourceActor,
    receipt: {
      schemaVersion: "agent-migration-quiesce/v1",
      migrationId: provisioned.migration.id,
      migrationGeneration: generation,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      sourceRuntimeState: "stopped",
      stoppedAt: new Date(t0.getTime() + 1_000).toISOString(),
      actor: "migration",
      launchSessionIdentity: "launch:launch-1:session:session-1",
      expectedRuntimeRevision: String(provisioned.source.message.expectedMigrationRevision),
    },
    now: new Date(t0.getTime() + 1_000),
  });
  await assert.rejects(() => stream(chunks[0], { migrationGeneration: "stale-generation" }), /MIGRATION_GENERATION_STALE/);
  await assert.rejects(() => stream(chunks[0], { sha256: "not-a-digest" }), /MIGRATION_STREAMED_CHUNK_INVALID/);
  await assert.rejects(
    () => stream(chunks[0], { sizeBytes: AGENT_MIGRATION_DEFAULT_CHUNK_BYTES + 1 }),
    /MIGRATION_STREAMED_CHUNK_INVALID/,
  );

  const first = await stream(chunks[0]);
  assert.equal(first.uploaded, false);
  assert.match(first.url ?? "", /\/resumable\/[0-9a-f]{24}\/chunks\/0\?put=1$/);
  // Same chunk again (an upload retry) gets a fresh URL; a different digest for the index is refused.
  assert.equal((await stream(chunks[0])).uploaded, false);
  await assert.rejects(() => stream(chunks[0], { sha256: "d".repeat(64) }), /MIGRATION_CHUNK_RECEIPT_MISMATCH/);
  const sourceReceipt = (chunk: (typeof chunks)[number]) => recordAgentMigrationChunkReceipt({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    transportToken: provisioned.source.message.bearerToken,
    migrationGeneration: generation,
    leaseId,
    chunkIndex: chunk.index,
    sizeBytes: chunk.sizeBytes,
    sha256: chunk.sha256,
  });
  await sourceReceipt(chunks[0]);
  assert.deepEqual(await stream(chunks[0]), { uploaded: true, url: null });
  await stream(chunks[1]);
  await sourceReceipt(chunks[1]);

  const control = (entryCount: number): AgentMigrationControlManifest => ({
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: provisioned.migration.id,
      migrationGeneration: generation,
      leaseId,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      targetMachineId: targetMachine.id,
    },
    capability: { required: [AGENT_MIGRATION_CAPABILITY] },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      totalBytes: 7,
      sha256: "c".repeat(64),
      chunkSizeBytes: 1024 * 1024,
      chunks,
    },
    archive: {
      format: "tar+gzip",
      entryCount,
      expandedBytes: entryCount,
      maxEntryBytes: 1,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: {
      includedFileCount: entryCount,
      includedBytes: entryCount,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
    },
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  });
  await assert.rejects(
    () => registerAgentMigrationControlManifest({ ...sourceActor, control: control(AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES + 1), now: new Date(t0.getTime() + 2_000) }),
    /MIGRATION_CONTROL_MANIFEST_INVALID/,
  );
  // A control whose chunk set differs from what was streamed is refused.
  await assert.rejects(
    () => registerAgentMigrationControlManifest({
      ...sourceActor,
      control: { ...control(250_001), bundle: { ...control(1).bundle, totalBytes: 4, chunks: [chunks[0]] } },
      now: new Date(t0.getTime() + 2_000),
    }),
    /MIGRATION_CHUNK_RECEIPT_SET_MISMATCH/,
  );
  const largeControl = control(250_001);
  const registered = await registerAgentMigrationControlManifest({ ...sourceActor, control: largeControl, now: new Date(t0.getTime() + 2_000) });
  assert.deepEqual(registered.missingChunkIndexes, [], "streamed chunks are already uploaded");
  // The chunk set is fixed once the control is registered.
  await assert.rejects(
    () => stream({ index: 2, offsetBytes: 7, sizeBytes: 1, sha256: "e".repeat(64) }),
    /MIGRATION_CHUNK_RECEIPT_MISMATCH/,
  );
  const complete = await completeAgentMigrationResumableUpload({
    ...sourceActor,
    migrationGeneration: generation,
    leaseId,
    controlSha256: registered.controlSha256,
    now: new Date(t0.getTime() + 3_000),
  });
  assert.equal(complete.state, "ready");
});

test("completion no longer waits for the source archive, and never backfills it", async ({ db: database }) => {

  const { user, targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  const db = getDb();
  await db.update(agentMigrations).set({
    sourceWorkspaceArchivedAt: null,
    initiatedByUserId: user.id,
    transferSummary: TEST_TRANSFER_SUMMARY,
  }).where(eq(agentMigrations.id, migration.id));

  const completed = await completeAgentMigrationAutoStart({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.sourceWorkspaceArchivedAt, null, "historical/pending archive is not silently backfilled");

  // Rows never attempted under the retry policy are not picked up by the background retry.
  assert.equal(await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-06T00:00:00.000Z") }), null);
});

test("source archive retry backs off, guards against the agent moving, and gives up visibly", async ({ db: database }) => {

  const { sourceMachine, targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  const db = getDb();
  await db.update(agentMigrations).set({ sourceWorkspaceArchivedAt: null })
    .where(eq(agentMigrations.id, migration.id));
  const t0 = new Date("2026-07-06T00:00:00.000Z");

  const failed = await recordAgentMigrationSourceArchiveAttemptFailed({
    migrationId: migration.id,
    errorCode: "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_TIMEOUT",
    now: t0,
  });
  assert.equal(failed?.sourceWorkspaceArchiveAttempts, 1);
  assert.equal(failed?.sourceWorkspaceArchiveLastError, "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_TIMEOUT");
  assert.equal(failed?.sourceWorkspaceArchiveRetryAt?.toISOString(), "2026-07-06T00:01:00.000Z");
  assert.equal(failed?.revision, migration.revision, "bookkeeping does not bump the state-machine revision");

  assert.equal(await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-06T00:00:30.000Z") }), null);
  const claim = await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-06T00:01:01.000Z") });
  assert.equal(claim?.action, "archive");
  // The claim pushes retry_at out as a lease so another replica does not double-dispatch.
  assert.equal(await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-06T00:01:02.000Z") }), null);

  const archived = await recordAgentMigrationSourceWorkspaceArchivedById({
    migrationId: migration.id,
    now: new Date("2026-07-06T00:01:03.000Z"),
  });
  assert.ok(archived?.sourceWorkspaceArchivedAt);
  assert.equal(archived?.sourceWorkspaceArchiveRetryAt, null);

  // Guard: the agent moved back to the source → abandon instead of archiving a live workspace.
  await db.update(agentMigrations).set({
    sourceWorkspaceArchivedAt: null,
    sourceWorkspaceArchiveRetryAt: t0,
  }).where(eq(agentMigrations.id, migration.id));
  await db.update(agents).set({ machineId: sourceMachine.id }).where(eq(agents.id, agent.id));
  const moved = await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-06T00:02:00.000Z") });
  assert.equal(moved?.action, "abandoned");
  assert.equal(moved?.migration.sourceWorkspaceArchiveLastError, "agent_moved");
  assert.ok(moved?.migration.sourceWorkspaceArchiveAbandonedAt);
  assert.equal(await claimAgentMigrationSourceArchiveRetry({ now: new Date("2026-07-07T00:00:00.000Z") }), null);

  // The source daemon refusing because the workspace is live again abandons at once.
  await db.update(agents).set({ machineId: targetMachine.id }).where(eq(agents.id, agent.id));
  await db.update(agentMigrations).set({
    sourceWorkspaceArchiveAbandonedAt: null,
    sourceWorkspaceArchiveAttempts: 1,
  }).where(eq(agentMigrations.id, migration.id));
  const refused = await recordAgentMigrationSourceArchiveAttemptFailed({
    migrationId: migration.id,
    errorCode: "MIGRATION_WORKSPACE_ARCHIVE_NEWER_OWNER",
    now: t0,
  });
  assert.ok(refused?.sourceWorkspaceArchiveAbandonedAt);
  assert.equal(refused?.sourceWorkspaceArchiveRetryAt, null);
  assert.equal(refused?.sourceWorkspaceArchiveLastError, "agent_moved");

  // Cap: exhausting the attempts leaves a visible abandoned state instead of retrying forever.
  await db.update(agents).set({ machineId: targetMachine.id }).where(eq(agents.id, agent.id));
  await db.update(agentMigrations).set({
    sourceWorkspaceArchiveAbandonedAt: null,
    sourceWorkspaceArchiveAttempts: AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_ATTEMPTS - 1,
  }).where(eq(agentMigrations.id, migration.id));
  const exhausted = await recordAgentMigrationSourceArchiveAttemptFailed({ migrationId: migration.id, now: t0 });
  assert.equal(exhausted?.sourceWorkspaceArchiveAttempts, AGENT_MIGRATION_SOURCE_ARCHIVE_MAX_ATTEMPTS);
  assert.equal(exhausted?.sourceWorkspaceArchiveRetryAt, null);
  assert.ok(exhausted?.sourceWorkspaceArchiveAbandonedAt);
  assert.equal(exhausted?.sourceWorkspaceArchiveLastError, "MIGRATION_SOURCE_WORKSPACE_ARCHIVE_FAILED");
});

test("provisioning migration persists object-store lease metadata and sends role-specific leases without plaintext tokens", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");

  const result = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: t0,
    transportSessionId: "session-123",
    transportLeaseMs: 30 * 60 * 1000,
    transportMaxBytes: 12_345,
  });

  assert.equal(result.migration.state, "provisioning");
  assert.equal(result.migration.transportProvider, "object_store");
  assert.equal(result.migration.transportSessionId, "session-123");
  assert.equal(result.migration.sourceTransportUrl, null);
  assert.equal(result.migration.targetTransportUrl, null);
  assert.equal(result.migration.transportLeaseSource, "server");
  assert.equal(result.migration.transportMaxBytes, 12_345);
  assert.ok(result.migration.sourceTransportTokenHash);
  assert.ok(result.migration.targetTransportTokenHash);
  assert.notEqual(result.migration.sourceTransportTokenHash, result.migration.targetTransportTokenHash);

  assert.equal(result.source.machineId, sourceMachine.id);
  assert.equal(result.source.message.role, "source");
  assert.equal(result.source.message.sessionId, "session-123");
  assert.equal(result.source.message.provider, "object_store");
  assert.equal(result.source.message.transferKind, "upload");
  assert.equal("url" in result.source.message, false, "the lease carries no whole-bundle URL");
  assert.equal(result.source.message.expiresAt, "2026-07-05T14:30:00.000Z");
  assert.equal(result.source.message.maxBytes, 12_345);
  assert.equal(result.target.machineId, targetMachine.id);
  assert.equal(result.target.message.role, "target");
  assert.equal(result.target.message.transferKind, "download");
  assert.match(result.source.message.bearerToken, /^slock_migration_/);
  assert.match(result.target.message.bearerToken, /^slock_migration_/);
  assert.notEqual(result.source.message.bearerToken, result.target.message.bearerToken);

  const storedText = JSON.stringify(result.migration);
  assert.doesNotMatch(storedText, new RegExp(result.source.message.bearerToken));
  assert.doesNotMatch(storedText, new RegExp(result.target.message.bearerToken));
});

// Reconciler step 14 (Q-H): a source that drains before its stop gets the
// drain's 10 min more prep window, and its lease offers exactly that extra
// as `sourceDrainUntil`; any other migration's lease has none (the source
// stops at once, as before). RED proof: drop the extra in insertAgentMigration
// and the prep deadline is 14:10 with no `sourceDrainUntil`.
test("a draining source gets the 10 min more prep window and the source lease offers it as sourceDrainUntil", async ({ db }) => {
  const { targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");
  const result = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    sourceDrainsBeforeStop: true,
    transportSessionId: "session-drain",
  });
  assert.equal(AGENT_MIGRATION_SOURCE_DRAIN_MAX_MS, 10 * 60 * 1000);
  assert.equal(result.migration.prepDeadlineAt.toISOString(), "2026-07-05T14:20:00.000Z");
  assert.equal(result.source.message.sourceDrainUntil, "2026-07-05T14:10:00.000Z", "the ordinary 10 min prep window is left after the wait");
  assert.equal("sourceDrainUntil" in result.target.message, false, "source lease only");
});

// task #62: while the source drains (before quiesce) it reports what it waits
// for and until when. The Server keeps it in `sourceBuildProgress` as a
// `draining` record, clamps `drainUntil` to [now, the lease's sourceDrainUntil],
// folds `waitingFor` into the fixed set, and drops it at the quiesce, after
// which build progress advances as before. RED proof: without the draining
// branch the report is rejected as MIGRATION_SOURCE_PROGRESS_INVALID.
test("a draining source's report is stored clamped and normalized, and gives way to build progress", async ({ db }) => {
  const { agent, sourceMachine, targetMachine, server } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T14:00:00.000Z");
  const at = (minutes: number, seconds = 0) => new Date(t0.getTime() + minutes * 60_000 + seconds * 1000);
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    sourceDrainsBeforeStop: true,
    transportSessionId: "session-drain-progress",
    transportLeaseMs: 60 * 60 * 1000,
  });
  assert.equal(provisioned.source.message.sourceDrainUntil, at(10).toISOString());
  const generation = provisioned.source.message.transportGeneration!;
  const sourceActor = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    transportToken: provisioned.source.message.bearerToken,
  };
  const drain = (fields: Record<string, unknown>) => ({ migrationGeneration: generation, phase: "draining", ...fields });

  const first = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: drain({ drainUntil: at(5).toISOString(), waitingFor: "turn" }), now: at(1) });
  assert.equal(first.advanced, false, "a drain report is not build progress");
  assert.deepEqual(first.migration.sourceBuildProgress, { phase: "draining", drainUntil: at(5).toISOString(), waitingFor: "turn", reportedAt: at(1).toISOString() });
  assert.equal(first.migration.revision, provisioned.migration.revision, "no revision bump");
  assert.equal(first.migration.prepDeadlineAt.getTime(), provisioned.migration.prepDeadlineAt.getTime(), "no deadline slide");
  assert.deepEqual(sourceDrainOf(first.migration), { until: at(5).toISOString(), waitingFor: "turn", reportedAt: at(1).toISOString() });
  assert.equal(sourceBuildProgressOf(first.migration), null, "the owner never sees a drain record as build progress");

  const beyondCap = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: drain({ drainUntil: at(30).toISOString(), waitingFor: "<b>raw text</b>" }), now: at(2) });
  assert.deepEqual(sourceDrainOf(beyondCap.migration), { until: at(10).toISOString(), waitingFor: "other", reportedAt: at(2).toISOString() }, "clamped to sourceDrainUntil; unknown waitingFor is other");

  const inThePast = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: drain({ drainUntil: at(-60).toISOString() }), now: at(3) });
  assert.deepEqual(sourceDrainOf(inThePast.migration), { until: at(3).toISOString(), waitingFor: null, reportedAt: at(3).toISOString() }, "clamped up to now; missing waitingFor stays null");

  const unparseable = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: drain({ drainUntil: "soon", waitingFor: "background_tasks" }), now: at(4) });
  assert.equal(sourceDrainOf(unparseable.migration)?.until, at(10).toISOString(), "an unparseable drainUntil reads as the cap");
  assert.equal(sourceDrainOf(unparseable.migration)?.waitingFor, "background_tasks");

  for (const malformed of [drain({ drainUntil: at(5).toISOString(), extra: true }), drain({ drainUntil: at(5).toISOString(), waitingFor: 7 }), drain({})]) {
    await assert.rejects(
      () => recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: malformed, now: at(4, 30) }),
      /MIGRATION_SOURCE_PROGRESS_INVALID/,
    );
  }
  await assert.rejects(
    () => recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: { ...drain({ drainUntil: at(5).toISOString() }), migrationGeneration: "stale" }, now: at(4, 30) }),
    /MIGRATION_GENERATION_STALE/,
  );
  const beforeQuiesceBuild = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: { migrationGeneration: generation, phase: "scanning", files: 1, bytes: 1 }, now: at(4, 40) });
  assert.equal(beforeQuiesceBuild.advanced, false, "build progress before quiesce is still ignored");
  assert.equal(sourceDrainOf(beforeQuiesceBuild.migration)?.waitingFor, "background_tasks");

  const quiesced = await recordAgentMigrationSourceQuiesced({
    ...sourceActor,
    receipt: {
      schemaVersion: "agent-migration-quiesce/v1",
      migrationId: provisioned.migration.id,
      migrationGeneration: generation,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      sourceRuntimeState: "stopped",
      stoppedAt: at(5).toISOString(),
      actor: "migration",
      launchSessionIdentity: "launch:launch-1:session:session-1",
      expectedRuntimeRevision: String(provisioned.source.message.expectedMigrationRevision),
    },
    now: at(5),
  });
  assert.equal(quiesced.sourceBuildProgress, null, "the quiesce clears the drain report");
  assert.equal(sourceDrainOf(quiesced), null);
  const lateDrain = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: drain({ drainUntil: at(9).toISOString() }), now: at(5, 10) });
  assert.equal(lateDrain.migration.sourceBuildProgress, null, "a drain report after quiesce is ignored");

  // A drain record still in the column (no quiesce clear) never blocks the first build report.
  await db.update(agentMigrations)
    .set({ sourceBuildProgress: { phase: "draining", drainUntil: at(9).toISOString(), waitingFor: "turn", reportedAt: at(4).toISOString() } })
    .where(eq(agentMigrations.id, provisioned.migration.id));
  const scanning = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: { migrationGeneration: generation, phase: "scanning", files: 0, bytes: 0 }, now: at(6) });
  assert.equal(scanning.advanced, true, "the first build report after a drain report is progress");
  assert.deepEqual(scanning.migration.sourceBuildProgress, { phase: "scanning", files: 0, bytes: 0, reportedAt: at(6).toISOString() });
  assert.equal(sourceDrainOf(scanning.migration), null);
  const packing = await recordAgentMigrationSourceBuildProgress({ ...sourceActor, report: { migrationGeneration: generation, phase: "packing", files: 3, bytes: 30 }, now: at(7) });
  assert.equal(packing.advanced, true, "build progress keeps advancing");
  assert.deepEqual(sourceBuildProgressOf(packing.migration), { phase: "packing", files: 3, bytes: 30, reportedAt: at(7).toISOString() });
});

test("a draining report for a migration whose lease offers no drain is ignored", async ({ db }) => {
  const { agent, sourceMachine, targetMachine, server } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T14:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-no-drain-progress",
    transportLeaseMs: 60 * 60 * 1000,
  });
  const result = await recordAgentMigrationSourceBuildProgress({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    transportToken: provisioned.source.message.bearerToken,
    report: { migrationGeneration: provisioned.source.message.transportGeneration, phase: "draining", drainUntil: new Date(t0.getTime() + 60_000).toISOString(), waitingFor: "turn" },
    now: new Date(t0.getTime() + 1_000),
  });
  assert.equal(result.advanced, false);
  assert.equal(result.migration.sourceBuildProgress, null);
});

test("a migration whose source does not drain keeps its prep window and sends no sourceDrainUntil", async ({ db }) => {
  const { targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");
  const result = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-no-drain",
  });
  assert.equal(result.migration.prepDeadlineAt.toISOString(), "2026-07-05T14:10:00.000Z");
  assert.equal("sourceDrainUntil" in result.source.message, false);
});

test("transfer lease ready helper validates object-store role/session/expiry/max-byte contract", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const result = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    transportSessionId: "session-ready",
    transportLeaseMs: 60_000,
    transportMaxBytes: 999,
  });

  assert.deepEqual(evaluateAgentMigrationTransferLeaseReady({
    migration: result.migration,
    role: "source",
    now: new Date("2026-07-05T14:00:30.000Z"),
    lease: {
      provider: "object_store",
      role: "source",
      transferKind: "upload",
      leaseSource: "server",
      migrationId: result.migration.id,
      migrationGeneration: result.source.message.migrationGeneration,
      sessionId: "session-ready",
      expiresAt: result.source.message.expiresAt,
      maxBytes: 999,
    },
  }), { ready: true });

  assert.deepEqual(evaluateAgentMigrationTransferLeaseReady({
    migration: result.migration,
    role: "target",
    now: new Date("2026-07-05T14:00:30.000Z"),
    lease: {
      provider: "object_store",
      role: "target",
      transferKind: "upload",
      leaseSource: "server",
      migrationId: result.migration.id,
      migrationGeneration: result.target.message.migrationGeneration,
      sessionId: "session-ready",
      expiresAt: result.target.message.expiresAt,
      maxBytes: 999,
    },
  }), { ready: false, code: "MIGRATION_TRANSPORT_NOT_PROVISIONED", reason: "transfer_kind_mismatch" });

  assert.deepEqual(evaluateAgentMigrationTransferLeaseReady({
    migration: result.migration,
    role: "source",
    now: new Date("2026-07-05T14:01:00.000Z"),
    lease: {
      provider: "object_store",
      role: "source",
      transferKind: "upload",
      leaseSource: "server",
      migrationId: result.migration.id,
      migrationGeneration: result.source.message.migrationGeneration,
      sessionId: "session-ready",
      expiresAt: result.source.message.expiresAt,
      maxBytes: 999,
    },
  }), { ready: false, code: "MIGRATION_TRANSPORT_LOST", reason: "expired" });
});

test("migration service enforces T0-T7 server state and flips machineId only at the transfer boundary", async ({ db }) => {

  const { user, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: t0,
  });
  const { migration } = provisioning;
  assert.equal(migration.state, "provisioning");
  assert.equal(migration.sourceMachineId, sourceMachine.id);
  assert.equal(migration.targetMachineId, targetMachine.id);
  assert.equal(await zenMigrating(agent.id, new Date("2026-07-05T14:00:30.000Z")), true);

  let [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, sourceMachine.id, "source machine remains authoritative during prep");

  const ready = await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  assert.equal(ready.state, "ready");
  assert.equal(ready.readyAt?.toISOString(), "2026-07-05T14:01:00.000Z");

  const inTransit = await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  assert.equal(inTransit.state, "in_transit");

  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z"));
  assert.equal(arriving.state, "arriving");
  assert.equal(arriving.flippedAt?.toISOString(), "2026-07-05T14:03:00.000Z");

  [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, targetMachine.id, "machineId flips atomically after transfer is ready");
  assert.equal(agentRow.sessionId, "source-native-session", "resume state remains until arrival commits");

  const completed = await completeArrivingMigration({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    reportPath: "MIGRATION-ARRIVED.json",
    reportSha256: "sha256:arrived",
    now: new Date("2026-07-05T14:04:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.arrivalReportPath, "MIGRATION-ARRIVED.json");
  [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.sessionId, null, "arrival atomically forces a cold native session on the target");
  assert.equal(await getActiveAgentMigration(agent.id), null);
  assert.equal(await zenMigrating(agent.id), false);
});

test("arrival finalizes runtime profile projection and marks transfer teardown", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");

  await getDb().insert(agentRuntimeProfiles).values({
    agentId: agent.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    runtimeProfileFingerprint: "before-fp",
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "medium",
    executionMode: "byoc",
    daemonVersion: "0.72.4",
    sessionRefLabel: "source-native-session",
    sessionRefPath: "/source/.codex/sessions/source-native-session.jsonl",
    sessionRefMachineId: sourceMachine.id,
    sessionRefRuntime: "codex",
    sessionRefReachable: true,
    sessionRefReason: "native session is reachable on source only",
    baselineRuntimeProfileFingerprint: "before-fp",
    baselineMachineId: sourceMachine.id,
    baselineRuntime: "codex",
    baselineModel: "gpt-5.3-codex",
    baselineReasoningEffort: "medium",
    baselineExecutionMode: "byoc",
    baselineDaemonVersion: "0.72.4",
    migrationStatus: "migrating",
    pendingKind: "migration",
    pendingKey: "agent_migration:test",
    pendingBeforeRuntimeProfileFingerprint: "before-fp",
    pendingAfterRuntimeProfileFingerprint: "after-fp",
    pendingBeforeMachineId: sourceMachine.id,
    pendingAfterMachineId: targetMachine.id,
    pendingBeforeRuntime: "codex",
    pendingAfterRuntime: "codex",
    pendingBeforeModel: "gpt-5.3-codex",
    pendingAfterModel: "gpt-5.3-codex",
    pendingBeforeReasoningEffort: "medium",
    pendingAfterReasoningEffort: "high",
    pendingBeforeExecutionMode: "byoc",
    pendingAfterExecutionMode: "byoc",
    pendingBeforeDaemonVersion: "0.72.4",
    pendingAfterDaemonVersion: "0.72.5",
    migratingSince: t0,
    migrationDeliveredAt: t0,
    migrationDeliveredLaunchId: "source-launch",
    migrationNudgeCount: 2,
  });

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z"));

  const completed = await completeArrivingMigration({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: new Date("2026-07-05T14:04:00.000Z"),
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.transportTeardownAt?.toISOString(), "2026-07-05T14:04:00.000Z");

  const [profile] = await getDb().select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agent.id));
  assert.equal(profile.machineId, targetMachine.id);
  assert.equal(profile.baselineMachineId, targetMachine.id);
  assert.equal(profile.baselineRuntimeProfileFingerprint, "after-fp");
  assert.equal(profile.baselineReasoningEffort, "high");
  assert.equal(profile.baselineDaemonVersion, "0.72.5");
  assert.equal(profile.sessionRefLabel, null);
  assert.equal(profile.sessionRefPath, null);
  assert.equal(profile.sessionRefMachineId, null);
  assert.equal(profile.sessionRefRuntime, null);
  assert.equal(profile.sessionRefReachable, null);
  assert.equal(profile.sessionRefReason, null);
  assert.equal(profile.migrationStatus, "stable");
  assert.equal(profile.pendingKind, null);
  assert.equal(profile.pendingKey, null);
  assert.equal(profile.pendingAfterRuntimeProfileFingerprint, null);
  assert.equal(profile.migrationDeliveredAt, null);
  assert.equal(profile.migrationDeliveredLaunchId, null);
  assert.equal(profile.migratingSince, null);
  assert.equal(profile.migrationNudgeCount, 0);
  assert.equal(profile.migrationHandledAt?.toISOString(), "2026-07-05T14:04:00.000Z");
});

test("arrival deadline starts at machine flip, not migration begin", async ({ db }) => {

  const { user, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2026-07-05T14:00:00.000Z");

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transferDeadlineMs: 60 * 60 * 1000,
    arrivalDeadlineMs: 10 * 60 * 1000,
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));

  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:20:00.000Z"));
  assert.equal(arriving.state, "arriving");
  assert.equal(arriving.arrivalDeadlineAt.toISOString(), "2026-07-05T14:30:00.000Z");

  const completed = await completeArrivingMigration({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: new Date("2026-07-05T14:25:00.000Z"),
  });
  assert.equal(completed.state, "completed");
});

test("machine flip requires an explicit in-transit transfer state", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });

  await assert.rejects(
    () => flipTestAgentMigration(migration.id, new Date("2026-07-05T14:02:00.000Z")),
    /MIGRATION_NOT_FLIPPABLE/,
  );
});

test("the flip refuses a target whose Computer key was revoked meanwhile: the move fails with its reason, the agent stays on its source", async ({ db }) => {

  const { sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  // The target is detached between the transfer and the flip (a legacy machine: its own key).
  await getDb().update(machines).set({ apiKeyHash: "revoked:account_deletion_requested" }).where(eq(machines.id, targetMachine.id));

  await assert.rejects(
    () => flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z")),
    /MIGRATION_TARGET_COMPUTER_DETACHED/,
  );
  const [row] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(row.state, "failed");
  assert.equal(row.failureReason, "MIGRATION_TARGET_COMPUTER_DETACHED");
  const [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, sourceMachine.id);
});

test("zen(migrating) delivery planner queues ordinary traffic until deadline", async () => {
  const migration = {
    state: "provisioning" as const,
    prepDeadlineAt: new Date("2026-07-05T14:10:00.000Z"),
    transferDeadlineAt: new Date("2026-07-05T15:00:00.000Z"),
    arrivalDeadlineAt: new Date("2026-07-05T15:10:00.000Z"),
  };

  assert.deepEqual(planZenMigratingDelivery({
    migration,
    now: new Date("2026-07-05T14:01:00.000Z"),
  }), { action: "queue", reason: "zen-migrating" });
  assert.deepEqual(planZenMigratingDelivery({
    migration,
    now: new Date("2026-07-05T14:11:00.000Z"),
  }), { action: "deadline-expired", reason: "prep-deadline" });

  assert.deepEqual(planZenMigratingDelivery({
    migration: { ...migration, state: "starting" },
    now: new Date("2026-07-06T14:11:00.000Z"),
  }), { action: "deliver", reason: "target-starting" });
});

test("post-arrival start failure remains active and retryable after the former arrival deadline", async ({ db }) => {

  const { server, targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z"));
  await markAgentMigrationTargetImportArrived({
    migrationId: migration.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:04:00.000Z"),
  });
  await recordAgentMigrationAutoStartFailure({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    stage: "start_agent",
    code: "start_not_dispatched",
    now: new Date("2026-07-05T14:04:01.000Z"),
  });

  const afterFormerDeadline = new Date("2026-07-05T15:00:00.000Z");
  const gate = await getAgentMigrationGateStatus(agent.id, getDb(), afterFormerDeadline);
  assert.equal(gate.migration?.state, "starting");
  assert.equal(gate.migration?.failureReason, "auto_start_failed");
  assert.equal(await zenMigrating(agent.id, afterFormerDeadline), false);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.state, "starting");
  assert.equal(persisted.abortedAt, null);
});

test("auto-start failure persists typed privacy-narrowed cause before retry is eligible", async ({ db }) => {

  const { migration } = await seedAutoStartFailedMigration({
    stage: "orchestrator",
    code: "orchestrator_unavailable",
  });

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.failureReason, "auto_start_failed");
  assert.equal(persisted.autoStartFailureStage, "orchestrator");
  assert.equal(persisted.autoStartFailureCode, "orchestrator_unavailable");
  assert.equal(persisted.autoStartRetryAttempts, 0);
  assert.equal(persisted.autoStartRetryDeadlineAt, null);
});

test("auto-start reconciler adopts an arrival that never recorded an outcome, only after the grace", async ({ db }) => {

  const { migration } = await seedAutoStartFailedMigration();
  // Shape left by an `/arrived` request that died after writing `starting`.
  await getDb().update(agentMigrations)
    .set({ failureReason: null, autoStartFailureStage: null, autoStartFailureCode: null })
    .where(eq(agentMigrations.id, migration.id));
  const arrivedAt = new Date("2026-07-05T14:04:00.000Z");

  const early = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-reconciler",
    now: new Date(arrivedAt.getTime() + AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS - 1_000),
  });
  assert.equal(early, null);

  const claimNow = new Date(arrivedAt.getTime() + AGENT_MIGRATION_ORPHANED_ARRIVAL_GRACE_MS + 1_000);
  const claim = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-reconciler",
    now: claimNow,
    leaseMs: 30_000,
  });
  assert.ok(claim);
  assert.equal(claim.action, "dispatch");
  assert.equal(claim.candidateVariant, "orphaned_arrival");
  assert.equal(claim.migration.autoStartRetryAttempts, 1);

  // A claim that crashes before recording an outcome is re-adopted once its lease expires.
  const reclaimed = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-reconciler-b",
    now: new Date(claimNow.getTime() + 31_000),
    leaseMs: 30_000,
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.candidateVariant, "orphaned_arrival");
  assert.equal(reclaimed.migration.autoStartRetryAttempts, 2);
});

test("auto-start reconciler skips untyped legacy stuck rows instead of silently sweeping them", async ({ db }) => {

  const { migration } = await seedAutoStartFailedMigration();
  await getDb().update(agentMigrations)
    .set({ autoStartFailureStage: null, autoStartFailureCode: null })
    .where(eq(agentMigrations.id, migration.id));
  const [before] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  const beforeOutbox = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));

  const claim = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-reconciler",
    now: new Date("2026-07-05T14:05:00.000Z"),
  });
  assert.equal(claim, null);

  let startAgentCalls = 0;
  let cancelCalls = 0;
  const workerResult = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator: {
      startAgent: async () => {
        startAgentCalls += 1;
        return { outcome: "dispatched" as const };
      },
      sendAgentMigrationCancel: async () => {
        cancelCalls += 1;
      },
    } as never,
    workerId: "server-boot",
    now: new Date("2026-07-05T14:05:01.000Z"),
  });
  assert.deepEqual(workerResult, { autoStart: false, cancellation: false, deadline: false, sourceArchive: false });
  assert.equal(startAgentCalls, 0);
  assert.equal(cancelCalls, 0);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  const afterOutbox = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.deepEqual(migrationSnapshot(persisted), migrationSnapshot(before));
  assert.deepEqual(afterOutbox, beforeOutbox);
});

test("auto-start reconciler is independent, leased, bounded, and terminalizes with receipt", async ({ db }) => {

  const { sourceMachine, targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  const first = await claimAgentMigrationAutoStartRemediation({
    workerId: "steward-a",
    now: new Date("2026-07-05T14:05:00.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(first);
  assert.equal(first.action, "dispatch");
  assert.equal(first.candidateVariant, "typed_failed");
  assert.ok(first.leaseId?.startsWith("steward-a:"));
  assert.equal(first.migration.failureReason, null);
  assert.equal(first.migration.autoStartRetryAttempts, 1);
  assert.equal(first.migration.autoStartRetryDeadlineAt?.toISOString(), "2026-07-05T14:07:00.000Z");

  await recordAgentMigrationAutoStartFailure({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    stage: "start_agent",
    code: "start_threw",
    now: new Date("2026-07-05T14:05:10.000Z"),
  });
  const contended = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-b",
    now: new Date("2026-07-05T14:05:20.000Z"),
  });
  assert.equal(contended, null);

  for (let attempt = 2; attempt <= AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS; attempt += 1) {
    const retryAt = new Date(Date.parse("2026-07-05T14:05:00.000Z") + attempt * 31_000);
    const claim = await claimAgentMigrationAutoStartRemediation({
      workerId: `server-${attempt}`,
      now: retryAt,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    assert.equal(claim.action, "dispatch");
    assert.equal(claim.candidateVariant, "typed_failed");
    assert.equal(claim.migration.autoStartRetryAttempts, attempt);
    await recordAgentMigrationAutoStartFailure({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      stage: "start_agent",
      code: "start_threw",
      now: new Date(retryAt.getTime() + 1_000),
    });
  }

  const terminal = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-terminal",
    now: new Date("2026-07-05T14:08:00.000Z"),
  });
  assert.ok(terminal);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.candidateVariant, "typed_failed");
  assert.equal(terminal.migration.state, "failed");
  assert.equal(terminal.migration.failureReason, "auto_start_failed");
  assert.equal(terminal.migration.transportTeardownAt?.toISOString(), "2026-07-05T14:08:00.000Z");
  assert.equal(await zenMigrating(agent.id, new Date("2026-07-05T14:08:01.000Z")), false);

  const outbox = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.receiptKind, "failed");

  const successorProvisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: sourceMachine.id,
    now: new Date("2026-07-05T14:09:00.000Z"),
  });
  const successor = successorProvisioning.migration;
  assert.equal(successor.state, "provisioning");
});

test("orphaned exhausted auto-start dispatch terminalizes on successor worker tick", async ({ db }) => {

  const { targetMachine, agent, migration } = await seedAutoStartFailedMigration();

  const first = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-lost-owner",
    now: new Date("2026-07-05T14:05:00.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(first);
  assert.equal(first.action, "dispatch");
  assert.equal(first.candidateVariant, "typed_failed");
  assert.ok(first.leaseId);

  await getDb().update(agentMigrations)
    .set({
      autoStartRetryAttempts: AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS,
      autoStartRetryDeadlineAt: new Date("2026-07-05T14:07:00.000Z"),
    })
    .where(eq(agentMigrations.id, migration.id));

  let startCalls = 0;
  const result = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator: {
      startAgent: async () => {
        startCalls += 1;
        return { outcome: "dispatched" as const };
      },
      sendAgentMigrationCancel: async () => {},
    } as never,
    workerId: "server-successor",
    now: new Date("2026-07-05T14:05:31.000Z"),
  });

  assert.deepEqual(result, { autoStart: true, cancellation: false, deadline: false, sourceArchive: false });
  assert.equal(startCalls, 0);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.failureReason, "auto_start_failed");
  assert.equal(persisted.autoStartFailureStage, "start_agent");
  assert.equal(persisted.autoStartFailureCode, "start_not_dispatched");
  assert.equal(persisted.autoStartRemediationLeaseId, null);
  assert.equal(persisted.autoStartRemediationLeaseExpiresAt, null);
  assert.equal(await zenMigrating(agent.id, new Date("2026-07-05T14:05:32.000Z")), false);

  const outbox = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.receiptKind, "failed");

  const surfaces = await getDb().select().from(agentMigrationReceiptChannels).where(eq(agentMigrationReceiptChannels.migrationId, migration.id));
  assert.equal(surfaces.length, 1);
  const [surfaceShape] = await getDb().select({
    agentMembers: sql<number>`(SELECT count(*)::int FROM channel_agents WHERE channel_id = ${surfaces[0]!.channelId})`,
    humanMembers: sql<number>`(SELECT count(*)::int FROM channel_humans WHERE channel_id = ${surfaces[0]!.channelId})`,
  }).from(channels).where(eq(channels.id, surfaces[0]!.channelId));
  assert.equal(surfaceShape?.agentMembers, 1);
  assert.equal(surfaceShape?.humanMembers, 0);

  await assert.rejects(
    () => recordAgentMigrationAutoStartFailure({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      stage: "start_agent",
      code: "start_threw",
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:33.000Z"),
    }),
    /MIGRATION_NOT_STARTING/,
  );
});

test("server remediation worker dispatches post-arrival auto-start and completes with receipt", async ({ db }) => {

  const { targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  await getDb().update(agentMigrations)
    .set({ transferSummary: TEST_TRANSFER_SUMMARY })
    .where(eq(agentMigrations.id, migration.id));
  let startedAgentId: string | null = null;

  const result = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator: {
      startAgent: async (agentId: string) => {
        startedAgentId = agentId;
        return { outcome: "dispatched" as const };
      },
      sendAgentMigrationCancel: async () => {},
    } as never,
    workerId: "server-remediation",
    now: new Date("2026-07-05T14:05:00.000Z"),
  });

  assert.deepEqual(result, { autoStart: true, cancellation: false, deadline: false, sourceArchive: false });
  assert.equal(startedAgentId, agent.id);
  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.state, "completed");
  assert.equal(persisted.failureReason, null);
  assert.equal(persisted.autoStartRetryAttempts, 1);
  assert.equal(persisted.targetMachineId, targetMachine.id);
  const outbox = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.receiptKind, "completed");
});

test("remediation worker stop prevents new claims while durable leases allow safe successor recovery", async ({ db }) => {

  const worker = startAgentMigrationRemediationWorker({
    io: fakeIo() as never,
    orchestrator: {
      startAgent: async () => ({ outcome: "dispatched" as const }),
      sendAgentMigrationCancel: async () => {},
    } as never,
    workerId: "server-stopping",
    intervalMs: 5,
  });
  worker.stop();

  const { targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  await getDb().update(agentMigrations)
    .set({ transferSummary: TEST_TRANSFER_SUMMARY })
    .where(eq(agentMigrations.id, migration.id));
  await sleep(20);
  const [afterStop] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(afterStop.autoStartRetryAttempts, 0);
  assert.equal(afterStop.autoStartRemediationLeaseId, null);

  const first = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-first",
    now: new Date("2026-07-05T14:05:00.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(first);
  assert.equal(first.action, "dispatch");
  assert.ok(first.leaseId);

  const [firstOwnerRow] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.ok(firstOwnerRow);
  const firstOwnerSnapshot = migrationSnapshot(firstOwnerRow);

  await assert.rejects(
    () => recordAgentMigrationAutoStartFailure({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      stage: "start_agent",
      code: "start_threw",
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:31.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE/,
  );
  const [afterExpiredFailure] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.ok(afterExpiredFailure);
  assert.deepEqual(migrationSnapshot(afterExpiredFailure), firstOwnerSnapshot);

  await assert.rejects(
    () => completeAgentMigrationAutoStart({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:31.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE/,
  );
  const [afterExpiredComplete] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.ok(afterExpiredComplete);
  assert.deepEqual(migrationSnapshot(afterExpiredComplete), firstOwnerSnapshot);

  const successor = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-successor",
    now: new Date("2026-07-05T14:05:31.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(successor);
  assert.equal(successor.action, "dispatch");
  assert.notEqual(successor.leaseId, first.leaseId);
  assert.equal(successor.migration.autoStartRetryAttempts, 2);

  await assert.rejects(
    () => recordAgentMigrationAutoStartFailure({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      stage: "start_agent",
      code: "start_threw",
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:32.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE/,
  );
  await assert.rejects(
    () => completeAgentMigrationAutoStart({
      migrationId: migration.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:33.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE/,
  );

  const completed = await completeAgentMigrationAutoStart({
    migrationId: migration.id,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    remediationLeaseId: successor.leaseId,
    now: new Date("2026-07-05T14:05:34.000Z"),
  });
  assert.equal(completed.state, "completed");
});

test("auto-start reconciler terminalizes when deadline expires even before max attempts", async ({ db }) => {

  const { migration } = await seedAutoStartFailedMigration();

  const first = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-a",
    now: new Date("2026-07-05T14:05:00.000Z"),
  });
  assert.ok(first);
  assert.equal(first.action, "dispatch");

  await getDb().update(agentMigrations)
    .set({ failureReason: "auto_start_failed" })
    .where(eq(agentMigrations.id, migration.id));

  const terminal = await claimAgentMigrationAutoStartRemediation({
    workerId: "server-deadline",
    now: new Date(Date.parse("2026-07-05T14:05:00.000Z") + AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS),
  });
  assert.ok(terminal);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.migration.state, "failed");
});

test("stale post-arrival auto-start dispatch is reclaimable exactly once", async ({ db }) => {

  const { server, targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const { migration } = provisioning;
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z"));
  const arrivalInput = {
    migrationId: migration.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
  };
  const first = await markAgentMigrationTargetImportArrived({
    ...arrivalInput,
    now: new Date("2026-07-05T14:04:00.000Z"),
  });
  assert.equal(first.autoStart, "dispatch");

  const withinLease = await markAgentMigrationTargetImportArrived({
    ...arrivalInput,
    now: new Date("2026-07-05T14:04:29.999Z"),
  });
  assert.equal(withinLease.autoStart, "observe");

  const reclaimAt = new Date(new Date("2026-07-05T14:04:00.000Z").getTime() + AGENT_MIGRATION_AUTO_START_LEASE_MS);
  const replays = await Promise.all([
    markAgentMigrationTargetImportArrived({ ...arrivalInput, now: reclaimAt }),
    markAgentMigrationTargetImportArrived({ ...arrivalInput, now: reclaimAt }),
  ]);
  assert.deepEqual(replays.map((result) => result.autoStart).sort(), ["dispatch", "observe"]);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.state, "starting");
  assert.equal(persisted.failureReason, null);
});

test("active migration unique index prevents split-brain migration grants for one agent", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();

  await beginTestAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
  await assert.rejects(async () => {
    try {
      await beginTestAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
    } catch (err) {
      const message = `${err instanceof Error ? err.message : String(err)} ${(err as { cause?: unknown })?.cause ?? ""}`;
      assert.match(message, /idx_agent_migrations_active_agent|duplicate key|constraint/i);
      throw err;
    }
  });

  const rows = await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
  assert.equal(rows.length, 1);
});

test("transport-lost keeps the daemon's detailed cause while failure_reason stays in the known set", async ({ db }) => {

  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
  const { migration } = provisioning;

  const failed = await markAgentMigrationTransportLostForComputer({
    migrationId: migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    detailCode: "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
    message: "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.failureReason, "MIGRATION_TRANSPORT_LOST");
  assert.equal(
    failed.transportErrorCode,
    "MIGRATION_TARGET_IMPORT_ARRIVED_FAILED:503:migration_source_workspace_archive_failed",
  );

  // A repeated report from the other side is idempotent on the known reason.
  const repeated = await markAgentMigrationTransportLostForComputer({
    migrationId: migration.id,
    serverId: server.id,
    machineId: targetMachine.id,
    detailCode: "FETCH_ECONNRESET",
  });
  assert.equal(repeated.revision, failed.revision);
  assert.equal(repeated.transportErrorCode, failed.transportErrorCode);
});

test("a pre-flip migration whose transfer run was lost is re-provisioned under a new transport generation", async ({ db }) => {

  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T14:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-original",
    transportLeaseMs: 60 * 60 * 1000,
    transportMaxBytes: 10_000,
  });
  const oldGeneration = provisioned.migration.transportGeneration!;
  const provision = {
    provider: "object_store" as const,
    sessionId: "session-rotated",
    leaseMs: 60 * 60 * 1000,
    maxBytes: 10_000,
    storageKey: "rotated",
  };

  // A lease younger than the minimum age may still be in flight: leave it alone.
  assert.equal(await reprovisionAgentMigrationTransport({
    migrationId: provisioned.migration.id,
    expectedTransportGeneration: oldGeneration,
    provision,
    now: new Date(t0.getTime() + 5_000),
  }), null);

  const later = new Date(t0.getTime() + AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS + 1_000);
  const rotated = await reprovisionAgentMigrationTransport({
    migrationId: provisioned.migration.id,
    expectedTransportGeneration: oldGeneration,
    provision,
    now: later,
  });
  assert.ok(rotated);
  assert.notEqual(rotated.migration.transportGeneration, oldGeneration);
  assert.equal(rotated.migration.transportLeaseId, "session-rotated");
  assert.equal(rotated.migration.transportControlSha256, null);
  assert.equal(rotated.migration.sourceQuiesceReceipt, null);
  assert.equal(rotated.migration.transportExpectedMigrationRevision, rotated.migration.revision);
  assert.equal(rotated.source.message.transportGeneration, rotated.migration.transportGeneration);
  assert.equal(rotated.target?.message.transportGeneration, rotated.migration.transportGeneration);
  assert.notEqual(rotated.source.message.bearerToken, provisioned.source.message.bearerToken);

  // Only the generation that was observed missing is replaced (no double rotation).
  assert.equal(await reprovisionAgentMigrationTransport({
    migrationId: provisioned.migration.id,
    expectedTransportGeneration: oldGeneration,
    provision,
    now: new Date(later.getTime() + 60_000),
  }), null);

  // The old generation's still-running peer reports transport-lost: ignored.
  const afterStale = await markAgentMigrationTransportLostForComputer({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: targetMachine.id,
    code: "MIGRATION_GENERATION_STALE",
    transportGeneration: oldGeneration,
  });
  assert.equal(afterStale.state, provisioned.migration.state);
  assert.equal(afterStale.revision, rotated.migration.revision);

  // A failure in the current generation still fails the migration.
  const failed = await markAgentMigrationTransportLostForComputer({
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: sourceMachine.id,
    transportGeneration: rotated.migration.transportGeneration,
  });
  assert.equal(failed.state, "failed");

  // Post-flip / terminal rows are never re-provisioned.
  assert.equal(await reprovisionAgentMigrationTransport({
    migrationId: provisioned.migration.id,
    expectedTransportGeneration: rotated.migration.transportGeneration!,
    provision,
    now: new Date(later.getTime() + 120_000),
  }), null);
});

test("a target that lost its run gets its lease re-issued under the same generation, even after upload", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-05T14:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-target-reissue",
    transportLeaseMs: 60 * 60 * 1000,
    transportMaxBytes: 10_000,
  });
  const generation = provisioned.migration.transportGeneration!;
  const later = new Date(t0.getTime() + AGENT_MIGRATION_LEASE_REPROVISION_MIN_AGE_MS + 1_000);
  // Upload already completed: the row is `ready`. The source no longer matters; the target does.
  await getDb().update(agentMigrations).set({ state: "ready" }).where(eq(agentMigrations.id, provisioned.migration.id));
  const [ready] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, provisioned.migration.id));
  assert.equal(agentMigrationLostRunRecovery(ready, "source", later), null);
  assert.equal(agentMigrationLostRunRecovery(ready, "target", later), "reissue_target_lease");
  assert.equal(agentMigrationLostRunRecovery(ready, "target", new Date(t0.getTime() + 1_000)), null, "in-flight first lease");

  const delivery = await reissueAgentMigrationTargetLease({
    migrationId: ready.id,
    expectedTransportGeneration: generation,
    now: later,
  });
  assert.ok(delivery);
  assert.equal(delivery.role, "target");
  assert.equal(delivery.message.transportGeneration, generation, "same generation: the download resumes");
  assert.notEqual(delivery.message.bearerToken, provisioned.target.message.bearerToken);
  const [after] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, ready.id));
  assert.equal(after.revision, ready.revision, "no revision bump");
  assert.equal(after.sourceTransportTokenHash, ready.sourceTransportTokenHash);
  assert.notEqual(after.targetTransportTokenHash, ready.targetTransportTokenHash);

  // A superseded generation or a post-flip row is not re-issued.
  assert.equal(await reissueAgentMigrationTargetLease({
    migrationId: ready.id,
    expectedTransportGeneration: "agent_migration_transport:other",
    now: later,
  }), null);
  await getDb().update(agentMigrations).set({ state: "arriving" }).where(eq(agentMigrations.id, ready.id));
  assert.equal(await reissueAgentMigrationTargetLease({
    migrationId: ready.id,
    expectedTransportGeneration: generation,
    now: later,
  }), null);
});

test("elapsed deadlines exit the zen migrating gate on read, and only the sweep aborts and frees the grant", async ({ db }) => {

  const { sourceMachine, targetMachine, agent } = await seedMigrationFixture();

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    prepDeadlineMs: 1000,
  });
  const { migration } = provisioning;
  const [before] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));

  assert.equal(await zenMigrating(agent.id, new Date("2026-07-05T14:00:00.500Z")), true);
  const afterDeadline = new Date("2026-07-05T14:00:02.000Z");
  const expired = await getAgentMigrationGateStatus(agent.id, getDb(), afterDeadline);
  assert.equal(expired.migration, null, "an expired migration no longer gates delivery");
  assert.equal(await zenMigrating(agent.id, afterDeadline), false);
  const status = await getLatestAgentMigration(agent.id, getDb(), afterDeadline);
  assert.equal(status?.id, migration.id);
  assert.equal(status?.state, "aborted", "the status read reports the migration as the sweep will leave it");
  assert.equal(status?.abortReason, "prep-deadline");

  // Reads are pure: the row, its receipts, and the agent's machine are untouched.
  const [unchanged] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.deepEqual(unchanged, before);
  assert.deepEqual(await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migration.id)), []);
  const [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, sourceMachine.id, "pre-flip, delivery stays on the source");

  const swept = await sweepElapsedAgentMigrationDeadline({ now: afterDeadline });
  assert.equal(swept?.id, migration.id);
  const [aborted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.abortReason, "prep-deadline");
  assert.equal(aborted.revision, status?.revision, "the projection matches what the sweep wrote");

  const retryProvisioning = await beginTestAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
  const retry = retryProvisioning.migration;
  assert.equal(retry.state, "provisioning");
});

test("a post-flip expired migration stops gating on read and stays on the target until the sweep aborts it", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    arrivalDeadlineMs: 60_000,
  });
  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:00:01.000Z") });
  await startTestAgentMigrationTransfer(provisioning.migration.id, new Date("2026-07-05T14:00:02.000Z"));
  const arriving = await flipTestAgentMigration(provisioning.migration.id, new Date("2026-07-05T14:00:03.000Z"));
  assert.equal(arriving.state, "arriving");
  const afterDeadline = new Date(arriving.arrivalDeadlineAt.getTime() + 1_000);

  assert.equal((await getAgentMigrationGateStatus(agent.id, getDb(), afterDeadline)).migration, null);
  assert.equal((await getLatestAgentMigration(agent.id, getDb(), afterDeadline))?.abortReason, "arrival-deadline");
  const [unchanged] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(unchanged.state, "arriving");
  assert.equal(unchanged.revision, arriving.revision);
  const [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, targetMachine.id, "post-flip, delivery goes to the target");

  const swept = await sweepElapsedAgentMigrationDeadline({ now: afterDeadline });
  assert.equal(swept?.state, "aborted");
  assert.equal(swept?.abortReason, "arrival-deadline");
});

test("remediation sweeps an elapsed deadline without any delivery touching the agent", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    prepDeadlineMs: 1000,
  });
  const { migration } = provisioning;

  assert.equal(await sweepElapsedAgentMigrationDeadline({ now: new Date("2026-07-05T14:00:00.500Z") }), null);

  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(makeAvailableReplicaStateStore(), undefined, new BasicTracer({ sink }));
  const migrationAbortedEvents = () => sink.getAllSpans()
    .filter((span) => span.name === "server.agent.migration.deadline_expired")
    .flatMap((span) => span.events)
    .filter((event) => event.name === "agent.lifecycle.event" && event.attrs?.event_type === "migration_aborted");
  const result = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator,
    workerId: "server-sweeper",
    now: new Date("2026-07-05T14:00:02.000Z"),
  });
  assert.equal(result.deadline, true);

  const [aborted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.abortReason, "prep-deadline");
  // The agent is told (the receipt is queued with the abort, not a precondition of it).
  const abortedReceipts = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.deepEqual(abortedReceipts.map((row) => row.receiptKind), ["aborted"]);
  // The sweep's abort emits migration_aborted, once.
  const emitted = migrationAbortedEvents();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.attrs?.reason, "migration_abort");
  assert.equal(
    emitted[0]!.attrs?.idempotency_key,
    `agent_migration:${migration.supportRef}:migration_aborted:${aborted.revision}`,
  );

  const again = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator,
    workerId: "server-sweeper",
    now: new Date("2026-07-05T14:00:03.000Z"),
  });
  assert.equal(again.deadline, false);
  assert.equal(migrationAbortedEvents().length, 1, "a later tick does not re-emit");
  assert.equal(await sweepElapsedAgentMigrationDeadline({ now: new Date("2026-07-05T14:00:03.000Z") }), null);
});

test("migration aborted lifecycle event uses control-class names without leaking grant keys", async ({ db }) => {

  const { targetMachine, sourceMachine, agent } = await seedMigrationFixture();

  const provisioning = await beginTestAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const { migration } = provisioning;
  const preFlipAbortEvent = createAgentMigrationLifecycleEvent({
    migration,
    occurredAt: "2026-07-05T14:00:00.000Z",
  });
  assert.equal(preFlipAbortEvent.eventType, "migration_aborted");
  assert.equal(preFlipAbortEvent.reason, "migration_abort");
  assert.equal(preFlipAbortEvent.machineId, sourceMachine.id);
  assert.equal(preFlipAbortEvent.correlationId, `agent_migration:${migration.supportRef}`);
  assert.equal(preFlipAbortEvent.idempotencyKey, `agent_migration:${migration.supportRef}:migration_aborted:${migration.revision}`);

  await markTestAgentMigrationReady(provisioning, { now: new Date("2026-07-05T14:01:00.000Z") });
  await startTestAgentMigrationTransfer(migration.id, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipTestAgentMigration(migration.id, new Date("2026-07-05T14:03:00.000Z"));

  const arrivingAbortEvent = createAgentMigrationLifecycleEvent({ migration: arriving });
  assert.equal(arrivingAbortEvent.reason, "migration_abort");
  assert.equal(arrivingAbortEvent.machineId, targetMachine.id);
});

test("safe cancel terminalizes, keeps cleanup fenced, and lets server/steward retry independently", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "cancel-session",
    now: new Date("2026-08-03T08:00:00.000Z"),
  });
  assert.match(provisioned.migration.supportRef, /^mig_[A-Za-z0-9_-]{22}$/);

  const requested = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: provisioned.migration.supportRef,
    expectedRevision: provisioned.migration.revision,
    initiatedByUserId: user.id,
    reason: "owner_cancel",
    now: new Date("2026-08-03T08:00:01.000Z"),
  });
  assert.equal(requested.migration.state, "canceled_pre_flip");
  assert.equal(requested.migration.cancelTransportGeneration, provisioned.migration.transportGeneration);
  assert.equal(requested.dispatch, "required");
  const generation = requested.migration.cancelGeneration!;
  const transportGeneration = requested.migration.cancelTransportGeneration!;
  const deliveries = buildAgentMigrationCancellationDeliveries(requested.migration);
  assert.deepEqual(deliveries.map((delivery) => [delivery.message.role, delivery.message.stopAgent]), [
    ["source", false],
    ["target", false],
  ]);

  const afterLegacyDeadlines = new Date("2030-08-03T08:00:00.000Z");
  assert.equal(
    planZenMigratingDelivery({ migration: requested.migration, now: afterLegacyDeadlines }).action,
    "deliver",
  );
  const gateDuringCancellation = await getAgentMigrationGateStatus(agent.id, undefined, afterLegacyDeadlines);
  assert.equal(gateDuringCancellation.migration, null);
  await assert.rejects(
    () => markAgentMigrationTransportLostForComputer({
      migrationId: requested.migration.id,
      serverId: server.id,
      machineId: sourceMachine.id,
      now: afterLegacyDeadlines,
    }),
    /MIGRATION_NOT_ACTIVE/,
  );
  assert.equal(await sweepElapsedAgentMigrationDeadline({ now: afterLegacyDeadlines }), null);

  const duplicateRequest = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: provisioned.migration.supportRef,
    expectedRevision: provisioned.migration.revision,
    initiatedByUserId: user.id,
    reason: "duplicate",
    now: new Date("2026-08-03T08:00:02.000Z"),
  });
  assert.equal(duplicateRequest.dispatch, "none");
  assert.equal(duplicateRequest.migration.cancelGeneration, generation);
  assert.equal(duplicateRequest.migration.revision, requested.migration.revision);

  const retried = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-cleanup-worker-a",
    now: new Date("2026-08-03T08:00:02.000Z"),
  });
  assert.equal(retried?.dispatch, "required");
  assert.equal(retried?.migration.cancelGeneration, generation);
  assert.equal(retried?.migration.cancelDispatchAttempts, 2);
  assert.ok(retried?.leaseId);
  const contended = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-cleanup-worker-b",
    now: new Date("2026-08-03T08:00:02.100Z"),
  });
  assert.equal(contended, null);
  const lastDispatch = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-cleanup-worker-b",
    now: new Date("2026-08-03T08:00:40.000Z"),
  });
  assert.equal(lastDispatch?.dispatch, "required");
  assert.equal(lastDispatch?.migration.cancelDispatchAttempts, 3);
  const exhausted = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-cleanup-worker-a",
    now: new Date("2026-08-03T08:01:11.000Z"),
  });
  assert.ok(exhausted);
  assert.equal(exhausted.dispatch, "none");
  assert.equal(exhausted.migration.cancelErrorCode, "cancel_dispatch_retry_exhausted");
  assert.ok(exhausted.migration.cancelNeedsAttentionAt);
  await assert.rejects(
    () => acknowledgeAgentMigrationCancellation({
      migrationId: requested.migration.id,
      migrationRef: requested.migration.supportRef,
      transportGeneration: "stale-transport-generation",
      cancelGeneration: generation,
      serverId: server.id,
      machineId: sourceMachine.id,
      role: "source",
      outcome: "cleaned",
    }),
    /MIGRATION_GENERATION_STALE/,
  );

  const sourceAck = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration,
    cancelGeneration: generation,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    outcome: "cleaned",
    now: new Date("2026-08-03T08:00:03.000Z"),
  });
  assert.equal(sourceAck.state, "canceled_pre_flip");
  assert.equal(sourceAck.cancelSourceOutcome, "cleaned");
  assert.ok(sourceAck.canceledAt);
  assert.ok(sourceAck.cancelNeedsAttentionAt);

  const terminal = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration,
    cancelGeneration: generation,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    outcome: "cleaned",
    now: new Date("2026-08-03T08:00:04.000Z"),
  });
  assert.equal(terminal.state, "canceled_pre_flip");
  assert.equal(terminal.cancelNeedsAttentionAt, null);
  assert.equal(projectAgentMigrationUpdatedPayload(terminal).authority, "source");
  assert.equal(projectAgentMigrationUpdatedPayload(terminal).migrationRef, provisioned.migration.supportRef);

  const duplicateAck = await acknowledgeAgentMigrationCancellation({
    migrationId: retried.migration.id,
    migrationRef: retried.migration.supportRef,
    transportGeneration,
    cancelGeneration: generation,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    outcome: "cleaned",
  });
  assert.equal(duplicateAck.revision, terminal.revision);
});

test("server remediation worker dispatches pending migration cancellation deliveries", async ({ db }) => {

  const { user, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "worker-cancel-session",
    now: new Date("2026-08-03T08:00:00.000Z"),
  });
  const requested = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: provisioned.migration.supportRef,
    expectedRevision: provisioned.migration.revision,
    initiatedByUserId: user.id,
    reason: "owner_cancel",
    now: new Date("2026-08-03T08:00:01.000Z"),
  });
  const sent: Array<{ machineId: string; role: string; migrationRef: string }> = [];

  const result = await drainAgentMigrationRemediation({
    io: fakeIo() as never,
    orchestrator: {
      startAgent: async () => ({ outcome: "dispatched" as const }),
      sendAgentMigrationCancel: async (machineId: string, message: { role: string; migrationRef: string }) => {
        sent.push({ machineId, role: message.role, migrationRef: message.migrationRef });
      },
    } as never,
    workerId: "server-cancel-worker",
    now: new Date("2026-08-03T08:00:02.000Z"),
  });

  assert.deepEqual(result, { autoStart: false, cancellation: true, deadline: false, sourceArchive: false });
  assert.deepEqual(sent, [
    { machineId: sourceMachine.id, role: "source", migrationRef: requested.migration.supportRef },
    { machineId: targetMachine.id, role: "target", migrationRef: requested.migration.supportRef },
  ]);
  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, requested.migration.id));
  assert.equal(persisted.cancelDispatchAttempts, 2);
  assert.ok(persisted.cancelCleanupLeaseId?.startsWith("server-cancel-worker:"));
  assert.equal(persisted.cancelNeedsAttentionAt, null);
});

test("cancellation cleanup stale owners cannot write after durable lease successor claim", async ({ db }) => {

  const { user, sourceMachine, targetMachine, agent, server } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "worker-cancel-stale-session",
    now: new Date("2026-08-03T08:00:00.000Z"),
  });
  const requested = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: provisioned.migration.supportRef,
    expectedRevision: provisioned.migration.revision,
    initiatedByUserId: user.id,
    reason: "owner_cancel",
    now: new Date("2026-08-03T08:00:01.000Z"),
  });
  const first = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-first",
    now: new Date("2026-08-03T08:00:02.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(first);
  assert.equal(first.dispatch, "required");
  assert.ok(first.leaseId);

  const [firstOwnerRow] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, requested.migration.id));
  assert.ok(firstOwnerRow);
  const firstOwnerSnapshot = migrationSnapshot(firstOwnerRow);

  await assert.rejects(
    () => acknowledgeAgentMigrationCancellation({
      migrationId: requested.migration.id,
      migrationRef: requested.migration.supportRef,
      transportGeneration: requested.migration.cancelTransportGeneration!,
      cancelGeneration: requested.migration.cancelGeneration!,
      serverId: server.id,
      machineId: sourceMachine.id,
      role: "source",
      outcome: "needs_attention",
      cleanupLeaseId: first.leaseId,
      errorCode: "late_owner_before_successor",
      now: new Date("2026-08-03T08:00:33.000Z"),
    }),
    /MIGRATION_CANCEL_CLEANUP_LEASE_STALE/,
  );
  const [afterExpiredAttention] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, requested.migration.id));
  assert.ok(afterExpiredAttention);
  assert.deepEqual(migrationSnapshot(afterExpiredAttention), firstOwnerSnapshot);

  const successor = await claimAgentMigrationCancellationCleanup({
    workerId: "cancel-successor",
    now: new Date("2026-08-03T08:00:33.000Z"),
    leaseMs: 30_000,
  });
  assert.ok(successor);
  assert.equal(successor.dispatch, "required");
  assert.notEqual(successor.leaseId, first.leaseId);

  await assert.rejects(
    () => acknowledgeAgentMigrationCancellation({
      migrationId: requested.migration.id,
      migrationRef: requested.migration.supportRef,
      transportGeneration: requested.migration.cancelTransportGeneration!,
      cancelGeneration: requested.migration.cancelGeneration!,
      serverId: server.id,
      machineId: sourceMachine.id,
      role: "source",
      outcome: "needs_attention",
      cleanupLeaseId: first.leaseId,
      errorCode: "late_owner",
      now: new Date("2026-08-03T08:00:34.000Z"),
    }),
    /MIGRATION_CANCEL_CLEANUP_LEASE_STALE/,
  );

  const attention = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration!,
    cancelGeneration: requested.migration.cancelGeneration!,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    outcome: "needs_attention",
    cleanupLeaseId: successor.leaseId,
    errorCode: "successor_owner",
    now: new Date("2026-08-03T08:00:35.000Z"),
  });
  assert.equal(attention.cancelErrorCode, "successor_owner");
});

test("cancel recovery teeth prove unavailable control, released gate, and next migration admission", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const migrationStartedAt = new Date("2026-08-03T08:30:00.000Z");
  const transferDeadlineAt = new Date(migrationStartedAt.getTime() + 60_000);
  const arrivalDeadlineAt = new Date(migrationStartedAt.getTime() + 120_000);
  const activeGateNow = new Date(migrationStartedAt.getTime() + 2_000);
  const postTerminalNow = new Date(migrationStartedAt.getTime() + 4_000);
  // deliverMessageToAgent reaches the migration gate through currentDate(), so
  // this fixture must own the clock instead of relying on a future wall date.
  vi.useFakeTimers({ toFake: ["Date"], now: activeGateNow });
  const [nextTargetMachine] = await getDb().insert(machines).values({
    id: "66666666-6666-6666-6666-666666666666",
    serverId: server.id,
    userId: user.id,
    name: "next-target-mac",
    apiKeyHash: "next-target-key",
    runtimes: ["codex"],
    lastHeartbeat: migrationStartedAt,
  }).returning();
  assert.ok(nextTargetMachine);
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "cancel-recovery-teeth",
    now: migrationStartedAt,
  });
  const [active] = await getDb().update(agentMigrations)
    .set({
      state: "in_transit",
      transportGeneration: "cancel-recovery-generation",
      transferDeadlineAt,
      arrivalDeadlineAt,
      updatedAt: new Date("2026-08-03T08:30:01.000Z"),
    })
    .where(eq(agentMigrations.id, provisioned.migration.id))
    .returning();
  assert.ok(active);
  const [messageChannel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: "migration-control-proof",
    type: "channel",
  }).returning();
  assert.ok(messageChannel);
  await getDb().insert(channelAgents).values({
    channelId: messageChannel.id,
    agentId: agent.id,
  });
  const orchestrator = new TestAgentOrchestrator();
  await orchestrator.registerMachine(sourceMachine.id, server.id, makeFakeMachineWs() as never);
  let canceled: Awaited<ReturnType<typeof requestAgentMigrationCancellation>> | null = null;
  try {
    const controlDecision = planZenMigratingDelivery({
      migration: {
        state: active.state,
        prepDeadlineAt: active.prepDeadlineAt,
        transferDeadlineAt: active.transferDeadlineAt,
        arrivalDeadlineAt: active.arrivalDeadlineAt,
      },
      now: activeGateNow,
    });
    if (controlDecision.action !== "queue") {
      throw new Error("CANNOT_RUN_CANCEL_RECOVERY_UNAVAILABLE_CONTROL_MISSING");
    }
    const activeGateMessage = await createMessage(
      messageChannel.id,
      "user",
      user.id,
      "ordinary message while migration gate is active",
    );
    const activeGateDelivery = await deliverMessageToAgent(
      orchestrator,
      activeGateMessage.id,
      agent.id,
      { requireQueueReceipt: true },
    );
    assert.deepEqual(activeGateDelivery, { status: "queued", reason: "control_gate_inbox" });
    assert.deepEqual(
      orchestrator.peekPendingMessages(agent.id).map((message) => message.message_id),
      [activeGateMessage.id],
    );

    canceled = await requestAgentMigrationCancellation({
      agentId: agent.id,
      migrationRef: active.supportRef,
      expectedRevision: active.revision,
      initiatedByUserId: user.id,
      reason: "owner_cancel",
      now: new Date("2026-08-03T08:30:03.000Z"),
    });
    assert.equal(canceled.migration.state, "canceled_pre_flip");
    assert.equal(await zenMigrating(agent.id, postTerminalNow), false);
    assert.equal((await getAgentMigrationGateStatus(agent.id, undefined, postTerminalNow)).migration, null);
    assert.equal(
      planZenMigratingDelivery({
        migration: canceled.migration,
        now: postTerminalNow,
      }).action,
      "deliver",
    );
    vi.setSystemTime(postTerminalNow);
    const postTerminalMessage = await createMessage(
      messageChannel.id,
      "user",
      user.id,
      "ordinary message after migration terminalization",
    );
    const postTerminalDelivery = await deliverMessageToAgent(
      orchestrator,
      postTerminalMessage.id,
      agent.id,
      { requireQueueReceipt: true },
    );
    assert.deepEqual(postTerminalDelivery, { status: "queued", reason: "replayable_inbox" });
    assert.deepEqual(
      orchestrator.peekPendingMessages(agent.id).map((message) => message.message_id),
      [activeGateMessage.id, postTerminalMessage.id],
    );
    assert.deepEqual(orchestrator.deliverMessageCalls, [activeGateMessage.id, postTerminalMessage.id]);
  } finally {
    orchestrator.shutdown();
  }
  assert.ok(canceled);

  const successor = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: nextTargetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "cancel-recovery-successor",
    now: new Date("2026-08-03T08:30:05.000Z"),
  });
  assert.equal(successor.migration.state, "provisioning");
  assert.notEqual(successor.migration.id, canceled.migration.id);
});

test("post-flip cancel truthfully retains target authority", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "post-flip-cancel-session",
    now: new Date("2026-08-03T09:00:00.000Z"),
  });
  const flippedAt = new Date("2026-08-03T09:00:01.000Z");
  const [flipped] = await getDb().update(agentMigrations)
    .set({ state: "arriving", flippedAt, revision: provisioned.migration.revision + 1, updatedAt: flippedAt })
    .where(eq(agentMigrations.id, provisioned.migration.id))
    .returning();
  await getDb().update(agents).set({ machineId: targetMachine.id, updatedAt: flippedAt }).where(eq(agents.id, agent.id));

  const requested = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: flipped.supportRef,
    expectedRevision: flipped.revision,
    initiatedByUserId: user.id,
    reason: "owner_cancel_after_flip",
    now: new Date("2026-08-03T09:00:02.000Z"),
  });
  assert.equal(requested.migration.state, "canceled_post_flip");
  assert.equal(requested.disposition, "post_flip_target_authoritative");
  assert.equal(projectAgentMigrationUpdatedPayload(requested.migration).authority, "target");
  assert.deepEqual(
    buildAgentMigrationCancellationDeliveries(requested.migration).map((delivery) => [delivery.message.role, delivery.message.stopAgent]),
    [["source", false], ["target", true]],
  );

  await assert.rejects(
    () => acknowledgeAgentMigrationCancellation({
      migrationId: requested.migration.id,
      migrationRef: requested.migration.supportRef,
      transportGeneration: requested.migration.cancelTransportGeneration!,
      cancelGeneration: requested.migration.cancelGeneration!,
      serverId: server.id,
      machineId: targetMachine.id,
      role: "target",
      outcome: "cleaned",
      now: new Date("2026-08-03T09:00:02.500Z"),
    }),
    /MIGRATION_CANCEL_OUTCOME_MISMATCH/,
  );
  const [afterRejectedTargetAck] = await getDb().select()
    .from(agentMigrations)
    .where(eq(agentMigrations.id, requested.migration.id));
  assert.equal(afterRejectedTargetAck.state, "canceled_post_flip");
  assert.equal(afterRejectedTargetAck.cancelTargetAckAt, null);
  assert.equal(afterRejectedTargetAck.cancelTargetOutcome, null);
  assert.ok(afterRejectedTargetAck.canceledAt);
  assert.ok(afterRejectedTargetAck.transportTeardownAt);
  assert.equal(afterRejectedTargetAck.revision, requested.migration.revision);

  const sourceAcknowledged = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration!,
    cancelGeneration: requested.migration.cancelGeneration!,
    serverId: server.id,
    machineId: sourceMachine.id,
    role: "source",
    outcome: "cleaned",
    now: new Date("2026-08-03T09:00:03.000Z"),
  });
  assert.equal(sourceAcknowledged.state, "canceled_post_flip");
  assert.equal(projectAgentMigrationUpdatedPayload(sourceAcknowledged).authority, "target");

  const terminal = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration!,
    cancelGeneration: requested.migration.cancelGeneration!,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    outcome: "stopped",
    now: new Date("2026-08-03T09:00:04.000Z"),
  });
  assert.equal(terminal.state, "canceled_post_flip");
  assert.equal(projectAgentMigrationUpdatedPayload(terminal).authority, "target");

  const duplicateAck = await acknowledgeAgentMigrationCancellation({
    migrationId: requested.migration.id,
    migrationRef: requested.migration.supportRef,
    transportGeneration: requested.migration.cancelTransportGeneration!,
    cancelGeneration: requested.migration.cancelGeneration!,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target",
    outcome: "stopped",
  });
  assert.equal(duplicateAck.revision, terminal.revision);
});

test("migration target kind: the database keeps the Computer and hosted shapes apart", async ({ db }) => {
  const { user, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "target-kind-session",
    now: new Date("2026-10-18T05:00:00.000Z"),
  });
  const migration = provisioned.migration;
  assert.equal(migration.targetKind, "computer");
  assert.equal(isComputerTargetMigration(migration), true);
  assert.equal(requireComputerTarget(migration).targetMachineId, targetMachine.id);

  const rejects = async (patch: string) => {
    await assert.rejects(
      db.execute(sql.raw(`UPDATE agent_migrations SET ${patch} WHERE id = '${migration.id}'`)),
      (error: unknown) => String((error as { cause?: unknown })?.cause ?? error).includes("agent_migrations_target_kind_shape"),
    );
  };
  // A Computer target must name its machine; a hosted target must name none.
  await rejects("target_machine_id = NULL");
  await rejects("target_machine_name_snapshot = NULL");
  await rejects("target_kind = 'hosted'");
  await rejects(`target_kind = 'hosted', target_machine_id = NULL`);

  await db.update(agentMigrations)
    .set({ targetKind: "hosted", targetMachineId: null, targetMachineNameSnapshot: null })
    .where(eq(agentMigrations.id, migration.id));
  await db.insert(agentMigrationHostedTargets).values({ migrationId: migration.id, provider: "antiproton" });
  const [hosted] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(hosted.targetKind, "hosted");
  assert.equal(isComputerTargetMigration(hosted), false);
  assert.throws(() => requireComputerTarget(hosted), /MIGRATION_TARGET_NOT_COMPUTER/);

  const [detail] = await db.select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, migration.id));
  assert.equal(detail.provider, "antiproton");
  assert.equal(detail.reviewConfirmedAt, null);
});

test("hosted target: cancel goes to the source daemon only, and lifecycle events name no target machine", async ({ db }) => {
  const { user, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "hosted-cancel-session",
    now: new Date("2026-10-18T05:00:00.000Z"),
  });
  const requested = await requestAgentMigrationCancellation({
    agentId: agent.id,
    migrationRef: provisioned.migration.supportRef,
    expectedRevision: provisioned.migration.revision,
    initiatedByUserId: user.id,
    reason: "owner_cancel",
    now: new Date("2026-10-18T05:00:01.000Z"),
  });
  const hosted = { ...requested.migration, targetKind: "hosted" as const, targetMachineId: null, targetMachineNameSnapshot: null };
  const deliveries = buildAgentMigrationCancellationDeliveries(hosted);
  assert.deepEqual(deliveries.map((delivery) => [delivery.machineId, delivery.message.role]), [[sourceMachine.id, "source"]]);

  const flippedEvent = createAgentMigrationLifecycleEvent({ migration: { ...hosted, flippedAt: new Date("2026-10-18T05:00:02.000Z") } });
  assert.equal(flippedEvent.machineId, undefined);

  // The real row stays a Computer migration and still tells both daemons.
  const [stored] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, requested.migration.id));
  assert.deepEqual(buildAgentMigrationCancellationDeliveries(stored).map((delivery) => delivery.message.role), ["source", "target"]);
});

test("a finished migration tells the Computer to stop transferring instead of waiting", async ({ db }) => {
  const { server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const t0 = new Date("2099-07-06T14:00:00.000Z");
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-finished",
    transportLeaseMs: 6 * 60 * 60 * 1000,
  });
  const targetActor = {
    migrationId: provisioned.migration.id,
    serverId: server.id,
    machineId: targetMachine.id,
    role: "target" as const,
    transportToken: provisioned.target.message.bearerToken,
  };
  // While the source is still uploading the target hears "not ready yet" and keeps waiting.
  await assert.rejects(
    () => getAgentMigrationResumableControl({ ...targetActor, now: new Date(t0.getTime() + 1_000) }),
    /MIGRATION_CONTROL_MANIFEST_MISSING/,
  );

  const afterPrepDeadline = new Date(t0.getTime() + 60 * 60 * 1000);
  const swept = await sweepElapsedAgentMigrationDeadline({ now: afterPrepDeadline });
  assert.equal(swept?.state, "aborted");
  // The lease runs for hours more, but the migration is over: answer 410, not 409.
  await assert.rejects(
    () => getAgentMigrationResumableControl({ ...targetActor, now: afterPrepDeadline }),
    /MIGRATION_TRANSFER_ENDED/,
  );
  await assert.rejects(
    () => planAgentMigrationChunkTransfers({
      ...targetActor,
      machineId: sourceMachine.id,
      role: "source",
      transportToken: provisioned.source.message.bearerToken,
      now: afterPrepDeadline,
    }),
    /MIGRATION_TRANSFER_ENDED/,
  );
});
