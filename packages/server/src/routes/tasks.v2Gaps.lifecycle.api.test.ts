import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — lifecycle lines in the task conversation (RFC 078
 * "Following and notifications"; coverage matrix F7, F8, F10, F11, F15):
 *  - unassign (web and agent): one line, no mention, nobody starts following;
 *  - reassign: the earlier assignee keeps following (follows are only left by hand);
 *  - every status of the five, forwards and back: one line per change, heard
 *    by the conversation's followers but never by the actor;
 *  - a task v2 task's first status change creates its conversation, its
 *    creator following (`authored`);
 *  - unclaim (agent and web): one line, no mention, the follow is kept;
 *  - claim (agent and web): the same lines as assign-to-self and the status
 *    route ("took", "moved … to In Progress"), one per change.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  channels,
  inboxNotificationFacts,
  messageMentions,
  messages,
  serverMembers,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
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
    name: `gaps-life-${randomUUID().slice(0, 6)}`,
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

/** Owner + member (people) and agents A, B, C in one public channel, task v2 on. */
async function setup(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Gaps ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agentA = await createAgent(server.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentC = await createAgent(server.id, `${slug}-c-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB, agentC]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  return {
    owner, member, server, channel, agentA, agentB, agentC,
    keyA: await agentKey(agentA.id),
    keyB: await agentKey(agentB.id),
    keyC: await agentKey(agentC.id),
    board: `#${channel.name}`,
  };
}

/** Task v2: a task always has a source; agent A's own message in the channel. */
async function sourceByA(fx: Awaited<ReturnType<typeof setup>>, content: string) {
  return (await createMessage(fx.channel.id, "agent", fx.agentA.id, content)).id;
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

async function conversationLines(conversationId: string, subtypes: string[]) {
  const rows = await getDb().select().from(messages).where(and(
    eq(messages.channelId, conversationId),
    inArray(messages.systemSubtype, subtypes),
  ));
  return rows.sort((a, b) => a.seq - b.seq);
}

async function followRows(conversationId: string) {
  return getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationId));
}

async function activeFollow(conversationId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row && !row.unfollowedAt ? row : null;
}

async function mentionRows(messageId: string) {
  return getDb().select().from(messageMentions).where(eq(messageMentions.messageId, messageId));
}

async function userFacts(messageId: string) {
  return getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, messageId),
    eq(inboxNotificationFacts.receiverType, "user"),
  ));
}

const LIFECYCLE = ["task.lifecycle_thread", "task.assignment_receipt"];

// ── F7: unassign ──

test("F7 web unassign (v2): one 🔓 line in the task conversation, no mention, no personal entry, nobody newly follows", async ({ app }) => {
  const fx = await setup("unassign-web");
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "hand it back" }]);
  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const assignee = (body: unknown) => fetch(`${app.baseUrl}/api/tasks/${task!.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, fx.server.id),
    body: JSON.stringify(body),
  });

  const assigned = await assignee({ assignee: { type: "user", id: fx.member.id } });
  assert.equal(assigned.status, 200, await assigned.clone().text());
  const conversationId = await waitFor("conversation", async () => (await taskRow(task!.id)).conversationChannelId);
  await waitFor("assignment line", async () => (await conversationLines(conversationId, LIFECYCLE)).length === 1);
  const followsBefore = (await followRows(conversationId)).map((row) => [row.followerType, row.followerId, row.reason]).sort();

  const unassigned = await assignee({ assignee: null });
  assert.equal(unassigned.status, 200, await unassigned.clone().text());
  assert.equal((await taskRow(task!.id)).claimedById, null);
  const lines = await waitFor("unassign line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  const line = lines[1]!;
  assert.equal(line.content, `🔓 ${fx.owner.displayName} unassigned #${task!.taskNumber} "hand it back"`);
  assert.equal(line.messageType, "system");
  assert.equal(line.systemSubtype, "task.lifecycle_thread", "an unassign is not an assignment notice");
  assert.equal(line.channelId, conversationId, "the line lives in the task conversation");
  assert.deepEqual(await mentionRows(line.id), [], "unassigning mentions nobody");
  await settle();
  assert.equal((await userFacts(line.id)).some((fact) => fact.personalMention), false, "nobody gets a personal entry");
  assert.deepEqual(
    (await followRows(conversationId)).map((row) => [row.followerType, row.followerId, row.reason]).sort(),
    followsBefore,
    "unassigning makes nobody follow (and drops no follow)",
  );
  assert.equal((await activeFollow(conversationId, "user", fx.member.id))?.reason, "assigned", "the former assignee still follows");
  await settle();
  assert.equal((await conversationLines(conversationId, LIFECYCLE)).length, 2, "exactly one line for the unassign");
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id)), [], "nothing in the channel itself");
});

