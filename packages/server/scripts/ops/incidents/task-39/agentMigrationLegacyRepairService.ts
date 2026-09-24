import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../../../src/db/index.js";
import {
  agentMigrationReceiptChannels,
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  messages,
} from "../../../../src/db/schema.js";
import {
  enqueueAgentMigrationCompletedReceipt,
  type AgentMigrationReceiptEnqueueHooks,
} from "../../../../src/services/agentMigrationReceiptService.js";

const LEGACY_FAILURE_STAGE = "legacy" as const;
const LEGACY_FAILURE_CODE = "legacy_auto_start_failed" as const;
const ACTIVE_STATES = ["provisioning", "prep", "ready", "in_transit", "arriving", "starting"] as const;

export type LegacyAgentMigrationRepairTarget = {
  migrationId: string;
  serverId: string;
  agentId: string;
  targetMachineId: string;
  expectedRevision: number;
};

export type LegacyAgentMigrationRepairPreview = {
  status: "ready" | "already_repaired";
  prestateSha256: string | null;
  expectedRevision: number;
};

export type LegacyAgentMigrationRepairResult = {
  status: "applied" | "already_repaired";
  revision: number;
};

export interface LegacyAgentMigrationRepairHooks {
  beforeUpdate?: () => void | Promise<void>;
  receipt?: AgentMigrationReceiptEnqueueHooks;
}

function normalizeForDigest(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalizeForDigest(entry)]),
    );
  }
  return value;
}

export function legacyAgentMigrationPrestateSha256(
  row: typeof agentMigrations.$inferSelect,
): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeForDigest(row)))
    .digest("hex");
}

async function assertSchemaReady(executor: DatabaseExecutor): Promise<void> {
  const result = await executor.execute(sql`
    SELECT
      (
        SELECT count(*)::int
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agent_migrations'
          AND column_name IN (
            'auto_start_failure_stage',
            'auto_start_failure_code',
            'auto_start_retry_attempts',
            'auto_start_retry_deadline_at',
            'auto_start_last_retry_at',
            'auto_start_remediation_lease_id',
            'auto_start_remediation_lease_expires_at'
          )
      ) AS "typedColumnCount",
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = to_regclass('public.agent_migrations')
          AND tgname = 'agent_migration_completed_receipt_required'
          AND tgdeferrable
          AND tginitdeferred
          AND NOT tgisinternal
      ) AS "hasDeferredReceiptTrigger",
      EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = to_regclass('public.agent_migration_receipt_outbox')
          AND tgname = 'agent_migration_receipt_outbox_validate'
          AND NOT tgisinternal
      ) AS "hasOutboxValidationTrigger",
      EXISTS (
        SELECT 1
        FROM pg_proc p
        INNER JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'require_agent_migration_completed_receipt'
      ) AS "hasReceiptRequirementFunction",
      EXISTS (
        SELECT 1
        FROM pg_proc p
        INNER JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'validate_agent_migration_receipt_outbox'
      ) AS "hasOutboxValidationFunction"
  `);
  const [row] = result.rows as Array<{
    typedColumnCount: number;
    hasDeferredReceiptTrigger: boolean;
    hasOutboxValidationTrigger: boolean;
    hasReceiptRequirementFunction: boolean;
    hasOutboxValidationFunction: boolean;
  }>;
  if (
    Number(row?.typedColumnCount) !== 7
    || row?.hasDeferredReceiptTrigger !== true
    || row?.hasOutboxValidationTrigger !== true
    || row?.hasReceiptRequirementFunction !== true
    || row?.hasOutboxValidationFunction !== true
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_SCHEMA_NOT_READY");
  }
}

async function loadMigration(
  executor: DatabaseExecutor,
  target: LegacyAgentMigrationRepairTarget,
  lock: boolean,
): Promise<typeof agentMigrations.$inferSelect> {
  const query = executor.select()
    .from(agentMigrations)
    .where(eq(agentMigrations.id, target.migrationId))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const [row] = rows;
  if (
    !row
    || row.serverId !== target.serverId
    || row.agentId !== target.agentId
    || row.targetMachineId !== target.targetMachineId
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_NOT_FOUND");
  }
  return row;
}

