import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 (flag on): "assignment reaches the assignee, the same for people and
 * agents, and makes them follow" (decided 2026-10-21, reply-design §9.1).
 *
 * Every path that hands a task to someone other than the actor posts ONE
 * lifecycle line into the task conversation (channels.type = 'task') that
 * mentions the new assignee: a person gets a personal-mention inbox entry, an
 * agent is woken with `mentioned: true` — and the assignee follows the
 * conversation (reason `assigned`). Self-assignment / claim notifies nobody.
 * Flag off: the pre-v2 line in the host message's thread, exactly as before.
 * Also pins the v2 claim-by-message rules (one task / several tasks / none).
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
  taskEvents,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import * as messageService from "../services/messageService";
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

/** Owner (task creator) + member + two agents in one public channel, one task (v2 unless `taskV2: false`). */
async function setup(slug: string, opts: { taskV2?: boolean } = {}) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Notice ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const helper = await createAgent(server.id, `${slug}-helper-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  await addAgent(channel.id, helper.id);
  // task_v2_conversations_v0 is default off: the task's discussion is then
  // the thread of its visible host message (pre-v2); on, its own conversation.
  if (opts.taskV2 !== false) await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} task` }],
  );
  return { owner, member, agent, helper, server, channel, task: task!, host: host ?? null };
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks"],
    name: `notice-${randomUUID().slice(0, 6)}`,
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

/** The task's conversation (v2) or its host message's thread (flag off). */
async function discussionId(task: { id: string }) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  if (row?.conversationChannelId) return row.conversationChannelId;
  if (!row?.messageId) return null;
  const [thread] = await getDb().select({ id: channels.id }).from(channels).where(and(
    eq(channels.parentMessageId, row.messageId),
    eq(channels.type, "thread"),
  ));
  return thread?.id ?? null;
}

async function lifecycleNotices(task: { id: string }) {
  const id = await discussionId(task);
  if (!id) return [];
  return getDb().select().from(messages).where(and(
    eq(messages.channelId, id),
    inArray(messages.systemSubtype, ["task.lifecycle_thread", "task.assignment_receipt"]),
  ));
}

async function followRows(task: { id: string }, followerType: "user" | "agent", followerId: string) {
  const id = await discussionId(task);
  if (!id) return [];
  return getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, id),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
}

async function mentionRows(messageId: string) {
  return getDb().select().from(messageMentions).where(eq(messageMentions.messageId, messageId));
}

test("web assign to a person (v2): one mentioning line in the task conversation, an inbox entry, the assignee follows", async ({ app }) => {
  const { owner, member, server, channel, task, host } = await setup("wah-on");
  assert.equal(host, null, "a task v2 task has no host message");
  assert.deepEqual(await messageService.listMessages(channel.id, 50), [], "creating it posted nothing in the channel");
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const [notice] = await waitFor("assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.match(notice!.content, new RegExp(`assigned #${task.taskNumber} ".*" to @${member.name}$`));
  // Its own subtype, so the notification pipeline classifies it as an assignment.
  assert.equal(notice!.systemSubtype, "task.assignment_receipt");
  const [assignedRow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.ok(assignedRow!.conversationChannelId, "the assignment line created the task's conversation (lazy)");
  assert.equal(notice!.channelId, assignedRow!.conversationChannelId, "the line lives in the task conversation, not the channel");

  const mentions = await mentionRows(notice!.id);
  assert.deepEqual(mentions.map((row) => [row.targetType, row.targetId]), [["user", member.id]]);
  assert.ok(mentions[0]!.notifiedAt, "the mention is delivered (notified) at send");
  const facts = await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, notice!.id),
    eq(inboxNotificationFacts.receiverType, "user"),
    eq(inboxNotificationFacts.receiverId, member.id),
  ));
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention]), [["task", true]]);
  assert.deepEqual((await followRows(task, "user", member.id)).map((row) => row.reason), ["assigned"], "being assigned follows");

  // A no-op re-assign announces nothing — the assignee hears about it once.
  const again = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(again.status, 200);
  await settle();
  assert.equal((await lifecycleNotices(task)).length, 1);
});

