import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { noopTracer, type TraceAttributes, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  attachments,
  channelAgents,
  channelConversionJobs,
  channelHumans,
  channels,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalInboundEvents,
  jointChannels,
  jointChannelServers,
  messages,
  servers,
} from "../db/schema.js";
import { withServerLock, withServerResourceLock } from "./planService.js";

export type ChannelConversionPhase =
  | "prepare"
  | "drop_task_identity"
  | "move_parent_messages"
  | "prepare_threads"
  | "move_thread_messages"
  | "verify"
  | "finalize"
  | "done";

type ChannelConversionJob = typeof channelConversionJobs.$inferSelect;
type ChannelConversionTraceOutcome = "ok" | "failed" | "timeout";
export type ChannelConversionPreJobPhase =
  | "source_lookup"
  | "active_job_check"
  | "eligibility_check"
  | "source_lock"
  | "job_insert";
type ChannelConversionEligibilitySubcheck = "direct_task" | "thread_task";
type ChannelConversionTaskIdentityDropPolicy = "drop_task_identity";
type ChannelConversionPreJobTrace = (event: {
  phase: ChannelConversionPreJobPhase;
  outcome: "started" | "ok" | "failed";
  errorClass?: string;
  eligibilitySubcheck?: ChannelConversionEligibilitySubcheck;
}) => void;

const CONVERSION_LOCK_NAMESPACE = 136;
const LEASE_MS = 60_000;
export const CHANNEL_CONVERSION_TASK_IDENTITY_DROP_COPY =
  "This channel contains tasks. Converting it will permanently remove task identity from those messages: they will disappear from task boards, task links, and task badges. The messages themselves remain in history.";

const NEXT_PHASE: Record<Exclude<ChannelConversionPhase, "done">, ChannelConversionPhase> = {
  prepare: "drop_task_identity",
  drop_task_identity: "move_parent_messages",
  move_parent_messages: "prepare_threads",
  prepare_threads: "move_thread_messages",
  move_thread_messages: "verify",
  verify: "finalize",
  finalize: "done",
};

export class ChannelConversionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ChannelConversionTaskInventoryItem {
  kind: "direct" | "thread";
  messageId: string;
  channelId: string;
  taskStatus: string;
  taskNumber: number | null;
  parentMessageId?: string;
  threadChannelId?: string;
}

export interface ChannelConversionTaskInventory {
  directTaskCount: number;
  threadTaskCount: number;
  totalCount: number;
  directTasks: ChannelConversionTaskInventoryItem[];
  threadTasks: ChannelConversionTaskInventoryItem[];
}

export class ChannelConversionTaskIdentityDropRequiredError extends ChannelConversionError {
  constructor(public readonly taskInventory: ChannelConversionTaskInventory) {
    super(CHANNEL_CONVERSION_TASK_IDENTITY_DROP_COPY, "channel_conversion_task_identity_drop_required");
  }
}

export function describeChannelConversionPreJobFailure(phase: ChannelConversionPreJobPhase, error: unknown) {
  const timedOut = isLikelyTimeout(error);
  const phaseCopy: Record<ChannelConversionPreJobPhase, string> = {
    source_lookup: "looking up the source channel",
    active_job_check: "checking for an existing conversion job",
    eligibility_check: "checking whether the channel contains tasks",
    source_lock: "reserving the source channel",
    job_insert: "creating the conversion job",
  };
  return {
    status: timedOut ? 503 : 500,
    code: `channel_conversion_${phase}${timedOut ? "_timeout" : "_failed"}`,
    error: `Channel conversion ${timedOut ? "timed out" : "failed"} while ${phaseCopy[phase]}. The source channel was not locked and history remains intact. Please retry or contact support.`,
    phase,
    retryable: true,
  };
}

