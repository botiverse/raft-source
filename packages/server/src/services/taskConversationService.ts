import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { channels, jointChannels, jointChannelServers, tasks, threadFollows } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { withChannelWriterFence } from "./channelConversionFenceService";
import { getActiveJointChannelProjectionsByLocalChannel } from "./channelService";
import { isTaskV2ConversationsEnabled } from "./taskConversationsGate";
import { pendingTaskConversationFollowerSql, taskUsesOwnConversation } from "./taskV2Mode";

/**
 * Task v2 task conversations (#wg-task-v2).
 *
 * A task's discussion is its own sub-conversation: a `channels` row with
 * `type = 'task'` and `task_id`, whose `parent_channel_id` is the channel the
 * task lives in. Replies are ordinary `messages` rows in it, so edit,
 * attachments, reactions, mentions and search all reuse the message system;
 * follow / notification / unread / delivery are the thread rules
 * (`isSubConversationType`).
 *
 * Joint channels mirror joint THREAD projections exactly: one canonical
 * conversation on the task's storage channel (the only place messages are
 * stored, `tasks.conversation_channel_id`), plus one local conversation per
 * participating server (`type = 'task'`, same `task_id`, `parent_channel_id` =
 * that server's local channel), linked through `joint_channels`
 * (canonical_channel_id = canonical conversation) + `joint_channel_servers`.
 * Follows and read cursors are kept per local conversation.
 *
 * Lazy, like a thread (decided 2026-10-21): creating a task creates only the
 * task. Its conversation is created by the first action that needs it — a
 * reply, a follow / unfollow, a lifecycle line, a resource-receipt line, the
 * web opening it (ensureTaskConversation) — for task v2 and pre-v2 tasks
 * alike, per initiating server (whose flag must be on).
 *
 * Who follows (spec §4): when the conversation is created, the task's creator
 * (reason `authored`) and its current assignee (`assigned`), in the creating
 * transaction; later an assignee (`assigned`; self-claim too), anyone who
 * replies or is @mentioned (send path), manual follow. The source message's
 * author gets nothing.
 */

export function taskConversationChannelName(taskId: string): string {
  return `task-${taskId.slice(0, 8)}`;
}

type StorageChannel = { id: string; serverId: string; type: string };
type TaskConversationTask = { id: string; channelId: string };
export type TaskConversationActor = { type: "user" | "agent"; id: string };

export type CreatedTaskConversation = {
  taskId: string;
  canonicalChannelId: string;
  /** Joint only: the joint record linking canonical and local conversations. */
  jointChannelId: string | null;
  /** serverId -> local conversation id (non-joint: the storage server -> canonical). */
  localByServer: Map<string, { localChannelId: string; localParentChannelId: string }>;
};

/**
 * Create the conversation of each task inside the creating transaction:
 * canonical conversation, `tasks.conversation_channel_id`, and for a joint
 * storage channel one local projection per active participating server.
 * Idempotent per task: a task that already has a conversation is returned as
 * is (the caller holds the channel writer fence / task row lock).
 */
