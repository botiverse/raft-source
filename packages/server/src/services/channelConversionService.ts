import { isAgentLoungeChannel } from "./agentLoungeService";
import { assertJointAdmission } from "./jointChannelLimitService";
import { boundGuestsBlockJoint } from "./externalInviteService";
import { countChannelParties, EXTERNAL_CHANNEL_MAX_SLOTS } from "./externalChannelLimitService";
import { announceJointInvitesForJoints } from "./listChangedRealtime";
import { currentDate, isActiveChannelConversionJob, noopTracer, projectConversionState, type ChannelConversionCommandView, type ChannelConversionJobView, type ChannelConversionState, type TraceContext, type Tracer } from "@botiverse/raft-shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor, type DatabaseTransaction } from "../db/index";
import {
  attestedSendPendingDrafts,
  channelAgents,
  channelConversionCommands,
  channelConversionFences,
  channelConversionJobs,
  channelHumans,
  channels,
  externalChannelBindings,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  servers,
  shareArtifacts,
  tasks,
  workflowInstances
} from "../db/schema";
import {
  freezeActionCardsForConversion,
  isActionCardConversionMutationForTest,
  unfreezeActionCardsAfterCancellation
} from "./actionCardConversionService";
import { applyChannelConversionAudienceRealtimeCutover, audienceCutover, finalize, getChannelConversionAudienceCutover, residualCleanup } from "./channelConversionAudience";
import {
  parseConversionProgress,
  type ConversionProgress
} from "./channelConversionContracts";
import {
  acquireChannelConversionFence,
  getActiveChannelConversionFence,
  recordConversionPhaseCommit,
  probeChannelConversionResourceLockFree,
  releaseChannelConversionFence,
  withChannelConversionResourceBoundedLock,
  withChannelConversionResourceTryLock
} from "./channelConversionFenceService";
import { ChannelConversionBusyError, ChannelConversionError, conversionTraceAttrs, stableStringify, stateForLegacyPhase, type ChannelConversionJob, type ChannelConversionPhase } from "./channelConversionPhaseContext";
import { assertNoActiveAttachmentTransfers, carryTaskNumberHighWater, ChannelConversionUploadsInFlightError, moveParentMessages, moveThreadMessages, prepare, prepareExternalBindingsForChannelConversion, OnlineMoveStartBudget, OnlineMoveStartBudgetExceededError, prepareOnlineMove, prepareTasks, prepareThreads, verify } from "./channelConversionPreparation";
import { CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import { restoreConversionResources } from "./channelConversionResources";
import { lockJointUsersFirst } from "./jointHumanMembershipMirror";
import { addTraceEvent, errorClassOf } from "../tracing/semanticTrace";
export { applyChannelConversionAudienceRealtimeCutover, getChannelConversionAudienceCutover, replayResidualCleanupForTest, setAudienceCleanupMutationForTest, type ChannelConversionAudienceCutover } from "./channelConversionAudience";
export { ChannelConversionBusyError, ChannelConversionError } from "./channelConversionPhaseContext";
export { assertNoActiveAttachmentTransfersBeforeAdmission, ChannelConversionUploadsInFlightError } from "./channelConversionPreparation";
export { CHANNEL_CONVERSION_BATCH_SIZE } from "./channelConversionResources";

export type { ChannelConversionPhase } from "./channelConversionPhaseContext";
export type ChannelConversionPrivacyRevalidator = (input: {
  serverId: string;
  channelId: string;
  now: Date;
}) => Promise<readonly { kind: string; reason?: string }[]>;
type ChannelConversionReceipt = ChannelConversionJob & { canCancel: boolean };
type ChannelConversionTraceOutcome = "ok" | "failed" | "timeout";
export type ChannelConversionPreJobPhase =
  | "source_lookup"
  | "active_job_check"
  | "eligibility_check"
  | "upload_check"
  | "scope_size_check"
  | "source_lock"
  | "job_insert";
type ChannelConversionEligibilitySubcheck = "direct_task" | "thread_task";
export type ChannelConversionPreJobTrace = (event: {
  phase: ChannelConversionPreJobPhase;
  outcome: "started" | "ok" | "failed";
  errorClass?: string;
  eligibilitySubcheck?: ChannelConversionEligibilitySubcheck;
}) => void;

/** A request's bounded wait for the conversion lock ran out: the 409 "in progress" refusal. */
const conversionBusy = (cause: unknown) => new ChannelConversionBusyError({ cause });
const NEXT_PHASE: Record<Exclude<ChannelConversionPhase, "done">, ChannelConversionPhase> = {
  prepare: "prepare_tasks",
  // The online start prepares inline and stays here; its mover and switch come later.
  online_move: "online_move",
  prepare_tasks: "move_parent_messages",
  move_parent_messages: "prepare_threads",
  prepare_threads: "move_thread_messages",
  move_thread_messages: "verify",
  verify: "audience_cutover",
  audience_cutover: "residual_cleanup",
  residual_cleanup: "finalize",
  finalize: "done",
};

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
  canonicalDirectTaskCount: number;
  canonicalThreadTaskCount: number;
  canonicalTaskCount: number;
  shadowOnlyTaskCount: number;
  directTasks: ChannelConversionTaskInventoryItem[];
  threadTasks: ChannelConversionTaskInventoryItem[];
}

export function describeChannelConversionPreJobFailure(phase: ChannelConversionPreJobPhase, error: unknown) {
  const timedOut = isLikelyTimeout(error);
  const phaseCopy: Record<ChannelConversionPreJobPhase, string> = {
    source_lookup: "looking up the source channel",
    active_job_check: "checking for an existing conversion job",
    eligibility_check: "checking whether the channel contains tasks",
    upload_check: "checking whether attachment uploads have finished",
    scope_size_check: "counting the channel's threads and task conversations",
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

/**
 * A Guest is bound to one channel of its server. With the host's
 * external_channels_v1 off a channel with bound Guests can't become joint (the
 * same refusal as connecting a server to it, externalInviteConnectService);
 * with it on (P3) the conversion carries them into the joint channel: its
 * finalize mirrors their membership through the host projection.
 * The route asks first, before admitting a command; start and a retry of a
 * restored job ask again under the conversion resource lock, which a Guest's
 * acceptance takes too (shared, via withChannelWriterFence) before binding.
 */
/**
 * The most threads and task conversations a channel may have and still be
 * converted (slock issue 15637). Each one becomes two conversations in the
 * conversion's scope (its local projection and its canonical copy), and the
 * cutover statements grow with that scope: the 2026-11-19 incident channel
 * (331 threads, 28 task conversations: 720 scope ids) timed out every
 * audience cutover. Tenny's starting number; not measured on staging.
 */
export const CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS = 100;

/**
 * The most messages (any state: a rollback moves every row) the channel and
 * its threads and task conversations may hold and still be converted. A
 * rollback moves each one back, and each move fires two row triggers
 * (message_server_timeline_on_update, messages_follow_parent_channel_id).
 * Derived, not measured: the incident's cancel moved 4,048 messages in 4m23s,
 * about 65 ms a message, so 15 s of statement_timeout fits about 230; 150
 * leaves about a third spare (Ray; Tenny decided, #wg-rbac:#100). That rate
 * is an upper bound (it includes the rest of the rollback). Raise it with
 * PR 3's batched rollback, or a staging measurement.
 */
export const CHANNEL_CONVERSION_MAX_MESSAGES = 150;

export interface ConversionScopeSize {
  /** Threads and task conversations, counted up to one past their limit (0 when the messages alone are over). */
  subconversations: number;
  /** Messages in the source and those conversations, counted up to one past their limit. */
  messages: number;
}

/**
 * The scope's size in bounded index probes, so a quiet channel costs as little
 * as a busy one (no OR / IN-subquery the planner could turn into a scan of
 * messages). First the source's own messages (idx_messages_channel_seq, at
 * most limit + 1 rows); over the limit, nothing else is read. Then its threads
 * through its at most 150 parent messages (idx_channels_parent_message) and its
 * task conversations (idx_channels_task_parent_channel), at most limit + 1
 * together; then each one's messages, one LATERAL probe per id, the total
 * stopping at the message limit + 1.
 */
export async function measureConversionScope(executor: DatabaseExecutor, sourceChannelId: string): Promise<ConversionScopeSize> {
  const messageCap = CHANNEL_CONVERSION_MAX_MESSAGES + 1;
  const own = await executor.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM ${messages} WHERE channel_id = ${sourceChannelId} LIMIT ${messageCap}
    ) bounded`);
  const ownMessages = Number((own.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  if (ownMessages > CHANNEL_CONVERSION_MAX_MESSAGES) return { subconversations: 0, messages: ownMessages };

  const scope = await executor.execute(sql`
    (SELECT thread_channel.id::text AS id
       FROM ${messages} parent_message
       JOIN ${channels} thread_channel
         ON thread_channel.parent_message_id = parent_message.id
        AND thread_channel.type = 'thread'
        AND thread_channel.deleted_at IS NULL
      WHERE parent_message.channel_id = ${sourceChannelId})
    UNION ALL
    (SELECT task_conversation.id::text
       FROM ${channels} task_conversation
      WHERE task_conversation.parent_channel_id = ${sourceChannelId}
        AND task_conversation.type = 'task'
        AND task_conversation.deleted_at IS NULL)
    LIMIT ${CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS + 1}`);
  const scopeIds = (scope.rows as Array<{ id?: unknown }>).flatMap((row) => typeof row.id === "string" ? [row.id] : []);
  if (scopeIds.length > CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS || scopeIds.length === 0) {
    return { subconversations: scopeIds.length, messages: ownMessages };
  }
  const nested = await executor.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1
        FROM unnest(${sql.raw("ARRAY[")}${sql.join(scopeIds.map((id) => sql`${id}::uuid`), sql`, `)}${sql.raw("]")}) AS scope(id)
        CROSS JOIN LATERAL (
          SELECT 1 FROM ${messages} scoped WHERE scoped.channel_id = scope.id LIMIT ${messageCap}
        ) probe
       LIMIT ${messageCap}
    ) bounded`);
  const nestedMessages = Number((nested.rows[0] as { count?: unknown } | undefined)?.count ?? 0);
  return { subconversations: scopeIds.length, messages: Math.min(ownMessages + nestedMessages, messageCap) };
}

