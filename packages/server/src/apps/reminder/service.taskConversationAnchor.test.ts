/**
 * Task v2 (L5): a resource receipt's expiry follow-up on a v2 task anchors on
 * the receipt line in the task's conversation. When it fires, the reminder
 * renders as the task (`#channel:#7`), not as a message ref, and links to the
 * task's dialog in its channel: in the legacy wake notice the owner agent gets
 * and in the fired reminder's summary.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/index";
import { reminders, users } from "../../db/schema";
import { taskResourceExpiryFollowups } from "../../registry.manifest";
import { createAgent } from "../../services/agentService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { createServer } from "../../services/serverService";
import * as taskService from "../../services/taskService";
import { getTaskConversation } from "../../services/taskConversationService";
import { fixturePasswordHash } from "../../test/integration/credentials";
import { createApiTest } from "../../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../../test/integration/taskV2Flag";
import { deliverLegacyReminderWake, fireReminder, toReminderSummaries } from "./service";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("a fired expiry follow-up anchored in a task conversation renders as #channel:#N and links to the task", async ({ db: _db }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `l5-owner-${randomUUID()}@slock.test`,
    name: `l5-owner-${randomUUID().slice(0, 6)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  const slug = `l5-${randomUUID().slice(0, 8)}`;
  const server = await createServer("Reminder L5", slug, owner!.id);
  const channel = await createChannel(server.id, "l5-room");
  await addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `l5-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);

  const { tasks: [task] } = await taskService.createTasks(
    channel.id, "user", owner!.id, [{ title: "Create bucket", createsResource: true }], { initiatingServerId: server.id },
  );
  const recorded = await taskService.recordTaskResourceReceipt({
    taskId: task!.id,
    receipt: {
      object: "s3://raft-l5",
      purpose: "reminder rendering",
      teardown_owner: `@${agent.name}`,
      security_privacy: "internal; encrypted",
      expiry: "2099-09-01T00:00:00.000Z",
      runbook: "runbooks/staging-resource.md",
      tracking: `task #${task!.taskNumber}`,
    },
    actorType: "agent",
    actorId: agent.id,
    teardownOwnerAgentId: agent.id,
    teardownOwnerServerId: server.id,
    teardownOwnerTargetChannelId: channel.id,
    expiryFollowups: taskResourceExpiryFollowups,
  });
  assert.notEqual(typeof recorded, "string", String(recorded));
  const result = recorded as taskService.TaskResourceReceiptResult;
  const conversation = (await getTaskConversation(task!.id))!;
  assert.ok(conversation, "the receipt line created the task conversation");
  const lineId = result.expiryFollowup.msgId!;

  const [scheduled] = await db.select().from(reminders).where(eq(reminders.id, result.expiryFollowup.id));
  assert.ok(scheduled, "the follow-up reminder exists");
  assert.equal(scheduled.msgId, lineId);
  const fire = await fireReminder(scheduled.id, scheduled.version, { clock: { now: () => scheduled.fireAt } });
  assert.ok(fire.ok, fire.ok ? "" : `expected a fire, got ${fire.reason}`);
  assert.equal(fire.row.status, "fired");

  const ref = `#${channel.name}:#${task!.taskNumber}`;

  // The owner agent's wake notice: delivered into the task conversation as a
  // sub-conversation, its first line naming the task (not a message id).
  const deliveries: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: Record<string, unknown>) => {
      deliveries.push({ agentId, payload });
      return { status: "queued" as const };
    },
  };
  assert.equal(await deliverLegacyReminderWake(orchestrator as never, fire.row), true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.agentId, agent.id);
  assert.equal(deliveries[0]!.payload.channel_id, conversation.canonicalChannelId);
  assert.equal(deliveries[0]!.payload.channel_type, "thread");
  const [firstLine] = String(deliveries[0]!.payload.content).split("\n");
  assert.ok(firstLine!.includes(` — ${ref} — "`), firstLine);
  assert.ok(!firstLine!.includes(lineId.slice(0, 8)), "the task ref replaces the anchor message ref");

  // The fired reminder's summary: the same ref, linking to the task dialog
  // in its channel, scrolled to the receipt line.
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://app.example.test";
  try {
    const [summary] = await toReminderSummaries([fire.row], server.id);
    assert.equal(summary!.status, "fired");
    assert.equal(summary!.msgRef, ref);
    const link = new URL(summary!.msgPermalink!);
    assert.equal(link.origin, "https://app.example.test");
    assert.equal(link.pathname, `/s/${slug}/channel/${channel.id}`);
    assert.equal(link.searchParams.get("task"), `${channel.id}:task:${task!.id}`);
    assert.equal(link.searchParams.get("msg"), lineId);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});