export async function startChannelToJointConversion(input: {
  serverId: string;
  sourceChannelId: string;
  createdByUserId: string;
  confirmTaskIdentityDrop?: boolean;
  tracePreJobPhase?: ChannelConversionPreJobTrace;
}): Promise<ChannelConversionJob> {
  return withServerLock(input.serverId, CONVERSION_LOCK_NAMESPACE, async (tx) => {
    const [source] = await tracePreJobPhase(input, "source_lookup", () => tx
      .select()
      .from(channels)
      .where(and(
        eq(channels.id, input.sourceChannelId),
        isNull(channels.deletedAt),
      ))
      .limit(1));
    if (!source || source.serverId !== input.serverId) throw new ChannelConversionError("Channel not found", "channel_not_found");
    if (source.type !== "channel" && source.type !== "private") {
      throw new ChannelConversionError("Only public or private channels can be converted", "unsupported_channel_type");
    }
    if (source.name === "all") {
      throw new ChannelConversionError("The #all channel cannot be converted", "reserved_channel");
    }

    const [activeJob] = await tracePreJobPhase(input, "active_job_check", () => tx
      .select()
      .from(channelConversionJobs)
      .where(and(
        eq(channelConversionJobs.sourceChannelId, source.id),
        inArray(channelConversionJobs.status, ["pending", "running", "failed"]),
      ))
      .limit(1));
    const activeJobProgress = activeJob ? normalizeProgress(activeJob.progress) : null;
    const canRevalidateFailedUnlockedJob = activeJob?.status === "failed" && activeJobProgress?.sourceLock === "released";
    if (activeJob && !canRevalidateFailedUnlockedJob) return activeJob;

    const taskInventory = await tracePreJobPhase(input, "eligibility_check", async () => {
      return collectTaskInventory(tx, source.id, input);
    });
    if (taskInventory.totalCount > 0 && !input.confirmTaskIdentityDrop) {
      throw new ChannelConversionTaskIdentityDropRequiredError(taskInventory);
    }

    const now = new Date();
    const externalBindingsPaused = await tracePreJobPhase(input, "source_lock", async () => {
      // Outbound admission takes this same canonical conversation row before
      // it resolves binding authority or inserts the source message/outbox
      // fact. Take it first here too: the prior binding-first order allowed an
      // already-started sender to append an old-epoch delivery after the drain
      // check but before conversion committed its epoch bump.
      const [lockedSource] = await tx.select().from(channels).where(and(
        eq(channels.id, source.id),
        eq(channels.serverId, source.serverId),
        isNull(channels.deletedAt),
      )).for("update").limit(1);
      if (
        !lockedSource
        || (lockedSource.type !== "channel" && lockedSource.type !== "private")
      ) {
        throw new ChannelConversionError(
          "Channel changed before conversion could reserve it",
          "channel_conversion_source_changed",
        );
      }

      const paused = await prepareExternalBindingsForChannelConversion(
        tx,
        lockedSource.serverId,
        lockedSource.id,
      );
      await tx.update(channels)
        .set({
          archivedAt: lockedSource.archivedAt ?? now,
          archivedByUserId: input.createdByUserId,
          archivedByAgentId: null,
        })
        .where(eq(channels.id, lockedSource.id));
      return paused;
    });

    if (activeJob && canRevalidateFailedUnlockedJob) {
      const [job] = await tracePreJobPhase(input, "job_insert", () => tx
        .update(channelConversionJobs)
        .set({
          status: "pending",
          phase: "prepare",
          error: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
          progress: {
            ...activeJobProgress,
            lockedAt: now.toISOString(),
            relockedAt: now.toISOString(),
            retryState: "running",
            sourceLock: "retained",
            taskConversionPolicy: taskInventory.totalCount > 0 ? "drop_task_identity" : "none",
            taskDropAcknowledged: taskInventory.totalCount > 0 ? input.confirmTaskIdentityDrop === true : false,
            taskInventory: {
              directTaskCount: taskInventory.directTaskCount,
              threadTaskCount: taskInventory.threadTaskCount,
              totalCount: taskInventory.totalCount,
            },
            externalBindingsPaused,
          },
        })
        .where(eq(channelConversionJobs.id, activeJob.id))
        .returning());
      return job;
    }

    const [job] = await tracePreJobPhase(input, "job_insert", () => tx
      .insert(channelConversionJobs)
      .values({
        serverId: input.serverId,
        sourceChannelId: source.id,
        sourceChannelType: source.type as "channel" | "private",
        status: "pending",
        phase: "prepare",
        createdByUserId: input.createdByUserId,
        progress: {
          lockedAt: now.toISOString(),
          taskConversionPolicy: taskInventory.totalCount > 0 ? "drop_task_identity" : "none",
          taskDropAcknowledged: taskInventory.totalCount > 0 ? input.confirmTaskIdentityDrop === true : false,
          taskInventory: {
            directTaskCount: taskInventory.directTaskCount,
            threadTaskCount: taskInventory.threadTaskCount,
            totalCount: taskInventory.totalCount,
          },
          externalBindingsPaused,
        },
      })
      .returning());
    return job;
  });
}