export async function createTaskConversationsInTransaction(
  tx: DatabaseExecutor,
  input: {
    tasks: readonly TaskConversationTask[];
    storageChannel: StorageChannel;
    initiatingServerId: string;
    createdByUserId?: string | null;
  },
): Promise<Map<string, CreatedTaskConversation>> {
  const created = new Map<string, CreatedTaskConversation>();
  if (input.tasks.length === 0) return created;
  const jointProjections = await getActiveJointChannelProjectionsByLocalChannel(input.storageChannel.id, tx);
  const isJointStorage = jointProjections.length > 0
    && jointProjections.every((projection) => projection.localChannelId !== input.storageChannel.id);

  const existing = await tx
    .select({ id: tasks.id, conversationChannelId: tasks.conversationChannelId })
    .from(tasks)
    .where(inArray(tasks.id, input.tasks.map((task) => task.id)));
  const existingByTask = new Map(existing.map((row) => [row.id, row.conversationChannelId]));

  for (const task of input.tasks) {
    const already = existingByTask.get(task.id);
    if (already) {
      const resolved = await loadTaskConversationProjections(already, tx);
      if (resolved) {
        created.set(task.id, resolved);
        continue;
      }
    }
    const canonicalId = randomUUID();
    await tx.insert(channels).values({
      id: canonicalId,
      serverId: input.storageChannel.serverId,
      name: taskConversationChannelName(task.id),
      type: "task",
      taskId: task.id,
      parentMessageId: null,
      // Explicit: the task's (storage) channel. The task_conversation_channels migration trigger derives the
      // same value when it is left NULL, but schema-pushed dev databases
      // (raftdev) have no trigger, and a NULL parent makes the conversation
      // unreachable (no access, no listings).
      parentChannelId: task.channelId,
    });
    await tx.update(tasks).set({ conversationChannelId: canonicalId }).where(eq(tasks.id, task.id));

    const localByServer = new Map<string, { localChannelId: string; localParentChannelId: string }>();
    let jointChannelId: string | null = null;
    if (isJointStorage) {
      const [joint] = await tx.insert(jointChannels).values({
        canonicalChannelId: canonicalId,
        createdByServerId: input.initiatingServerId,
        createdByUserId: input.createdByUserId ?? null,
        status: "active",
      }).returning({ id: jointChannels.id });
      jointChannelId = joint!.id;
      for (const projection of jointProjections) {
        const local = await ensureLocalTaskConversationProjection(tx, {
          jointChannelId,
          taskId: task.id,
          localParentProjection: projection,
          joinedByUserId: projection.serverId === input.initiatingServerId ? input.createdByUserId ?? null : null,
        });
        localByServer.set(projection.serverId, { localChannelId: local.localChannelId, localParentChannelId: projection.localChannelId });
      }
    } else {
      localByServer.set(input.storageChannel.serverId, { localChannelId: canonicalId, localParentChannelId: input.storageChannel.id });
    }
    created.set(task.id, { taskId: task.id, canonicalChannelId: canonicalId, jointChannelId, localByServer });
  }
  return created;
}

/**
 * One local task conversation for a joint server (mirror of
 * channelService.ensureJointThreadProjectionForLocalParent).
 */
export async function ensureLocalTaskConversationProjection(
  executor: DatabaseExecutor,
  input: {
    jointChannelId: string;
    taskId: string;
    localParentProjection: { serverId: string; localChannelId: string; role: "host" | "participant" };
    joinedByUserId: string | null;
  },
): Promise<{ localChannelId: string; created: boolean }> {
  const [existingLocal] = await executor
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(and(
      eq(jointChannelServers.jointChannelId, input.jointChannelId),
      eq(jointChannelServers.serverId, input.localParentProjection.serverId),
      eq(jointChannelServers.status, "active"),
    ))
    .limit(1);
  if (existingLocal?.localChannelId) return { localChannelId: existingLocal.localChannelId, created: false };

  const localId = randomUUID();
  await executor.insert(channels).values({
    id: localId,
    serverId: input.localParentProjection.serverId,
    name: taskConversationChannelName(input.taskId),
    type: "task",
    taskId: input.taskId,
    parentMessageId: null,
    parentChannelId: input.localParentProjection.localChannelId,
  });
  await executor.insert(jointChannelServers).values({
    jointChannelId: input.jointChannelId,
    serverId: input.localParentProjection.serverId,
    localChannelId: localId,
    role: input.localParentProjection.role,
    status: "active",
    joinedByUserId: input.joinedByUserId,
  }).onConflictDoNothing();
  return { localChannelId: localId, created: true };
}

/**
 * A server joined a joint channel: give it a local conversation for every
 * task conversation under the channel (mirror of
 * backfillJointThreadProjectionsForLocalParent).
 */
