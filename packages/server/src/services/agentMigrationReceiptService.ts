import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  currentDate,
  setClockInterval,
  type AgentMigrationTransferSummary,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agentMigrationReceiptChannels,
  agentMigrationReceiptOutbox,
  agentMigrations,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
} from "../db/schema.js";
import type { AgentOrchestrator } from "./agentOrchestrator.js";
import {
  broadcastSystemMessage,
  recordInboxFactsForPersistedMessages,
} from "./messageService.js";
import {
  classifyAgentMigrationReceiptDrain,
  createAgentMigrationWorkerObservability,
  type AgentMigrationWorkerObservability,
} from "./agentMigrationWorkerObservability.js";

type AgentMigrationReceiptKind = (typeof agentMigrationReceiptOutbox.$inferSelect)["receiptKind"];
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface AgentMigrationReceiptEnqueueHooks {
  beforeOutboxInsert?: () => void | Promise<void>;
}

type ReceiptSurfaceResolution = {
  channel: typeof channels.$inferSelect;
};

async function hasActiveJointProjectionForReceiptServer(
  executor: DatabaseExecutor,
  channelId: string,
  serverId: string,
): Promise<boolean> {
  const [projection] = await executor.select({ channelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannelServers.localChannelId, channelId),
      eq(jointChannelServers.serverId, serverId),
      eq(jointChannelServers.status, "active"),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);
  return Boolean(projection);
}

