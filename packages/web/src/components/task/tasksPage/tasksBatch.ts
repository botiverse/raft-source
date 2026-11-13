import api from "../../../api/client";
import { useTaskStore } from "../../../store/taskStore";
import type { Task, TaskStatus } from "../../../store/taskStore";
import { useThreadStore } from "../../../store/threadStore";
import { directTaskConversationChannelId } from "../../../utils/taskConversation";
import { canEditTaskStatus } from "../taskStatusUi";

/**
 * Acting on the selected tasks at once (the Tasks page's selection bar).
 * Phase 1 calls the per-task APIs one task at a time, a few in flight; there
 * is no batch endpoint. A task the viewer may not change is skipped, and so
 * is one the server refuses; the toast says how many.
 */

export type TaskAssigneeRef = { type: "user" | "agent"; id: string };

export type BatchAction =
  | { kind: "status"; status: TaskStatus }
  | { kind: "assignee"; assignee: TaskAssigneeRef | null }
  | { kind: "follow" }
  | { kind: "delete" };

export interface BatchViewer {
  userId: string | null;
  /** Server capability `assignTasks` (a Guest assigns in its own channel too). */
  canAssign: boolean;
  /** Server capability `deleteAnyTask`. */
  canDeleteAny: boolean;
}

export interface BatchOutcome {
  /** Tasks the action reached (or that already were so). */
  done: number;
  /** Tasks it left: not the viewer's to change, or refused by the server. */
  skipped: number;
  /** The tasks the server refused (or that failed on the way): they stay selected, to try again. */
  failedIds: string[];
}

/**
 * Whether `action` may be applied to `task` by the viewer: per action, the rule the same change on one task follows
 * (and the server's), so a batch does what the viewer could do task by task.
 * - Status: anyone who may write the task (canEditTaskStatus, as a card's drag or its status chip), except moving an
 *   unassigned To-do to In progress, which the server refuses (a single task's move is its mover's claim; one status
 *   for many tasks claims none of them).
 * - Assignee: the `assignTasks` capability (a Guest assigns in its own channel), on a task not done and writable (as
 *   the task's own Assignee field).
 * - Delete: its creator, or `deleteAnyTask`.
 * - Follow: anyone who sees it.
 * Never a legacy task.
 */
export function canApplyBatchAction(action: BatchAction, task: Task, viewer: BatchViewer): boolean {
  if (task.isLegacy) return false;
  switch (action.kind) {
    case "follow":
      return true;
    case "status":
      if (action.status === "in_progress" && task.status === "todo" && !task.claimedById) return false;
      return canEditTaskStatus(task, viewer.userId ?? undefined, false);
    case "assignee":
      return viewer.canAssign && task.status !== "done" && !task.readOnlyReason;
    case "delete": {
      const creator = viewer.userId !== null && task.createdByType === "user" && task.createdById === viewer.userId;
      return !task.readOnlyReason && (creator || viewer.canDeleteAny);
    }
  }
}

/** The task already is what the action would make it: nothing to send. */
export function isBatchNoop(action: BatchAction, task: Task): boolean {
  if (action.kind === "status") return task.status === action.status;
  if (action.kind === "assignee") {
    if (!action.assignee) return !task.claimedById;
    return task.claimedByType === action.assignee.type && task.claimedById === action.assignee.id;
  }
  return false;
}

/** Follow a task's conversation, creating it first where it has none yet (as the task's own Follow does). */
async function followTask(task: Task): Promise<void> {
  let conversationChannelId = directTaskConversationChannelId(task);
  if (!conversationChannelId) {
    // The server answers this server's local conversation (a joint task's too).
    const { data } = await api.post(`/tasks/${task.id}/conversation`);
    const created = (data as { conversationChannelId?: unknown } | null)?.conversationChannelId;
    if (typeof created !== "string" || created.length === 0) throw new Error("Task conversation creation did not return a channel id");
    conversationChannelId = created;
  }
  await api.post("/channels/threads/follow", { threadChannelId: conversationChannelId });
  const followed = conversationChannelId;
  useThreadStore.setState((state) => ({ taskFollowOverrides: { ...state.taskFollowOverrides, [followed]: true } }));
}

/** One task's write for the action, through the task store (so the page updates at once). */
function performBatchAction(action: BatchAction, task: Task): Promise<void> {
  const store = useTaskStore.getState();
  switch (action.kind) {
    case "status":
      // Backlog asks no reason here (blank is no reason): one reason would not fit many tasks. No claim either
      // (canApplyBatchAction leaves out what would need one).
      return store.updateTaskStatus(task.channelId, task.id, action.status, undefined, { claimUnassigned: false });
    case "assignee":
      return store.updateTaskAssignee(task.channelId, task.id, action.assignee);
    case "follow":
      return followTask(task);
    case "delete":
      return store.deleteTask(task.channelId, task.id);
  }
}

/** Writes in flight at once. */
const BATCH_CONCURRENCY = 4;

/**
 * Apply `action` to `tasks`: the ones the viewer may change, each with its own
 * request (a few at a time); the rest, and any the server refuses, skipped.
 * `perform` is the write (the task store's, by default).
 */
export async function runTaskBatch(
  action: BatchAction,
  tasks: readonly Task[],
  viewer: BatchViewer,
  perform: (action: BatchAction, task: Task) => Promise<void> = performBatchAction,
): Promise<BatchOutcome> {
  const permitted = tasks.filter((task) => canApplyBatchAction(action, task, viewer));
  let done = 0;
  const failedIds: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < permitted.length) {
      const task = permitted[next++]!;
      if (isBatchNoop(action, task)) {
        done += 1;
        continue;
      }
      try {
        await perform(action, task);
        done += 1;
      } catch (err) {
        console.error("Batch task action failed:", err);
        failedIds.push(task.id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, permitted.length) }, worker));
  if (action.kind === "follow" && done > 0) void useThreadStore.getState().loadFollowedThreads("manual").catch(() => {});
  return { done, skipped: tasks.length - permitted.length + failedIds.length, failedIds };
}