test("web assign on a v2 task without a conversation yet: the line creates it; creator `authored`, assignee `assigned`, one mention", async ({ app }) => {
  const { owner, member, server, task } = await setup("wah-lazy");
  const [before] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(before!.conversationChannelId, null, "creating the task created no conversation");
  assert.equal(before!.ownConversation, true);
  assert.deepEqual(await getDb().select().from(channels).where(eq(channels.taskId, task.id)), []);
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const [notice] = await waitFor("assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  const [after] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.ok(after!.conversationChannelId);
  assert.equal(notice!.channelId, after!.conversationChannelId);
  const conversations = await getDb().select().from(channels).where(and(eq(channels.taskId, task.id), eq(channels.type, "task")));
  assert.equal(conversations.length, 1, "exactly one conversation");

  const follows = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, after!.conversationChannelId!));
  assert.deepEqual(
    follows.map((row) => [row.followerType, row.followerId, row.reason, row.parentTaskId]).sort(),
    [["user", owner.id, "authored", task.id], ["user", member.id, "assigned", task.id]].sort(),
    "one row each: the creator from creation, the assignee from creation (the attention follow adds nothing)",
  );
  const mentions = await mentionRows(notice!.id);
  assert.deepEqual(mentions.map((row) => [row.targetType, row.targetId]), [["user", member.id]]);
  const facts = await getDb().select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, notice!.id),
    eq(inboxNotificationFacts.receiverType, "user"),
    eq(inboxNotificationFacts.receiverId, member.id),
  ));
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention]), [["task", true]], "notified once");
  await settle();
  assert.equal((await lifecycleNotices(task)).length, 1);
});

test("web assign to a person, flag off: the pre-v2 line in the host message thread — no mention, no follow", async ({ app }) => {
  const { owner, member, server, task, host } = await setup("wah-off", { taskV2: false });
  assert.equal(host!.messageType, "chat");
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const [notice] = await waitFor("assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.equal(notice!.content.endsWith(`to ${member.displayName}`), true, notice!.content);
  assert.equal(notice!.systemSubtype, "task.lifecycle_thread");
  assert.deepEqual(await mentionRows(notice!.id), []);
  assert.deepEqual(await followRows(task, "user", member.id), []);
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(row!.conversationChannelId, null);
});

test("web assign to an agent: the agent is woken once with mentioned:true and follows", async ({ app }) => {
  const { owner, agent, helper, server, task } = await setup("web-assign-agent");
  const deliveries = installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "agent", id: agent.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const [notice] = await waitFor("assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.match(notice!.content, new RegExp(`to @${agent.name}$`));
  const wake = await waitFor("agent wake", async () => deliveries.filter((d) => d.payload.message_id === notice!.id).length > 0
    ? deliveries.filter((d) => d.payload.message_id === notice!.id)
    : null);
  await settle();
  const toNotice = deliveries.filter((d) => d.payload.message_id === notice!.id);
  assert.deepEqual(toNotice.map((d) => d.agentId), [agent.id], "only the assignee is woken, exactly once");
  assert.equal(wake[0]!.payload.mentioned, true);
  assert.equal(toNotice.some((d) => d.agentId === helper.id), false, "a non-following channel agent is not woken");
  assert.deepEqual((await followRows(task, "agent", agent.id)).map((row) => row.reason), ["assigned"], "being assigned follows");
  assert.deepEqual((await mentionRows(notice!.id)).map((row) => [row.targetType, row.targetId]), [["agent", agent.id]]);
});

test("agent assign: a person gets the mention, another agent is woken; both follow", async ({ app }) => {
  const { member, agent, helper, task, channel } = await setup("agent-assign");
  const deliveries = installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);

  const toHuman = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`,
  });
  assert.equal(toHuman.status, 200, JSON.stringify(toHuman.body));
  const [humanNotice] = await waitFor("human assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.match(humanNotice!.content, new RegExp(`to @${member.name}$`));
  const humanMentions = await mentionRows(humanNotice!.id);
  assert.deepEqual(humanMentions.map((row) => [row.targetType, row.targetId]), [["user", member.id]]);
  assert.ok(humanMentions[0]!.notifiedAt);
  assert.deepEqual((await followRows(task, "user", member.id)).map((row) => row.reason), ["assigned"]);

  const toAgent = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${helper.name}`,
  });
  assert.equal(toAgent.status, 200, JSON.stringify(toAgent.body));
  const agentNotice = await waitFor("agent assignment notice", async () => {
    const rows = await lifecycleNotices(task);
    return rows.find((row) => row.content.endsWith(`@${helper.name}`)) ?? null;
  });
  await waitFor("helper wake", async () => deliveries.some((d) => d.payload.message_id === agentNotice.id));
  await settle();
  const toNotice = deliveries.filter((d) => d.payload.message_id === agentNotice.id);
  assert.deepEqual(toNotice.map((d) => d.agentId), [helper.id], "the new assignee is woken exactly once; the assigner is not");
  assert.equal(toNotice[0]!.payload.mentioned, true);
  assert.deepEqual((await followRows(task, "agent", helper.id)).map((row) => row.reason), ["assigned"]);
  assert.equal((await lifecycleNotices(task)).length, 2);
});

