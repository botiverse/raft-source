import { lockJointTaskWriteAuthority, type JointTaskWriteActor } from "./jointTaskWriteAuthority";
import { resolveJointHumanEntrySql, jointHumanConnectedIdentitySql, jointMembershipRemovalPendingSql, acquireJointSourceExitFlagReadLock, jointHumanHasLiveSourceSql, resolveJointSourceExitJointIds, resolveJointGuestEntryJointIds } from "./jointHumanMembershipAccess";
import { conversionReadChannelIdsQuery, conversionReadChannelPredicate } from "./channelConversionReadScope";
import { withChannelWriterFence, assertChannelWritableInTransaction } from "./channelConversionFenceService";
import { recordAssistantOwnerTaskAction } from "./assistantService";
import { randomUUID } from "node:crypto";
import { eq, and, inArray, sql, asc, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import {
  messages,
  users,
  agents,
  channels,
  channelAgents,
  channelHumans,
  serverMembers,
  serverMembershipDepartures,
  tasks,
  taskEvents,
  messageMentions,
  userChannelInboxStates,
  jointChannels,
  jointChannelMembers,
  jointChannelServers,
  notificationOutbox,
} from "../db/schema";
import {
  currentDate,
  failpoints,
  formatAgentTaskRef,
  isSubConversationType,
  type AgentApiTaskClaimConflict,
  type ServerId,
  type TaskResourceReceipt,
  type TaskStatus,
  type TaskReadOnlyReason,
  TASK_ASSIGN_REASON_UNCHANGED_MESSAGE,
  TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU,
  TASK_STATUSES,
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  checkTaskCreateStatus,
  resolveTaskCreateStatus,
  type TaskCreateStatus,
  type TaskCreateStatusRefusal,
} from "@botiverse/raft-shared";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId";
import { buildSearchText } from "./searchTokenizer";
import {
  filterUserAccessibleChannelIds,
  getActiveJointChannelProjectionsByLocalChannel,
  resolveAgentFacingChannelRef,
  type JointChannelProjection,
} from "./channelService";
import { asTaskChannelType, getTaskReadOnlyReason, resolveTaskChannelSurfaces, type TaskChannelSurface, type TaskChannelType } from "./taskChannelSurface";
import { canView, visibleRootChannelIds } from "./visibilityService";
import { loadTaskCurrentProjectionsByTaskId } from "./messageTaskProjection";
import { ensureTaskConversation } from "./taskConversationService";
import { hasTaskSourceMessage, isTaskV2ConversationsEnabled, isTaskV2ConversationsEnabledForRequest, TaskV2NotEnabledError } from "./taskConversationsGate";
import { isV2Task, pendingTaskConversationFollowerSql, TASK_V2_RETIRED_IN_REVIEW_REASON, taskAliasColumns, taskUsesOwnConversation, taskV2StoredStatus } from "./taskV2Mode";

type MessageRow = typeof messages.$inferSelect;

export class TaskMutationConflictError extends Error {
  readonly status = 409;
  readonly code = "task_channel_changed";
  constructor() { super("The task changed while this request was waiting. Refresh and retry."); }
}

async function withTaskWriter<T>(observed: TaskRow, work: (tx: DatabaseExecutor) => Promise<T>, actor?: JointTaskWriteActor): Promise<T> {
  return withChannelWriterFence(observed.channelId, async (tx) => {
    const [current] = await tx.select({ channelId: tasks.channelId }).from(tasks).where(eq(tasks.id, observed.id)).limit(1);
    if (current && current.channelId !== observed.channelId) throw new TaskMutationConflictError();
    if (actor) await lockJointTaskWriteAuthority(tx, observed.channelId, actor);
    return work(tx);
  });
}

async function withTaskChannelWriter<T>(channelId: string, work: (tx: DatabaseExecutor) => Promise<T>, executor?: DatabaseExecutor): Promise<T> {
  if (executor) {
    await assertChannelWritableInTransaction(executor, channelId);
    return work(executor);
  }
  return withChannelWriterFence(channelId, work);
}

/**
 * `tasks.last_activity_at` for a write that is task activity on the Tasks
 * page: the statement's now(). Written by task creation and by status,
 * assignee, title and description changes, in the same statement as the
 * change; a chat message in the task's own conversation writes it through
 * touchTaskConversationActivity. Bookkeeping writes (the conversation link, a
 * resource receipt) leave it. now() is the transaction's start, so tasks
 * created by one createTasks call share it and tie on activity time; the
 * sorted walk breaks the tie by task id, so their order is still total.
 */
const TASK_ACTIVITY_NOW = sql`now()`;

/**
 * The board's activity time: last_activity_at, or for a row last written
 * before that column existed (no backfill) its updated_at. The expression of
 * idx_tasks_channel_activity; the activity sort orders by exactly this.
 */
export const taskActivityAt = sql`COALESCE(${tasks.lastActivityAt}, ${tasks.updatedAt})`;

/**
 * A chat message in a task conversation re-stamps at most once per this
 * interval per task: every stamp is a new tasks row version (the activity
 * index reads the column, so it is never a HOT update), and a busy
 * conversation would otherwise write one per message.
 */
export const TASK_ACTIVITY_MESSAGE_THROTTLE = "1 minute";

/**
 * Stamp `last_activity_at` for a chat message posted in task `taskId`'s own
 * conversation (messageService.broadcastAndDeliver starts it after the
 * message committed and does not wait for it). One statement by primary key:
 *  - skipped while the stamp is younger than TASK_ACTIVITY_MESSAGE_THROTTLE;
 *  - never waits for a lock: the row is taken FOR NO KEY UPDATE SKIP LOCKED,
 *    so while a task write holds it (and stamps it itself when it is
 *    activity) this one writes nothing instead of queueing behind it;
 *  - outside the message's transaction, so the send never holds the task
 *    row's lock either, and a task write that also writes into the
 *    conversation cannot deadlock against it.
 * Resolves true when it stamped.
 */
export async function touchTaskConversationActivity(taskId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const result = await executor.execute(sql`
    UPDATE ${tasks} SET last_activity_at = now()
    WHERE ${tasks.id} = (
      SELECT locked.id FROM ${tasks} AS locked
      WHERE locked.id = ${taskId}::uuid
        AND (locked.last_activity_at IS NULL OR locked.last_activity_at < now() - ${TASK_ACTIVITY_MESSAGE_THROTTLE}::interval)
      FOR NO KEY UPDATE SKIP LOCKED
    )
    RETURNING ${tasks.id}
  `);
  return result.rows.length > 0;
}

function nextClaimedAt(previous: Date | null): Date {
  const now = currentDate();
  if (previous === null || now.getTime() > previous.getTime()) {
    return now;
  }
  return new Date(previous.getTime() + 1);
}

export type TaskCreationAssignee = {
  type: "user" | "agent";
  id: string;
};

export type TaskAssignmentReceiptRequest = {
  /** Exact server-resolved handle, without the leading `@`. */
  assigneeName: string;
};

export type TaskAssignmentReceipt = {
  message: MessageRow;
  content: string;
  assignee: string;
  state: "started" | "assigned";
};

export class TaskCreationAssigneeEligibilityError extends Error {
  readonly code = "assignee_cannot_claim" as const;

  constructor() {
    super("Assignee can no longer claim tasks in this channel");
    this.name = "TaskCreationAssigneeEligibilityError";
  }
}

export class AssignedTaskCreationChannelError extends Error {
  readonly code = "assigned_task_channel_unsupported" as const;

  constructor() {
    super("Assigned task creation is not supported in thread channels");
    this.name = "AssignedTaskCreationChannelError";
  }
}

/**
 * A task-create item named a `sourceMessageId` the task cannot hang under:
 * missing, in another channel, a thread reply, a system message, or an
 * external projection. Mirrors convertMessageToTask.
 */
export class TaskSourceMessageError extends Error {
  readonly code = "invalid_source_message" as const;
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "TaskSourceMessageError";
  }
}

/**
 * A create asked for a status the task can't start in
 * (`checkTaskCreateStatus`). Routes check first and answer 400 before any
 * write; the writers re-check so no caller can skip it.
 */
export class TaskCreateStatusError extends Error {
  readonly status = 400;
  readonly code: TaskCreateStatusRefusal["code"];

  constructor(refusal: TaskCreateStatusRefusal) {
    super(refusal.message);
    this.name = "TaskCreateStatusError";
    this.code = refusal.code;
  }
}

function assertTaskCreateStatus(requested: TaskCreateStatus | undefined, opts: { taskV2?: boolean } = {}): void {
  const refusal = checkTaskCreateStatus(requested, opts);
  if (refusal) throw new TaskCreateStatusError(refusal);
}

/**
 * A status write asked for a status this task can't have: `backlog` on a
 * pre-v2 task where task conversations are off. To the caller it is an invalid
 * status (400), not a refused move (409): the status does not exist here.
 */
export class TaskStatusNotAvailableError extends Error {
  readonly status = 400;
  readonly code = "task_status_not_available" as const;

  constructor(status: string) {
    super(`valid status is required (${TASK_STATUSES.filter((known) => known !== "backlog").join(", ")}): ${status} needs task conversations, which this task does not have`);
    this.name = "TaskStatusNotAvailableError";
  }
}

export type TaskCreateItem = {
  title: string;
  description?: string;
  createsResource?: boolean;
  /** Task v2: the visible chat message this task hangs under (full UUID, same channel). */
  sourceMessageId?: string | null;
};

/**
 * Validate every distinct `sourceMessageId` of a create batch inside the
 * creating transaction (the channel row is already locked by the caller).
 */
