import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, vi } from "vitest";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  type AgentMigrationControlManifest,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
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
} from "../db/schema.js";
import {
  AGENT_MIGRATION_AUTO_START_LEASE_MS,
  AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS,
  AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS,
  DEFAULT_AGENT_MIGRATION_TRANSPORT_MAX_BYTES,
  abortAgentMigration,
  agentMigrationGeneration,
  beginAgentMigration,
  beginAgentMigrationProvisioning,
  buildAgentMigrationCancellationDeliveries,
  claimAgentMigrationAutoStartRemediation,
  claimAgentMigrationCancellationCleanup,
  completeAgentMigrationResumableUpload,
  completeAgentMigrationAutoStart,
  createAgentMigrationLifecycleEvent,
  evaluateAgentMigrationTransferLeaseReady,
  flipAgentMigrationMachine,
  getActiveAgentMigration,
  getAgentMigrationGateStatus,
  getAgentMigrationHistory,
  isAgentZenMigrating,
  markAgentMigrationTargetImportArrived,
  markAgentMigrationReady,
  markAgentMigrationTransportLost,
  markAgentMigrationTransportProvisioned,
  planZenMigratingDelivery,
  planAgentMigrationChunkTransfers,
  projectAgentMigrationUpdatedPayload,
  provisionAgentMigrationObjectStoreTransfer,
  recordAgentMigrationChunkReceipt,
  recordAgentMigrationSourceWorkspaceArchived,
  recordAgentMigrationSourceQuiesced,
  recordAgentMigrationAutoStartFailure,
  requestAgentMigrationCancellation,
  acknowledgeAgentMigrationCancellation,
  registerAgentMigrationControlManifest,
  startAgentMigrationTransfer,
} from "./agentMigrationService.js";
import {
  drainAgentMigrationRemediation,
  startAgentMigrationRemediationWorker,
} from "./agentMigrationRemediationWorker.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { createMessage, deliverMessageToAgent } from "./messageService.js";
import type { ReplicaStateStore } from "./replicaStateStore.js";


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
    setAgentRuntimeError: async () => {},
    getAgentRuntimeError: async () => null,
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("server lifecycle wires the migration remediation worker and stops it on shutdown", async () => {
  const source = await readFile(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ startAgentMigrationRemediationWorker \} from "\.\/services\/agentMigrationRemediationWorker\.js";/);
  assert.match(source, /const agentMigrationRemediationWorker = startAgentMigrationRemediationWorker\(\{\s*io,\s*orchestrator: agentOrchestrator,\s*\}\);/s);
  assert.match(source, /agentMigrationRemediationWorker\.stop\(\);/);
});

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
  grantKey: string;
  agentId: string;
  targetMachineId: string;
  initiatedByUserId: string;
  reportPath?: string;
  reportSha256?: string;
  now: Date;
}) {
  const db = getDb();
  const [migration] = await db.select().from(agentMigrations).where(eq(agentMigrations.grantKey, input.grantKey));
  assert.ok(migration);
  await db.update(agentMigrations).set({
    initiatedByUserId: input.initiatedByUserId,
    transferSummary: TEST_TRANSFER_SUMMARY,
  }).where(eq(agentMigrations.id, migration.id));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    grantKey: input.grantKey,
    migrationGeneration: agentMigrationGeneration(migration),
    serverId: migration.serverId,
    targetMachineId: input.targetMachineId,
    now: input.now,
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    grantKey: input.grantKey,
    migrationGeneration: archived.migrationGeneration,
    serverId: migration.serverId,
    targetMachineId: input.targetMachineId,
    reportPath: input.reportPath,
    reportSha256: input.reportSha256,
    now: input.now,
  });
  assert.equal(arrival.migration.state, "starting");
  return await completeAgentMigrationAutoStart({
    grantKey: input.grantKey,
    agentId: input.agentId,
    targetMachineId: input.targetMachineId,
    now: input.now,
  });
}

