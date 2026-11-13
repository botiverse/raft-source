/**
 * The structure of an assignment line in a task's conversation ("📌 Otter
 * assigned #51 "…" to @xxchan: <reason>", "📌 Otter took #51 …", "🔓 Otter
 * unassigned #51 …"), carried as the system message's `actionMetadata`. The
 * text stays the record (agents, notifications and older clients read it);
 * web reads this to draw a hand-off with a reason as a card, and to see when
 * the task later comes back to whoever handed it off.
 */

/** `actionMetadata.kind` of an assignment line (the stored spelling; never rename it). */
export const TASK_ASSIGNMENT_NOTICE_KIND = "task-assignment";

export interface TaskAssignmentNoticeParty {
  type: "user" | "agent";
  id: string;
  /** Handle (`@name`), when it could be resolved. */
  name: string | null;
  /** The name people read, when it could be resolved. */
  displayName: string | null;
}

export interface TaskAssignmentNoticeMetadata {
  kind: typeof TASK_ASSIGNMENT_NOTICE_KIND;
  taskNumber: number;
  /** Who changed the assignee. */
  actor: TaskAssignmentNoticeParty;
  /** The new assignee; null when the assignee was cleared. */
  assignee: TaskAssignmentNoticeParty | null;
  /** A hand-off to someone else: what the task waits on them for (`checkTaskAssignReason`). */
  reason?: string;
}

function readParty(value: unknown): TaskAssignmentNoticeParty | null {
  if (!value || typeof value !== "object") return null;
  const party = value as Record<string, unknown>;
  if ((party.type !== "user" && party.type !== "agent") || typeof party.id !== "string" || !party.id) return null;
  return {
    type: party.type,
    id: party.id,
    name: typeof party.name === "string" && party.name ? party.name : null,
    displayName: typeof party.displayName === "string" && party.displayName ? party.displayName : null,
  };
}

/** The assignment line's structure from a message's `actionMetadata`; null for anything else. */
export function readTaskAssignmentNotice(actionMetadata: unknown): TaskAssignmentNoticeMetadata | null {
  if (!actionMetadata || typeof actionMetadata !== "object") return null;
  const metadata = actionMetadata as Record<string, unknown>;
  if (metadata.kind !== TASK_ASSIGNMENT_NOTICE_KIND) return null;
  if (typeof metadata.taskNumber !== "number") return null;
  const actor = readParty(metadata.actor);
  if (!actor) return null;
  const assignee = metadata.assignee === null ? null : readParty(metadata.assignee);
  if (metadata.assignee !== null && !assignee) return null;
  const reason = typeof metadata.reason === "string" && metadata.reason.trim() ? metadata.reason : undefined;
  return {
    kind: TASK_ASSIGNMENT_NOTICE_KIND,
    taskNumber: metadata.taskNumber,
    actor,
    assignee,
    ...(reason !== undefined && { reason }),
  };
}

/** A hand-off with a reason: the task went to someone other than the actor, saying why. */
export function isTaskHandoffWithReason(notice: TaskAssignmentNoticeMetadata | null): notice is TaskAssignmentNoticeMetadata & { assignee: TaskAssignmentNoticeParty; reason: string } {
  return Boolean(
    notice?.reason
    && notice.assignee
    && !(notice.assignee.type === notice.actor.type && notice.assignee.id === notice.actor.id),
  );
}