/** Refuses, before the source is fenced, a channel too large to convert today. */
export async function assertConversionScopeWithinLimit(executor: DatabaseExecutor, sourceChannelId: string): Promise<void> {
  const size = await measureConversionScope(executor, sourceChannelId);
  const tooMany = size.subconversations > CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS
    ? `more than ${CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS} threads and task conversations`
    : size.messages > CHANNEL_CONVERSION_MAX_MESSAGES
      ? `more than ${CHANNEL_CONVERSION_MAX_MESSAGES} messages`
      : null;
  if (!tooMany) return;
  // Counts only (each capped one past its limit): how many real conversions the limit turns away.
  addTraceEvent("server.channel_conversion.scope_too_large", {
    channel_id: sourceChannelId,
    limit_hit: size.subconversations > CHANNEL_CONVERSION_MAX_SUBCONVERSATIONS ? "subconversations" : "messages",
    subconversations: size.subconversations,
    messages: size.messages,
    outcome: "refused",
  });
  throw new ChannelConversionError(
    `This channel has ${tooMany}, which is more than can be moved to a shared channel right now. Nothing was changed. Start a new shared channel instead.`,
    "channel_conversion_too_large",
  );
}

export async function assertNoBoundGuests(executor: DatabaseExecutor, channel: { id: string; serverId: string }): Promise<void> {
  if (await boundGuestsBlockJoint(executor, channel)) {
    throw new ChannelConversionError("This channel has guests, so it can't become a joint channel yet.", "guests_present");
  }
  // P3 (Tenny, PR #13205): the Guests it carries count toward the joint's one
  // party cap (countChannelParties: the host and its Guests) together with the
  // server it is converted to share with. A conversion never makes a joint
  // channel that is over the cap from the start.
  if (await countChannelParties(executor, { ...channel, type: "private" }) + 1 > EXTERNAL_CHANNEL_MAX_SLOTS) {
    throw new ChannelConversionError(
      `This channel has too many guests to be shared with another server: a shared channel holds at most ${EXTERNAL_CHANNEL_MAX_SLOTS} parties, servers and guests together.`,
      "joint_party_limit",
    );
  }
}

export async function startChannelToJointConversion(input: {
  serverId: string;
  sourceChannelId: string;
  createdByUserId: string;
  tracePreJobPhase?: ChannelConversionPreJobTrace;
  transaction?: DatabaseTransaction;
  revalidateExternalPrivacy?: ChannelConversionPrivacyRevalidator;
  /**
   * Always today's fenced conversion, whatever channel_conversion_online_move_v1
   * says: a caller that needs the conversion to run to its end through the
   * worker (an external invite's connection) until the online move's mover
   * and switch exist.
   */
  fencedOnly?: true;
}): Promise<ChannelConversionReceipt> {
  await revalidateExternalPrivacyBeforeConversion(input.revalidateExternalPrivacy, input.serverId, input.sourceChannelId);
  // Decided before any lock: a flag read must not hold the conversion lock.
  const onlineMove = !input.fencedOnly && await isChannelConversionOnlineMoveEnabled(input.serverId);
  return withChannelConversionResourceBoundedLock(input.serverId, input.sourceChannelId, conversionBusy, async (tx) => {
    if (!onlineMove) return startConversionInTransaction(tx, input);
    // The online start holds the conversion lock exclusively (writers queue
    // on it) and then row locks writers wait on: bound every lock wait, every
    // statement and the transaction as a whole (OnlineMoveStartBudget), so it
    // gives up, and rolls back, instead of stalling them.
    const restoreTimeouts = await setOnlineMoveStartTimeouts(tx);
    const budget = new OnlineMoveStartBudget(
      tx, CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS, CHANNEL_CONVERSION_ONLINE_START_STATEMENT_TIMEOUT_MS, CHANNEL_CONVERSION_ONLINE_START_LOCK_TIMEOUT_MS,
    );
    let failed = false;
    try {
      return await startConversionInTransaction(tx, input, { onlineMove: budget });
    } catch (error) {
      failed = true;
      if (isOnlineMoveStartAbort(error)) {
        addTraceEvent("server.channel_conversion.online_move.start_aborted", {
          channel_id: input.sourceChannelId,
          error_class: error instanceof OnlineMoveStartBudgetExceededError ? "OnlineMoveStartBudgetExceeded" : classifyConversionErrorClass(error),
          outcome: "timeout",
        });
        throw new ChannelConversionError(
          "The channel is busy right now, so the move could not start. Nothing was changed. Try again in a moment.",
          "channel_conversion_online_start_busy",
        );
      }
      throw error;
    } finally {
      // A failure aborted the transaction (or the caller's savepoint): its
      // rollback reverts these transaction-local settings, and no statement
      // can run in it before then. Restore them only on the way out of a success.
      if (!failed) await restoreTimeouts();
    }
  }, input.transaction);
}

/**
 * The online start's limits (channel_conversion_online_move_v1): a lock wait
 * longer than CHANNEL_CONVERSION_ONLINE_START_LOCK_TIMEOUT_MS (a writer or a
 * reader holding the source row or one of its threads), a statement longer
 * than CHANNEL_CONVERSION_ONLINE_START_STATEMENT_TIMEOUT_MS, a deadlock, or
 * the whole transaction going past CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS
 * (checked between steps, each step capped at what is left) aborts the start:
 * its transaction rolls back and nothing changes. At the size limits the
 * start takes about 0.25 s (channelConversionOnlineMoveTiming.realPg.test.ts).
 */
export const CHANNEL_CONVERSION_ONLINE_START_LOCK_TIMEOUT_MS = 2_000;
export const CHANNEL_CONVERSION_ONLINE_START_STATEMENT_TIMEOUT_MS = 10_000;
export const CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS = 5_000;