test("F7 agent unassign (raft task assign null): one 🔓 line, the former assignee is not woken as mentioned and keeps following", async ({ app }) => {
  const fx = await setup("unassign-agent");
  const deliveries = installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title: "agent hands back", source_message_id: await sourceByA(fx, "agent hands back") }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const task = await taskByNumber(fx.channel.id, taskNumber);

  const assign = await agentPost(app.baseUrl, fx.keyA, "tasks/assign", { channel: fx.board, task_number: taskNumber, assignee: `@${fx.agentB.name}` });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const conversationId = await waitFor("conversation", async () => (await taskRow(task.id)).conversationChannelId);
  const [assignLine] = await waitFor("assignment line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === 1 ? rows : null;
  });
  await waitFor("B woken by the assignment", async () => deliveries.some((d) => d.agentId === fx.agentB.id && d.payload.message_id === assignLine!.id));
  const followsBefore = (await followRows(conversationId)).map((row) => [row.followerType, row.followerId, row.reason]).sort();

  const unassign = await agentPost(app.baseUrl, fx.keyA, "tasks/assign", { channel: fx.board, task_number: taskNumber, assignee: null });
  assert.equal(unassign.status, 200, JSON.stringify(unassign.body));
  assert.equal(unassign.body.assignee, null);
  const lines = await waitFor("unassign line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  const line = lines[1]!;
  const actorName = fx.agentA.displayName || fx.agentA.name;
  assert.equal(line.content, `🔓 ${actorName} unassigned #${taskNumber} "agent hands back"`);
  assert.equal(line.systemSubtype, "task.lifecycle_thread");
  assert.deepEqual(await mentionRows(line.id), []);
  await settle();
  assert.equal(
    deliveries.some((d) => d.payload.message_id === line.id && d.payload.mentioned === true),
    false,
    "nobody is woken as mentioned by an unassign",
  );
  assert.equal(deliveries.some((d) => d.agentId === fx.agentA.id && d.payload.message_id === line.id), false, "the actor does not hear its own line");
  assert.equal(deliveries.some((d) => d.agentId === fx.agentC.id), false, "the bystander hears nothing");
  assert.deepEqual(
    (await followRows(conversationId)).map((row) => [row.followerType, row.followerId, row.reason]).sort(),
    followsBefore,
    "unassigning makes nobody follow",
  );
  assert.equal((await activeFollow(conversationId, "agent", fx.agentB.id))?.reason, "assigned", "the former assignee keeps following");
});

// ── F8: reassign ──

