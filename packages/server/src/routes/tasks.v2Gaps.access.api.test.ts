import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — who may see, write and hear a task conversation
 * (coverage matrix C2, M4, M6, C9 / M5, K3, M7). A task conversation follows
 * its parent channel, exactly like a thread:
 *  - private channel: an agent outside it gets the same 404 for a task that
 *    exists as for one that does not (view / read / reply / follow / message
 *    send at the ref), and nothing is created or written;
 *  - an agent that leaves the private channel, and a person removed from it,
 *    keep their follow (by design) but are no longer woken / notified;
 *  - a deleted agent is no longer woken, and its claim is released;
 *  - archived parent channel: `raft task reply`, `message send` at a task ref
 *    and the web send answer 409 `channel_archived`, nothing is written or
 *    created;
 *  - search never returns a private channel's task conversation to a non-member;
 *  - deleting the parent channel drops the task conversation from the
 *    followed list and closes the open task.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent, deleteAgent } from "../services/agentService";
import { addAgent, addHuman, archiveChannel, createChannel, deleteChannel, removeHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { searchMessagesForUser } from "../services/searchService";
import { createServer } from "../services/serverService";
import { ensureTaskConversation } from "../services/taskConversationService";
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
    // POST /channels/:id/leave purges the leaver's inbox for a private channel.
    purgeAgentInboxForChannelTree: async () => ({ removedCount: 0 }),
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

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
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

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `gaps-access-${randomUUID().slice(0, 6)}`,
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

async function agentTaskReply(baseUrl: string, apiKey: string, board: string, taskNumber: number, content: string) {
  const res = await agentPost(baseUrl, apiKey, "tasks/reply", { channel: board, task_number: taskNumber, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, "sent", JSON.stringify(res.body));
  return res.body.messageId as string;
}

async function taskRow(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

async function taskByNumber(channelId: string, taskNumber: number) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
  assert.ok(row, `task #${taskNumber} exists`);
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

/** Owner + agents in a channel of `type` (task v2 on). Agents listed in `members` join it; `outsider` does not. */
async function setup(slug: string, type: "channel" | "private") {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Access ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`, undefined, type);
  await addHuman(channel.id, owner.id);
  const agentA = await createAgent(server.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentC = await createAgent(server.id, `${slug}-c-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const outsider = await createAgent(server.id, `${slug}-x-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB, agentC]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  return {
    owner, server, channel, agentA, agentB, agentC, outsider,
    keyA: await agentKey(agentA.id),
    keyB: await agentKey(agentB.id),
    keyC: await agentKey(agentC.id),
    keyX: await agentKey(outsider.id),
    board: `#${channel.name}`,
  };
}

/** Task v2: a task always has a source; agent A's own message in the channel. */
async function sourceByA(fx: Awaited<ReturnType<typeof setup>>, content: string) {
  return (await createMessage(fx.channel.id, "agent", fx.agentA.id, content)).id;
}

/** A creates a task and assigns it to B: the assignment line creates the conversation (A authored, B assigned). */
async function assignedTask(baseUrl: string, fx: Awaited<ReturnType<typeof setup>>, title: string) {
  const created = await agentPost(baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title, source_message_id: await sourceByA(fx, title) }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const assign = await agentPost(baseUrl, fx.keyA, "tasks/assign", { channel: fx.board, task_number: taskNumber, assignee: `@${fx.agentB.name}` });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const task = await taskByNumber(fx.channel.id, taskNumber);
  const conversationId = await waitFor("conversation", async () => (await taskRow(task.id)).conversationChannelId);
  await waitFor("assignee follows", async () => followRow(conversationId, "agent", fx.agentB.id));
  return { task, taskNumber, conversationId };
}

// ── C2: private channel, an agent outside it ──

test("C2 private channel: an agent outside it gets the same 404 for a real task as for a missing one, and writes or creates nothing", async ({ app }) => {
  const fx = await setup("priv-cloak", "private");
  installRecordingOrchestrator(app.app);
  const discussed = await assignedTask(app.baseUrl, fx, "private discussion");
  await agentTaskReply(app.baseUrl, fx.keyB, fx.board, discussed.taskNumber, "members only");
  const lazyCreated = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title: "private, no conversation", source_message_id: await sourceByA(fx, "private, no conversation") }] });
  assert.equal(lazyCreated.status, 200, JSON.stringify(lazyCreated.body));
  const lazyNumber = lazyCreated.body.tasks[0].taskNumber as number;
  const lazy = await taskByNumber(fx.channel.id, lazyNumber);
  const messagesBefore = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, discussed.conversationId));

  const board = encodeURIComponent(fx.board);
  const attempts = (taskNumber: number) => [
    () => agentGet(app.baseUrl, fx.keyX, `tasks/view?channel=${board}&task_number=${taskNumber}`),
    () => agentGet(app.baseUrl, fx.keyX, `tasks/read?channel=${board}&task_number=${taskNumber}`),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/reply", { channel: fx.board, task_number: taskNumber, content: "let me in" }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/follow", { channel: fx.board, task_number: taskNumber }),
    () => agentPost(app.baseUrl, fx.keyX, "send", { target: `${fx.board}:#${taskNumber}`, content: "let me in" }),
  ];
  // An answer may echo the ref it was given; compare with the number masked.
  const masked = (body: unknown, taskNumber: number) => JSON.stringify(body).split(`#${taskNumber}`).join("#N");
  const missingNumber = 9_999;
  const missing = [];
  for (const attempt of attempts(missingNumber)) missing.push(await attempt());
  for (const taskNumber of [discussed.taskNumber, lazyNumber]) {
    const answers = [];
    for (const attempt of attempts(taskNumber)) answers.push(await attempt());
    for (const [index, answer] of answers.entries()) {
      assert.equal(answer.status, 404, `attempt ${index} on #${taskNumber}: ${JSON.stringify(answer.body)}`);
      assert.equal(
        masked(answer.body, taskNumber),
        masked(missing[index]!.body, missingNumber),
        `attempt ${index}: a real task is indistinguishable from a missing one`,
      );
    }
  }

  await settle();
  const messagesAfter = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, discussed.conversationId));
  assert.equal(messagesAfter.length, messagesBefore.length, "nothing was written in the task conversation");
  assert.equal((await taskRow(lazy.id)).conversationChannelId, null, "the lazy task got no conversation");
  assert.equal(await followRow(discussed.conversationId, "agent", fx.outsider.id), null, "the outsider follows nothing");

  // Control: a member agent sees it.
  const memberView = await agentGet(app.baseUrl, fx.keyC, `tasks/view?channel=${board}&task_number=${discussed.taskNumber}`);
  assert.equal(memberView.status, 200, JSON.stringify(memberView.body));
  assert.equal(memberView.body.taskRef, `${fx.board}:#${discussed.taskNumber}`);
});

