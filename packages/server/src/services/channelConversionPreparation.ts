import { currentDate } from "@botiverse/raft-shared";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  attachmentTransferIntents,
  attachmentUploadReservations,
  attachmentUploadSessions,
  channels,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalInboundEvents,
  jointChannels,
  jointChannelServers,
  messages,
  servers,
  tasks
} from "../db/schema";
import {
  type ConversionThreadProjection,
  type ConversionUploadScope
} from "./channelConversionContracts";
import {
  ChannelConversionLedgerConflictError,
  recordConversionPhaseCommit
} from "./channelConversionFenceService";
import { advance, ChannelConversionError, conversionTraceAttrs, persistResourceBatchProgress, requireCanonicalChannelId, requireStorageNamespaceId, stableStringify, type ChannelConversionJob, type ChannelConversionPhase } from "./channelConversionPhaseContext";
import { CHANNEL_CONVERSION_BATCH_SIZE, conversionThreadMapping, moveConversionResources, verifyConversionResources } from "./channelConversionResources";
import { taskConversationChannelName } from "./taskConversationService";
import { RESERVATION_IN_FLIGHT, SESSION_IN_FLIGHT, TRANSFER_INTENT_IN_FLIGHT } from "./channelConversionUploadActivity";

import type { ConversionPhaseContext } from "./channelConversionPhaseContext";
export class ChannelConversionUploadsInFlightError extends ChannelConversionError {
  constructor(
    public readonly uploadScope: ConversionUploadScope,
    public readonly uploadCount: number,
  ) {
    super(
      `Channel conversion is paused because ${uploadCount} attachment upload${uploadCount === 1 ? " is" : "s are"} still in progress. Return to the original channel and wait for the upload${uploadCount === 1 ? "" : "s"} to finish, or cancel ${uploadCount === 1 ? "it" : "them"}; then return to Settings and retry conversion.`,
      "channel_conversion_uploads_in_flight",
    );
  }
}


const EXTERNAL_CONVERSION_RECONFIRM_REASON = "channel_conversion_reconfirmation_required";
export async function prepareExternalBindingsForChannelConversion(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
  applyPause = true,
): Promise<number> {
  const bindings = await tx.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.serverId, serverId),
    eq(externalChannelBindings.channelId, sourceChannelId),
    inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
  )).for("update");
  let paused = 0;
  const now = currentDate();
  for (const binding of bindings) {
    if (
      binding.state === "paused"
      && binding.stateReason === EXTERNAL_CONVERSION_RECONFIRM_REASON
    ) continue;
    if (binding.state !== "active") {
      throw new ChannelConversionError(
        "External channel binding must be active before conversion",
        "external_binding_not_ready_for_conversion",
      );
    }
    if (binding.privacyFreshUntil <= now) {
      throw new ChannelConversionError(
        "External channel privacy must be verified before conversion",
        "external_binding_privacy_stale",
      );
    }
    if (binding.privacyClass !== "public") {
      throw new ChannelConversionError(
        "Private external channel bindings require an audience migration contract before conversion",
        "private_external_binding_conversion_unsupported",
      );
    }
    const [partition] = await tx.select({
      cursorPosition: externalDeliveryPartitions.cursorPosition,
      lastEnqueuedPosition: externalDeliveryPartitions.lastEnqueuedPosition,
    }).from(externalDeliveryPartitions).where(and(
      eq(externalDeliveryPartitions.bindingId, binding.id),
      eq(externalDeliveryPartitions.bindingEpoch, binding.bindingEpoch),
    )).for("update").limit(2);
    if (partition && partition.cursorPosition !== partition.lastEnqueuedPosition) {
      throw new ChannelConversionError(
        "External channel binding still has outbound work to drain",
        "external_binding_conversion_drain_pending",
      );
    }
    const [inbound] = await tx.select({ id: externalInboundEvents.id })
      .from(externalInboundEvents).where(and(
        eq(externalInboundEvents.bindingId, binding.id),
        eq(externalInboundEvents.bindingEpoch, binding.bindingEpoch),
        inArray(externalInboundEvents.status, ["queued", "processing"]),
      )).for("update").limit(1);
    if (inbound) {
      throw new ChannelConversionError(
        "External channel binding still has inbound work to drain",
        "external_binding_conversion_drain_pending",
      );
    }
    if (!applyPause) continue;
    const [updated] = await tx.update(externalChannelBindings).set({
      state: "paused",
      stateReason: EXTERNAL_CONVERSION_RECONFIRM_REASON,
      bindingEpoch: binding.bindingEpoch + 1,
      updatedAt: sql`now()`,
    }).where(and(
      eq(externalChannelBindings.id, binding.id),
      eq(externalChannelBindings.state, "active"),
      eq(externalChannelBindings.connectionEpoch, binding.connectionEpoch),
      eq(externalChannelBindings.bindingEpoch, binding.bindingEpoch),
    )).returning({ id: externalChannelBindings.id });
    if (!updated) {
      throw new ChannelConversionError(
        "External channel binding changed during conversion",
        "external_binding_conversion_fence_mismatch",
      );
    }
    paused += 1;
  }
  return paused;
}