test("F8 reassign: the earlier assignee keeps following; only the new assignee is mentioned", async ({ app }) => {
  // RFC 078 does not define this case; the thread rules it writes down only
  // ever leave a follow by hand (Unfollow), so the earlier assignee keeps it.
  const fx = await setup("reassign");
  const deliveries = installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "pass it on" }]);
  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const assign = (assignee: { type: "user" | "agent"; id: string }) => fetch(`${app.baseUrl}/api/tasks/${task!.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, fx.server.id),
    body: JSON.stringify({ assignee }),
  });

  assert.equal((await assign({ type: "user", id: fx.member.id })).status, 200);
  const conversationId = await waitFor("conversation", async () => (await taskRow(task!.id)).conversationChannelId);
  await waitFor("first assignment line", async () => (await conversationLines(conversationId, LIFECYCLE)).length === 1);
  assert.equal((await assign({ type: "agent", id: fx.agentB.id })).status, 200);
  const lines = await waitFor("second assignment line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  const second = lines[1]!;
  assert.match(second.content, new RegExp(`to @${fx.agentB.name}$`));
  assert.deepEqual((await mentionRows(second.id)).map((row) => [row.targetType, row.targetId]), [["agent", fx.agentB.id]], "only the new assignee is mentioned");
  await waitFor("new assignee woken", async () => deliveries.some((d) => d.agentId === fx.agentB.id && d.payload.message_id === second.id && d.payload.mentioned === true));
  assert.equal((await activeFollow(conversationId, "agent", fx.agentB.id))?.reason, "assigned");
  assert.equal((await activeFollow(conversationId, "user", fx.member.id))?.reason, "assigned", "the earlier assignee still follows");
  assert.equal((await userFacts(second.id)).some((fact) => fact.receiverId === fx.member.id && fact.personalMention), false, "the earlier assignee is not personally notified");
});

// ── F10: every status ──

test("F10 the statuses of a task v2 task, forwards and back: one line per change, heard by the followers but never by the actor", async ({ app }) => {
  const fx = await setup("walk");
  const deliveries = installRecordingOrchestrator(app.app);
  const title = "walk the statuses";
  const source = await sourceByA(fx, title);
  const created = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title, source_message_id: source }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const task = await taskByNumber(fx.channel.id, taskNumber);
  const assign = await agentPost(app.baseUrl, fx.keyA, "tasks/assign", { channel: fx.board, task_number: taskNumber, assignee: `@${fx.agentB.name}` });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const conversationId = await waitFor("conversation", async () => (await taskRow(task.id)).conversationChannelId);
  await waitFor("assignment line", async () => (await conversationLines(conversationId, ["task.assignment_receipt"])).length === 1);
  assert.equal((await activeFollow(conversationId, "agent", fx.agentA.id))?.reason, "authored");
  assert.equal((await activeFollow(conversationId, "agent", fx.agentB.id))?.reason, "assigned");

  // The member follows the task conversation by hand (web follow bell).
  const memberToken = await login(app.baseUrl, fx.member.email);
  const follow = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST",
    headers: humanHeaders(memberToken, fx.server.id),
    body: JSON.stringify({ threadChannelId: conversationId }),
  });
  assert.equal(follow.status, 200, await follow.clone().text());

  // in_review is not used for task v2 tasks (#wg-task-v2:f7043517): asked
  // for, it stores in_progress, and the line and the response say in_progress.
  const walk: Array<[status: string, emoji: string, label: string, requested?: string]> = [
    ["in_progress", "🔄", "In Progress"],
    ["done", "✅", "Done"],
    ["in_progress", "🔄", "In Progress"], // sent back
    ["done", "✅", "Done"],
    ["closed", "🚫", "Closed"], // retroactively abandoned
    ["todo", "📝", "Todo"], // reopened
    ["in_progress", "🔄", "In Progress", "in_review"], // an older client's in_review
  ];
  for (const [index, [status, emoji, label, requested]] of walk.entries()) {
    const res = await agentPost(app.baseUrl, fx.keyB, "tasks/update-status", { channel: fx.board, task_number: taskNumber, status: requested ?? status });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.taskRef, `${fx.board}:#${taskNumber}`);
    assert.equal(res.body.status, status, "the response names the stored status");
    assert.equal((await taskRow(task.id)).status, status);
    const line = await waitFor(`status line ${index + 1}`, async () => {
      const rows = await conversationLines(conversationId, ["task.lifecycle_thread"]);
      return rows.length === index + 1 ? rows[index] : null;
    });
    // The actor by display name, as every lifecycle line names it (web, claim, assign).
    assert.equal(line.content, `${emoji} ${fx.agentB.displayName || fx.agentB.name} moved #${taskNumber} "${title}" to ${label}`);
    assert.equal(line.channelId, conversationId);
    assert.equal(line.messageType, "system");
    assert.equal(line.causalActorId, fx.agentB.id);
    assert.deepEqual(await mentionRows(line.id), [], "a status change mentions nobody");

    await waitFor(`creator woken by ${status}`, async () => deliveries.some((d) => d.agentId === fx.agentA.id && d.payload.message_id === line.id));
    await settle();
    assert.deepEqual(
      deliveries.filter((d) => d.payload.message_id === line.id).map((d) => d.agentId),
      [fx.agentA.id],
      `${status}: the following creator hears it; the acting assignee and the bystander do not`,
    );
    const facts = await waitFor(`member fact for ${status}`, async () => {
      const rows = (await userFacts(line.id)).filter((fact) => fact.unreadEligible);
      return rows.length > 0 ? rows : null;
    });
    assert.deepEqual(
      facts.map((fact) => [fact.receiverId, fact.kind, fact.personalMention]),
      [[fx.member.id, "task", false]],
      `${status}: the following person gets an ordinary task entry; the owner (not following) none`,
    );
  }
  await settle();
  assert.equal((await conversationLines(conversationId, ["task.lifecycle_thread"])).length, walk.length, "exactly one line per change");
  assert.deepEqual(
    (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, fx.channel.id))).map((row) => row.id),
    [source],
    "nothing in the channel itself but the task's source",
  );
});

// ── F11: a lazy task's first status change ──

