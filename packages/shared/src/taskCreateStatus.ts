import type { TaskStatus } from "./index";

/**
 * The statuses a task can be created in, as a to-do app lets you file an item
 * as "later" or "doing now" (stdrc 2026-10-31 #wg-task-v2 bb4f4de7; design:
 * raft-design `design/patterns/tasks.md`, Create Task). In Review, Done and
 * Closed are not here on purpose: a task gets there through its work, not at
 * its creation. Backlog is here but is task v2 only (see `checkTaskCreateStatus`),
 * and a create in it asks for no reason: a new task has nothing to come back from.
 *
 * One list for every create surface (web route, Agent API, CLI), so they
 * cannot drift.
 */
export const TASK_CREATE_STATUSES = ["backlog", "todo", "in_progress"] as const satisfies readonly TaskStatus[];

export type TaskCreateStatus = (typeof TASK_CREATE_STATUSES)[number];

export const isTaskCreateStatus = (value: unknown): value is TaskCreateStatus =>
  typeof value === "string" && (TASK_CREATE_STATUSES as readonly string[]).includes(value);

/** A create asked for a status a task can't start in (in_review, done, closed, …). 400. */
export const TASK_CREATE_STATUS_NOT_ALLOWED = "task_create_status_not_allowed" as const;

export interface TaskCreateStatusRefusal {
  code: typeof TASK_CREATE_STATUS_NOT_ALLOWED;
  message: string;
}

/** `backlog, todo or in_progress`. */
function formatChoices(statuses: readonly string[]): string {
  return `${statuses.slice(0, -1).join(", ")} or ${statuses[statuses.length - 1]}`;
}

/**
 * Check a create's requested status before any write. `undefined` (no status)
 * is always fine: the create keeps the default (see
 * `resolveTaskCreateStatus`). No status needs an assignee: statuses have no
 * limits anywhere else (an unassigned task can already be moved to
 * in_progress), so creation adds none (#926 design review).
 *
 * `taskV2`: whether this create makes a task v2 task, once that is known (the
 * `task_v2_conversations_v0` flag of the server the request came through; the
 * same read that sets the new row's `own_conversation`). `false` refuses
 * `backlog` as any other status a task can't start in. Omitted: the list alone,
 * for callers that have not read the flag yet.
 */
export function checkTaskCreateStatus(requested: unknown, opts: { taskV2?: boolean } = {}): TaskCreateStatusRefusal | null {
  if (requested === "backlog" && opts.taskV2 === false) {
    return {
      code: TASK_CREATE_STATUS_NOT_ALLOWED,
      message: `A task can't be created as backlog on a server without task conversations: choose ${formatChoices(TASK_CREATE_STATUSES.filter((status) => status !== "backlog"))}.`,
    };
  }
  if (requested === undefined || isTaskCreateStatus(requested)) return null;
  const named = typeof requested === "string" ? requested : JSON.stringify(requested);
  return {
    code: TASK_CREATE_STATUS_NOT_ALLOWED,
    message: `A task can't be created as ${named}: choose ${formatChoices(TASK_CREATE_STATUSES)}. A task reaches in_review, done or closed through its work.`,
  };
}

/**
 * The status a create starts in. With no status asked for it is the behaviour
 * from before statuses could be chosen: assigning yourself starts the work
 * (in_progress), anything else is todo.
 */
export function resolveTaskCreateStatus(
  requested: TaskCreateStatus | undefined,
  assignee: "none" | "self" | "other",
): TaskCreateStatus {
  if (requested !== undefined) return requested;
  return assignee === "self" ? "in_progress" : "todo";
}