async function seedAutoStartFailedMigration(input: {
  now?: Date;
  stage?: "orchestrator" | "start_agent" | "legacy";
  code?: "orchestrator_unavailable" | "start_not_dispatched" | "start_threw" | "legacy_auto_start_failed";
} = {}) {
  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const startedAt = input.now ?? new Date("2026-07-05T14:00:00.000Z");
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: startedAt,
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date(startedAt.getTime() + 60_000),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date(startedAt.getTime() + 120_000));
  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date(startedAt.getTime() + 180_000));
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    grantKey: migration.grantKey,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(startedAt.getTime() + 210_000),
  });
  await markAgentMigrationTargetImportArrived({
    grantKey: migration.grantKey,
    migrationGeneration: archived.migrationGeneration,
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(startedAt.getTime() + 240_000),
  });
  const failed = await recordAgentMigrationAutoStartFailure({
    grantKey: migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    stage: input.stage ?? "start_agent",
    code: input.code ?? "start_not_dispatched",
    now: new Date(startedAt.getTime() + 241_000),
  });
  return { user, server, sourceMachine, targetMachine, agent, migration: failed };
}

test("object-store transfer provisioner mints presigned PUT and GET URLs from storage", async () => {
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
  assert.equal(provision.storageKey, "agent-migrations/session-test/bundle");
  assert.equal(provision.sourceTransferUrl, "https://r2.example.test/agent-migrations/session-test/bundle?put=1");
  assert.equal(provision.targetTransferUrl, "https://r2.example.test/agent-migrations/session-test/bundle?get=1");
  assert.equal(provision.maxBytes, 4096);
  assert.deepEqual(calls, [
    { kind: "put", key: "agent-migrations/session-test/bundle", expiresIn: 120 },
    { kind: "get", key: "agent-migrations/session-test/bundle", expiresIn: 120 },
  ]);
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
    sourceTransferUrl: "https://unused.example.test/source",
    targetTransferUrl: "https://unused.example.test/target",
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
    capability: { required: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES] },
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
  await recordAgentMigrationSourceQuiesced({
    ...sourceActor,
    receipt,
    now: new Date(t0.getTime() + 2_000),
  });
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
  assert.equal((await recordAgentMigrationChunkReceipt(targetChunk0)).outcome, "recorded");
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
  await startAgentMigrationTransfer(provisioned.migration.grantKey, new Date(t0.getTime() + 6_000));
  const arriving = await flipAgentMigrationMachine(
    provisioned.migration.grantKey,
    new Date(t0.getTime() + 7_000),
  );
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    grantKey: provisioned.migration.grantKey,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 7_500),
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    grantKey: provisioned.migration.grantKey,
    migrationGeneration: archived.migrationGeneration,
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 8_000),
  });
  assert.equal(arrival.migration.state, "starting");
  const completed = await completeAgentMigrationAutoStart({
    grantKey: provisioned.migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date(t0.getTime() + 9_000),
  });
  assert.equal(completed.state, "completed");
  const completedReplay = await completeAgentMigrationAutoStart({
    grantKey: provisioned.migration.grantKey,
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

test("auto-start completion requires a durable source workspace archive receipt, including legacy completed rows", async ({ db: database }) => {

  const { user, server, targetMachine, agent, migration } = await seedAutoStartFailedMigration();
  const db = getDb();
  await db.update(agentMigrations)
    .set({ sourceWorkspaceArchivedAt: null })
    .where(eq(agentMigrations.id, migration.id));

  await assert.rejects(
    () => completeAgentMigrationAutoStart({
      grantKey: migration.grantKey,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
    }),
    /MIGRATION_SOURCE_WORKSPACE_ARCHIVE_PENDING/,
  );
  const [pending] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(pending?.state, "starting");
  assert.equal(pending?.completedAt, null);

  assert.ok(pending);
  await recordAgentMigrationSourceWorkspaceArchived({
    grantKey: migration.grantKey,
    migrationGeneration: agentMigrationGeneration(pending),
    serverId: server.id,
    targetMachineId: targetMachine.id,
  });
  await db.update(agentMigrations).set({
    initiatedByUserId: user.id,
    transferSummary: TEST_TRANSFER_SUMMARY,
  }).where(eq(agentMigrations.id, migration.id));
  await completeAgentMigrationAutoStart({
    grantKey: migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
  });
  await db.update(agentMigrations)
    .set({ sourceWorkspaceArchivedAt: null })
    .where(eq(agentMigrations.id, migration.id));
  await assert.rejects(
    () => completeAgentMigrationAutoStart({
      grantKey: migration.grantKey,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
    }),
    /MIGRATION_SOURCE_WORKSPACE_ARCHIVE_PENDING/,
    "historical completed rows must not be silently backfilled as archived",
  );
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
    sourceTransferUrl: "https://r2.example.test/migrations/session-123.bundle?put=1",
    targetTransferUrl: "https://r2.example.test/migrations/session-123.bundle?get=1",
    transportLeaseMs: 30 * 60 * 1000,
    transportMaxBytes: 12_345,
  });

  assert.equal(result.migration.state, "provisioning");
  assert.equal(result.migration.transportProvider, "object_store");
  assert.equal(result.migration.transportSessionId, "session-123");
  assert.equal(result.migration.sourceTransportUrl, "https://r2.example.test/migrations/session-123.bundle?put=1");
  assert.equal(result.migration.targetTransportUrl, "https://r2.example.test/migrations/session-123.bundle?get=1");
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
  assert.equal(result.source.message.url, "https://r2.example.test/migrations/session-123.bundle?put=1");
  assert.equal(result.source.message.expiresAt, "2026-07-05T14:30:00.000Z");
  assert.equal(result.source.message.maxBytes, 12_345);
  assert.equal(result.target.machineId, targetMachine.id);
  assert.equal(result.target.message.role, "target");
  assert.equal(result.target.message.transferKind, "download");
  assert.equal(result.target.message.url, "https://r2.example.test/migrations/session-123.bundle?get=1");
  assert.match(result.source.message.bearerToken, /^slock_migration_/);
  assert.match(result.target.message.bearerToken, /^slock_migration_/);
  assert.notEqual(result.source.message.bearerToken, result.target.message.bearerToken);

  const storedText = JSON.stringify(result.migration);
  assert.doesNotMatch(storedText, new RegExp(result.source.message.bearerToken));
  assert.doesNotMatch(storedText, new RegExp(result.target.message.bearerToken));
});

