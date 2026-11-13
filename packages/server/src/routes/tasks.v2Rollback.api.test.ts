import { fixturePasswordHash } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2, per-task mode (RFC 078 "Per-task mode"): a task created the v2 way
 * (`tasks.own_conversation`) or one that already has its conversation keeps
 * working the v2 way after `task_v2_conversations_v0` is turned off again
 * (rollback). The flag decides only how NEW tasks are created, whether the new
 * entry points show, and whether a pre-v2 task gets a conversation lazily.
 *
 * Each test creates v2 tasks with the flag on — some with their conversation,
 * some still without one (lazy) — turns the flag off, then checks one surface:
 * assign / status lines and the assignee's notice, `raft task reply`, an old
 * CLI's `message send "#ch:#7"`, the resource receipt, the listings (followed,
 * Done, Files, web board), `raft task view|read|list|claim`, delete. A task
 * from before task v2 keeps the staging behavior throughout (host thread).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, type TaskResourceReceipt } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channels,
  featureFlagRules,
  inboxNotificationFacts,
  messages,
  serverMembers,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type Delivery = { agentId: string; payload: Record<string, unknown> };

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
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

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `rollback-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return apiKey;
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

async function disableTaskV2Conversations() {
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY));
}

async function taskRow(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

async function followRow(conversationId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row?.unfollowedAt == null ? row ?? null : null;
}

async function messagesIn(channelId: string) {
  return getDb().select().from(messages).where(eq(messages.channelId, channelId));
}

/**
 * Owner (creator) + member + agent A (creator of agent tasks) + agent B in one
 * public channel. With the flag on: `lazy` and `lazy2` (v2, no conversation
 * yet), `talked` (v2, conversation created by a reply), `receipt` (v2, creates
 * a resource, no source); with the flag still off before that: `legacy` (a
 * pre-v2 task with its host message). Then the flag goes off (rollback).
 */
async function rolledBack(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Rollback ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-room`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agentA = await createAgent(server.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agentA.id);
  await addAgent(channel.id, agentB.id);
  const keyA = await agentKey(agentA.id);
  const keyB = await agentKey(agentB.id);
  const board = `#${channel.name}`;

  // Before task v2: a task with its visible host message.
  const { tasks: [legacy], hostMessages: [legacyHost] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} legacy task` }],
  );

  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [lazy, lazy2, talked] } = await taskService.createTasks(
    channel.id, "agent", agentA.id,
    [{ title: `${slug} lazy` }, { title: `${slug} lazy two` }, { title: `${slug} talked` }],
    { initiatingServerId: server.id },
  );
  const { tasks: [receipt] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} bucket`, createsResource: true }], { initiatingServerId: server.id },
  );
  return { owner, member, server, channel, agentA, agentB, keyA, keyB, board, legacy: legacy!, legacyHost: legacyHost!, lazy: lazy!, lazy2: lazy2!, talked: talked!, receipt: receipt! };
}