const EXTERNAL_CONVERSION_RECONFIRM_REASON = "channel_conversion_reconfirmation_required";

/**
 * Freezes every live external conversation before Channel history moves into
 * Joint storage. The binding remains anchored to the same permission-facing
 * local channel id; its old epoch is drained, then invalidated so neither
 * inbound nor outbound work can cross the conversion boundary. Provisioning
 * must run a fresh preflight/reconfirmation before the new epoch can resume.
 */
async function prepareExternalBindingsForChannelConversion(
  tx: DatabaseExecutor,
  serverId: string,
  sourceChannelId: string,
): Promise<number> {
  const bindings = await tx.select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.serverId, serverId),
    eq(externalChannelBindings.channelId, sourceChannelId),
    inArray(externalChannelBindings.state, ["active", "paused", "quarantined"]),
  )).for("update");
  let paused = 0;
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

async function collectTaskInventory(
  tx: DatabaseExecutor,
  sourceChannelId: string,
  input?: { tracePreJobPhase?: ChannelConversionPreJobTrace },
): Promise<ChannelConversionTaskInventory> {
  const directTaskResult = await traceEligibilitySubcheck(input ?? {}, "direct_task", () => tx.execute(sql`
      SELECT
        'direct'::text AS "kind",
        task_message.id::text AS "messageId",
        task_message.channel_id::text AS "channelId",
        task_message.task_status::text AS "taskStatus",
        task_message.task_number AS "taskNumber"
        FROM ${messages} task_message
       WHERE task_message.channel_id = ${sourceChannelId}
         AND task_message.task_status IS NOT NULL
       ORDER BY task_message.seq ASC
    `));

  const threadTaskResult = await traceEligibilitySubcheck(input ?? {}, "thread_task", () => tx.execute(sql`
      SELECT
        'thread'::text AS "kind",
        task_message.id::text AS "messageId",
        task_message.channel_id::text AS "channelId",
        task_message.task_status::text AS "taskStatus",
        task_message.task_number AS "taskNumber",
        parent_message.id::text AS "parentMessageId",
        thread_channel.id::text AS "threadChannelId"
        FROM ${messages} parent_message
        JOIN ${channels} thread_channel
          ON thread_channel.parent_message_id = parent_message.id
         AND thread_channel.type = 'thread'
         AND thread_channel.deleted_at IS NULL
        JOIN ${messages} task_message
          ON task_message.channel_id = thread_channel.id
         AND task_message.task_status IS NOT NULL
       WHERE parent_message.channel_id = ${sourceChannelId}
       ORDER BY parent_message.seq ASC, task_message.seq ASC
    `));
  const directTasks = directTaskResult.rows.map((row) => normalizeTaskInventoryRow(row, "direct"));
  const threadTasks = threadTaskResult.rows.map((row) => normalizeTaskInventoryRow(row, "thread"));
  return {
    directTaskCount: directTasks.length,
    threadTaskCount: threadTasks.length,
    totalCount: directTasks.length + threadTasks.length,
    directTasks,
    threadTasks,
  };
}

function normalizeTaskInventoryRow(
  row: unknown,
  kind: "direct" | "thread",
): ChannelConversionTaskInventoryItem {
  const value = row && typeof row === "object" ? row as Record<string, unknown> : {};
  return {
    kind,
    messageId: String(value.messageId ?? ""),
    channelId: String(value.channelId ?? ""),
    taskStatus: String(value.taskStatus ?? ""),
    taskNumber: typeof value.taskNumber === "number" ? value.taskNumber : null,
    ...(typeof value.parentMessageId === "string" ? { parentMessageId: value.parentMessageId } : {}),
    ...(typeof value.threadChannelId === "string" ? { threadChannelId: value.threadChannelId } : {}),
  };
}

async function tracePreJobPhase<T>(
  input: { tracePreJobPhase?: ChannelConversionPreJobTrace },
  phase: ChannelConversionPreJobPhase,
  work: () => Promise<T>,
): Promise<T> {
  input.tracePreJobPhase?.({ phase, outcome: "started" });
  try {
    const result = await work();
    input.tracePreJobPhase?.({ phase, outcome: "ok" });
    return result;
  } catch (error) {
    input.tracePreJobPhase?.({
      phase,
      outcome: "failed",
      errorClass: classifyConversionErrorClass(error),
    });
    throw error;
  }
}

