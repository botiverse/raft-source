import { randomUUID } from "node:crypto";
import { eq, and, gt, inArray, sql, asc, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index.js";
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
  jointChannelServers,
} from "../db/schema.js";
import {
  currentDate,
  failpoints,
  type AgentApiTaskClaimConflict,
  type ServerId,
  type TaskResourceReceipt,
  type TaskStatus,
  TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU,
} from "@botiverse/raft-shared";
import { isMessageShortId, messageIdShortPrefixConditions, UUID_RE } from "../lib/messageId.js";
import { buildSearchText } from "./searchService.js";
import {
  canUserAccessChannel,
  getActiveJointChannelProjectionsByLocalChannel,
  type JointChannelProjection,
} from "./channelService.js";
import { resolveTaskChannelSurface } from "./taskChannelSurface.js";
import { loadTaskCurrentProjectionsByTaskId } from "./messageTaskProjection.js";

type MessageRow = typeof messages.$inferSelect;

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
  if (assignee.type === "user") {
    const [identity] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, assignee.id))
      .limit(1)
      .for("update");
    if (!identity) return null;
    const rows = await tx
      .select({ channelId: channelHumans.channelId })
      .from(channelHumans)
      .where(and(
        inArray(channelHumans.channelId, projectionIds),
        eq(channelHumans.userId, assignee.id),
      ))
      .for("update");
    for (const row of rows) reachableIds.add(row.channelId);
  } else {
    const [identity] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, assignee.id), isNull(agents.deletedAt)))
      .limit(1)
      .for("update");
    if (!identity) return null;
    const rows = await tx
      .select({ channelId: channelAgents.channelId, serverId: agents.serverId })
      .from(channelAgents)
      .innerJoin(agents, and(
        eq(agents.id, channelAgents.agentId),
        isNull(agents.deletedAt),
      ))
      .where(and(
        inArray(channelAgents.channelId, projectionIds),
        eq(channelAgents.agentId, assignee.id),
      ))
      .for("update");
    for (const row of rows) {
      const projection = projections.find((candidate) => candidate.localChannelId === row.channelId);
      if (projection?.serverId === row.serverId) reachableIds.add(row.channelId);
    }
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
    // which atomically starts it and stamps taskClaimedAt.
    if (assignedToRequester && task.taskStatus === "todo" && task.taskClaimedAt === null) return null;
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

  if (assignee.type === "user") {
    const [identity] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, assignee.id))
      .limit(1)
      .for("update");
    if (!identity) return "assignee not found";
    const [membership] = await tx
      .select({ id: users.id })
      .from(jointChannelServers)
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, jointChannelServers.localChannelId),
        eq(channelHumans.userId, assignee.id),
      ))
      .innerJoin(channels, and(
        eq(channels.id, jointChannelServers.localChannelId),
        eq(channels.serverId, jointChannelServers.serverId),
        isNull(channels.deletedAt),
      ))
      .innerJoin(users, eq(users.id, channelHumans.userId))
      .where(and(
        eq(jointChannelServers.jointChannelId, joint.id),
        eq(jointChannelServers.status, "active"),
      ))
      .limit(1)
      .for("update");
    return membership ? null : "assignee is not a member of this channel";
  }

  const [identity] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, assignee.id), isNull(agents.deletedAt)))
    .limit(1)
    .for("update");
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
    ))
    .limit(1)
    .for("update");
  return membership ? null : "assignee is not a member of this channel";
}

/** Allocate the next task number for a channel, accounting for both messages and legacy tasks. */
export async function allocateTaskNumber(channelId: string): Promise<{ taskStatus: "todo"; taskNumber: number }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${channelId}))`);

    const [{ maxMsgNum }] = await tx
      .select({ maxMsgNum: sql<number>`COALESCE(MAX(${messages.taskNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, channelId));

    let maxLegacyNum = 0;
    try {
      const [row] = await tx
        .select({ maxLegacyNum: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.channelId, channelId));
      maxLegacyNum = row?.maxLegacyNum ?? 0;
    } catch (err) {
      console.error("[taskService] legacy tasks query failed:", err);
    }

    return { taskStatus: "todo" as const, taskNumber: Math.max(maxMsgNum ?? 0, maxLegacyNum) + 1 };
  });
}