async function ensureJointStorageNamespace(executor: DatabaseExecutor, ownerId: string): Promise<string> {
  const [existing] = await executor
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.slug, "__joint_storage__"), eq(servers.kind, "joint_storage"), isNull(servers.deletedAt)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await executor
    .insert(servers)
    .values({
      name: "Joint Storage Namespace",
      slug: "__joint_storage__",
      kind: "joint_storage",
      ownerId,
      plan: "founder",
      agentAllChannelGreetingEnabled: false,
    })
    .returning({ id: servers.id });
  return created.id;
}

/**
 * Conversion cannot copy a source set while an upload can still publish into
 * that set.  The advisory source lock prevents a new writer from racing this
 * read; the durable rows below make the decision restartable and observable.
 * Completed/consumed rows are safe, while a completed upload with an
 * unconsumed reservation is still in-flight from conversion's point of view.
 */
export async function assertNoActiveAttachmentTransfers(
  tx: DatabaseExecutor,
  scopeInput: { serverId: string; sourceChannelId: string; canonicalChannelId?: string | null },
): Promise<void> {
  const result = await tx.execute(sql`
    WITH scope AS (
      SELECT ${scopeInput.sourceChannelId}::uuid AS channel_id
      UNION
      SELECT thread_channel.id
        FROM ${channels} thread_channel
        JOIN ${messages} parent_message
          ON parent_message.id = thread_channel.parent_message_id
       WHERE thread_channel.type = 'thread'
         AND thread_channel.deleted_at IS NULL
         AND parent_message.channel_id = ${scopeInput.sourceChannelId}
      UNION
      SELECT ${scopeInput.canonicalChannelId ?? scopeInput.sourceChannelId}::uuid
      UNION
      -- Task v2 conversations under the source or canonical channel: the
      -- host's conversations (before and after they become local
      -- projections) and their canonical rows.
      SELECT task_conversation.id
        FROM ${channels} task_conversation
       WHERE task_conversation.type = 'task'
         AND task_conversation.deleted_at IS NULL
         AND task_conversation.parent_channel_id IN (
           ${scopeInput.sourceChannelId}, ${scopeInput.canonicalChannelId ?? scopeInput.sourceChannelId}
         )
      UNION
      SELECT joint_thread.canonical_channel_id
        FROM ${jointChannelServers} thread_projection
        JOIN ${jointChannels} joint_thread
          ON joint_thread.id = thread_projection.joint_channel_id
        JOIN ${channels} canonical_thread
          ON canonical_thread.id = joint_thread.canonical_channel_id
         AND canonical_thread.type = 'thread'
        JOIN ${messages} parent_message
          ON parent_message.id = canonical_thread.parent_message_id
       WHERE thread_projection.server_id = ${scopeInput.serverId}
         AND thread_projection.status = 'active'
         AND parent_message.channel_id IN (
           ${scopeInput.sourceChannelId}, ${scopeInput.canonicalChannelId ?? scopeInput.sourceChannelId}
         )
      UNION
      SELECT thread_projection.local_channel_id
        FROM ${jointChannelServers} thread_projection
        JOIN ${jointChannels} joint_thread
          ON joint_thread.id = thread_projection.joint_channel_id
        JOIN ${channels} canonical_thread
          ON canonical_thread.id = joint_thread.canonical_channel_id
         AND canonical_thread.type = 'thread'
        JOIN ${messages} parent_message
          ON parent_message.id = canonical_thread.parent_message_id
       WHERE thread_projection.server_id = ${scopeInput.serverId}
         AND thread_projection.status = 'active'
         AND parent_message.channel_id IN (
           ${scopeInput.sourceChannelId}, ${scopeInput.canonicalChannelId ?? scopeInput.sourceChannelId}
         )
    ), active_rows AS (
      SELECT 'session'::text AS kind, upload.id::text AS id, upload.attachment_id::text AS logical_id
        FROM ${attachmentUploadSessions} upload
        JOIN scope ON scope.channel_id = upload.channel_id
       WHERE ${SESSION_IN_FLIGHT}
      UNION ALL
      SELECT 'transfer_intent'::text AS kind, intent.id::text AS id, intent.reservation_id::text AS logical_id
        FROM ${attachmentTransferIntents} intent
        JOIN scope ON scope.channel_id = intent.channel_id
       WHERE ${TRANSFER_INTENT_IN_FLIGHT}
      UNION ALL
      SELECT 'reservation'::text AS kind, reservation.id::text AS id, reservation.id::text AS logical_id
        FROM ${attachmentUploadReservations} reservation
        JOIN scope ON scope.channel_id = reservation.channel_id
       WHERE ${RESERVATION_IN_FLIGHT}
    )
    SELECT kind, id, logical_id FROM active_rows ORDER BY kind, id
  `);
  const rows = result.rows as Array<{ kind?: unknown; id?: unknown; logical_id?: unknown }>;
  if (rows.length === 0) return;
  const uploadScope = {
    sessionIds: rows.filter((row) => row.kind === "session").map((row) => String(row.id)),
    transferIntentIds: rows.filter((row) => row.kind === "transfer_intent").map((row) => String(row.id)),
    reservationIds: rows.filter((row) => row.kind === "reservation").map((row) => String(row.id)),
  };
  const logicalUploadCount = new Set(
    rows.map((row) => String(row.logical_id ?? row.id)),
  ).size;
  throw new ChannelConversionUploadsInFlightError(uploadScope, logicalUploadCount);
}