export async function backfillJointTaskConversationProjectionsForLocalParent(
  executor: DatabaseExecutor,
  input: {
    canonicalParentChannelId: string;
    localParentProjection: { serverId: string; localChannelId: string; role: "host" | "participant" };
    joinedByUserId: string | null;
  },
): Promise<void> {
  const canonicalConversation = channels;
  const rows = await executor
    .select({ jointChannelId: jointChannels.id, taskId: tasks.id })
    .from(tasks)
    .innerJoin(canonicalConversation, eq(canonicalConversation.id, tasks.conversationChannelId))
    .innerJoin(jointChannels, eq(jointChannels.canonicalChannelId, canonicalConversation.id))
    .where(and(
      eq(tasks.channelId, input.canonicalParentChannelId),
      eq(canonicalConversation.type, "task"),
      isNull(canonicalConversation.deletedAt),
      eq(jointChannels.status, "active"),
    ));
  for (const row of rows) {
    await ensureLocalTaskConversationProjection(executor, {
      jointChannelId: row.jointChannelId,
      taskId: row.taskId,
      localParentProjection: input.localParentProjection,
      joinedByUserId: input.joinedByUserId,
    });
  }
}

async function loadTaskConversationProjections(
  canonicalChannelId: string,
  executor: DatabaseExecutor,
): Promise<CreatedTaskConversation | null> {
  const [canonical] = await executor
    .select({ id: channels.id, serverId: channels.serverId, taskId: channels.taskId, parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(and(eq(channels.id, canonicalChannelId), eq(channels.type, "task"), isNull(channels.deletedAt)))
    .limit(1);
  if (!canonical?.taskId) return null;
  const projections = await executor
    .select({
      jointChannelId: jointChannels.id,
      serverId: jointChannelServers.serverId,
      localChannelId: jointChannelServers.localChannelId,
      localParentChannelId: channels.parentChannelId,
    })
    .from(jointChannels)
    .innerJoin(jointChannelServers, eq(jointChannelServers.jointChannelId, jointChannels.id))
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(
      eq(jointChannels.canonicalChannelId, canonicalChannelId),
      eq(jointChannels.status, "active"),
      eq(jointChannelServers.status, "active"),
      isNull(channels.deletedAt),
    ))
    .orderBy(asc(jointChannelServers.joinedAt));
  const localByServer = new Map<string, { localChannelId: string; localParentChannelId: string }>();
  if (projections.length === 0) {
    localByServer.set(canonical.serverId, { localChannelId: canonical.id, localParentChannelId: canonical.parentChannelId ?? "" });
  }
  for (const projection of projections) {
    if (!projection.localParentChannelId) continue;
    localByServer.set(projection.serverId, {
      localChannelId: projection.localChannelId,
      localParentChannelId: projection.localParentChannelId,
    });
  }
  return {
    taskId: canonical.taskId,
    canonicalChannelId: canonical.id,
    jointChannelId: projections[0]?.jointChannelId ?? null,
    localByServer,
  };
}

/** The canonical conversation of a task plus its local projections; null when none exists yet. */
export async function getTaskConversation(
  taskId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<CreatedTaskConversation | null> {
  if (!UUID_RE.test(taskId)) return null;
  const [task] = await executor
    .select({ conversationChannelId: tasks.conversationChannelId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task?.conversationChannelId) return null;
  return loadTaskConversationProjections(task.conversationChannelId, executor);
}

/**
 * Task deletion (W6): the task's conversations by the parent channel each is
 * seen through (canonical: the task's channel; joint: each server's local
 * channel). Read before the task row is deleted — `channels.task_id ON DELETE
 * cascade` removes them, their replies, follows and inbox facts with it — so
 * each surface's `task:deleted` can name the conversation it loses.
 */
export async function listTaskConversationsByParentChannel(
  taskId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!UUID_RE.test(taskId)) return out;
  const rows = await executor
    .select({ id: channels.id, parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(and(eq(channels.taskId, taskId), eq(channels.type, "task")));
  for (const row of rows) if (row.parentChannelId) out.set(row.parentChannelId, row.id);
  return out;
}

/**
 * The conversation a surface sees for a task: for a local channel id (the
 * channel a request came through), the local task conversation under it —
 * the canonical conversation for an ordinary channel, that server's local
 * projection for a joint channel. Null when the task has no conversation yet.
 */
export async function resolveLocalTaskConversationId(
  taskId: string,
  localParentChannelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<string | null> {
  const conversation = await getTaskConversation(taskId, executor);
  if (!conversation) return null;
  for (const local of conversation.localByServer.values()) {
    if (local.localParentChannelId === localParentChannelId) return local.localChannelId;
  }
  // The storage channel itself (system/agent callers holding the storage id).
  const [canonical] = await executor
    .select({ parentChannelId: channels.parentChannelId })
    .from(channels)
    .where(eq(channels.id, conversation.canonicalChannelId))
    .limit(1);
  return canonical?.parentChannelId === localParentChannelId ? conversation.canonicalChannelId : null;
}

export type TaskConversationIdentity = {
  /** The conversation channel this lookup started from (local projection or canonical). */
  conversationChannelId: string;
  canonicalConversationChannelId: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  /** The task's storage channel (canonical parent). */
  taskChannelId: string;
  /** Parent channel as seen from this conversation's server. */
  localParentChannelId: string | null;
  serverId: string;
};

/** Task conversation channel id (canonical or local) -> its task. Null for anything else. */
export async function getTaskForConversationChannel(
  conversationChannelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<TaskConversationIdentity | null> {
  const [row] = await executor
    .select({
      conversationChannelId: channels.id,
      serverId: channels.serverId,
      parentChannelId: channels.parentChannelId,
      taskId: tasks.id,
      taskNumber: tasks.taskNumber,
      taskTitle: tasks.title,
      taskChannelId: tasks.channelId,
      canonicalConversationChannelId: tasks.conversationChannelId,
    })
    .from(channels)
    .innerJoin(tasks, eq(tasks.id, channels.taskId))
    .where(and(eq(channels.id, conversationChannelId), eq(channels.type, "task")))
    .limit(1);
  if (!row) return null;
  return {
    conversationChannelId: row.conversationChannelId,
    canonicalConversationChannelId: row.canonicalConversationChannelId ?? row.conversationChannelId,
    taskId: row.taskId,
    taskNumber: row.taskNumber,
    taskTitle: row.taskTitle,
    taskChannelId: row.taskChannelId,
    localParentChannelId: row.parentChannelId,
    serverId: row.serverId,
  };
}

/** Batch: task conversation channel ids -> task id (non-task ids absent). */
export async function getTaskIdsForConversationChannels(
  conversationChannelIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, string>> {
  const ids = [...new Set(conversationChannelIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await executor
    .select({ id: channels.id, taskId: channels.taskId })
    .from(channels)
    .where(and(inArray(channels.id, ids), eq(channels.type, "task")));
  for (const row of rows) if (row.taskId) out.set(row.id, row.taskId);
  return out;
}

/**
 * Write a task-conversation follow row inside a transaction (creation /
 * assignment). An explicit unfollow is respected unless `reactivateUnfollowed`.
 * The conversation is the follower's LOCAL conversation.
 */
export async function insertTaskConversationFollow(
  executor: DatabaseExecutor,
  input: {
    conversationChannelId: string;
    taskId: string;
    follower: TaskConversationActor;
    reason: "authored" | "assigned" | "manual" | "replied" | "mentioned";
    reactivateUnfollowed?: boolean;
  },
): Promise<boolean> {
  const reactivate = input.reactivateUnfollowed ?? false;
  const result = await executor.execute(sql`
    INSERT INTO ${threadFollows} (thread_channel_id, follower_type, follower_id, parent_message_id, parent_task_id, reason, done_at, unfollowed_at)
    VALUES (${input.conversationChannelId}::uuid, ${input.follower.type}, ${input.follower.id}::uuid, NULL, ${input.taskId}::uuid, ${input.reason}, NULL, NULL)
    ON CONFLICT (thread_channel_id, follower_type, follower_id) DO UPDATE
    SET parent_task_id = EXCLUDED.parent_task_id,
        created_at = CASE WHEN ${threadFollows}.unfollowed_at IS NOT NULL THEN now() ELSE ${threadFollows}.created_at END,
        done_at = NULL,
        unfollowed_at = NULL,
        -- An automatic re-follow drops a stored "mentions" (the unfollow it
        -- undoes); an explicit "none" stays (contract §1.1).
        notification_level = CASE WHEN ${threadFollows}.notification_level = 'mentions' THEN NULL ELSE ${threadFollows}.notification_level END
    WHERE ${reactivate} OR ${threadFollows}.unfollowed_at IS NULL
    RETURNING thread_channel_id
  `);
  return result.rows.length > 0;
}

/**
 * The local conversation (on the follower's server) a follower of a task
 * conversation follows. Ordinary channel: the canonical conversation. Joint:
 * the projection whose local parent channel the follower is a member of
 * (first by join order), else the projection of `preferredServerId`.
 */
export async function resolveFollowerLocalTaskConversation(
  conversation: CreatedTaskConversation,
  follower: TaskConversationActor,
  opts: { preferredServerId?: string; executor?: DatabaseExecutor } = {},
): Promise<string | null> {
  const executor = opts.executor ?? getDb();
  const locals = [...conversation.localByServer.entries()];
  if (locals.length === 1) return locals[0]![1].localChannelId;
  const channelService = await import("./channelService");
  for (const [, local] of locals) {
    const isMember = follower.type === "user"
      ? await channelService.isChannelHuman(local.localParentChannelId, follower.id, executor)
      : await channelService.isChannelAgent(local.localParentChannelId, follower.id, executor);
    if (isMember) return local.localChannelId;
  }
  if (opts.preferredServerId) return conversation.localByServer.get(opts.preferredServerId)?.localChannelId ?? null;
  return null;
}

type TaskConversationCreationFollowSource = {
  id: string;
  createdByType: string;
  createdById: string;
  claimedByType: string | null;
  claimedById: string | null;
};

function taskActor(type: string | null, id: string | null): TaskConversationActor | null {
  return (type === "user" || type === "agent") && id ? { type, id } : null;
}

/**
 * The follows a task conversation starts with, written in the transaction
 * that creates it: the task's creator (`authored`) and its current assignee
 * (`assigned`; the creator who took their own task stays `authored`), each on
 * their own local conversation (joint: the projection of a channel they are
 * in, else the initiating server's).
 */
export async function insertTaskConversationCreationFollows(
  tx: DatabaseExecutor,
  conversation: CreatedTaskConversation,
  task: TaskConversationCreationFollowSource,
  initiatingServerId: string,
): Promise<void> {
  const creator = taskActor(task.createdByType, task.createdById);
  const assignee = taskActor(task.claimedByType, task.claimedById);
  const follows: { follower: TaskConversationActor; reason: "authored" | "assigned" }[] = [];
  if (creator) follows.push({ follower: creator, reason: "authored" });
  if (assignee && !(creator && creator.type === assignee.type && creator.id === assignee.id)) {
    follows.push({ follower: assignee, reason: "assigned" });
  }
  for (const { follower, reason } of follows) {
    const local = await resolveFollowerLocalTaskConversation(conversation, follower, {
      preferredServerId: initiatingServerId,
      executor: tx,
    });
    if (!local) continue;
    await insertTaskConversationFollow(tx, {
      conversationChannelId: local,
      taskId: conversation.taskId,
      follower,
      reason,
      // Being given or taking the task is personal attention: an assignee's
      // follow reactivates an explicit unfollow, as assignment / claim do
      // (taskConversationNotice). A just-created conversation normally has no
      // rows yet; this keeps the rule one rule.
      reactivateUnfollowed: reason === "assigned",
    });
  }
}

/**
 * Lazy conversation (no backfill): the first write (reply, lifecycle line,
 * follow) creates it, and the task's creator and assignee follow it from then
 * on. Per-task mode (./taskV2Mode): a task created the v2 way
 * (`own_conversation`) always gets it, whatever the flag (rollback, the
 * flag-off side of a joint channel); a pre-v2 task only when the flag is on
 * for the INITIATING server (where the request came from). Idempotent and safe
 * under concurrency (task row `FOR UPDATE` inside the channel writer fence).
 * Returns the conversation, or null for a pre-v2 task with the flag off / an
 * unknown task / a task whose channel is gone.
 */
export async function ensureTaskConversation(
  taskId: string,
  opts: { initiatingServerId?: string | null; createdByUserId?: string | null; executor?: DatabaseExecutor } = {},
): Promise<{ conversation: CreatedTaskConversation; created: boolean } | null> {
  if (!UUID_RE.test(taskId)) return null;
  const db = opts.executor ?? getDb();
  const existing = await getTaskConversation(taskId, db);
  if (existing) return { conversation: existing, created: false };
  const [observed] = await db
    .select({ task: tasks, storage: channels })
    .from(tasks)
    .innerJoin(channels, eq(channels.id, tasks.channelId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!observed || observed.storage.deletedAt) return null;
  const initiatingServerId = opts.initiatingServerId ?? observed.storage.serverId;
  if (!taskUsesOwnConversation(observed.task, await isTaskV2ConversationsEnabled(initiatingServerId, db))) return null;

  const write = async (tx: DatabaseExecutor) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    if (!task) return null;
    if (task.conversationChannelId) {
      const resolved = await loadTaskConversationProjections(task.conversationChannelId, tx);
      if (resolved) return { conversation: resolved, created: false };
    }
    const created = await createTaskConversationsInTransaction(tx, {
      tasks: [{ id: task.id, channelId: task.channelId }],
      storageChannel: observed.storage,
      initiatingServerId,
      createdByUserId: opts.createdByUserId ?? null,
    });
    const conversation = created.get(task.id);
    if (!conversation) return null;
    await insertTaskConversationCreationFollows(tx, conversation, task, initiatingServerId);
    return { conversation, created: true };
  };
  return opts.executor ? write(opts.executor) : withChannelWriterFence(observed.task.channelId, write);
}

/**
 * Which of these tasks' conversations a person follows, as seen through
 * `localParentChannelId` (the channel a request came through): the canonical
 * conversation of an ordinary channel, that server's local projection under a
 * joint channel. Tasks without a conversation (or not followed) are false.
 */
export async function getUserTaskConversationFollowStates(
  userId: string,
  localParentChannelId: string,
  taskIds: readonly string[],
  executor: DatabaseExecutor = getDb(),
): Promise<Map<string, boolean>> {
  const ids = [...new Set(taskIds)].filter((id) => UUID_RE.test(id));
  const out = new Map<string, boolean>(ids.map((id) => [id, false]));
  if (ids.length === 0) return out;
  const rows = await executor
    .select({ taskId: channels.taskId })
    .from(threadFollows)
    .innerJoin(channels, and(
      eq(channels.id, threadFollows.threadChannelId),
      eq(channels.type, "task"),
      isNull(channels.deletedAt),
    ))
    .where(and(
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, userId),
      isNull(threadFollows.unfollowedAt),
      eq(channels.parentChannelId, localParentChannelId),
      inArray(channels.taskId, ids),
    ));
  for (const row of rows) if (row.taskId) out.set(row.taskId, true);
  // Lazy conversations: a task v2 task whose conversation does not exist yet
  // is followed by its creator and assignee from creation
  // (insertTaskConversationCreationFollows), so they read as following
  // (one rule with raft task view / --following: ./taskV2Mode).
  const pending = await executor
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(
      inArray(tasks.id, ids),
      pendingTaskConversationFollowerSql(tasks, { type: "user", id: userId }),
    ));
  for (const row of pending) out.set(row.id, true);
  return out;
}
