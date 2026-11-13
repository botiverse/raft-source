import type { NotificationCategory } from "@botiverse/raft-shared";
import {
  SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION,
  systemMessageNotificationEvent,
  type SystemMessageNotificationEvent,
} from "./systemMessageBornReadRegistry";

/**
 * Who a task / agent system notice notifies, and as what (design §3.4, D10).
 *
 * Pure: the unified enqueue (services/notifications/enqueue.ts) calls it in
 * the sending transaction with the notice's inbox-fact audience and the
 * facts it loaded (the task, who can see its parent channel, who explicitly
 * unfollowed), and writes one outbox row per recipient. Every transport
 * (desktop, Web Push, mobile socket, APNs, FCM) then reaches the same people.
 *
 * Other system messages (renames, member changes, onboarding, ...) count in
 * Activity and notify only the people they @mention; `real-sender` producers
 * are ordinary messages.
 */

export type SystemMessageNotificationClass =
  /** A task / agent event: recipients from systemEventRecipients(). */
  | { kind: "event"; event: Exclude<SystemMessageNotificationEvent, "none"> }
  /** Persisted with its real sender: notifies like any message. */
  | { kind: "message" }
  /** Counts in Activity; notifies only the people it @mentions (as a mention). */
  | { kind: "silent" };

/** D10: which system messages notify. `producer` null = an ordinary (non-system) message. */
export function classifySystemMessageNotification(producer: string | null | undefined): SystemMessageNotificationClass {
  if (!producer) return { kind: "silent" };
  const event = systemMessageNotificationEvent(producer);
  if (event !== "none") return { kind: "event", event };
  const classification = (SYSTEM_MESSAGE_BORN_READ_CLASSIFICATION as Record<string, string | undefined>)[producer];
  return classification === "real-sender" ? { kind: "message" } : { kind: "silent" };
}

export type TaskStatusRecipientTask = {
  status: string;
  createdByType: "user" | "agent";
  createdById: string;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
};

/**
 * Who of the task's creator and assignee gets a status change personally
 * (product decision 1). Review and completion matter to both; a claim matters
 * to the creator (someone picked up my task). Back to todo is follower-only.
 */
export function taskStatusPersonalRecipients(task: TaskStatusRecipientTask): string[] {
  const creator = task.createdByType === "user" ? task.createdById : null;
  const assignee = task.claimedByType === "user" ? task.claimedById : null;
  switch (task.status) {
    case "in_review":
    case "done":
    case "closed":
      return [...new Set([creator, assignee].filter((id): id is string => Boolean(id)))];
    case "in_progress":
      return creator ? [creator] : [];
    default:
      return [];
  }
}

export type SystemEventRecipient = {
  userId: string;
  category: NotificationCategory;
  /** Personally addressed (task creator / assignee, assignee, the agent's human). */
  personal: boolean;
  /** Already in the notice's inbox-fact audience. */
  hasInboxFact: boolean;
};

export type SystemEventRecipientsInput = {
  event: Exclude<SystemMessageNotificationEvent, "none">;
  /** Human receivers of the notice's own unread inbox facts (born-read actor excluded). */
  factReceiverIds: readonly string[];
  /** Explicit personal-attention user targets of the notice (assignment receipt). */
  personalAttentionUserIds: readonly string[];
  /**
   * task_status only: taskStatusPersonalRecipients() of the task, already
   * limited to people who can see the parent channel and did not explicitly
   * unfollow the task conversation.
   */
  taskPersonalUserIds?: readonly string[];
  /** agent_attention only: the notice is in a DM and caused by its agent. */
  agentDm?: boolean;
  actor?: { type: "user" | "agent"; id: string } | null;
};

/**
 * The recipients of one notice (design §3.4):
 * - task_status: the task conversation audience (followers, as `thread`
 *   semantics) plus the personal recipients; the actor never;
 * - task_assigned: the assignee only;
 * - agent_action_required: the humans of the agent's DM.
 */
export function systemEventRecipients(input: SystemEventRecipientsInput): SystemEventRecipient[] {
  const actorUserId = input.actor?.type === "user" ? input.actor.id : null;
  const factIds = new Set(input.factReceiverIds);
  const byUser = new Map<string, SystemEventRecipient>();
  const add = (userId: string, category: NotificationCategory, personal: boolean) => {
    if (userId === actorUserId) return;
    const previous = byUser.get(userId);
    if (previous && (previous.personal || !personal)) return;
    byUser.set(userId, { userId, category, personal, hasInboxFact: factIds.has(userId) });
  };
  switch (input.event) {
    case "task_status":
      for (const userId of input.factReceiverIds) add(userId, "task_status", false);
      for (const userId of input.taskPersonalUserIds ?? []) add(userId, "task_status", true);
      break;
    case "task_assigned":
      for (const userId of input.personalAttentionUserIds) add(userId, "task_assigned", true);
      break;
    case "agent_action_required":
      if (!input.agentDm) break;
      for (const userId of input.factReceiverIds) add(userId, "agent_attention", true);
      break;
  }
  return [...byUser.values()];
}