async function traceEligibilitySubcheck<T>(
  input: { tracePreJobPhase?: ChannelConversionPreJobTrace },
  eligibilitySubcheck: ChannelConversionEligibilitySubcheck,
  work: () => Promise<T>,
): Promise<T> {
  input.tracePreJobPhase?.({ phase: "eligibility_check", eligibilitySubcheck, outcome: "started" });
  try {
    const result = await work();
    input.tracePreJobPhase?.({ phase: "eligibility_check", eligibilitySubcheck, outcome: "ok" });
    return result;
  } catch (error) {
    input.tracePreJobPhase?.({
      phase: "eligibility_check",
      eligibilitySubcheck,
      outcome: "failed",
      errorClass: classifyConversionErrorClass(error),
    });
    throw error;
  }
}

export async function retryChannelConversionJob(jobId: string): Promise<ChannelConversionJob> {
  const db = getDb();
  const job = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(channelConversionJobs)
      .where(eq(channelConversionJobs.id, jobId))
      .limit(1);
    if (!existing) return null;
    const progress = normalizeProgress(existing.progress);
    if (progress.sourceLock === "released" && progress.taskDropAcknowledged !== true) {
      const inventory = await collectTaskInventory(tx, existing.sourceChannelId);
      if (inventory.totalCount > 0) {
        throw new ChannelConversionTaskIdentityDropRequiredError(inventory);
      }
    }

    const [source] = await tx
      .select({
        archivedAt: channels.archivedAt,
        archivedByUserId: channels.archivedByUserId,
      })
      .from(channels)
      .where(eq(channels.id, existing.sourceChannelId))
      .limit(1);
    const lockedAt = new Date();
    await tx
      .update(channels)
      .set({
        archivedAt: source?.archivedAt ?? lockedAt,
        archivedByUserId: source?.archivedByUserId ?? existing.createdByUserId,
        archivedByAgentId: null,
      })
      .where(eq(channels.id, existing.sourceChannelId));

    const [updated] = await tx
      .update(channelConversionJobs)
      .set({
        status: "pending",
        phase: existing.status === "failed" ? "prepare" : existing.phase,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: lockedAt,
        progress: { ...progress, relockedAt: lockedAt.toISOString(), retryState: "running" },
      })
      .where(eq(channelConversionJobs.id, jobId))
      .returning();
    return updated ?? null;
  });
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return job;
}

export async function runChannelConversionJob(
  jobId: string,
  opts: {
    maxPhases?: number;
    failBeforePhase?: ChannelConversionPhase;
    tracer?: Tracer | null;
    traceParent?: TraceContext | null;
  } = {},
): Promise<ChannelConversionJob> {
  const tracer = opts.tracer ?? noopTracer;
  let remaining = opts.maxPhases ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const job = await getChannelConversionJob(jobId);
    if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
    if (job.phase === "done" || job.status === "done") return job;
    if (job.status === "failed") return job;
    if (job.status === "canceled") return job;
    if (opts.failBeforePhase && job.phase === opts.failBeforePhase) {
      await markJobFailed(job.id, `injected failure before ${job.phase}`, new Error("InjectedChannelConversionFailure"));
      return (await getChannelConversionJob(job.id))!;
    }
    await runOnePhase(job, tracer, opts.traceParent ?? null);
    remaining -= 1;
  }
  const job = await getChannelConversionJob(jobId);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return job;
}

export async function getChannelConversionJob(jobId: string): Promise<ChannelConversionJob | null> {
  const db = getDb();
  const [job] = await db.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
  return job ?? null;
}