async function assertHolderReady(
  executor: DatabaseExecutor,
  target: LegacyAgentMigrationRepairTarget,
  lock: boolean,
): Promise<void> {
  const query = executor.select({
    id: agents.id,
    serverId: agents.serverId,
    machineId: agents.machineId,
    status: agents.status,
    deletedAt: agents.deletedAt,
  })
    .from(agents)
    .where(eq(agents.id, target.agentId))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const [holder] = rows;
  if (
    !holder
    || holder.serverId !== target.serverId
    || holder.machineId !== target.targetMachineId
    || holder.status !== "active"
    || holder.deletedAt !== null
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_HOLDER_DRIFT");
  }
}

async function assertSingleActiveMigration(
  executor: DatabaseExecutor,
  target: LegacyAgentMigrationRepairTarget,
  expectedActive: boolean,
): Promise<void> {
  const activeRows = await executor.select({ id: agentMigrations.id })
    .from(agentMigrations)
    .where(and(
      eq(agentMigrations.agentId, target.agentId),
      inArray(agentMigrations.state, [...ACTIVE_STATES]),
    ));
  if (expectedActive) {
    if (activeRows.length !== 1 || activeRows[0]?.id !== target.migrationId) {
      throw new Error("MIGRATION_LEGACY_REPAIR_ACTIVE_SET_DRIFT");
    }
    return;
  }
  if (activeRows.length !== 0) {
    throw new Error("MIGRATION_LEGACY_REPAIR_ACTIVE_SET_DRIFT");
  }
}

async function assertReceiptSurfaceReady(
  executor: DatabaseExecutor,
  row: typeof agentMigrations.$inferSelect,
): Promise<void> {
  if (
    !row.receiptChannelId
    || !row.sourceMachineNameSnapshot
    || !row.targetMachineNameSnapshot
    || !row.transferSummary
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_RECEIPT_CONTEXT_MISSING");
  }
  const [surface] = await executor.select({
    channelId: agentMigrationReceiptChannels.channelId,
    serverId: agentMigrationReceiptChannels.serverId,
    agentId: agentMigrationReceiptChannels.agentId,
    channelType: channels.type,
    channelDeletedAt: channels.deletedAt,
  })
    .from(agentMigrationReceiptChannels)
    .innerJoin(channels, eq(channels.id, agentMigrationReceiptChannels.channelId))
    .where(eq(agentMigrationReceiptChannels.migrationId, row.id))
    .limit(1);
  if (
    !surface
    || surface.channelId !== row.receiptChannelId
    || surface.serverId !== row.serverId
    || surface.agentId !== row.agentId
    || surface.channelType !== "dm"
    || surface.channelDeletedAt !== null
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_RECEIPT_SURFACE_DRIFT");
  }
  const [agentMembers, humanMembers] = await Promise.all([
    executor.select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, surface.channelId)),
    executor.select({ userId: channelHumans.userId })
      .from(channelHumans)
      .where(eq(channelHumans.channelId, surface.channelId)),
  ]);
  if (
    agentMembers.length !== 1
    || agentMembers[0]?.agentId !== row.agentId
    || humanMembers.length !== 0
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_RECEIPT_AUDIENCE_DRIFT");
  }
}

function assertLegacyStartingPrestate(
  row: typeof agentMigrations.$inferSelect,
  target: LegacyAgentMigrationRepairTarget,
): void {
  if (
    row.state !== "starting"
    || row.revision !== target.expectedRevision
    || row.failureReason !== "auto_start_failed"
    || row.autoStartFailureStage !== null
    || row.autoStartFailureCode !== null
    || row.autoStartRetryAttempts !== 0
    || row.autoStartRetryDeadlineAt !== null
    || row.autoStartLastRetryAt !== null
    || row.autoStartRemediationLeaseId !== null
    || row.autoStartRemediationLeaseExpiresAt !== null
    || row.completedAt !== null
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_PRESTATE_NOT_ELIGIBLE");
  }
}

