import type { ServerRole } from "./serverPermissions.js";

export const TASK_ACTIONS = [
  "read",
  "create",
  "convert",
  "claim",
  "unclaim",
  "assign",
  "change_status",
  "delete",
] as const;

export type TaskAction = typeof TASK_ACTIONS[number];

export interface TaskAuthorizationInput {
  action: TaskAction;
  serverRole: ServerRole | null | undefined;
  canReadChannel: boolean;
  canWriteChannel: boolean;
  isCreator?: boolean;
  isAssignee?: boolean;
  hasAssignTasks?: boolean;
  hasDeleteAnyTask?: boolean;
}

/**
 * Typed task policy. Channel authority is necessary but never sufficient for
 * mutation: Guest is read-only even after joining a writable channel.
 */
export function authorizeTaskAction(input: TaskAuthorizationInput): boolean {
  if (input.action === "read") return input.canReadChannel;
  // This is the channel/admission gate, not a replacement for each route's
  // existing relationship/capability policy. Non-Guest mutations continue to
  // reach taskService and the route-specific assignee/assign/delete checks.
  return input.serverRole !== "guest" && input.canWriteChannel;
}