/**
 * Valid status transitions. Key = current status, value = allowed next statuses.
 *
 * `closed` is a terminal "won't do" state reachable from any active or
 * completed status — at any point a task can be deliberately abandoned. The
 * An assigned task can resume directly from `closed`; the permission check
 * below still restricts that transition to its current assignee. Unassigned
 * work must reopen to `todo` before it can be claimed.
 *
 * stdrc 2026-05-08 #proj-task:5ca7dfa3 msg=56ec4e74 ("干吧"):
 *   accepted state machine extending the closed status.
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "closed"],
  in_progress: ["in_review", "done", "closed"],
  in_review: ["done", "in_progress", "closed"],  // can send back, or abandon
  done: ["todo", "in_progress", "in_review", "closed"],  // can reopen, or retroactively abandon
  closed: ["todo", "in_progress"],  // assignee may resume directly; unassigned work reopens via todo
};

export function getTaskStatusTransitionError(
  currentStatus: TaskStatus,
  newStatus: TaskStatus,
): string | null {
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (allowed?.includes(newStatus)) return null;
  return `cannot transition from ${currentStatus} to ${newStatus}`;
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
  const channelMap = new Map<string, { name: string; type: "channel" | "private" | "joint" | "dm" | "thread" }>();

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
        type: channel.type,
      });
    }
  }

  return rows.map((t) => ({
    ...t,
    // Map to TaskInfo-compatible field names
    createdByType: t.senderType,
    createdById: t.senderId,
    createdByName: nameMap.get(t.senderId) || "Unknown",
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

  const taskConditions = [eq(tasks.channelId, channelId)];
  if (statusFilter) taskConditions.push(eq(tasks.status, statusFilter));

  let taskRows: (typeof tasks.$inferSelect)[] = [];
  try {
    taskRows = await db
      .select()
      .from(tasks)
      .where(and(...taskConditions))
      .orderBy(asc(tasks.taskNumber));
  } catch (err) {
    console.error("[listTasks] tasks query failed:", err);
  }

  return enrichTaskRows(taskRows);
}

const UNFINISHED_TASK_STATUSES = ["todo", "in_progress", "in_review"] as const satisfies readonly TaskStatus[];

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

  const conditions: SQL[] = [
    inArray(tasks.channelId, visibleChannelIds),
    eq(tasks.claimedByType, "agent"),
    eq(tasks.claimedById, agentId),
  ];
  if (statusFilter && statusFilter !== "all") {
    conditions.push(eq(tasks.status, statusFilter));
  } else if (!statusFilter) {
    conditions.push(inArray(tasks.status, [...UNFINISHED_TASK_STATUSES]));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.channelId), asc(tasks.taskNumber), asc(tasks.id));
  return enrichTaskRows(rows);
}

type TaskProjectionChannel = {
  id: string;
  name?: string | null;
  type: "channel" | "private" | "joint" | "dm" | "thread";
};

/** Project one canonical task fact into a requester's local channel surface. */
export function projectTasksToChannel<T extends {
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread";
}>(taskRows: T[], channel: TaskProjectionChannel): T[] {
  return taskRows.map((task) => ({
    ...task,
    channelId: channel.id,
    channelName: channel.name ?? task.channelName ?? null,
    channelType: channel.type,
  }));
}

export function projectTaskToChannel<T extends {
  channelId: string;
  channelName?: string | null;
  channelType?: "channel" | "private" | "joint" | "dm" | "thread";
}>(task: T, channel: TaskProjectionChannel): T {
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
 * List tasks for all non-DM, non-thread, non-archived task surfaces in a server.
 * Joint rows are read from canonical storage but projected back to the local
 * channel id, and remain membership-gated even though ordinary public-channel
 * tasks are server-visible.
 */
export async function listServerTasks(serverId: string, statusFilter: TaskStatus | undefined, userId: string) {
  const db = getDb();
  const serverChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      or(eq(channels.type, "channel"), eq(channels.type, "joint")),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.name));

  if (serverChannels.length === 0) return [];
  const taskLists = await Promise.all(serverChannels.map(async (channel) => {
    if (!await canUserAccessChannel(channel.id, userId, serverId as ServerId)) return [];
    const surface = await resolveTaskChannelSurface(serverId, channel.id);
    if (!surface) return [];
    const rows = await listTasks(surface.storageChannelId, statusFilter);
    return projectTasksToChannel(rows, surface.localChannel);
  }));
  return taskLists.flat();
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
  isLegacy: boolean;
  source: "tasks" | "message";
  hasDescription: boolean;
  descriptionBytes: number;
}