// ── C2b: a private channel you can't see answers like one that doesn't exist ──

test("C2b private channel: every task route answers an outsider the same 404 body as for a channel that doesn't exist", async ({ app }) => {
  const fx = await setup("priv-board", "private");
  const real = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title: "members only", source_message_id: await sourceByA(fx, "members only") }] });
  assert.equal(real.status, 200, JSON.stringify(real.body));
  const missingBoard = `#no-such-${randomUUID().slice(0, 6)}`;
  // The same request on each board; an answer may echo the board's name, so compare with it masked.
  const attempts = (board: string) => [
    () => agentPost(app.baseUrl, fx.keyX, "tasks", { channel: board, tasks: [{ title: "let me in" }] }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/claim", { channel: board, task_numbers: [1] }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/assign", { channel: board, task_number: 1, assignee: `@${fx.agentB.name}` }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/update-status", { channel: board, task_number: 1, status: "in_progress" }),
    () => agentGet(app.baseUrl, fx.keyX, `tasks/read?channel=${encodeURIComponent(board)}&task_number=1`),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/reply", { channel: board, task_number: 1, content: "let me in" }),
    () => agentGet(app.baseUrl, fx.keyX, `tasks?channel=${encodeURIComponent(board)}`),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/unclaim", { channel: board, task_number: 1 }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/delete", { channel: board, task_number: 1 }),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/amend", { channel: board, task_number: 1, title: "let me in" }),
    () => agentGet(app.baseUrl, fx.keyX, `tasks/history?channel=${encodeURIComponent(board)}&task_number=1`),
    () => agentPost(app.baseUrl, fx.keyX, "tasks/convert", { channel: board, message_id: randomUUID() }),
  ];
  const masked = (body: unknown, board: string) => JSON.stringify(body).split(board.slice(1)).join("BOARD");
  const hidden = attempts(fx.board);
  const missing = attempts(missingBoard);
  for (const [index, attempt] of hidden.entries()) {
    const onHidden = await attempt();
    const onMissing = await missing[index]!();
    assert.equal(onHidden.status, onMissing.status, `attempt ${index}: ${JSON.stringify(onHidden.body)} vs ${JSON.stringify(onMissing.body)}`);
    assert.equal(onHidden.status, 404, `attempt ${index}: ${JSON.stringify(onHidden.body)}`);
    assert.equal(onHidden.body.code, "task_channel_not_found", `attempt ${index}: every task route answers the one task_channel_not_found refusal`);
    assert.equal(masked(onHidden.body, fx.board), masked(onMissing.body, missingBoard), `attempt ${index}: a hidden channel reads like a missing one`);
  }
});