async function resolveAgentMigrationReceiptSurface(
  executor: DatabaseExecutor,
  migration: typeof agentMigrations.$inferSelect,
): Promise<ReceiptSurfaceResolution | null> {
  if (!migration.receiptChannelId) return null;
  const receiptChannelId = migration.receiptChannelId;
  const [surface] = await executor.select({ receiptChannel: agentMigrationReceiptChannels, channel: channels })
    .from(agentMigrationReceiptChannels)
    .innerJoin(channels, eq(channels.id, agentMigrationReceiptChannels.channelId))
    .where(and(
      eq(agentMigrationReceiptChannels.channelId, receiptChannelId),
      eq(agentMigrationReceiptChannels.migrationId, migration.id),
      eq(agentMigrationReceiptChannels.serverId, migration.serverId),
      eq(agentMigrationReceiptChannels.agentId, migration.agentId),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!surface) return null;

  const channelInReceiptServer = surface.channel.serverId === surface.receiptChannel.serverId
    || await hasActiveJointProjectionForReceiptServer(
      executor,
      surface.channel.id,
      surface.receiptChannel.serverId,
    );
  if (!channelInReceiptServer) return null;
  return { channel: surface.channel };
}

export function formatAgentMigrationCompletedReceipt(input: {
  sourceMachineName: string;
  targetMachineName: string;
  supportRef: string;
  summary: AgentMigrationTransferSummary;
}): string {
  const { summary } = input;
  const excluded = summary.excludedRegenerableByCategory;
  const keyEntries = [
    summary.keyWorkspaceEntries.memoryMdPresent ? "MEMORY.md" : null,
    summary.keyWorkspaceEntries.notesPresent ? "notes" : null,
  ].filter((entry): entry is string => entry !== null);
  const keyEntrySentence = keyEntries.length > 0
    ? ` ${keyEntries.join(" and ")} existed in the workspace and moved with it.`
    : "";
  const chineseKeyEntrySentence = keyEntries.length > 0
    ? `；其中原本存在的 ${keyEntries.join(" 和 ")} 已随工作区迁移。`
    : "。";

  return [
    `Migration completed. Moved from ${input.sourceMachineName} to ${input.targetMachineName}.`,
    `Migration support ref: ${input.supportRef}.`,
    `Moved ${summary.includedFileCount} files (${summary.includedBytes} bytes). Filtered ${summary.excludedRegenerableCount} regenerable entries: third-party dependencies ${excluded.thirdPartyDependencies}, caches ${excluded.caches}, build outputs ${excluded.buildArtifacts}, other regenerable files ${excluded.otherRegenerable}.`,
    `The workspace moved successfully.${keyEntrySentence}`,
    `迁移过程中会过滤部分第三方依赖、缓存、构建产物等可重新生成的非关键文件；工作区已迁移${chineseKeyEntrySentence}`,
  ].join("\n");
}

export function formatAgentMigrationTerminalReceipt(input: {
  kind: Exclude<AgentMigrationReceiptKind, "completed">;
  sourceMachineName: string;
  targetMachineName: string;
  supportRef: string;
  reason?: string | null;
  needsAttention?: boolean;
}): string {
  const direction = `from ${input.sourceMachineName} to ${input.targetMachineName}`;
  const reason = input.reason ? ` Reason: ${input.reason}.` : "";
  if (input.kind === "canceled") {
    const cleanup = input.needsAttention
      ? " Background cleanup still needs attention, but this canceled migration no longer blocks new work."
      : " Background cleanup will continue independently if any cleanup acknowledgement is still missing.";
    return [
      `Migration canceled. The migration ${direction} has been stopped.`,
      `Migration support ref: ${input.supportRef}.${reason}${cleanup}`,
      "You can continue once the next task reaches this agent; this canceled migration is no longer the active gate.",
    ].join("\n");
  }
  return [
    `Migration failed. The migration ${direction} did not complete.`,
    `Migration support ref: ${input.supportRef}.${reason}`,
    "This migration is terminal and is no longer the active gate; a new migration or repair can be started separately.",
  ].join("\n");
}

async function enqueueAgentMigrationReceipt(
  executor: DatabaseExecutor,
  migration: typeof agentMigrations.$inferSelect,
  receiptKind: AgentMigrationReceiptKind,
  content: string,
  now: Date,
  hooks: AgentMigrationReceiptEnqueueHooks = {},
): Promise<typeof messages.$inferSelect> {
  if (
    !migration.receiptChannelId
    || !migration.sourceMachineNameSnapshot
    || !migration.targetMachineNameSnapshot
  ) {
    throw new Error("MIGRATION_RECEIPT_CONTEXT_MISSING");
  }

  const surface = await resolveAgentMigrationReceiptSurface(executor, migration);
  const channel = surface?.channel;
  if (!channel || channel.type !== "dm") {
    throw new Error("MIGRATION_RECEIPT_SURFACE_INVALID");
  }

  const [surfaceShape] = await executor.select({
    agentCount: sql<number>`(SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channel.id})`,
    exactAgentCount: sql<number>`(SELECT count(*)::int FROM channel_agents WHERE channel_id = ${channel.id} AND agent_id = ${migration.agentId})`,
    humanCount: sql<number>`(SELECT count(*)::int FROM channel_humans WHERE channel_id = ${channel.id})`,
  })
    .from(channels)
    .where(eq(channels.id, channel.id))
    .limit(1);
  if (
    !surfaceShape
    || surfaceShape.agentCount !== 1
    || surfaceShape.exactAgentCount !== 1
    || surfaceShape.humanCount !== 0
  ) {
    throw new Error("MIGRATION_RECEIPT_SURFACE_AUDIENCE_INVALID");
  }

  const [existing] = await executor.select()
    .from(agentMigrationReceiptOutbox)
    .where(and(
      eq(agentMigrationReceiptOutbox.migrationId, migration.id),
      eq(agentMigrationReceiptOutbox.receiptKind, receiptKind),
    ))
    .limit(1);
  if (existing) {
    const [existingMessage] = await executor.select().from(messages).where(eq(messages.id, existing.messageId)).limit(1);
    if (!existingMessage) throw new Error("MIGRATION_RECEIPT_MESSAGE_MISSING");
    return existingMessage;
  }

  const [message] = await executor.insert(messages).values({
    id: randomUUID(),
    channelId: channel.id,
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content,
    searchText: content,
    createdAt: now,
    updatedAt: now,
  }).returning();

  await recordInboxFactsForPersistedMessages([message], {
    inboxFactPolicy: {
      mode: "record",
      producer: `agent.migration_${receiptKind}_receipt`,
      reason: `Authoritative migration ${receiptKind} state is durable agent-visible activity`,
    },
    executor,
    channel,
  });
  await hooks.beforeOutboxInsert?.();
  await executor.insert(agentMigrationReceiptOutbox).values({
    migrationId: migration.id,
    receiptKind,
    serverId: migration.serverId,
    agentId: migration.agentId,
    channelId: channel.id,
    messageId: message.id,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return message;
}

export async function enqueueAgentMigrationCompletedReceipt(
  executor: DatabaseExecutor,
  migration: typeof agentMigrations.$inferSelect,
  now: Date,
  hooks: AgentMigrationReceiptEnqueueHooks = {},
): Promise<typeof messages.$inferSelect> {
  if (migration.state !== "completed") throw new Error("MIGRATION_RECEIPT_NOT_COMPLETED");
  if (!migration.transferSummary) throw new Error("MIGRATION_RECEIPT_CONTEXT_MISSING");
  return enqueueAgentMigrationReceipt(
    executor,
    migration,
    "completed",
    formatAgentMigrationCompletedReceipt({
      sourceMachineName: migration.sourceMachineNameSnapshot,
      targetMachineName: migration.targetMachineNameSnapshot,
      supportRef: migration.supportRef,
      summary: migration.transferSummary,
    }),
    now,
    hooks,
  );
}

export async function enqueueAgentMigrationCanceledReceipt(
  executor: DatabaseExecutor,
  migration: typeof agentMigrations.$inferSelect,
  now: Date,
  hooks: AgentMigrationReceiptEnqueueHooks = {},
): Promise<typeof messages.$inferSelect> {
  if (migration.state !== "canceled_pre_flip" && migration.state !== "canceled_post_flip") {
    throw new Error("MIGRATION_RECEIPT_NOT_CANCELED");
  }
  return enqueueAgentMigrationReceipt(
    executor,
    migration,
    "canceled",
    formatAgentMigrationTerminalReceipt({
      kind: "canceled",
      sourceMachineName: migration.sourceMachineNameSnapshot,
      targetMachineName: migration.targetMachineNameSnapshot,
      supportRef: migration.supportRef,
      reason: migration.cancelReason,
      needsAttention: Boolean(migration.cancelNeedsAttentionAt),
    }),
    now,
    hooks,
  );
}

export async function enqueueAgentMigrationFailedReceipt(
  executor: DatabaseExecutor,
  migration: typeof agentMigrations.$inferSelect,
  now: Date,
  hooks: AgentMigrationReceiptEnqueueHooks = {},
): Promise<typeof messages.$inferSelect> {
  if (migration.state !== "failed") throw new Error("MIGRATION_RECEIPT_NOT_FAILED");
  return enqueueAgentMigrationReceipt(
    executor,
    migration,
    "failed",
    formatAgentMigrationTerminalReceipt({
      kind: "failed",
      sourceMachineName: migration.sourceMachineNameSnapshot,
      targetMachineName: migration.targetMachineNameSnapshot,
      supportRef: migration.supportRef,
      reason: migration.failureReason ?? migration.transportErrorCode,
    }),
    now,
    hooks,
  );
}

export async function drainAgentMigrationReceiptOutbox(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  batchSize?: number;
  now?: Date;
  staleLeaseMs?: number;
  afterBroadcast?: (messageId: string) => void | Promise<void>;
}): Promise<{ attempted: number; sent: number; failed: number }> {
  const db = getDb();
  const now = input.now ?? currentDate();
  const staleLockedAt = new Date(now.getTime() - (input.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS));
  const candidates = await db.select()
    .from(agentMigrationReceiptOutbox)
    .where(or(
      eq(agentMigrationReceiptOutbox.status, "pending"),
      and(
        eq(agentMigrationReceiptOutbox.status, "processing"),
        lt(agentMigrationReceiptOutbox.lockedAt, staleLockedAt),
      ),
    ))
    .orderBy(asc(agentMigrationReceiptOutbox.createdAt))
    .limit(input.batchSize ?? DEFAULT_BATCH_SIZE);

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const [claimed] = await db.update(agentMigrationReceiptOutbox)
      .set({
        status: "processing",
        lockedAt: now,
        attemptCount: sql`${agentMigrationReceiptOutbox.attemptCount} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(agentMigrationReceiptOutbox.id, candidate.id),
        or(
          eq(agentMigrationReceiptOutbox.status, "pending"),
          and(
            eq(agentMigrationReceiptOutbox.status, "processing"),
            lt(agentMigrationReceiptOutbox.lockedAt, staleLockedAt),
          ),
        ),
      ))
      .returning();
    if (!claimed) continue;
    attempted += 1;

    try {
      const [message] = await db.select().from(messages).where(eq(messages.id, claimed.messageId)).limit(1);
      if (!message) throw new Error("MIGRATION_RECEIPT_MESSAGE_MISSING");
      await broadcastSystemMessage(input.io, input.orchestrator, claimed.channelId, message.content, {
        inboxFactPolicy: {
          mode: "record",
          producer: `agent.migration_${claimed.receiptKind}_receipt`,
          reason: "Durable facts were committed with the migration completion transaction",
        },
        persistedMessage: message,
        targetAgentIds: [claimed.agentId],
        awaitAgentDelivery: true,
        bypassAgentMute: true,
        agentDeliveryOptions: {
          intrinsic: true,
          requireQueueReceipt: true,
        },
      });
      await input.afterBroadcast?.(message.id);
      await db.update(agentMigrationReceiptOutbox)
        .set({ status: "sent", sentAt: now, lockedAt: null, lastError: null, updatedAt: now })
        .where(and(
          eq(agentMigrationReceiptOutbox.id, claimed.id),
          eq(agentMigrationReceiptOutbox.status, "processing"),
        ));
      sent += 1;
    } catch (error) {
      await db.update(agentMigrationReceiptOutbox)
        .set({
          status: "pending",
          lockedAt: null,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          updatedAt: now,
        })
        .where(and(
          eq(agentMigrationReceiptOutbox.id, claimed.id),
          eq(agentMigrationReceiptOutbox.status, "processing"),
        ));
      failed += 1;
    }
  }
  return { attempted, sent, failed };
}

export function startAgentMigrationReceiptOutboxWorker(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  intervalMs?: number;
  batchSize?: number;
  observability?: AgentMigrationWorkerObservability;
  drainOutbox?: typeof drainAgentMigrationReceiptOutbox;
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const observability = input.observability ?? createAgentMigrationWorkerObservability({
    worker: "receipt_outbox",
  });
  const drainOutbox = input.drainOutbox ?? drainAgentMigrationReceiptOutbox;
  observability.startup();
  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await drainOutbox({
        io: input.io,
        orchestrator: input.orchestrator,
        batchSize: input.batchSize,
      });
      observability.drain(classifyAgentMigrationReceiptDrain(result));
    } catch (error) {
      observability.drain("failed");
      console.error("[AgentMigrationReceipt] Failed to drain outbox:", error);
    } finally {
      running = false;
    }
  };
  const timer = setClockInterval(() => void drain(), input.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  void drain();
  return {
    stop() {
      stopped = true;
      clearInterval(timer as ReturnType<typeof setInterval>);
    },
  };
}
