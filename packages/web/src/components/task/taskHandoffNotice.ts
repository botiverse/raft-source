import { isTaskHandoffWithReason, readTaskAssignmentNotice } from "@botiverse/raft-shared";
import type { TaskAssignmentNoticeMetadata, TaskAssignmentNoticeParty } from "@botiverse/raft-shared";

import type { Message } from "../../store/messageStore";

type NoticeSlice = Pick<Message, "id" | "messageType" | "createdAt"> & Partial<Pick<Message, "actionMetadata">>;

/** A hand-off with a reason, read from an assignment line's `actionMetadata`; null for any other message. */
export type TaskHandoffNotice = TaskAssignmentNoticeMetadata & { assignee: TaskAssignmentNoticeParty; reason: string };

export function readTaskHandoffNotice(message: Pick<Message, "messageType"> & Partial<Pick<Message, "actionMetadata">>): TaskHandoffNotice | null {
  if (message.messageType !== "system") return null;
  const notice = readTaskAssignmentNotice(message.actionMetadata);
  return isTaskHandoffWithReason(notice) ? notice : null;
}

/** When a hand-off came back to whoever made it: the later assignment line that gave it back. */
export interface TaskHandoffReturn {
  /** When it came back (the later line's `createdAt`). */
  at: string;
  /** Who made the change that gave it back: the hand-off's actor (took it back) or someone else (handed it back). */
  by: TaskAssignmentNoticeParty;
}

export function sameParty(a: TaskAssignmentNoticeParty | null, b: TaskAssignmentNoticeParty): boolean {
  return a !== null && a.type === b.type && a.id === b.id;
}

/**
 * For each hand-off with a reason in a task's conversation, the first later
 * assignment line that gives the task back to whoever handed it off (they
 * took it, or someone assigned it to them). A hand-off another one replaced
 * before it came back stays open: only a return to its own actor closes it.
 * Messages are in timeline order.
 */
export function taskHandoffReturns(messages: readonly NoticeSlice[]): ReadonlyMap<string, TaskHandoffReturn> {
  const returns = new Map<string, TaskHandoffReturn>();
  const open: { id: string; actor: TaskAssignmentNoticeParty }[] = [];
  for (const message of messages) {
    if (message.messageType !== "system") continue;
    const notice = readTaskAssignmentNotice(message.actionMetadata);
    if (!notice) continue;
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const handoff = open[i]!;
      if (sameParty(notice.assignee, handoff.actor)) {
        returns.set(handoff.id, { at: String(message.createdAt), by: notice.actor });
        open.splice(i, 1);
      }
    }
    if (isTaskHandoffWithReason(notice)) open.push({ id: message.id, actor: notice.actor });
  }
  return returns;
}