async function readReceiptEvidence(
  executor: DatabaseExecutor,
  row: typeof agentMigrations.$inferSelect,
): Promise<{ outboxCount: number; messageCount: number; inboxFactCount: number }> {
  const outboxes = await executor.select()
    .from(agentMigrationReceiptOutbox)
    .where(and(
      eq(agentMigrationReceiptOutbox.migrationId, row.id),
      eq(agentMigrationReceiptOutbox.receiptKind, "completed"),
    ));
  if (outboxes.length !== 1) {
    return { outboxCount: outboxes.length, messageCount: 0, inboxFactCount: 0 };
  }
  const outbox = outboxes[0]!;
  if (
    outbox.serverId !== row.serverId
    || outbox.agentId !== row.agentId
    || outbox.channelId !== row.receiptChannelId
    || !["pending", "processing", "sent"].includes(outbox.status)
  ) {
    throw new Error("MIGRATION_LEGACY_REPAIR_TERMINAL_EVIDENCE_DRIFT");
  }
  const [receiptMessages, facts] = await Promise.all([
    executor.select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.id, outbox.messageId),
        eq(messages.channelId, outbox.channelId),
        eq(messages.senderType, "user"),
        eq(messages.senderId, "system"),
        eq(messages.messageType, "system"),
      )),
    executor.select({ id: inboxNotificationFacts.id })
      .from(inboxNotificationFacts)
      .where(and(
        eq(inboxNotificationFacts.receiverType, "agent"),
        eq(inboxNotificationFacts.receiverId, row.agentId),
        eq(inboxNotificationFacts.serverId, row.serverId),
        eq(inboxNotificationFacts.sourceChannelId, outbox.channelId),
        eq(inboxNotificationFacts.messageId, outbox.messageId),
      )),
  ]);
  return {
    outboxCount: outboxes.length,
    messageCount: receiptMessages.length,
    inboxFactCount: facts.length,
  };
}

async function isAlreadyRepaired(
  executor: DatabaseExecutor,
  row: typeof agentMigrations.$inferSelect,
  target: LegacyAgentMigrationRepairTarget,
): Promise<boolean> {
  if (
    row.state !== "completed"
    || row.revision !== target.expectedRevision + 1
    || row.failureReason !== null
    || row.autoStartFailureStage !== LEGACY_FAILURE_STAGE
    || row.autoStartFailureCode !== LEGACY_FAILURE_CODE
    || row.autoStartRetryAttempts !== 0
    || row.autoStartRetryDeadlineAt !== null
    || row.autoStartLastRetryAt !== null
    || row.autoStartRemediationLeaseId !== null
    || row.autoStartRemediationLeaseExpiresAt !== null
    || !row.completedAt
    || !row.transportTeardownAt
    || row.completedAt.getTime() !== row.transportTeardownAt.getTime()
  ) {
    return false;
  }
  await assertSingleActiveMigration(executor, target, false);
  const evidence = await readReceiptEvidence(executor, row);
  if (evidence.outboxCount !== 1 || evidence.messageCount !== 1 || evidence.inboxFactCount !== 1) {
    throw new Error("MIGRATION_LEGACY_REPAIR_TERMINAL_EVIDENCE_DRIFT");
  }
  return true;
}

async function assertNoPriorReceipt(
  executor: DatabaseExecutor,
  migrationId: string,
): Promise<void> {
  const outboxes = await executor.select({ id: agentMigrationReceiptOutbox.id })
    .from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migrationId));
  if (outboxes.length !== 0) {
    throw new Error("MIGRATION_LEGACY_REPAIR_RECEIPT_ALREADY_EXISTS");
  }
}