async function assertTaskSourceMessages(
  tx: DatabaseExecutor,
  channelId: string,
  channelType: string,
  items: readonly TaskCreateItem[],
): Promise<void> {
  const ids = [...new Set(items.map((item) => item.sourceMessageId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return;
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new TaskSourceMessageError("source message not found");
  }
  // A sub-conversation (a thread, a task's own conversation) carries no tasks.
  if (isSubConversationType(channelType)) throw new TaskSourceMessageError("thread messages cannot carry tasks");
  const rows = await tx
    .select({
      id: messages.id,
      channelId: messages.channelId,
      senderType: messages.senderType,
      messageType: messages.messageType,
    })
    .from(messages)
    .where(inArray(messages.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new TaskSourceMessageError("source message not found");
    if (row.channelId !== channelId) throw new TaskSourceMessageError("source message not in this channel");
    if (row.senderType === "external_projection") {
      throw new TaskSourceMessageError("external projection messages cannot carry tasks");
    }
    if (row.messageType === "system") throw new TaskSourceMessageError("system messages cannot carry tasks");
  }
}

/**
 * Pre-task-v2 host messages (task_v2_conversations_v0 off): one PLAIN, visible
 * channel chat message per task (no task_status) that serves as the task's
 * display line and thread parent; the task fact lives in `tasks`, linked by
 * messageId. Callers broadcast / deliver / record inbox facts for them.
 */
function taskHostMessageValues(
  channelId: string,
  createdByType: "user" | "agent",
  createdById: string,
  items: readonly TaskCreateItem[],
) {
  return items.map((item) => ({
    channelId,
    senderType: createdByType,
    senderId: createdById,
    messageType: "chat" as const,
    content: item.title,
  }));
}

/**
 * Resolve the write-side mode of a create batch and refuse a source message
 * where task v2 conversations are off. The flag is read for the INITIATING
 * server: the server whose local channel the request came through. For a
 * joint channel the storage channel lives on the shared joint storage server,
 * whose flag never says anything about the requester.
 */
async function resolveTaskConversationMode(
  tx: DatabaseExecutor,
  initiatingServerId: string,
  items: readonly TaskCreateItem[],
  initialStatus?: TaskCreateStatus,
): Promise<{ conversations: boolean }> {
  const conversations = await isTaskV2ConversationsEnabled(initiatingServerId, tx);
  // A new task has no row to ask `taskUsesOwnConversation`: this read decides
  // whether it is task v2 (its `own_conversation`), so it decides backlog too.
  assertTaskCreateStatus(initialStatus, { taskV2: conversations });
  if (!conversations && hasTaskSourceMessage(items)) throw new TaskV2NotEnabledError();
  return { conversations };
}

type JointAssignmentRouting = {
  projections: JointChannelProjection[];
  preferredProjection: JointChannelProjection;
};

/**
 * Freeze the active joint projection set and put the assignee's preferred
 * receipt surface first. Inbox-fact dedupe keeps the first local source for a
 * logical receiver, so ordering here makes a dual-server human's receipt point
 * at the initiating surface when possible, otherwise at the surface where the
 * assignee is actually reachable.
 */
async function resolveJointAssignmentRouting(
  tx: DatabaseExecutor,
  storageChannelId: string,
  initiatingLocalChannelId: string,
  assignee: TaskCreationAssignee,
): Promise<JointAssignmentRouting | null> {
  const projections = await getActiveJointChannelProjectionsByLocalChannel(storageChannelId, tx);
  if (projections.length === 0) return null;

  const projectionIds = projections.map((projection) => projection.localChannelId);
  const reachableIds = new Set<string>();
  const [storage] = await tx.select().from(channels).where(eq(channels.id,storageChannelId));
  if (!storage || await lockTaskAssigneeEligibility(tx, storage, assignee)) return null;
  if (assignee.type === "user") {
    const permission = await resolveJointHumanEntrySql({ localChannelIds: projectionIds }, tx);
    const rows = await tx.execute<{ channelId: string }>(sql`SELECT p.local_channel_id AS "channelId"
      FROM joint_channel_servers p WHERE p.local_channel_id IN (${sql.join(projectionIds.map(id => sql`${id}::uuid`),sql`, `)})
        AND ${permission(sql`p.local_channel_id`,sql`${assignee.id}::uuid`)}`);
    rows.rows.forEach(row => reachableIds.add(row.channelId));
  } else {
    const rows = await tx.select({ channelId: channelAgents.channelId, serverId: agents.serverId })
      .from(channelAgents).innerJoin(agents,and(eq(agents.id,channelAgents.agentId),isNull(agents.deletedAt)))
      .where(and(inArray(channelAgents.channelId,projectionIds),eq(channelAgents.agentId,assignee.id)));
    for (const row of rows) if (projections.some(p => p.localChannelId===row.channelId && p.serverId===row.serverId)) reachableIds.add(row.channelId);
  }

  const preferredProjection = projections.find((projection) => (
    projection.localChannelId === initiatingLocalChannelId
    && reachableIds.has(projection.localChannelId)
  )) ?? projections.find((projection) => reachableIds.has(projection.localChannelId));
  if (!preferredProjection) return null;

  return {
    preferredProjection,
    projections: [
      preferredProjection,
      ...projections.filter((projection) => projection.localChannelId !== preferredProjection.localChannelId),
    ],
  };
}

/** Statuses a claim moves to in_progress: work waiting to be picked up. */
function isClaimStartableStatus(status: string | null): boolean {
  return status === "todo" || status === "backlog";
}

export function getTaskClaimConflictReason(
  task: Pick<MessageRow, "taskAssigneeType" | "taskAssigneeId" | "taskStatus" | "taskClaimedAt">,
  claimedByType: "user" | "agent",
  claimedById: string,
): string | null {
  if (task.taskStatus === "closed") return "task is closed; reopen it before claiming";
  if (task.taskAssigneeId) {
    const assignedToRequester = task.taskAssigneeType === claimedByType
      && task.taskAssigneeId === claimedById;
    // Assignment and work-start are distinct. An owner/admin may preassign a
    // todo task to another actor; only that actor may perform the first claim,
    // which atomically starts it and stamps taskClaimedAt. A parked task
    // reserved for them is claimed the same way.
    if (assignedToRequester && isClaimStartableStatus(task.taskStatus) && task.taskClaimedAt === null) return null;
    return assignedToRequester ? TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU : "already assigned";
  }
  if (task.taskStatus === "done") return "task is done";
  return null;
}

async function resolveActorHandle(
  executor: DatabaseExecutor,
  actorType: "user" | "agent" | null,
  actorId: string | null,
): Promise<string | null> {
  if (!actorType || !actorId) return null;
  if (actorType === "user") {
    const [row] = await executor
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, actorId))
      .limit(1);
    return row?.name ?? null;
  }
  const [row] = await executor
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, actorId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * A rejected claim: the prose reason plus, for assignment-held conflicts, the
 * structured effect-boundary projection. Both are built here from the SAME
 * observed task shape — the row the authoritative writer read under its lock —
 * so reason and conflict can never describe two different observations, and a
 * shape the requester was not authorized to resolve never reaches this point.
 */
export interface TaskClaimRejection {
  rejected: true;
  reason: string;
  conflict: AgentApiTaskClaimConflict | null;
}

export function isTaskClaimRejection(value: unknown): value is TaskClaimRejection {
  return typeof value === "object" && value !== null && (value as { rejected?: unknown }).rejected === true;
}

async function describeTaskClaimRejection(
  executor: DatabaseExecutor,
  task: Pick<MessageRow, "taskAssigneeType" | "taskAssigneeId" | "taskStatus" | "taskClaimedAt">,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<TaskClaimRejection | null> {
  const reason = getTaskClaimConflictReason(task, claimedByType, claimedById);
  if (reason === null) return null;
  // Only a task held by a DIFFERENT actor is a claim conflict. Closed/done/
  // self-claim failures carry no effect-boundary projection.
  if (reason !== "already assigned" || !task.taskAssigneeType || !task.taskAssigneeId) {
    return { rejected: true, reason, conflict: null };
  }
  const assigneeName = await resolveActorHandle(executor, task.taskAssigneeType, task.taskAssigneeId);
  return {
    rejected: true,
    reason: assigneeName ? `already assigned to @${assigneeName}` : "already assigned to <unresolved>",
    conflict: {
      kind: "claim_conflict",
      conflictScope: "implementation_execution",
      blockedActions: [...CLAIM_CONFLICT_BLOCKED_ACTIONS],
      unblockedActionExamples: [...CLAIM_CONFLICT_UNBLOCKED_ACTION_EXAMPLES],
      currentAssignee: { type: task.taskAssigneeType, name: assigneeName },
      taskStatus: task.taskStatus ?? null,
      claimedAt: task.taskClaimedAt ? task.taskClaimedAt.toISOString() : null,
      observedAt: new Date().toISOString(),
    },
  };
}

async function formatTaskClaimConflictReason(
  executor: DatabaseExecutor,
  task: Pick<MessageRow, "taskAssigneeType" | "taskAssigneeId" | "taskStatus" | "taskClaimedAt">,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<string | null> {
  return (await describeTaskClaimRejection(executor, task, claimedByType, claimedById))?.reason ?? null;
}

function taskClaimCasPredicate(
  taskId: string,
  expectedStatus: TaskStatus,
  claimedByType: "user" | "agent",
  claimedById: string,
) {
  return and(
    eq(messages.id, taskId),
    eq(messages.taskStatus, expectedStatus),
    sql`${messages.taskStatus} != 'done'`,
    or(
      and(
        isNull(messages.taskAssigneeType),
        isNull(messages.taskAssigneeId),
        isNull(messages.taskClaimedAt),
      ),
      and(
        eq(messages.taskAssigneeType, claimedByType),
        eq(messages.taskAssigneeId, claimedById),
        eq(messages.taskStatus, "todo"),
        isNull(messages.taskClaimedAt),
      ),
    ),
  );
}

export async function getFormattedTaskClaimConflictReason(
  task: Pick<MessageRow, "taskAssigneeType" | "taskAssigneeId" | "taskStatus" | "taskClaimedAt">,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<string | null> {
  return formatTaskClaimConflictReason(getDb(), task, claimedByType, claimedById);
}

/** Shape-agnostic claim pre-check: works on whichever side owns the task. */
export async function getClaimConflictReasonForOwner(
  owner: TaskOwner,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<string | null> {
  return formatTaskClaimConflictReason(getDb(), canonicalClaimShape(owner.row), claimedByType, claimedById);
}

/**
 * Detailed claim pre-check for an owner the caller has ALREADY resolved
 * within the requester's authorized scope (channel-bound resolution happens
 * before this point). Reason and conflict derive from the same read.
 */
export async function getClaimRejectionForOwner(
  owner: TaskOwner,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<TaskClaimRejection | null> {
  return describeTaskClaimRejection(getDb(), canonicalClaimShape(owner.row), claimedByType, claimedById);
}

// The one closed set of effects a claim conflict blocks. Anything not in it
// is not blocked by the conflict — it stays governed by its own
// authority/policy (in particular, request_reassign is a request path, not a
// grant to reassign).
export const CLAIM_CONFLICT_BLOCKED_ACTIONS = ["start_conflicting_execution"];
// Illustrative only; rendering surfaces must present these as examples,
// never as an exhaustive permission table.
export const CLAIM_CONFLICT_UNBLOCKED_ACTION_EXAMPLES = [
  "read",
  "coordinate",
  "review",
  "request_reassign",
  "handoff",
];

// NOTE: there is deliberately NO post-hoc claim-conflict projector here. A
// conflict projection may only be produced by the authoritative claim writer
// (or the channel-bound pre-check) from the very row that caused the failure.
// A global re-read projector both leaked cross-channel task state and could
// describe a different observation than the failure it annotated.

async function lockTaskCreationAssigneeIdentity(
  tx: DatabaseExecutor,
  serverId: string,
  assignee: TaskCreationAssignee,
): Promise<boolean> {
  if (assignee.type === "agent") {
    const [identity] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.id, assignee.id),
        eq(agents.serverId, serverId),
        isNull(agents.deletedAt),
      ))
      .for("update");
    return Boolean(identity);
  }

  const [identity] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, assignee.id))
    .for("update");
  return Boolean(identity);
}

async function lockTaskCreationAssigneeMembership(
  tx: DatabaseExecutor,
  channel: Pick<typeof channels.$inferSelect, "id" | "serverId" | "name" | "type">,
  assignee: TaskCreationAssignee,
): Promise<boolean> {
  if (assignee.type === "agent") {
    // Enabled #all is server-wide and deliberately has no channel_agents row.
    if (channel.name === "all" && channel.type === "channel") return true;

    const [membership] = await tx
      .select({ id: channelAgents.agentId })
      .from(channelAgents)
      .where(and(
        eq(channelAgents.channelId, channel.id),
        eq(channelAgents.agentId, assignee.id),
      ))
      .for("update");
    return Boolean(membership);
  }

  if (channel.name === "all" && channel.type === "channel") {
    const [membership] = await tx
      .select({ id: serverMembers.userId })
      .from(serverMembers)
      .where(and(
        eq(serverMembers.serverId, channel.serverId),
        eq(serverMembers.userId, assignee.id),
      ))
      .for("update");
    return Boolean(membership);
  }

  const [membership] = await tx
    .select({ id: channelHumans.userId })
    .from(channelHumans)
    .where(and(
      eq(channelHumans.channelId, channel.id),
      eq(channelHumans.userId, assignee.id),
    ))
    .for("update");
  return Boolean(membership);
}

/**
 * Lock and validate an assignee for an existing task's storage channel.
 *
 * Ordinary channels keep the existing server-local identity + membership
 * checks. A joint task is stored in a member-less canonical channel, so its
 * eligible assignee set is the union of active local projections. Human ids
 * are global logical identities: the same user present in two projections is
 * one assignee and this existential query intentionally returns one row. Agent
 * ids remain server-owned and must match the server of the projection carrying
 * their membership.
 */
async function lockTaskAssigneeEligibility(
  tx: DatabaseExecutor,
  channel: Pick<typeof channels.$inferSelect, "id" | "serverId" | "name" | "type">,
  assignee: TaskCreationAssignee,
): Promise<"assignee not found" | "assignee is not a member of this channel" | null> {
  const [joint] = await tx
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(and(
      eq(jointChannels.canonicalChannelId, channel.id),
      eq(jointChannels.status, "active"),
    ))
    .limit(1);

  if (!joint) {
    if (!await lockTaskCreationAssigneeIdentity(tx, channel.serverId, assignee)) return "assignee not found";
    return await lockTaskCreationAssigneeMembership(tx, channel, assignee)
      ? null
      : "assignee is not a member of this channel";
  }

  await acquireJointSourceExitFlagReadLock(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`joint-human-membership:${joint.id}`},0))`);
  if (assignee.type === "user") {
    const [identity] = await tx.select({ id: users.id }).from(users).where(eq(users.id, assignee.id)).limit(1);
    if (!identity) return "assignee not found";
    // Hold the authoritative member, not a source CH or another channel's
    // row after J. Source departure/role writers own SM before J.
    const membership = await tx.select({ id: jointChannelMembers.userId }).from(jointChannelMembers).where(and(
      eq(jointChannelMembers.jointChannelId, joint.id), eq(jointChannelMembers.userId, assignee.id),
      // P3: a bound host Guest is assignable only while the host admits guests.
      jointHumanConnectedIdentitySql(jointChannelMembers.jointChannelId, jointChannelMembers.userId, await resolveJointGuestEntryJointIds([joint.id], tx)),
      // With source exit, a member without a live source is not assignable.
      (await resolveJointSourceExitJointIds([joint.id], tx)).has(joint.id)
        ? jointHumanHasLiveSourceSql(jointChannelMembers.jointChannelId, jointChannelMembers.userId)
        : undefined,
      sql`NOT (${jointMembershipRemovalPendingSql(jointChannelMembers.jointChannelId, "user", jointChannelMembers.userId)})`,
    )).limit(1).for("key share");
    return membership.length ? null : "assignee is not a member of this channel";
  }

  const [identity] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, assignee.id), isNull(agents.deletedAt)))
    .limit(1);
  if (!identity) return "assignee not found";
  const [membership] = await tx
    .select({ id: agents.id })
    .from(jointChannelServers)
    .innerJoin(channelAgents, and(
      eq(channelAgents.channelId, jointChannelServers.localChannelId),
      eq(channelAgents.agentId, assignee.id),
    ))
    .innerJoin(channels, and(
      eq(channels.id, jointChannelServers.localChannelId),
      eq(channels.serverId, jointChannelServers.serverId),
      isNull(channels.deletedAt),
    ))
    .innerJoin(agents, and(
      eq(agents.id, channelAgents.agentId),
      eq(agents.serverId, jointChannelServers.serverId),
      isNull(agents.deletedAt),
    ))
    .where(and(
      eq(jointChannelServers.jointChannelId, joint.id),
      eq(jointChannelServers.status, "active"),
      sql`NOT (${jointMembershipRemovalPendingSql(jointChannelServers.jointChannelId, "agent", channelAgents.agentId)})`,
    ))
    .limit(1)
    .for("key share", { of: channelAgents });
  return membership ? null : "assignee is not a member of this channel";
}

/**
 * Reserve `count` consecutive task numbers in `channelId` (the storage
 * channel) and return the first. A number is never reused within a channel
 * (RFC 078): next = max(messages.task_number, tasks.task_number,
 * channels.task_number_high_water) + 1, and the high-water mark moves to the
 * last reserved number in the same statement. A legacy task keeps its host
 * message, but a v2 task has none, so without the mark deleting the newest v2
 * task would free its number and an old `#channel:#N` ref would point at the
 * next task.
 *
 * Call inside the allocation transaction, after the channel's advisory lock
 * (`pg_advisory_xact_lock(hashtext(channelId))`) where the caller takes it.
 * The UPDATE also row-locks the channel, and it reads the mark from the row
 * it locks, so even allocators that serialize only on the channel row
 * (workflows) cannot hand out a number another committed allocation took.
 */
export async function reserveTaskNumbers(tx: DatabaseExecutor, channelId: string, count = 1): Promise<number> {
  if (!Number.isInteger(count) || count < 1) throw new Error("reserveTaskNumbers needs a positive count");
  const result = await tx.execute(sql`
    UPDATE channels
       SET task_number_high_water = GREATEST(
             channels.task_number_high_water,
             (SELECT COALESCE(MAX(m.task_number), 0) FROM messages m WHERE m.channel_id = ${channelId}::uuid),
             (SELECT COALESCE(MAX(t.task_number), 0) FROM tasks t WHERE t.channel_id = ${channelId}::uuid)
           ) + ${count}::int
     WHERE channels.id = ${channelId}::uuid
     RETURNING task_number_high_water AS "highWater"
  `);
  const row = result.rows[0] as { highWater: number | string } | undefined;
  if (!row) throw new Error("Task channel is unavailable");
  return Number(row.highWater) - count + 1;
}

/** Allocate the next task number for a channel (see reserveTaskNumbers). */
export async function allocateTaskNumber(channelId: string): Promise<{ taskStatus: "todo"; taskNumber: number }> {
  return withTaskChannelWriter(channelId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${channelId}))`);
    return { taskStatus: "todo" as const, taskNumber: await reserveTaskNumbers(tx, channelId) };
  });
}

/**
 * Any status can be set from any other status, by people and agents alike:
 * stdrc 2026-10-31 #wg-task-v2:7415abae msg=ad820421 ("所有的状态之间切换的限制
 * 其实都不需要了 因为人和 Agent 都知道他现在应该要把它切成什么状态"). This
 * replaced the transition table of 2026-05-08 (#proj-task:5ca7dfa3). Setting
 * the status a task already has is the only refusal; the side effects of a
 * move (start epoch, completedAt, closed_*) are derived in writeCanonicalStatus.
 */
export function getTaskStatusTransitionError(
  currentStatus: TaskStatus,
  newStatus: TaskStatus,
): string | null {
  return currentStatus === newStatus ? `already ${newStatus}` : null;
}

/** Statuses of work not started yet: entering in_progress from one starts it. */
function isUnstartedStatus(status: TaskStatus): boolean {
  return status === "backlog" || status === "todo" || status === "closed";
}

/** Batch-resolve creator and claimer names for a list of task-messages. */
async function enrichWithNames(rows: MessageRow[], executor: DatabaseExecutor = getDb()) {
  if (rows.length === 0) return [];
  const db = executor;

  const userIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const t of rows) {
    // Creator comes from senderType/senderId
    if (t.senderType === "user") userIds.add(t.senderId);
    else agentIds.add(t.senderId);
    // Claimer comes from taskAssigneeType/taskAssigneeId
    if (t.taskAssigneeId) {
      if (t.taskAssigneeType === "user") userIds.add(t.taskAssigneeId);
      else agentIds.add(t.taskAssigneeId);
    }
  }

  const nameMap = new Map<string, string>();
  const handleMap = new Map<string, string>();
  const channelIds = [...new Set(rows.map((t) => t.channelId))];
  const channelMap = new Map<string, { name: string; type: TaskChannelType }>();

  if (userIds.size > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const u of userRows) {
      nameMap.set(u.id, u.displayName || u.name || "User");
      handleMap.set(u.id, u.name || "User");
    }
  }

  if (agentIds.size > 0) {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]));
    for (const a of agentRows) {
      nameMap.set(a.id, a.displayName || a.name);
      handleMap.set(a.id, a.name);
    }
  }

  if (channelIds.length > 0) {
    const channelRows = await db
      .select({ id: channels.id, name: channels.name, type: channels.type })
      .from(channels)
      .where(inArray(channels.id, channelIds));
    for (const channel of channelRows) {
      channelMap.set(channel.id, {
        name: channel.name,
        type: asTaskChannelType(channel.type),
      });
    }
  }

  return rows.map((t) => ({
    ...t,
    // Map to TaskInfo-compatible field names
    createdByType: t.senderType,
    createdById: t.senderId,
    createdByName: nameMap.get(t.senderId) || "Unknown",
    createdByHandle: handleMap.get(t.senderId) ?? null,
    claimedByType: t.taskAssigneeType ?? null,
    claimedById: t.taskAssigneeId ?? null,
    claimedByName: t.taskAssigneeId ? handleMap.get(t.taskAssigneeId) || "Unknown" : null,
    claimedAt: t.taskClaimedAt?.toISOString() ?? null,
    completedAt: t.taskCompletedAt?.toISOString() ?? null,
    status: t.taskStatus as TaskStatus,
    taskNumber: t.taskNumber!,
    title: t.content,
    description: null as string | null,
    messageId: t.id,
    channelName: channelMap.get(t.channelId)?.name ?? null,
    channelType: channelMap.get(t.channelId)?.type ?? "channel",
    // A message-task always has a host message (it *is* the message), so it is
    // never the read-only orphan shape. Emitted explicitly so both enrichers
    // produce one DTO and no consumer has to branch on the source table.
    revision: null as number | null,
    isLegacy: false,
  }));
}

/**
 * List tasks for a channel, optionally filtered by status.
 *
 * P3 (tasks-only read). The union against `messages.task_*` is gone: the prod
 * backfill on 2026-07-31 moved every message-task into `tasks` (verify oracle
 * check 1 = 0 over 427,546 rows), and both creation paths -- `createTasks` and
 * `convertMessageToTask` -- have written canonical-only since v1.4. So no task
 * can exist on the message side without a canonical row, and the anti-join it
 * used to need has nothing left to suppress.
 *
 * `messages.task_*` is retained as a frozen snapshot (rollback ledger, @stdrc
 * 2026-07-31 keep-and-observe) but is no longer read as truth by anything here.
 */
export async function listTasks(channelId: string, statusFilter?: TaskStatus) {
  const db = getDb();

  const taskConditions = [conversionReadChannelPredicate(tasks.channelId, channelId)];
  if (statusFilter) taskConditions.push(eq(tasks.status, statusFilter));

  // A failed query is not an empty board. Let each route report the failure;
  // callers can only assert completeness after the query and enrichment pass.
  const taskRows = await db
    .select()
    .from(tasks)
    .where(and(...taskConditions))
    .orderBy(asc(tasks.taskNumber));

  // A single-channel board includes current-text provenance. Do not present
  // fallback provenance as a complete result if its queries fail.
  return enrichTaskRows(taskRows, db, { failClosedCurrentProjection: true });
}

// Backlog is not here on purpose: parked work is not active (raft-design decision 0042).
const UNFINISHED_TASK_STATUSES = ["todo", "in_progress", "in_review"] as const satisfies readonly TaskStatus[];

/**
 * The caller-supplied channel ids, each expanded once to its storage-equivalent
 * ids, to join on `tasks.channel_id` (see listTasksAssignedToAgent).
 */
function authorizedTaskSurface(visibleChannelIds: readonly string[]) {
  return getDb().select({
    channelId: sql<string>`requested.id`.as("read_channel_id"),
    position: sql<number>`requested.position`.as("read_position"),
    storageChannelId: sql<string>`storage.id`.as("storage_channel_id"),
  }).from(sql`unnest(ARRAY[${sql.join(visibleChannelIds.map(id => sql`${id}::uuid`), sql`, `)}]) WITH ORDINALITY AS requested(id, position)
    CROSS JOIN LATERAL (${conversionReadChannelIdsQuery(sql`requested.id`)}) AS storage`)
    .as("authorized_task_surface");
}

/**
 * List every canonical task assigned to one exact agent identity within a
 * caller-supplied set of already-authorized channel ids. The caller must build
 * that set from channel visibility, rather than reading hidden assignments and
 * filtering them afterward (which would make hidden task count a timing side
 * channel).
 *
 * There is intentionally no row cap or pagination in v0. The response marks
 * itself complete, and the contract suite exercises a result set larger than
 * the common 100-row accidental cap so truncation cannot be introduced
 * silently.
 */
export async function listTasksAssignedToAgent(
  visibleChannelIds: string[],
  agentId: string,
  statusFilter?: TaskStatus | "all",
) {
  const db = getDb();
  if (visibleChannelIds.length === 0) return [];

  // Keep authorization inputs, namespace equivalence and the response surface
  // in one SQL snapshot. The first caller-supplied id is the local surface;
  // canonical ids are never discovered by inspecting unauthorized Task rows.
  // Each supplied id is expanded to its storage-equivalent ids once, then
  // joined on channel_id, so the planner reads tasks through the channel
  // index. Testing equivalence per task and id instead cost ~1.9 ms a pair
  // and hit the statement timeout for agents in 100+ channels.
  const readSurface = authorizedTaskSurface(visibleChannelIds);
  const conditions: SQL[] = [
    eq(tasks.claimedByType, "agent"),
    eq(tasks.claimedById, agentId),
  ];
  if (statusFilter && statusFilter !== "all") {
    conditions.push(eq(tasks.status, statusFilter));
  } else if (!statusFilter) {
    conditions.push(inArray(tasks.status, [...UNFINISHED_TASK_STATUSES]));
  }

  const rows = await db
    .selectDistinctOn([tasks.channelId, tasks.taskNumber, tasks.id], { task: tasks, readChannelId: readSurface.channelId })
    .from(tasks)
    .innerJoin(readSurface, eq(tasks.channelId, readSurface.storageChannelId))
    .where(and(...conditions))
    .orderBy(asc(tasks.channelId), asc(tasks.taskNumber), asc(tasks.id), asc(readSurface.position));
  const enriched = await enrichTaskRows(rows.map(row => row.task));
  const surfaceByTask = new Map(rows.map(row => [row.task.id, row.readChannelId]));
  return enriched.map(task => ({ ...task, channelId: surfaceByTask.get(task.id)! }));
}

/**
 * The unfinished tasks assigned to one agent in already-authorized channel
 * ids (as listTasksAssignedToAgent), one row per task with the requested id it
 * was read through: a subquery for the bounded reads below.
 */
function assignedOpenTaskRowsSubquery(visibleChannelIds: readonly string[], agentId: string) {
  const db = getDb();
  const readSurface = authorizedTaskSurface(visibleChannelIds);
  return db
    .selectDistinctOn([tasks.id], {
      id: tasks.id,
      taskNumber: tasks.taskNumber,
      title: tasks.title,
      updatedAt: tasks.updatedAt,
      channelId: readSurface.channelId,
    })
    .from(tasks)
    .innerJoin(readSurface, eq(tasks.channelId, readSurface.storageChannelId))
    .where(and(
      eq(tasks.claimedByType, "agent"),
      eq(tasks.claimedById, agentId),
      inArray(tasks.status, [...UNFINISHED_TASK_STATUSES]),
    ))
    .orderBy(asc(tasks.id), asc(readSurface.position))
    .as("assigned_open_task");
}

/**
 * At most `limit` unfinished tasks assigned to the agent in these
 * already-authorized channel ids, most recently updated first (then task
 * number), with the total: the bounded read behind a summary that names a
 * few and counts the rest. No enrichment.
 */
export async function listRecentTasksAssignedToAgent(
  visibleChannelIds: readonly string[],
  agentId: string,
  limit: number,
): Promise<{ rows: Array<{ id: string; taskNumber: number; title: string; channelId: string }>; total: number }> {
  if (visibleChannelIds.length === 0) return { rows: [], total: 0 };
  const assigned = assignedOpenTaskRowsSubquery(visibleChannelIds, agentId);
  const [rows, total] = await Promise.all([
    limit > 0
      ? getDb()
        .select({ id: assigned.id, taskNumber: assigned.taskNumber, title: assigned.title, channelId: assigned.channelId })
        .from(assigned)
        .orderBy(sql`${assigned.updatedAt} desc`, asc(assigned.taskNumber), asc(assigned.id))
        .limit(limit)
      : Promise.resolve([]),
    countTasksAssignedToAgent(visibleChannelIds, agentId),
  ]);
  return { rows, total };
}

/** How many unfinished tasks are assigned to the agent in these already-authorized channel ids. */
export async function countTasksAssignedToAgent(visibleChannelIds: readonly string[], agentId: string): Promise<number> {
  if (visibleChannelIds.length === 0) return 0;
  const assigned = assignedOpenTaskRowsSubquery(visibleChannelIds, agentId);
  const [row] = await getDb().select({ total: sql<number>`count(*)::int` }).from(assigned);
  return Number(row?.total ?? 0);
}

/**
 * At most `limit` task v2 tasks this agent created that nobody holds, in these
 * already-authorized channel ids, most recently updated first (idle task
 * reminder). Only statuses the caller names, each created at or before its
 * cutoff: a task's "untouched" clock cannot start before its creation, so a
 * younger one cannot be due and must not take a place under the limit.
 *
 * Reads tasks through idx_tasks_channel_status like the assigned reads, no
 * index on the creator; the creator and assignee are filters on those rows. No
 * enrichment.
 */
export async function listUnassignedTasksCreatedByAgent(
  visibleChannelIds: readonly string[],
  agentId: string,
  opts: { createdByStatus: Partial<Record<TaskStatus, Date>>; limit: number },
) {
  const statuses = Object.entries(opts.createdByStatus).flatMap(([status, cutoff]) => cutoff
    ? [and(eq(tasks.status, status as TaskStatus), lte(tasks.createdAt, cutoff))]
    : []);
  if (visibleChannelIds.length === 0 || statuses.length === 0 || opts.limit <= 0) return [];
  const db = getDb();
  const readSurface = authorizedTaskSurface(visibleChannelIds);
  const created = db
    .selectDistinctOn([tasks.id], {
      id: tasks.id,
      taskNumber: tasks.taskNumber,
      title: tasks.title,
      status: tasks.status,
      messageId: tasks.messageId,
      conversationChannelId: tasks.conversationChannelId,
      sourceMessageId: tasks.sourceMessageId,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      channelId: readSurface.channelId,
    })
    .from(tasks)
    .innerJoin(readSurface, eq(tasks.channelId, readSurface.storageChannelId))
    .where(and(
      eq(tasks.createdByType, "agent"),
      eq(tasks.createdById, agentId),
      isNull(tasks.claimedById),
      or(eq(tasks.ownConversation, true), isNotNull(tasks.conversationChannelId)),
      or(...statuses),
    ))
    .orderBy(asc(tasks.id), asc(readSurface.position))
    .as("unassigned_created_task");
  const rows = await db
    .select()
    .from(created)
    .orderBy(sql`${created.updatedAt} desc`, asc(created.taskNumber), asc(created.id))
    .limit(opts.limit);
  return rows.map((row) => ({
    id: row.id,
    taskNumber: row.taskNumber,
    title: row.title,
    status: row.status as TaskStatus,
    hostMessageId: row.messageId ?? null,
    conversationChannelId: row.conversationChannelId ?? null,
    // As enrichTaskRows: a task from before task v2 hangs under its host message.
    sourceMessageId: row.sourceMessageId ?? row.messageId ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    channelId: row.channelId,
  }));
}

type TaskProjectionChannel = {
  id: string;
  name?: string | null;
  type: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  taskReadOnlyBefore?: Date | null;
};

/** Project one canonical task fact into a requester's local channel surface. */
export function projectTasksToChannel<T extends {
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  createdAt?: Date | string;
}>(taskRows: T[], channel: TaskProjectionChannel): Array<T & { readOnlyReason: TaskReadOnlyReason | null }> {
  return taskRows.map((task) => ({
    ...task,
    channelId: channel.id,
    channelName: channel.name ?? task.channelName ?? null,
    channelType: channel.type,
    readOnlyReason: getTaskReadOnlyReason(channel, task.createdAt),
  }));
}

export function projectTaskToChannel<T extends {
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread" | "task";
}>(task: T, channel: TaskProjectionChannel): T & { readOnlyReason: TaskReadOnlyReason | null } {
  return projectTasksToChannel([task], channel)[0]!;
}

/** Message ids that already have a canonical `tasks` row in this channel. */
async function loadCanonicalMessageIds(
  executor: DatabaseExecutor,
  channelId: string,
): Promise<Set<string>> {
  try {
    const rows = await executor
      .select({ messageId: tasks.messageId })
      .from(tasks)
      .where(and(eq(tasks.channelId, channelId), isNotNull(tasks.messageId)));
    return new Set(rows.map((row) => row.messageId!).filter(Boolean));
  } catch (err) {
    console.error("[taskService] canonical message id scan failed:", err);
    return new Set();
  }
}

/**
 * The server task board's conversations for one human, ordered by (name, id):
 * the visible public, private and joint channels (visibilityService), minus
 * archived ones. DMs stay off the board by product choice (an agent's
 * `task list --mine` does list them); threads never carry tasks. Guests get
 * the same rule: the board lists what canView lets them read.
 */
async function listServerTaskBoardChannelIds(serverId: string, userId: string): Promise<string[]> {
  const { roots } = await visibleRootChannelIds(
    { type: "user", id: userId, serverId: serverId as ServerId },
    // The board reads top-level tasks only: no thread candidates, no joint storage map.
    { includeThreads: false },
  );
  const boardTypes = new Set(["channel", "private", "joint"]);
  return roots
    .filter((root) => boardTypes.has(root.type) && root.archivedAt === null)
    .map((root) => root.id);
}

/**
 * List tasks for all visible non-DM, non-thread, non-archived task surfaces in
 * a server (see listServerTaskBoardChannelIds). Joint rows are read from
 * canonical storage but projected back to the local channel id, and remain
 * membership-gated even though ordinary public-channel tasks are
 * server-visible; private channels likewise list only for their members.
 */
export async function listServerTasks(serverId: string, statusFilter: TaskStatus | undefined, userId: string) {
  const boardChannelIds = await listServerTaskBoardChannelIds(serverId, userId);
  if (boardChannelIds.length === 0) return [];
  const surfaces = await resolveOrderedTaskSurfaces(serverId, boardChannelIds);
  // A failed read surfaces as an error: an empty board would claim the server has no tasks.
  const rows = await selectServerTaskRows(surfaces, serverTaskConditions(statusFilter, undefined, userId));
  return projectServerTaskRows(surfaces, rows);
}

/** A person or agent as the board's Creator / Assignee filters name it (`<type>:<id>` on the wire). */
export type ServerTaskActorRef = { type: "user" | "agent"; id: string };

/**
 * The board's relation to the requesting person. Each is exclusive of the
 * ones before it, so one task lands in one relation tab:
 * - assigned_to_me: claimed by the person;
 * - created_by_me: created by the person and not claimed by them;
 * - from_my_message: its task v2 source message (`tasks.source_message_id`)
 *   was sent by the person, still exists and is not retracted, and the task
 *   was neither created by them nor claimed by them. Pre-v2 tasks have no source message (the
 *   summary's `sourceMessageId` host-message fallback is not one), so they
 *   never match.
 */
export const SERVER_TASK_RELATIONS = ["assigned_to_me", "created_by_me", "from_my_message"] as const;
export type ServerTaskRelation = (typeof SERVER_TASK_RELATIONS)[number];

/**
 * Opt-in filters of the server task board reads (`GET /api/tasks/server` new
 * shapes and `GET /api/tasks/server/counts`). Every filter narrows the same
 * visible board (listServerTaskBoardChannelIds); none can widen it.
 */
export interface ServerTaskFilters {
  /**
   * Board statuses. `in_progress` also matches stored `in_review` rows: task
   * v2 retired in_review and the board shows those rows as in progress, so
   * the column and its count must include them. `in_review` alone still
   * matches only in_review rows.
   */
  statuses?: readonly TaskStatus[];
  /** Local channel ids; ids outside the visible board simply match nothing. */
  channelIds?: readonly string[];
  /** Claimer identities, or "unassigned" for no claimer; any one matches. */
  assignees?: readonly (ServerTaskActorRef | "unassigned")[];
  /** Creator identities; any one matches. */
  creators?: readonly ServerTaskActorRef[];
  relation?: ServerTaskRelation;
  /**
   * Done tasks completed before this instant are left out; tasks in other
   * statuses are unaffected (completed_at is set only while a task is done),
   * so a board can bound its Done column without hiding the active ones.
   */
  completedSince?: Date;
  /**
   * Tasks created before this instant are left out, in every status (the
   * Tasks page's "created today": counts with created_since summed over the
   * columns).
   */
  createdSince?: Date;
  /**
   * The Tasks page's search: words the title contains, case-insensitively
   * (every word, in any order), or a task number (`12` / `#12`), which also
   * matches that number in any channel.
   */
  query?: string;
}

/** A LIKE pattern matching `text` anywhere, its own `%`, `_` and `\` taken literally. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Search words of ServerTaskFilters.query, at most this many. */
const SERVER_TASK_QUERY_MAX_WORDS = 8;

function serverTaskQueryPredicate(query: string): SQL | null {
  const words = [...new Set(query.trim().split(/\s+/u).filter(Boolean))].slice(0, SERVER_TASK_QUERY_MAX_WORDS);
  if (words.length === 0) return null;
  const title = and(...words.map((word) => sql`${tasks.title} ILIKE ${containsPattern(word)} ESCAPE '\\'`))!;
  const number = words.length === 1 ? /^#?(\d{1,9})$/.exec(words[0]!) : null;
  return number ? sql`(${title} OR ${tasks.taskNumber} = ${Number(number[1])})` : title;
}

const STATUSES_SHOWN_AS_IN_PROGRESS = ["in_progress", "in_review"] as const satisfies readonly TaskStatus[];
// Relation tabs count work that is still open; backlog is parked (as UNFINISHED_TASK_STATUSES).
const RELATION_COUNTED_STATUSES = ["todo", ...STATUSES_SHOWN_AS_IN_PROGRESS] as const satisfies readonly TaskStatus[];

function storedBoardStatuses(statuses: readonly TaskStatus[]): TaskStatus[] {
  const stored = new Set<TaskStatus>(statuses);
  if (stored.has("in_progress")) stored.add("in_review");
  return [...stored];
}

