/**
 * Task v2 (G5): a resource receipt on a task with no host and no source
 * message. The expiry follow-up anchors on a "resource receipt recorded"
 * system line committed in the task's conversation in the receipt
 * transaction (a real message uuid, so released CLIs keep a valid
 * `expiryFollowup.msgId`), and targets the conversation as the teardown
 * owner's server sees it. The reminder renders as the task (`#channel:#7`) for
 * new clients (reminder summaries) and old daemons (legacy wake notice into
 * the task conversation). Tasks anchored on a message keep the old shape.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { TaskResourceReceipt } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { jointChannels, jointChannelServers, messages, reminders, threadFollows, users } from "../db/schema";
import { taskResourceExpiryFollowups } from "../registry.manifest";
import * as reminderService from "../apps/reminder/service";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";
import { getTaskConversation } from "../services/taskConversationService";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 6)}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

function receiptFor(ownerName: string, taskNumber: number): TaskResourceReceipt {
  return {
    object: `s3://raft-staging-${taskNumber}`,
    purpose: "staging restore acceptance",
    teardown_owner: `@${ownerName}`,
    security_privacy: "internal; encrypted",
    expiry: "2099-09-01T00:00:00.000Z",
    runbook: "runbooks/staging-resource.md",
    tracking: `task #${taskNumber}`,
  };
}

async function ordinary(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Receipt ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `${slug}-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  return { owner, server, channel, agent };
}

test("a v2 task without a source message records its receipt; the follow-up anchors on a line in the task conversation", async ({ db: _db }) => {
  const db = getDb();
  const { owner, server, channel, agent } = await ordinary("rcpt");
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Create bucket", createsResource: true }], { initiatingServerId: server.id });
  assert.equal(task!.sourceMessageId, null);
  assert.equal(await getTaskConversation(task!.id), null, "creating the task created no conversation (lazy)");
  const input = {
    taskId: task!.id,
    receipt: receiptFor(agent.name, task!.taskNumber),
    actorType: "agent" as const,
    actorId: agent.id,
    teardownOwnerAgentId: agent.id,
    teardownOwnerServerId: server.id,
    teardownOwnerTargetChannelId: channel.id,
    expiryFollowups: taskResourceExpiryFollowups,
  };

  assert.equal(
    await taskService.recordTaskResourceReceipt({ ...input, receipt: { ...input.receipt, runbook: " " } }),
    "resource receipt field runbook must be nonblank",
  );
  assert.equal(await getTaskConversation(task!.id), null, "an invalid receipt writes no line and creates no conversation");
  assert.equal(
    await taskService.recordTaskResourceReceipt({ ...input, receipt: { ...input.receipt, expiry: "2000-01-01T00:00:00.000Z" } }),
    "resource receipt expiry must be in the future",
  );
  assert.equal(await getTaskConversation(task!.id), null, "a receipt refused inside the transaction (expired) creates no conversation either");

  const recorded = await taskService.recordTaskResourceReceipt(input);
  assert.notEqual(typeof recorded, "string", String(recorded));
  const conversation = (await getTaskConversation(task!.id))!;
  assert.ok(conversation, "the receipt line created the task's conversation");
  const follows = await db.select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversation.canonicalChannelId));
  assert.deepEqual(follows.map((follow) => [follow.followerId, follow.reason]), [[owner.id, "authored"]], "created with its creator following");
  const result = recorded as taskService.TaskResourceReceiptResult;
  assert.ok(result.receiptLine, "the anchor line is returned for the post-commit fan-out");
  const [line] = await db.select().from(messages).where(eq(messages.id, result.receiptLine!.message.id));
  assert.equal(line!.channelId, conversation.canonicalChannelId);
  assert.equal(line!.messageType, "system");
  assert.equal(line!.systemSubtype, "task.lifecycle_thread");
  assert.match(line!.content, new RegExp(`Resource receipt recorded for #${task!.taskNumber} "Create bucket"`));
  assert.equal(result.expiryFollowup.msgId, line!.id, "the follow-up anchors on the line (a real message uuid)");
  assert.equal(result.expiryFollowup.targetChannelId, conversation.canonicalChannelId, "and fires into the task conversation");

  const retry = await taskService.recordTaskResourceReceipt(input) as taskService.TaskResourceReceiptResult;
  assert.equal(retry.idempotent, true);
  assert.equal(retry.receiptLine, undefined);
  assert.equal((await db.select().from(messages).where(eq(messages.channelId, conversation.canonicalChannelId))).length, 1, "a retry posts no second line");

  // New clients: the reminder summary names the task and links its dialog.
  const [row] = await db.select().from(reminders).where(eq(reminders.id, result.expiryFollowup.id));
  const [summary] = await reminderService.toReminderSummaries([row!], server.id);
  assert.equal(summary!.msgRef, `#${channel.name}:#${task!.taskNumber}`);
  if (summary!.msgPermalink) {
    assert.match(summary!.msgPermalink, new RegExp(`/channel/${channel.id}\\?task=${channel.id}%3Atask%3A${task!.id}&msg=${line!.id}`));
  }

  // Old daemons: the legacy wake notice goes into the task conversation, as a
  // sub-conversation, and names the task.
  const deliveries: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: Record<string, unknown>) => {
      deliveries.push({ agentId, payload });
      return { status: "queued" as const };
    },
  };
  assert.equal(await reminderService.deliverLegacyReminderWake(orchestrator as never, row!), true);
  assert.equal(deliveries[0]!.agentId, agent.id);
  assert.equal(deliveries[0]!.payload.channel_id, conversation.canonicalChannelId);
  assert.equal(deliveries[0]!.payload.channel_type, "thread");
  assert.match(String(deliveries[0]!.payload.content), new RegExp(`#${channel.name}:#${task!.taskNumber}`));
});

test("a task anchored on a source message keeps the old follow-up shape (message anchor, channel target)", async ({ db: _db }) => {
  const db = getDb();
  const { owner, server, channel, agent } = await ordinary("rcptsrc");
  const source = await createMessage(channel.id, "user", owner.id, "we need a bucket");
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "Bucket", createsResource: true, sourceMessageId: source.id }], { initiatingServerId: server.id });
  const result = await taskService.recordTaskResourceReceipt({
    taskId: task!.id,
    receipt: receiptFor(agent.name, task!.taskNumber),
    actorType: "agent",
    actorId: agent.id,
    teardownOwnerAgentId: agent.id,
    teardownOwnerServerId: server.id,
    teardownOwnerTargetChannelId: channel.id,
    expiryFollowups: taskResourceExpiryFollowups,
  }) as taskService.TaskResourceReceiptResult;
  assert.equal(result.expiryFollowup.msgId, source.id);
  assert.equal(result.expiryFollowup.targetChannelId, channel.id);
  assert.equal(result.receiptLine, undefined);
  assert.equal(await getTaskConversation(task!.id), null, "a message-anchored receipt needs no task conversation, so none is created");
  void db;
});

test("agent API: POST /tasks/resource-receipt on a v2 task without a source message answers a uuid msgId and fans the line out", async ({ app }) => {
  const db = getDb();
  const { owner, server, channel, agent } = await ordinary("rcptapi");
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "API bucket", createsResource: true }], { initiatingServerId: server.id });
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "rcpt", issuedVia: "computer", createdByUserId: null });
  const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/resource-receipt`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: `#${channel.name}`, task_number: task!.taskNumber, receipt: receiptFor(agent.name, task!.taskNumber) }),
  });
  const body = await res.json() as { ok: boolean; expiryFollowup: { msgId: string; targetChannelId: string } };
  assert.equal(res.status, 200, JSON.stringify(body));
  const conversation = (await getTaskConversation(task!.id))!;
  assert.ok(conversation, "the receipt line created the task's conversation");
  assert.match(body.expiryFollowup.msgId, /^[0-9a-f-]{36}$/);
  assert.equal(body.expiryFollowup.targetChannelId, conversation.canonicalChannelId);
  const [line] = await db.select().from(messages).where(eq(messages.id, body.expiryFollowup.msgId));
  assert.equal(line!.channelId, conversation.canonicalChannelId, "msgId is the receipt line in the task conversation");
});

test("joint: the follow-up targets the teardown owner's server face of the task conversation and renders with its local channel", async ({ db: _db }) => {
  const db = getDb();
  const hostOwner = await seedUser("rcptj-host");
  const peerOwner = await seedUser("rcptj-peer");
  const hostServer = await createServer("Rcpt Host", `rcptj-h-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Rcpt Peer", `rcptj-p-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const storage = await createChannel(hostServer.id, "rcptj-storage", undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, "rcptj-room", undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, "rcptj-peer-room", undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: storage.id, createdByServerId: hostServer.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host" },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant" },
  ]);
  await addHuman(hostProjection.id, hostOwner.id);
  const peerAgent = await createAgent(peerServer.id, `rcptj-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(peerProjection.id, peerAgent.id);
  await enableTaskV2ConversationsForServer(hostServer.id);
  // Lazy: the receipt line creates the conversation (a v2 task: whatever the
  // teardown owner's server flag; the flag-off side is covered by
  // tasks.v2JointMixedFlag).
  await enableTaskV2ConversationsForServer(peerServer.id);
  const { tasks: [task] } = await taskService.createTasks(storage.id, "user", hostOwner.id, [{ title: "Joint bucket", createsResource: true }], { initiatingServerId: hostServer.id });
  assert.equal(await getTaskConversation(task!.id), null);

  const result = await taskService.recordTaskResourceReceipt({
    taskId: task!.id,
    receipt: receiptFor(peerAgent.name, task!.taskNumber),
    actorType: "agent",
    actorId: peerAgent.id,
    teardownOwnerAgentId: peerAgent.id,
    teardownOwnerServerId: peerServer.id,
    teardownOwnerTargetChannelId: peerProjection.id,
    expiryFollowups: taskResourceExpiryFollowups,
  }) as taskService.TaskResourceReceiptResult;
  const conversation = (await getTaskConversation(task!.id))!;
  assert.ok(conversation, "the receipt line created the canonical conversation and every server's face");
  const peerLocal = conversation.localByServer.get(peerServer.id)!.localChannelId;
  assert.equal(result.expiryFollowup.targetChannelId, peerLocal, "the peer owner's local task conversation");
  const [line] = await db.select().from(messages).where(eq(messages.id, result.expiryFollowup.msgId!));
  assert.equal(line!.channelId, conversation.canonicalChannelId, "the line is stored once, in the canonical conversation");
  const [row] = await db.select().from(reminders).where(eq(reminders.id, result.expiryFollowup.id));
  const [summary] = await reminderService.toReminderSummaries([row!], peerServer.id);
  assert.equal(summary!.msgRef, `#${peerProjection.name}:#${task!.taskNumber}`, "rendered with the peer server's local channel");
});