/** Read-only admission preflight. The worker repeats this check after its
 * durable fence is established to cover a transfer racing the preflight. */
export async function assertNoActiveAttachmentTransfersBeforeAdmission(input: {
  serverId: string;
  sourceChannelId: string;
}): Promise<void> {
  await getDb().transaction((tx) => assertNoActiveAttachmentTransfers(tx, input));
}

export async function prepare(
  { tx, job, progress, span }: ConversionPhaseContext) {
  await assertNoActiveAttachmentTransfers(tx, job);
  const externalBindingsPaused = await prepareExternalBindingsForChannelConversion(tx, job.serverId, job.sourceChannelId);
  const [source] = await tx.select().from(channels).where(eq(channels.id, job.sourceChannelId)).limit(1);
  if (!source) throw new Error("source channel missing");
  if (!job.createdByUserId) throw new Error("conversion creator missing");
  const storageNamespaceId = await ensureJointStorageNamespace(tx, job.createdByUserId);

  let canonicalChannelId = job.canonicalChannelId;
  if (!canonicalChannelId) {
    const [canonical] = await tx
      .insert(channels)
      .values({
        serverId: storageNamespaceId,
        name: `joint-storage-convert-${job.id.replaceAll("-", "")}`,
        description: source.description,
        type: "channel",
        createdAt: source.createdAt,
      })
      .returning({ id: channels.id });
    canonicalChannelId = canonical.id;
  }

  let jointChannelId = job.jointChannelId;
  if (!jointChannelId) {
    const [joint] = await tx
      .insert(jointChannels)
      .values({
        canonicalChannelId,
        createdByServerId: job.serverId,
        createdByUserId: job.createdByUserId,
      })
      .returning({ id: jointChannels.id });
    jointChannelId = joint.id;
  }

  await tx
    .insert(jointChannelServers)
    .values({
      jointChannelId,
      serverId: job.serverId,
      localChannelId: job.sourceChannelId,
      role: "host",
      joinedByUserId: job.createdByUserId,
    })
    .onConflictDoNothing();

  // The insert is deliberately idempotent, but the retained projection is
  // the phase's business/authority output. Always read it back so retries
  // evidence what is actually persisted rather than the values we intended
  // to write. The ledger comparison then rejects any same-epoch drift.
  const persistedPrepareOutputs = await tx
    .select({
      canonicalChannelId: channels.id,
      canonicalServerId: channels.serverId,
      canonicalName: channels.name,
      canonicalDescription: channels.description,
      canonicalType: channels.type,
      canonicalParentMessageId: channels.parentMessageId,
      canonicalCreatedAt: channels.createdAt,
      jointChannelId: jointChannels.id,
      jointCanonicalChannelId: jointChannels.canonicalChannelId,
      jointCreatedByServerId: jointChannels.createdByServerId,
      jointCreatedByUserId: jointChannels.createdByUserId,
      jointStatus: jointChannels.status,
      localChannelId: jointChannelServers.localChannelId,
      projectionServerId: jointChannelServers.serverId,
      projectionJointChannelId: jointChannelServers.jointChannelId,
      projectionRole: jointChannelServers.role,
      projectionStatus: jointChannelServers.status,
      projectionJoinedByUserId: jointChannelServers.joinedByUserId,
      projectionDisconnectedByUserId: jointChannelServers.disconnectedByUserId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(channels, eq(channels.id, jointChannels.canonicalChannelId))
    .where(and(
      eq(jointChannelServers.serverId, job.serverId),
      or(
        eq(jointChannelServers.localChannelId, job.sourceChannelId),
        eq(jointChannelServers.jointChannelId, jointChannelId),
      ),
    ))
    .limit(2);
  const [persistedPrepareOutput] = persistedPrepareOutputs;
  const canonicalCreatedAt = source.createdAt instanceof Date
    ? source.createdAt.toISOString()
    : new Date(source.createdAt).toISOString();
  if (
    persistedPrepareOutputs.length !== 1
    || !persistedPrepareOutput
    || persistedPrepareOutput.canonicalChannelId !== canonicalChannelId
    || persistedPrepareOutput.canonicalServerId !== storageNamespaceId
    || persistedPrepareOutput.canonicalName !== `joint-storage-convert-${job.id.replaceAll("-", "")}`
    || persistedPrepareOutput.canonicalDescription !== source.description
    || persistedPrepareOutput.canonicalType !== "channel"
    || persistedPrepareOutput.canonicalParentMessageId !== null
    || persistedPrepareOutput.canonicalCreatedAt.toISOString() !== canonicalCreatedAt
    || persistedPrepareOutput.jointChannelId !== jointChannelId
    || persistedPrepareOutput.jointCanonicalChannelId !== canonicalChannelId
    || persistedPrepareOutput.jointCreatedByServerId !== job.serverId
    || persistedPrepareOutput.jointCreatedByUserId !== job.createdByUserId
    || persistedPrepareOutput.jointStatus !== "active"
    || persistedPrepareOutput.localChannelId !== job.sourceChannelId
    || persistedPrepareOutput.projectionServerId !== job.serverId
    || persistedPrepareOutput.projectionJointChannelId !== jointChannelId
    || persistedPrepareOutput.projectionRole !== "host"
    || persistedPrepareOutput.projectionStatus !== "active"
    || persistedPrepareOutput.projectionJoinedByUserId !== job.createdByUserId
    || persistedPrepareOutput.projectionDisconnectedByUserId !== null
  ) {
    throw new ChannelConversionLedgerConflictError(
      job.id,
      job.conversionEpoch,
      `${job.conversionEpoch}:prepare:all`,
    );
  }

  await advance(tx, job.id, "prepare_tasks", {
    canonicalChannelId,
    jointChannelId,
    progress: {
      ...progress,
      preparedAt: currentDate().toISOString(),
      canonicalCopyStarted: true,
      externalBindingsPaused,
      persistedPrepareOutput: {
        ...persistedPrepareOutput,
        canonicalCreatedAt: persistedPrepareOutput.canonicalCreatedAt.toISOString(),
      },
    },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}

export async function prepareTasks(
  { tx, job, progress, span }: ConversionPhaseContext) {
  // Any legacy message-only task is promoted
  // into the canonical Task v2 table before messages move.  Existing
  // canonical rows are untouched, so UUID/number/status/assignment/revision
  // and history remain stable.
  const directTaskResult = await tx.execute(sql`
    INSERT INTO ${tasks} (
      id, channel_id, task_number, title, status, created_by_type, created_by_id,
      claimed_by_type, claimed_by_id, claimed_at, completed_at, revision,
      message_id, created_at, updated_at
    )
    SELECT gen_random_uuid(), m.channel_id, m.task_number, m.content, m.task_status,
      m.sender_type, m.sender_id, m.task_assignee_type, m.task_assignee_id,
      m.task_claimed_at, m.task_completed_at, 0, m.id, m.created_at, now()
    FROM ${messages} m
    WHERE m.channel_id = ${job.sourceChannelId}
      AND m.task_status IS NOT NULL
      AND m.task_number IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${tasks} t WHERE t.message_id = m.id)
    ORDER BY m.id LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE}
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
  `);

  const threadTaskResult = await tx.execute(sql`
    INSERT INTO ${tasks} (
      id, channel_id, task_number, title, status, created_by_type, created_by_id,
      claimed_by_type, claimed_by_id, claimed_at, completed_at, revision,
      message_id, created_at, updated_at
    )
    SELECT gen_random_uuid(), m.channel_id, m.task_number, m.content, m.task_status,
      m.sender_type, m.sender_id, m.task_assignee_type, m.task_assignee_id,
      m.task_claimed_at, m.task_completed_at, 0, m.id, m.created_at, now()
    FROM ${messages} m
    JOIN ${channels} thread_channel ON thread_channel.id = m.channel_id
      AND thread_channel.type = 'thread' AND thread_channel.deleted_at IS NULL
    JOIN ${messages} parent_message ON parent_message.id = thread_channel.parent_message_id
    WHERE parent_message.channel_id = ${job.sourceChannelId}
      AND m.task_status IS NOT NULL
      AND m.task_number IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${tasks} t WHERE t.message_id = m.id)
    ORDER BY m.id LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE}
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id
  `);

  const directTaskRows = (Number(progress.taskRowsAffected ?? 0) + directTaskResult.rows.length);
  const threadTaskRows = (Number(progress.threadTaskRowsAffected ?? 0) + threadTaskResult.rows.length);
  const promoted = [...directTaskResult.rows, ...threadTaskResult.rows];
  const promotedTaskIds = [
    ...(progress.promotedTaskIds ?? []),
    ...promoted.map((row) => String((row as { id: unknown }).id)),
  ];
  if (promoted.length) await recordConversionPhaseCommit(tx, {
    jobId: job.id, conversionEpoch: job.conversionEpoch, phase: job.phase,
    batchKey: `tasks:${Number(progress.taskRowsAffected ?? 0) + Number(progress.threadTaskRowsAffected ?? 0)}`,
    sourceCount: promoted.length, targetCount: promoted.length, checksumInput: stableStringify(promoted),
  });
  progress.promotedTaskIds = promotedTaskIds;
  progress.taskRowsAffected = directTaskRows;
  progress.threadTaskRowsAffected = threadTaskRows;
  if (directTaskResult.rows.length === CHANNEL_CONVERSION_BATCH_SIZE || threadTaskResult.rows.length === CHANNEL_CONVERSION_BATCH_SIZE) {
    await persistResourceBatchProgress(tx, job, progress);
    return;
  }
  await advance(tx, job.id, "move_parent_messages", {
    progress: {
      ...progress,
      taskIdentityPreservedAt: currentDate().toISOString(),

      taskRowsAffected: directTaskRows,
      threadTaskRowsAffected: threadTaskRows,
      promotedTaskIds,
    },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: directTaskRows + threadTaskRows,

    taskRowsAffected: directTaskRows,
    threadTaskRowsAffected: threadTaskRows,

  }));
}

// One transaction moves at most this many rows from each resource family.
// Every batch commits its cursor and content checksum with the actual writes.
export { CHANNEL_CONVERSION_BATCH_SIZE } from "./channelConversionResources";

/** Raise `toChannelId`'s task-number high-water mark to at least `fromChannelId`'s. */
export async function carryTaskNumberHighWater(tx: DatabaseExecutor, fromChannelId: string, toChannelId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE ${channels} target
       SET task_number_high_water = source.task_number_high_water
      FROM ${channels} source
     WHERE source.id = ${fromChannelId}::uuid
       AND target.id = ${toChannelId}::uuid
       AND target.task_number_high_water < source.task_number_high_water
  `);
}

async function moveResources({ tx, job, progress }: ConversionPhaseContext, scope: "parent" | "thread", mapping: SQL, nextPhase: ChannelConversionPhase) {
  const resourceScope = scope;
  const before = progress.resources[resourceScope]?.messages?.moved ?? 0;
  const complete = await moveConversionResources(tx, job, mapping, resourceScope, progress);
  if (complete) await advance(tx, job.id, nextPhase, { progress });
  else await persistResourceBatchProgress(tx, job, progress);
  return (progress.resources[resourceScope]?.messages?.moved ?? 0) - before;
}

export async function moveParentMessages(
  { tx, job, progress, span }: ConversionPhaseContext) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  // The tasks move to the canonical channel, so its task numbering carries on
  // past the source's high-water mark too (RFC 078: numbers are never reused,
  // also not a deleted v2 task's). Idempotent across batches and retries.
  await carryTaskNumberHighWater(tx, job.sourceChannelId, canonicalChannelId);
  const moved = await moveResources({ tx, job, progress }, "parent", sql`
    SELECT ${job.sourceChannelId}::uuid AS local_id, ${canonicalChannelId}::uuid AS canonical_id
  `, "prepare_threads");
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok", rowsCopied: moved }));
}

export async function prepareThreads(
  { tx, job, progress, span }: ConversionPhaseContext) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const storageNamespaceId = await requireStorageNamespaceId(tx, canonicalChannelId);
  const sourceThreadsResult = await tx.execute(sql`
      SELECT
        thread_channel.id::text AS "oldThreadId",
        thread_channel.description AS "oldThreadDescription",
        thread_channel.created_at AS "oldThreadCreatedAt",
        thread_channel.parent_message_id::text AS "parentMessageId"
      FROM ${channels} thread_channel
      JOIN ${messages} parent_message
        ON parent_message.id = thread_channel.parent_message_id
      WHERE thread_channel.server_id = ${job.serverId}
        AND thread_channel.type = 'thread'
        AND thread_channel.deleted_at IS NULL
        AND parent_message.channel_id = ${canonicalChannelId}
        AND NOT EXISTS (
          SELECT 1
          FROM ${jointChannelServers} existing_projection
          WHERE existing_projection.local_channel_id = thread_channel.id
            AND existing_projection.status = 'active'
        )
      ORDER BY thread_channel.id LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE}
  `);
  const sourceThreads = sourceThreadsResult.rows as Array<{
    oldThreadId: string;
    oldThreadDescription: string | null;
    oldThreadCreatedAt: Date;
    parentMessageId: string;
  }>;

  for (const sourceThread of sourceThreads) {
    const canonicalThreadId = randomUUID();
    await tx
      .update(channels)
      .set({ parentMessageId: null })
      .where(eq(channels.id, sourceThread.oldThreadId));
    await tx.insert(channels).values({
      id: canonicalThreadId,
      serverId: storageNamespaceId,
      name: `thread-${sourceThread.parentMessageId.slice(0, 8)}`,
      description: sourceThread.oldThreadDescription,
      type: "thread",
      parentMessageId: sourceThread.parentMessageId,
      createdAt: sourceThread.oldThreadCreatedAt instanceof Date
        ? sourceThread.oldThreadCreatedAt
        : new Date(sourceThread.oldThreadCreatedAt),
    });
    const [jointThread] = await tx
      .insert(jointChannels)
      .values({
        canonicalChannelId: canonicalThreadId,
        createdByServerId: job.serverId,
        createdByUserId: job.createdByUserId,
      })
      .returning({ id: jointChannels.id });
    await tx.insert(jointChannelServers).values({
      jointChannelId: jointThread.id,
      serverId: job.serverId,
      localChannelId: sourceThread.oldThreadId,
      role: "host",
      status: "active",
      joinedByUserId: job.createdByUserId,
    });
    await tx.update(messages).set({ threadId: canonicalThreadId })
      .where(eq(messages.id, sourceThread.parentMessageId));
  }

  const preparedThreads = (typeof progress.preparedThreads === "number" ? progress.preparedThreads : 0) + sourceThreads.length;
  if (sourceThreads.length) await recordConversionPhaseCommit(tx, {
    jobId: job.id, conversionEpoch: job.conversionEpoch, phase: job.phase,
    batchKey: `threads:${progress.preparedThreadsCursor ?? "start"}`,
    sourceCount: sourceThreads.length, targetCount: sourceThreads.length,
    checksumInput: stableStringify(sourceThreads),
  });
  progress.preparedThreads = preparedThreads;
  if (sourceThreads.length) progress.preparedThreadsCursor = sourceThreads.at(-1)!.oldThreadId;
  if (sourceThreads.length === CHANNEL_CONVERSION_BATCH_SIZE) {
    await persistResourceBatchProgress(tx, job, progress);
    return;
  }
  const preparedTaskConversations = await prepareTaskConversationProjections(tx, job, canonicalChannelId, storageNamespaceId);
  progress.preparedTaskConversations = (progress.preparedTaskConversations ?? 0) + preparedTaskConversations;
  if (preparedTaskConversations === CHANNEL_CONVERSION_BATCH_SIZE) {
    await persistResourceBatchProgress(tx, job, progress);
    return;
  }
  const threadProjectionMap = await readThreadProjectionMap(tx, job, canonicalChannelId);
  await advance(tx, job.id, "move_thread_messages", {
    progress: { ...progress, preparedThreads, threadProjectionMap },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: preparedThreads,
  }));
}

/**
 * Task v2: the host's existing task conversations become joint task
 * conversations, mirroring what the thread loop above does for threads. By
 * now the tasks have moved to the canonical channel (move_parent_messages),
 * and the task_conversation_tasks migration trigger has pointed each canonical conversation's
 * parent_channel_id at it. For each such conversation still on the host
 * server without a projection:
 *  - the existing row becomes the host's LOCAL projection (parent = the source
 *    channel, which stays the host's local joint channel; follows, read
 *    cursors and inbox state keyed on it stay valid),
 *  - a new canonical conversation is created on the joint storage server and
 *    `tasks.conversation_channel_id` points at it,
 *  - joint_channels + joint_channel_servers link them; move_thread_messages
 *    then moves the conversation's messages into the canonical row
 *    (conversionThreadMapping's task arm).
 * Re-selection is idempotent (a converted task's conversation is on the
 * storage server). No task conversations exist with task v2 off: a no-op.
 * Returns how many conversations this batch converted.
 */
async function prepareTaskConversationProjections(
  tx: DatabaseExecutor,
  job: ChannelConversionJob,
  canonicalChannelId: string,
  storageNamespaceId: string,
): Promise<number> {
  const result = await tx.execute(sql`
    SELECT
      conversation.id::text AS "oldConversationId",
      conversation.description AS "description",
      conversation.created_at AS "createdAt",
      task.id::text AS "taskId"
    FROM ${tasks} task
    JOIN ${channels} conversation
      ON conversation.id = task.conversation_channel_id
     AND conversation.type = 'task'
     AND conversation.deleted_at IS NULL
    WHERE task.channel_id = ${canonicalChannelId}
      AND conversation.server_id = ${job.serverId}
      AND NOT EXISTS (
        SELECT 1
        FROM ${jointChannelServers} existing_projection
        WHERE existing_projection.local_channel_id = conversation.id
          AND existing_projection.status = 'active'
      )
    ORDER BY conversation.id LIMIT ${CHANNEL_CONVERSION_BATCH_SIZE}
  `);
  const sourceConversations = result.rows as Array<{
    oldConversationId: string;
    description: string | null;
    createdAt: Date | string;
    taskId: string;
  }>;
  for (const source of sourceConversations) {
    // Detach first: (task_id, parent_channel_id) is unique per live task
    // conversation, and the canonical row below takes the canonical parent.
    await tx.update(channels)
      .set({ parentChannelId: job.sourceChannelId })
      .where(eq(channels.id, source.oldConversationId));
    const canonicalConversationId = randomUUID();
    await tx.insert(channels).values({
      id: canonicalConversationId,
      serverId: storageNamespaceId,
      name: taskConversationChannelName(source.taskId),
      description: source.description,
      type: "task",
      taskId: source.taskId,
      parentMessageId: null,
      parentChannelId: canonicalChannelId,
      createdAt: source.createdAt instanceof Date ? source.createdAt : new Date(source.createdAt),
    });
    await tx.update(tasks)
      .set({ conversationChannelId: canonicalConversationId })
      .where(and(eq(tasks.id, source.taskId), eq(tasks.conversationChannelId, source.oldConversationId)));
    const [jointConversation] = await tx
      .insert(jointChannels)
      .values({
        canonicalChannelId: canonicalConversationId,
        createdByServerId: job.serverId,
        createdByUserId: job.createdByUserId,
      })
      .returning({ id: jointChannels.id });
    await tx.insert(jointChannelServers).values({
      jointChannelId: jointConversation.id,
      serverId: job.serverId,
      localChannelId: source.oldConversationId,
      role: "host",
      status: "active",
      joinedByUserId: job.createdByUserId,
    });
  }
  if (sourceConversations.length) await recordConversionPhaseCommit(tx, {
    jobId: job.id, conversionEpoch: job.conversionEpoch, phase: job.phase,
    batchKey: `task_conversations:${sourceConversations[0]!.oldConversationId}`,
    sourceCount: sourceConversations.length, targetCount: sourceConversations.length,
    checksumInput: stableStringify(sourceConversations.map(({ oldConversationId, taskId }) => ({ oldConversationId, taskId }))),
  });
  return sourceConversations.length;
}

export async function moveThreadMessages(
  { tx, job, progress, span }: ConversionPhaseContext) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const moved = await moveResources({ tx, job, progress }, "thread", conversionThreadMapping(job.serverId, canonicalChannelId), "verify");
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok", rowsCopied: moved }));
}

export async function verify(
  { tx, job, progress, span }: ConversionPhaseContext) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  await verifyConversionResources(tx, sql`
    SELECT ${job.sourceChannelId}::uuid AS channel_id
    UNION SELECT local_id FROM (${conversionThreadMapping(job.serverId, canonicalChannelId)}) threads
  `);

  await advance(tx, job.id, "audience_cutover", {
    progress: { ...progress, verifiedAt: currentDate().toISOString() },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}

async function readThreadProjectionMap(
  tx: DatabaseExecutor,
  job: ChannelConversionJob,
  canonicalChannelId: string,
): Promise<ConversionThreadProjection[]> {
  const result = await tx.execute(sql`
    SELECT
      projection.local_channel_id::text AS "localThreadId",
      joint_thread.canonical_channel_id::text AS "canonicalThreadId",
      canonical_thread.server_id::text AS "canonicalServerId",
      canonical_thread.parent_message_id::text AS "canonicalParentMessageId",
      projection.joint_channel_id::text AS "jointChannelId",
      joint_thread.created_by_server_id::text AS "jointCreatedByServerId",
      joint_thread.created_by_user_id::text AS "jointCreatedByUserId",
      joint_thread.status::text AS "jointStatus",
      projection.server_id::text AS "projectionServerId",
      projection.role::text AS role,
      projection.status::text AS status,
      projection.joined_by_user_id::text AS "joinedByUserId",
      projection.disconnected_by_user_id::text AS "disconnectedByUserId"
    FROM ${jointChannelServers} projection
    JOIN ${jointChannels} joint_thread
      ON joint_thread.id = projection.joint_channel_id
    JOIN ${channels} canonical_thread
      ON canonical_thread.id = joint_thread.canonical_channel_id
    JOIN ${messages} parent_message
      ON parent_message.id = canonical_thread.parent_message_id
    WHERE projection.server_id = ${job.serverId}
      AND canonical_thread.type = 'thread'
      AND parent_message.channel_id = ${canonicalChannelId}
    ORDER BY projection.local_channel_id, projection.joint_channel_id
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    localThreadId: String(row.localThreadId),
    canonicalThreadId: String(row.canonicalThreadId),
    canonicalServerId: String(row.canonicalServerId),
    canonicalParentMessageId: String(row.canonicalParentMessageId),
    jointChannelId: String(row.jointChannelId),
    jointCreatedByServerId: String(row.jointCreatedByServerId),
    jointCreatedByUserId: typeof row.jointCreatedByUserId === "string" ? row.jointCreatedByUserId : null,
    jointStatus: String(row.jointStatus),
    projectionServerId: String(row.projectionServerId),
    role: String(row.role),
    status: String(row.status),
    joinedByUserId: typeof row.joinedByUserId === "string" ? row.joinedByUserId : null,
    disconnectedByUserId: typeof row.disconnectedByUserId === "string" ? row.disconnectedByUserId : null,
  }));
}