async function runOnePhase(job: ChannelConversionJob, tracer: Tracer, traceParent: TraceContext | null) {
  const phaseSpan = tracer.startSpan("server.channel_conversion.phase", {
    parent: traceParent,
    surface: "server",
    kind: "internal",
    attrs: conversionTraceAttrs(job, { outcome: "ok" }),
  });
  let outcome: ChannelConversionTraceOutcome = "ok";
  let errorClass: string | undefined;
  try {
    await withServerResourceLock(job.serverId, CONVERSION_LOCK_NAMESPACE, job.sourceChannelId, async (tx) => {
      const [current] = await tx
        .select()
        .from(channelConversionJobs)
        .where(eq(channelConversionJobs.id, job.id))
        .limit(1);
      if (!current || current.status === "done" || current.phase === "done" || current.status === "canceled") return;

      const leaseOwner = `conversion:${randomUUID()}`;
      await tx
        .update(channelConversionJobs)
        .set({
          status: "running",
          error: null,
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(channelConversionJobs.id, current.id));

      if (current.phase === "prepare") await prepare(tx, current, phaseSpan);
      else if (current.phase === "drop_task_identity") await dropTaskIdentity(tx, current, phaseSpan);
      else if (current.phase === "move_parent_messages") await moveParentMessages(tx, current, phaseSpan);
      else if (current.phase === "prepare_threads") await prepareThreads(tx, current, phaseSpan);
      else if (current.phase === "move_thread_messages") await moveThreadMessages(tx, current, phaseSpan);
      else if (current.phase === "verify") await verify(tx, current, phaseSpan);
      else if (current.phase === "finalize") await finalize(tx, current, phaseSpan);
    });
  } catch (err) {
    outcome = classifyConversionTraceOutcome(err);
    errorClass = classifyConversionErrorClass(err);
    phaseSpan.addEvent("server.channel_conversion.phase.failed", conversionTraceAttrs(job, { outcome, errorClass }));
    await markJobFailed(job.id, err instanceof Error ? err.message : String(err), err);
  } finally {
    phaseSpan.end(outcome === "ok" ? "ok" : "error", {
      attrs: conversionTraceAttrs(job, { outcome, errorClass }),
    });
  }
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

async function prepare(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
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

  await advance(tx, job.id, "drop_task_identity", {
    canonicalChannelId,
    jointChannelId,
    progress: { ...job.progress, preparedAt: new Date().toISOString() },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}

async function dropTaskIdentity(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
  const directTaskResult = await tx.execute(sql`
    UPDATE ${messages} task_message
       SET task_status = NULL,
           task_number = NULL,
           task_assignee_type = NULL,
           task_assignee_id = NULL,
           task_claimed_at = NULL,
           task_completed_at = NULL,
           updated_at = now()
     WHERE task_message.channel_id = ${job.sourceChannelId}
       AND task_message.task_status IS NOT NULL
    RETURNING 1
  `);

  const threadTaskResult = await tx.execute(sql`
    WITH source_threads AS (
      SELECT thread_channel.id AS thread_channel_id
        FROM ${messages} parent_message
        JOIN ${channels} thread_channel
          ON thread_channel.parent_message_id = parent_message.id
         AND thread_channel.type = 'thread'
         AND thread_channel.deleted_at IS NULL
       WHERE parent_message.channel_id = ${job.sourceChannelId}
    )
    UPDATE ${messages} task_message
       SET task_status = NULL,
           task_number = NULL,
           task_assignee_type = NULL,
           task_assignee_id = NULL,
           task_claimed_at = NULL,
           task_completed_at = NULL,
           updated_at = now()
      FROM source_threads
     WHERE task_message.channel_id = source_threads.thread_channel_id
       AND task_message.task_status IS NOT NULL
    RETURNING 1
  `);

  const directTaskRows = directTaskResult.rows.length;
  const threadTaskRows = threadTaskResult.rows.length;
  const progress = normalizeProgress(job.progress);
  await advance(tx, job.id, "move_parent_messages", {
    progress: {
      ...progress,
      droppedTaskIdentityAt: new Date().toISOString(),
      taskConversionPolicy: "drop_task_identity",
      taskRowsAffected: directTaskRows,
      threadTaskRowsAffected: threadTaskRows,
    },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: directTaskRows + threadTaskRows,
    taskConversionPolicy: "drop_task_identity",
    taskRowsAffected: directTaskRows,
    threadTaskRowsAffected: threadTaskRows,
    acknowledged: progress.taskDropAcknowledged === true,
  }));
}

async function moveParentMessages(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const moveResult = await tx.execute(sql`
    UPDATE ${messages}
       SET channel_id = ${canonicalChannelId},
           updated_at = now()
     WHERE channel_id = ${job.sourceChannelId}
    RETURNING 1
  `);
  const attachmentResult = await tx.execute(sql`
    UPDATE ${attachments} attachment
       SET channel_id = ${canonicalChannelId}
      FROM ${messages} message
     WHERE attachment.channel_id = ${job.sourceChannelId}
       AND attachment.message_id = message.id
       AND message.channel_id = ${canonicalChannelId}
    RETURNING 1
  `);
  await advance(tx, job.id, "prepare_threads", {
    progress: {
      ...job.progress,
      movedParentMessages: moveResult.rows.length,
      movedParentAttachments: attachmentResult.rows.length,
    },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: moveResult.rows.length,
  }));
}

async function prepareThreads(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
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
  }

  await tx.execute(sql`
    UPDATE ${messages} parent_message
       SET thread_id = joint_thread.canonical_channel_id::text,
           updated_at = now()
      FROM ${jointChannelServers} thread_projection
      JOIN ${jointChannels} joint_thread
        ON joint_thread.id = thread_projection.joint_channel_id
      JOIN ${channels} local_thread
        ON local_thread.id = thread_projection.local_channel_id
      JOIN ${channels} canonical_thread
        ON canonical_thread.id = joint_thread.canonical_channel_id
     WHERE thread_projection.server_id = ${job.serverId}
       AND local_thread.type = 'thread'
       AND canonical_thread.type = 'thread'
       AND canonical_thread.parent_message_id = parent_message.id
       AND parent_message.channel_id = ${canonicalChannelId}
  `);

  await tx.execute(sql`
    UPDATE ${channels} local_thread
       SET parent_message_id = NULL
      FROM ${jointChannelServers} thread_projection
      JOIN ${jointChannels} joint_thread
        ON joint_thread.id = thread_projection.joint_channel_id
      JOIN ${channels} canonical_thread
        ON canonical_thread.id = joint_thread.canonical_channel_id
     WHERE local_thread.id = thread_projection.local_channel_id
       AND thread_projection.server_id = ${job.serverId}
       AND local_thread.type = 'thread'
       AND canonical_thread.type = 'thread'
       AND canonical_thread.parent_message_id IS NOT NULL
  `);

  await advance(tx, job.id, "move_thread_messages", {
    progress: { ...job.progress, preparedThreads: sourceThreads.length },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: sourceThreads.length,
  }));
}

