export const TASK_ACTIONS = [
  "read",
  "create",
  "convert",
  "claim",
  "unclaim",
  "assign",
  "change_status",
  "amend",
  "delete",
] as const;

/**
 * Length limits on a task's text, shared by every path that writes it: the
 * agent `tasks amend` contract and the web edit route (PATCH /api/tasks/:id).
 */
export const TASK_TITLE_MAX_LENGTH = 10_000;
export const TASK_DESCRIPTION_MAX_LENGTH = 50_000;

export type TaskAction = typeof TASK_ACTIONS[number];

export type TaskReadOnlyReason = "historical_joint_task";

export interface TaskAuthorizationInput {
  action: TaskAction;
  canReadChannel: boolean;
  canWriteChannel: boolean;
  isCreator?: boolean;
  isAssignee?: boolean;
  hasAssignTasks?: boolean;
  hasDeleteAnyTask?: boolean;
  /** Resource authority projected by the server, separate from actor role. */
  readOnlyReason?: TaskReadOnlyReason | null;
}

/**
 * Typed task policy. Channel write authority gates every mutation. A Guest
 * has write authority only in its one bound channel (canGuestPostToChannel),
 * so there it creates, assigns, claims and updates tasks by the same rules as
 * a member (matrix §1); an assignee must be in the channel for everyone
 * (taskService assignee eligibility).
 */
export function authorizeTaskAction(input: TaskAuthorizationInput): boolean {
  if (input.action === "read") return input.canReadChannel;
  // This is the channel/admission gate, not a replacement for each route's
  // existing relationship/capability policy. Non-Guest mutations continue to
  // reach taskService and the route-specific assignee/assign/delete checks.
  return input.readOnlyReason == null && input.canWriteChannel;
}