function serverTaskRelationPredicate(relation: ServerTaskRelation, userId: string): SQL {
  // Plain equalities where the relation selects rows, so a WHERE can read them
  // through idx_tasks_claimed_by / idx_tasks_created_by (a NULL claimer is
  // simply not a match there).
  const claimedByMeMatch = sql`(${tasks.claimedByType} = 'user' AND ${tasks.claimedById} = ${userId})`;
  // COALESCE where it excludes: an unclaimed task's NULL claimer must read as "not mine", or NOT would drop it.
  const claimedByMe = sql`COALESCE(${tasks.claimedByType} = 'user' AND ${tasks.claimedById} = ${userId}, false)`;
  const createdByMe = sql`(${tasks.createdByType} = 'user' AND ${tasks.createdById} = ${userId})`;
  switch (relation) {
    case "assigned_to_me":
      return claimedByMeMatch;
    case "created_by_me":
      return sql`(${createdByMe} AND NOT ${claimedByMe})`;
    case "from_my_message":
      return sql`(NOT ${createdByMe} AND NOT ${claimedByMe} AND EXISTS (
        SELECT 1 FROM ${messages}
        WHERE ${messages.id} = ${tasks.sourceMessageId}
          AND ${messages.senderType} = 'user'
          AND ${messages.senderId} = ${userId}
          AND ${messages.deletedAt} IS NULL
      ))`;
  }
}

function actorRefPredicate(typeColumn: typeof tasks.createdByType | typeof tasks.claimedByType, idColumn: typeof tasks.createdById | typeof tasks.claimedById, ref: ServerTaskActorRef): SQL {
  return and(eq(typeColumn, ref.type), eq(idColumn, ref.id))!;
}

/**
 * WHERE conditions on `tasks` for a board read. `statusFilter` is the legacy
 * exact single status (no in_review folding); `filters` are the opt-in ones.
 * `channelIds` is not here: it narrows the surfaces, not the rows.
 */
function serverTaskConditions(
  statusFilter: TaskStatus | undefined,
  filters: ServerTaskFilters | undefined,
  userId: string,
  options: { ignoreRelation?: boolean } = {},
): SQL[] {
  const conditions: SQL[] = [];
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter));
  if (!filters) return conditions;
  if (filters.statuses) conditions.push(inArray(tasks.status, storedBoardStatuses(filters.statuses)));
  if (filters.assignees) {
    conditions.push(or(...filters.assignees.map((assignee) => (
      assignee === "unassigned" ? isNull(tasks.claimedById) : actorRefPredicate(tasks.claimedByType, tasks.claimedById, assignee)
    )))!);
  }
  if (filters.creators) {
    conditions.push(or(...filters.creators.map((creator) => actorRefPredicate(tasks.createdByType, tasks.createdById, creator)))!);
  }
  if (filters.relation && !options.ignoreRelation) conditions.push(serverTaskRelationPredicate(filters.relation, userId));
  if (filters.completedSince) {
    conditions.push(sql`(${tasks.status} <> 'done' OR ${tasks.completedAt} >= ${filters.completedSince.toISOString()}::timestamptz)`);
  }
  if (filters.createdSince) {
    conditions.push(sql`${tasks.createdAt} >= ${filters.createdSince.toISOString()}::timestamptz`);
  }
  if (filters.query) {
    const matches = serverTaskQueryPredicate(filters.query);
    if (matches) conditions.push(matches);
  }
  return conditions;
}

/** The board's ordered channel ids, narrowed to `channelIds` when given; ids outside the board drop out. */
function narrowServerTaskBoard(boardChannelIds: string[], channelIds: readonly string[] | undefined): string[] {
  if (!channelIds) return boardChannelIds;
  const wanted = new Set(channelIds);
  return boardChannelIds.filter((id) => wanted.has(id));
}

export interface ServerTaskCounts {
  /** Per board column; `in_progress` includes stored in_review rows. */
  counts: { backlog: number; todo: number; in_progress: number; done: number; closed: number };
  /** Open (todo / in progress) tasks per relation, within every filter but `relation`. */
  relations: Record<ServerTaskRelation, number>;
}

/**
 * Counts for the server task board over exactly the rows the board list
 * (`listServerTasksPage` with the same filters) would page through: same
 * visible surfaces, same per-surface rows, so a column's count is the number
 * of rows its pages hold. One aggregate query, no rows loaded.
 */
export async function countServerTasks(serverId: string, userId: string, filters: ServerTaskFilters): Promise<ServerTaskCounts> {
  const boardChannelIds = narrowServerTaskBoard(await listServerTaskBoardChannelIds(serverId, userId), filters.channelIds);
  const zero: ServerTaskCounts = {
    counts: { backlog: 0, todo: 0, in_progress: 0, done: 0, closed: 0 },
    relations: { assigned_to_me: 0, created_by_me: 0, from_my_message: 0 },
  };
  if (boardChannelIds.length === 0) return zero;
  const surfaces = await resolveOrderedTaskSurfaces(serverId, boardChannelIds);
  if (surfaces.length === 0) return zero;

  // The relation param narrows the column counts only; the relation counts
  // are the tabs' badges, each computed within every other filter.
  const inRelation = filters.relation ? serverTaskRelationPredicate(filters.relation, userId) : sql`TRUE`;
  const statusIn = (statuses: readonly TaskStatus[]) => inArray(tasks.status, [...statuses]);
  const column = (statuses: readonly TaskStatus[]) =>
    sql<number>`count(*) FILTER (WHERE ${statusIn(statuses)} AND ${inRelation})`.mapWith(Number);
  const relationCount = (relation: ServerTaskRelation) =>
    sql<number>`count(*) FILTER (WHERE ${statusIn(RELATION_COUNTED_STATUSES)} AND ${serverTaskRelationPredicate(relation, userId)})`.mapWith(Number);
  const conditions = serverTaskConditions(undefined, filters, userId, { ignoreRelation: true });

  const [row] = await getDb()
    .select({
      backlog: column(["backlog"]),
      todo: column(["todo"]),
      inProgress: column(STATUSES_SHOWN_AS_IN_PROGRESS),
      done: column(["done"]),
      closed: column(["closed"]),
      assignedToMe: relationCount("assigned_to_me"),
      createdByMe: relationCount("created_by_me"),
      fromMyMessage: relationCount("from_my_message"),
    })
    .from(serverTaskSurfaceSource(surfaces))
    .innerJoin(tasks, eq(tasks.channelId, sql`read_scope.id`))
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  if (!row) return zero;
  return {
    counts: { backlog: row.backlog, todo: row.todo, in_progress: row.inProgress, done: row.done, closed: row.closed },
    relations: { assigned_to_me: row.assignedToMe, created_by_me: row.createdByMe, from_my_message: row.fromMyMessage },
  };
}

type ServerTaskSurfaceRow = { position: number; task: TaskRow };

/**
 * The visible task surfaces among `orderedChannelIds`, in that order: the
 * batched equivalent of running `canUserAccessChannel` and then
 * `resolveTaskChannelSurface` for each id, in a constant number of queries.
 */
async function resolveVisibleServerTaskSurfaces(
  serverId: string,
  userId: string,
  orderedChannelIds: string[],
): Promise<TaskChannelSurface[]> {
  const accessible = await filterUserAccessibleChannelIds(orderedChannelIds, userId, serverId as ServerId);
  return resolveOrderedTaskSurfaces(serverId, orderedChannelIds.filter((id) => accessible.has(id)));
}

/** The task surfaces of already-visible channel ids, in that order. */
async function resolveOrderedTaskSurfaces(serverId: string, accessibleIds: string[]): Promise<TaskChannelSurface[]> {
  const surfaceById = await resolveTaskChannelSurfaces(serverId, accessibleIds);
  return accessibleIds.flatMap((id) => {
    const surface = surfaceById.get(id);
    return surface ? [surface] : [];
  });
}

/**
 * The board's row source: each surface's conversion-read equivalence set as
 * `surface(storage_id, position)` x `read_scope(id)`, to join on
 * `tasks.channel_id = read_scope.id`. Shared by the board list and its counts
 * so both read exactly the same rows.
 */
function serverTaskSurfaceSource(surfaces: TaskChannelSurface[]): SQL {
  const storageIds = sql.join(surfaces.map((surface) => sql`${surface.storageChannelId}::uuid`), sql`, `);
  const localIds = sql.join(surfaces.map((surface) => sql`${surface.localChannel.id}::uuid`), sql`, `);
  // local_id: the surface's local channel id, the sorted walks' last tiebreaker.
  return sql`unnest(ARRAY[${storageIds}], ARRAY[${localIds}]) WITH ORDINALITY AS surface(storage_id, local_id, position)
      CROSS JOIN LATERAL (${conversionReadChannelIdsQuery(sql`surface.storage_id`)}) AS read_scope(id)`;
}

/**
 * ONE tasks query over every surface's conversion-read equivalence set.
 * Each row is tagged with the 0-based index of the surface it was read
 * through, so a task whose channel sits in two surfaces' equivalence sets is
 * returned once per surface -- exactly what per-surface `listTasks` calls
 * produced. Ordered by (surface index, taskNumber); `after` resumes strictly
 * after a keyset position and `limit` bounds the row count.
 */
async function selectServerTaskRows(
  surfaces: TaskChannelSurface[],
  filterConditions: SQL[],
  page?: { after?: { position: number; taskNumber: number } | null; limit?: number },
): Promise<ServerTaskSurfaceRow[]> {
  if (surfaces.length === 0) return [];
  // WITH ORDINALITY is 1-based; positions exposed to callers are 0-based.
  const position = sql<string>`(surface.position - 1)`;
  const conditions: SQL[] = [...filterConditions];
  if (page?.after) {
    conditions.push(sql`(${position} > ${page.after.position} OR (${position} = ${page.after.position} AND ${tasks.taskNumber} > ${page.after.taskNumber}))`);
  }
  const query = getDb()
    .select({ position, task: tasks })
    .from(serverTaskSurfaceSource(surfaces))
    .innerJoin(tasks, eq(tasks.channelId, sql`read_scope.id`))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`surface.position`, asc(tasks.taskNumber), asc(tasks.id));
  const rows = page?.limit != null ? await query.limit(page.limit) : await query;
  return rows.map((row) => ({ position: Number(row.position), task: row.task }));
}

/** Enrich all rows once (enrichment is per-row keyed) and project each onto its surface. */
async function projectServerTaskRows(surfaces: TaskChannelSurface[], rows: ServerTaskSurfaceRow[]) {
  const uniqueRows = [...new Map(rows.map((row) => [row.task.id, row.task])).values()];
  const enrichedById = new Map(
    (await enrichTaskRows(uniqueRows, getDb(), { includeCurrentProjection: false })).map((task) => [task.id, task]),
  );
  return rows.map((row) => projectTaskToChannel(enrichedById.get(row.task.id)!, surfaces[row.position]!.localChannel));
}

/** One item of `listServerTasks`' return type (the enriched, projected row). */
export type ServerTaskListItem = Awaited<ReturnType<typeof listServerTasks>>[number];

/**
 * Position marker for paginated `GET /api/tasks/server`. The walk is a stable
 * total order — channel name ASC (the existing channel ordering, with channel
 * id as tiebreaker so equal names cannot reorder between pages), then
 * taskNumber ASC (unique within a channel) — so "strictly after the last item
 * of the previous page" is a total-order comparison, not an offset.
 */
export interface ServerTasksPageCursor {
  channelId: string;
  taskNumber: number;
}

/**
 * The board's sorted walks (`GET /api/tasks/server?sort=`); without `sort`
 * the walk keeps its (channel, task number) order.
 *   activity      activity time (taskActivityAt) DESC: most recently updated first
 *   activity_asc  activity time ASC: longest without an update first (the
 *                 Tasks page's "least recently updated")
 *   created       created_at DESC
 *   number        task number DESC (numbers are per channel, so channels interleave)
 * Ties break on task id, then the surface's local channel id (one task is
 * listed once per surface that reads its channel), in the sort's direction,
 * so the order is total and a keyset over it is exact. activity_asc is
 * exactly the reverse of activity.
 */
export const SERVER_TASK_SORTS = ["activity", "activity_asc", "created", "number"] as const;
export type ServerTaskSort = (typeof SERVER_TASK_SORTS)[number];

/** Whether a sort walks its key (and its tie-breaks) ascending. */
export function isAscendingServerTaskSort(sort: ServerTaskSort): boolean {
  return sort === "activity_asc";
}

/**
 * Position marker of a sorted walk: the last emitted item's sort key, task id
 * and local channel id. Resumes strictly after that item in the sort's total
 * order; it does not depend on which channels are still visible, so it never
 * goes stale. Only valid for the sort that produced it.
 */
export interface ServerTasksSortedCursor {
  sort: ServerTaskSort;
  /**
   * activity / activity_asc / created: the instant as stored, `YYYY-MM-DDTHH:MM:SS.ffffffZ`
   * (microseconds: a millisecond ISO string would round, and the walk could
   * skip or repeat a row); number: the task number.
   */
  key: string | number;
  taskId: string;
  channelId: string;
}

export function isServerTasksSortedCursor(cursor: ServerTasksPageCursor | ServerTasksSortedCursor): cursor is ServerTasksSortedCursor {
  return "sort" in cursor;
}

function serverTaskSortKey(sort: ServerTaskSort): SQL {
  switch (sort) {
    case "activity":
    case "activity_asc":
      return taskActivityAt;
    case "created":
      return sql`${tasks.createdAt}`;
    case "number":
      return sql`${tasks.taskNumber}`;
  }
}

