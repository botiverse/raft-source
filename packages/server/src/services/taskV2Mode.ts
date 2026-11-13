import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Task v2, per-task mode (RFC 078 "Per-task mode"). A task created the v2 way
 * (`tasks.own_conversation`) or one that already has its conversation
 * (`tasks.conversation_channel_id`) keeps working the v2 way whatever
 * `task_v2_conversations_v0` says for the server reading or writing it: its
 * discussion is its own conversation, created lazily by the first action that
 * needs it, and it is addressed `#channel:#7`. The flag decides only how NEW
 * tasks are created, whether the new entry points show, and whether a pre-v2
 * task (host message thread) gets a conversation lazily.
 */
export type TaskModeFields = {
  ownConversation: boolean;
  conversationChannelId: string | null;
};

/** A v2 task: created the v2 way, or it already has its conversation. */
export function isV2Task(task: TaskModeFields): boolean {
  return task.ownConversation || task.conversationChannelId != null;
}

/**
 * Whether the task's discussion is (or, lazily, will be) its own conversation
 * for a request whose server has the flag `flagOn`: always for a v2 task; for
 * a pre-v2 task only where the flag is on (else its host message's thread).
 */
export function taskUsesOwnConversation(task: TaskModeFields, flagOn: boolean): boolean {
  return flagOn || isV2Task(task);
}

/**
 * `in_review` is retired for task v2 tasks (tygg + stdrc, #wg-task-v2:f7043517).
 * A write that asks for it on a task whose discussion is (or, by this write,
 * becomes) its own conversation stores `in_progress` instead, assignee
 * unchanged; the request enum keeps `in_review` so older clients still parse.
 * Pre-v2 tasks on a server without the flag keep `in_review` exactly as before.
 * The SQL backfill of existing rows can only see the stored columns, so it uses
 * `isV2Task` (see the `in_review_retired_for_task_v2` migration).
 */
export const TASK_V2_RETIRED_IN_REVIEW_REASON = "in_review_retired_for_task_v2";

/** The status a status write stores: `requested`, except `in_review` on a task v2 task. */
export function taskV2StoredStatus<S extends string>(
  task: TaskModeFields,
  flagOn: boolean,
  requested: S,
): S | "in_progress" {
  return requested === "in_review" && taskUsesOwnConversation(task, flagOn) ? "in_progress" : requested;
}

type PendingFollowTask = TaskModeFields & {
  createdByType: string;
  createdById: string;
  claimedByType: string | null;
  claimedById: string | null;
};

type TaskFollower = { type: "user" | "agent"; id: string };

/**
 * W7: the follow someone has on a task whose conversation does not exist yet.
 * Only a task created the v2 way has a pending conversation: its creator
 * (`authored`) and assignee (`assigned`) follow it from creation
 * (taskConversationService.insertTaskConversationCreationFollows). A pre-v2
 * task without a conversation is discussed in its host message's thread, so
 * nobody follows a conversation of it. One rule for `raft task view`,
 * `raft task list --following` (pendingTaskConversationFollowerSql) and the
 * web's `conversationFollowed`.
 */
export function pendingTaskConversationFollowReason(
  task: PendingFollowTask,
  follower: TaskFollower,
): "authored" | "assigned" | null {
  if (task.conversationChannelId != null || !task.ownConversation) return null;
  if (task.createdByType === follower.type && task.createdById === follower.id) return "authored";
  if (task.claimedByType === follower.type && task.claimedById === follower.id) return "assigned";
  return null;
}

/** The task columns `pendingTaskConversationFollowerSql` reads (drizzle columns or raw aliases). */
export type PendingFollowTaskColumns = {
  ownConversation: SQLWrapper;
  conversationChannelId: SQLWrapper;
  createdByType: SQLWrapper;
  createdById: SQLWrapper;
  claimedByType: SQLWrapper;
  claimedById: SQLWrapper;
};

/** The raw `t.` alias of the tasks table, for hand-written SQL. */
export function taskAliasColumns(alias: string): PendingFollowTaskColumns {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return {
    ownConversation: col("own_conversation"),
    conversationChannelId: col("conversation_channel_id"),
    createdByType: col("created_by_type"),
    createdById: col("created_by_id"),
    claimedByType: col("claimed_by_type"),
    claimedById: col("claimed_by_id"),
  };
}

/** SQL form of `pendingTaskConversationFollowReason(...) !== null`. */
export function pendingTaskConversationFollowerSql(t: PendingFollowTaskColumns, follower: TaskFollower): SQL {
  return sql`(${t.conversationChannelId} IS NULL AND ${t.ownConversation} AND (
    (${t.createdByType} = ${follower.type} AND ${t.createdById} = ${follower.id})
    OR (${t.claimedByType} = ${follower.type} AND ${t.claimedById} = ${follower.id})
  ))`;
}
