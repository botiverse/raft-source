import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — who an @mention or a source message reaches in a
 * task conversation (RFC 078 "Following and notifications"; coverage matrix
 * G14 and "@mention of a non-member"):
 *  - an agent's `raft task reply` that @mentions a server member outside the
 *    channel (a person and an agent) notifies neither and makes neither
 *    follow; the sender gets pending mention actions (`not_member`), exactly
 *    as for a thread; `notify` then reaches the outsider agent once, at the
 *    task ref, still without a follow;
 *  - the author of a task's source message neither follows nor hears the
 *    task conversation because of it ("Source message author: never"); its
 *    thread holds only the notice that the request was taken (#11310).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { formatAgentMessageTarget } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, messageMentions, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

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

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels", "mentions"],
    name: `gaps-mention-${randomUUID().slice(0, 6)}`,
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

async function taskByNumber(channelId: string, taskNumber: number) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
  assert.ok(row, `task #${taskNumber} exists`);
  return row!;
}

async function followsOf(followerType: "user" | "agent", followerId: string, conversationIds: string[]) {
  return getDb().select().from(threadFollows).where(and(
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
    inArray(threadFollows.threadChannelId, conversationIds),
  ));
}

test("@mention of a non-member in a task conversation: nobody outside the channel is notified or follows; the sender gets not_member actions; notify reaches the agent once", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("mention-owner");
  const outsiderPerson = await seedUser("mention-outsider");
  const server = await createServer("Mentions", `mentions-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsiderPerson.id, role: "member" });
  const channel = await createChannel(server.id, `mentions-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  const agentA = await createAgent(server.id, `mention-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const outsiderAgent = await createAgent(server.id, `mention-x-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agentA.id);
  await enableTaskV2ConversationsForServer(server.id);
  const deliveries = installRecordingOrchestrator(app.app);
  const keyA = await agentKey(agentA.id);
  const board = `#${channel.name}`;

  // A task always has a source: A's own message in the channel.
  const source = await createMessage(channel.id, "agent", agentA.id, "I'll ask around");
  const created = await agentPost(app.baseUrl, keyA, "tasks", { channel: board, tasks: [{ title: "ask around", source_message_id: source.id }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const task = await taskByNumber(channel.id, taskNumber);

  const reply = await agentPost(app.baseUrl, keyA, "tasks/reply", {
    channel: board,
    task_number: taskNumber,
    content: `@${outsiderPerson.name} @${outsiderAgent.name} do either of you know?`,
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.state, "sent", JSON.stringify(reply.body));
  const messageId = reply.body.messageId as string;
  const [stored] = await db.select().from(messages).where(eq(messages.id, messageId));
  const [conversation] = await db.select().from(tasks).where(eq(tasks.id, task.id));
  assert.equal(stored!.channelId, conversation!.conversationChannelId, "the reply is in the task conversation");
  const conversationIds = (await db.select({ id: channels.id }).from(channels).where(eq(channels.taskId, task.id))).map((row) => row.id);

  // The sender is told who did not hear it, the way a thread send does.
  const pending = reply.body.pendingMentionActions as Array<{ resolutionId: string; targetType: string; targetHandle: string; reason: string }>;
  assert.ok(Array.isArray(pending), JSON.stringify(reply.body));
  assert.deepEqual(
    pending.map((action) => [action.targetType, action.targetHandle, action.reason]).sort(),
    [["agent", outsiderAgent.name, "not_member"], ["user", outsiderPerson.name, "not_member"]].sort(),
  );
  const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, messageId));
  assert.deepEqual(
    mentionRows.map((row) => [row.targetType, row.targetId, row.notifiableAtSend]).sort(),
    [["agent", outsiderAgent.id, false], ["user", outsiderPerson.id, false]].sort(),
    "the mentions are recorded but not notifiable at send",
  );

  await settle();
  assert.deepEqual(
    await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, messageId),
      eq(inboxNotificationFacts.receiverId, outsiderPerson.id),
    )),
    [],
    "the outsider person gets no entry",
  );
  assert.equal(deliveries.some((d) => d.agentId === outsiderAgent.id), false, "the outsider agent is not woken");
  assert.deepEqual(await followsOf("user", outsiderPerson.id, conversationIds), [], "the outsider person does not follow");
  assert.deepEqual(await followsOf("agent", outsiderAgent.id, conversationIds), [], "the outsider agent does not follow");

  // The sender chooses to notify the outsider agent: one wake at the task ref, still no follow.
  const agentAction = pending.find((action) => action.targetType === "agent")!;
  const notify = await agentPost(app.baseUrl, keyA, "mention-actions/execute", { action: "notify", resolutionIds: [agentAction.resolutionId] });
  assert.equal(notify.status, 200, JSON.stringify(notify.body));
  assert.equal(notify.body.results[0].status, "queued", JSON.stringify(notify.body));
  const wake = await waitFor("outsider agent notified", async () => deliveries.find((d) => d.agentId === outsiderAgent.id && d.payload.message_id === messageId) ?? null);
  assert.equal(wake.payload.non_member_mention, true);
  assert.equal(formatAgentMessageTarget(wake.payload), `${board}:#${taskNumber}`, "the notice names the task ref");
  await settle();
  assert.equal(deliveries.filter((d) => d.agentId === outsiderAgent.id).length, 1, "once");
  assert.deepEqual(await followsOf("agent", outsiderAgent.id, conversationIds), [], "being notified is not following");
});