async function moveThreadMessages(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const moveResult = await tx.execute(sql`
    WITH thread_map AS (
      SELECT
        thread_projection.local_channel_id AS local_thread_id,
        joint_thread.canonical_channel_id AS canonical_thread_id
      FROM ${jointChannelServers} thread_projection
      JOIN ${jointChannels} joint_thread
        ON joint_thread.id = thread_projection.joint_channel_id
      JOIN ${channels} local_thread
        ON local_thread.id = thread_projection.local_channel_id
      JOIN ${channels} canonical_thread
        ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent_message
        ON parent_message.id = canonical_thread.parent_message_id
      WHERE thread_projection.server_id = ${job.serverId}
        AND local_thread.type = 'thread'
        AND canonical_thread.type = 'thread'
        AND parent_message.channel_id = ${canonicalChannelId}
    )
    UPDATE ${messages} message
       SET channel_id = thread_map.canonical_thread_id,
           updated_at = now()
      FROM thread_map
     WHERE message.channel_id = thread_map.local_thread_id
    RETURNING 1
  `);

  const attachmentResult = await tx.execute(sql`
    WITH thread_map AS (
      SELECT
        thread_projection.local_channel_id AS local_thread_id,
        joint_thread.canonical_channel_id AS canonical_thread_id
      FROM ${jointChannelServers} thread_projection
      JOIN ${jointChannels} joint_thread
        ON joint_thread.id = thread_projection.joint_channel_id
      JOIN ${channels} local_thread
        ON local_thread.id = thread_projection.local_channel_id
      JOIN ${channels} canonical_thread
        ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent_message
        ON parent_message.id = canonical_thread.parent_message_id
      WHERE thread_projection.server_id = ${job.serverId}
        AND local_thread.type = 'thread'
        AND canonical_thread.type = 'thread'
        AND parent_message.channel_id = ${canonicalChannelId}
    )
    UPDATE ${attachments} attachment
       SET channel_id = thread_map.canonical_thread_id
      FROM thread_map
     WHERE attachment.channel_id = thread_map.local_thread_id
    RETURNING 1
  `);

  await advance(tx, job.id, "verify", {
    progress: {
      ...job.progress,
      movedThreadMessages: moveResult.rows.length,
      movedThreadAttachments: attachmentResult.rows.length,
    },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, {
    outcome: "ok",
    rowsCopied: moveResult.rows.length,
  }));
}