/** The sort key as the cursor carries it (ServerTasksSortedCursor.key). */
function serverTaskSortKeyText(sort: ServerTaskSort, key: SQL): SQL {
  return sort === "number"
    ? sql`(${key})::text`
    : sql`to_char((${key}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function serverTaskSortKeyValue(cursor: ServerTasksSortedCursor): SQL {
  return cursor.sort === "number" ? sql`${cursor.key}::integer` : sql`${cursor.key}::timestamptz`;
}

type SortedServerTaskSurfaceRow = { position: number; taskId: string; sortKey: string };

/**
 * Whether the filters pin the rows to named people or agents (an
 * assigned_to_me / created_by_me relation, an Assignee list without
 * "unassigned", a Creator list): their rows are few and
 * idx_tasks_claimed_by / idx_tasks_created_by reach them directly, so the
 * sorted walk reads them in one join and sorts them (selectSortedServerTaskRows'
 * "actor" shape). Without one, the per-channel LATERAL bounds a page; with
 * one, it would scan each channel's sort index past every row that is not
 * that actor's.
 */
function serverTaskFiltersPinActors(filters: ServerTaskFilters | undefined): boolean {
  if (!filters) return false;
  if (filters.relation === "assigned_to_me" || filters.relation === "created_by_me") return true;
  if (filters.creators && filters.creators.length > 0) return true;
  return Boolean(filters.assignees && filters.assignees.length > 0 && !filters.assignees.includes("unassigned"));
}

/**
 * The SQL of a sorted walk's page: up to `limit` (task, surface) pairs in
 * `sort`'s total order, strictly after `after`, as
 * (position, taskId, sortKey). Every ORDER BY and keyset bound uses exactly
 * the sort key expression (serverTaskSortKey; for activity
 * COALESCE(last_activity_at, updated_at), the expression of
 * idx_tasks_channel_activity), so the planner can read the index in order.
 *
 * Two shapes over the same row source and conditions as selectServerTaskRows:
 *   per_channel  each channel of each surface reads its own top `limit` rows
 *                (a LATERAL in the sort's order: idx_tasks_channel_activity /
 *                idx_tasks_channel_created / idx_tasks_channel_number), and
 *                the outer query merges them: at most limit rows per channel,
 *                never the whole board;
 *   actor        one join, sorted (serverTaskFiltersPinActors): the planner
 *                reaches the named actor's rows through their index.
 * Exported for the EXPLAIN tests.
 */
export function sortedServerTaskRowsQuery(
  surfaces: TaskChannelSurface[],
  filterConditions: SQL[],
  sort: ServerTaskSort,
  page: { after?: ServerTasksSortedCursor | null; limit?: number; shape: "per_channel" | "actor" },
): SQL {
  const key = serverTaskSortKey(sort);
  // One direction for the key and both tie-breaks, so a btree on (channel,
  // key, id) serves either: forward for one, backward for the other.
  const ascending = isAscendingServerTaskSort(sort);
  const dir = ascending ? sql.raw("ASC") : sql.raw("DESC");
  const conditions: SQL[] = [sql`${tasks.channelId} = read_scope.id`, ...filterConditions];
  if (page.after) {
    // Strictly after (k, i, c) in (key, id, local_id), all DESC (or all ASC):
    // the row comparison is the index-friendly bound, the NOT drops the
    // cursor's own row and its copies on surfaces at or before c.
    const k = serverTaskSortKeyValue(page.after);
    const i = sql`${page.after.taskId}::uuid`;
    if (ascending) {
      conditions.push(sql`(${key}, ${tasks.id}) >= (${k}, ${i})`);
      conditions.push(sql`NOT ((${key}, ${tasks.id}) = (${k}, ${i}) AND surface.local_id <= ${page.after.channelId}::uuid)`);
    } else {
      conditions.push(sql`(${key}, ${tasks.id}) <= (${k}, ${i})`);
      conditions.push(sql`NOT ((${key}, ${tasks.id}) = (${k}, ${i}) AND surface.local_id >= ${page.after.channelId}::uuid)`);
    }
  }
  const limit = page.limit != null ? sql` LIMIT ${page.limit}` : sql``;
  if (page.shape === "actor") {
    return sql`
    SELECT (surface.position - 1) AS "position", ${tasks.id}::text AS "taskId", ${serverTaskSortKeyText(sort, key)} AS "sortKey"
    FROM ${serverTaskSurfaceSource(surfaces)}
    JOIN ${tasks} ON ${and(...conditions)}
    ORDER BY ${key} ${dir}, ${tasks.id} ${dir}, surface.local_id ${dir}${limit}
  `;
  }
  return sql`
    SELECT (surface.position - 1) AS "position", picked.id::text AS "taskId", picked.sort_key AS "sortKey"
    FROM ${serverTaskSurfaceSource(surfaces)}
    CROSS JOIN LATERAL (
      SELECT ${tasks.id} AS id, ${key} AS sort_value, ${serverTaskSortKeyText(sort, key)} AS sort_key
      FROM ${tasks}
      WHERE ${and(...conditions)}
      ORDER BY ${key} ${dir}, ${tasks.id} ${dir}${limit}
    ) AS picked
    ORDER BY picked.sort_value ${dir}, picked.id ${dir}, surface.local_id ${dir}${limit}
  `;
}

/** sortedServerTaskRowsQuery for a board read: the filters' conditions and shape. Exported for the EXPLAIN tests. */
export function sortedServerTaskPageQuery(
  surfaces: TaskChannelSurface[],
  statusFilter: TaskStatus | undefined,
  filters: ServerTaskFilters | undefined,
  userId: string,
  sort: ServerTaskSort,
  page: { after?: ServerTasksSortedCursor | null; limit?: number },
): SQL {
  return sortedServerTaskRowsQuery(surfaces, serverTaskConditions(statusFilter, filters, userId), sort, {
    ...page,
    shape: serverTaskFiltersPinActors(filters) ? "actor" : "per_channel",
  });
}

async function selectSortedServerTaskRows(
  surfaces: TaskChannelSurface[],
  statusFilter: TaskStatus | undefined,
  filters: ServerTaskFilters | undefined,
  userId: string,
  sort: ServerTaskSort,
  page: { after?: ServerTasksSortedCursor | null; limit?: number },
): Promise<SortedServerTaskSurfaceRow[]> {
  if (surfaces.length === 0) return [];
  const result = await getDb().execute(sortedServerTaskPageQuery(surfaces, statusFilter, filters, userId, sort, page));
  return result.rows.map((row) => ({
    position: Number(row.position),
    taskId: String(row.taskId),
    sortKey: String(row.sortKey),
  }));
}

/** The full rows of a sorted page, in its order; a task deleted since the first read drops out. */
async function loadSortedServerTaskRows(picked: readonly SortedServerTaskSurfaceRow[]): Promise<ServerTaskSurfaceRow[]> {
  if (picked.length === 0) return [];
  const rows = await getDb().select().from(tasks).where(inArray(tasks.id, [...new Set(picked.map((row) => row.taskId))]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return picked.flatMap((row) => {
    const task = byId.get(row.taskId);
    return task ? [{ position: row.position, task }] : [];
  });
}

/**
 * Small per-item projection for `detail=summary`: every field a task panel
 * needs to render a row, none of the unbounded text. `description` itself is
 * never selected into this shape; `hasDescription`/`descriptionBytes` let the
 * client decide whether to fetch the full card.
 *
 * `source` is kept for forward compatibility with the pre-P3 union shape; P3
 * reads are canonical-only, so it is always "tasks" today.
 */
export interface ServerTaskSummary {
  id: string;
  readOnlyReason: TaskReadOnlyReason | null;
  messageId: string;
  channelId: string;
  channelName: string | null;
  channelType: "channel" | "private" | "joint" | "dm" | "thread";
  taskNumber: number;
  title: string;
  revision: number;
  status: TaskStatus;
  createdByType: "user" | "agent";
  createdById: string;
  createdByName: string;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** As on the full row: the stored last_activity_at, null on a row last written before it existed. */
  lastActivityAt: string | null;
  /** As on the full row: lastActivityAt ?? updatedAt, the time `sort=activity` orders by. */
  activityAt: string;
  isLegacy: boolean;
  source: "tasks" | "message";
  hasDescription: boolean;
  descriptionBytes: number;
  /** As on the full row: the task v2 source message, else a pre-v2 task's host message. */
  sourceMessageId: string | null;
  /** As on the full row: whether `sourceMessageId` is a real source (false: "Source not recorded"). */
  sourceRecorded: boolean;
  /**
   * Who sent the task v2 source message (`tasks.source_message_id`): what the
   * `from_my_message` relation reads, so a client can place a live-updated row
   * in the same tab the server counts it in. Null for a task without one (a
   * pre-v2 task: its `sourceMessageId` above is the host-message fallback),
   * and when that message was deleted or retracted.
   */
  sourceSenderType: "user" | "agent" | "external_projection" | null;
  sourceSenderId: string | null;
  /** As on the full row: messages in the task's discussion. */
  conversationReplyCount: number;
}

type ServerTaskSourceSender = { senderType: "user" | "agent" | "external_projection"; senderId: string };

/**
 * Senders of the rows' task v2 source messages, keyed by task id: one
 * primary-key read per page. Deleted (retracted) messages are left out.
 */
async function loadServerTaskSourceSenders(rows: readonly TaskRow[]): Promise<Map<string, ServerTaskSourceSender>> {
  const senders = new Map<string, ServerTaskSourceSender>();
  const sourceIds = [...new Set(rows.map((row) => row.sourceMessageId).filter((id): id is string => Boolean(id)))];
  if (sourceIds.length === 0) return senders;
  const messageRows = await getDb()
    .select({ id: messages.id, senderType: messages.senderType, senderId: messages.senderId })
    .from(messages)
    .where(and(inArray(messages.id, sourceIds), isNull(messages.deletedAt)));
  const byMessage = new Map(messageRows.map((row) => [row.id, row]));
  for (const row of rows) {
    const message = row.sourceMessageId ? byMessage.get(row.sourceMessageId) : undefined;
    if (message) senders.set(row.id, { senderType: message.senderType, senderId: message.senderId });
  }
  return senders;
}

function toServerTaskSummary(task: ServerTaskListItem, sourceSender: ServerTaskSourceSender | undefined): ServerTaskSummary {
  const descriptionBytes = task.description ? Buffer.byteLength(task.description, "utf8") : 0;
  return {
    id: task.id,
    readOnlyReason: task.readOnlyReason,
    messageId: task.messageId,
    channelId: task.channelId,
    channelName: task.channelName ?? null,
    channelType: task.channelType,
    taskNumber: task.taskNumber,
    title: task.title,
    revision: task.revision,
    status: task.status,
    createdByType: task.createdByType,
    createdById: task.createdById,
    createdByName: task.createdByName,
    claimedByType: task.claimedByType,
    claimedById: task.claimedById,
    claimedByName: task.claimedByName,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastActivityAt: task.lastActivityAt,
    activityAt: task.activityAt,
    isLegacy: task.isLegacy,
    source: "tasks",
    hasDescription: descriptionBytes > 0,
    descriptionBytes,
    sourceMessageId: task.sourceMessageId,
    sourceRecorded: task.sourceRecorded,
    sourceSenderType: sourceSender?.senderType ?? null,
    sourceSenderId: sourceSender?.senderId ?? null,
    conversationReplyCount: task.conversationReplyCount,
  };
}

/**
 * Paginated / summary read over exactly the same visibility set as
 * `listServerTasks` (listServerTaskBoardChannelIds, joint storage projection,
 * same status filter). Anything this returns is a subset of what the legacy
 * read returns, in the same order.
 *
 * Differences from the legacy read, all opt-in from the route:
 * - `limit` bounds the page; one extra row (limit + 1 in the single tasks
 *   query) is the page-boundary witness whose existence sets nextCursor.
 * - `cursor` resumes strictly after a previous page's last item. A cursor
 *   naming a channel that has fallen out of the visible set (archived,
 *   deleted, access revoked) cannot be positioned in the total order, so the
 *   walk refuses it: returns "invalid cursor" for the route to map to 400.
 *   The client's remedy is to restart pagination from the beginning.
 * - `detail: "summary"` projects each item down to `ServerTaskSummary`.
 * - `filters` (ServerTaskFilters) narrow the rows; `countServerTasks` counts
 *   the same rows. `filters.channelIds` narrows the walk's channels, so a
 *   cursor from a walk with other channel filters may be refused as above.
 * - `sort` walks the same rows in another order (listSortedServerTasksPage),
 *   with its own cursor shape; a cursor of another walk is "invalid cursor".
 */
export async function listServerTasksPage(
  serverId: string,
  statusFilter: TaskStatus | undefined,
  userId: string,
  options: {
    limit?: number;
    cursor?: ServerTasksPageCursor | ServerTasksSortedCursor | null;
    detail: "full" | "summary";
    filters?: ServerTaskFilters;
    /** A sorted walk (SERVER_TASK_SORTS); absent = the (channel, task number) walk. */
    sort?: ServerTaskSort;
  },
): Promise<{ tasks: (ServerTaskListItem | ServerTaskSummary)[]; nextCursor: ServerTasksPageCursor | ServerTasksSortedCursor | null } | "invalid cursor"> {
  // A cursor resumes only the walk that produced it: a (channel, number)
  // cursor under a sort, a sorted one without it or under another sort, is
  // refused rather than read as a position in a different order.
  const sortedCursor = options.cursor && isServerTasksSortedCursor(options.cursor) ? options.cursor : null;
  if (options.cursor && (options.sort ? sortedCursor?.sort !== options.sort : sortedCursor)) {
    return "invalid cursor";
  }
  if (options.sort) return listSortedServerTasksPage(serverId, statusFilter, userId, options.sort, { ...options, cursor: sortedCursor });
  const cursor = options.cursor as ServerTasksPageCursor | null | undefined;

  const boardChannelIds = narrowServerTaskBoard(await listServerTaskBoardChannelIds(serverId, userId), options.filters?.channelIds);

  // A cursor naming a channel outside the board can be refused before any
  // surface work.
  if (cursor && !boardChannelIds.includes(cursor.channelId)) {
    return "invalid cursor";
  }
  const surfaces = await resolveOrderedTaskSurfaces(serverId, boardChannelIds);

  let after: { position: number; taskNumber: number } | null = null;
  if (cursor) {
    // Visible surfaces keep the candidate order, so the cursor channel's index
    // among them is its position in the total order. Not visible (access
    // revoked, no task surface) => unknowable position => refuse.
    const position = surfaces.findIndex((surface) => surface.localChannel.id === cursor.channelId);
    if (position === -1) return "invalid cursor";
    after = { position, taskNumber: cursor.taskNumber };
  }

  const limit = options.limit;
  // `limit + 1`: the extra row is the witness for "another page exists" and
  // is never emitted on this page.
  const rows = await selectServerTaskRows(surfaces, serverTaskConditions(statusFilter, options.filters, userId), {
    after,
    limit: limit != null ? limit + 1 : undefined,
  });
  const hasMore = limit != null && rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = await projectServerTaskRows(surfaces, pageRows);

  // The cursor resumes against `serverChannels`, whose ids are this server's
  // local channel ids — the same ids projection puts on the items — so the
  // last emitted item's (channelId, taskNumber) is directly replayable.
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? { channelId: last.channelId, taskNumber: last.taskNumber }
    : null;

  if (options.detail === "summary") {
    const sourceSenders = await loadServerTaskSourceSenders(pageRows.map((row) => row.task));
    return { tasks: items.map((item) => toServerTaskSummary(item, sourceSenders.get(item.id))), nextCursor };
  }
  return { tasks: items, nextCursor };
}

/**
 * listServerTasksPage's sorted walk: the same board, filters, enrichment and
 * page contract, in `sort`'s order (SERVER_TASK_SORTS). Its cursor is
 * ServerTasksSortedCursor.
 */
async function listSortedServerTasksPage(
  serverId: string,
  statusFilter: TaskStatus | undefined,
  userId: string,
  sort: ServerTaskSort,
  options: {
    limit?: number;
    cursor: ServerTasksSortedCursor | null;
    detail: "full" | "summary";
    filters?: ServerTaskFilters;
  },
): Promise<{ tasks: (ServerTaskListItem | ServerTaskSummary)[]; nextCursor: ServerTasksSortedCursor | null }> {
  const boardChannelIds = narrowServerTaskBoard(await listServerTaskBoardChannelIds(serverId, userId), options.filters?.channelIds);
  const surfaces = await resolveOrderedTaskSurfaces(serverId, boardChannelIds);
  const limit = options.limit;
  // `limit + 1`: the extra row is the witness for "another page exists".
  const picked = await selectSortedServerTaskRows(surfaces, statusFilter, options.filters, userId, sort, {
    after: options.cursor,
    limit: limit != null ? limit + 1 : undefined,
  });
  const hasMore = limit != null && picked.length > limit;
  const pagePicked = hasMore ? picked.slice(0, limit) : picked;
  const pageRows = await loadSortedServerTaskRows(pagePicked);
  const items = await projectServerTaskRows(surfaces, pageRows);

  // From the ordered read itself, not the reloaded row: a write between the
  // two reads must not move the resume point.
  const last = pagePicked[pagePicked.length - 1];
  const nextCursor = hasMore && last
    ? { sort, key: sort === "number" ? Number(last.sortKey) : last.sortKey, taskId: last.taskId, channelId: surfaces[last.position]!.localChannel.id }
    : null;

  if (options.detail === "summary") {
    const sourceSenders = await loadServerTaskSourceSenders(pageRows.map((row) => row.task));
    return { tasks: items.map((item) => toServerTaskSummary(item, sourceSenders.get(item.id))), nextCursor };
  }
  return { tasks: items, nextCursor };
}

/**
 * Task v2: reply count of each task's discussion, one grouped query per kind:
 *  - a task with its own conversation (`conversation_channel_id`): chat
 *    messages in it (lifecycle lines are system rows and do not count);
 *  - a pre-v2 task without one: replies in its host message's thread (the
 *    discussion it has had so far, flag off or not yet moved).
 * Keyed by task id; tasks without a discussion are absent (0).
 */
async function loadTaskConversationReplyCounts(
  rows: readonly (typeof tasks.$inferSelect)[],
  db: DatabaseExecutor,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const conversationIds = [...new Set(rows.map((t) => t.conversationChannelId).filter((id): id is string => Boolean(id)))];
  if (conversationIds.length > 0) {
    const countRows = await db
      .select({ channelId: messages.channelId, replyCount: sql<number>`count(${messages.id})::int` })
      .from(messages)
      .where(and(inArray(messages.channelId, conversationIds), eq(messages.messageType, "chat")))
      .groupBy(messages.channelId);
    const byConversation = new Map(countRows.map((row) => [row.channelId, Number(row.replyCount)]));
    for (const t of rows) {
      if (t.conversationChannelId) counts.set(t.id, byConversation.get(t.conversationChannelId) ?? 0);
    }
  }
  const hostIds = [...new Set(rows.filter((t) => !t.conversationChannelId).map((t) => t.messageId).filter((id): id is string => Boolean(id)))];
  if (hostIds.length > 0) {
    const countRows = await db
      .select({
        parentMessageId: channels.parentMessageId,
        replyCount: sql<number>`count(${messages.id})::int`,
      })
      .from(channels)
      .innerJoin(messages, eq(messages.channelId, channels.id))
      .where(and(
        inArray(channels.parentMessageId, hostIds),
        eq(channels.type, "thread"),
        isNull(channels.deletedAt),
      ))
      .groupBy(channels.parentMessageId);
    const byHost = new Map(countRows.map((row) => [row.parentMessageId, Number(row.replyCount)]));
    for (const t of rows) {
      if (!t.conversationChannelId && t.messageId) counts.set(t.id, byHost.get(t.messageId) ?? 0);
    }
  }
  return counts;
}

/**
 * Enrich canonical `tasks` rows with creator/claimer names.
 *
 * v1.4: this table is no longer "the legacy table" — it is where every task
 * fact lives. `isLegacy` therefore stops meaning "which table did this come
 * from" and means what the UI actually branches on: **does this task have a
 * host message?** A task with a `messageId` opens its thread like any other;
 * a task without one is a true pre-message-task orphan and stays read-only.
 * Keying it on the table instead would have flipped every new v1.4 task to the
 * LEGACY badge / read-only CLI marker / LegacyTaskPanel.
 */
/**
 * Pre-v2 tasks (a host message) whose source is a real request, keyed by task
 * id; every other pre-v2 task has no recorded source (see sourceRecordedOf).
 *
 * A pre-v2 task's source is its host message (`source_message_id` = the host,
 * or NULL before migration 0420; read-time fallback). That host is a real
 * source when an existing message was converted into the task: its `created`
 * event says `convertedFromMessage` (convertMessageToTask, send-as-task). A
 * direct create posted the title as a brand-new message: the "source" is the
 * task's own echo, so nothing that asked for the work was recorded. A task with
 * no `created` event (legacy message tasks folded into the table) falls back to
 * the host's sender: someone else's message was converted; the creator's own
 * message is read as the echo.
 */
async function loadPreV2RecordedSources(rows: readonly (typeof tasks.$inferSelect)[], db: DatabaseExecutor): Promise<Set<string>> {
  const recorded = new Set<string>();
  const hosted = rows.filter(isPreV2HostedSource);
  if (hosted.length === 0) return recorded;
  const ids = hosted.map((row) => row.id);
  const events = await db
    .select({ taskId: taskEvents.taskId, converted: sql<boolean>`COALESCE(${taskEvents.payload} ->> 'convertedFromMessage' = 'true', false)` })
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, ids), eq(taskEvents.eventType, "created")));
  const withEvent = new Set<string>();
  for (const event of events) {
    withEvent.add(event.taskId);
    if (event.converted) recorded.add(event.taskId);
  }
  const eventless = hosted.filter((row) => !withEvent.has(row.id));
  if (eventless.length > 0) {
    const hosts = await db
      .select({ id: messages.id, senderType: messages.senderType, senderId: messages.senderId })
      .from(messages)
      .where(inArray(messages.id, eventless.map((row) => row.messageId!)));
    const byId = new Map(hosts.map((host) => [host.id, host]));
    for (const row of eventless) {
      const host = byId.get(row.messageId!);
      if (host && !(host.senderType === row.createdByType && host.senderId === row.createdById)) recorded.add(row.id);
    }
  }
  return recorded;
}

/**
 * Whether a task has a recorded source, the message that asked for the work
 * ("A task must always have a source", #wg-task-v2:#23). A task v2 task has
 * one when `source_message_id` is set (agents and the web always set it now;
 * older ones may have none). A pre-v2 task: loadPreV2RecordedSources, read
 * only where task v2 is on; with the flag off its host stays its source.
 */
function sourceRecordedOf(
  row: typeof tasks.$inferSelect,
  preV2Recorded: ReadonlySet<string>,
  taskV2Servers: ReadonlySet<string>,
  serverId: string | undefined,
): boolean {
  if (isPreV2HostedSource(row)) {
    // Flag off: a pre-v2 task's host stands for its source, as before.
    if (!serverId || !taskV2Servers.has(serverId)) return true;
    return preV2Recorded.has(row.id);
  }
  return row.sourceMessageId !== null;
}

/** A pre-v2 task whose source is its host message (or unset: read-time fallback to it). */
function isPreV2HostedSource(row: typeof tasks.$inferSelect): boolean {
  return Boolean(row.messageId) && (row.sourceMessageId === null || row.sourceMessageId === row.messageId);
}

async function enrichTaskRows(
  rows: (typeof tasks.$inferSelect)[],
  executor: DatabaseExecutor = getDb(),
  options: { includeCurrentProjection?: boolean; failClosedCurrentProjection?: boolean } = {},
) {
  if (rows.length === 0) return [];
  // Callers inside a transaction MUST pass `tx`: the assigned-create path holds
  // a channel advisory lock, and enriching over a second connection deadlocks
  // against it. This mirrors enrichWithNames' executor parameter.
  const db = executor;

  const userIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const t of rows) {
    if (t.createdByType === "user") userIds.add(t.createdById);
    else agentIds.add(t.createdById);
    if (t.claimedById) {
      if (t.claimedByType === "user") userIds.add(t.claimedById);
      else agentIds.add(t.claimedById);
    }
  }

  const nameMap = new Map<string, string>();
  const handleMap = new Map<string, string>();
  const agentPresenceMap = new Map<string, { serverId: string; deletedAt: Date | null }>();
  const channelIds = [...new Set(rows.map((t) => t.channelId))];
  const channelMap = new Map<string, {
    name: string;
    serverId: string;
    type: TaskChannelType;
  }>();

  if (userIds.size > 0) {
    const userRows = await db
      .select({ id: users.id, name: users.name, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const u of userRows) {
      nameMap.set(u.id, u.displayName || u.name || "User");
      handleMap.set(u.id, u.name || "User");
    }
  }

  if (agentIds.size > 0) {
    const agentRows = await db
      .select({
        id: agents.id,
        serverId: agents.serverId,
        name: agents.name,
        displayName: agents.displayName,
        deletedAt: agents.deletedAt,
      })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]));
    for (const a of agentRows) {
      nameMap.set(a.id, a.displayName || a.name || "Agent");
      handleMap.set(a.id, a.name || "Agent");
      agentPresenceMap.set(a.id, { serverId: a.serverId, deletedAt: a.deletedAt });
    }
  }

  if (channelIds.length > 0) {
    const channelRows = await db
      .select({ id: channels.id, name: channels.name, serverId: channels.serverId, type: channels.type })
      .from(channels)
      .where(inArray(channels.id, channelIds));
    for (const channel of channelRows) {
      channelMap.set(channel.id, {
        name: channel.name,
        serverId: channel.serverId,
        type: asTaskChannelType(channel.type),
      });
    }
  }

  // Preserve a historical creator handle for audit context, but carry a
  // separate membership fact so renderers do not present a dangling reference
  // exactly like a live mention token. Joint tasks live on canonical storage
  // channels shared by multiple servers, so their membership fact comes from
  // the union of active local projections rather than the storage server.
  const canonicalJointChannelIds = new Set<string>();
  const jointIdByCanonicalChannel = new Map<string, string>();
  if (channelIds.length > 0) {
    const jointRows = await db
      .select({ id: jointChannels.id, canonicalChannelId: jointChannels.canonicalChannelId })
      .from(jointChannels)
      .where(inArray(jointChannels.canonicalChannelId, channelIds));
    for (const row of jointRows) {
      canonicalJointChannelIds.add(row.canonicalChannelId);
      jointIdByCanonicalChannel.set(row.canonicalChannelId, row.id);
    }
  }

  const activeJointCreatorKeys = new Set<string>();
  const jointIds = [...jointIdByCanonicalChannel.values()];
  if (jointIds.length > 0 && userIds.size > 0) {
    const permission=await resolveJointHumanEntrySql({jointIds},db);
    const jointHumanRows = await db
      .select({
        canonicalChannelId: jointChannels.canonicalChannelId,
        userId: users.id,
      })
      .from(jointChannels)
      .innerJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.status, "active"),
      ))
      .innerJoin(users,inArray(users.id,[...userIds]))
      .where(and(
        permission(jointChannelServers.localChannelId,users.id),
        inArray(jointChannels.id, jointIds),
        eq(jointChannels.status, "active"),
      ));
    for (const membership of jointHumanRows) {
      activeJointCreatorKeys.add(`${membership.canonicalChannelId}:user:${membership.userId}`);
    }
  }
  if (jointIds.length > 0 && agentIds.size > 0) {
    const jointAgentRows = await db
      .select({
        canonicalChannelId: jointChannels.canonicalChannelId,
        agentId: channelAgents.agentId,
      })
      .from(jointChannels)
      .innerJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.status, "active"),
      ))
      .innerJoin(channelAgents, and(
        eq(channelAgents.channelId, jointChannelServers.localChannelId),
        inArray(channelAgents.agentId, [...agentIds]),
      ))
      .where(and(
        sql`NOT (${jointMembershipRemovalPendingSql(jointChannels.id,"agent",channelAgents.agentId)})`,
        inArray(jointChannels.id, jointIds),
        eq(jointChannels.status, "active"),
      ));
    for (const membership of jointAgentRows) {
      activeJointCreatorKeys.add(`${membership.canonicalChannelId}:agent:${membership.agentId}`);
    }
  }

  const membershipServerIds = [...new Set(
    [...channelMap.entries()]
      .filter(([channelId, channel]) => (
        channel.type !== "joint" && !canonicalJointChannelIds.has(channelId)
      ))
      .map(([, channel]) => channel.serverId),
  )];
  const activeHumanMembershipKeys = new Set<string>();
  const humanDepartureReasonByKey = new Map<string, "left" | "removed">();
  if (userIds.size > 0 && membershipServerIds.length > 0) {
    const membershipRows = await db
      .select({ serverId: serverMembers.serverId, userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(
        inArray(serverMembers.serverId, membershipServerIds),
        inArray(serverMembers.userId, [...userIds]),
      ));
    for (const membership of membershipRows) {
      activeHumanMembershipKeys.add(`${membership.serverId}:${membership.userId}`);
    }

    const departureRows = await db
      .select({
        serverId: serverMembershipDepartures.serverId,
        userId: serverMembershipDepartures.userId,
        reason: serverMembershipDepartures.reason,
      })
      .from(serverMembershipDepartures)
      .where(and(
        inArray(serverMembershipDepartures.serverId, membershipServerIds),
        inArray(serverMembershipDepartures.userId, [...userIds]),
      ));
    for (const departure of departureRows) {
      humanDepartureReasonByKey.set(
        `${departure.serverId}:${departure.userId}`,
        departure.reason,
      );
    }
  }

  type CreatorMembershipStatus = "active" | "left" | "removed" | null;
  const creatorMembershipStatus = (task: typeof tasks.$inferSelect): CreatorMembershipStatus => {
    const channel = channelMap.get(task.channelId);
    if (!channel || channel.type === "joint") {
      return null;
    }
    if (canonicalJointChannelIds.has(task.channelId)) {
      const key = `${task.channelId}:${task.createdByType}:${task.createdById}`;
      const profileIsActive = task.createdByType === "user"
        || agentPresenceMap.get(task.createdById)?.deletedAt === null;
      return activeJointCreatorKeys.has(key) && profileIsActive ? "active" : "removed";
    }
    if (task.createdByType === "user") {
      const key = `${channel.serverId}:${task.createdById}`;
      return activeHumanMembershipKeys.has(key)
        ? "active"
        : (humanDepartureReasonByKey.get(key) ?? "removed");
    }
    const agent = agentPresenceMap.get(task.createdById);
    return agent?.serverId === channel.serverId && agent.deletedAt === null
      ? "active"
      : "removed";
  };

  // Server-wide task lists omit the current-text projection: it duplicates
  // title/description (and costs a task_events scan) and no list consumer
  // reads it. Single-channel boards and task payloads keep it.
  const includeCurrentProjection = options.includeCurrentProjection ?? true;
  const currentProjections = includeCurrentProjection
    ? await loadTaskCurrentProjectionsByTaskId(rows, db, { failClosed: options.failClosedCurrentProjection })
    : new Map<string, never>();
  const conversationReplyCounts = await loadTaskConversationReplyCounts(rows, db);
  // Only where task v2 is on (the task's channel's server) is a pre-v2 echo
  // "not recorded"; flag-off servers keep the host as the source, unread.
  const hostedServerIds = [...new Set(rows.filter(isPreV2HostedSource).flatMap((t) => {
    const serverId = channelMap.get(t.channelId)?.serverId;
    return serverId ? [serverId] : [];
  }))];
  const taskV2Servers = new Set<string>();
  for (const serverId of hostedServerIds) {
    if (await isTaskV2ConversationsEnabled(serverId, db)) taskV2Servers.add(serverId);
  }
  const preV2RecordedSources = await loadPreV2RecordedSources(
    rows.filter((t) => isPreV2HostedSource(t) && taskV2Servers.has(channelMap.get(t.channelId)?.serverId ?? "")),
    db,
  );

  return rows.map((t) => ({
    id: t.id,
    // Pre-v2 host message (thread = earlier discussion). Task v2 tasks have
    // none; the id fallback keeps the field's pre-v2 shape for old clients.
    messageId: t.messageId || t.id,
    /** The real `tasks.message_id` (null for task v2 tasks). */
    hostMessageId: t.messageId ?? null,
    // A task from before task v2 hangs under its host message (read-time
    // fallback: the task_source_message_id migration does not backfill).
    sourceMessageId: t.sourceMessageId ?? t.messageId ?? null,
    /**
     * Whether `sourceMessageId` is a real source, the message that asked for
     * the work. False for a task created without one, and for a pre-v2 task
     * whose "source" is the message it was posted as (its own echo): clients
     * show "Source not recorded" (sourceRecordedOf).
     */
    sourceRecorded: sourceRecordedOf(t, preV2RecordedSources, taskV2Servers, channelMap.get(t.channelId)?.serverId),
    conversationReplyCount: conversationReplyCounts.get(t.id) ?? 0,
    /**
     * Task v2: the task's own (canonical) conversation, channels.type =
     * 'task'. Null for a pre-v2 task that has not been written to since task
     * v2 (its discussion is still `messageId`'s thread) and for every task on
     * a flag-off server. A joint surface resolves its local conversation via
     * POST /api/tasks/:id/conversation.
     */
    conversationChannelId: t.conversationChannelId ?? null,
    /**
     * Task v2: the discussion is the task's own conversation — it exists
     * (conversationChannelId != null) or will be created on first use
     * (ownConversation, conversationChannelId still null).
     */
    conversationAnchored: t.conversationChannelId != null || t.ownConversation,
    channelId: t.channelId,
    channelName: channelMap.get(t.channelId)?.name ?? null,
    channelType: channelMap.get(t.channelId)?.type ?? "channel",
    taskNumber: t.taskNumber,
    title: t.title,
    description: t.description,
    status: t.status as TaskStatus,
    createdByType: t.createdByType,
    createdById: t.createdById,
    createdByName: nameMap.get(t.createdById) || "Unknown",
    /** The creator's handle (`createdByName` is the display name); null when unresolved. */
    createdByHandle: handleMap.get(t.createdById) ?? null,
    createdByMembershipStatus: creatorMembershipStatus(t),
    claimedByType: t.claimedByType ?? null,
    claimedById: t.claimedById ?? null,
    claimedByName: t.claimedById ? handleMap.get(t.claimedById) || "Unknown" : null,
    claimedAt: t.claimedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    requiresResourceReceipt: t.requiresResourceReceipt,
    resourceReceipt: t.resourceReceipt,
    resourceReceiptRecordedAt: t.resourceReceiptRecordedAt?.toISOString() ?? null,
    resourceTeardownOwnerAgentId: t.resourceTeardownOwnerAgentId,
    resourceExpiryFollowupId: t.resourceExpiryFollowupId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    /** The stored `last_activity_at`; null for a row last written before that column existed. */
    lastActivityAt: t.lastActivityAt?.toISOString() ?? null,
    /** The board's activity time, what `sort=activity` orders by: lastActivityAt, else updatedAt (taskActivityAt). */
    activityAt: (t.lastActivityAt ?? t.updatedAt).toISOString(),
    revision: t.revision,
    ...(includeCurrentProjection ? { taskCurrentProjection: currentProjections.get(t.id) } : {}),
    // A true pre-message-task orphan: neither a host message nor its own
    // conversation. Task v2 tasks (no host message) are not legacy.
    isLegacy: t.messageId == null && t.conversationChannelId == null && !t.ownConversation,
  }));
}

/** A task row from the canonical `tasks` table. */
export type TaskRow = typeof tasks.$inferSelect;

/**
 * Which table owns a given task. Every mutation resolves this first and then
 * writes to exactly that side — this is the invariant that keeps a task from
 * having two sources of truth during the mixed window. Canonical `tasks` always
 * wins: once a task exists there (new v1.4 task, or a backfilled old one), the
 * legacy `messages.task_*` columns are a stale shadow and are never written
 * again.
 */
/**
 * P3: canonical-only. The `{ source: "message" }` variant is gone -- after the
 * 2026-07-31 prod backfill no task exists on the message side without a
 * canonical row, and both creation paths have been canonical-only since v1.4.
 * The union is kept as a single-variant object rather than a bare TaskRow so
 * call sites that already destructure `.row` / `.source` keep compiling and the
 * shape stays open if a second source is ever reintroduced deliberately.
 */
export type TaskOwner = { source: "tasks"; row: TaskRow };

async function selectCanonicalTask(where: SQL | undefined): Promise<TaskRow | null> {
  try {
    const [row] = await getDb().select().from(tasks).where(where);
    return row ?? null;
  } catch (err) {
    console.error("[taskService] canonical task lookup failed:", err);
    return null;
  }
}

/** Resolve a task by its own id. */
export async function resolveTaskById(taskId: string): Promise<TaskOwner | null> {
  if (!UUID_RE.test(taskId)) return null;
  const canonical = await selectCanonicalTask(eq(tasks.id, taskId));
  return canonical ? { source: "tasks", row: canonical } : null;
}

/** Resolve a task by channel + per-channel task number. */
export async function resolveTaskByNumber(
  channelId: string,
  taskNumber: number,
): Promise<TaskOwner | null> {
  const canonical = await selectCanonicalTask(
    and(conversionReadChannelPredicate(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)),
  );
  return canonical ? { source: "tasks", row: canonical } : null;
}

/** Resolve a task by the id of its host message. */
export async function resolveTaskByMessageId(messageId: string): Promise<TaskOwner | null> {
  if (!UUID_RE.test(messageId)) return null;
  const canonical = await selectCanonicalTask(eq(tasks.messageId, messageId));
  return canonical ? { source: "tasks", row: canonical } : null;
}

/**
 * What "claim by message id" means under task v2, where one chat message can
 * carry several tasks (`tasks.source_message_id`):
 *  - the id names exactly one task — a pre-v2 host message (`message_id`) or
 *    a source message with a single task → claim that task;
 *  - a source message carrying several tasks → ambiguous: the caller must
 *    name one by number (`taskNumbers` ascending);
 *  - no task → the caller keeps the convert-to-task behavior.
 * Callers resolve the message inside the target channel first; task links
 * are keyed by message id alone (like `resolveTaskByMessageId`).
 */
export type TaskClaimByMessageTarget =
  | { kind: "task"; owner: TaskOwner }
  | { kind: "ambiguous"; tasks: TaskRow[]; taskNumbers: number[] }
  | { kind: "none" };

export async function resolveClaimTargetByMessageId(messageId: string): Promise<TaskClaimByMessageTarget> {
  if (!UUID_RE.test(messageId)) return { kind: "none" };
  // A chat message matches the task it hosts (pre-v2 / converted) plus every
  // task hanging under it (`source_message_id`); a converted host is both.
  const rows = await getDb()
    .select()
    .from(tasks)
    .where(or(eq(tasks.messageId, messageId), eq(tasks.sourceMessageId, messageId)))
    .orderBy(asc(tasks.taskNumber));
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) return { kind: "task", owner: { source: "tasks", row: rows[0]! } };
  return { kind: "ambiguous", tasks: rows, taskNumbers: rows.map((row) => row.taskNumber) };
}

/** Claim rejection for a message that carries several tasks. */
export function describeAmbiguousClaimByMessage(taskNumbers: readonly number[]): string {
  return `message has ${taskNumbers.length} tasks (${taskNumbers.map((n) => `#${n}`).join(", ")}) — claim one with --number`;
}

/** Get a single message-task by ID (message ID where taskStatus is not null). */
export async function getTask(taskId: string) {
  return (await resolveTaskById(taskId))?.row ?? null;
}

/**
 * True for a pre-thread orphan: a canonical row with no host message.
 *
 * These predate the task↔message association, so they have no thread to
 * discuss a change in and no chat surface to show it on. stdrc's ruling for the
 * mixed window (2026-07-27) is that they stay read-only until tasks get their
 * own discussion channel.
 */
function isOrphanTask(owner: TaskOwner): boolean {
  // P3: `owner.source` is always "tasks", so an orphan is simply a canonical
  // row with no host message.
  // Task v2: a task with its own conversation has a place to discuss changes.
  // Task v2 tasks own their (lazily created) conversation before it exists.
  return owner.row.messageId == null && owner.row.conversationChannelId == null && !owner.row.ownConversation;
}

/**
 * Get a single task by channel ID + task number, from whichever side owns it.
 *
 * Agent-surface only — every caller is an agent task route. Orphans are
 * deliberately invisible here: before v1.4 this read `messages` alone, so an
 * orphan simply had no row and the agent endpoints answered "task not found".
 * Ownership routing made them reachable for the first time, which silently gave
 * agents write access to tasks the product treats as read-only. Returning null
 * keeps the agent-facing answer byte-identical to the pre-migration one.
 *
 * This is not the human REST path — that one resolves orphans through
 * `requireTaskInServer` and has always been able to write them.
 */
export async function getTaskByNumber(channelId: string, taskNumber: number) {
  const owner = await resolveTaskByNumber(channelId, taskNumber);
  if (!owner || isOrphanTask(owner)) return null;
  return owner.row;
}

/**
 * Task v2, per-task mode (./taskV2Mode): which of these task numbers in the
 * channel are v2 tasks (created the v2 way, or already with a conversation).
 */
export async function listV2TaskNumbers(channelId: string, taskNumbers: readonly number[]): Promise<Set<number>> {
  const numbers = [...new Set(taskNumbers)];
  if (numbers.length === 0) return new Set();
  const rows = await getDb()
    .select({ taskNumber: tasks.taskNumber, ownConversation: tasks.ownConversation, conversationChannelId: tasks.conversationChannelId })
    .from(tasks)
    .where(and(eq(tasks.channelId, channelId), inArray(tasks.taskNumber, numbers)));
  return new Set(rows.filter(isV2Task).map((row) => row.taskNumber));
}

/** Get a canonical `tasks` row by channel ID + task number. */
export async function getLegacyTaskByNumber(channelId: string, taskNumber: number) {
  return selectCanonicalTask(and(conversionReadChannelPredicate(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
}

/**
 * Append a task lifecycle event to the audit trail (v1.4). Ordered by the
 * global `seq`; `created_at` is wall-clock only. actorType `system` carries a
 * null actorId. Payload is event-specific JSON.
 */
async function recordTaskEvent(
  tx: DatabaseExecutor,
  taskRowId: string,
  eventType:
    | "created"
    | "status_changed"
    | "assignee_changed"
    | "reopened"
    | "closed"
    | "resource_receipt_recorded"
    | "amended",
  actorType: "user" | "agent" | "system",
  actorId: string | null,
  payload: Record<string, unknown>,
) {
  const [event] = await tx.insert(taskEvents).values({
    taskId: taskRowId,
    eventType,
    actorType,
    actorId,
    payload,
  }).returning();
  // RFC 077: a person's task change rings their personal assistant (owner action).
  if (actorType === "user" && actorId && OWNER_ACTION_TASK_EVENTS.has(eventType)) {
    await recordAssistantOwnerTaskAction({ actorUserId: actorId, taskRowId }, tx);
  }
  return event;
}

const OWNER_ACTION_TASK_EVENTS = new Set(["status_changed", "reopened", "closed", "assignee_changed"]);

export type TaskAmendPatch = {
  title?: string;
  description?: string | null;
};

export type TaskAmendmentChange = {
  from: string | null;
  to: string | null;
};

export type TaskAmendmentResult = {
  row: TaskRow;
  event: {
    id: string;
    seq: number;
    eventType: "amended";
    actorType: "user" | "agent";
    actorId: string;
    payload: {
      revision: number;
      changes: Partial<Record<"title" | "description", TaskAmendmentChange>>;
    };
    createdAt: Date;
  };
};

export const TASK_AMEND_MEMBERSHIP_ERROR = "only current channel members with post access can amend the card";
/** A stale `expectedRevision` or a lost revision CAS: nothing was written. */
export const TASK_AMEND_STALE_REVISION_ERROR = "task changed concurrently; read the current card and retry";
export const TASK_AMEND_NO_CHANGES_ERROR = "task amendment makes no changes";

async function isTaskAmendActorChannelMember(
  executor: DatabaseExecutor,
  channelId: string,
  requesterType: "user" | "agent",
  requesterId: string,
): Promise<boolean> {
  const [channel] = await executor
    .select({
      id: channels.id,
      serverId: channels.serverId,
      name: channels.name,
      type: channels.type,
    })
    .from(channels)
    .where(and(
      eq(channels.id, channelId),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  if (!channel) return false;

  const actor = { type: requesterType, id: requesterId } satisfies TaskCreationAssignee;
  // Canonical joint-channel storage rows are intentionally member-less. Reuse
  // the existing eligibility lock so amendment authority is the union of live
  // local projections there, while ordinary channels retain their exact local
  // membership check.
  return await lockTaskAssigneeEligibility(executor, channel, actor) === null;
}

/**
 * Amend the current task-card projection while preserving an append-only audit
 * record. The task row is the queryable current view; `task_events` is the
 * immutable history. Both commit in one transaction, and every write is
 * revision-CAS guarded so two editors cannot silently overwrite each other.
 *
 * `expectedRevision` (optional) is the caller's OCC token, as on `assignTask`:
 * when supplied it must match the row read here, so an editor saving over a
 * stale view loses (TASK_AMEND_STALE_REVISION_ERROR) instead of overwriting a
 * concurrent change. Absent (the agent path), the read-then-CAS alone guards.
 */
export async function amendTask(
  taskId: string,
  patch: TaskAmendPatch,
  requesterType: "user" | "agent",
  requesterId: string,
  opts: { expectedRevision?: number; serverId?: string } = {},
): Promise<TaskAmendmentResult | string> {
  const { serverId } = opts;
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  if (owner.source !== "tasks" || isOrphanTask(owner)) {
    return "legacy task cards cannot be amended";
  }

  const observed = owner.row;
  if (!await isTaskAmendActorChannelMember(getDb(), observed.channelId, requesterType, requesterId)) {
    return TASK_AMEND_MEMBERSHIP_ERROR;
  }
  if (opts.expectedRevision !== undefined && opts.expectedRevision !== observed.revision) {
    return TASK_AMEND_STALE_REVISION_ERROR;
  }

  const changes: Partial<Record<"title" | "description", TaskAmendmentChange>> = {};
  const setFields: Partial<typeof tasks.$inferInsert> = {};
  if (patch.title !== undefined && patch.title !== observed.title) {
    changes.title = { from: observed.title, to: patch.title };
    setFields.title = patch.title;
  }
  if (patch.description !== undefined && patch.description !== observed.description) {
    changes.description = { from: observed.description, to: patch.description };
    setFields.description = patch.description;
  }
  if (Object.keys(changes).length === 0) return TASK_AMEND_NO_CHANGES_ERROR;

  await failpoints.hit("server.task.amend.afterAuthorizationRead", {
    taskId,
    requesterType,
    requesterId,
    observedRevision: observed.revision,
  });

  return withTaskWriter(observed, async (tx) => {
    // Membership is the explicit collaboration boundary. Re-lock it inside
    // the write transaction so a member removed after the optimistic read
    // cannot amend with stale authority. Free-text @mentions never grant it.
    if (!await isTaskAmendActorChannelMember(tx, observed.channelId, requesterType, requesterId)) {
      return TASK_AMEND_MEMBERSHIP_ERROR;
    }

    const nextRevision = observed.revision + 1;
    const [updated] = await tx
      .update(tasks)
      .set({
        ...setFields,
        revision: nextRevision,
        updatedAt: new Date(),
        lastActivityAt: TASK_ACTIVITY_NOW,
      })
      .where(canonicalRevisionCas(observed))
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      if (!current) return "task not found";
      return TASK_AMEND_STALE_REVISION_ERROR;
    }

    const payload = { revision: nextRevision, changes };
    const event = await recordTaskEvent(
      tx,
      updated.id,
      "amended",
      requesterType,
      requesterId,
      payload,
    );

    return {
      row: updated,
      event: {
        ...event,
        eventType: "amended" as const,
        actorType: requesterType,
        actorId: requesterId,
        payload,
      },
    };
  }, { type: requesterType, id: requesterId, serverId });
}

export type TaskHistoryEvent = {
  id: string;
  seq: number;
  eventType: string;
  actorType: "user" | "agent" | "system";
  actorName: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** Read the complete append-only lifecycle/amendment history for one task. */
export async function listTaskHistory(taskId: string): Promise<TaskHistoryEvent[] | string> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  if (owner.source !== "tasks" || isOrphanTask(owner)) {
    return "legacy task cards do not have canonical history";
  }

  const db = getDb();
  const rows = await db.select().from(taskEvents)
    .where(eq(taskEvents.taskId, owner.row.id))
    .orderBy(asc(taskEvents.seq));

  const actorNames = new Map<string, string>();
  const userIds = [...new Set(rows.filter((row) => row.actorType === "user" && row.actorId).map((row) => row.actorId!))];
  const agentIds = [...new Set(rows.filter((row) => row.actorType === "agent" && row.actorId).map((row) => row.actorId!))];
  if (userIds.length > 0) {
    const actorRows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds));
    for (const actor of actorRows) actorNames.set(`user:${actor.id}`, actor.name);
  }
  if (agentIds.length > 0) {
    const actorRows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds));
    for (const actor of actorRows) actorNames.set(`agent:${actor.id}`, actor.name);
  }

  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    eventType: row.eventType,
    actorType: row.actorType,
    actorName: row.actorId ? actorNames.get(`${row.actorType}:${row.actorId}`) ?? null : null,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Create one or more tasks in a channel. Returns created tasks with enriched names. */
export async function createTasks(
  channelId: string,
  createdByType: "user" | "agent",
  createdById: string,
  items: TaskCreateItem[],
  opts: {
    /**
     * Runs on the creating transaction after every row is written and before
     * it commits (keyed Agent API writes record their idempotency ledger row
     * here). A rejection rolls the whole creation back.
     */
    beforeCommit?: (
      executor: DatabaseExecutor,
      result: { tasks: Awaited<ReturnType<typeof enrichTaskRows>>; hostMessages: MessageRow[] },
    ) => Promise<void>;
    /**
     * The server whose local channel the request came through (task v2 flag
     * gate). Defaults to the storage channel's server, which is right for
     * every non-joint channel.
     */
    initiatingServerId?: string;
    /**
     * The status every task starts in (`TASK_CREATE_STATUSES`); default todo.
     * An unassigned in_progress task has no claimant, so claimedAt stays null.
     */
    initialStatus?: TaskCreateStatus;
  } = {},
) {
  if (items.length === 0) return { tasks: [], hostMessages: [], hostMessagesVisible: false };
  assertTaskCreateStatus(opts.initialStatus);
  const initialStatus = resolveTaskCreateStatus(opts.initialStatus, "none");
  const db = getDb();

  // Use a transaction with advisory lock on channel to prevent task number collisions
  const created = await withTaskChannelWriter(channelId, async (tx) => {
    await lockJointTaskWriteAuthority(tx, channelId, { type: createdByType, id: createdById, serverId: opts.initiatingServerId });
    // Advisory lock keyed on channel UUID to serialize task number allocation
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${channelId}))`);

    const [channel] = await tx
      .select({
        id: channels.id,
        serverId: channels.serverId,
        name: channels.name,
        type: channels.type,
      })
      .from(channels)
      .where(and(
        eq(channels.id, channelId),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ))
      .for("update");
    if (!channel) throw new Error("Task channel is unavailable");
    // Numbers past every message, task and deleted task (never reused).
    let nextNum = await reserveTaskNumbers(tx, channelId, items.length);

    const initiatingServerId = opts.initiatingServerId ?? channel.serverId;
    const { conversations } = await resolveTaskConversationMode(tx, initiatingServerId, items, initialStatus);
    await assertTaskSourceMessages(tx, channelId, channel.type, items);

    // Task v2 (flag on): no message at all — each task gets its own
    // conversation (channels.type = 'task') below; `source_message_id` = the
    // chat message the task hangs under, if any. Flag off: the pre-v2 visible
    // host message, whose thread is the discussion and which is also the
    // task's source message. The task fact lives only in `tasks` either way.
    const hostMessages = conversations
      ? []
      : await tx.insert(messages).values(taskHostMessageValues(channelId, createdByType, createdById, items)).returning();

    const taskRows: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const host = hostMessages[i] ?? null;
      const [taskRow] = await tx
        .insert(tasks)
        .values({
          channelId,
          taskNumber: nextNum++,
          title: item.title,
          description: item.description ?? null,
          status: initialStatus,
          requiresResourceReceipt: item.createsResource === true,
          createdByType,
          createdById,
          messageId: host?.id ?? null,
          sourceMessageId: host ? host.id : item.sourceMessageId ?? null,
          // Task v2: its discussion is its own (lazily created) conversation.
          ownConversation: conversations,
          lastActivityAt: TASK_ACTIVITY_NOW,
        })
        .returning();
      await recordTaskEvent(tx, taskRow.id, "created", createdByType, createdById, {
        taskNumber: taskRow.taskNumber,
        status: initialStatus,
        requiresResourceReceipt: taskRow.requiresResourceReceipt,
      });
      taskRows.push(taskRow);
    }

    // Task v2: the task's conversation is created lazily, like a thread, by
    // the first action that needs it (reply, follow, lifecycle line, …;
    // taskConversationService.ensureTaskConversation), which also makes the
    // creator and the assignee follow it.

    if (opts.beforeCommit) {
      const enrichedInTransaction = await enrichTaskRows(taskRows, tx);
      await opts.beforeCommit(tx, { tasks: enrichedInTransaction, hostMessages });
      return { hostMessages, taskRows, enrichedInTransaction, conversations };
    }
    return { hostMessages, taskRows, enrichedInTransaction: null, conversations };
  });

  if (!created.conversations) {
    // Pre-v2 visible host messages are channel activity.
    const { recordInboxFactsForPersistedMessages } = await import("./messageService");
    await recordInboxFactsForPersistedMessages(created.hostMessages, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.body",
        reason: "task body messages are durable shared work items and count as channel activity",
      },
      dedupeLogicalReceiverAcrossJointProjections: true,
    });
  }
  // Task v2 (flag on): there is no message, so no inbox fact, and the routes
  // post no `task.created_summary` either — creating a task posts nothing in
  // the channel (spec §2, §4).

  const enrichedTasks = created.enrichedInTransaction ?? await enrichTaskRows(created.taskRows);
  return {
    tasks: enrichedTasks,
    hostMessages: created.hostMessages,
    hostMessagesVisible: !created.conversations,
  };
}

