import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gap C4 — a task in a DM, end to end on the server. The
 * task ref of a DM board is `dm:@peer:#7` (RFC 078 "Task reference"), and the
 * conversation follows the thread rules exactly as on a channel:
 *  1. the person creates a task in their DM with an agent and assigns it to
 *     the agent → nothing is posted in the DM; the assignment line creates the
 *     task conversation (person `authored`, agent `assigned`) and wakes the
 *     agent once, mentioned, at `dm:@person:#7`;
 *  2. the agent replies with `raft task reply` at that ref → the person gets a
 *     task entry (kind `task`);
 *  3. the person replies from the web → the agent is woken at the same ref;
 *  4. `raft task view` / `raft task read` name the DM ref.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { formatAgentMessageTarget, parseAgentTaskRef } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channels, inboxNotificationFacts, messages, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { findOrCreateDM } from "../services/channelService";
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
    name: `gaps-dm-${randomUUID().slice(0, 6)}`,
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

async function followReason(conversationId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row && !row.unfollowedAt ? row.reason : null;
}

test("C4 a task in a DM: assignment, agent reply and web reply follow the thread rules at dm:@peer:#N", async ({ app }) => {
  const db = getDb();
  const person = await seedUser("dm-person");
  const server = await createServer("DM tasks", `dm-tasks-${randomUUID()}`, person.id);
  const agent = await createAgent(server.id, `dm-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const bystander = await createAgent(server.id, `dm-bystander-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await enableTaskV2ConversationsForServer(server.id);
  const dm = await findOrCreateDM(server.id, person.id, agent.id);
  assert.ok(dm, "the DM exists");
  const deliveries = installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const personToken = await login(app.baseUrl, person.email);
  const woken = async (messageId: string, expected: string[]) => {
    await waitFor(`wake for ${messageId}`, async () => expected.every((id) => deliveries.some((d) => d.agentId === id && d.payload.message_id === messageId)));
    await settle();
    return deliveries.filter((d) => d.payload.message_id === messageId);
  };

  // 1. The person creates a task in the DM and hands it to the agent.
  const { tasks: [created] } = await taskService.createTasks(dm!.id, "user", person.id, [{ title: "book the venue" }]);
  const [task] = await db.select().from(tasks).where(eq(tasks.id, created!.id));
  assert.equal(task!.channelId, dm!.id);
  assert.equal(task!.messageId, null, "no host message in the DM");
  assert.equal(task!.ownConversation, true);
  const assign = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(personToken, server.id),
    body: JSON.stringify({ assignee: { type: "agent", id: agent.id } }),
  });
  assert.equal(assign.status, 200, await assign.clone().text());
  const conversationId = await waitFor("conversation", async () => {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    return row?.conversationChannelId ?? null;
  });
  const [conversation] = await db.select().from(channels).where(eq(channels.id, conversationId));
  assert.equal(conversation!.type, "task");
  assert.equal(conversation!.parentChannelId, dm!.id, "the task conversation hangs off the DM");
  assert.equal(await followReason(conversationId, "user", person.id), "authored");
  assert.equal(await followReason(conversationId, "agent", agent.id), "assigned");
  const [notice] = await waitFor("assignment line", async () => {
    const rows = await db.select().from(messages).where(and(eq(messages.channelId, conversationId), eq(messages.systemSubtype, "task.assignment_receipt")));
    return rows.length > 0 ? rows : null;
  });
  const toNotice = await woken(notice!.id, [agent.id]);
  assert.deepEqual(toNotice.map((d) => d.agentId), [agent.id], "only the assignee hears the assignment");
  assert.equal(toNotice[0]!.payload.mentioned, true);
  const ref = formatAgentMessageTarget(toNotice[0]!.payload);
  assert.equal(ref, `dm:@${person.name}:#${task!.taskNumber}`, "a DM task reaches the agent by its DM task ref");
  assert.deepEqual(await db.select().from(messages).where(eq(messages.channelId, dm!.id)), [], "nothing is posted in the DM itself");

  // 2. The agent replies at that ref → the person (creator, following) gets a task entry.
  const parsed = parseAgentTaskRef(ref);
  assert.ok(parsed);
  assert.equal(parsed!.target, `dm:@${person.name}`);
  const reply = await agentPost(app.baseUrl, key, "tasks/reply", { channel: parsed!.target, task_number: parsed!.taskNumber, content: "the hall on 5th is free" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.state, "sent", JSON.stringify(reply.body));
  const [stored] = await db.select().from(messages).where(eq(messages.id, reply.body.messageId));
  assert.equal(stored!.channelId, conversationId, "the reply is stored in the task conversation, not the DM");
  const facts = await waitFor("person entry", async () => {
    const rows = await db.select().from(inboxNotificationFacts).where(and(
      eq(inboxNotificationFacts.messageId, reply.body.messageId),
      eq(inboxNotificationFacts.receiverType, "user"),
      eq(inboxNotificationFacts.receiverId, person.id),
    ));
    return rows.length > 0 ? rows : null;
  });
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.sourceChannelId, fact.unreadEligible]), [["task", conversationId, true]]);

  // 3. The person replies from the web → the agent is woken at the same ref.
  const web = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(personToken, server.id),
    body: JSON.stringify({ channelId: conversationId, content: "book it" }),
  });
  assert.equal(web.status, 200, await web.clone().text());
  const { id: humanReply } = await web.json() as { id: string };
  const toHuman = await woken(humanReply, [agent.id]);
  assert.deepEqual(toHuman.map((d) => d.agentId), [agent.id]);
  assert.equal(formatAgentMessageTarget(toHuman[0]!.payload), ref);

  // 4. View and read name the DM ref and show the discussion.
  const board = encodeURIComponent(parsed!.target);
  const view = await agentGet(app.baseUrl, key, `tasks/view?channel=${board}&task_number=${parsed!.taskNumber}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.taskRef, ref);
  assert.deepEqual([view.body.following, view.body.followReason], [true, "assigned"]);
  assert.equal(view.body.conversation.exists, true);
  const read = await agentGet(app.baseUrl, key, `tasks/read?channel=${board}&task_number=${parsed!.taskNumber}&after=0&limit=50`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.target, ref);
  const contents = (read.body.messages as Array<{ content: string }>).map((m) => m.content);
  for (const content of ["the hall on 5th is free", "book it"]) assert.ok(contents.some((c) => c.includes(content)), `read shows "${content}"`);

  assert.equal(deliveries.some((d) => d.agentId === bystander.id), false, "an agent outside the DM hears nothing");
  assert.deepEqual(await db.select().from(messages).where(eq(messages.channelId, dm!.id)), [], "the DM itself stays empty");
});