test("transfer lease ready helper validates object-store role/session/expiry/max-byte contract", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const result = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    transportSessionId: "session-ready",
    sourceTransferUrl: "https://r2.example.test/session-ready?put=1",
    targetTransferUrl: "https://r2.example.test/session-ready?get=1",
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

  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: t0,
  });
  assert.equal(migration.state, "prep");
  assert.equal(migration.sourceMachineId, sourceMachine.id);
  assert.equal(migration.targetMachineId, targetMachine.id);
  assert.equal(await isAgentZenMigrating(agent.id, getDb(), new Date("2026-07-05T14:00:30.000Z")), true);

  let [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, sourceMachine.id, "source machine remains authoritative during prep");

  const ready = await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "MIGRATION-MANIFEST.json",
    manifestSha256: "sha256:manifest",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.readyAt?.toISOString(), "2026-07-05T14:01:00.000Z");

  const inTransit = await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  assert.equal(inTransit.state, "in_transit");

  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:03:00.000Z"));
  assert.equal(arriving.state, "arriving");
  assert.equal(arriving.flippedAt?.toISOString(), "2026-07-05T14:03:00.000Z");

  [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, targetMachine.id, "machineId flips atomically after transfer is ready");
  assert.equal(agentRow.sessionId, "source-native-session", "resume state remains until arrival commits");

  const completed = await completeArrivingMigration({
    grantKey: migration.grantKey,
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
  assert.equal(await isAgentZenMigrating(agent.id), false);
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

  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transportSessionId: "session-finalize",
    sourceTransferUrl: "https://r2.example.test/session-finalize?put=1",
    targetTransferUrl: "https://r2.example.test/session-finalize?get=1",
  });
  const prep = await markAgentMigrationTransportProvisioned({
    migrationId: provisioned.migration.id,
    now: new Date("2026-07-05T14:00:05.000Z"),
  });
  await markAgentMigrationReady({
    grantKey: prep.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(prep.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  await flipAgentMigrationMachine(prep.grantKey, new Date("2026-07-05T14:03:00.000Z"));

  const completed = await completeArrivingMigration({
    grantKey: prep.grantKey,
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

  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: t0,
    transferDeadlineMs: 60 * 60 * 1000,
    arrivalDeadlineMs: 10 * 60 * 1000,
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));

  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:20:00.000Z"));
  assert.equal(arriving.state, "arriving");
  assert.equal(arriving.arrivalDeadlineAt.toISOString(), "2026-07-05T14:30:00.000Z");

  const completed = await completeArrivingMigration({
    grantKey: migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: new Date("2026-07-05T14:25:00.000Z"),
  });
  assert.equal(completed.state, "completed");
});

test("machine flip requires an explicit in-transit transfer state", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();

  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });

  await assert.rejects(
    () => flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:02:00.000Z")),
    /MIGRATION_NOT_FLIPPABLE/,
  );
});