test("self-assignment and claim notify nobody", async ({ app }) => {
  const { member, agent, server, task, channel } = await setup("self-claim");
  const deliveries = installRecordingOrchestrator(app.app);
  const memberToken = await login(app.baseUrl, member.email);

  const selfAssign = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(memberToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(selfAssign.status, 200);
  const [selfNotice] = await waitFor("self-assign line", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.match(selfNotice!.content, /took #/);
  assert.deepEqual(await mentionRows(selfNotice!.id), []);

  // Agent claims a different task by number: no mention, no wake.
  const { tasks: [other] } = await taskService.createTasks(channel.id, "user", member.id, [{ title: "agent claims" }]);
  const key = await agentKey(agent.id);
  const claim = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [other!.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  await settle();
  const mentionsForAgent = await getDb().select().from(messageMentions).where(and(
    eq(messageMentions.targetType, "agent"),
    eq(messageMentions.targetId, agent.id),
  ));
  assert.deepEqual(mentionsForAgent, []);
  assert.equal(deliveries.some((d) => d.payload.mentioned === true), false);
});

test("claim by message id on a task v2 server: never executes; names the tasks by number or the create command", async ({ app }) => {
  const { owner, agent, channel } = await setup("claim-by-message");
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const claim = (messageId: string) => agentPost(app.baseUrl, key, "tasks/claim", {
    channel: `#${channel.name}`, message_ids: [messageId],
  });

  // 1. A source message carrying one task names that task: claim it by number.
  const single = await createMessage(channel.id, "user", owner.id, "one task here");
  const { tasks: [only] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "only", sourceMessageId: single.id }]);
  const bySingle = await claim(single.id);
  assert.equal(bySingle.status, 409, JSON.stringify(bySingle.body));
  assert.equal(bySingle.body.code, "task_v2_use_create");
  assert.match(bySingle.body.error, new RegExp(`raft task claim --target "#${channel.name}" --number ${only!.taskNumber}`));

  // 2. A source message with several tasks lists each claim command.
  const multi = await createMessage(channel.id, "user", owner.id, "two tasks here");
  const { tasks: pair } = await taskService.createTasks(channel.id, "user", owner.id, [
    { title: "first", sourceMessageId: multi.id },
    { title: "second", sourceMessageId: multi.id },
  ]);
  const byMulti = await claim(multi.id.slice(0, 8));
  assert.equal(byMulti.status, 409);
  for (const t of pair) assert.match(byMulti.body.error, new RegExp(`--number ${t.taskNumber}\\b`));

  // 3. A plain message with no task: the create-from-message command, taking it yourself.
  const plain = await createMessage(channel.id, "user", owner.id, "please do this");
  const byPlain = await claim(plain.id);
  assert.equal(byPlain.status, 409);
  assert.ok(byPlain.body.error.includes(
    `raft task create --target "#${channel.name}" --message-id ${plain.id.slice(0, 8)} --title "please do this" --assignee @${agent.name}`,
  ), byPlain.body.error);

  // Nothing was claimed or created.
  const rows = await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id));
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.claimedById === null), "a refused claim claims nothing");
});

test("claim by message id on a pre-v2 server: converts the message and claims it, as before", async ({ app }) => {
  const { owner, agent, channel } = await setup("cbm-off", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const plain = await createMessage(channel.id, "user", owner.id, "please do this");
  const byPlain = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, message_ids: [plain.id] });
  assert.equal(byPlain.status, 200, JSON.stringify(byPlain.body));
  assert.equal(byPlain.body.results[0].success, true);
  const [converted] = await getDb().select().from(tasks).where(eq(tasks.messageId, plain.id));
  assert.equal(converted!.claimedById, agent.id, "the message itself is the task's host");
});

test("agent hand-off with a reason: the reason ends the line, rides on the event and the line's structure", async ({ app }) => {
  const { member, agent, task, channel } = await setup("handoff-reason");
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const reason = "Your call: ship Friday or Monday?";

  const res = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason: `  ${reason}\n`,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [notice] = await waitFor("hand-off line", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.ok(notice!.content.endsWith(`to @${member.name}: ${reason}`), notice!.content);
  assert.deepEqual((await mentionRows(notice!.id)).map((row) => [row.targetType, row.targetId]), [["user", member.id]], "the notification is the line, reason included");
  const metadata = notice!.actionMetadata as Record<string, any>;
  assert.equal(metadata.kind, "task-assignment");
  assert.equal(metadata.reason, reason);
  assert.deepEqual([metadata.actor.type, metadata.actor.id], ["agent", agent.id]);
  assert.deepEqual([metadata.assignee.type, metadata.assignee.id, metadata.assignee.name], ["user", member.id, member.name]);

  const events = await getDb().select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.eventType, "assignee_changed")));
  assert.equal(events.at(-1)!.payload.reason, reason);
});