const TASK_SYSTEM_MESSAGE_SUMMARY_MAX = 80;

function summarizeTaskTitle(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= TASK_SYSTEM_MESSAGE_SUMMARY_MAX) return single;
  return single.slice(0, TASK_SYSTEM_MESSAGE_SUMMARY_MAX - 1).trimEnd() + "…";
}

/**
 * Assigned creation is intentionally a separate API: callers cannot reserve
 * task rows without also committing the canonical assignment receipt.
 */
export async function createTasksWithAssignmentReceipt(
  channelId: string,
  createdByType: "user" | "agent",
  createdById: string,
  items: TaskCreateItem[],
  assignee: TaskCreationAssignee,
  receiptRequest: TaskAssignmentReceiptRequest,
  opts: {
    initiatingLocalChannelId?: string;
    /**
     * The status every task starts in (`TASK_CREATE_STATUSES`). Omitted: the
     * behaviour from before statuses could be chosen — assigning yourself
     * starts the work, assigning someone else reserves a todo for them.
     * in_progress for someone else starts it for them (claimedAt stamped, as a
     * start); todo for yourself reserves it for later (claimedAt null), and so
     * does backlog for anyone.
     */
    initialStatus?: TaskCreateStatus;
    /**
     * Runs on the creating transaction after the tasks and the assignment
     * receipt are written and before it commits. A rejection rolls the whole
     * creation back.
     */
    beforeCommit?: (
      executor: DatabaseExecutor,
      result: {
        tasks: Awaited<ReturnType<typeof enrichTaskRows>>;
        hostMessages: MessageRow[];
        assignmentReceipt: TaskAssignmentReceipt | null;
      },
    ) => Promise<void>;
  } = {},
): Promise<{
  tasks: Awaited<ReturnType<typeof enrichTaskRows>>;
  hostMessages: MessageRow[];
  /** Pre-v2 visible host messages (flag off): the caller broadcasts and delivers them. */
  hostMessagesVisible: boolean;
  /**
   * The channel assignment receipt (flag off). Null with task v2
   * conversations on: creating a task posts nothing in the channel, and the
   * caller announces the assignment in each task's own conversation instead
   * (`taskConversationNotice.announceTaskCreationAssignment`), which mentions
   * the assignee exactly like a later assign.
   */
  assignmentReceipt: TaskAssignmentReceipt | null;
}> {
  if (items.length === 0) throw new Error("Assigned task creation requires at least one task");
  assertTaskCreateStatus(opts.initialStatus);
  const db = getDb();

  return withTaskChannelWriter(channelId, async (tx) => {
    const entryServer = opts.initiatingLocalChannelId
      ? (await tx.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id,opts.initiatingLocalChannelId)))[0]?.serverId
      : undefined;
    await lockJointTaskWriteAuthority(tx, channelId, { type: createdByType, id: createdById, serverId: entryServer });
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${channelId}))`);

    // Establish the immutable server/type lookup without taking the channel
    // row lock, then lock identity before channel. deleteAgent takes that same
    // identity -> DM-channel order, so assigned DM creation cannot deadlock it.
    const [channelSnapshot] = await tx
      .select({
        id: channels.id,
        serverId: channels.serverId,
        type: channels.type,
      })
      .from(channels)
      .where(and(
        eq(channels.id, channelId),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ));
    if (!channelSnapshot) throw new Error("Task channel is unavailable");
    const jointRequest = opts.initiatingLocalChannelId !== undefined;
    // A sub-conversation (thread, task conversation) never holds tasks.
    if (isSubConversationType(channelSnapshot.type) || (channelSnapshot.type === "joint" && !jointRequest)) {
      throw new AssignedTaskCreationChannelError();
    }
    if (!jointRequest && !await lockTaskCreationAssigneeIdentity(tx, channelSnapshot.serverId, assignee)) {
      throw new TaskCreationAssigneeEligibilityError();
    }

    // Revalidate the exact active channel server/type under lock before any
    // membership check or durable write.
    const [channel] = await tx
      .select()
      .from(channels)
      .where(and(
        eq(channels.id, channelSnapshot.id),
        eq(channels.serverId, channelSnapshot.serverId),
        eq(channels.type, channelSnapshot.type),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ))
      .for("update");
    if (!channel) throw new Error("Task channel is unavailable");
    let jointRouting: JointAssignmentRouting | null = null;
    if (jointRequest) {
      // Assigned joint creation needs the assignee's reachable local surface
      // as well as eligibility. Resolve and lock both through one query path so
      // the transaction cannot validate one membership shape and route another.
      jointRouting = await resolveJointAssignmentRouting(tx, channelId, opts.initiatingLocalChannelId!, assignee);
      if (!jointRouting) throw new TaskCreationAssigneeEligibilityError();
    } else if (!await lockTaskCreationAssigneeMembership(tx, channel, assignee)) {
      throw new TaskCreationAssigneeEligibilityError();
    }

    // Numbers past every message, task and deleted task (never reused).
    let nextNum = await reserveTaskNumbers(tx, channelId, items.length);
    const selfAssigned = assignee.type === createdByType && assignee.id === createdById;
    const initialStatus = resolveTaskCreateStatus(opts.initialStatus, selfAssigned ? "self" : "other");
    // A task created in progress is started (claimedAt stamped, as a start
    // does), whoever it is assigned to; a todo is reserved, not started.
    const startsAssignedWork = initialStatus === "in_progress";
    const claimedAt = startsAssignedWork ? currentDate() : null;

    // The initiating server gates task v2 (a joint storage channel lives on
    // the shared joint storage server).
    const initiatingServerId = jointRouting
      ? jointRouting.projections.find((projection) => projection.localChannelId === opts.initiatingLocalChannelId)?.serverId
        ?? channel.serverId
      : channel.serverId;
    const { conversations } = await resolveTaskConversationMode(tx, initiatingServerId, items, initialStatus);
    await assertTaskSourceMessages(tx, channelId, channel.type, items);

    // Task v2 (flag on): no message; each task gets its own conversation
    // below. Flag off: the pre-v2 visible host messages (see createTasks).
    // Canonical tasks rows either way; the assignee and status live on the
    // task row.
    const created = conversations
      ? []
      : await tx.insert(messages).values(taskHostMessageValues(channelId, createdByType, createdById, items)).returning();

    const taskRows: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < items.length; i++) {
      const host = created[i] ?? null;
      const [taskRow] = await tx
        .insert(tasks)
        .values({
          channelId,
          taskNumber: nextNum++,
          title: items[i].title,
          description: items[i].description ?? null,
          status: initialStatus,
          requiresResourceReceipt: items[i].createsResource === true,
          createdByType,
          createdById,
          claimedByType: assignee.type,
          claimedById: assignee.id,
          claimedAt,
          messageId: host?.id ?? null,
          sourceMessageId: host ? host.id : items[i].sourceMessageId ?? null,
          // Task v2: its discussion is its own (lazily created) conversation.
          ownConversation: conversations,
          lastActivityAt: TASK_ACTIVITY_NOW,
        })
        .returning();
      await recordTaskEvent(tx, taskRow.id, "created", createdByType, createdById, {
        taskNumber: taskRow.taskNumber,
        status: initialStatus,
        requiresResourceReceipt: taskRow.requiresResourceReceipt,
      });
      await recordTaskEvent(tx, taskRow.id, "assignee_changed", createdByType, createdById, {
        assigneeType: assignee.type,
        assigneeId: assignee.id,
      });
      taskRows.push(taskRow);
    }

    await failpoints.hit("server.task.assignedCreate.afterTaskRows", {
      channelId,
      taskIds: taskRows.map((task) => task.id),
    }, async () => undefined);

    // Task v2 (flag on): nothing is posted in the channel — no host message,
    // no assignment receipt — so the channel gains no activity, and no
    // conversation is created here. The caller announces the assignment in
    // each task's conversation after commit (one personal notification);
    // that first line creates the conversation lazily, and its creation makes
    // the creator (`authored`) and the assignee (`assigned`) follow it.
    if (conversations) {
      const enrichedConversations = await enrichTaskRows(taskRows, tx);
      const conversationResult = {
        tasks: enrichedConversations,
        hostMessages: created,
        hostMessagesVisible: false,
        assignmentReceipt: null,
      };
      if (opts.beforeCommit) await opts.beforeCommit(tx, conversationResult);
      return conversationResult;
    }

    await tx.update(userChannelInboxStates)
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.channelId, channelId),
        isNotNull(userChannelInboxStates.doneAt),
      ));

    // Pre-v2 host messages are channel activity, recorded in this transaction
    // as before; the assignment receipt below is the durable, visible
    // attention record.
    const messageService = await import("./messageService");
    await messageService.recordInboxFactsForPersistedMessages(created, {
      inboxFactPolicy: {
        mode: "record",
        producer: "task.body",
        reason: "task body messages are durable shared work items and count as channel activity",
      },
      executor: tx,
      channel,
      ...(jointRouting && {
        jointProjections: jointRouting.projections,
        recordJointLocalFace: true,
        dedupeLogicalReceiverAcrossJointProjections: true,
      }),
    });
    await failpoints.hit("server.task.assignedCreate.afterTaskFacts", {
      channelId,
      taskIds: created.map((task) => task.id),
    }, async () => undefined);

    // "started" reads "@x started …": only true when the creator started its
    // own work. Starting it for someone else is still their assignment.
    const state = startsAssignedWork && selfAssigned ? "started" as const : "assigned" as const;
    const assigneeRef = `@${receiptRequest.assigneeName}`;
    const taskList = taskRows
      .map((task) => `task #${task.taskNumber} "${summarizeTaskTitle(task.title)}"`)
      .join(", ");
    const receiptContent = state === "started"
      ? `📌 ${assigneeRef} started ${taskRows.length === 1 ? taskList : `${taskRows.length} new tasks: ${taskList}`}`
      : `📌 Assigned ${assigneeRef} to ${taskRows.length === 1 ? taskList : `${taskRows.length} new tasks: ${taskList}`}`;
    const [receiptMessage] = await tx.insert(messages).values({
      channelId,
      senderType: "user",
      senderId: "system",
      messageType: "system",
      content: receiptContent,
      searchText: buildSearchText(receiptContent),
      // born-read causal actor = the task creator (createdBy). "started" is the
      // self-start case (assignee === creator), "assigned" is the assigner; both
      // resolve to createdBy, matching the inbox-fact causal actor below.
      causalActorType: createdByType,
      causalActorId: createdById,
      systemSubtype: "task.assignment_receipt",
    }).returning();
    if (!receiptMessage) throw new Error("Failed to persist task assignment receipt");

    await failpoints.hit("server.task.assignedCreate.afterReceiptRow", {
      channelId,
      receiptMessageId: receiptMessage.id,
    }, async () => undefined);

    await tx.insert(messageMentions).values({
      messageId: receiptMessage.id,
      messageSeq: receiptMessage.seq,
      serverId: jointRouting?.preferredProjection.serverId ?? channel.serverId,
      channelId: jointRouting?.preferredProjection.localChannelId ?? channelId,
      targetType: assignee.type,
      targetId: assignee.id,
      handleAtSendTime: receiptRequest.assigneeName,
      source: "send_path",
      confidence: "exact",
      notifiableAtSend: true,
    });

    await messageService.recordInboxFactsForPersistedMessages(
      [{ message: receiptMessage, causalActor: { type: createdByType, id: createdById } }],
      {
        inboxFactPolicy: {
          mode: "record",
          producer: "task.assignment_receipt",
          reason: "a task assignment is durable directed attention for its assignee",
        },
        executor: tx,
        channel,
        ...(jointRouting && {
          jointProjections: jointRouting.projections,
          recordJointLocalFace: true,
          dedupeLogicalReceiverAcrossJointProjections: true,
        }),
        targetVisibleMentionsByMessageId: new Map([[
          receiptMessage.id,
          [{ type: assignee.type, id: assignee.id, name: receiptRequest.assigneeName }],
      ]]),
    });
    await failpoints.hit("server.task.assignedCreate.afterReceiptFacts", {
      channelId,
      taskIds: created.map((task) => task.id),
      receiptMessageId: receiptMessage.id,
    }, async () => undefined);

    const enriched = await enrichTaskRows(taskRows, tx);
    const result = {
      tasks: enriched,
      hostMessages: created,
      hostMessagesVisible: true,
      assignmentReceipt: {
        message: receiptMessage,
        content: receiptContent,
        assignee: assigneeRef,
        state,
      },
    };
    if (opts.beforeCommit) await opts.beforeCommit(tx, result);
    return result;
  });
}