test("rollback: assign and status on a v2 task without a conversation create it, post the lines there and notify the assignee", async ({ app }) => {
  const fx = await rolledBack("rb-assign");
  installRecordingOrchestrator(app.app);
  await disableTaskV2Conversations();
  assert.equal((await taskRow(fx.lazy.id)).conversationChannelId, null, "still lazy at rollback");
  const ownerToken = await login(app.baseUrl, fx.owner.email);

  // Web assign to the member: the line creates the conversation.
  const assign = await fetch(`${app.baseUrl}/api/tasks/${fx.lazy.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, fx.server.id),
    body: JSON.stringify({ assignee: { type: "user", id: fx.member.id } }),
  });
  assert.equal(assign.status, 200, await assign.clone().text());
  const conversationId = await waitFor("conversation", async () => (await taskRow(fx.lazy.id)).conversationChannelId);
  const line = await waitFor("assignment line", async () => {
    const rows = (await messagesIn(conversationId)).filter((row) => row.systemSubtype === "task.assignment_receipt");
    return rows[0] ?? null;
  });
  const facts = await waitFor("assignee notice", async () => {
    const rows = await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, line.id),
      eq(inboxNotificationFacts.receiverId, fx.member.id),
    ));
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention]), [["task", true]], "the assignee is notified once, as a task mention");
  assert.equal((await followRow(conversationId, "user", fx.member.id))?.reason, "assigned");
  assert.equal((await followRow(conversationId, "agent", fx.agentA.id))?.reason, "authored", "created with its creator following");

  // Agent status change: the line goes to the same conversation; the channel stays clean.
  const channelBefore = (await messagesIn(fx.channel.id)).length;
  const status = await agentPost(app.baseUrl, fx.keyA, "tasks/update-status", { channel: fx.board, task_number: fx.lazy.taskNumber, status: "in_progress" });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.taskRef, `${fx.board}:#${fx.lazy.taskNumber}`, "the receipt names the v2 task by its ref");
  await waitFor("status line", async () => (await messagesIn(conversationId)).some((row) => row.systemSubtype === "task.lifecycle_thread"));
  await settle();
  assert.equal((await messagesIn(fx.channel.id)).length, channelBefore, "nothing is posted in the channel");
  assert.equal((await getDb().select().from(channels).where(and(eq(channels.taskId, fx.lazy.id), eq(channels.type, "task")))).length, 1);

  // Control: a pre-v2 task keeps the staging behavior (host message thread, no conversation, no ref).
  const legacyStatus = await agentPost(app.baseUrl, fx.keyA, "tasks/update-status", { channel: fx.board, task_number: fx.legacy.taskNumber, status: "in_progress" });
  assert.equal(legacyStatus.status, 200, JSON.stringify(legacyStatus.body));
  assert.equal(legacyStatus.body.taskRef, undefined, "pre-v2 response shape");
  await waitFor("legacy host thread line", async () => {
    const [thread] = await getDb().select().from(channels).where(and(eq(channels.parentMessageId, fx.legacyHost.id), eq(channels.type, "thread")));
    return thread ? (await messagesIn(thread.id)).length > 0 : false;
  });
  assert.equal((await taskRow(fx.legacy.id)).conversationChannelId, null, "a pre-v2 task gets no conversation with the flag off");
});

test("rollback: raft task reply, an old CLI's message send to the ref, task read and view on v2 tasks", async ({ app }) => {
  const fx = await rolledBack("rb-reply");
  const deliveries = installRecordingOrchestrator(app.app);
  // `talked` gets its conversation while the flag is on.
  const first = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: fx.talked.taskNumber, content: "before rollback" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const talkedConversation = (await taskRow(fx.talked.id)).conversationChannelId!;
  assert.ok(talkedConversation);
  await disableTaskV2Conversations();

  // raft task reply: an existing conversation, and a lazy one created now.
  const toTalked = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: fx.talked.taskNumber, content: "after rollback" });
  assert.equal(toTalked.status, 200, JSON.stringify(toTalked.body));
  const [talkedRow] = await getDb().select().from(messages).where(eq(messages.id, toTalked.body.messageId));
  assert.equal(talkedRow!.channelId, talkedConversation);
  await waitFor("creator woken", async () => deliveries.some((d) => d.agentId === fx.agentA.id && d.payload.message_id === toTalked.body.messageId));

  const toLazy = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: fx.lazy.taskNumber, content: "first reply, flag off" });
  assert.equal(toLazy.status, 200, JSON.stringify(toLazy.body));
  const lazyConversation = (await taskRow(fx.lazy.id)).conversationChannelId!;
  assert.ok(lazyConversation, "the reply created the v2 task's conversation with the flag off");
  assert.equal((await followRow(lazyConversation, "agent", fx.agentA.id))?.reason, "authored");
  assert.equal((await followRow(lazyConversation, "agent", fx.agentB.id))?.reason, "replied");

  // An old CLI's `message send "#ch:#7"` (the delivered target) reaches the conversation.
  const oldSend = await agentPost(app.baseUrl, fx.keyB, "send", { target: `${fx.board}:#${fx.lazy2.taskNumber}`, content: "old cli reply" });
  assert.equal(oldSend.status, 200, JSON.stringify(oldSend.body));
  const lazy2Conversation = (await taskRow(fx.lazy2.id)).conversationChannelId!;
  assert.ok(lazy2Conversation, "message send at the ref created the conversation");
  const [oldRow] = await getDb().select().from(messages).where(eq(messages.id, oldSend.body.messageId));
  assert.equal(oldRow!.channelId, lazy2Conversation);

  // The delivery still addresses the task by its ref.
  const delivered = await waitFor("delivery", async () => deliveries.find((d) => d.agentId === fx.agentA.id && d.payload.message_id === oldSend.body.messageId));
  assert.equal(delivered.payload.task_conversation_number, fx.lazy2.taskNumber);

  // read / view by ref.
  const read = await agentGet(app.baseUrl, fx.keyA, `tasks/read?channel=${encodeURIComponent(fx.board)}&task_number=${fx.lazy.taskNumber}&after=0&limit=50`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok((read.body.messages as Array<{ content: string }>).some((m) => m.content.includes("first reply, flag off")));
  const { tasks: [untouched] } = await taskService.createTasks(fx.channel.id, "agent", fx.agentA.id, [{ title: "made after rollback" }], { initiatingServerId: fx.server.id });
  assert.equal(untouched!.conversationAnchored, false, "a task created after the rollback is a pre-v2 task again");
  const view = await agentGet(app.baseUrl, fx.keyA, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${fx.receipt.taskNumber}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.conversation.exists, false);
  assert.deepEqual([view.body.following, view.body.followReason], [false, null], "agent A neither created nor holds it");
  const emptyRead = await agentGet(app.baseUrl, fx.keyA, `tasks/read?channel=${encodeURIComponent(fx.board)}&task_number=${fx.receipt.taskNumber}`);
  assert.equal(emptyRead.status, 200, "a v2 task without a conversation reads as an empty discussion, not 409");
  assert.deepEqual(emptyRead.body.messages, []);

  // Control: a pre-v2 task on the flag-off server answers as on staging.
  const legacyReply = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: fx.legacy.taskNumber, content: "hi" });
  assert.equal(legacyReply.status, 409, JSON.stringify(legacyReply.body));
  assert.equal(legacyReply.body.code, "task_conversations_not_enabled");
  const legacySend = await agentPost(app.baseUrl, fx.keyB, "send", { target: `${fx.board}:#${fx.legacy.taskNumber}`, content: "hi" });
  assert.equal(legacySend.status, 404, JSON.stringify(legacySend.body));
});