async function verify(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
  const canonicalChannelId = await requireCanonicalChannelId(tx, job);
  const leftoverParent = await tx.execute(sql`
    SELECT 1
      FROM ${messages}
     WHERE channel_id = ${job.sourceChannelId}
     LIMIT 1
  `);
  if (leftoverParent.rows.length > 0) throw new Error("source channel still has local messages");

  const leftoverThread = await tx.execute(sql`
    SELECT 1
      FROM ${messages} message
      JOIN ${jointChannelServers} thread_projection
        ON thread_projection.local_channel_id = message.channel_id
      JOIN ${jointChannels} joint_thread
        ON joint_thread.id = thread_projection.joint_channel_id
      JOIN ${channels} canonical_thread
        ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent_message
        ON parent_message.id = canonical_thread.parent_message_id
     WHERE thread_projection.server_id = ${job.serverId}
       AND parent_message.channel_id = ${canonicalChannelId}
     LIMIT 1
  `);
  if (leftoverThread.rows.length > 0) throw new Error("source thread projection still has local messages");

  await advance(tx, job.id, "finalize", {
    progress: { ...job.progress, verifiedAt: new Date().toISOString() },
  });
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}

async function finalize(tx: DatabaseExecutor, job: ChannelConversionJob, span?: { addEvent(name: string, attrs?: TraceAttributes): void }) {
  const [updated] = await tx
    .update(channels)
    .set({ type: "joint", archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
    .where(eq(channels.id, job.sourceChannelId))
    .returning({ id: channels.id, serverId: channels.serverId });
  if (!updated) throw new Error("source channel missing during finalize");
  if (updated.serverId !== job.serverId) throw new Error("source channel server mismatch during finalize");

  await tx
    .update(channelConversionJobs)
    .set({
      phase: "done",
      status: "done",
      completedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
      progress: { ...job.progress, finalizedAt: new Date().toISOString() },
    })
    .where(eq(channelConversionJobs.id, job.id));
  span?.addEvent("server.channel_conversion.phase.finished", conversionTraceAttrs(job, { outcome: "ok" }));
}

async function requireCanonicalChannelId(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<string> {
  if (job.canonicalChannelId) return job.canonicalChannelId;
  const [fresh] = await tx
    .select({ canonicalChannelId: channelConversionJobs.canonicalChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, job.id))
    .limit(1);
  if (!fresh?.canonicalChannelId) throw new Error("conversion canonical channel missing");
  return fresh.canonicalChannelId;
}

async function requireStorageNamespaceId(tx: DatabaseExecutor, canonicalChannelId: string): Promise<string> {
  const [canonical] = await tx
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, canonicalChannelId))
    .limit(1);
  if (!canonical) throw new Error("canonical channel missing");
  return canonical.serverId;
}

async function advance(
  tx: DatabaseExecutor,
  jobId: string,
  phase: ChannelConversionPhase,
  updates: Partial<Pick<ChannelConversionJob, "canonicalChannelId" | "jointChannelId" | "progress">> = {},
) {
  await tx
    .update(channelConversionJobs)
    .set({
      ...updates,
      phase,
      status: phase === "done" ? "done" : "running",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(channelConversionJobs.id, jobId));
}

async function markJobFailed(jobId: string, error: string, cause?: unknown) {
  const db = getDb();
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(channelConversionJobs)
      .where(eq(channelConversionJobs.id, jobId))
      .limit(1);
    if (!job) return;
    const failedAt = new Date();
    const shouldUnlockSource = shouldUnlockSourceOnFailure(job);
    if (shouldUnlockSource) {
      await tx
        .update(channels)
        .set({ archivedAt: null, archivedByUserId: null, archivedByAgentId: null })
        .where(and(
          eq(channels.id, job.sourceChannelId),
          eq(channels.type, job.sourceChannelType),
        ));
    }
    await tx
      .update(channelConversionJobs)
      .set({
        status: "failed",
        error,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: failedAt,
        progress: {
          ...normalizeProgress(job.progress),
          failedAt: failedAt.toISOString(),
          ...(shouldUnlockSource ? { unlockedAt: failedAt.toISOString() } : { awaitingRetryAt: failedAt.toISOString() }),
          retryState: shouldUnlockSource ? "failed_unlocked" : "awaiting_retry",
          sourceLock: shouldUnlockSource ? "released" : "retained",
          errorClass: classifyConversionErrorClass(cause),
        },
      })
      .where(eq(channelConversionJobs.id, jobId));
  });
}

function shouldUnlockSourceOnFailure(job: ChannelConversionJob): boolean {
  const progress = normalizeProgress(job.progress);
  if (typeof progress.movedParentMessages === "number") return false;
  if (typeof progress.movedParentAttachments === "number") return false;
  if (typeof progress.taskRowsAffected === "number" && progress.taskRowsAffected > 0) return false;
  if (typeof progress.threadTaskRowsAffected === "number" && progress.threadTaskRowsAffected > 0) return false;
  return job.phase === "prepare" || job.phase === "drop_task_identity" || job.phase === "move_parent_messages";
}