test("zen(migrating) delivery planner queues ordinary traffic and pierces protocol or owner paths until deadline", async () => {
  const migration = {
    state: "prep" as const,
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
    now: new Date("2026-07-05T14:01:00.000Z"),
    migrationProtocol: true,
  }), { action: "deliver", reason: "migration-protocol" });
  assert.deepEqual(planZenMigratingDelivery({
    migration,
    now: new Date("2026-07-05T14:01:00.000Z"),
    ownerPierce: true,
  }), { action: "deliver", reason: "owner-pierce" });
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
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:03:00.000Z"));
  await markAgentMigrationTargetImportArrived({
    grantKey: migration.grantKey,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:04:00.000Z"),
  });
  await recordAgentMigrationAutoStartFailure({
    grantKey: migration.grantKey,
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
  assert.equal(gate.expiredLifecycleEvent, undefined);
  assert.equal(await isAgentZenMigrating(agent.id, getDb(), afterFormerDeadline), false);

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

test("auto-start reconciler skips untyped legacy stuck rows instead of silently sweeping them", async ({ db }) => {

  const { migration } = await seedAutoStartFailedMigration();
  await getDb().update(agentMigrations)
    .set({ autoStartFailureStage: null, autoStartFailureCode: null })
    .where(eq(agentMigrations.id, migration.id));
  const [before] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  const beforeOutbox = await getDb().select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));

  const claim = await claimAgentMigrationAutoStartRemediation({
    executor: "server",
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
  assert.deepEqual(workerResult, { autoStart: false, cancellation: false });
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
  await assert.rejects(
    () => claimAgentMigrationAutoStartRemediation({
      executor: "faulted_agent" as never,
      workerId: "blocked-agent",
      now: new Date("2026-07-05T14:05:00.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_EXECUTOR_INVALID/,
  );

  const first = await claimAgentMigrationAutoStartRemediation({
    executor: "healthy_steward",
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
    grantKey: migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    stage: "start_agent",
    code: "start_threw",
    now: new Date("2026-07-05T14:05:10.000Z"),
  });
  const contended = await claimAgentMigrationAutoStartRemediation({
    executor: "server",
    workerId: "server-b",
    now: new Date("2026-07-05T14:05:20.000Z"),
  });
  assert.equal(contended, null);

  for (let attempt = 2; attempt <= AGENT_MIGRATION_AUTO_START_MAX_RETRY_ATTEMPTS; attempt += 1) {
    const retryAt = new Date(Date.parse("2026-07-05T14:05:00.000Z") + attempt * 31_000);
    const claim = await claimAgentMigrationAutoStartRemediation({
      executor: "server",
      workerId: `server-${attempt}`,
      now: retryAt,
      leaseMs: 30_000,
    });
    assert.ok(claim);
    assert.equal(claim.action, "dispatch");
    assert.equal(claim.candidateVariant, "typed_failed");
    assert.equal(claim.migration.autoStartRetryAttempts, attempt);
    await recordAgentMigrationAutoStartFailure({
      grantKey: migration.grantKey,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      stage: "start_agent",
      code: "start_threw",
      now: new Date(retryAt.getTime() + 1_000),
    });
  }

  const terminal = await claimAgentMigrationAutoStartRemediation({
    executor: "server",
    workerId: "server-terminal",
    now: new Date("2026-07-05T14:08:00.000Z"),
  });
  assert.ok(terminal);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.candidateVariant, "typed_failed");
  assert.equal(terminal.migration.state, "failed");
  assert.equal(terminal.migration.failureReason, "auto_start_failed");
  assert.equal(terminal.migration.transportTeardownAt?.toISOString(), "2026-07-05T14:08:00.000Z");
  assert.equal(await isAgentZenMigrating(agent.id, getDb(), new Date("2026-07-05T14:08:01.000Z")), false);

  const outbox = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.migrationId, migration.id));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.receiptKind, "failed");

  const successor = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: sourceMachine.id,
    now: new Date("2026-07-05T14:09:00.000Z"),
  });
  assert.equal(successor.state, "prep");
});