test("rollback: task list, claim and following name v2 tasks by ref; view agrees with --following and the web (W7)", async ({ app }) => {
  const fx = await rolledBack("rb-list");
  installRecordingOrchestrator(app.app);
  await disableTaskV2Conversations();

  const list = await agentGet(app.baseUrl, fx.keyA, `tasks?channel=${encodeURIComponent(fx.board)}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const byNumber = new Map((list.body.tasks as Array<{ taskNumber: number; messageId: string; conversationPending?: boolean }>).map((t) => [t.taskNumber, t]));
  assert.equal(byNumber.get(fx.lazy.taskNumber)!.messageId, `#${fx.lazy.taskNumber}`, "a v2 task is followed up at its ref");
  assert.equal(byNumber.get(fx.legacy.taskNumber)!.messageId, fx.legacy.messageId, "a pre-v2 task keeps its host message");
  assert.equal(byNumber.get(fx.legacy.taskNumber)!.conversationPending, undefined);

  const claim = await agentPost(app.baseUrl, fx.keyB, "tasks/claim", { channel: fx.board, task_numbers: [fx.lazy.taskNumber, fx.legacy.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const results = claim.body.results as Array<{ taskNumber: number; taskRef?: string; success: boolean }>;
  assert.equal(results.find((r) => r.taskNumber === fx.lazy.taskNumber)?.taskRef, `${fx.board}:#${fx.lazy.taskNumber}`);
  assert.equal(results.find((r) => r.taskNumber === fx.legacy.taskNumber)?.taskRef, undefined, "pre-v2 claim result shape");
  const claimedConversation = (await taskRow(fx.lazy.id)).conversationChannelId;
  assert.ok(claimedConversation, "the claim line created the v2 task's conversation");
  assert.equal((await followRow(claimedConversation!, "agent", fx.agentB.id))?.reason, "assigned");

  // W7: one rule. Agent A created lazy2 (no conversation): following (authored)
  // in view and --following. The owner created the legacy task: no conversation
  // to follow anywhere.
  const viewLazy2 = await agentGet(app.baseUrl, fx.keyA, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${fx.lazy2.taskNumber}`);
  assert.deepEqual([viewLazy2.body.following, viewLazy2.body.followReason], [true, "authored"]);
  const following = await agentGet(app.baseUrl, fx.keyA, "tasks/following");
  assert.equal(following.status, 200, JSON.stringify(following.body));
  const refs = (following.body.tasks as Array<{ taskRef: string }>).map((row: { taskRef: string }) => row.taskRef);
  assert.ok(refs.includes(`${fx.board}:#${fx.lazy2.taskNumber}`), JSON.stringify(following.body));

  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const boardRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.channel.id}`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(boardRes.status, 200);
  const boardTasks = (await boardRes.json() as { tasks: Array<{ id: string; conversationFollowed?: boolean }> }).tasks;
  assert.equal(boardTasks.find((t) => t.id === fx.receipt.id)?.conversationFollowed, true, "the owner created the v2 receipt task: following, before its conversation exists");
  assert.equal(boardTasks.find((t) => t.id === fx.lazy2.id)?.conversationFollowed, false, "a v2 task the owner neither created nor holds");
  assert.equal("conversationFollowed" in boardTasks.find((t) => t.id === fx.legacy.id)!, false, "a pre-v2 task on a flag-off server keeps the DTO unchanged");

  // The legacy task's creator is not "following" a conversation that is not there.
  const legacyByAgent = await taskService.createTasks(fx.channel.id, "agent", fx.agentA.id, [{ title: "legacy by A" }], { initiatingServerId: fx.server.id });
  const viewLegacy = await agentGet(app.baseUrl, fx.keyA, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${legacyByAgent.tasks[0]!.taskNumber}`);
  assert.deepEqual([viewLegacy.body.following, viewLegacy.body.followReason], [false, null], "view agrees with --following for a pre-v2 task");
  const followingAfter = await agentGet(app.baseUrl, fx.keyA, "tasks/following");
  const refsAfter = (followingAfter.body.tasks as Array<{ taskRef: string }>).map((row: { taskRef: string }) => row.taskRef);
  assert.equal(refsAfter.includes(`${fx.board}:#${legacyByAgent.tasks[0]!.taskNumber}`), false);
});

test("rollback: a resource receipt on a v2 task without source or conversation anchors on a line in its new conversation", async ({ app }) => {
  const fx = await rolledBack("rb-receipt");
  installRecordingOrchestrator(app.app);
  await disableTaskV2Conversations();
  const receipt: TaskResourceReceipt = {
    object: "s3://raft-rollback",
    purpose: "rollback acceptance",
    teardown_owner: `@${fx.agentA.name}`,
    security_privacy: "internal; encrypted",
    expiry: "2099-09-01T00:00:00.000Z",
    runbook: "runbooks/rollback.md",
    tracking: `task #${fx.receipt.taskNumber}`,
  };
  const res = await agentPost(app.baseUrl, fx.keyA, "tasks/resource-receipt", { channel: fx.board, task_number: fx.receipt.taskNumber, receipt });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const conversationId = (await taskRow(fx.receipt.id)).conversationChannelId!;
  assert.ok(conversationId, "the receipt line created the conversation with the flag off");
  const [line] = await getDb().select().from(messages).where(eq(messages.id, res.body.expiryFollowup.msgId));
  assert.equal(line!.channelId, conversationId);
  assert.equal(res.body.expiryFollowup.targetChannelId, conversationId);
});

test("rollback: a v2 task's conversation stays listed (followed, Done, Files) and its web board row opens it", async ({ app }) => {
  const fx = await rolledBack("rb-lists");
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, fx.owner.email);
  // The owner's v2 task gets its conversation (a web reply) and a file, with the flag on.
  const opened = await fetch(`${app.baseUrl}/api/tasks/${fx.receipt.id}/conversation`, { method: "POST", headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(opened.status, 200, await opened.clone().text());
  const { conversationChannelId } = await opened.json() as { conversationChannelId: string };
  const web = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(await login(app.baseUrl, fx.member.email), fx.server.id),
    body: JSON.stringify({ channelId: conversationChannelId, content: "bucket is up" }),
  });
  assert.equal(web.status, 200, await web.clone().text());
  const { id: replyId } = await web.json() as { id: string };
  await insertAttachmentsWithObjects(getDb(), {
    id: randomUUID(),
    messageId: replyId,
    channelId: conversationChannelId,
    uploaderId: fx.member.id,
    uploaderType: "user",
    filename: "bucket.png",
    mimeType: "image/png",
    sizeBytes: 42,
    storageKey: "attachments/bucket.png",
  });
  await disableTaskV2Conversations();

  const followed = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(followed.status, 200);
  const row = ((await followed.json()) as { threads: any[] }).threads.find((thread) => thread.threadChannelId === conversationChannelId);
  assert.equal(row?.kind, "task", "the followed list keeps the v2 task's conversation");
  assert.equal(row?.unreadCount, 1);

  const files = await fetch(`${app.baseUrl}/api/channels/${fx.channel.id}/files`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(files.status, 200);
  assert.ok(((await files.json()) as { files: any[] }).files.some((file) => file.filename === "bucket.png" && file.source.type === "task"));

  const done = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST", headers: humanHeaders(ownerToken, fx.server.id), body: JSON.stringify({ threadChannelId: conversationChannelId }),
  });
  assert.ok(done.status < 300, await done.clone().text());
  const history = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=50`, { headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(history.status, 200);
  assert.ok(((await history.json()) as { items: any[] }).items.some((item) => item.threadChannelId === conversationChannelId && item.kind === "task"));

  // The board row: a v2 task (conversationAnchored) with its conversation id.
  const boardRes = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.channel.id}`, { headers: humanHeaders(ownerToken, fx.server.id) });
  const boardTask = ((await boardRes.json()) as { tasks: any[] }).tasks.find((t) => t.id === fx.receipt.id);
  assert.equal(boardTask.conversationAnchored, true);
  assert.equal(boardTask.conversationChannelId, conversationChannelId);
  assert.equal(boardTask.hostMessageId, null);
  assert.equal(boardTask.conversationFollowed, true);
});
