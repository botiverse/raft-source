import assert from "node:assert/strict";
import type { NotificationEnqueueRow } from "../../services/notifications/enqueue";
import { parseNotificationNoticePayload } from "../../services/notifications/envelope";
import { __setReminderFiredNotificationDepsForTests, notifyReminderFired } from "./firedNotification";

function install(input: { createdByType: "human" | "agent"; member?: boolean }) {
  const enqueued: NotificationEnqueueRow[] = [];
  __setReminderFiredNotificationDepsForTests({
    loadReminder: async (id) => ({
      id,
      serverId: "s1",
      ownerAgentId: "agent-1",
      title: "Check the **deploy**",
      createdByType: input.createdByType,
      createdById: "human-1",
    }),
    isServerMember: async () => input.member ?? true,
    enqueue: async (rows) => {
      enqueued.push(...rows);
      return rows.map((_, index) => `row-${index}`);
    },
  });
  return { enqueued };
}

afterEach(() => {
  __setReminderFiredNotificationDepsForTests(null);
});

test("a fired reminder a human scheduled is one outbox row for that human", async () => {
  const { enqueued } = install({ createdByType: "human" });
  await notifyReminderFired({ reminderId: "r1", firedAt: "2026-10-20T10:00:00.000Z" });
  assert.equal(enqueued.length, 1);
  const row = enqueued[0]!;
  assert.equal(row.receiverId, "human-1");
  assert.equal(row.serverId, "s1");
  assert.equal(row.eventKey, "reminder:r1:2026-10-20T10:00:00.000Z");
  assert.equal(row.category, "reminder");
  assert.equal(row.personalMention, true);
  assert.equal(row.messageId, null);
  assert.equal(row.activityAt.toISOString(), "2026-10-20T10:00:00.000Z");
  const payload = parseNotificationNoticePayload(row.payload);
  assert.ok(payload);
  assert.equal(payload.title, "Reminder");
  // The title's localization key travels with it (contract §1.5).
  assert.equal(payload.titleKey, "push.title.reminder");
  assert.equal(payload.body, "Check the deploy");
  assert.equal(payload.kind, "reminder");
  assert.equal(payload.event, "reminder_fired");
  assert.deepEqual(payload.route, { type: "agent", serverId: "s1", agentId: "agent-1" });
  assert.equal(payload.groupKey, "s1:reminder");
});

test("agent-created reminders and a departed member enqueue nothing", async () => {
  for (const setup of [
    { createdByType: "agent" as const },
    { createdByType: "human" as const, member: false },
  ]) {
    const { enqueued } = install(setup);
    await notifyReminderFired({ reminderId: "r1", firedAt: "2026-10-20T10:00:00.000Z" });
    assert.deepEqual(enqueued, [], JSON.stringify(setup));
  }
});

test("an enqueue failure never throws into the fire receipt", async () => {
  __setReminderFiredNotificationDepsForTests({
    loadReminder: async () => { throw new Error("db down"); },
  });
  await notifyReminderFired({ reminderId: "r1", firedAt: "2026-10-20T10:00:00.000Z" });
});