export async function previewLegacyAgentMigrationCompletion(
  target: LegacyAgentMigrationRepairTarget,
): Promise<LegacyAgentMigrationRepairPreview> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await assertSchemaReady(tx);
    const row = await loadMigration(tx, target, false);
    await assertHolderReady(tx, target, false);
    if (await isAlreadyRepaired(tx, row, target)) {
      return {
        status: "already_repaired",
        prestateSha256: null,
        expectedRevision: target.expectedRevision,
      };
    }
    assertLegacyStartingPrestate(row, target);
    await assertSingleActiveMigration(tx, target, true);
    await assertReceiptSurfaceReady(tx, row);
    await assertNoPriorReceipt(tx, row.id);
    return {
      status: "ready",
      prestateSha256: legacyAgentMigrationPrestateSha256(row),
      expectedRevision: target.expectedRevision,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function applyLegacyAgentMigrationCompletion(
  target: LegacyAgentMigrationRepairTarget & { expectedPrestateSha256: string; now?: Date },
  hooks: LegacyAgentMigrationRepairHooks = {},
): Promise<LegacyAgentMigrationRepairResult> {
  const db = getDb();
  const now = target.now ?? currentDate();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await assertSchemaReady(tx);
    const row = await loadMigration(tx, target, true);
    await assertHolderReady(tx, target, true);
    if (await isAlreadyRepaired(tx, row, target)) {
      return { status: "already_repaired", revision: row.revision };
    }
    assertLegacyStartingPrestate(row, target);
    await assertSingleActiveMigration(tx, target, true);
    await assertReceiptSurfaceReady(tx, row);
    await assertNoPriorReceipt(tx, row.id);
    if (legacyAgentMigrationPrestateSha256(row) !== target.expectedPrestateSha256) {
      throw new Error("MIGRATION_LEGACY_REPAIR_PRESTATE_DRIFT");
    }
    await hooks.beforeUpdate?.();
    const [updated] = await tx.update(agentMigrations)
      .set({
        state: "completed",
        failureReason: null,
        autoStartFailureStage: LEGACY_FAILURE_STAGE,
        autoStartFailureCode: LEGACY_FAILURE_CODE,
        autoStartRemediationLeaseId: null,
        autoStartRemediationLeaseExpiresAt: null,
        completedAt: now,
        transportTeardownAt: now,
        revision: target.expectedRevision + 1,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrations.id, target.migrationId),
        eq(agentMigrations.serverId, target.serverId),
        eq(agentMigrations.agentId, target.agentId),
        eq(agentMigrations.targetMachineId, target.targetMachineId),
        eq(agentMigrations.revision, target.expectedRevision),
        eq(agentMigrations.state, "starting"),
        eq(agentMigrations.failureReason, "auto_start_failed"),
        isNull(agentMigrations.autoStartFailureStage),
        isNull(agentMigrations.autoStartFailureCode),
        eq(agentMigrations.autoStartRetryAttempts, 0),
        isNull(agentMigrations.autoStartRetryDeadlineAt),
        isNull(agentMigrations.autoStartLastRetryAt),
        isNull(agentMigrations.autoStartRemediationLeaseId),
        isNull(agentMigrations.autoStartRemediationLeaseExpiresAt),
        isNull(agentMigrations.completedAt),
      ))
      .returning();
    if (!updated) throw new Error("MIGRATION_LEGACY_REPAIR_CONCURRENT_UPDATE");
    await enqueueAgentMigrationCompletedReceipt(tx, updated, now, hooks.receipt);
    const evidence = await readReceiptEvidence(tx, updated);
    if (evidence.outboxCount !== 1 || evidence.messageCount !== 1 || evidence.inboxFactCount !== 1) {
      throw new Error("MIGRATION_LEGACY_REPAIR_TERMINAL_EVIDENCE_DRIFT");
    }
    await assertSingleActiveMigration(tx, target, false);
    return { status: "applied", revision: updated.revision };
  }, { isolationLevel: "serializable", accessMode: "read write" });
}