// ── M4: leaving the private channel ──

test("M4 private channel: an agent that left is no longer woken by task replies (its follow stays), and can no longer view the task", async ({ app }) => {
  const fx = await setup("priv-left", "private");
  const deliveries = installRecordingOrchestrator(app.app);
  const { taskNumber, conversationId } = await assignedTask(app.baseUrl, fx, "keep going without B");
  const followC = await agentPost(app.baseUrl, fx.keyC, "tasks/follow", { channel: fx.board, task_number: taskNumber });
  assert.equal(followC.status, 200, JSON.stringify(followC.body));

  const before = await agentTaskReply(app.baseUrl, fx.keyA, fx.board, taskNumber, "B, are you there?");
  await waitFor("B and C woken", async () => [fx.agentB.id, fx.agentC.id].every((id) => deliveries.some((d) => d.agentId === id && d.payload.message_id === before)));

  const leave = await agentPost(app.baseUrl, fx.keyB, `channels/${fx.channel.id}/leave`, {});
  assert.equal(leave.status, 200, JSON.stringify(leave.body));

  const after = await agentTaskReply(app.baseUrl, fx.keyA, fx.board, taskNumber, "B has left");
  await waitFor("C woken", async () => deliveries.some((d) => d.agentId === fx.agentC.id && d.payload.message_id === after));
  await settle();
  assert.deepEqual(
    deliveries.filter((d) => d.payload.message_id === after).map((d) => d.agentId),
    [fx.agentC.id],
    "the agent that left the private channel is not woken; the remaining follower is",
  );
  assert.equal((await followRow(conversationId, "agent", fx.agentB.id))?.reason, "assigned", "the follow itself is kept (by design)");
  const view = await agentGet(app.baseUrl, fx.keyB, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${taskNumber}`);
  assert.equal(view.status, 404, JSON.stringify(view.body));
});

test("M4 private channel: a person removed from it keeps the follow but gets no entry for later task replies", async ({ app }) => {
  const fx = await setup("priv-removed", "private");
  installRecordingOrchestrator(app.app);
  const member = await seedUser("priv-removed-member");
  await getDb().insert(serverMembers).values({ serverId: fx.server.id, userId: member.id, role: "member" });
  await addHuman(fx.channel.id, member.id);
  const { taskNumber, conversationId } = await assignedTask(app.baseUrl, fx, "people leave too");
  const memberToken = await login(app.baseUrl, member.email);
  const follow = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST",
    headers: humanHeaders(memberToken, fx.server.id),
    body: JSON.stringify({ threadChannelId: conversationId }),
  });
  assert.equal(follow.status, 200, await follow.clone().text());

  const before = await agentTaskReply(app.baseUrl, fx.keyA, fx.board, taskNumber, "the member still hears this");
  await waitFor("member entry", async () => (await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, before),
    eq(inboxNotificationFacts.receiverId, member.id),
  ))).length > 0);

  await removeHuman(fx.channel.id, member.id, { self: true });
  const after = await agentTaskReply(app.baseUrl, fx.keyA, fx.board, taskNumber, "the member is gone");
  await settle();
  assert.deepEqual(
    await getDb().select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, after),
      eq(inboxNotificationFacts.receiverId, member.id),
    )),
    [],
    "a person removed from the private channel gets no entry",
  );
  assert.ok(await followRow(conversationId, "user", member.id), "the follow itself is kept (by design)");
});

// ── M6: a deleted agent ──

test("M6 a deleted agent: its claim is released and it is no longer woken by the task conversation", async ({ app }) => {
  const fx = await setup("deleted-agent", "channel");
  const deliveries = installRecordingOrchestrator(app.app);
  const { task, taskNumber } = await assignedTask(app.baseUrl, fx, "outlive the assignee");
  assert.equal((await agentPost(app.baseUrl, fx.keyC, "tasks/follow", { channel: fx.board, task_number: taskNumber })).status, 200);

  await deleteAgent(fx.agentB.id);
  assert.equal((await taskRow(task.id)).claimedById, null, "deleting the agent released its claim");

  const reply = await agentTaskReply(app.baseUrl, fx.keyA, fx.board, taskNumber, "who picks this up?");
  await waitFor("C woken", async () => deliveries.some((d) => d.agentId === fx.agentC.id && d.payload.message_id === reply));
  await settle();
  assert.deepEqual(deliveries.filter((d) => d.payload.message_id === reply).map((d) => d.agentId), [fx.agentC.id], "the deleted agent is not woken");
});

// ── C9 / M5: archived parent channel ──

test("C9 archived channel: raft task reply, message send at the ref and the web send answer 409 channel_archived; nothing is written or created", async ({ app }) => {
  const fx = await setup("archived", "channel");
  const member = await seedUser("archived-member");
  await getDb().insert(serverMembers).values({ serverId: fx.server.id, userId: member.id, role: "member" });
  await addHuman(fx.channel.id, member.id);
  installRecordingOrchestrator(app.app);
  const { taskNumber, conversationId } = await assignedTask(app.baseUrl, fx, "frozen with the channel");
  await agentTaskReply(app.baseUrl, fx.keyB, fx.board, taskNumber, "before the archive");
  const lazyCreated = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title: "never discussed", source_message_id: await sourceByA(fx, "never discussed") }] });
  assert.equal(lazyCreated.status, 200, JSON.stringify(lazyCreated.body));
  const lazyNumber = lazyCreated.body.tasks[0].taskNumber as number;
  const lazy = await taskByNumber(fx.channel.id, lazyNumber);
  const countBefore = (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, conversationId))).length;

  await archiveChannel(fx.channel.id, fx.owner.id);

  const reply = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: taskNumber, content: "after the archive" });
  assert.equal(reply.status, 409, JSON.stringify(reply.body));
  assert.equal(reply.body.code, "channel_archived");
  const lazyReply = await agentPost(app.baseUrl, fx.keyB, "tasks/reply", { channel: fx.board, task_number: lazyNumber, content: "first word, too late" });
  assert.equal(lazyReply.status, 409, JSON.stringify(lazyReply.body));
  assert.equal(lazyReply.body.code, "channel_archived");
  // `message send` at the lazy task's ref: refused before a conversation is created.
  const lazySend = await agentPost(app.baseUrl, fx.keyB, "send", { target: `${fx.board}:#${lazyNumber}`, content: "through message send, too late" });
  assert.equal(lazySend.status, 409, JSON.stringify(lazySend.body));
  assert.equal(lazySend.body.code, "channel_archived");

  const memberToken = await login(app.baseUrl, member.email);
  const web = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(memberToken, fx.server.id),
    body: JSON.stringify({ channelId: conversationId, content: "from the web, after the archive" }),
  });
  assert.equal(web.status, 409, await web.clone().text());
  assert.equal(((await web.json()) as { code?: string }).code, "channel_archived");

  await settle();
  const countAfter = (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, conversationId))).length;
  assert.equal(countAfter, countBefore, "nothing was written in the task conversation");
  assert.equal((await taskRow(lazy.id)).conversationChannelId, null, "no conversation was created for the lazy task");
});

