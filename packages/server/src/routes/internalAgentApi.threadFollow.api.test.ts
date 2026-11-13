import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Agent attention parity (decided 2026-10-21):
 *  - `raft thread follow --target "#ch:<msg>"` (POST /internal/agent-api/
 *    threads/follow) mirrors `raft task follow`: reason `manual`, reactivates
 *    an earlier unfollow, read position starts at the latest reply, posts no
 *    line. A message without replies gets its thread. Task refs / task
 *    conversations are refused with `task_target_use_task_command`.
 *  - `raft task unfollow` posts "@agent stopped following this task" (": <reason>" if given) in
 *    the task conversation, like `raft thread unfollow` does in a thread, with
 *    no inbox fact.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentChannelReadCursors, channels, inboxNotificationFacts, messages, tasks, threadFollows, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliverMessage = async () => ({ status: "queued" as const });
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function setup(slug: string) {
  const [owner] = await getDb().insert(users).values({
    email: `${slug}-${randomUUID()}@slock.test`,
    name: `${slug}-${randomUUID().slice(0, 8)}`,
    displayName: `${slug} owner`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  const server = await createServer(`ThreadFollow ${slug}`, `${slug}-${randomUUID()}`, owner!.id);
  const channel = await createChannel(server.id, slug);
  await addHuman(channel.id, owner!.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `thread-follow-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return { owner: owner!, server, channel, agent, key: apiKey };
}

type AgentBody = { [key: string]: unknown; changed?: boolean; code?: string; error?: string; suggestedNextAction?: string };

async function agentPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as AgentBody };
}

async function agentFollow(threadChannelId: string, agentId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, threadChannelId),
    eq(threadFollows.followerType, "agent"),
    eq(threadFollows.followerId, agentId),
  ));
  return row ?? null;
}

async function agentCursor(channelId: string, agentId: string) {
  const [row] = await getDb().select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.channelId, channelId),
    eq(agentChannelReadCursors.agentId, agentId),
  ));
  return row?.lastReadSeq ?? null;
}

test("thread follow: follows as `manual` from the latest reply, idempotent, posts nothing", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, channel, agent, key } = await setup("tf-basic");
  const parent = await createMessage(channel.id, "user", owner.id, "a thread root");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "reply one");
  const latest = await createMessage(thread.id, "user", owner.id, "reply two");
  const target = `#${channel.name}:${parent.id.slice(0, 8)}`;

  const first = await agentPost(app.baseUrl, key, "threads/follow", { thread: target });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { ok: true, following: true, changed: true });
  const row = await agentFollow(thread.id, agent.id);
  assert.equal(row?.reason, "manual");
  assert.equal(row?.unfollowedAt, null);
  assert.equal(row?.parentMessageId, parent.id);
  assert.equal(await agentCursor(thread.id, agent.id), latest.seq, "existing replies are not unread");

  const again = await agentPost(app.baseUrl, key, "threads/follow", { thread: thread.id });
  assert.deepEqual(again.body, { ok: true, following: true, changed: false });

  await settle();
  const systemLines = await getDb().select().from(messages).where(and(
    eq(messages.channelId, thread.id),
    eq(messages.messageType, "system"),
  ));
  assert.deepEqual(systemLines, [], "following posts no line");
});

test("thread follow reactivates an explicit unfollow", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, channel, agent, key } = await setup("tf-reactivate");
  const parent = await createMessage(channel.id, "user", owner.id, "root");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", owner.id, "reply");
  const target = `#${channel.name}:${parent.id.slice(0, 8)}`;

  assert.equal((await agentPost(app.baseUrl, key, "threads/follow", { thread: target })).status, 200);
  assert.equal((await agentPost(app.baseUrl, key, "threads/unfollow", { thread: target })).status, 200);
  assert.ok((await agentFollow(thread.id, agent.id))?.unfollowedAt);

  const refollow = await agentPost(app.baseUrl, key, "threads/follow", { thread: target });
  assert.deepEqual(refollow.body, { ok: true, following: true, changed: true });
  const row = await agentFollow(thread.id, agent.id);
  assert.equal(row?.unfollowedAt, null);
  assert.equal(row?.reason, "manual");
});