test("G14 the source message's author neither follows nor hears the task conversation", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("source-owner");
  const author = await seedUser("source-author");
  const server = await createServer("Source author", `source-author-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: author.id, role: "member" });
  const channel = await createChannel(server.id, `source-${randomUUID().slice(0, 6)}`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, author.id);
  const agentA = await createAgent(server.id, `source-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentB = await createAgent(server.id, `source-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const sourceAgent = await createAgent(server.id, `source-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  for (const agent of [agentA, agentB, sourceAgent]) await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);
  const deliveries = installRecordingOrchestrator(app.app);
  const keyA = await agentKey(agentA.id);
  const keyB = await agentKey(agentB.id);
  const board = `#${channel.name}`;

  const fromPerson = await createMessage(channel.id, "user", author.id, "we should redo the onboarding emails");
  const fromAgent = await createMessage(channel.id, "agent", sourceAgent.id, "and the pricing page");
  const created = await agentPost(app.baseUrl, keyA, "tasks", {
    channel: board,
    tasks: [
      { title: "redo the onboarding emails", source_message_id: fromPerson.id.slice(0, 8) },
      { title: "redo the pricing page", source_message_id: fromAgent.id },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const numbers = (created.body.tasks as Array<{ taskNumber: number }>).map((t) => t.taskNumber);
  const taskRows = await Promise.all(numbers.map((n) => taskByNumber(channel.id, n)));
  assert.deepEqual(taskRows.map((row) => row.sourceMessageId), [fromPerson.id, fromAgent.id]);

  const replies: string[] = [];
  for (const n of numbers) {
    const assign = await agentPost(app.baseUrl, keyA, "tasks/assign", { channel: board, task_number: n, assignee: `@${agentB.name}` });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    for (const [key, content] of [[keyB, "on it"], [keyA, "thanks"]] as const) {
      const res = await agentPost(app.baseUrl, key, "tasks/reply", { channel: board, task_number: n, content });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      replies.push(res.body.messageId as string);
    }
  }
  await waitFor("replies delivered", async () => replies.every((id) => deliveries.some((d) => d.payload.message_id === id)));
  await settle();

  const conversationIds = (await db.select({ id: channels.id }).from(channels).where(inArray(channels.taskId, taskRows.map((row) => row.id)))).map((row) => row.id);
  assert.equal(conversationIds.length, 2);
  assert.deepEqual(await followsOf("user", author.id, conversationIds), [], "the source author does not follow");
  assert.deepEqual(await followsOf("agent", sourceAgent.id, conversationIds), [], "the source agent does not follow");
  const conversationMessages = await db.select({ id: messages.id }).from(messages).where(inArray(messages.channelId, conversationIds));
  assert.deepEqual(
    await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.receiverId, author.id),
      inArray(inboxNotificationFacts.messageId, conversationMessages.map((row) => row.id)),
    )),
    [],
    "the source author has no entries for the task conversations",
  );
  assert.equal(
    deliveries.some((d) => d.agentId === sourceAgent.id && conversationMessages.some((row) => row.id === d.payload.message_id)),
    false,
    "the source agent is never woken by the task conversations",
  );
  // The discussion is the task's own: each source message's thread holds only
  // the one-line notice that its request was taken (#11310), nothing from the
  // task conversation.
  const sourceThreads = await db.select().from(channels).where(and(inArray(channels.parentMessageId, [fromPerson.id, fromAgent.id]), eq(channels.type, "thread")));
  assert.equal(sourceThreads.length, 2);
  const threadLines = await db.select({ content: messages.content }).from(messages).where(inArray(messages.channelId, sourceThreads.map((row) => row.id)));
  assert.equal(threadLines.length, 2, JSON.stringify(threadLines));
  assert.ok(threadLines.every((row) => row.content.startsWith("📌 ") && row.content.endsWith(" from this message")), JSON.stringify(threadLines));
});