function toServerTaskSummary(task: ServerTaskListItem): ServerTaskSummary {
  const descriptionBytes = task.description ? Buffer.byteLength(task.description, "utf8") : 0;
  return {
    id: task.id,
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
    isLegacy: task.isLegacy,
    source: "tasks",
    hasDescription: descriptionBytes > 0,
    descriptionBytes,
  };
}

/**
 * Paginated / summary read over exactly the same visibility set as
 * `listServerTasks` (non-archived channel|joint surfaces, per-channel access
 * check, joint storage projection, same status filter). Anything this returns
 * is a subset of what the legacy read returns, in the same order.
 *
 * Differences from the legacy read, all opt-in from the route:
 * - `limit` bounds the page; one extra row per channel is fetched as the
 *   page-boundary witness whose existence (not a count query) sets nextCursor.
 * - `cursor` resumes strictly after a previous page's last item. A cursor
 *   naming a channel that has fallen out of the visible set (archived,
 *   deleted, access revoked) cannot be positioned in the total order, so the
 *   walk refuses it: returns "invalid cursor" for the route to map to 400.
 *   The client's remedy is to restart pagination from the beginning.
 * - `detail: "summary"` projects each item down to `ServerTaskSummary`.
 */
export async function listServerTasksPage(
  serverId: string,
  statusFilter: TaskStatus | undefined,
  userId: string,
  options: {
    limit?: number;
    cursor?: ServerTasksPageCursor | null;
    detail: "full" | "summary";
  },
): Promise<{ tasks: (ServerTaskListItem | ServerTaskSummary)[]; nextCursor: ServerTasksPageCursor | null } | "invalid cursor"> {
  const db = getDb();
  const serverChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      or(eq(channels.type, "channel"), eq(channels.type, "joint")),
      isNull(channels.archivedAt),
    ))
    .orderBy(asc(channels.name), asc(channels.id));

  let startIndex = 0;
  let afterTaskNumber: number | null = null;
  if (options.cursor) {
    startIndex = serverChannels.findIndex((channel) => channel.id === options.cursor!.channelId);
    if (startIndex === -1) return "invalid cursor";
    afterTaskNumber = options.cursor.taskNumber;
  }

  const limit = options.limit;
  const items: ServerTaskListItem[] = [];
  let hasMore = false;

  outer:
  for (let i = startIndex; i < serverChannels.length; i++) {
    const channel = serverChannels[i]!;
    if (!await canUserAccessChannel(channel.id, userId, serverId as ServerId)) continue;
    const surface = await resolveTaskChannelSurface(serverId, channel.id);
    if (!surface) continue;

    const conditions = [eq(tasks.channelId, surface.storageChannelId)];
    if (statusFilter) conditions.push(eq(tasks.status, statusFilter));
    if (i === startIndex && afterTaskNumber != null) {
      conditions.push(gt(tasks.taskNumber, afterTaskNumber));
    }
    const query = db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(asc(tasks.taskNumber));
    // `limit - items.length + 1` is >= 1 by the loop invariant; the +1 row is
    // the witness for "another page exists" and is never emitted on this page.
    const rows = limit != null
      ? await query.limit(limit - items.length + 1)
      : await query;
    const projected = projectTasksToChannel(await enrichTaskRows(rows), surface.localChannel);
    for (const task of projected) {
      if (limit != null && items.length >= limit) {
        hasMore = true;
        break outer;
      }
      items.push(task);
    }
  }

  // The cursor resumes against `serverChannels`, whose ids are this server's
  // local channel ids — the same ids projection puts on the items — so the
  // last emitted item's (channelId, taskNumber) is directly replayable.
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? { channelId: last.channelId, taskNumber: last.taskNumber }
    : null;

  if (options.detail === "summary") {
    return { tasks: items.map(toServerTaskSummary), nextCursor };
  }
  return { tasks: items, nextCursor };
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
async function enrichTaskRows(
  rows: (typeof tasks.$inferSelect)[],
  executor: DatabaseExecutor = getDb(),
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
    type: "channel" | "private" | "joint" | "dm" | "thread";
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
        type: channel.type,
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
    const jointHumanRows = await db
      .select({
        canonicalChannelId: jointChannels.canonicalChannelId,
        userId: channelHumans.userId,
      })
      .from(jointChannels)
      .innerJoin(jointChannelServers, and(
        eq(jointChannelServers.jointChannelId, jointChannels.id),
        eq(jointChannelServers.status, "active"),
      ))
      .innerJoin(channelHumans, and(
        eq(channelHumans.channelId, jointChannelServers.localChannelId),
        inArray(channelHumans.userId, [...userIds]),
      ))
      .where(and(
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

  const currentProjections = await loadTaskCurrentProjectionsByTaskId(rows, db);

  return rows.map((t) => ({
    id: t.id,
    messageId: t.messageId || t.id,
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
    revision: t.revision,
    taskCurrentProjection: currentProjections.get(t.id),
    isLegacy: t.messageId == null,
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
    and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)),
  );
  return canonical ? { source: "tasks", row: canonical } : null;
}

/** Resolve a task by the id of its host message. */
export async function resolveTaskByMessageId(messageId: string): Promise<TaskOwner | null> {
  if (!UUID_RE.test(messageId)) return null;
  const canonical = await selectCanonicalTask(eq(tasks.messageId, messageId));
  return canonical ? { source: "tasks", row: canonical } : null;
}

/** Get a single message-task by ID (message ID where taskStatus is not null). */
export async function getTask(taskId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, taskId), isNotNull(messages.taskStatus)));
  return row || null;
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
  return owner.row.messageId == null;
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