test("F11 a task v2 task without its conversation: the first status change creates it, its creator follows (authored), the line is there", async ({ app }) => {
  const fx = await setup("lazy-status");
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "first move" }]);
  const before = await taskRow(task!.id);
  assert.equal(before.ownConversation, true);
  assert.equal(before.conversationChannelId, null, "creating the task created no conversation");

  const memberToken = await login(app.baseUrl, fx.member.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/status`, {
    method: "PATCH",
    headers: humanHeaders(memberToken, fx.server.id),
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const conversationId = await waitFor("conversation", async () => (await taskRow(task!.id)).conversationChannelId);
  const conversations = await getDb().select().from(channels).where(and(eq(channels.taskId, task!.id), eq(channels.type, "task")));
  assert.deepEqual(conversations.map((row) => row.id), [conversationId], "exactly one conversation");
  assert.equal((await activeFollow(conversationId, "user", fx.owner.id))?.reason, "authored", "its creator follows from its creation");
  const [line] = await waitFor("status line", async () => {
    const rows = await conversationLines(conversationId, ["task.lifecycle_thread"]);
    return rows.length > 0 ? rows : null;
  });
  assert.equal(line!.content, `🔄 ${fx.member.displayName} moved #${task!.taskNumber} "first move" to In Progress`);
  const facts = await waitFor("creator entry", async () => {
    const rows = (await userFacts(line!.id)).filter((fact) => fact.receiverId === fx.owner.id);
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention, fact.unreadEligible]), [["task", false, true]], "the creator hears it as a follower");
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id)), [], "nothing in the channel itself");
});

// ── F15: unclaim ──

test("F15 agent raft task unclaim (v2): one line in the task conversation, no mention, the follow is kept", async ({ app }) => {
  const fx = await setup("unclaim-agent");
  const deliveries = installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "put it down" }]);
  const claim = await agentPost(app.baseUrl, fx.keyB, "tasks/claim", { channel: fx.board, task_numbers: [task!.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  const conversationId = (await taskRow(task!.id)).conversationChannelId!;
  assert.ok(conversationId, "the claim created the conversation");
  assert.equal((await activeFollow(conversationId, "agent", fx.agentB.id))?.reason, "assigned");
  const linesBefore = (await conversationLines(conversationId, LIFECYCLE)).length;

  const unclaim = await agentPost(app.baseUrl, fx.keyB, "tasks/unclaim", { channel: fx.board, task_number: task!.taskNumber });
  assert.equal(unclaim.status, 200, JSON.stringify(unclaim.body));
  assert.equal(unclaim.body.taskRef, `${fx.board}:#${task!.taskNumber}`);
  assert.equal((await taskRow(task!.id)).claimedById, null);
  // Parity with the web unclaim: one "🔓 … released" line.
  const lines = await waitFor("unclaim line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === linesBefore + 1 ? rows : null;
  });
  const line = lines[lines.length - 1]!;
  assert.match(line.content, new RegExp(`^🔓 .+ (released|unassigned) #${task!.taskNumber} "put it down"$`));
  assert.deepEqual(await mentionRows(line.id), []);
  await settle();
  assert.equal(deliveries.some((d) => d.payload.message_id === line.id && d.payload.mentioned === true), false);
  assert.equal((await activeFollow(conversationId, "agent", fx.agentB.id))?.reason, "assigned", "unclaiming keeps the follow");
});

test("F15 web unclaim (v2): one 🔓 released line in the task conversation, no mention, the follow is kept", async ({ app }) => {
  const fx = await setup("unclaim-web");
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "web puts it down" }]);
  const memberToken = await login(app.baseUrl, fx.member.email);
  const claim = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/claim`, { method: "PATCH", headers: humanHeaders(memberToken, fx.server.id) });
  assert.equal(claim.status, 200, await claim.clone().text());
  const conversationId = await waitFor("conversation", async () => (await taskRow(task!.id)).conversationChannelId);
  await waitFor("claimer follow", async () => activeFollow(conversationId, "user", fx.member.id));

  const unclaim = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/unclaim`, { method: "PATCH", headers: humanHeaders(memberToken, fx.server.id) });
  assert.equal(unclaim.status, 200, await unclaim.clone().text());
  const expected = `🔓 ${fx.member.displayName} released #${task!.taskNumber} "web puts it down"`;
  const line = await waitFor("released line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.find((row) => row.content === expected) ?? null;
  });
  assert.equal(line.channelId, conversationId);
  assert.deepEqual(await mentionRows(line.id), []);
  await settle();
  assert.equal((await conversationLines(conversationId, LIFECYCLE)).filter((row) => row.content === expected).length, 1, "one line");
  assert.equal((await userFacts(line.id)).some((fact) => fact.personalMention), false);
  assert.equal((await activeFollow(conversationId, "user", fx.member.id))?.reason, "assigned", "unclaiming keeps the follow");
});

