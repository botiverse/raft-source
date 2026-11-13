/**
 * The reason a task is moved into Backlog with: what would bring it back
 * (raft-design `design/patterns/tasks.md`, Moving a task to Backlog). Optional;
 * recorded on the status event and in the line the move writes in the task's
 * discussion. One list of rules for every surface (web route, Agent API, CLI),
 * so they cannot drift.
 */

/** Long enough for a sentence; the design asks for one single-line input. */
export const TASK_BACKLOG_REASON_MAX_LENGTH = 500;

/** A status write's reason can't be used: not a string, too long, or a status other than backlog. 400. */
export const TASK_STATUS_REASON_INVALID = "task_status_reason_invalid" as const;

export interface TaskStatusReasonRefusal {
  code: typeof TASK_STATUS_REASON_INVALID;
  message: string;
}

export type TaskStatusReasonCheck =
  | { reason: string | undefined; refusal: null }
  | { reason: undefined; refusal: TaskStatusReasonRefusal };

/**
 * A task reason as one line: runs of whitespace (line breaks included) become
 * one space, trimmed. Shared by the backlog reason and the hand-off reason
 * (`checkTaskAssignReason`).
 */
export function normalizeTaskReasonText(reason: string): string {
  return reason.replace(/[\s\u0085]+/g, " ").trim();
}

const refuse = (message: string): TaskStatusReasonCheck => ({
  reason: undefined,
  refusal: { code: TASK_STATUS_REASON_INVALID, message },
});

/**
 * Check a status write's reason and normalize it to one line (it ends up in a
 * line of the discussion, so a line break in it could start a forged row).
 * Blank is no reason, whatever the status: an empty field moves the task
 * without one. A reason with any other status is refused, not dropped: the
 * caller wrote it to be read, and nothing else would tell them it was lost.
 */
export function checkTaskStatusReason(status: unknown, reason: unknown): TaskStatusReasonCheck {
  if (reason === undefined || reason === null) return { reason: undefined, refusal: null };
  if (typeof reason !== "string") return refuse("reason must be a string");
  const normalized = normalizeTaskReasonText(reason);
  if (!normalized) return { reason: undefined, refusal: null };
  if (status !== "backlog") return refuse("reason is only for moving a task to backlog");
  if (normalized.length > TASK_BACKLOG_REASON_MAX_LENGTH) {
    return refuse(`reason must be at most ${TASK_BACKLOG_REASON_MAX_LENGTH} characters`);
  }
  return { reason: normalized, refusal: null };
}