test("agent hand-off from a client that offers a reason: without one it is refused, naming --reason; taking it yourself needs none", async ({ app }) => {
  const { member, agent, task, channel } = await setup("handoff-required");
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);

  const refused = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason: "  ",
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "task_assign_reason_required");
  assert.match(refused.body.error, /needs a reason/);
  // The sentence names no command; the step is `next`, rendered by each client.
  assert.doesNotMatch(refused.body.error, /raft |--reason/);
  assert.equal(refused.body.suggestedNextAction, `raft task assign "#${channel.name}:#${task.taskNumber}" @${member.name} --reason "…"`);
  assert.deepEqual(refused.body.next.op, { name: "tasks.assign", args: { target: `#${channel.name}`, taskNumber: task.taskNumber, assignee: `@${member.name}` }, partial: true });
  const [unchanged] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(unchanged!.claimedById, null, "a refused hand-off assigns nothing");

  const self = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${agent.name}`, reason: "",
  });
  assert.equal(self.status, 200, JSON.stringify(self.body));

  const selfWithReason = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${agent.name}`, reason: "mine now",
  });
  assert.equal(selfWithReason.status, 400);
  assert.equal(selfWithReason.body.code, "task_assign_reason_invalid");
});

test("web hand-off: the reason is optional for a person and ends the line when given", async ({ app }) => {
  const { owner, member, server, task } = await setup("web-handoff-reason");
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id }, reason: "Needs your sign-off on the copy" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const [notice] = await waitFor("hand-off line", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.ok(notice!.content.endsWith(`to @${member.name}: Needs your sign-off on the copy`), notice!.content);
  assert.equal((notice!.actionMetadata as Record<string, unknown>).reason, "Needs your sign-off on the copy");

  const unassignWithReason = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: null, reason: "not needed" }),
  });
  assert.equal(unassignWithReason.status, 400);
});

test("agent re-assigning the current assignee: no reason needed; a reason is refused, pointing at a reply", async ({ app }) => {
  const { member, agent, task, channel } = await setup("handoff-unchanged");
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const first = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason: "Your call",
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const noop = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason: "",
  });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));

  const withReason = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason: "One more thing",
  });
  assert.equal(withReason.status, 409, JSON.stringify(withReason.body));
  assert.equal(withReason.body.code, "task_assign_reason_unchanged");
  assert.match(withReason.body.error, /already has that assignee/);
  assert.doesNotMatch(withReason.body.error, /raft /);
  assert.equal(withReason.body.suggestedNextAction, `raft task reply "#${channel.name}:#${task.taskNumber}"`);
  await settle();
  assert.equal((await lifecycleNotices(task)).length, 1, "only the first hand-off wrote a line");
});

test("an @handle inside a hand-off reason mentions nobody: only the assignee is a mention / notification target", async ({ app }) => {
  const { owner, member, agent, helper, task, channel } = await setup("hr-mention");
  const deliveries = installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const reason = `check with @${owner.name} and @${helper.name} first`;

  const res = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: task.taskNumber, assignee: `@${member.name}`, reason,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [notice] = await waitFor("hand-off line", async () => {
    const rows = await lifecycleNotices(task);
    return rows.length > 0 ? rows : null;
  });
  assert.ok(notice!.content.endsWith(`: ${reason}`), notice!.content);
  await settle();

  // Mention rows: the assignee only.
  assert.deepEqual((await mentionRows(notice!.id)).map((row) => [row.targetType, row.targetId]), [["user", member.id]]);
  // Inbox facts: whoever else gets the line (the creator follows the task) gets no personal mention.
  const facts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, notice!.id));
  assert.deepEqual(
    facts.filter((fact) => fact.personalMention).map((fact) => [fact.receiverType, fact.receiverId]),
    [["user", member.id]],
  );
  assert.equal(facts.some((fact) => fact.receiverType === "user" && fact.receiverId === owner.id && fact.personalMention), false);
  // The agent named in the reason is not woken as mentioned (nor at all: it doesn't follow the task).
  assert.equal(deliveries.some((d) => d.agentId === helper.id && d.payload.message_id === notice!.id), false);
  assert.equal(deliveries.some((d) => d.payload.message_id === notice!.id && d.payload.mentioned === true && d.agentId !== member.id), false);
});