/** Get a canonical `tasks` row by channel ID + task number. */
export async function getLegacyTaskByNumber(channelId: string, taskNumber: number) {
  return selectCanonicalTask(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
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
  return event;
}

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

const TASK_AMEND_MEMBERSHIP_ERROR = "only current channel members with post access can amend the card";

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
 */
export async function amendTask(
  taskId: string,
  patch: TaskAmendPatch,
  requesterType: "user" | "agent",
  requesterId: string,
): Promise<TaskAmendmentResult | string> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  if (owner.source !== "tasks" || owner.row.messageId == null) {
    return "legacy task cards cannot be amended";
  }

  const observed = owner.row;
  if (!await isTaskAmendActorChannelMember(getDb(), observed.channelId, requesterType, requesterId)) {
    return TASK_AMEND_MEMBERSHIP_ERROR;
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
  if (Object.keys(changes).length === 0) return "task amendment makes no changes";

  await failpoints.hit("server.task.amend.afterAuthorizationRead", {
    taskId,
    requesterType,
    requesterId,
    observedRevision: observed.revision,
  });

  return getDb().transaction(async (tx) => {
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
      })
      .where(canonicalRevisionCas(observed))
      .returning();

    if (!updated) {
      const [current] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      if (!current) return "task not found";
      return "task changed concurrently; read the current card and retry";
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
  });
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
  if (owner.source !== "tasks" || owner.row.messageId == null) {
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
  items: { title: string; description?: string; createsResource?: boolean }[],
) {
  if (items.length === 0) return { tasks: [], hostMessages: [] };
  const db = getDb();

  // Use a transaction with advisory lock on channel to prevent task number collisions
  const created = await db.transaction(async (tx) => {
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
    // Check both messages and legacy tasks tables to avoid number collisions
    const [{ maxMsgNum }] = await tx
      .select({ maxMsgNum: sql<number>`COALESCE(MAX(${messages.taskNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, channelId));

    let maxLegacyNum = 0;
    try {
      const [row] = await tx
        .select({ maxLegacyNum: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.channelId, channelId));
      maxLegacyNum = row?.maxLegacyNum ?? 0;
    } catch (err) {
      console.error("[taskService] legacy tasks query failed:", err);
    }

    let nextNum = Math.max(maxMsgNum ?? 0, maxLegacyNum) + 1;

    // v1.4 (tasks-table-canonical): the host message is a PLAIN channel message
    // (no task_status) that serves as display/thread anchor; the task fact lives
    // in the canonical `tasks` table, linked by messageId. New tasks are never
    // written into messages.task_*, so they never form a dual representation.
    const hostValues = items.map((item) => ({
      channelId,
      senderType: createdByType as "user" | "agent",
      senderId: createdById,
      messageType: "chat" as const,
      content: item.title,
    }));
    const hostMessages = await tx.insert(messages).values(hostValues).returning();

    const taskRows: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const host = hostMessages[i];
      const [taskRow] = await tx
        .insert(tasks)
        .values({
          channelId,
          taskNumber: nextNum++,
          title: item.title,
          description: item.description ?? null,
          status: "todo",
          requiresResourceReceipt: item.createsResource === true,
          createdByType,
          createdById,
          messageId: host.id,
        })
        .returning();
      await recordTaskEvent(tx, taskRow.id, "created", createdByType, createdById, {
        taskNumber: taskRow.taskNumber,
        status: "todo",
        requiresResourceReceipt: taskRow.requiresResourceReceipt,
      });
      taskRows.push(taskRow);
    }

    return { hostMessages, taskRows };
  });

  const { recordInboxFactsForPersistedMessages } = await import("./messageService.js");
  await recordInboxFactsForPersistedMessages(created.hostMessages, {
    inboxFactPolicy: {
      mode: "record",
      producer: "task.body",
      reason: "task body messages are durable shared work items and count as channel activity",
    },
    dedupeLogicalReceiverAcrossJointProjections: true,
  });

  const enrichedTasks = await enrichTaskRows(created.taskRows);
  return { tasks: enrichedTasks, hostMessages: created.hostMessages };
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
  items: { title: string; description?: string; createsResource?: boolean }[],
  assignee: TaskCreationAssignee,
  receiptRequest: TaskAssignmentReceiptRequest,
  opts: { initiatingLocalChannelId?: string } = {},
): Promise<{
  tasks: Awaited<ReturnType<typeof enrichTaskRows>>;
  hostMessages: MessageRow[];
  assignmentReceipt: TaskAssignmentReceipt;
}> {
  if (items.length === 0) throw new Error("Assigned task creation requires at least one task");
  const db = getDb();

  return db.transaction(async (tx) => {
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
    if (channelSnapshot.type === "thread" || (channelSnapshot.type === "joint" && !jointRequest)) {
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

    const [{ maxMsgNum }] = await tx
      .select({ maxMsgNum: sql<number>`COALESCE(MAX(${messages.taskNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, channelId));

    let maxLegacyNum = 0;
    try {
      const [row] = await tx
        .select({ maxLegacyNum: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.channelId, channelId));
      maxLegacyNum = row?.maxLegacyNum ?? 0;
    } catch (err) {
      console.error("[taskService] legacy tasks query failed:", err);
    }

    let nextNum = Math.max(maxMsgNum ?? 0, maxLegacyNum) + 1;
    const startsAssignedWork = assignee.type === createdByType && assignee.id === createdById;
    const claimedAt = startsAssignedWork ? currentDate() : null;
    const initialStatus = startsAssignedWork ? "in_progress" as const : "todo" as const;

    // v1.4 (tasks-table-canonical): plain host messages + canonical tasks rows.
    // The assignee and status live on the task row, not messages.task_*.
    const created = await tx.insert(messages).values(items.map((item) => ({
      channelId,
      senderType: createdByType,
      senderId: createdById,
      messageType: "chat" as const,
      content: item.title,
    }))).returning();

    const taskRows: (typeof tasks.$inferSelect)[] = [];
    for (let i = 0; i < items.length; i++) {
      const host = created[i];
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
          messageId: host.id,
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
      taskIds: created.map((task) => task.id),
    }, async () => undefined);

    await tx.update(userChannelInboxStates)
      .set({ doneAt: null, updatedAt: currentDate() })
      .where(and(
        eq(userChannelInboxStates.channelId, channelId),
        isNotNull(userChannelInboxStates.doneAt),
      ));

    const messageService = await import("./messageService.js");
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

    const state = startsAssignedWork ? "started" as const : "assigned" as const;
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

    await messageService.recordInboxFactsForPersistedMessages([receiptMessage], {
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
      causalActorByMessageId: new Map([[receiptMessage.id, { type: createdByType, id: createdById }]]),
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
    return {
      tasks: enriched,
      hostMessages: created,
      assignmentReceipt: {
        message: receiptMessage,
        content: receiptContent,
        assignee: assigneeRef,
        state,
      },
    };
  });
}

/** Claim a task (set assignee). Does not require specific status. If status is todo, auto-advances to in_progress. */
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
): Promise<TaskClaimOutcome> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return { result: "task not found" };
  const written = await writeCanonicalClaim(getDb(), owner.row, claimedByType, claimedById);
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
): Promise<TaskMutationResult> {
  return (await claimTaskDetailed(taskId, claimedByType, claimedById)).result;
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
  | { source: "tasks"; row: TaskRow }
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
): Promise<{
  taskNumber: number;
  success: boolean;
  reason?: string;
  conflict?: AgentApiTaskClaimConflict;
  task?: { source: "tasks"; row: TaskRow };
}[]> {
  const db = getDb();
  const results: Awaited<ReturnType<typeof batchClaimTasks>> = [];

  await db.transaction(async (tx) => {
    for (const num of taskNumbers) {
      // Canonical first: if a `tasks` row owns this number, the message-task
      // columns are a stale shadow and must not be claimed instead.
      const [canonical] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, num)))
        .for("update");

      if (canonical) {
        // Orphans stay unreachable from the agent surface — same reason and
        // same wording as `getTaskByNumber`. Before v1.4 this query ran against
        // `messages` alone, so an orphan produced exactly this result.
        if (canonical.messageId == null) {
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
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonical(await writeCanonicalUnclaim(getDb(), owner.row, requesterType, requesterId));
}

/**
 * Set or clear a task's assignee.
 *
 * This is the v1.4 successor to "claim", and it is deliberately NOT a superset
 * of it:
 *
 *  - **`claim` assigns self AND advances `todo -> in_progress`.** Claiming means
 *    "I am starting this."
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
export async function assignTask(
  taskId: string,
  assignee: TaskCreationAssignee | null,
  actorType: "user" | "agent",
  actorId: string,
  opts: { expectedRevision?: number } = {},
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
  if (sameAssignee) return wrapCanonical(observed);

  return wrapCanonical(await getDb().transaction(async (tx) => {
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
    });
    return updated;
  }));
}

/** Update task status. Validates transition. Assignee or admin can update. Sets completedAt when transitioning to done. */
export async function updateTaskStatus(
  taskId: string,
  newStatus: TaskStatus,
  requesterId: string,
  requesterType?: "user" | "agent",
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonical(
    await writeCanonicalStatus(getDb(), owner.row, newStatus, { requesterId, requesterType }),
  );
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
): Promise<TaskMutationResult> {
  const owner = await resolveTaskById(taskId);
  if (!owner) return "task not found";
  return wrapCanonical(await writeCanonicalStatus(getDb(), owner.row, newStatus, {
    force: true,
    requesterType: actorType,
    requesterId: actorId,
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
): Promise<TaskRow | string> {
  const db = getDb();

  // Look up the message
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) return "message not found";

  // Validate channel ownership if expected channel is provided
  if (expectedChannelId && msg.channelId !== expectedChannelId) return "message not in this channel";

  const [channel] = await db
    .select({ type: channels.type })
    .from(channels)
    .where(eq(channels.id, msg.channelId));
  if (!channel) return "channel not found";
  if (channel.type === "thread") return "thread messages cannot be claimed as tasks";
  if (msg.senderType === "external_projection") {
    return "external projection messages cannot be claimed as tasks";
  }
  if (msg.messageType === "system")
    return "system messages cannot be claimed as tasks — if the message describes an action you should take, just do it; otherwise ignore it. Don't claim.";

  // Check if already a task — either the legacy message-task shape, or a v1.4
  // canonical tasks-table row already linked to this message.
  if (msg.taskStatus !== null) return "already converted";
  const [existingLink] = await db.select().from(tasks).where(eq(tasks.messageId, messageId));
  if (existingLink) return "already converted";

  // v1.4 (tasks-table-canonical): create a canonical tasks row linked to the
  // message; the message itself stays a plain message (task_status untouched).
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${msg.channelId}))`);

    // Check both messages and tasks tables to avoid number collisions
    const [{ maxMsgNum }] = await tx
      .select({ maxMsgNum: sql<number>`COALESCE(MAX(${messages.taskNumber}), 0)` })
      .from(messages)
      .where(eq(messages.channelId, msg.channelId));

    let maxLegacyNum = 0;
    try {
      const [legacyRow] = await tx
        .select({ maxLegacyNum: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.channelId, msg.channelId));
      maxLegacyNum = legacyRow?.maxLegacyNum ?? 0;
    } catch (err) {
      console.error("[taskService] legacy tasks query failed:", err);
    }

    const nextNum = Math.max(maxMsgNum ?? 0, maxLegacyNum) + 1;

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
  });

  if (!created) return "already converted";
  return created;
}

/** Get a task by message ID. v1.4: a task may be a legacy message-task (task
 *  state on the message) OR a canonical tasks-table row linked via messageId. */
export async function getTaskByMessageId(messageId: string) {
  return (await resolveTaskByMessageId(messageId))?.row ?? null;
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
): Promise<TaskRow | null> {
  const created = await convertMessageToTask(messageId, createdByType, createdById);
  if (typeof created !== "string") return created;
  if (created === "already converted") {
    const owner = await resolveTaskByMessageId(messageId);
    return owner?.row ?? null;
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
export async function deleteTaskByOwner(owner: TaskOwner) {
  if (owner.row.messageId) await deleteTask(owner.row.messageId);
  await deleteLegacyTask(owner.row.id);
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
  const db = getDb();
  await db
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
  return and(eq(tasks.id, row.id), eq(tasks.revision, row.revision));
}

/** Claimable-by-this-actor predicate, mirroring taskClaimCasPredicate. */
function canonicalClaimCasPredicate(claimedByType: "user" | "agent", claimedById: string) {
  return and(
    sql`${tasks.status} != 'done'`,
    or(
      and(
        isNull(tasks.claimedByType),
        isNull(tasks.claimedById),
        isNull(tasks.claimedAt),
      ),
      and(
        eq(tasks.claimedByType, claimedByType),
        eq(tasks.claimedById, claimedById),
        eq(tasks.status, "todo"),
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
  const nextStatus: TaskStatus = previousStatus === "todo" ? "in_progress" : previousStatus;

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

/**
 * Status transition on a canonical task.
 *
 * `force: true` is the admin/owner override — it skips the assignee check but
 * keeps every state-machine guard, matching forceUpdateTaskStatus on the
 * message side.
 */
async function writeCanonicalStatus(
  executor: DatabaseExecutor,
  observed: TaskRow,
  newStatus: TaskStatus,
  opts: { requesterId?: string; requesterType?: "user" | "agent"; force?: boolean },
): Promise<TaskRow | string> {
  const previousStatus = observed.status as TaskStatus;
  const force = opts.force === true;

  // This is a completion invariant, not a permission check. Every writer,
  // including the owner/admin force path, must cross it.
  if (newStatus === "done" && observed.requiresResourceReceipt && !hasCompleteTaskResourceReceipt(observed)) {
    return "resource receipt required before task can move to done";
  }

  if (force) {
    if (previousStatus === newStatus) return `already ${newStatus}`;
    if (previousStatus === "todo" && newStatus === "in_progress" && !observed.claimedById) {
      return "task must be claimed before moving to in_progress";
    }
    if (previousStatus === "todo" && newStatus === "in_progress" && observed.claimedAt !== null) {
      return "task start state changed concurrently";
    }
  } else {
    const transitionError = getTaskStatusTransitionError(previousStatus, newStatus);
    if (transitionError) return transitionError;
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
    if (previousStatus === "todo" && newStatus === "in_progress" && observed.claimedAt !== null) {
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
  if ((previousStatus === "todo" || previousStatus === "closed") && newStatus === "in_progress") {
    // Starting preassigned todo work and resuming closed owned work both stamp
    // the current ownership epoch, exactly as updateMessageTaskStatus does. The
    // assignee check plus the revision CAS keep a stale owner from reviving it.
    setFields.claimedAt = nextClaimedAt(observed.claimedAt);
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

  const [updated] = await executor
    .update(tasks)
    .set(setFields)
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
  });
  return updated;
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

  const db = getDb();
  return db.transaction(async (tx) => {
    const [observed] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update");
    if (!observed) return "task not found";
    if (!observed.requiresResourceReceipt) return "task is not marked as creating a resource";
    if (!observed.messageId) return "resource receipt requires a task message anchor";

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

    const followupId = randomUUID();
    const recordedAt = currentDate();
    const expiryFollowup = await input.expiryFollowups.create({
      id: followupId,
      serverId: input.teardownOwnerServerId,
      ownerAgentId: input.teardownOwnerAgentId,
      targetChannelId: input.teardownOwnerTargetChannelId,
      msgId: observed.messageId,
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
    return { task: updated, expiryFollowup, receipt: normalized, idempotent: false };
  });
}

/** Get a canonical task row by ID. */
export async function getLegacyTask(taskId: string) {
  if (!UUID_RE.test(taskId)) return null;
  return selectCanonicalTask(eq(tasks.id, taskId));
}

/** Delete a canonical task row (task_events cascade with it). */
export async function deleteLegacyTask(taskId: string) {
  const db = getDb();
  await db.delete(tasks).where(eq(tasks.id, taskId));
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
