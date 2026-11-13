/**
 * The reason a task is handed to someone else with (`raft task assign … --reason`):
 * what the task now waits on them for. It goes on the `assignee_changed`
 * event, in the line the assignment writes in the task's conversation and in
 * the assignee's notification, so the hand-off needs no separate message.
 *
 * Optional for people; required from an agent handing a task to someone other
 * than itself (its client sends the key, see `agentApiTaskAssignBodySchema`).
 * Taking a task yourself or clearing the assignee asks for none. Same text
 * rules as a backlog reason (`checkTaskStatusReason`): one line, at most
 * `TASK_ASSIGN_REASON_MAX_LENGTH` characters, blank is no reason.
 */

import { normalizeTaskReasonText, TASK_BACKLOG_REASON_MAX_LENGTH } from "./taskStatusReason";

/** Long enough for a sentence; the same limit as a backlog reason. */
export const TASK_ASSIGN_REASON_MAX_LENGTH = TASK_BACKLOG_REASON_MAX_LENGTH;

/** An assignment's reason can't be used: not a string, too long, or not a hand-off to someone else. 400. */
export const TASK_ASSIGN_REASON_INVALID = "task_assign_reason_invalid" as const;

/** An agent handed a task to someone else without saying what it waits on them for. 400. */
export const TASK_ASSIGN_REASON_REQUIRED = "task_assign_reason_required" as const;

/** A reason sent with an assignment that changes nothing (the task already has that assignee). 409. */
export const TASK_ASSIGN_REASON_UNCHANGED = "task_assign_reason_unchanged" as const;

export interface TaskAssignReasonRefusal {
  code: typeof TASK_ASSIGN_REASON_INVALID;
  message: string;
}

export type TaskAssignReasonCheck =
  | { reason: string | undefined; refusal: null }
  | { reason: undefined; refusal: TaskAssignReasonRefusal };

const refuse = (message: string): TaskAssignReasonCheck => ({
  reason: undefined,
  refusal: { code: TASK_ASSIGN_REASON_INVALID, message },
});

/**
 * Check an assignment's reason and normalize it to one line (it ends up in a
 * line of the discussion, so a line break in it could start a forged row).
 * `handoff`: the task goes to someone other than the one assigning it. A
 * reason on any other assignment (taking it yourself, clearing it) is refused,
 * not dropped: the caller wrote it to be read, and nothing else would tell
 * them it was lost. Whether a reason is required is the caller's rule
 * (`TASK_ASSIGN_REASON_REQUIRED_MESSAGE`).
 */
export function checkTaskAssignReason(reason: unknown, handoff: boolean): TaskAssignReasonCheck {
  if (reason === undefined || reason === null) return { reason: undefined, refusal: null };
  if (typeof reason !== "string") return refuse("reason must be a string");
  const normalized = normalizeTaskReasonText(reason);
  if (!normalized) return { reason: undefined, refusal: null };
  if (!handoff) return refuse("reason is only for handing a task to someone else (not for taking it yourself or clearing the assignee)");
  if (normalized.length > TASK_ASSIGN_REASON_MAX_LENGTH) {
    return refuse(`reason must be at most ${TASK_ASSIGN_REASON_MAX_LENGTH} characters`);
  }
  return { reason: normalized, refusal: null };
}

/**
 * The refusal an agent gets for handing a task to someone else without a
 * reason (task_assign_reason_required). Client-neutral and naming no command
 * (refusal sentences, shared/refusal.ts): the step to take goes in the
 * refusal's `next` (RAFT_HINTS.taskAssignWithReason), which the CLI and the
 * SDK each render in their own form.
 */
export const TASK_ASSIGN_REASON_REQUIRED_MESSAGE =
  "Handing a task to someone else needs a reason: say in one line what you are waiting on them for. "
  + "They see that sentence in their notification and in the task, so no separate message is needed.";

/**
 * The refusal for a reason sent with an assignment that changes nothing (the
 * task already has that assignee; task_assign_reason_unchanged): the reason
 * would have nowhere to go. Naming no command; the reply goes in `next`.
 */
export const TASK_ASSIGN_REASON_UNCHANGED_MESSAGE =
  "The task already has that assignee, so nothing was changed and the reason was not sent. "
  + "To tell them something, reply in the task's conversation.";