/** Claim a task (set assignee). Does not require specific status. If status is todo or backlog, auto-advances to in_progress. */
export interface TaskClaimOutcome {
  result: TaskMutationResult;
  /** Present only when the failure was an assignment-held conflict; built by
   *  the authoritative writer from the same observed row as `result`. */
  conflict?: AgentApiTaskClaimConflict;
}

export async function claimTaskDetailed(
  taskId: string,
  claimedByType: "user" | "agent",
  claimedById: string,
  serverId?: string,
): Promise<TaskClaimOutcome> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return { result: "task not found" };
  const written = await withTaskWriter(owner.row, (tx) => writeCanonicalClaim(tx, owner.row, claimedByType, claimedById), { type: claimedByType, id: claimedById, serverId });
  if (isTaskClaimRejection(written)) {
    // Deterministic seam for the temporal-congruence tooth: state may change
    // here (between the writer forming its rejection and this function
    // returning), and the caller must still receive the writer's own
    // observation — never a post-hoc re-read of whatever is current now.
    await failpoints.hit("server.task.claimDetailed.afterRejectionFormed", { taskId }, async () => undefined);
    return { result: written.reason, conflict: written.conflict ?? undefined };
  }
  return { result: { source: "tasks", row: written as TaskRow } };
}

export async function claimTask(
  taskId: string,
  claimedByType: "user" | "agent",
  claimedById: string,
  serverId?: string,
): Promise<TaskMutationResult> {
  return (await claimTaskDetailed(taskId, claimedByType, claimedById, serverId)).result;
}

/**
 * Result of a task mutation.
 *
 * P3: this used to be tagged with the owning side, because a legacy message-task
 * IS a chat message and needed `message:updated`, while a canonical task's host
 * message did not change. Reads are canonical-only now, so the `"message"`
 * variant is unconstructable and has been removed rather than left dangling.
 *
 * That removal is the point, not tidiness: while the variant still existed the
 * compiler happily type-checked dead `source === "message"` branches, which is
 * how `batchClaimTasks` kept a live `messages.task_*` writer through a green
 * build. `source` is kept (rather than collapsing to `TaskRow | string`) so
 * existing call sites and their narrowing stay unchanged.
 */
export type TaskMutationResult =
  | {
    source: "tasks";
    row: TaskRow;
    /**
     * Nothing was written: a status write asked a task v2 task already in
     * in_progress for in_review, which it stores as in_progress. Success
     * for older clients that still send in_review; callers post no
     * lifecycle line for it.
     */
    unchanged?: true;
  }
  | string;

function wrapCanonical(result: TaskRow | string): TaskMutationResult {
  return typeof result === "string" ? result : { source: "tasks", row: result };
}

/** Batch claim tasks by task numbers in a channel. Returns per-task results. */
export async function batchClaimTasks(
  channelId: string,
  taskNumbers: number[],
  claimedByType: "user" | "agent",
  claimedById: string,
  localChannel: Pick<TaskProjectionChannel, "taskReadOnlyBefore"> = {},
): Promise<{
  taskNumber: number;
  success: boolean;
  reason?: string;
  conflict?: AgentApiTaskClaimConflict;
  task?: { source: "tasks"; row: TaskRow };
}[]> {
  const db = getDb();
  const results: Awaited<ReturnType<typeof batchClaimTasks>> = [];

  await withTaskChannelWriter(channelId, async (tx) => {
    for (const num of taskNumbers) {
      // Canonical first: if a `tasks` row owns this number, the message-task
      // columns are a stale shadow and must not be claimed instead.
      const [canonical] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, num)))
        .for("update");

      if (canonical) {
        if (getTaskReadOnlyReason(localChannel, canonical.createdAt)) {
          results.push({ taskNumber: num, success: false, reason: "Historical tasks are read-only from a participant workspace" });
          continue;
        }
        // Orphans stay unreachable from the agent surface — same reason and
        // same wording as `getTaskByNumber`. Before v1.4 this query ran against
        // `messages` alone, so an orphan produced exactly this result.
        // Task v2 tasks have no host message but their own conversation.
        if (canonical.messageId == null && canonical.conversationChannelId == null && !canonical.ownConversation) {
          results.push({ taskNumber: num, success: false, reason: "task not found" });
          continue;
        }
        const claim = await writeCanonicalClaim(tx, canonical, claimedByType, claimedById);
        if (isTaskClaimRejection(claim)) {
          results.push({ taskNumber: num, success: false, reason: claim.reason, ...(claim.conflict ? { conflict: claim.conflict } : {}) });
        } else {
          results.push({ taskNumber: num, success: true, task: { source: "tasks", row: claim } });
        }
        continue;
      }

      // P3: no canonical row means the task does not exist. The former fallback
      // locked `messages` and claimed the message-side shadow via
      // `writeTaskClaim` -- the last live writer of `messages.task_*`. After the
      // 2026-07-31 backfill no task exists only on the message side, so that
      // branch could only ever have claimed a stale shadow.
      //
      // NOTE for reviewers: the compiler did NOT surface this one when
      // `TaskOwner` was narrowed to canonical-only, because this function
      // carries its own local result union that still had a "message" variant.
      // Narrowing the shared type enumerates the sites that flow through it and
      // no others.
      results.push({ taskNumber: num, success: false, reason: "task not found" });
    }
  });

  return results;
}

/** Unclaim a task (remove assignee). Does not change status. Only the assignee can unclaim. */
export async function unclaimTask(
  taskId: string,
  requesterType: "user" | "agent",
  requesterId: string,
  serverId?: string,
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonical(await withTaskWriter(owner.row, (tx) => writeCanonicalUnclaim(tx, owner.row, requesterType, requesterId), { type: requesterType, id: requesterId, serverId }));
}

/**
 * Set or clear a task's assignee.
 *
 * This is the v1.4 successor to "claim", and it is deliberately NOT a superset
 * of it:
 *
 *  - **`claim` assigns self AND advances `todo` or `backlog -> in_progress`.**
 *    Claiming means "I am starting this."
 *  - **`assign` only moves the assignee.** Handing work to someone else must not
 *    assert on their behalf that it has started. This asymmetry is the point,
 *    not an oversight -- see the tests that pin it.
 *
 * `claim`/`unclaim` are retained rather than reimplemented on top of this,
 * because an un-upgraded Computer keeps calling them (@stdrc: 很多用户可能不升级
 * computer). Two entry points, one storage shape.
 *
 * Authorization is capability-based (`assignTasks`, member+) and is checked by
 * the caller, because unlike `unclaim` this MAY act on someone else's task --
 * withdrawing an assignment is exactly what @stdrc asked for. What this function
 * re-asserts in the UPDATE is the state it read: the row is unchanged
 * (`revision`) and the task is not terminal. Per the note on
 * `canonicalRevisionCas`, the token alone is not authorization.
 *
 * `expectedRevision` (optional) is the caller's OCC token. When supplied it must
 * match the row we read, so a client acting on a stale view loses instead of
 * silently overwriting a concurrent assignment.
 */
/** assignTask's refusal of a reason with an unchanged assignee (a backstop; the routes check first). */
export const TASK_ASSIGN_REASON_UNCHANGED_ERROR = TASK_ASSIGN_REASON_UNCHANGED_MESSAGE;

export async function assignTask(
  taskId: string,
  assignee: TaskCreationAssignee | null,
  actorType: "user" | "agent",
  actorId: string,
  opts: {
    expectedRevision?: number;
    serverId?: string;
    /** Handing it to someone else: what it waits on them for, already normalized (`checkTaskAssignReason`). */
    reason?: string;
  } = {},
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  const observed = owner.row;

  if (opts.expectedRevision !== undefined && opts.expectedRevision !== observed.revision) {
    return "task state changed concurrently";
  }
  if (observed.status === "done") return "task is done";

  // No-op assignment is success, not a wasted revision bump: re-assigning to the
  // current assignee must not invalidate everyone else's OCC token.
  const sameAssignee = assignee
    ? observed.claimedByType === assignee.type && observed.claimedById === assignee.id
    : observed.claimedById === null;
  if (sameAssignee) {
    // A reason has nowhere to go when nothing changes: say so rather than drop
    // it (the routes word this with the task and handle first).
    if (assignee && opts.reason) return TASK_ASSIGN_REASON_UNCHANGED_ERROR;
    return wrapCanonical(observed);
  }

  return wrapCanonical(await withTaskWriter(observed, async (tx) => {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.id, observed.channelId), isNull(channels.deletedAt)));
    if (!channel) return "task channel is unavailable";

    if (assignee) {
      const eligibilityError = await lockTaskAssigneeEligibility(tx, channel, assignee);
      if (eligibilityError) return eligibilityError;
    }

    const [updated] = await tx
      .update(tasks)
      .set({
        claimedByType: assignee?.type ?? null,
        claimedById: assignee?.id ?? null,
        // `claimedAt` is ALWAYS cleared here, including for a self-assignment.
        //
        // It was originally stamped on self-assign, by analogy with `claim`.
        // That was wrong and it broke a real sequence: `claimedAt` means "work
        // was taken up", and `writeCanonicalStatus` treats
        // `todo + claimedAt != null` as evidence that someone started the task
        // concurrently -- a state only `claim` could previously produce, and
        // only together with `in_progress`. Stamping it here made
        // `todo + claimedAt` REACHABLE and legitimate, so assigning yourself a
        // task and then starting it via the status route returned
        // `409 task start state changed concurrently` and the task could not
        // leave `todo` by that path at all.
        //
        // Clearing it keeps this function honest about its own contract:
        // assign moves ownership and asserts nothing about progress. `claim` is
        // still the verb that says "I have started", and it remains available
        // on a self-assigned todo task via the claim CAS predicate.
        claimedAt: null,
        revision: observed.revision + 1,
        // Use the shared clock seam so tests can control this write.
        updatedAt: currentDate(),
        lastActivityAt: TASK_ACTIVITY_NOW,
      })
      .where(and(
        canonicalRevisionCas(observed),
        sql`${tasks.status} != 'done'`,
      ))
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, observed.id));
      if (!current) return "task not found";
      if (current.status === "done") return "task is done";
      return "task state changed concurrently";
    }

    await recordTaskEvent(tx, updated.id, "assignee_changed", actorType, actorId, {
      assigneeType: assignee?.type ?? null,
      assigneeId: assignee?.id ?? null,
      previousAssigneeType: observed.claimedByType,
      previousAssigneeId: observed.claimedById,
      ...(assignee && opts.reason && { reason: opts.reason }),
    });
    return updated;
  }, { type: actorType, id: actorId, serverId: opts.serverId }));
}

/** Where a status write came from, for the task v2 rules (`taskV2StoredStatus`). */
export type TaskStatusWriteContext = {
  /**
   * The server whose surface the request came through: its
   * `task_v2_conversations_v0` decides whether a pre-v2 task counts as task
   * v2 (`taskUsesOwnConversation`). Absent: `serverId`, else the server that
   * owns the task's storage channel.
   */
  initiatingServerId?: string | null;
  /** A move into backlog: what would bring it back, already normalized (`checkTaskStatusReason`). */
  backlogReason?: string;
};

/**
 * Update task status. Sets completedAt when transitioning to done.
 *
 * Task v2: `in_review` is retired for task v2 tasks; asking for it stores
 * `in_progress` (assignee unchanged). The returned row is what was stored, so
 * callers must report `row.status`, not the requested status. `backlog` is task
 * v2 only; asking for it on any other task throws `TaskStatusNotAvailableError`.
 */
export async function updateTaskStatus(
  taskId: string,
  newStatus: TaskStatus,
  requesterId: string,
  requesterType?: "user" | "agent",
  serverId?: string,
  context: TaskStatusWriteContext = {},
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonicalStatus(
    await writeCanonicalStatus(owner.row, newStatus, {
      requesterId,
      requesterType,
      serverId,
      initiatingServerId: context.initiatingServerId,
      backlogReason: context.backlogReason,
    }),
  );
}

function wrapCanonicalStatus(result: TaskRow | string | CanonicalStatusUnchanged): TaskMutationResult {
  if (typeof result === "object" && "unchanged" in result) return { source: "tasks", row: result.unchanged, unchanged: true };
  return wrapCanonical(result);
}

/** Force update task status (admin/owner override). Skips assignee check. */
/**
 * Admin override: set any status, skipping the transition table.
 *
 * The actor is REQUIRED, not optional. Without it `writeCanonicalStatus`
 * resolves the event actor to `"system"`, so the one status change that most
 * needs accountability — someone overriding the state machine — was the only
 * one recording nobody. A forced `closed` was worse than anonymous: the
 * `closed_by_*` columns fall back to `observed.claimedByType/Id`, so it named
 * the PREVIOUS ASSIGNEE as the closer.
 *
 * Required rather than optional so a future call site cannot silently
 * reintroduce the anonymous write; there are only three, and the compiler now
 * asks each of them who is acting.
 */
export async function forceUpdateTaskStatus(
  taskId: string,
  newStatus: TaskStatus,
  actorType: "user" | "agent",
  actorId: string,
  serverId?: string,
  context: TaskStatusWriteContext = {},
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonicalStatus(await writeCanonicalStatus(owner.row, newStatus, {
    force: true,
    requesterType: actorType,
    requesterId: actorId,
    serverId,
    initiatingServerId: context.initiatingServerId,
    backlogReason: context.backlogReason,
  }));
}

/**
 * Convert an existing message into a task.
 *
 * v1.4: this creates a canonical `tasks` row associated to the message via
 * `tasks.messageId`. The message itself is left untouched — `messages.task_*`
 * is never written on a convert again, so convert can no longer manufacture a
 * second representation of the same task.
 *
 * If expectedChannelId is provided, validates the message belongs to that
 * channel (prevents cross-channel attacks).
 */