test("orphaned exhausted auto-start dispatch terminalizes on successor worker tick", async ({ db }) => {

  const { targetMachine, agent, migration } = await seedAutoStartFailedMigration();

  const first = await claimAgentMigrationAutoStartRemediation({
    executor: "server",
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

  assert.deepEqual(result, { autoStart: true, cancellation: false });
  assert.equal(startCalls, 0);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.failureReason, "auto_start_failed");
  assert.equal(persisted.autoStartFailureStage, "start_agent");
  assert.equal(persisted.autoStartFailureCode, "start_not_dispatched");
  assert.equal(persisted.autoStartRemediationLeaseId, null);
  assert.equal(persisted.autoStartRemediationLeaseExpiresAt, null);
  assert.equal(await isAgentZenMigrating(agent.id, getDb(), new Date("2026-07-05T14:05:32.000Z")), false);

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
      grantKey: migration.grantKey,
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

  assert.deepEqual(result, { autoStart: true, cancellation: false });
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
    executor: "server",
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
      grantKey: migration.grantKey,
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
      grantKey: migration.grantKey,
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
    executor: "server",
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
      grantKey: migration.grantKey,
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
      grantKey: migration.grantKey,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      remediationLeaseId: first.leaseId,
      now: new Date("2026-07-05T14:05:33.000Z"),
    }),
    /MIGRATION_AUTO_START_REMEDIATION_LEASE_STALE/,
  );

  const completed = await completeAgentMigrationAutoStart({
    grantKey: migration.grantKey,
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
    executor: "server",
    workerId: "server-a",
    now: new Date("2026-07-05T14:05:00.000Z"),
  });
  assert.ok(first);
  assert.equal(first.action, "dispatch");

  await getDb().update(agentMigrations)
    .set({ failureReason: "auto_start_failed" })
    .where(eq(agentMigrations.id, migration.id));

  const terminal = await claimAgentMigrationAutoStartRemediation({
    executor: "server",
    workerId: "server-deadline",
    now: new Date(Date.parse("2026-07-05T14:05:00.000Z") + AGENT_MIGRATION_AUTO_START_REMEDIATION_WINDOW_MS),
  });
  assert.ok(terminal);
  assert.equal(terminal.action, "terminal");
  assert.equal(terminal.migration.state, "failed");
});