async function setOnlineMoveStartTimeouts(tx: DatabaseExecutor): Promise<() => Promise<void>> {
  const previous = await tx.execute(sql`
    SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout`);
  const row = previous.rows[0] as { lock_timeout?: unknown; statement_timeout?: unknown } | undefined;
  await tx.execute(sql`SELECT set_config('lock_timeout', ${`${CHANNEL_CONVERSION_ONLINE_START_LOCK_TIMEOUT_MS}ms`}, true),
    set_config('statement_timeout', ${`${Math.min(CHANNEL_CONVERSION_ONLINE_START_STATEMENT_TIMEOUT_MS, CHANNEL_CONVERSION_ONLINE_START_BUDGET_MS)}ms`}, true)`);
  return async () => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${typeof row?.lock_timeout === "string" ? row.lock_timeout : "0"}, true),
      set_config('statement_timeout', ${typeof row?.statement_timeout === "string" ? row.statement_timeout : "0"}, true)`);
  };
}

/** The SQLSTATEs a transaction that gave up waiting ends with: lock_not_available (55P03, lock_timeout), deadlock_detected (40P01). */
function isLockWaitAbort(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === "55P03" || code === "40P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** A lock wait given up, a deadlock, a statement over its time (57014), or the start's whole budget spent. */
function isOnlineMoveStartAbort(error: unknown): boolean {
  if (error instanceof OnlineMoveStartBudgetExceededError || isLockWaitAbort(error)) return true;
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** channel_conversion_online_move_v1, server-scoped; a failed read is off. */
async function isChannelConversionOnlineMoveEnabled(serverId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, serverId })).enabled === true;
  } catch (error) {
    console.warn("[ChannelConversion] online move flag read failed; starting a fenced conversion", { serverId, errorClass: errorClassOf(error) });
    return false;
  }
}

/** The start's work in its transaction, which holds the conversion lock: fenced (today's), or online. */
async function startConversionInTransaction(
  tx: DatabaseTransaction,
  input: Parameters<typeof startChannelToJointConversion>[0],
  options: { onlineMove?: OnlineMoveStartBudget } = {},
): Promise<ChannelConversionReceipt> {
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
  if (await isAgentLoungeChannel(source.id, tx)) {
    throw new ChannelConversionError("An agent's lounge cannot be converted", "reserved_channel");
  }
  // Contract v0.3 §18.7: conversion is one of the four admission points.
  // It only ever adds the host, so it cannot break a limit today; calling
  // the shared check keeps the four entry points from drifting apart.
  await assertJointAdmission(tx, null, { kind: "convert", hostServerId: input.serverId }, currentDate());

  const [activeJob] = await tracePreJobPhase(input, "active_job_check", () => tx
    .select()
    .from(channelConversionJobs)
    .where(and(
      eq(channelConversionJobs.sourceChannelId, source.id),
      inArray(channelConversionJobs.status, ["pending", "running", "failed"]),
    ))
    .limit(1));
  // The active job and its epoch are the durable source-of-truth. A duplicate
  // start never creates a second fence or silently advances a phase.
  if (activeJob) {
    // A compensated failure has deliberately released its source fence and
    // restored the ordinary channel. Keep the receipt as the durable retry
    // record; the command executor will mint a fresh epoch when the caller
    // explicitly starts/retries it. Treating this row as an active fenced
    // job would make a restored source permanently fail closed.
    if (activeJob.status === "failed" && normalizeProgress(activeJob.progress).rollbackState === "restored") {
      return projectConversionJob(activeJob);
    }
    // An online move holds no fence by design: writers are admitted.
    if (activeJob.phase === "online_move") return projectConversionJob(activeJob);
    const activeFence = await tx
      .select({ status: channelConversionFences.status })
      .from(channelConversionFences)
      .where(and(
        eq(channelConversionFences.sourceChannelId, source.id),
        eq(channelConversionFences.status, "active"),
      ))
      .limit(1);
    if (activeFence.length === 0) {
      throw new ChannelConversionError(
        "Active conversion job is missing its source fence; retry or repair is required",
        "channel_conversion_fence_missing",
      );
    }
    return projectConversionJob(activeJob);
  }
  const taskInventory = await tracePreJobPhase(input, "eligibility_check", async () => {
    return collectTaskInventory(tx, source.id, input);
  });
  const now = currentDate();
  const externalBindingsPaused = await tracePreJobPhase(input, "source_lock", async () => {
    // Match external outbound admission's conversation-first lock order.
    // The conversion fence owns write admission; archive remains lifecycle state.
    const [lockedSource] = await tx.select().from(channels).where(and(
      eq(channels.id, source.id), eq(channels.serverId, source.serverId), isNull(channels.deletedAt),
    )).for("update").limit(1);
    if (!lockedSource || (lockedSource.type !== "channel" && lockedSource.type !== "private")) {
      throw new ChannelConversionError("Channel changed before conversion could reserve it", "channel_conversion_source_changed");
    }
    await assertNoBoundGuests(tx, lockedSource);
    return prepareExternalBindingsForChannelConversion(tx, lockedSource.serverId, lockedSource.id, false);
  });
  // Before anything is fenced or frozen (the source row lock keeps new
  // threads out; the binding pause above rolls back with this refusal).
  await tracePreJobPhase(input, "scope_size_check", () => assertConversionScopeWithinLimit(tx, source.id));
  // Uploads are a start precondition. Keep the prepare-phase assertion too:
  // the source lock prevents new writers after this point, but a transfer
  // already committed before the lock must still be rechecked by the worker.
  await tracePreJobPhase(input, "upload_check", () => assertNoActiveAttachmentTransfers(tx, {
    serverId: input.serverId,
    sourceChannelId: source.id,
  }));
  // Online move: the start rewrites every thread and task conversation of
  // the source (parent_message_id, joint rows), and writers are admitted
  // right after it commits. Lock them now, after the source row, in id
  // order, FOR NO KEY UPDATE (see lockOnlineMoveSubConversations).
  if (options.onlineMove) await options.onlineMove.step("lock_subconversations", () => lockOnlineMoveSubConversations(tx, source.id));

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
        version: 1, ledgerVersion: 2, resources: {},
        lockedAt: now.toISOString(),
        sourceArchiveSnapshot: {
          archivedAt: source.archivedAt?.toISOString() ?? null,
          archivedByUserId: source.archivedByUserId,
          archivedByAgentId: source.archivedByAgentId,
        },


        taskInventory: {
          directTaskCount: taskInventory.directTaskCount,
          threadTaskCount: taskInventory.threadTaskCount,
          totalCount: taskInventory.totalCount,
          canonicalDirectTaskCount: taskInventory.canonicalDirectTaskCount,
          canonicalThreadTaskCount: taskInventory.canonicalThreadTaskCount,
          canonicalTaskCount: taskInventory.canonicalTaskCount,
          shadowOnlyTaskCount: taskInventory.shadowOnlyTaskCount,
        },
        externalBindingsPaused,
      },
    })
    .returning());
  if (options.onlineMove) {
    await freezeActionCardsForConversion(tx, {
      id: job.id,
      serverId: input.serverId,
      sourceChannelId: source.id,
      conversionEpoch: job.conversionEpoch,
    });
    await recordConversionPhaseCommit(tx, {
      jobId: job.id,
      conversionEpoch: job.conversionEpoch,
      phase: "prepared",
      checksumInput: `${job.id}:${source.id}:prepared`,
    });
    // No fence row: writers are admitted. The route to the canonical
    // channel changes in this transaction, under the source row's FOR UPDATE.
    return projectConversionJob(await prepareOnlineMove(tx, job.id, options.onlineMove));
  }
  const fence = await acquireChannelConversionFence(tx, {
    jobId: job.id,
    serverId: input.serverId,
    sourceChannelId: source.id,
    conversionEpoch: job.conversionEpoch,
  });
  await freezeActionCardsForConversion(tx, {
    id: job.id,
    serverId: input.serverId,
    sourceChannelId: source.id,
    conversionEpoch: fence.conversionEpoch,
  });
  await recordConversionPhaseCommit(tx, {
    jobId: job.id,
    conversionEpoch: job.conversionEpoch,
    phase: "prepared",
    checksumInput: `${job.id}:${source.id}:prepared`,
  });
  await recordConversionPhaseCommit(tx, {
    jobId: job.id,
    conversionEpoch: job.conversionEpoch,
    phase: "fenced",
    checksumInput: `${job.id}:${fence.conversionEpoch}:fenced`,
  });
  const [fencedJob] = await tx
    .update(channelConversionJobs)
    .set({ state: "fenced", updatedAt: now })
    .where(eq(channelConversionJobs.id, job.id))
    .returning();
  return projectConversionJob(fencedJob ?? job);
}

/**
 * The source's live threads and task conversations, in id order: the rows an
 * online start rewrites. Its caller holds the source row FOR UPDATE already.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: the start changes none of their key
 * columns (parent_message_id and parent_channel_id are only in partial unique
 * indexes), and read-state resolution (readMutationSequencer) takes FOR KEY
 * SHARE on a thread or task conversation before its parent channel, the
 * reverse of this. FOR KEY SHARE does not conflict with FOR NO KEY UPDATE, so
 * a mark-read holding a thread and waiting for the source can never wait for
 * the start here (no cycle). Writers are kept out by the conversion lock the
 * start holds exclusively (they take it shared) and a thread's creator by the
 * source row (getOrCreateThread takes it FOR KEY SHARE first). Pinned by
 * channelConversionOnlineMove.realPg.test.ts.
 */
async function lockOnlineMoveSubConversations(tx: DatabaseExecutor, sourceChannelId: string): Promise<void> {
  await tx.execute(sql`
    SELECT sub.id
      FROM ${channels} sub
     WHERE sub.id IN (
       SELECT thread_channel.id
         FROM ${messages} parent_message
         JOIN ${channels} thread_channel
           ON thread_channel.parent_message_id = parent_message.id
          AND thread_channel.type = 'thread'
          AND thread_channel.deleted_at IS NULL
        WHERE parent_message.channel_id = ${sourceChannelId}
       UNION
       SELECT task_conversation.id
         FROM ${channels} task_conversation
        WHERE task_conversation.parent_channel_id = ${sourceChannelId}
          AND task_conversation.type = 'task'
          AND task_conversation.deleted_at IS NULL
     )
     ORDER BY sub.id
     FOR NO KEY UPDATE OF sub`);
}

/**
 * A conversion start's first step, before any lock (it may call Slack). A
 * caller that takes the conversion lock before starting (an external
 * invite's connection, P2a-3) runs it first and starts without a revalidator.
 */
export async function revalidateExternalPrivacyBeforeConversion(
  revalidate: ChannelConversionPrivacyRevalidator | undefined,
  serverId: string,
  channelId: string,
): Promise<void> {
  if (!revalidate) return;
  const receipts = await revalidate({ serverId, channelId, now: currentDate() });
  if (receipts.some((receipt) => receipt.kind === "unavailable")) {
    throw new ChannelConversionError(
      "Slack channel privacy could not be verified before conversion",
      "external_binding_privacy_unavailable",
    );
  }
}

const EXTERNAL_CONVERSION_RECONFIRM_REASON = "channel_conversion_reconfirmation_required";

/**
 * Freezes every live external conversation before Channel history moves into
 * Joint storage. The binding remains anchored to the same permission-facing
 * local channel id; its old epoch is drained, then invalidated so neither
 * inbound nor outbound work can cross the conversion boundary. Provisioning
 * must run a fresh preflight/reconfirmation before the new epoch can resume.
 */
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
  // v2 task identity is authoritative in `tasks`, including message-less
  // rows. Keep the legacy message scan only as an eligibility warning for
  // rows that still carry a frozen shadow; it must never replace a canonical
  // row or become a second task representation.
  const canonicalDirect = await tx
    .select({ id: tasks.id, messageId: tasks.messageId, channelId: tasks.channelId, status: tasks.status, taskNumber: tasks.taskNumber })
    .from(tasks)
    .where(eq(tasks.channelId, sourceChannelId));
  const threadChannels = await tx.execute(sql`
    SELECT thread_channel.id::text AS "threadChannelId", parent_message.id::text AS "parentMessageId"
      FROM ${channels} thread_channel
      JOIN ${messages} parent_message ON parent_message.id = thread_channel.parent_message_id
     WHERE parent_message.channel_id = ${sourceChannelId}
       AND thread_channel.type = 'thread' AND thread_channel.deleted_at IS NULL
  `);
  const threadChannelIds = (threadChannels.rows as Array<{ threadChannelId: string }>).map((row) => row.threadChannelId);
  const canonicalThread = threadChannelIds.length === 0
    ? []
    : await tx
      .select({ id: tasks.id, messageId: tasks.messageId, channelId: tasks.channelId, status: tasks.status, taskNumber: tasks.taskNumber })
      .from(tasks)
      .where(inArray(tasks.channelId, threadChannelIds));

  const canonicalMessageIds = new Set(
    [...canonicalDirect, ...canonicalThread]
      .map((row) => row.messageId)
      .filter((id): id is string => typeof id === "string"),
  );
  const canonicalDirectTasks = canonicalDirect.map((row) => normalizeTaskInventoryRow({
    kind: "direct", messageId: row.messageId ?? row.id, channelId: row.channelId,
    taskStatus: row.status, taskNumber: row.taskNumber,
  }, "direct"));
  const canonicalThreadTasks = canonicalThread.map((row) => normalizeTaskInventoryRow({
    kind: "thread", messageId: row.messageId ?? row.id, channelId: row.channelId,
    taskStatus: row.status, taskNumber: row.taskNumber,
  }, "thread"));
  // Legacy shadows without a Task v2 row are promoted; existing canonical
  // identity remains authoritative and never requires destructive consent.
  const directTasks = directTaskResult.rows
    .map((row) => normalizeTaskInventoryRow(row, "direct"))
    .filter((row) => !canonicalMessageIds.has(row.messageId));
  const threadTasks = threadTaskResult.rows
    .map((row) => normalizeTaskInventoryRow(row, "thread"))
    .filter((row) => !canonicalMessageIds.has(row.messageId));
  const shadowOnlyTaskCount = directTasks.length + threadTasks.length;
  return {
    directTaskCount: directTasks.length,
    threadTaskCount: threadTasks.length,
    totalCount: shadowOnlyTaskCount,
    canonicalDirectTaskCount: canonicalDirectTasks.length,
    canonicalThreadTaskCount: canonicalThreadTasks.length,
    canonicalTaskCount: canonicalDirectTasks.length + canonicalThreadTasks.length,
    shadowOnlyTaskCount,
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

export async function retryChannelConversionJob(jobId: string, transaction?: DatabaseTransaction): Promise<ChannelConversionReceipt> {
  const db = transaction ?? getDb();
  const [routing] = await db
    .select({ serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!routing) throw new ChannelConversionError("Conversion job not found", "job_not_found");

  const job = await withChannelConversionResourceBoundedLock(
    routing.serverId,
    routing.sourceChannelId,
    conversionBusy,
    async (tx) => {
    const [existing] = await tx
      .select()
      .from(channelConversionJobs)
      .where(eq(channelConversionJobs.id, jobId))
      .limit(1);
    if (!existing) return null;
    // Retry is an operation on a failed receipt. A pending/running job is only
    // accepted here when its retained fence is missing, which is the explicit
    // repair path used after a crash between job insert and fence persistence.
    // Never reset a live or terminal job from a stale client retry (or a race
    // with another runner) and accidentally replay an already-committed phase.
    const [activeFence] = await tx
      .select({ status: channelConversionFences.status })
      .from(channelConversionFences)
      .where(and(
        eq(channelConversionFences.jobId, existing.id),
        eq(channelConversionFences.status, "active"),
      ))
      .limit(1);
    if (
      existing.status !== "failed"
      && activeFence
    ) {
      throw new ChannelConversionError(
        "Only a failed conversion can be retried",
        "channel_conversion_retry_not_allowed",
      );
    }
    if (["done", "canceled", "succeeded"].includes(existing.status) || existing.phase === "done" || existing.phase === "online_move") {
      throw new ChannelConversionError(
        "Only a failed conversion can be retried",
        "channel_conversion_retry_not_allowed",
      );
    }
    const existingProgress = normalizeProgress(existing.progress);
    const rolledBack = existing.status === "failed" && existingProgress.rollbackState === "restored";
    const progress: ConversionProgress = rolledBack
      ? parseConversionProgress({
        ledgerVersion: 2,
        ...(existingProgress.sourceArchiveSnapshot ? { sourceArchiveSnapshot: existingProgress.sourceArchiveSnapshot } : {}),
        ...(existingProgress.taskInventory ? { taskInventory: existingProgress.taskInventory } : {}),
        retryState: "running",
      })
      : existingProgress;
    const lockedAt = currentDate();
    const nextEpoch = rolledBack ? randomUUID() : existing.conversionEpoch;
    if (rolledBack) {
      // The restored source took writes (and could take a Guest) since its fence was released.
      await assertNoBoundGuests(tx, { id: existing.sourceChannelId, serverId: existing.serverId });
      // The restored source is unfenced: refuse a scope too large before fencing it again.
      await assertConversionScopeWithinLimit(tx, existing.sourceChannelId);
      await tx.update(channelConversionJobs).set({
        conversionEpoch: nextEpoch,
        canonicalChannelId: null,
        jointChannelId: null,
        phase: "prepare",
      }).where(eq(channelConversionJobs.id, existing.id));
    }
    await acquireChannelConversionFence(tx, {
      jobId: existing.id,
      serverId: existing.serverId,
      sourceChannelId: existing.sourceChannelId,
      conversionEpoch: nextEpoch,
    });
    if (rolledBack) {
      await freezeActionCardsForConversion(tx, {
        id: existing.id,
        serverId: existing.serverId,
        sourceChannelId: existing.sourceChannelId,
        conversionEpoch: nextEpoch,
      });
    }
    if (isActionCardConversionMutationForTest("failed_retry_unfreeze")) {
      await unfreezeActionCardsAfterCancellation(tx, {
        id: existing.id,
        serverId: existing.serverId,
        sourceChannelId: existing.sourceChannelId,
        conversionEpoch: nextEpoch,
      });
    }
    const [updated] = await tx
      .update(channelConversionJobs)
      .set({
        state: rolledBack ? "fenced"
          : isConversionState(progress.previousState)
          ? progress.previousState
          : existing.phase === "prepare" ? "fenced" : "copying",
        status: "pending",
        // Every phase is its own transactional/idempotent retry boundary.
        // Resume the failed phase directly so the receipt's Retry action has
        // precise semantics instead of silently replaying earlier stages.
        phase: rolledBack ? "prepare" : existing.phase,
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: lockedAt,
        progress: { ...progress, relockedAt: lockedAt.toISOString(), retryState: "running", completionBroadcastAt: null },
      })
      .where(eq(channelConversionJobs.id, jobId))
      .returning();
    return updated ?? null;
  }, transaction);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return projectConversionJob(job);
}

export async function runChannelConversionJob(
  jobId: string,
  opts: {
    maxPhases?: number;
    io?: Pick<SocketServer, "in">;
    failBeforePhase?: ChannelConversionPhase;
    tracer?: Tracer | null;
    traceParent?: TraceContext | null;
    /** Each phase this run attempted: the phase, and whether it got the conversion lock (false: busy, it did not run). */
    onPhaseAttempt?: (attempt: ChannelConversionPhaseAttempt) => void;
  } = {},
): Promise<ChannelConversionReceipt> {
  const tracer = opts.tracer ?? noopTracer;
  let remaining = opts.maxPhases ?? Number.POSITIVE_INFINITY;
  while (remaining > 0) {
    const job = await getChannelConversionJob(jobId);
    if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
    if (job.phase === "done" || job.status === "done") return job;
    if (job.status === "failed") return job;
    if (job.status === "canceled") return job;
    // An online move waits for its mover and switch (later steps): no phase runs it.
    if (job.phase === "online_move") return job;
    if (opts.failBeforePhase && job.phase === opts.failBeforePhase) {
      await recordJobFailure(job, `injected failure before ${job.phase}`, new Error("InjectedChannelConversionFailure"));
      return (await getChannelConversionJob(job.id))!;
    }
    const lock = await runOnePhase(job, tracer, opts.traceParent ?? null, opts.failBeforePhase);
    opts.onPhaseAttempt?.({ phase: job.phase, lockAcquired: lock === "acquired" });
    // Busy: another transaction (another replica's phase, a retry or cancel)
    // holds the conversion lock. Nothing ran and nothing was recorded; whoever
    // holds it, or the next worker pass, moves the job on. Stop here instead
    // of asking again: a run with no phase limit (a retry's) would spin.
    if (lock === "busy") break;
    if (opts.io) applyChannelConversionAudienceRealtimeCutover(opts.io, await getChannelConversionAudienceCutover(job.id));
    remaining -= 1;
  }
  const job = await getChannelConversionJob(jobId);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  return job;
}

export type ChannelConversionPhaseAttempt = { phase: ChannelConversionPhase; lockAcquired: boolean };

export async function getChannelConversionJob(jobId: string): Promise<ChannelConversionReceipt | null> {
  const db = getDb();
  const [job] = await db.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
  return job ? projectConversionJob(job) : null;
}

/** Legacy fields keep their existing active-job-only shape. The new read model
 * also carries terminal jobs, so clients never infer cancellation from channel.type. */
export type ConversionCommandView = ChannelConversionCommandView;

export function conversionCommandView(command: typeof channelConversionCommands.$inferSelect): ConversionCommandView {
  return {
    id: command.id, kind: command.kind, status: command.status, jobId: command.jobId,
    error: command.error, createdAt: command.createdAt.toISOString(),
  };
}

export async function attachLatestChannelConversionJobs<T extends { id: string; serverId: string }>(
  rows: T[],
): Promise<Array<T & { conversionJob: ChannelConversionJobView | null; conversionCommand: ConversionCommandView | null; conversionState: ChannelConversionState }>> {
  if (rows.length === 0) return [];
  // Both facts must come from one read snapshot: a command committed between
  // two ordinary reads must not be paired with the pre-command failed job.
  return getDb().transaction(async (db) => {
    const jobs = await db
      .selectDistinctOn([channelConversionJobs.sourceChannelId])
      .from(channelConversionJobs)
      .where(and(
        inArray(channelConversionJobs.serverId, [...new Set(rows.map((row) => row.serverId))]),
        inArray(channelConversionJobs.sourceChannelId, rows.map((row) => row.id)),
      ))
      .orderBy(channelConversionJobs.sourceChannelId, sql`CASE WHEN ${channelConversionJobs.status} IN ('pending', 'running', 'failed') THEN 0 ELSE 1 END`,
        desc(channelConversionJobs.updatedAt), desc(channelConversionJobs.createdAt));
    const bySource = new Map<string, ChannelConversionJobView>();
    for (const job of jobs) {
      if (!bySource.has(job.sourceChannelId)) bySource.set(job.sourceChannelId, conversionJobView(job));
    }
    const commands = await db.selectDistinctOn([channelConversionCommands.sourceChannelId]).from(channelConversionCommands).where(and(
      inArray(channelConversionCommands.sourceChannelId, rows.map(row => row.id)),
      inArray(channelConversionCommands.serverId, [...new Set(rows.map(row => row.serverId))]),
    )).orderBy(channelConversionCommands.sourceChannelId, sql`CASE WHEN ${channelConversionCommands.status} = 'pending' THEN 0 ELSE 1 END`, desc(channelConversionCommands.createdAt));
    const commandsBySource = new Map<string, ConversionCommandView>();
    for (const command of commands) {
      if (!commandsBySource.has(command.sourceChannelId)) commandsBySource.set(command.sourceChannelId, conversionCommandView(command));
    }
    return rows.map((row) => {
      const job = bySource.get(row.id) ?? null;
      const command = commandsBySource.get(row.id) ?? null;
      return {
        ...row,
        conversionJob: isActiveChannelConversionJob(job) ? job : null,
        conversionCommand: command,
        conversionState: projectConversionState(command, job),
      };
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export function canCancelChannelConversion(job: Pick<ChannelConversionJob, "status" | "phase" | "progress" | "canonicalChannelId" | "jointChannelId">): boolean {
  const progress = normalizeProgress(job.progress);
  if (job.status === "failed" && progress.rollbackState === "restored") return true;
  return ["pending", "running", "failed"].includes(job.status)
    && !progress.audienceCutoverAt
    && !["residual_cleanup", "finalize", "done"].includes(job.phase);
}

/**
 * The progress keys a client reads (JointConversionSection, the channel
 * store's conversion state). The stored progress is the runner's working
 * state: it holds the converted audience (every agent and person on the
 * server, for a public channel, personal assistants included), task and upload
 * ids. None of that leaves the server.
 */
const CLIENT_CONVERSION_PROGRESS_KEYS = [
  "canonicalCopyStarted", "uploadCount", "errorCode", "failedAt", "relockedAt", "rollbackState",
] as const;

/** A conversion job as any client receives it: ChannelConversionJobView, with only the progress it reads. */
export function conversionJobView(
  job: Pick<ChannelConversionJob, "id" | "status" | "phase" | "progress" | "error"> & { canCancel?: boolean },
): ChannelConversionJobView {
  const stored = job.progress && typeof job.progress === "object" && !Array.isArray(job.progress)
    ? job.progress as Record<string, unknown>
    : {};
  const progress: Record<string, unknown> = {};
  for (const key of CLIENT_CONVERSION_PROGRESS_KEYS) {
    if (stored[key] !== undefined) progress[key] = stored[key];
  }
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    canCancel: job.canCancel ?? canCancelChannelConversion(job as ChannelConversionJob),
    progress,
    error: job.error,
  };
}

function projectConversionJob(job: ChannelConversionJob): ChannelConversionReceipt {
  return { ...job, canCancel: canCancelChannelConversion(job) };
}

export async function cancelChannelConversionJob(jobId: string, transaction?: DatabaseTransaction): Promise<ChannelConversionReceipt> {
  const db = transaction ?? getDb();
  const [routing] = await db
    .select({ serverId: channelConversionJobs.serverId, sourceChannelId: channelConversionJobs.sourceChannelId })
    .from(channelConversionJobs)
    .where(eq(channelConversionJobs.id, jobId))
    .limit(1);
  if (!routing) throw new ChannelConversionError("Conversion job not found", "job_not_found");

  return withChannelConversionResourceBoundedLock(routing.serverId, routing.sourceChannelId, conversionBusy, (tx) => cancelInTransaction(tx, jobId), transaction)
    .catch((error: unknown) => {
      // An online move's rollback gave up a lock wait (or lost a deadlock
      // check): its transaction rolled back, nothing changed. The same 409
      // "in progress" a busy conversion lock answers; the request can be sent again.
      if (isLockWaitAbort(error)) throw new ChannelConversionBusyError({ cause: error });
      throw error;
    });
}

async function cancelInTransaction(tx: DatabaseTransaction, jobId: string): Promise<ChannelConversionReceipt> {
  const [job] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
  if (!job) throw new ChannelConversionError("Conversion job not found", "job_not_found");
  if (job.status === "canceled") return projectConversionJob(job);
  if (["done", "succeeded"].includes(job.status) || job.phase === "done") {
    throw new ChannelConversionError(
      "This conversion has already reached a terminal state and cannot be canceled",
      "channel_conversion_cancel_not_allowed",
    );
  }
  if (!canCancelChannelConversion(job)) {
    throw new ChannelConversionError(
      "This conversion has already switched channel access; retry it to finish.",
      "channel_conversion_cancel_after_copy",
    );
  }
  await rollbackConversionToSource(tx, job);
  const [canceled] = await tx
    .update(channelConversionJobs)
    .set({
      state: "canceled",
      status: "canceled",
      phase: "done",
      progress: { ...normalizeProgress(job.progress), completionBroadcastAt: null },
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: currentDate(),
    })
    .where(eq(channelConversionJobs.id, job.id))
    .returning();
  return projectConversionJob(canceled);
}

/** How long an online move's cancel waits for the source row (below PostgreSQL's 1 s deadlock_timeout). */
const ONLINE_MOVE_CANCEL_SOURCE_LOCK_TIMEOUT = "500ms";

/** The phases whose transaction writes the source channel's people into the joint (audienceCutover's run ends with the finalize). */
const AUDIENCE_WRITING_PHASES: ReadonlySet<ChannelConversionPhase> = new Set(["audience_cutover", "finalize"]);

/** Everyone in the source channel, sorted. */
async function sourceChannelHumanIds(executor: DatabaseExecutor, sourceChannelId: string): Promise<string[]> {
  const rows = await executor.select({ userId: channelHumans.userId }).from(channelHumans)
    .where(eq(channelHumans.channelId, sourceChannelId)).orderBy(channelHumans.userId);
  return rows.map((row) => row.userId);
}

let rollbackFailureForTest = false;

/** Test seam: make the failure compensation hit a real statement_timeout after its writes. */
export function setConversionRollbackFailureForTest(fail: boolean): void {
  if (process.env.NODE_ENV !== "test") throw new Error("conversion rollback seams are test-only");
  rollbackFailureForTest = fail;
}

let phaseUsersLockObserverForTest: ((jobId: string) => void) | null = null;

/** Test seam: called when a phase's transaction has taken its users rows (audience phases). */
export function setConversionPhaseUsersLockObserverForTest(observer: ((jobId: string) => void) | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("conversion phase observers are test-only");
  phaseUsersLockObserverForTest = observer;
}

/**
 * One phase in one transaction under the conversion lock, taken with a try:
 * "busy" when another transaction holds it (nothing ran, nothing is
 * recorded, no failure). The users rows (KEY SHARE) come first as before; a
 * try never waits, so taking it after them keeps the one lock order
 * (users, conversion, admission, lifecycle, channel/member, flags, J).
 *
 * Before any of that, a standalone probe of the lock (autocommit, holds
 * nothing): held, and the pass is busy without reading the channel's people,
 * locking their users rows or opening a transaction. Every replica's worker
 * asks every 500 ms; only the in-transaction try decides.
 *
 * A phase that fails is rolled back to a savepoint and its failure recorded
 * in the same transaction, still under the lock: no other runner can take the
 * lock between the failure and its record (and run the failing phase again).
 */
async function runOnePhase(job: ChannelConversionJob, tracer: Tracer, traceParent: TraceContext | null, failBeforePhase?: ChannelConversionPhase): Promise<"acquired" | "busy"> {
  if (!await probeChannelConversionResourceLockFree(job.serverId, job.sourceChannelId)) return "busy";
  const phaseSpan = tracer.startSpan("server.channel_conversion.phase", {
    parent: traceParent,
    surface: "server",
    kind: "internal",
    attrs: conversionTraceAttrs(job, { outcome: "ok" }),
  });
  let outcome: ChannelConversionTraceOutcome = "ok";
  let errorClass: string | undefined;
  let attemptedJob = job;
  // The audience cutover and the finalize write the joint membership of
  // everyone in the source channel (joint_channel_members, admissions; no
  // acting person): their users rows first (lockJointUsersFirst; only
  // locked), before the conversion lock and the J lock, as every joint
  // membership writer takes them (an FK check taking one only at the insert
  // closes a cycle with that person's account deletion: users row FOR UPDATE,
  // then the servers they own). Read unlocked: under the published conversion
  // fence nobody joins the source channel (its writers refuse), and the
  // transaction does nothing when it finds one it did not lock (or a phase
  // that writes them it did not expect): the next pass reads them again.
  const audienceUserIds = AUDIENCE_WRITING_PHASES.has(job.phase) ? await sourceChannelHumanIds(getDb(), job.sourceChannelId) : null;
  let lock: "acquired" | "busy" = "acquired";
  let phaseError: { error: unknown } | null = null;
  try {
    await getDb().transaction(async (outer) => {
      if (audienceUserIds) {
        await lockJointUsersFirst(outer, { userIds: audienceUserIds });
        phaseUsersLockObserverForTest?.(job.id);
      }
      const attempt = await withChannelConversionResourceTryLock(job.serverId, job.sourceChannelId, async (lockedTx) => {
        try {
          await lockedTx.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(channelConversionJobs)
              .where(eq(channelConversionJobs.id, job.id))
              .limit(1);
            if (!current || current.status === "done" || current.phase === "done" || current.status === "canceled" || current.status === "failed") return;
            if (AUDIENCE_WRITING_PHASES.has(current.phase)) {
              const locked = new Set(audienceUserIds ?? []);
              if (!audienceUserIds || (await sourceChannelHumanIds(tx, current.sourceChannelId)).some((id) => !locked.has(id))) return;
            }
            attemptedJob = current;
            const fence = await getActiveChannelConversionFence(tx, current.sourceChannelId);
            if (!fence || fence.jobId !== current.id || fence.conversionEpoch !== current.conversionEpoch) {
              throw new ChannelConversionError(
                "Conversion source fence is missing or belongs to another epoch",
                "channel_conversion_fence_mismatch",
              );
            }

            // No lease: the conversion lock is the claim (lease_owner and
            // lease_expires_at are no longer written; nothing ever read them).
            await tx
              .update(channelConversionJobs)
              .set({
                state: current.phase === "prepare" ? "draining" : stateForLegacyPhase(current.phase),
                status: "running",
                error: null,
                updatedAt: currentDate(),
              })
              .where(eq(channelConversionJobs.id, current.id));

            if (current.phase === "prepare") await prepare({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "prepare_tasks") await prepareTasks({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "move_parent_messages") await moveParentMessages({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "prepare_threads") await prepareThreads({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "move_thread_messages") await moveThreadMessages({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "verify") await verify({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "audience_cutover") {
              // Access changes, destructive personal-state cleanup, and success are
              // one commit. Until this transaction commits every copied row can be
              // returned to the source; no newly-created job can stop halfway through
              // an irreversible cutover.
              await audienceCutover({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
              let [next] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, current.id));
              if (failBeforePhase === "residual_cleanup") throw new Error("InjectedChannelConversionFailure");
              do {
                await residualCleanup({ tx, job: next, progress: normalizeProgress(next.progress), span: phaseSpan });
                [next] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, current.id));
              } while (next.phase === "residual_cleanup");
              if (failBeforePhase === "finalize") throw new Error("InjectedChannelConversionFailure");
              await finalize({ tx, job: next, progress: normalizeProgress(next.progress), span: phaseSpan });
            }
            else if (current.phase === "residual_cleanup") await residualCleanup({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
            else if (current.phase === "finalize") await finalize({ tx, job: current, progress: normalizeProgress(current.progress), span: phaseSpan });
          });
        } catch (err) {
          // The savepoint rolled the phase back; the conversion lock is still ours.
          phaseError = { error: err };
          // An audience phase holds KEY SHARE on every member's users row
          // (lockJointUsersFirst on `outer`) until this transaction ends, and
          // /api/auth/refresh needs FOR UPDATE on those rows. The compensation
          // rewrites every moved message (row triggers included) and can run
          // for minutes: never run it under those locks. Record the failure
          // with the source fenced; Cancel (no users locks) restores it, Retry
          // resumes the phase.
          await markJobFailed(lockedTx, attemptedJob, err instanceof Error ? err.message : String(err), err, { compensate: !audienceUserIds });
        }
      }, outer);
      if (!attempt.acquired) lock = "busy";
    });
    if (phaseError) {
      const err = (phaseError as { error: unknown }).error;
      outcome = classifyConversionTraceOutcome(err);
      errorClass = classifyConversionErrorClass(err);
      phaseSpan.addEvent("server.channel_conversion.phase.failed", conversionTraceAttrs(job, { outcome, errorClass }));
    }
  } catch (err) {
    // The phase's transaction itself failed (its connection, its commit, or
    // recording the failure in it): record the failure in a new one.
    outcome = classifyConversionTraceOutcome(err);
    errorClass = classifyConversionErrorClass(err);
    phaseSpan.addEvent("server.channel_conversion.phase.failed", conversionTraceAttrs(job, { outcome, errorClass }));
    const recorded = await recordJobFailure(attemptedJob, err instanceof Error ? err.message : String(err), err);
    if (recorded === "busy") {
      phaseSpan.addEvent("server.channel_conversion.phase.failure_deferred", conversionTraceAttrs(job, { outcome, errorClass }));
    }
  } finally {
    phaseSpan.end(outcome === "ok" ? "ok" : "error", {
      attrs: { ...conversionTraceAttrs(job, { outcome, errorClass }), lock_acquired: lock === "acquired" ? true : "busy" },
    });
  }
  return lock;
}

/** Compensate committed pre-cutover work after a phase failure.  The source
 * fence is held for the whole operation, so no writer can observe a half
 * restored projection.  This deliberately stops before audience cleanup,
 * whose deleted personal state cannot be reconstructed from the conversion
 * tables alone. */
async function rollbackConversionToSource(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<void> {
  // An online move (channel_conversion_online_move_v1) admits writers and
  // routes the source's new messages to the canonical channel: the route
  // goes back to the source only under the source row's FOR UPDATE (the
  // writers' storage resolution holds it FOR KEY SHARE), and the job leaves
  // online_move in this same transaction. Its threads and task conversations
  // were prepared from the source's own parents, which may not have moved
  // yet: look for them in both channels.
  const onlineMove = normalizeProgress(job.progress).onlineMovePreparedAt !== undefined;
  const ownedProjection = await resolveOwnedConversionProjection(tx, job);
  const canonicalChannelId = ownedProjection?.canonicalChannelId ?? null;
  const jointChannelId = ownedProjection?.jointChannelId ?? null;
  // Drop the job's foreign-key references before deleting the temporary
  // projection. The rollback runs in the same transaction, so this does not
  // expose an unowned intermediate state, and it prevents the FK from making
  // compensation itself fail closed.
  if (canonicalChannelId || jointChannelId) {
    await tx.update(channelConversionJobs).set({ canonicalChannelId: null, jointChannelId: null })
      .where(eq(channelConversionJobs.id, job.id));
  }
  if (!canonicalChannelId) {
    const promotedTaskIds = normalizeProgress(job.progress).promotedTaskIds;
    if (Array.isArray(promotedTaskIds) && promotedTaskIds.length > 0) {
      await tx.delete(tasks).where(inArray(tasks.id, promotedTaskIds.filter((id): id is string => typeof id === "string")));
    }
    await restoreExternalBindings(tx, job);
    await releaseChannelConversionFence(tx, job.id, "failed_rollback");
    await unfreezeActionCardsAfterCancellation(tx, {
      id: job.id, serverId: job.serverId, sourceChannelId: job.sourceChannelId, conversionEpoch: job.conversionEpoch,
    });
    return;
  }

  // Lock everything this rollback deletes or re-keys before changing any of
  // it, in the order read-state resolution takes FOR KEY SHARE on the same
  // rows (readMutationSequencer): per thread in local-thread-id order the
  // projection, joint, storage thread and parent message, then the parent
  // joint, its projections and the canonical channel. Moving a message back
  // rewrites channel_id, a key column, so parents need FOR UPDATE too. A
  // rollback that waits here therefore holds nothing a reader needs next.
  // Rows are locked in ORDER BY order; within one row, PostgreSQL locks the
  // tables in FOR UPDATE OF list order (not FROM order — verified on PG 18),
  // so that list is the per-thread lock order and must stay projection,
  // joint_thread, canonical_thread, parent.
  const threadRows = await tx.execute(sql`
    SELECT projection.local_channel_id::text AS local_id,
           joint_thread.canonical_channel_id::text AS canonical_id,
           canonical_thread.parent_message_id::text AS parent_message_id,
           projection.joint_channel_id::text AS joint_id
      FROM ${jointChannelServers} projection
      JOIN ${jointChannels} joint_thread ON joint_thread.id = projection.joint_channel_id
      JOIN ${channels} canonical_thread ON canonical_thread.id = joint_thread.canonical_channel_id
      JOIN ${messages} parent ON parent.id = canonical_thread.parent_message_id
     WHERE projection.server_id = ${job.serverId}
       AND joint_thread.created_by_server_id = ${job.serverId}
       AND joint_thread.id <> ${jointChannelId ?? "00000000-0000-0000-0000-000000000000"}::uuid
       AND canonical_thread.type = 'thread'
       AND ${onlineMove ? sql`parent.channel_id IN (${canonicalChannelId}, ${job.sourceChannelId})` : sql`parent.channel_id = ${canonicalChannelId}`}
     ORDER BY projection.local_channel_id
     FOR UPDATE OF projection, joint_thread, canonical_thread, parent
  `);
  // Task v2 conversations this job turned into joint ones (prepare_threads),
  // locked the same way after the threads: per conversation in local-id
  // order the projection, joint, canonical conversation and task. The task
  // row is re-keyed back (conversation_channel_id) below.
  const taskConversationRows = await tx.execute(sql`
    SELECT projection.local_channel_id::text AS local_id,
           joint_conversation.canonical_channel_id::text AS canonical_id,
           task.id::text AS task_id,
           projection.joint_channel_id::text AS joint_id
      FROM ${jointChannelServers} projection
      JOIN ${jointChannels} joint_conversation ON joint_conversation.id = projection.joint_channel_id
      JOIN ${channels} canonical_conversation ON canonical_conversation.id = joint_conversation.canonical_channel_id
      JOIN ${tasks} task ON task.id = canonical_conversation.task_id
     WHERE projection.server_id = ${job.serverId}
       AND joint_conversation.created_by_server_id = ${job.serverId}
       AND joint_conversation.id <> ${jointChannelId ?? "00000000-0000-0000-0000-000000000000"}::uuid
       AND canonical_conversation.type = 'task'
       AND ${onlineMove ? sql`task.channel_id IN (${canonicalChannelId}, ${job.sourceChannelId})` : sql`task.channel_id = ${canonicalChannelId}`}
       AND task.conversation_channel_id = canonical_conversation.id
     ORDER BY projection.local_channel_id
     FOR UPDATE OF projection, joint_conversation, canonical_conversation, task
  `);
  if (jointChannelId) {
    await tx.execute(sql`SELECT 1 FROM ${jointChannels} WHERE id = ${jointChannelId}::uuid FOR UPDATE`);
    await tx.execute(sql`
      SELECT 1 FROM ${jointChannelServers} WHERE joint_channel_id = ${jointChannelId}::uuid ORDER BY server_id FOR UPDATE
    `);
  }
  await tx.execute(sql`SELECT 1 FROM ${channels} WHERE id = ${canonicalChannelId}::uuid FOR UPDATE`);
  if (onlineMove) {
    // Last, after every row above, as read-state resolution takes the
    // parent channel last (a thread, then its parent: readMutationSequencer):
    // a mark-read holding a thread's rows and waiting for the source never
    // waits on a row this rollback holds. A whole-scope mark-read
    // (global_read_all) takes root channels first, then threads, so it may
    // hold the source while asking for a row locked above: this wait is
    // bounded below deadlock_timeout, so this rollback is the one that gives
    // up (cancelChannelConversionJob answers busy, nothing changed), never
    // the reader.
    const previous = await tx.execute(sql`SELECT current_setting('lock_timeout') AS lock_timeout`);
    await tx.execute(sql`SELECT set_config('lock_timeout', ${ONLINE_MOVE_CANCEL_SOURCE_LOCK_TIMEOUT}, true)`);
    await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, job.sourceChannelId)).for("update");
    const restore = (previous.rows[0] as { lock_timeout?: unknown } | undefined)?.lock_timeout;
    await tx.execute(sql`SELECT set_config('lock_timeout', ${typeof restore === "string" ? restore : "0"}, true)`);
  }

  for (const row of threadRows.rows as Array<{ local_id: string; canonical_id: string; parent_message_id: string; joint_id: string }>) {
    await moveRowsBackToSource(tx, row.canonical_id, row.local_id);
    await tx.update(messages)
      .set({ threadId: row.local_id })
      .where(and(eq(messages.id, row.parent_message_id), eq(messages.threadId, row.canonical_id)));
    await tx.delete(jointChannelServers).where(eq(jointChannelServers.jointChannelId, row.joint_id));
    await tx.delete(jointChannels).where(eq(jointChannels.id, row.joint_id));
    await tx.delete(channels).where(eq(channels.id, row.canonical_id));
    await tx.update(channels)
      .set({ parentMessageId: row.parent_message_id })
      .where(eq(channels.id, row.local_id));
  }

  for (const row of taskConversationRows.rows as Array<{ local_id: string; canonical_id: string; task_id: string; joint_id: string }>) {
    await moveRowsBackToSource(tx, row.canonical_id, row.local_id);
    // Re-key the task to its original conversation BEFORE the task moves back
    // to the source channel below: the task_conversation_tasks migration trigger then re-derives the
    // parent channel of that row (the canonical row is gone by then).
    await tx.update(tasks)
      .set({ conversationChannelId: row.local_id })
      .where(and(eq(tasks.id, row.task_id), eq(tasks.conversationChannelId, row.canonical_id)));
    await tx.delete(jointChannelServers).where(eq(jointChannelServers.jointChannelId, row.joint_id));
    await tx.delete(jointChannels).where(eq(jointChannels.id, row.joint_id));
    await tx.delete(channels).where(eq(channels.id, row.canonical_id));
    await tx.update(channels)
      .set({ parentChannelId: job.sourceChannelId })
      .where(eq(channels.id, row.local_id));
  }

  await moveRowsBackToSource(tx, canonicalChannelId, job.sourceChannelId);
  // The tasks are back in the source: keep its numbering past any number the
  // canonical channel handed out (RFC 078: never reused).
  await carryTaskNumberHighWater(tx, canonicalChannelId, job.sourceChannelId);
  const promotedTaskIds = normalizeProgress(job.progress).promotedTaskIds;
  if (Array.isArray(promotedTaskIds) && promotedTaskIds.length > 0) {
    await tx.delete(tasks).where(inArray(tasks.id, promotedTaskIds.filter((id): id is string => typeof id === "string")));
  }
  if (jointChannelId) {
    // Its pending invites go with the joint (cascade): off their invitees' lists.
    await announceJointInvitesForJoints(tx, [jointChannelId]);
    await tx.delete(jointChannelServers).where(eq(jointChannelServers.jointChannelId, jointChannelId));
    await tx.delete(jointChannels).where(eq(jointChannels.id, jointChannelId));
  }
  await tx.delete(channels).where(eq(channels.id, canonicalChannelId));

  // Restore bindings paused by this epoch.  The source lock serializes this
  // with binding writers; only our reconfirmation marker is eligible.
  await restoreExternalBindings(tx, job);
  await releaseChannelConversionFence(tx, job.id, "failed_rollback");
  await unfreezeActionCardsAfterCancellation(tx, {
    id: job.id, serverId: job.serverId, sourceChannelId: job.sourceChannelId, conversionEpoch: job.conversionEpoch,
  });
}

/**
 * Find only the projection this conversion is allowed to compensate.  The
 * job's routing columns are mutable retry state, so they are not sufficient
 * authority after an interrupted or corrupted attempt.  The deterministic
 * storage-channel name plus its creating server binds the cleanup to this
 * conversion id and prevents a bad job row from deleting another channel.
 */
async function resolveOwnedConversionProjection(
  tx: DatabaseExecutor,
  job: ChannelConversionJob,
): Promise<{ canonicalChannelId: string; jointChannelId: string } | null> {
  const expectedName = `joint-storage-convert-${job.id.replaceAll("-", "")}`;
  const rows = await tx.execute(sql`
    SELECT canonical.id::text AS canonical_id, joint.id::text AS joint_id
      FROM ${jointChannels} joint
      JOIN ${channels} canonical ON canonical.id = joint.canonical_channel_id
      JOIN ${servers} storage ON storage.id = canonical.server_id
     WHERE joint.created_by_server_id = ${job.serverId}
       AND storage.kind = 'joint_storage'
       AND canonical.name = ${expectedName}
  `);
  const candidates = rows.rows as Array<{ canonical_id?: unknown; joint_id?: unknown }>;
  const unique = new Map<string, string>();
  for (const row of candidates) {
    if (typeof row.canonical_id === "string" && typeof row.joint_id === "string") {
      unique.set(row.canonical_id, row.joint_id);
    }
  }
  if (unique.size > 1) throw new Error("Ambiguous conversion projection ownership");
  if (unique.size === 0) return null;
  const [entry] = unique.entries();
  return entry ? { canonicalChannelId: entry[0], jointChannelId: entry[1] } : null;
}

async function restoreExternalBindings(tx: DatabaseExecutor, job: ChannelConversionJob): Promise<void> {
  await tx.execute(sql`
    UPDATE ${externalChannelBindings}
       SET state = 'active',
           state_reason = NULL,
           binding_epoch = GREATEST(binding_epoch - 1, 0),
           updated_at = now()
     WHERE server_id = ${job.serverId}
       AND channel_id = ${job.sourceChannelId}
       AND state = 'paused'
       AND state_reason = ${EXTERNAL_CONVERSION_RECONFIRM_REASON}
  `);
}

async function moveRowsBackToSource(tx: DatabaseExecutor, fromChannelId: string, sourceChannelId: string): Promise<void> {
  await restoreConversionResources(tx, fromChannelId, sourceChannelId);
  await tx.update(messageMentions).set({ channelId: sourceChannelId }).where(eq(messageMentions.channelId, fromChannelId));
  await tx.update(workflowInstances).set({ channelId: sourceChannelId }).where(eq(workflowInstances.channelId, fromChannelId));
  await tx.update(shareArtifacts).set({ channelId: sourceChannelId }).where(eq(shareArtifacts.channelId, fromChannelId));
  await tx.update(attestedSendPendingDrafts).set({ channelId: sourceChannelId }).where(eq(attestedSendPendingDrafts.channelId, fromChannelId));
}

/**
 * Record a phase's failure (and compensate, before cutover) in a transaction
 * of its own: when the phase's transaction could not record it (lost
 * connection, failed commit), and the injected test failure. Waits for the
 * conversion lock at most CHANNEL_CONVERSION_LOCK_WAIT_TIMEOUT: still held,
 * "busy", and the job is left as it is for the next pass, which runs the
 * phase again (and records its failure then, under the lock it holds)
 * instead of a worker waiting out another transaction's phase.
 */
async function recordJobFailure(expected: ChannelConversionJob, error: string, cause?: unknown): Promise<"done" | "busy"> {
  const jobId = expected.id;
  try {
    await withChannelConversionResourceBoundedLock(expected.serverId, expected.sourceChannelId, conversionBusy, (tx) => markJobFailed(tx, expected, error, cause));
    return "done";
  } catch (lockError) {
    if (!(lockError instanceof ChannelConversionBusyError)) throw lockError;
    console.warn("[ChannelConversion] failure not recorded: the conversion lock is busy; the next pass retries the phase", { jobId, phase: expected.phase });
    addTraceEvent("server.channel_conversion.mark_failed.lock_busy", conversionTraceAttrs(expected, { outcome: "timeout", errorClass: classifyConversionErrorClass(cause) }));
    return "busy";
  }
}

/** In `tx`, which holds the conversion lock (the failed phase's own transaction, or recordJobFailure's). */
async function markJobFailed(tx: DatabaseTransaction, expected: ChannelConversionJob, error: string, cause?: unknown, options: { compensate?: boolean } = {}) {
  const jobId = expected.id;
  const [job] = await tx.select().from(channelConversionJobs).where(eq(channelConversionJobs.id, jobId)).limit(1);
  // Compare with the persisted snapshot *before* the failed transaction.
  // The phase's writes were rolled back (its savepoint, or its transaction).
  // A newer cancel, retry, phase or batch must never receive this old error.
  if (!job || job.status === "done" || job.status === "canceled" || job.status === "failed"
    || job.phase === "done" || job.phase !== expected.phase || job.status !== expected.status
    || job.conversionEpoch !== expected.conversionEpoch || job.leaseOwner !== expected.leaseOwner
    || job.updatedAt.getTime() !== expected.updatedAt.getTime()
    || stableStringify(job.progress) !== stableStringify(expected.progress)) return;
  const failedAt = currentDate();
  const phaseCopy: Record<ChannelConversionPhase, string> = {
    prepare: "preparing the conversion",
    prepare_tasks: "preserving task identity",
    move_parent_messages: "moving channel history",
    prepare_threads: "preparing thread projections",
    move_thread_messages: "moving thread history",
    verify: "verifying copied history",
    audience_cutover: "computing channel access",
    residual_cleanup: "cleaning obsolete personal state",
    finalize: "committing the Joint channel",
    done: "finishing the conversion",
    online_move: "moving channel history",
  };
  const rollbackEligible = options.compensate !== false && canCancelChannelConversion(job);
  const userFacingError = cause instanceof ChannelConversionUploadsInFlightError
    ? cause.message
    : cause instanceof ChannelConversionError
      ? error
    : null;
  // Database/transport diagnostics belong to server logs, never the receipt.
  console.error("[ChannelConversion] phase failed", { jobId, phase: job.phase, cause });
  // Failures before audience cutover are compensating failures: restore every
  // committed move and release the source fence so the user can return to the
  // ordinary channel. New jobs commit cutover, cleanup and Done together;
  // only legacy jobs already past cutover need forward recovery.
  // The compensation runs in a savepoint: if it fails too (a large channel's
  // rollback hitting statement_timeout), the failure must still be recorded.
  // Otherwise the whole transaction rolls back, the job stays pending/running
  // and the worker picks it up again forever. Unrestored, the job keeps its
  // source fence and Retry resumes the failed phase.
  let restored = false;
  if (rollbackEligible) {
    try {
      await tx.transaction(async (savepoint) => {
        await rollbackConversionToSource(savepoint, job);
        if (rollbackFailureForTest) await savepoint.execute(sql`SET LOCAL statement_timeout = '1ms'; SELECT pg_sleep(0.05)`);
      });
      restored = true;
    } catch (rollbackError) {
      console.error("[ChannelConversion] rollback failed; recording the failure with the source fence retained", { jobId, phase: job.phase, rollbackError });
    }
  }
  if (isActionCardConversionMutationForTest("failed_retry_unfreeze")) {
    await unfreezeActionCardsAfterCancellation(tx, {
      id: job.id,
      serverId: job.serverId,
      sourceChannelId: job.sourceChannelId,
      conversionEpoch: job.conversionEpoch,
    });
  }
  const failureMessage = userFacingError
    ?? `Channel conversion failed while ${phaseCopy[job.phase] ?? "running a conversion phase"}. ${restored ? "The original channel has been restored. You can use it or retry conversion." : "Retry to finish the conversion, or cancel it to restore the original channel."}`;
  await tx
    .update(channelConversionJobs)
    .set({
      state: "retry_waiting",
      status: "failed",
      error: failureMessage,
      // A compensated failure deletes its temporary projection. Clear the
      // routing references in the receipt as part of the same transition so
      // the persisted job cannot point at a channel that no longer exists.
      ...(restored ? { canonicalChannelId: null, jointChannelId: null } : {}),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: failedAt,
      progress: {
        ...normalizeProgress(job.progress),
        failedAt: failedAt.toISOString(),
        awaitingRetryAt: failedAt.toISOString(),
        previousState: job.state,
        retryState: "awaiting_retry",
        sourceLock: restored ? "released" : "retained",
        ...(restored ? { rollbackState: "restored", rollbackAt: failedAt.toISOString() } : {}),
        errorClass: classifyConversionErrorClass(cause),
        errorPhase: job.phase,
        ...(cause instanceof ChannelConversionError ? { errorCode: cause.code } : {}),
        ...(cause instanceof ChannelConversionUploadsInFlightError
          ? { uploadScope: cause.uploadScope, uploadCount: cause.uploadCount }
          : {}),
      },
    })
    .where(eq(channelConversionJobs.id, jobId));
}

function normalizeProgress(progress: unknown): ConversionProgress {
  return parseConversionProgress(progress);
}

function isConversionState(value: unknown): value is ChannelConversionJob["state"] {
  return typeof value === "string" && [
    "prepared",
    "fenced",
    "draining",
    "copying",
    "projections_rebuilt",
    "audience_cutover",
    "residual_cleanup",
    "verifying",
    "succeeded",
    "retry_waiting",
    "failed",
    "canceled",
  ].includes(value);
}

function classifyConversionTraceOutcome(error: unknown): ChannelConversionTraceOutcome {
  if (isLikelyTimeout(error)) return "timeout";
  return "failed";
}

function classifyConversionErrorClass(error: unknown): string {
  if (isLikelyTimeout(error)) return "TimeoutError";
  return errorClassOf(error);
}

function isLikelyTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed out|statement timeout|canceling statement due to statement timeout/i.test(error.message);
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