export async function convertMessageToTask(
  messageId: string,
  convertedByType: "user" | "agent",
  convertedById: string,
  expectedChannelId?: string,
  executor?: DatabaseExecutor,
  /** The Joint entry server the caller already locked (a send-as-task). */
  entryServerId?: string,
): Promise<TaskRow | string> {
  const db = executor ?? getDb();

  // Look up the message
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) return "message not found";

  // Validate channel ownership if expected channel is provided
  if (expectedChannelId && msg.channelId !== expectedChannelId) return "message not in this channel";

  // Already a task host — checked before the shape rejections below.
  if (msg.taskStatus !== null) return "already converted";
  // A pre-v2 host message is already its task.
  const [existingLink] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.messageId, messageId));
  if (existingLink) return "already converted";

  const [channel] = await db
    .select({ type: channels.type, serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, msg.channelId));
  if (!channel) return "channel not found";
  // A message in a sub-conversation (a thread, a task's own conversation)
  // never becomes a task: no task nests in another task.
  if (isSubConversationType(channel.type)) return "thread messages cannot be claimed as tasks";
  if (msg.senderType === "external_projection") {
    return "external projection messages cannot be claimed as tasks";
  }
  if (msg.messageType === "system")
    return "system messages cannot be claimed as tasks — if the message describes an action you should take, just do it; otherwise ignore it. Don't claim.";

  // v1.4 (tasks-table-canonical): create a canonical tasks row linked to the
  // message; the message itself stays a plain message (task_status untouched).
  const created = await withTaskChannelWriter(msg.channelId, async (tx) => {
    const [fresh] = await tx.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, messageId)).limit(1);
    if (fresh && fresh.channelId !== msg.channelId) throw new TaskMutationConflictError();
    // A send-as-task re-checks the entry the send itself locked (its row,
    // then J); any other projection taken here after J could close a cycle
    // with a concurrent send through that projection.
    await lockJointTaskWriteAuthority(tx, msg.channelId, { type: convertedByType, id: convertedById, ...(entryServerId ? { serverId: entryServerId } : {}) });
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${msg.channelId}))`);

    // Task v2: there is no "converting" a message any more (spec §1, §5).
    // Agents' `task convert` / `task claim --message-id` and the web convert
    // route refuse with `task_v2_use_create` before reaching here; humans and
    // agents create tasks from a message through createTasks
    // (`sourceMessageId`). The one remaining flag-on caller is send-as-task
    // (`ensureTaskForMessage`), kept tolerant for older web clients: the task
    // gets its own conversation with the message as its source, created once
    // per message so replayed sends converge (the conversation itself
    // is created lazily). Without the flag the message is
    // the host, as before.
    // The flag is the sender's server's (the Joint entry the send locked), not
    // the joint storage server's, as createTasks reads it.
    if (await isTaskV2ConversationsEnabled(entryServerId ?? channel.serverId, tx)) {
      const [raced] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.sourceMessageId, messageId))
        .limit(1);
      if (raced) return null;
      // Reserved only once the task will be inserted, so a lost race leaves no gap.
      const nextNum = await reserveTaskNumbers(tx, msg.channelId);
      const [inserted] = await tx
        .insert(tasks)
        .values({
          channelId: msg.channelId,
          taskNumber: nextNum,
          // The message's first line is the title and the rest its
          // description, as the New task dialog writes them.
          ...taskTextFromMessage(msg.content),
          status: "todo",
          createdByType: convertedByType,
          createdById: convertedById,
          messageId: null,
          sourceMessageId: messageId,
          ownConversation: true,
          lastActivityAt: TASK_ACTIVITY_NOW,
        })
        .returning();
      await recordTaskEvent(tx, inserted.id, "created", convertedByType, convertedById, {
        taskNumber: nextNum,
        status: "todo",
        convertedFromMessage: true,
      });
      // Its conversation is created lazily, by the first action that needs it.
      return inserted;
    }

    // A concurrent convert of this message took the same channel advisory
    // lock and has committed by now: settle the race before reserving a number
    // (the conflict target below stays as the backstop).
    const [linked] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.messageId, messageId)).limit(1);
    if (linked) return null;
    const nextNum = await reserveTaskNumbers(tx, msg.channelId);
    const [row] = await tx
      .insert(tasks)
      .values({
        channelId: msg.channelId,
        taskNumber: nextNum,
        title: msg.content,
        status: "todo",
        createdByType: convertedByType,
        createdById: convertedById,
        messageId,
        sourceMessageId: messageId,
        lastActivityAt: TASK_ACTIVITY_NOW,
      })
      .onConflictDoNothing({ target: tasks.messageId })
      .returning();
    if (!row) return null;
    await recordTaskEvent(tx, row.id, "created", convertedByType, convertedById, {
      taskNumber: nextNum,
      status: "todo",
      convertedFromMessage: true,
    });
    return row;
  }, executor);

  if (!created) return "already converted";
  return created;
}

/** Get a task by message ID. v1.4: a task may be a legacy message-task (task
 *  state on the message) OR a canonical tasks-table row linked via messageId. */
export async function getTaskByMessageId(messageId: string) {
  return (await resolveTaskByMessageId(messageId))?.row ?? null;
}

/** A message sent as a task: its first non-empty line is the title, the rest the description, both within the limits. */
export function taskTextFromMessage(content: string): { title: string; description: string | null } {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  const title = (first === -1 ? content : lines[first]!).trim();
  const rest = first === -1 ? "" : lines.slice(first + 1).join("\n").trim();
  return {
    title: Array.from(title).slice(0, TASK_TITLE_MAX_LENGTH).join("") || content.slice(0, TASK_TITLE_MAX_LENGTH),
    description: rest ? Array.from(rest).slice(0, TASK_DESCRIPTION_MAX_LENGTH).join("") : null,
  };
}

/**
 * Idempotently associate a canonical task with an existing message.
 *
 * This is what "send as task" uses after the plain host message is persisted:
 * the message insert no longer carries task columns, so the task fact is
 * created here, once, keyed by the unique `tasks.messageId`. Replayed sends
 * (agentSendKey / randomId idempotency) therefore converge on the same task row
 * instead of minting a second one.
 */
export async function ensureTaskForMessage(
  messageId: string,
  createdByType: "user" | "agent",
  createdById: string,
  executor?: DatabaseExecutor,
  /** The Joint entry server the send locked; see convertMessageToTask. */
  entryServerId?: string,
): Promise<TaskRow | null> {
  const created = await convertMessageToTask(messageId, createdByType, createdById, undefined, executor, entryServerId);
  if (typeof created !== "string") return created;
  if (created === "already converted") {
    const [row] = await (executor ?? getDb())
      .select()
      .from(tasks)
      .where(or(eq(tasks.messageId, messageId), eq(tasks.sourceMessageId, messageId)))
      .orderBy(tasks.taskNumber)
      .limit(1);
    return row ?? null;
  }
  console.error(`[taskService] ensureTaskForMessage(${messageId}) failed: ${created}`);
  return null;
}

/** Resolve a message ID (full UUID or short prefix) to a full message row within a channel.
 *  Short IDs (< 36 chars) must resolve uniquely. Returns null if not found or ambiguous. */
export async function resolveMessageInChannel(channelId: string, idOrPrefix: string) {
  const db = getDb();
  if (UUID_RE.test(idOrPrefix)) {
    // Full UUID — exact match
    const [row] = await db.select().from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.id, idOrPrefix)));
    return row || null;
  }
  if (!isMessageShortId(idOrPrefix)) return null;
  // Short prefix — must be unique
  const rows = await db.select().from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      ...messageIdShortPrefixConditions(idOrPrefix),
    ))
    .limit(2);
  if (rows.length === 1) return rows[0];
  return null; // Not found or ambiguous
}

/** A person's message sent with `randomId` (the web New task's source message key), if any. */
export async function findCreatorSourceMessageByRandomId(userId: string, randomId: string) {
  const [row] = await getDb()
    .select({ id: messages.id, channelId: messages.channelId, content: messages.content })
    .from(messages)
    .where(and(eq(messages.senderType, "user"), eq(messages.senderId, userId), eq(messages.randomId, randomId)))
    .limit(1);
  return row ?? null;
}

/**
 * The tasks `creator` created from `sourceMessageId` in `channelId`, enriched
 * as createTasks returns them, in task-number order. A person's create that
 * posted its own source message reads them on a retry (the same
 * sourceRandomId), so a lost response does not create the tasks twice.
 */
export async function listTasksFromSourceByCreator(
  channelId: string,
  sourceMessageId: string,
  creator: { type: "user" | "agent"; id: string },
) {
  const rows = await getDb()
    .select()
    .from(tasks)
    .where(and(
      eq(tasks.channelId, channelId),
      eq(tasks.sourceMessageId, sourceMessageId),
      eq(tasks.createdByType, creator.type),
      eq(tasks.createdById, creator.id),
    ))
    .orderBy(asc(tasks.taskNumber));
  return enrichTaskRows(rows);
}

/**
 * Task v2: a task's source, from the id a caller gave (full UUID or short
 * prefix). A top-level message of `channelId` is the source itself. A reply in
 * one of `channelId`'s threads resolves to that thread's root message (the
 * channel message the thread hangs under), and `threadReplyId` names the
 * reply given. Anything else (another channel, a DM, a task conversation, a
 * thread under another channel) is null: no such message here. A short id is
 * null when it is ambiguous: it matches more than one message, whether
 * top-level messages, replies, or one of each.
 *
 * A system or external-projection reply is refused (TaskSourceMessageError),
 * as such a top-level message is; the shape checks on the root (system,
 * external projection) stay in assertTaskSourceMessages, under the channel
 * lock.
 */
export async function resolveTaskSourceMessage(
  channelId: string,
  idOrPrefix: string,
): Promise<{ id: string; threadReplyId: string | null } | null> {
  const value = idOrPrefix.trim();
  const fullId = UUID_RE.test(value);
  if (!fullId && !isMessageShortId(value)) return null;
  const db = getDb();
  const idMatch = fullId ? [eq(messages.id, value)] : messageIdShortPrefixConditions(value);
  const topLevel = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.channelId, channelId), ...idMatch))
    .limit(2);
  const replies = await db
    .select({ id: messages.id, rootId: channels.parentMessageId, senderType: messages.senderType, messageType: messages.messageType })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(and(
      eq(channels.type, "thread"),
      eq(channels.parentChannelId, channelId),
      isNull(channels.deletedAt),
      ...idMatch,
    ))
    .limit(2);
  if (topLevel.length + replies.length !== 1) return null;
  if (topLevel.length === 1) return { id: topLevel[0]!.id, threadReplyId: null };
  const reply = replies[0]!;
  if (!reply.rootId) return null;
  if (reply.senderType === "external_projection") throw new TaskSourceMessageError("external projection messages cannot carry tasks");
  if (reply.messageType === "system") throw new TaskSourceMessageError("system messages cannot carry tasks");
  // The thread hangs under a message of this channel (parent_channel_id is
  // where its root lives); re-read it so a moved root is never taken.
  const [root] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, reply.rootId), eq(messages.channelId, channelId)))
    .limit(1);
  return root ? { id: root.id, threadReplyId: reply.id } : null;
}

/**
 * Delete a task without deleting its host message.
 *
 * P3: no longer routed by ownership -- every task is a canonical row. The old
 * message-owned tail is unreachable and has been removed.
 *
 * Clearing the message-side shadow is KEPT and is not vestigial. Pre-P3 it
 * mattered because `listTasks` suppressed the shadow by anti-join, so dropping
 * only the canonical row un-suppressed it and resurrected the task. Nothing
 * reads that side now, so the reason has changed rather than disappeared: it
 * keeps the frozen rollback snapshot honest, since a rolled-back 1.6.2 reads
 * `messages.task_*` directly and would otherwise list a task the user deleted.
 */
export async function deleteTaskByOwner(owner: TaskOwner, actor?: JointTaskWriteActor) {
  await withTaskWriter(owner.row, async (tx) => {
    if (owner.row.messageId) await clearTaskShadow(tx, owner.row.messageId);
    await retireTaskConversations(tx, owner.row.id);
    await tx.delete(tasks).where(and(eq(tasks.id, owner.row.id), eq(tasks.channelId, owner.row.channelId)));
  }, actor);
}

/**
 * Task v2 (RFC 078 "Deleting a task"): a deleted task's conversation is
 * soft-deleted like a deleted channel, not hard-deleted by the
 * `channels.task_id` cascade. Its messages may be referenced ON DELETE
 * RESTRICT by external bridge rows (external_message_links,
 * external_outbound_deliveries, inbound events, reaction facts), so the cascade
 * could fail the delete. Every face (canonical and joint locals) gets
 * `deleted_at` and loses `task_id` (the task_conversation_detach_on_delete check admits that shape) in the
 * delete transaction, before the task row goes; follows still go with the task
 * (thread_follows.parent_task_id cascade), and every reader already hides a
 * deleted conversation. Pending phone pushes for it are revoked, as the
 * cascade used to drop them.
 */
async function retireTaskConversations(tx: DatabaseExecutor, taskId: string): Promise<void> {
  const now = currentDate();
  const retired = await tx.update(channels)
    .set({ taskId: null, deletedAt: sql`coalesce(${channels.deletedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(channels.taskId, taskId), eq(channels.type, "task")))
    .returning({ id: channels.id });
  if (retired.length === 0) return;
  await tx.update(notificationOutbox)
    .set({
      status: "revoked",
      processedAt: now,
      updatedAt: now,
      lastError: "task_deleted",
    })
    .where(and(
      inArray(notificationOutbox.sourceChannelId, retired.map((row) => row.id)),
      inArray(notificationOutbox.status, ["pending", "processing"]),
    ));
}

/** Delete a message-task — clears task fields (does NOT delete the message). */
/**
 * P3: one of exactly three remaining writers of `messages.task_*`, and the only
 * one in this file. None of the three OWNS a task in those columns -- each
 * clears or terminates a shadow. Verified by enumerating every `.update(messages)`
 * in non-test `src/` rather than trusting the compiler, which cannot see through
 * a `.set({...})` object literal:
 *
 *   1. this function          -- clears all six columns when a task is deleted
 *   2. `agentService`         -- releases assignee columns when an agent is soft-deleted
 *   3. `channelService`       -- marks open shadows "closed" when a channel is deleted
 *
 * (`messageService` projects task facts onto an in-memory row for downstream
 * consumers and deliberately does NOT persist them; `actionCardsService` writes
 * `actionMetadata` only. Neither is a task-column writer.)
 *
 * 2 and 3 now write to a side nothing reads, so they are dead weight rather than
 * a correctness risk; they are left in place for P4 to remove together with the
 * columns, so this PR changes reads and writers without also changing cleanup
 * semantics.
 *
 * This function CLEARS the columns rather than owning a task in them.
 *
 * `messages.task_*` is retained after the 2026-07-31 backfill as a frozen
 * rollback snapshot (@stdrc keep-and-observe). Clearing it when a task is
 * deleted is what keeps that snapshot honest -- otherwise a rolled-back 1.6.2
 * would still list a task the user had deleted. Do not "clean this up" as a
 * leftover legacy write: removing it would silently degrade the snapshot the
 * rollback ledger is tracking.
 */
export async function deleteTask(taskId: string) {
  const [message] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, taskId)).limit(1);
  if (!message) return;
  await withTaskChannelWriter(message.channelId, (tx) => clearTaskShadow(tx, taskId));
}

async function clearTaskShadow(executor: DatabaseExecutor, taskId: string): Promise<void> {
  await executor
    .update(messages)
    .set({
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, taskId));
}

// ── Canonical `tasks` table writers (v1.4) ──
//
// Every mutation here is OCC-guarded on `tasks.revision` (added in P0) instead
// of the field-by-field CAS the message-task path needs: the canonical row has
// a single monotonic token, so "did anything change under me" is one equality
// test. Each committed mutation appends to `task_events`, ordered by the global
// `seq` — that is the lifecycle proof vocabulary P5 depends on.

/** Present a canonical task row in the message-task claim shape so both sides
 *  share one conflict-reason implementation (no drift in user-facing strings). */
function canonicalClaimShape(row: TaskRow): Pick<
  MessageRow,
  "taskAssigneeType" | "taskAssigneeId" | "taskStatus" | "taskClaimedAt"
> {
  return {
    taskAssigneeType: row.claimedByType,
    taskAssigneeId: row.claimedById,
    taskStatus: row.status,
    taskClaimedAt: row.claimedAt,
  };
}

/**
 * OCC predicate: this exact row, unchanged since we read it.
 *
 * `revision` only detects writers that bump it. Every write below therefore
 * ALSO re-asserts the specific precondition it authorized on (assignment,
 * claim state), so an out-of-band writer — a backfill, an admin UPDATE, a
 * future code path that forgets the token — cannot defeat authorization by
 * simply not touching `revision`.
 */
function canonicalRevisionCas(row: TaskRow) {
  return and(eq(tasks.id, row.id), eq(tasks.channelId, row.channelId), eq(tasks.revision, row.revision));
}

/** Claimable-by-this-actor predicate, mirroring taskClaimCasPredicate. */
function canonicalClaimCasPredicate(claimedByType: "user" | "agent", claimedById: string) {
  return and(
    sql`${tasks.status} != 'done'`,
    or(
      // Nobody holds it: claimable whatever claimedAt says. A task moved to
      // in_progress with no assignee used to stamp it, and those rows stay.
      and(
        isNull(tasks.claimedByType),
        isNull(tasks.claimedById),
      ),
      and(
        eq(tasks.claimedByType, claimedByType),
        eq(tasks.claimedById, claimedById),
        inArray(tasks.status, ["todo", "backlog"]),
        isNull(tasks.claimedAt),
      ),
    ),
  );
}

/** Re-assert the exact assignment the caller was authorized against. */
function canonicalAssignmentCas(row: TaskRow) {
  return and(
    row.claimedByType === null ? isNull(tasks.claimedByType) : eq(tasks.claimedByType, row.claimedByType),
    row.claimedById === null ? isNull(tasks.claimedById) : eq(tasks.claimedById, row.claimedById),
    row.claimedAt === null ? isNull(tasks.claimedAt) : eq(tasks.claimedAt, row.claimedAt),
  );
}

/** Claim a canonical task. Mirrors writeTaskClaim's semantics exactly, including
 *  the preassigned-todo case where only the named assignee may perform the
 *  first claim (which is what atomically starts the task). */
async function writeCanonicalClaim(
  executor: DatabaseExecutor,
  observed: TaskRow,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<TaskRow | TaskClaimRejection> {
  const rejection = await describeTaskClaimRejection(
    executor,
    canonicalClaimShape(observed),
    claimedByType,
    claimedById,
  );
  if (rejection) return rejection;

  const previousStatus = observed.status as TaskStatus;
  const nextStatus: TaskStatus = isClaimStartableStatus(previousStatus) ? "in_progress" : previousStatus;

  const [updated] = await executor
    .update(tasks)
    .set({
      status: nextStatus,
      claimedByType,
      claimedById,
      // Monotonic ownership epoch, same rule as the message path: a resumed
      // task must advance `claimedAt` even when the wall clock repeats a
      // millisecond, or the CAS below cannot tell two claims apart.
      claimedAt: nextClaimedAt(observed.claimedAt),
      revision: observed.revision + 1,
      updatedAt: new Date(),
      lastActivityAt: TASK_ACTIVITY_NOW,
    })
    .where(and(
      canonicalRevisionCas(observed),
      canonicalClaimCasPredicate(claimedByType, claimedById),
    ))
    .returning();

  if (!updated) return await canonicalClaimRaceReason(executor, observed.id, claimedByType, claimedById);

  await recordTaskEvent(executor, updated.id, "assignee_changed", claimedByType, claimedById, {
    assigneeType: claimedByType,
    assigneeId: claimedById,
  });
  if (nextStatus !== previousStatus) {
    await recordTaskEvent(executor, updated.id, "status_changed", claimedByType, claimedById, {
      from: previousStatus,
      to: nextStatus,
    });
  }
  return updated;
}

async function canonicalClaimRaceReason(
  executor: DatabaseExecutor,
  taskId: string,
  claimedByType: "user" | "agent",
  claimedById: string,
): Promise<TaskClaimRejection> {
  const [current] = await executor.select().from(tasks).where(eq(tasks.id, taskId));
  if (!current) return { rejected: true, reason: "task not found", conflict: null };
  return await describeTaskClaimRejection(
    executor,
    canonicalClaimShape(current),
    claimedByType,
    claimedById,
  ) ?? { rejected: true, reason: "cannot claim", conflict: null };
}

/**
 * Unclaim a canonical task; status is unchanged.
 *
 * Any channel member may unclaim, not only the assignee. Two reasons:
 *  - @stdrc's ruling that only DELETE is creator/admin-restricted;
 *  - the restriction was already void in practice, because `assignTask(null)`
 *    is member-level and clears the assignee identically. Two endpoints with
 *    different rules for the same effect is a trap, not a safeguard.
 *
 * The actor is still recorded on the `assignee_changed` event, so taking a task
 * off someone leaves a trail.
 */
async function writeCanonicalUnclaim(
  executor: DatabaseExecutor,
  observed: TaskRow,
  requesterType: "user" | "agent",
  requesterId: string,
): Promise<TaskRow | string> {
  if (observed.status === "done") return "task is done";
  if (!observed.claimedById) return "task is not assigned";

  const previousAssigneeType = observed.claimedByType;
  const [updated] = await executor
    .update(tasks)
    .set({
      claimedByType: null,
      claimedById: null,
      claimedAt: null,
      revision: observed.revision + 1,
      updatedAt: new Date(),
      lastActivityAt: TASK_ACTIVITY_NOW,
    })
    .where(and(
      canonicalRevisionCas(observed),
      // Assignee identity is no longer part of the predicate (member-level
      // unclaim); the revision CAS still guarantees nobody changed the row
      // between the read and this write.
      isNotNull(tasks.claimedById),
      sql`${tasks.status} != 'done'`,
    ))
    .returning();

  if (!updated) {
    const [current] = await executor.select().from(tasks).where(eq(tasks.id, observed.id));
    if (!current) return "task not found";
    if (current.status === "done") return "task is done";
    if (!current.claimedById) return "task is not assigned";
    return "task state changed concurrently";
  }

  // Record the ACTOR, not the person the task was taken from. These used to be
  // the same row -- only the assignee could unclaim, so `previousAssigneeType`
  // happened to be the requester's type. Opening unclaim to members split them:
  // an agent unclaiming a human's task would otherwise be written as
  // actorType "user" with an agent's id, an actor tuple pointing at nobody.
  //
  // The previous assignee is not dropped, it moves into the payload -- matching
  // `assignTask`, so "taken off @someone" is answerable from either writer.
  await recordTaskEvent(executor, updated.id, "assignee_changed", requesterType, requesterId, {
    assigneeType: null,
    assigneeId: null,
    previousAssigneeType,
    previousAssigneeId: observed.claimedById,
  });
  return updated;
}

/** `writeCanonicalStatus` wrote nothing: in_review asked of a task v2 task already in_progress. */
type CanonicalStatusUnchanged = { unchanged: TaskRow };

/**
 * Status transition on a canonical task.
 *
 * `force: true` is the admin/owner override — it skips the assignee check but
 * keeps every state-machine guard, matching forceUpdateTaskStatus on the
 * message side.
 */
async function writeCanonicalStatus(
  observed: TaskRow,
  requestedStatus: TaskStatus,
  opts: {
    requesterId?: string;
    requesterType?: "user" | "agent";
    force?: boolean;
    serverId?: string;
    initiatingServerId?: string | null;
    backlogReason?: string;
  },
): Promise<TaskRow | string | CanonicalStatusUnchanged> {
  const previousStatus = observed.status as TaskStatus;
  const force = opts.force === true;
  // Task v2: in_review is retired; a task v2 task asked for it stores
  // in_progress, through every rule below exactly as if in_progress had been
  // asked for. The flag is read only when it can matter (in_review or backlog
  // on a pre-v2 task: on that server it gets its conversation, so it is task v2).
  const flagOn = (requestedStatus === "in_review" || requestedStatus === "backlog") && !isV2Task(observed)
    ? await isTaskV2ConversationsEnabledForRequest({
      initiatingServerId: opts.initiatingServerId ?? opts.serverId,
      storageChannelId: observed.channelId,
    })
    : false;
  // Backlog is task v2 only, for every writer, the admin force path included.
  if (requestedStatus === "backlog" && !taskUsesOwnConversation(observed, flagOn)) {
    throw new TaskStatusNotAvailableError(requestedStatus);
  }
  const newStatus: TaskStatus = taskV2StoredStatus(observed, flagOn, requestedStatus);
  const inReviewRetired = newStatus !== requestedStatus;

  // This is a completion invariant, not a permission check. Every writer,
  // including the owner/admin force path, must cross it.
  if (newStatus === "done" && observed.requiresResourceReceipt && !hasCompleteTaskResourceReceipt(observed)) {
    return "resource receipt required before task can move to done";
  }

  // Already in_progress: what an older client asking for in_review means is
  // already true, so it is a success that writes nothing (no revision bump,
  // no event), not the "already in_progress" refusal it would ask for.
  // Still through the writer fence and joint write authority, as a write is.
  const writerActor = opts.requesterId
    ? { type: opts.requesterType ?? "user", id: opts.requesterId, serverId: opts.serverId }
    : undefined;
  if (inReviewRetired && previousStatus === newStatus) {
    return withTaskWriter(observed, async (): Promise<CanonicalStatusUnchanged> => ({ unchanged: observed }), writerActor);
  }

  const transitionError = getTaskStatusTransitionError(previousStatus, newStatus);
  if (transitionError) return transitionError;

  if (force) {
    if (previousStatus === "todo" && newStatus === "in_progress" && !observed.claimedById) {
      return "task must be claimed before moving to in_progress";
    }
    if (previousStatus === "todo" && newStatus === "in_progress" && observed.claimedAt !== null) {
      return "task start state changed concurrently";
    }
  } else {
    // No assignee check. @stdrc ruled that status is a member-level action:
    // "status 应该也是，人都可以做。你想象一个正常的 to-do list 管理软件，
    //  它没理由是只有 admin 能操作的。" Only DELETE stays creator/admin-only.
    //
    // This removed `only the assignee can update status` plus its
    // `in_review -> done` carve-out, which existed solely to punch a hole in
    // that restriction. Channel write access is still enforced at the route,
    // so "member" means "member of this channel", not anyone on the server.
    //
    // It also dissolves a bypass rather than accepting one: while status was
    // assignee-only, any member could reassign the task to themselves and then
    // change it, so the restriction bought nothing except two extra steps and
    // a misleading audit trail.
    //
    // The guard below is NOT a permission check -- it is concurrency
    // protection (two people starting the same task), and it stays.
    if (previousStatus === "todo" && newStatus === "in_progress" && observed.claimedById && observed.claimedAt !== null) {
      // With no holder, claimedAt says nothing about a start: older writes left it on such rows.
      return "task start state changed concurrently";
    }

    // Interleaving window between authorizing on a read and committing the
    // write. Named the same as the message path's failpoint so the fail-closed
    // negative control is expressible against whichever side owns the task.
    await failpoints.hit("server.task.canonicalStatus.afterAuthorizationRead", {
      taskId: observed.id,
      requesterId: opts.requesterId,
      previousStatus,
      newStatus,
    });
  }

  const setFields: Partial<typeof tasks.$inferInsert> = {
    status: newStatus,
    revision: observed.revision + 1,
    updatedAt: new Date(),
  };
  if (observed.claimedById && isUnstartedStatus(previousStatus) && newStatus === "in_progress") {
    // Starting preassigned todo work and resuming closed owned work both stamp
    // the current ownership epoch, exactly as updateMessageTaskStatus does. The
    // assignee check plus the revision CAS keep a stale owner from reviving it.
    // With nobody holding the task there is no ownership to stamp, as when one
    // is created in_progress with no assignee; the first claim stamps it.
    setFields.claimedAt = nextClaimedAt(observed.claimedAt);
  }
  if ((newStatus === "todo" || newStatus === "backlog") && observed.claimedAt !== null) {
    // Back to not started, from any status: the assignment stays, its start
    // epoch goes, so starting it again (or the assignee's first claim) stamps
    // a new one instead of tripping the concurrent-start guard below.
    setFields.claimedAt = null;
  }
  if (newStatus === "done") setFields.completedAt = new Date();
  else if (previousStatus === "done") setFields.completedAt = null;

  // `closed` is the non-success terminal state; P0 added closed_* so it is
  // distinguishable from `done` without replaying the event log.
  if (newStatus === "closed") {
    setFields.closedAt = new Date();
    setFields.closedByType = opts.requesterType ?? observed.claimedByType ?? "user";
    setFields.closedById = opts.requesterId ?? observed.claimedById ?? null;
  } else if (previousStatus === "closed") {
    setFields.closedAt = null;
    setFields.closedByType = null;
    setFields.closedById = null;
  }

  return withTaskWriter(observed, async (executor) => {
  const [updated] = await executor
    .update(tasks)
    .set({ ...setFields, lastActivityAt: TASK_ACTIVITY_NOW })
    .where(and(
      canonicalRevisionCas(observed),
      eq(tasks.status, previousStatus),
      // NOT a permission check (status is member-level now). This guards
      // OWNERSHIP INTEGRITY: a closed/todo -> in_progress write stamps
      // `claimedAt` for the requester, so if their assignment was removed
      // between the read and this write, committing would REVIVE a claim that
      // no longer exists. Only applies when the requester was the assignee at
      // read time -- a non-assignee changing status stamps nothing to revive.
      !force && observed.claimedById === opts.requesterId
        ? canonicalAssignmentCas(observed)
        : undefined,
    ))
    .returning();

  if (!updated) {
    // Same race-reason ladder as updateMessageTaskStatus, in the same order.
    // These strings are user-facing (409 bodies, CLI output), so a canonical
    // task losing a race must explain itself identically to a message-task —
    // otherwise the storage move leaks through the error text.
    const [current] = await executor.select().from(tasks).where(eq(tasks.id, observed.id));
    if (!current) return "task not found";
    if (current.status !== previousStatus) return "status changed concurrently";
    if (!force && observed.claimedById === opts.requesterId && current.claimedById !== opts.requesterId) {
      // Was "only the assignee can update status", which is now actively
      // misleading: status is member-level, so this is not a permission
      // refusal. The requester WAS the assignee when we read, and no longer is
      // -- a concurrency outcome, and the ladder already has a name for it.
      return "task assignment changed concurrently";
    }
    return "task assignment changed concurrently";
  }

  const actorType = opts.requesterType
    ?? (observed.claimedById && observed.claimedById === opts.requesterId ? observed.claimedByType : null)
    ?? "system";
  const actorId = actorType === "system" ? null : opts.requesterId ?? null;
  const eventType = newStatus === "closed"
    ? "closed"
    : previousStatus === "closed"
      ? "reopened"
      : "status_changed";
  await recordTaskEvent(executor, updated.id, eventType, actorType, actorId, {
    from: previousStatus,
    to: newStatus,
    forced: force,
    ...(inReviewRetired && { reason: TASK_V2_RETIRED_IN_REVIEW_REASON }),
    ...(newStatus === "backlog" && opts.backlogReason && { reason: opts.backlogReason }),
  });
  return updated;
  }, writerActor);
}

const TASK_RESOURCE_RECEIPT_FIELDS = [
  "object",
  "purpose",
  "teardown_owner",
  "security_privacy",
  "expiry",
  "runbook",
  "tracking",
] as const satisfies readonly (keyof TaskResourceReceipt)[];

function normalizeTaskResourceReceipt(input: TaskResourceReceipt): TaskResourceReceipt | string {
  for (const field of TASK_RESOURCE_RECEIPT_FIELDS) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0) {
      return `resource receipt field ${field} must be nonblank`;
    }
  }
  const teardownOwner = input.teardown_owner.trim();
  if (!teardownOwner.startsWith("@") || teardownOwner.slice(1).trim().length === 0) {
    return "resource receipt field teardown_owner must be an @agent handle";
  }
  const expiry = new Date(input.expiry.trim());
  if (!Number.isFinite(expiry.getTime())) {
    return "resource receipt field expiry must be an ISO timestamp";
  }
  return {
    object: input.object.trim(),
    purpose: input.purpose.trim(),
    teardown_owner: teardownOwner,
    security_privacy: input.security_privacy.trim(),
    expiry: expiry.toISOString(),
    runbook: input.runbook.trim(),
    tracking: input.tracking.trim(),
  };
}