test("stale post-arrival auto-start dispatch is reclaimable exactly once", async ({ db }) => {

  const { server, targetMachine, agent } = await seedMigrationFixture();
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:03:00.000Z"));
  const arrivalInput = {
    grantKey: migration.grantKey,
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

test("arriving migration abort can roll back machineId to the source machine", async ({ db }) => {

  const { targetMachine, sourceMachine, agent } = await seedMigrationFixture();
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:03:00.000Z"));

  const aborted = await abortAgentMigration({
    grantKey: migration.grantKey,
    reason: "adopt_failed",
    rollbackArrivingMachine: true,
    now: new Date("2026-07-05T14:05:00.000Z"),
  });
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.abortReason, "adopt_failed");

  const [agentRow] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(agentRow.machineId, sourceMachine.id);
});

test("active migration unique index prevents split-brain migration grants for one agent", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();

  await beginAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
  await assert.rejects(async () => {
    try {
      await beginAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
    } catch (err) {
      const message = `${err instanceof Error ? err.message : String(err)} ${(err as { cause?: unknown })?.cause ?? ""}`;
      assert.match(message, /idx_agent_migrations_active_agent|duplicate key|constraint/i);
      throw err;
    }
  });

  const rows = await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
  assert.equal(rows.length, 1);
});

test("migration history is newest-first and enforces its requested bound", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();
  const migrationIds: string[] = [];

  for (let index = 0; index < 4; index += 1) {
    const startedAt = new Date(`2026-07-05T14:0${index}:00.000Z`);
    const migration = await beginAgentMigration({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      now: startedAt,
    });
    migrationIds.push(migration.id);
    await abortAgentMigration({
      grantKey: migration.grantKey,
      reason: `history-${index}`,
      now: new Date(startedAt.getTime() + 1_000),
    });
  }

  const latestTwo = await getAgentMigrationHistory(
    agent.id,
    2,
    getDb(),
    new Date("2026-07-05T15:00:00.000Z"),
  );
  assert.deepEqual(latestTwo.map((migration) => migration.id), [migrationIds[3], migrationIds[2]]);

  const minimumBound = await getAgentMigrationHistory(
    agent.id,
    0,
    getDb(),
    new Date("2026-07-05T15:00:00.000Z"),
  );
  assert.equal(minimumBound.length, 1);
  assert.equal(minimumBound[0]?.id, migrationIds[3]);
});

test("elapsed deadlines auto-exit zen migrating gate and free the active grant", async ({ db }) => {

  const { targetMachine, agent } = await seedMigrationFixture();

  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
    prepDeadlineMs: 1000,
  });

  assert.equal(await isAgentZenMigrating(agent.id, getDb(), new Date("2026-07-05T14:00:00.500Z")), true);
  const expired = await getAgentMigrationGateStatus(agent.id, getDb(), new Date("2026-07-05T14:00:02.000Z"));
  assert.equal(expired.migration, null);
  assert.equal(expired.expiredLifecycleEvent?.eventType, "migration_aborted");
  assert.equal(expired.expiredLifecycleEvent?.reason, "migration_abort");
  assert.equal(await isAgentZenMigrating(agent.id, getDb(), new Date("2026-07-05T14:00:02.000Z")), false);

  const [aborted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.abortReason, "prep-deadline");

  const retry = await beginAgentMigration({ agentId: agent.id, targetMachineId: targetMachine.id });
  assert.equal(retry.state, "prep");
});

test("migration lifecycle events use control-class event names without leaking grant keys", async ({ db }) => {

  const { user, targetMachine, sourceMachine, agent } = await seedMigrationFixture();

  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-07-05T14:00:00.000Z"),
  });
  const started = createAgentMigrationLifecycleEvent({
    migration,
    eventType: "migration_started",
    occurredAt: "2026-07-05T14:00:00.000Z",
  });
  assert.equal(started.eventType, "migration_started");
  assert.equal(started.reason, "migration_prepare");
  assert.equal(started.machineId, sourceMachine.id);
  assert.equal(started.correlationId, `agent_migration:${migration.supportRef}`);
  assert.equal(started.idempotencyKey, `agent_migration:${migration.supportRef}:migration_started:${migration.revision}`);
  assert.doesNotMatch(JSON.stringify(started), new RegExp(migration.grantKey));

  await markAgentMigrationReady({
    grantKey: migration.grantKey,
    manifestPath: "manifest.json",
    now: new Date("2026-07-05T14:01:00.000Z"),
  });
  await startAgentMigrationTransfer(migration.grantKey, new Date("2026-07-05T14:02:00.000Z"));
  const arriving = await flipAgentMigrationMachine(migration.grantKey, new Date("2026-07-05T14:03:00.000Z"));
  const completed = await completeArrivingMigration({
    grantKey: migration.grantKey,
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    now: new Date("2026-07-05T14:04:00.000Z"),
  });

  const arrivingAbortEvent = createAgentMigrationLifecycleEvent({
    migration: arriving,
    eventType: "migration_aborted",
  });
  assert.equal(arrivingAbortEvent.reason, "migration_abort");
  assert.equal(arrivingAbortEvent.machineId, targetMachine.id);

  const completedEvent = createAgentMigrationLifecycleEvent({
    migration: completed,
    eventType: "migration_completed",
  });
  assert.equal(completedEvent.reason, "migration_arrived");
  assert.equal(completedEvent.machineId, targetMachine.id);
});