// ── claim: one line per change, worded as every other path words it ──

test("claim (agent, by number) of a task already assigned to the claimer: the status line, as raft task update writes it", async ({ app }) => {
  const fx = await setup("claim-assigned");
  installRecordingOrchestrator(app.app);
  const title = "埋点";
  const created = await agentPost(app.baseUrl, fx.keyA, "tasks", { channel: fx.board, tasks: [{ title, source_message_id: await sourceByA(fx, title) }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const task = await taskByNumber(fx.channel.id, taskNumber);
  const assign = await agentPost(app.baseUrl, fx.keyA, "tasks/assign", { channel: fx.board, task_number: taskNumber, assignee: `@${fx.agentB.name}` });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const conversationId = await waitFor("conversation", async () => (await taskRow(task.id)).conversationChannelId);
  await waitFor("assignment line", async () => (await conversationLines(conversationId, LIFECYCLE)).length === 1);

  const claim = await agentPost(app.baseUrl, fx.keyB, "tasks/claim", { channel: fx.board, task_numbers: [taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  assert.equal((await taskRow(task.id)).status, "in_progress");
  const lines = await waitFor("claim line", async () => {
    const rows = await conversationLines(conversationId, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  const actorName = fx.agentB.displayName || fx.agentB.name;
  assert.equal(lines[1]!.content, `🔄 ${actorName} moved #${taskNumber} "${title}" to In Progress`);
  assert.equal(lines[1]!.systemSubtype, "task.lifecycle_thread");
  assert.equal(lines[1]!.causalActorId, fx.agentB.id);
  assert.deepEqual(await mentionRows(lines[1]!.id), []);
  await settle();
  assert.equal((await conversationLines(conversationId, LIFECYCLE)).length, 2, "the task was already the claimer's: no took line");
});

test("claim of an untaken Todo task (agent and web): the took line, then the status line; each actor by display name", async ({ app }) => {
  const fx = await setup("claim-untaken");
  installRecordingOrchestrator(app.app);
  const { tasks: [agentTask, webTask] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "agent takes it" }, { title: "web takes it" }]);

  const claim = await agentPost(app.baseUrl, fx.keyB, "tasks/claim", { channel: fx.board, task_numbers: [agentTask!.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const agentConversation = await waitFor("agent task conversation", async () => (await taskRow(agentTask!.id)).conversationChannelId);
  const agentName = fx.agentB.displayName || fx.agentB.name;
  const agentLines = await waitFor("agent claim lines", async () => {
    const rows = await conversationLines(agentConversation, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  assert.deepEqual(agentLines.map((row) => row.content), [
    `📌 ${agentName} took #${agentTask!.taskNumber} "agent takes it"`,
    `🔄 ${agentName} moved #${agentTask!.taskNumber} "agent takes it" to In Progress`,
  ]);
  assert.equal((await activeFollow(agentConversation, "agent", fx.agentB.id))?.reason, "assigned");

  const memberToken = await login(app.baseUrl, fx.member.email);
  const webClaim = await fetch(`${app.baseUrl}/api/tasks/${webTask!.id}/claim`, { method: "PATCH", headers: humanHeaders(memberToken, fx.server.id) });
  assert.equal(webClaim.status, 200, await webClaim.clone().text());
  const webConversation = await waitFor("web task conversation", async () => (await taskRow(webTask!.id)).conversationChannelId);
  const webLines = await waitFor("web claim lines", async () => {
    const rows = await conversationLines(webConversation, LIFECYCLE);
    return rows.length === 2 ? rows : null;
  });
  assert.deepEqual(webLines.map((row) => row.content), [
    `📌 ${fx.member.displayName} took #${webTask!.taskNumber} "web takes it"`,
    `🔄 ${fx.member.displayName} moved #${webTask!.taskNumber} "web takes it" to In Progress`,
  ]);
  for (const row of [...agentLines, ...webLines]) assert.deepEqual(await mentionRows(row.id), [], "a claim mentions nobody");
  assert.equal((await activeFollow(webConversation, "user", fx.member.id))?.reason, "assigned");
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id)), [], "nothing in the channel itself");
});