function normalizeProgress(progress: unknown): Record<string, unknown> {
  return progress && typeof progress === "object" && !Array.isArray(progress)
    ? progress as Record<string, unknown>
    : {};
}

function classifyConversionTraceOutcome(error: unknown): ChannelConversionTraceOutcome {
  if (isLikelyTimeout(error)) return "timeout";
  return "failed";
}

function classifyConversionErrorClass(error: unknown): string {
  if (isLikelyTimeout(error)) return "TimeoutError";
  return error instanceof Error ? error.name : typeof error;
}

function isLikelyTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|statement timeout|canceling statement due to statement timeout/i.test(error.message);
}

function conversionTraceAttrs(
  job: Pick<ChannelConversionJob, "id" | "sourceChannelId" | "phase">,
  opts: {
    outcome: ChannelConversionTraceOutcome;
    errorClass?: string;
    rowsCopied?: number;
    batchIndex?: number;
    taskConversionPolicy?: ChannelConversionTaskIdentityDropPolicy;
    taskRowsAffected?: number;
    threadTaskRowsAffected?: number;
    acknowledged?: boolean;
  },
): TraceAttributes {
  return {
    event_kind: "channel_conversion",
    job_id: job.id,
    channel_id: job.sourceChannelId,
    phase: job.phase,
    outcome: opts.outcome,
    ...(opts.errorClass ? { error_class: opts.errorClass } : {}),
    ...(typeof opts.rowsCopied === "number" ? { rows_copied: opts.rowsCopied } : {}),
    ...(typeof opts.batchIndex === "number" ? { batch_index: opts.batchIndex } : {}),
    ...(opts.taskConversionPolicy ? { task_conversion_policy: opts.taskConversionPolicy } : {}),
    ...(typeof opts.taskRowsAffected === "number" ? { task_rows_affected: opts.taskRowsAffected } : {}),
    ...(typeof opts.threadTaskRowsAffected === "number" ? { thread_task_rows_affected: opts.threadTaskRowsAffected } : {}),
    ...(typeof opts.acknowledged === "boolean" ? { acknowledged: opts.acknowledged } : {}),
  };
}

export async function getJointShapeForLocalChannel(channelId: string) {
  const db = getDb();
  const canonicalThread = alias(channels, "shape_canonical_thread");
  const localThread = alias(channels, "shape_local_thread");
  const parentMessage = alias(messages, "shape_parent_message");

  const [parent] = await db
    .select({
      localChannelId: jointChannelServers.localChannelId,
      serverId: jointChannelServers.serverId,
      role: jointChannelServers.role,
      jointChannelId: jointChannelServers.jointChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(eq(jointChannelServers.localChannelId, channelId), eq(jointChannelServers.status, "active")))
    .limit(1);
  if (!parent) return null;

  const threadRows = await db
    .select({
      localThreadId: jointChannelServers.localChannelId,
      canonicalThreadId: jointChannels.canonicalChannelId,
      parentMessageId: canonicalThread.parentMessageId,
      parentContent: parentMessage.content,
      localParentMessageId: localThread.parentMessageId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .innerJoin(localThread, eq(localThread.id, jointChannelServers.localChannelId))
    .innerJoin(canonicalThread, eq(canonicalThread.id, jointChannels.canonicalChannelId))
    .innerJoin(parentMessage, eq(parentMessage.id, canonicalThread.parentMessageId))
    .where(and(
      eq(jointChannelServers.serverId, parent.serverId),
      eq(localThread.type, "thread"),
      eq(canonicalThread.type, "thread"),
      eq(parentMessage.channelId, parent.canonicalChannelId),
    ));

  const memberRows = await db
    .select({ userId: channelHumans.userId })
    .from(channelHumans)
    .where(eq(channelHumans.channelId, parent.localChannelId));
  const agentRows = await db
    .select({ agentId: channelAgents.agentId })
    .from(channelAgents)
    .where(eq(channelAgents.channelId, parent.localChannelId));

  const parentMessages = await db
    .select({ content: messages.content, threadId: messages.threadId, senderType: messages.senderType })
    .from(messages)
    .where(eq(messages.channelId, parent.canonicalChannelId));

  return {
    parent,
    threadRows,
    memberUserIds: memberRows.map((row) => row.userId).sort(),
    memberAgentIds: agentRows.map((row) => row.agentId).sort(),
    parentMessages,
  };
}
