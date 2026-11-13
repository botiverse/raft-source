import type { TaskStatusId } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";
import { TASK_STATUSES } from "@botiverse/raft-shared";
import type { Task, TaskStatus } from "../../store/taskStore";
import { opensAsTaskConversation } from "../../utils/taskConversation";

/**
 * The task-status vocabulary — the app's canonical status set. This module owns
 * only what is status SEMANTICS: the label id (a MessageId, never a sentence)
 * and the transition rules. It deliberately owns NO colour, icon, or badge
 * recipe any more.
 *
 * Task-status APPEARANCE has exactly one source: raft-ui's `TaskStatusBadge` /
 * `TaskStatusIcon` (and the `task-status-*` tokens behind them). Surfaces render
 * those components; nothing here re-declares a colour, so a status can no longer
 * look different on different screens.
 */

export interface TaskStatusUi {
  /**
   * The status label as a MessageId — rendered by every task surface. Holding
   * an id (not finished English) is what makes a hardcoded-English regression
   * impossible rather than merely absent (task #54).
   */
  labelId: MessageId;
}

export const TASK_STATUS_UI: Record<TaskStatus, TaskStatusUi> = {
  backlog: { labelId: "task.status.backlog" },
  todo: { labelId: "task.status.todo" },
  in_progress: { labelId: "task.status.inProgress" },
  in_review: { labelId: "task.status.inReview" },
  done: { labelId: "task.status.done" },
  // Closed = won't-do (cancelled / abandoned). Its disabled look comes from
  // raft-ui's task-status tokens; this map only carries the label id.
  closed: { labelId: "task.status.closed" },
};

/**
 * Back-compat alias for task list/card callsites that read the label. Keep it a
 * typed view over TASK_STATUS_UI, not a second source of truth.
 */
export const STATUS_STYLES: Record<TaskStatus, TaskStatusUi> = TASK_STATUS_UI;

/**
 * slock writes statuses snake_case (`in_progress`); raft-ui writes them
 * kebab-case (`in-progress`). One converter, one place — so no callsite
 * hand-writes the mapping.
 */
export function toRuiTaskStatus(status: TaskStatus): TaskStatusId {
  return status.replace(/_/g, "-") as TaskStatusId;
}

/**
 * Status is a member-level action: any member who can see the task may move it.
 *
 * This mirrors the server, where the `only the assignee can update status` rule
 * (and its `in_review -> done` carve-out, which existed only to punch a hole in
 * that rule) was removed. Leaving the old check here would have been worse than
 * a dead branch -- the server would accept the write while the browser refused
 * to offer it, so the rule would look intact to every human and only agents on
 * the CLI would get the new behavior.
 *
 * There are no transition limits either (stdrc 2026-10-31, #wg-task-v2
 * msg=ad820421): any status can be set from any status.
 */
export function canEditTaskStatus(
  task: Task,
  _currentUserId: string | undefined,
  _canManageServer: boolean,
): boolean {
  // A Guest sees only its own channel's tasks and moves them like a member (matrix §1).
  return !task.readOnlyReason;
}

export function getTaskStatusOptions(task: Task, _currentUserId: string | undefined, _canManageServer: boolean, taskV2: boolean) {
  const current = task.status;
  const v2Task = opensAsTaskConversation(task, taskV2);
  // in_review is retired for task v2 (#wg-task-v2:f7043517): the server stores
  // in_progress when asked for it. A task still in it keeps it as its current option.
  const retiredInReview = v2Task && current !== "in_review";
  // Backlog is task v2 only: the server refuses it on a pre-v2 task with the flag
  // off (task_status_not_available). A task already in it keeps it, as above.
  const noBacklog = !v2Task && current !== "backlog";
  // Every other status, from any status, for members and admins alike: the server
  // has no transition table (taskService.getTaskStatusTransitionError).
  return TASK_STATUSES.filter((status) => !(retiredInReview && status === "in_review") && !(noBacklog && status === "backlog")).map((status) => ({
    id: status,
    labelId: current === "closed" && status === "todo"
      ? ("task.status.reopenToTodo" satisfies MessageId)
      : TASK_STATUS_UI[status].labelId,
  }));
}