test("safe cancel terminalizes, keeps cleanup fenced, and lets server/steward retry independently", async ({ db }) => {

  const { user, server, sourceMachine, targetMachine, agent } = await seedMigrationFixture();
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: user.id,
    transportSessionId: "cancel-session",
    sourceTransferUrl: "https://r2.example.test/source",
    targetTransferUrl: "https://r2.example.test/target",
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
  assert.equal(gateDuringCancellation.expiredLifecycleEvent, undefined);
  assert.equal(
    await markAgentMigrationTransportLost({ migrationId: requested.migration.id, now: afterLegacyDeadlines }),
    null,
  );
  await assert.rejects(
    () => abortAgentMigration({
      grantKey: requested.migration.grantKey,
      reason: "stale_abort_racing_cancel",
      now: afterLegacyDeadlines,
    }),
    /MIGRATION_NOT_ACTIVE/,
  );

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
    executor: "server",
    workerId: "cancel-cleanup-worker-a",
    now: new Date("2026-08-03T08:00:02.000Z"),
  });
  assert.equal(retried?.dispatch, "required");
  assert.equal(retried?.migration.cancelGeneration, generation);
  assert.equal(retried?.migration.cancelDispatchAttempts, 2);
  assert.ok(retried?.leaseId);
  const contended = await claimAgentMigrationCancellationCleanup({
    executor: "healthy_steward",
    workerId: "cancel-cleanup-worker-b",
    now: new Date("2026-08-03T08:00:02.100Z"),
  });
  assert.equal(contended, null);
  const lastDispatch = await claimAgentMigrationCancellationCleanup({
    executor: "healthy_steward",
    workerId: "cancel-cleanup-worker-b",
    now: new Date("2026-08-03T08:00:40.000Z"),
  });
  assert.equal(lastDispatch?.dispatch, "required");
  assert.equal(lastDispatch?.migration.cancelDispatchAttempts, 3);
  const exhausted = await claimAgentMigrationCancellationCleanup({
    executor: "server",
    workerId: "cancel-cleanup-worker-a",
    now: new Date("2026-08-03T08:01:11.000Z"),
  });
  assert.ok(exhausted);
  assert.equal(exhausted.dispatch, "none");
  assert.equal(exhausted.migration.cancelErrorCode, "cancel_dispatch_retry_exhausted");
  assert.ok(exhausted.migration.cancelNeedsAttentionAt);
  await assert.rejects(
    () => claimAgentMigrationCancellationCleanup({
      executor: "faulted_agent" as never,
      workerId: "blocked-agent",
      now: new Date("2026-08-03T08:00:41.500Z"),
    }),
    /MIGRATION_CANCEL_CLEANUP_EXECUTOR_INVALID/,
  );

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
    sourceTransferUrl: "https://r2.example.test/source",
    targetTransferUrl: "https://r2.example.test/target",
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

  assert.deepEqual(result, { autoStart: false, cancellation: true });
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
    sourceTransferUrl: "https://r2.example.test/source",
    targetTransferUrl: "https://r2.example.test/target",
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
    executor: "server",
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
    executor: "server",
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
    sourceTransferUrl: "https://r2.example.test/source",
    targetTransferUrl: "https://r2.example.test/target",
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
    assert.equal(await isAgentZenMigrating(agent.id, undefined, postTerminalNow), false);
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
    sourceTransferUrl: "https://r2.example.test/successor-source",
    targetTransferUrl: "https://r2.example.test/successor-target",
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
    sourceTransferUrl: "https://r2.example.test/source",
    targetTransferUrl: "https://r2.example.test/target",
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