function hasCompleteTaskResourceReceipt(row: TaskRow): boolean {
  const normalized = row.resourceReceipt
    ? normalizeTaskResourceReceipt(row.resourceReceipt)
    : "resource receipt missing";
  return typeof normalized !== "string"
    && row.resourceReceiptRecordedAt !== null
    && row.resourceReceiptRecordedByType !== null
    && row.resourceReceiptRecordedById !== null
    && row.resourceTeardownOwnerAgentId !== null
    && row.resourceExpiryFollowupId !== null;
}

export interface TaskResourceExpiryFollowup {
  id: string;
  serverId: string;
  ownerAgentId: string;
  targetChannelId: string | null;
  msgId: string | null;
  fireAt: Date;
  payload: unknown;
  version: number;
}

export interface TaskResourceExpiryFollowupPort {
  create(input: {
    id: string;
    serverId: string;
    ownerAgentId: string;
    targetChannelId: string;
    msgId: string;
    title: string;
    fireAt: Date;
    payload: unknown;
    createdBy: { type: "agent" | "human"; id: string };
  }, executor: DatabaseExecutor): Promise<TaskResourceExpiryFollowup>;
  get(id: string, executor: DatabaseExecutor): Promise<TaskResourceExpiryFollowup | null>;
}

export interface RecordTaskResourceReceiptInput {
  taskId: string;
  receipt: TaskResourceReceipt;
  actorType: "user" | "agent";
  actorId: string;
  teardownOwnerAgentId: string;
  teardownOwnerServerId: string;
  teardownOwnerTargetChannelId: string;
  expiryFollowups: TaskResourceExpiryFollowupPort;
}

export interface TaskResourceReceiptResult {
  task: TaskRow;
  expiryFollowup: TaskResourceExpiryFollowup;
  receipt: TaskResourceReceipt;
  idempotent: boolean;
  /**
   * Task v2, a task without a host or source message: the "resource receipt
   * recorded" line committed in the task conversation as the follow-up's
   * anchor. Persisted (and anchored) in the receipt transaction; the caller
   * fans it out after commit (publishTaskResourceReceiptLine). Absent for
   * idempotent retries and for tasks anchored on a message.
   */
  receiptLine?: {
    message: typeof messages.$inferSelect;
    content: string;
    /** The conversation as the teardown owner's server sees it (the follow-up's target). */
    localConversationId: string;
  };
}

/**
 * Atomically records the authoritative task receipt and its owner-anchored
 * expiry follow-up. A byte-equivalent retry returns the same durable follow-up;
 * a different second receipt is rejected instead of silently rewriting audit
 * history.
 */
export async function recordTaskResourceReceipt(
  input: RecordTaskResourceReceiptInput,
): Promise<TaskResourceReceiptResult | string> {
  const normalized = normalizeTaskResourceReceipt(input.receipt);
  if (typeof normalized === "string") return normalized;

  const owner = await resolveTaskById(input.taskId);
  if (!owner) return "task not found";
  return withTaskWriter(owner.row, async (tx) => {
    const [observed] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update");
    if (!observed) return "task not found";
    if (!observed.requiresResourceReceipt) return "task is not marked as creating a resource";
    // Task v2 tasks have no host message; their source message (if any) is
    // the conversational anchor of the expiry follow-up. A v2 task without a
    // source message anchors it on a "resource receipt recorded" line in its
    // own conversation, written below once the receipt is valid (needs the
    // task's conversation; without one the receipt is refused as before).
    const anchorMessageId = observed.messageId ?? observed.sourceMessageId;

    if (observed.resourceReceipt) {
      const existing = normalizeTaskResourceReceipt(observed.resourceReceipt);
      const sameReceipt = typeof existing !== "string"
        && JSON.stringify(existing) === JSON.stringify(normalized)
        && observed.resourceTeardownOwnerAgentId === input.teardownOwnerAgentId;
      if (!sameReceipt) return "resource receipt is already recorded";
      if (!hasCompleteTaskResourceReceipt(observed) || !observed.resourceExpiryFollowupId) {
        return "resource receipt state is incomplete";
      }
      const expiryFollowup = await input.expiryFollowups.get(observed.resourceExpiryFollowupId, tx);
      if (!expiryFollowup) return "resource expiry follow-up is missing";
      return { task: observed, expiryFollowup, receipt: existing, idempotent: true };
    }

    const fireAt = new Date(normalized.expiry);
    if (fireAt.getTime() <= currentDate().getTime()) {
      return "resource receipt expiry must be in the future";
    }
    // Lazy conversation: created only once the receipt is valid and new, so
    // a refused receipt creates nothing.
    const anchorConversation = anchorMessageId
      ? null
      : await ensureTaskConversation(observed.id, { initiatingServerId: input.teardownOwnerServerId, executor: tx });
    if (!anchorMessageId && !anchorConversation) return "resource receipt requires a task message anchor";

    const followupId = randomUUID();
    const recordedAt = currentDate();
    let followupMessageId = anchorMessageId;
    let followupTargetChannelId = input.teardownOwnerTargetChannelId;
    let receiptLine: TaskResourceReceiptResult["receiptLine"];
    if (!followupMessageId && anchorConversation) {
      const { conversation } = anchorConversation;
      const ownerLocal = [...conversation.localByServer.values()]
        .find((local) => local.localParentChannelId === input.teardownOwnerTargetChannelId)
        ?? conversation.localByServer.get(input.teardownOwnerServerId);
      const content = `🧾 Resource receipt recorded for #${observed.taskNumber} "${summarizeTaskTitle(observed.title)}": `
        + `${summarizeTaskTitle(normalized.object)} · teardown ${normalized.teardown_owner} · expires ${normalized.expiry}`;
      const [line] = await tx.insert(messages).values({
        // Messages live in the canonical conversation (joint: on storage).
        channelId: conversation.canonicalChannelId,
        senderType: "user",
        senderId: "system",
        messageType: "system",
        content,
        searchText: buildSearchText(content),
        causalActorType: input.actorType,
        causalActorId: input.actorId,
        systemSubtype: "task.lifecycle_thread",
      }).returning();
      if (!line) throw new Error("Failed to persist the resource receipt line");
      followupMessageId = line.id;
      // The follow-up fires into the task's conversation (the owner's face).
      followupTargetChannelId = ownerLocal?.localChannelId ?? conversation.canonicalChannelId;
      receiptLine = { message: line, content, localConversationId: followupTargetChannelId };
    }
    const expiryFollowup = await input.expiryFollowups.create({
      id: followupId,
      serverId: input.teardownOwnerServerId,
      ownerAgentId: input.teardownOwnerAgentId,
      targetChannelId: followupTargetChannelId,
      msgId: followupMessageId!,
      title: `Resource expiry: task #${observed.taskNumber} — ${normalized.object}`,
      fireAt,
      payload: {
        kind: "task_resource_expiry",
        taskId: observed.id,
        taskNumber: observed.taskNumber,
        object: normalized.object,
        teardownOwner: normalized.teardown_owner,
        receiptRecordedAt: recordedAt.toISOString(),
      },
      createdBy: {
        type: input.actorType === "user" ? "human" : "agent",
        id: input.actorId,
      },
    }, tx);

    const [updated] = await tx
      .update(tasks)
      .set({
        resourceReceipt: normalized,
        resourceReceiptRecordedAt: recordedAt,
        resourceReceiptRecordedByType: input.actorType,
        resourceReceiptRecordedById: input.actorId,
        resourceTeardownOwnerAgentId: input.teardownOwnerAgentId,
        resourceExpiryFollowupId: expiryFollowup.id,
        revision: observed.revision + 1,
        updatedAt: recordedAt,
      })
      .where(eq(tasks.id, observed.id))
      .returning();
    if (!updated) throw new Error("Failed to record task resource receipt");

    await recordTaskEvent(tx, updated.id, "resource_receipt_recorded", input.actorType, input.actorId, {
      receipt: normalized,
      teardownOwnerAgentId: input.teardownOwnerAgentId,
      expiryFollowupId: expiryFollowup.id,
    });
    return {
      task: updated,
      expiryFollowup,
      receipt: normalized,
      idempotent: false,
      ...(receiptLine ? { receiptLine } : {}),
    };
  }, { type: input.actorType, id: input.actorId });
}

/** Get a canonical task row by ID. */
export async function getLegacyTask(taskId: string) {
  if (!UUID_RE.test(taskId)) return null;
  return selectCanonicalTask(eq(tasks.id, taskId));
}

/** Delete a canonical task row (task_events cascade with it). */
export async function deleteLegacyTask(taskId: string) {
  const owner = await resolveTaskById(taskId);
  if (!owner) return;
  await withTaskWriter(owner.row, async (tx) => {
    await tx.delete(tasks).where(and(eq(tasks.id, taskId), eq(tasks.channelId, owner.row.channelId)));
  });
}

/** Enrich a single canonical task row with names (for socket event emission). */
export async function enrichSingleLegacyTask(row: TaskRow) {
  const [enriched] = await enrichTaskRows([row]);
  return enriched;
}

/** Enrich a single task row with creator/claimer names. */
export async function enrichSingleTask(row: MessageRow) {
  const [enriched] = await enrichWithNames([row]);
  return enriched;
}

/** Aggregate at the ACL-filtered source: never infer period totals from a capped page. */
export async function getServerTaskPeriodMetrics(serverId: string, userId: string, from: Date, midpoint: Date, to: Date, channelId?: string) {
  const candidates = await getDb().select({ id: channels.id }).from(channels).where(and(
    eq(channels.serverId, serverId), inArray(channels.type, ["channel", "joint", "private"]),
    isNull(channels.deletedAt), isNull(channels.archivedAt), channelId ? eq(channels.id, channelId) : undefined,
  )).orderBy(asc(channels.name), asc(channels.id));
  const surfaces = await resolveVisibleServerTaskSurfaces(serverId, userId, candidates.map((channel) => channel.id));
  const emptyPeriod = { completed: 0, meanHours: null as number | null, medianHours: null as number | null, durationSamples: 0 };
  if (!surfaces.length) return { current: emptyPeriod, previous: emptyPeriod, surfaces: 0 };
  const storageIds = sql.join(surfaces.map((surface) => sql`${surface.storageChannelId}::uuid`), sql`, `);
  const facts = getDb().selectDistinct({ id: tasks.id, createdAt: tasks.createdAt, completedAt: tasks.completedAt })
    .from(sql`unnest(ARRAY[${storageIds}]) AS surface(storage_id)
      CROSS JOIN LATERAL (${conversionReadChannelIdsQuery(sql`surface.storage_id`)}) AS read_scope(id)`)
    .innerJoin(tasks, eq(tasks.channelId, sql`read_scope.id`))
    .where(and(eq(tasks.status, "done"), sql`${tasks.completedAt} >= ${from.toISOString()}::timestamptz`, sql`${tasks.completedAt} < ${to.toISOString()}::timestamptz`)).as("visible_task_facts");
  const elapsed = sql`EXTRACT(EPOCH FROM (${facts.completedAt} - ${facts.createdAt})) / 3600.0`;
  const period = sql<string>`CASE WHEN ${facts.completedAt} >= ${midpoint.toISOString()}::timestamptz THEN 'current' ELSE 'previous' END`;
  const rows = await getDb().select({
    period,
    completed: sql<number>`count(*)`.mapWith(Number),
    samples: sql<number>`count(*) FILTER (WHERE ${elapsed} >= 0)`.mapWith(Number),
    mean: sql<number | null>`avg(${elapsed}) FILTER (WHERE ${elapsed} >= 0)`.mapWith(Number),
    median: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${elapsed}) FILTER (WHERE ${elapsed} >= 0)`.mapWith(Number),
  }).from(facts).groupBy(sql`1`);
  const select = (name: string) => {
    const row = rows.find((item) => item.period === name);
    return row ? { completed: row.completed, durationSamples: row.samples, meanHours: row.mean, medianHours: row.median } : emptyPeriod;
  };
  return { current: select("current"), previous: select("previous"), surfaces: surfaces.length };
}

/** Current task facts across the viewer's accessible task surfaces, independent of AI analysis. */
export async function getServerTaskSnapshot(serverId: string, userId: string, channelId?: string) {
  const candidates = await getDb().select({ id: channels.id }).from(channels).where(and(
    eq(channels.serverId, serverId), inArray(channels.type, ["channel", "joint", "private"]),
    isNull(channels.deletedAt), isNull(channels.archivedAt), channelId ? eq(channels.id, channelId) : undefined,
  )).orderBy(asc(channels.name), asc(channels.id));
  const surfaces = await resolveVisibleServerTaskSurfaces(serverId, userId, candidates.map((channel) => channel.id));
  const empty = { surfaces: surfaces.length, total: 0, backlog: 0, todo: 0, inProgress: 0, inReview: 0, done: 0, closed: 0,
    humanCreated: 0, agentCreated: 0, durationSamples: 0, medianHours: null as number | null, p90Hours: null as number | null,
    firstCreatedAt: null as Date | null, latestCreatedAt: null as Date | null, latestUpdatedAt: null as Date | null };
  if (!surfaces.length) return empty;
  const storageIds = sql.join(surfaces.map((surface) => sql`${surface.storageChannelId}::uuid`), sql`, `);
  const facts = getDb().selectDistinct({ id: tasks.id, status: tasks.status, createdByType: tasks.createdByType,
    createdAt: tasks.createdAt, updatedAt: tasks.updatedAt, completedAt: tasks.completedAt })
    .from(sql`unnest(ARRAY[${storageIds}]) AS surface(storage_id)
      CROSS JOIN LATERAL (${conversionReadChannelIdsQuery(sql`surface.storage_id`)}) AS read_scope(id)`)
    .innerJoin(tasks, eq(tasks.channelId, sql`read_scope.id`)).as("visible_task_snapshot");
  const elapsed = sql`EXTRACT(EPOCH FROM (${facts.completedAt} - ${facts.createdAt})) / 3600.0`;
  const validDuration = sql`${facts.status} = 'done' AND ${facts.completedAt} IS NOT NULL AND ${elapsed} >= 0`;
  const [row] = await getDb().select({
    total: sql<number>`count(*)`.mapWith(Number),
    backlog: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'backlog')`.mapWith(Number),
    todo: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'todo')`.mapWith(Number),
    inProgress: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'in_progress')`.mapWith(Number),
    inReview: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'in_review')`.mapWith(Number),
    done: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'done')`.mapWith(Number),
    closed: sql<number>`count(*) FILTER (WHERE ${facts.status} = 'closed')`.mapWith(Number),
    humanCreated: sql<number>`count(*) FILTER (WHERE ${facts.createdByType} = 'user')`.mapWith(Number),
    agentCreated: sql<number>`count(*) FILTER (WHERE ${facts.createdByType} = 'agent')`.mapWith(Number),
    durationSamples: sql<number>`count(*) FILTER (WHERE ${validDuration})`.mapWith(Number),
    medianHours: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${elapsed}) FILTER (WHERE ${validDuration})`.mapWith(Number),
    p90Hours: sql<number | null>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${elapsed}) FILTER (WHERE ${validDuration})`.mapWith(Number),
    firstCreatedAt: sql<Date | null>`min(${facts.createdAt})`.mapWith((value) => value === null ? null : new Date(String(value))),
    latestCreatedAt: sql<Date | null>`max(${facts.createdAt})`.mapWith((value) => value === null ? null : new Date(String(value))),
    latestUpdatedAt: sql<Date | null>`max(${facts.updatedAt})`.mapWith((value) => value === null ? null : new Date(String(value))),
  }).from(facts);
  return { ...row, surfaces: surfaces.length };
}

/** One row of `raft task list --following` (task v2). */
export interface AgentFollowedTaskConversation {
  /** `#channel:#7` / `dm:@peer:#7`, as this agent names the task's channel. */
  taskRef: string;
  taskNumber: number;
  title: string;
  status: TaskStatus;
  /** Messages from others after the agent's read position in the conversation. */
  unread: number;
  followedAt: string;
  reason: string | null;
  /** The agent-facing (local) conversation channel; null while not created yet (lazy). */
  conversationChannelId: string | null;
}

/**
 * Task v2: the task conversations an agent follows on this server (its
 * replies wake the agent), newest follow first — the task counterpart of
 * listAgentFollowedThreads. `unread` counts by the inbox's own unread rule
 * (markAgentOwnSendRead): not the agent's own sends, not system rows it
 * caused, not noise subtypes, after its read cursor on the local conversation
 * (messages live in the canonical conversation, which differs for a joint
 * channel's projection).
 *
 * Lazy conversations: a task v2 task whose conversation does not exist yet is
 * followed by its creator (`authored`) and assignee (`assigned`) from
 * creation, so it is listed for them too (unread 0), as `raft task view`
 * reports it — in the same query, reached through the channels the agent is
 * a member of on this server (a joint channel through its local projection),
 * so the task scan rides the tasks' channel index.
 */
export async function listAgentFollowedTaskConversations(
  serverId: string,
  agentId: string,
): Promise<AgentFollowedTaskConversation[]> {
  const result = await getDb().execute(sql`
    SELECT
      c.id::text AS "conversationChannelId",
      c.parent_channel_id::text AS "parentChannelId",
      t.task_number AS "taskNumber",
      t.title AS "title",
      t.status AS "status",
      tf.created_at AS "followedAt",
      tf.reason AS "reason",
      (
        SELECT count(*)::int FROM messages m
        WHERE m.channel_id = COALESCE(t.conversation_channel_id, c.id)
          AND m.seq > COALESCE((
            SELECT COALESCE(r.last_read_seq8, CAST(r.last_read_seq AS BIGINT))
            FROM agent_channel_read_cursors r
            WHERE r.agent_id = ${agentId}::uuid AND r.channel_id = c.id
          ), 0)
          AND NOT (m.sender_type = 'agent' AND m.sender_id = ${agentId}::text)
          AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'agent' AND m.causal_actor_id = ${agentId}::text, FALSE)
          AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
      ) AS "unread"
    FROM thread_follows tf
    JOIN channels c ON c.id = tf.thread_channel_id
      AND c.type = 'task'
      AND c.server_id = ${serverId}::uuid
      AND c.deleted_at IS NULL
    JOIN tasks t ON t.id = c.task_id
    WHERE tf.follower_type = 'agent'
      AND tf.follower_id = ${agentId}::uuid
      AND tf.unfollowed_at IS NULL
    UNION ALL
    SELECT
      NULL AS "conversationChannelId",
      lc.id::text AS "parentChannelId",
      t.task_number AS "taskNumber",
      t.title AS "title",
      t.status AS "status",
      CASE WHEN t.created_by_type = 'agent' AND t.created_by_id = ${agentId}::text
        THEN t.created_at ELSE COALESCE(t.claimed_at, t.created_at) END AS "followedAt",
      CASE WHEN t.created_by_type = 'agent' AND t.created_by_id = ${agentId}::text
        THEN 'authored' ELSE 'assigned' END AS "reason",
      0 AS "unread"
    FROM channel_agents ca
    JOIN channels lc ON lc.id = ca.channel_id
      AND lc.server_id = ${serverId}::uuid
      AND lc.deleted_at IS NULL
    LEFT JOIN joint_channel_servers jcs ON jcs.local_channel_id = lc.id AND jcs.status = 'active'
    LEFT JOIN joint_channels jc ON jc.id = jcs.joint_channel_id
    JOIN tasks t ON t.channel_id = COALESCE(jc.canonical_channel_id, lc.id)
    WHERE ca.agent_id = ${agentId}::uuid
      -- A v2 task without its conversation yet: its creator and assignee
      -- follow it from creation (one rule with raft task view and the web).
      AND ${pendingTaskConversationFollowerSql(taskAliasColumns("t"), { type: "agent", id: agentId })}
    ORDER BY "followedAt" DESC, "conversationChannelId" DESC NULLS LAST, "taskNumber" DESC
  `);
  const rows = result.rows as Array<{
    conversationChannelId: string | null;
    parentChannelId: string | null;
    taskNumber: number;
    title: string;
    status: TaskStatus;
    followedAt: Date | string;
    reason: string | null;
    unread: number;
  }>;
  const parentRefs = new Map<string, string | null>();
  const items: AgentFollowedTaskConversation[] = [];
  // Visibility through the one entry (visibilityService.canView), for every
  // row at once. Not created yet: the agent reaches it through the task's channel.
  const visible = await canView(
    { type: "agent", id: agentId, serverId: serverId as ServerId },
    rows.map((row) => ({ kind: "conversation" as const, channelId: row.conversationChannelId ?? row.parentChannelId ?? "" })),
  );
  for (const [index, row] of rows.entries()) {
    if (!row.parentChannelId) continue;
    if (!visible[index]) continue;
    if (!parentRefs.has(row.parentChannelId)) {
      parentRefs.set(row.parentChannelId, await resolveAgentFacingChannelRef(serverId, agentId, row.parentChannelId));
    }
    const parentRef = parentRefs.get(row.parentChannelId);
    const taskRef = parentRef ? formatAgentTaskRef(parentRef, Number(row.taskNumber)) : null;
    if (!taskRef) continue;
    items.push({
      taskRef,
      taskNumber: Number(row.taskNumber),
      title: row.title,
      status: row.status,
      unread: Number(row.unread) || 0,
      followedAt: new Date(row.followedAt).toISOString(),
      reason: row.reason,
      conversationChannelId: row.conversationChannelId,
    });
  }
  return items;
}