// ── K3: search ──

test("K3 search: a private channel's task conversation is not found by a non-member, and is by a member", async ({ db: _db }) => {
  const owner = await seedUser("search-owner");
  const outsider = await seedUser("search-outsider");
  const server = await createServer("Search", `search-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  const privateChannel = await createChannel(server.id, `search-priv-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(privateChannel.id, owner.id);
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(privateChannel.id, "user", owner.id, [{ title: "secret plans" }], { initiatingServerId: server.id });
  const ensured = await ensureTaskConversation(task!.id, { initiatingServerId: server.id, createdByUserId: owner.id });
  assert.ok(ensured?.created);
  const conversationId = (await taskRow(task!.id)).conversationChannelId!;
  await createMessage(conversationId, "user", owner.id, "the wombatword stays private");

  const forOwner = await searchMessagesForUser({ serverId: server.id, userId: owner.id, query: "wombatword", historyCutoff: undefined });
  assert.ok(forOwner.results.some((result) => result.channelId === conversationId), "the member finds it");
  const forOutsider = await searchMessagesForUser({ serverId: server.id, userId: outsider.id, query: "wombatword", historyCutoff: undefined });
  assert.deepEqual(forOutsider.results, [], "a non-member finds nothing");
});

// ── M7: the parent channel is deleted ──

test("M7 a deleted channel: its open task closes and its task conversation leaves the followed list", async ({ app }) => {
  const owner = await seedUser("deleted-channel-owner");
  const server = await createServer("Deleted channel", `deleted-channel-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `deleted-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  await enableTaskV2ConversationsForServer(server.id);
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "goes with the channel" }]);
  const ownerToken = await login(app.baseUrl, owner.email);
  const open = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/conversation`, { method: "POST", headers: humanHeaders(ownerToken, server.id) });
  assert.equal(open.status, 200, await open.clone().text());
  const { conversationChannelId } = await open.json() as { conversationChannelId: string };
  await createMessage(conversationChannelId, "user", owner.id, "a reply before the delete");
  const followed = async () => {
    const res = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: humanHeaders(ownerToken, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { threads: Array<{ threadChannelId: string }> }).threads;
  };
  assert.ok((await followed()).some((row) => row.threadChannelId === conversationChannelId), "listed while the channel exists");

  await deleteChannel(channel.id);
  assert.equal((await taskRow(task!.id)).status, "closed", "the open task is closed with its channel");
  assert.equal((await followed()).some((row) => row.threadChannelId === conversationChannelId), false, "the task conversation is no longer listed");
  const [conversation] = await getDb().select().from(channels).where(eq(channels.id, conversationChannelId));
  assert.ok(conversation, "the conversation row itself stays (soft delete of the parent)");
});
