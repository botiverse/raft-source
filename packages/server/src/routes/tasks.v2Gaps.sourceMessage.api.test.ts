import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — a task is linked to its source message, never the
 * same thing (RFC 078 "Model"; coverage matrix M2, D7):
 *  - the source message's text changes (the product has no general edit
 *    route; the row change stands in for one): the task's title is its own,
 *    `raft task view` shows the source as it is now;
 *  - the source message is retracted (RFC 077 soft delete: placeholder text,
 *    `deleted_at`): the task, its link, its conversation and its replies stay;
 *    the original text is not shown any more;
 *  - the source message row is removed: the task stays (`source_message_id`
 *    set null), with its conversation; view reports no source;
 *  - a true pre-thread orphan (no host message, no conversation, not a task
 *    v2 task) still reads as legacy (`isLegacy: true`), a task v2 task never.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { messages, serverMembers, servers, tasks, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { RETRACTED_DELEGATED_MESSAGE_CONTENT } from "../services/assistantSendAsOwnerService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliveries: { agentId: string; payload: Record<string, unknown> }[] = [];
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>) => {
    deliveries.push({ agentId, payload });
    return { status: "queued" as const };
  };
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown> }>) =>
      batch.map(({ agentId, message }) => deliverMessage(agentId, message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  return deliveries;
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

async function login(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function humanHeaders(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function agentPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function agentGet(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return { status: res.status, body: await res.json() as any };
}

async function taskRow(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row ?? null;
}

/** Owner + author (people) and an agent in one public channel, task v2 on. */
async function setup(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const author = await seedUser(`${slug}-author`);
  const server = await createServer(`Source ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: author.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, author.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `gaps-source-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return { owner, author, server, channel, agent, key: apiKey, board: `#${channel.name}` };
}

/** The agent creates a task from `source` and replies in it (so its conversation exists). */
async function taskFromSource(baseUrl: string, fx: Awaited<ReturnType<typeof setup>>, sourceId: string, title: string) {
  const created = await agentPost(baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title, source_message_id: sourceId }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, fx.channel.id), eq(tasks.taskNumber, taskNumber)));
  assert.equal(row!.sourceMessageId, sourceId);
  const reply = await agentPost(baseUrl, fx.key, "tasks/reply", { channel: fx.board, task_number: taskNumber, content: "drafting it now" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const conversationId = (await taskRow(row!.id))!.conversationChannelId!;
  assert.ok(conversationId);
  return { task: row!, taskNumber, conversationId, replyId: reply.body.messageId as string };
}

async function view(baseUrl: string, fx: Awaited<ReturnType<typeof setup>>, taskNumber: number) {
  const res = await agentGet(baseUrl, fx.key, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${taskNumber}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function assertConversationIntact(fx: Awaited<ReturnType<typeof setup>>, baseUrl: string, taskNumber: number, conversationId: string, replyId: string) {
  const [reply] = await getDb().select().from(messages).where(eq(messages.id, replyId));
  assert.equal(reply?.channelId, conversationId, "the earlier reply is still in the task conversation");
  const again = await agentPost(baseUrl, fx.key, "tasks/reply", { channel: fx.board, task_number: taskNumber, content: "still on it" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const [stored] = await getDb().select().from(messages).where(eq(messages.id, again.body.messageId));
  assert.equal(stored!.channelId, conversationId, "and it still takes replies");
}

test("M2 the source message's text changes: the task keeps its own title; view shows the source as it is now", async ({ app }) => {
  const fx = await setup("src-edit");
  installRecordingOrchestrator(app.app);
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "ship the launch post");
  const { task, taskNumber, conversationId, replyId } = await taskFromSource(app.baseUrl, fx, source.id, "launch post");

  await getDb().update(messages).set({ content: "ship the launch post on Friday", updatedAt: new Date() }).where(eq(messages.id, source.id));

  const after = (await taskRow(task.id))!;
  assert.equal(after.title, "launch post", "the task's title is its own, not the message's text");
  assert.equal(after.sourceMessageId, source.id);
  const body = await view(app.baseUrl, fx, taskNumber);
  assert.equal(body.task.title, "launch post");
  assert.equal(body.sourceMessage?.id, source.id);
  assert.equal(body.sourceMessage?.content, "ship the launch post on Friday");
  await assertConversationIntact(fx, app.baseUrl, taskNumber, conversationId, replyId);
});

test("M2 the source message is retracted (soft delete): the task, its link and its conversation stay; the original text is not shown", async ({ app }) => {
  const fx = await setup("src-retract");
  installRecordingOrchestrator(app.app);
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "the secret launch date is May 4");
  const { task, taskNumber, conversationId, replyId } = await taskFromSource(app.baseUrl, fx, source.id, "announce the launch");

  const now = new Date();
  await getDb().update(messages).set({ content: RETRACTED_DELEGATED_MESSAGE_CONTENT, searchText: "", deletedAt: now, updatedAt: now }).where(eq(messages.id, source.id));

  const after = (await taskRow(task.id))!;
  assert.ok(after, "the task stays");
  assert.deepEqual([after.title, after.status, after.sourceMessageId, after.conversationChannelId], ["announce the launch", "todo", source.id, conversationId]);
  const body = await view(app.baseUrl, fx, taskNumber);
  assert.equal(body.task.title, "announce the launch");
  assert.notEqual(body.sourceMessage?.content, "the secret launch date is May 4", "the retracted text is not shown");
  assert.equal(JSON.stringify(body).includes("the secret launch date"), false);

  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const listed = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.channel.id}`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(listed.status, 200, await listed.clone().text());
  const listedTask = ((await listed.json()) as { tasks: Array<{ id: string; sourceMessageId: string | null; conversationChannelId: string | null }> }).tasks.find((t) => t.id === task.id);
  assert.ok(listedTask, "still on the board");
  assert.deepEqual([listedTask!.sourceMessageId, listedTask!.conversationChannelId], [source.id, conversationId]);
  await assertConversationIntact(fx, app.baseUrl, taskNumber, conversationId, replyId);
});

test("M2 the source message row is removed: the task stays without a source, with its conversation", async ({ app }) => {
  const fx = await setup("src-gone");
  installRecordingOrchestrator(app.app);
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "clean up the old docs");
  const { task, taskNumber, conversationId, replyId } = await taskFromSource(app.baseUrl, fx, source.id, "docs cleanup");

  await getDb().delete(messages).where(eq(messages.id, source.id));

  const after = await taskRow(task.id);
  assert.ok(after, "the task stays");
  assert.equal(after!.sourceMessageId, null, "the link is cleared");
  assert.equal(after!.title, "docs cleanup");
  assert.equal(after!.conversationChannelId, conversationId);
  const body = await view(app.baseUrl, fx, taskNumber);
  assert.equal(body.sourceMessage, null);
  assert.equal(body.conversation.exists, true);
  const listed = await agentGet(app.baseUrl, fx.key, `tasks?channel=${encodeURIComponent(fx.board)}&status=all`);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok((listed.body.tasks as Array<{ taskNumber: number }>).some((t) => t.taskNumber === taskNumber), "still listed");
  await assertConversationIntact(fx, app.baseUrl, taskNumber, conversationId, replyId);
});

test("D7 a true pre-thread orphan (no host message, no conversation, not task v2) reads as legacy; a task v2 task does not", async ({ app }) => {
  const fx = await setup("orphan");
  installRecordingOrchestrator(app.app);
  const [orphan] = await getDb().insert(tasks).values({
    channelId: fx.channel.id,
    taskNumber: 900,
    title: "from before message tasks",
    createdByType: "user",
    createdById: fx.owner.id,
  }).returning();
  assert.equal(orphan!.messageId, null);
  assert.equal(orphan!.conversationChannelId, null);
  assert.equal(orphan!.ownConversation, false);
  const { tasks: [v2] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "a task v2 task" }]);

  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.channel.id}`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  const listed = (await res.json() as { tasks: Array<{ id: string; isLegacy?: boolean; conversationAnchored?: boolean }> }).tasks;
  const orphanDto = listed.find((t) => t.id === orphan!.id);
  const v2Dto = listed.find((t) => t.id === v2!.id);
  assert.ok(orphanDto && v2Dto, "both are listed");
  assert.deepEqual([orphanDto!.isLegacy, orphanDto!.conversationAnchored], [true, false], "the orphan opens the read-only legacy panel");
  assert.deepEqual([v2Dto!.isLegacy, v2Dto!.conversationAnchored], [false, true]);
});

test("the source message is older than a Free server's 30-day history: view keeps who and when, says why the text is missing", async ({ app }) => {
  const fx = await setup("src-aged");
  installRecordingOrchestrator(app.app);
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "the plan from last quarter");
  const { taskNumber } = await taskFromSource(app.baseUrl, fx, source.id, "last quarter's plan");
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, source.id));

  const free = await view(app.baseUrl, fx, taskNumber);
  assert.equal(free.task.title, "last quarter's plan");
  assert.equal(free.sourceMessage?.id, source.id);
  assert.equal(free.sourceMessage?.content, "", "not what it said");
  assert.equal(
    free.sourceMessage?.historyLimitMessage,
    "This message is older than the 30-day history on the Free plan. Upgrading to Pro restores the full history.",
  );

  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, fx.server.id));
  assert.equal((await view(app.baseUrl, fx, taskNumber)).sourceMessage?.content, "the plan from last quarter");
});
