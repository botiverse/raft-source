import { and, eq } from "drizzle-orm";
import { desktopNotificationReminderGroupKey, desktopNotificationReminderId, formatNotificationCopy } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { reminders, serverMembers } from "../../db/schema";
import { addTraceEvent } from "../../tracing/semanticTrace";
import { enqueueNotificationRows } from "../../services/notifications/enqueue";
import { noticePlainBody, type NotificationNoticePayload } from "../../services/notifications/envelope";

export type ReminderFiredNotificationDeps = {
  loadReminder: (reminderId: string) => Promise<{
    id: string;
    serverId: string;
    ownerAgentId: string;
    title: string;
    createdByType: "agent" | "human";
    createdById: string;
  } | null>;
  isServerMember: (serverId: string, userId: string) => Promise<boolean>;
  enqueue: typeof enqueueNotificationRows;
};

const defaultReminderDeps: ReminderFiredNotificationDeps = {
  loadReminder: async (reminderId) => {
    const [row] = await getDb()
      .select({
        id: reminders.id,
        serverId: reminders.serverId,
        ownerAgentId: reminders.ownerAgentId,
        title: reminders.title,
        createdByType: reminders.createdByType,
        createdById: reminders.createdById,
      })
      .from(reminders)
      .where(eq(reminders.id, reminderId))
      .limit(1);
    return row ?? null;
  },
  isServerMember: async (serverId, userId) => {
    const [row] = await getDb()
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
      .limit(1);
    return Boolean(row);
  },
  enqueue: (rows) => enqueueNotificationRows(rows),
};

let reminderDepsOverride: Partial<ReminderFiredNotificationDeps> | null = null;

export function __setReminderFiredNotificationDepsForTests(overrides: Partial<ReminderFiredNotificationDeps> | null): void {
  reminderDepsOverride = overrides;
}

/**
 * A reminder a human scheduled (for an agent) fired: notify that human on
 * every device through the notification outbox (`reminder:<id>:<firedAt>`,
 * category `reminder`, judged against their server level). Reminders created
 * by agents stay agent-only (the agent's reply is the notification). Never
 * throws into the fire receipt; a repeated fire report enqueues nothing new.
 */
export async function notifyReminderFired(fired: { reminderId: string; firedAt: string }): Promise<void> {
  const deps = { ...defaultReminderDeps, ...(reminderDepsOverride ?? {}) };
  try {
    const reminder = await deps.loadReminder(fired.reminderId);
    if (!reminder || reminder.createdByType !== "human") return;
    const userId = reminder.createdById;
    if (!(await deps.isServerMember(reminder.serverId, userId))) return;
    const payload: NotificationNoticePayload = {
      title: formatNotificationCopy("push.title.reminder"),
      titleKey: "push.title.reminder",
      body: noticePlainBody(reminder.title),
      kind: "reminder",
      event: "reminder_fired",
      route: { type: "agent", serverId: reminder.serverId, agentId: reminder.ownerAgentId },
      groupKey: desktopNotificationReminderGroupKey(reminder.serverId),
    };
    const firedAt = new Date(fired.firedAt);
    await deps.enqueue([{
      receiverId: userId,
      serverId: reminder.serverId,
      kind: null,
      sourceChannelId: null,
      messageId: null,
      messageSeq: null,
      activityAt: Number.isNaN(firedAt.getTime()) ? new Date() : firedAt,
      personalMention: true,
      eventKey: desktopNotificationReminderId(reminder.id, fired.firedAt),
      category: "reminder",
      payload: payload as unknown as Record<string, unknown>,
    }]);
  } catch (err) {
    addTraceEvent("notification.reminder_fired.failed", {
      error_class: err instanceof Error ? err.name : "unknown_error",
    });
  }
}