test("thread follow on a message without replies creates its thread and follows it", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, channel, agent, key } = await setup("tf-lazy");
  const parent = await createMessage(channel.id, "user", owner.id, "nobody replied yet");

  const res = await agentPost(app.baseUrl, key, "threads/follow", { thread: `#${channel.name}:${parent.id.slice(0, 8)}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.changed, true);
  const [thread] = await getDb().select().from(channels).where(and(
    eq(channels.parentMessageId, parent.id),
    eq(channels.type, "thread"),
  ));
  assert.ok(thread, "the thread exists now");
  assert.equal((await agentFollow(thread!.id, agent.id))?.reason, "manual");
});

test("thread follow refuses task refs and task conversations, naming raft task follow; unknown threads are 404", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, channel, key } = await setup("tf-task");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "a task" }]);
  const ref = `#${channel.name}:#${task!.taskNumber}`;

  const byRef = await agentPost(app.baseUrl, key, "threads/follow", { thread: ref });
  assert.equal(byRef.status, 400, JSON.stringify(byRef.body));
  assert.equal(byRef.body.code, "task_target_use_task_command");
  // The sentence names no command; the next step does.
  assert.ok(String(byRef.body.suggestedNextAction).includes(`raft task follow "${ref}"`), byRef.body.suggestedNextAction);
  assert.doesNotMatch(String(byRef.body.error), /raft /);

  // Give the task its conversation (lazy or eager) and try its channel id.
  assert.equal((await agentPost(app.baseUrl, key, "tasks/follow", { channel: `#${channel.name}`, task_number: task!.taskNumber })).status, 200);
  const [row] = await getDb().select({ conversationChannelId: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, task!.id));
  assert.ok(row?.conversationChannelId);
  const byId = await agentPost(app.baseUrl, key, "threads/follow", { thread: row!.conversationChannelId });
  assert.equal(byId.status, 400, JSON.stringify(byId.body));
  assert.equal(byId.body.code, "task_target_use_task_command");

  const missing = await agentPost(app.baseUrl, key, "threads/follow", { thread: `#${channel.name}:deadbeef` });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  const notThread = await agentPost(app.baseUrl, key, "threads/follow", { thread: channel.id });
  assert.equal(notThread.status, 400, JSON.stringify(notThread.body));
});

test("thread follow cloaks an inaccessible private thread", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, key } = await setup("tf-private");
  const privateChannel = await createChannel(server.id, `tf-private-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  const parent = await createMessage(privateChannel.id, "user", owner.id, "secret root");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");

  const byId = await agentPost(app.baseUrl, key, "threads/follow", { thread: thread.id });
  assert.equal(byId.status, 404);
  const byRef = await agentPost(app.baseUrl, key, "threads/follow", { thread: `#${privateChannel.name}:${parent.id.slice(0, 8)}` });
  assert.equal(byRef.status, 404);
});

test("thread unfollow posts just \"@agent stopped following this thread\" unless a reason is given", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, channel, agent, key } = await setup("tu-copy");
  const parent = await createMessage(channel.id, "user", owner.id, "root");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const target = `#${channel.name}:${parent.id.slice(0, 8)}`;

  // No reason; the filler older CLIs always send; a real reason.
  for (const reason of [undefined, "no longer following", "handed off to the owner"]) {
    assert.equal((await agentPost(app.baseUrl, key, "threads/follow", { thread: target })).status, 200);
    const res = await agentPost(app.baseUrl, key, "threads/unfollow", reason ? { thread: target, reason } : { thread: target });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  await settle();
  const lines = await getDb().select().from(messages).where(and(
    eq(messages.channelId, thread.id),
    eq(messages.messageType, "system"),
  ));
  assert.deepEqual(lines.map((line) => line.content).sort(), [
    `@${agent.name} stopped following this thread`,
    `@${agent.name} stopped following this thread`,
    `@${agent.name} stopped following this thread: handed off to the owner`,
  ]);
});

test("task unfollow posts \"@agent stopped following this task: …\" in the task conversation, with no inbox fact", async ({ app }) => {
  installRecordingOrchestrator(app.app);
  const { owner, server, channel, agent, key } = await setup("tu-line");
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "watch then leave" }]);
  const body = { channel: `#${channel.name}`, task_number: task!.taskNumber };

  assert.equal((await agentPost(app.baseUrl, key, "tasks/follow", body)).status, 200);
  const unfollow = await agentPost(app.baseUrl, key, "tasks/unfollow", { ...body, reason: "handed off to the owner" });
  assert.equal(unfollow.status, 200, JSON.stringify(unfollow.body));
  assert.equal(unfollow.body.changed, true);

  const [row] = await getDb().select({ conversationChannelId: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, task!.id));
  const lines = await getDb().select().from(messages).where(and(
    eq(messages.channelId, row!.conversationChannelId!),
    eq(messages.messageType, "system"),
  ));
  const left = lines.filter((line) => line.content.includes("stopped following this task"));
  assert.deepEqual(left.map((line) => line.content), [`@${agent.name} stopped following this task: handed off to the owner`]);
  const facts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, left[0]!.id));
  assert.deepEqual(facts, [], "a self-unfollow line has no audience: no inbox fact");

  // Not following any more: nothing changes, nothing is posted.
  const again = await agentPost(app.baseUrl, key, "tasks/unfollow", body);
  assert.equal(again.body.changed, false);
  await settle();
  const after = await getDb().select().from(messages).where(and(
    eq(messages.channelId, row!.conversationChannelId!),
    eq(messages.messageType, "system"),
  ));
  assert.equal(after.filter((line) => line.content.includes("stopped following this task")).length, 1);

  // No reason: just the line, as for threads.
  assert.equal((await agentPost(app.baseUrl, key, "tasks/follow", body)).status, 200);
  assert.equal((await agentPost(app.baseUrl, key, "tasks/unfollow", body)).status, 200);
  const defaults = await getDb().select().from(messages).where(and(
    eq(messages.channelId, row!.conversationChannelId!),
    eq(messages.messageType, "system"),
  ));
  assert.ok(defaults.some((line) => line.content === `@${agent.name} stopped following this task`));
});
