import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
/**
 * Task v2, deleting a task (W6, decided 2026-10-21): deleting a v2 task
 * deletes its conversation with it. Like a deleted channel, the conversation
 * is soft-deleted and detached from the task (`deleted_at`, `task_id` NULL) in
 * the delete transaction, so messages that external bridges reference
 * (ON DELETE RESTRICT) cannot fail the delete: its follows go, the followed /
 * Done / Activity listings and search drop it, the conversation reads as not
 * found, and realtime clients get `task:deleted` naming the conversation they
 * lose. Creating a v2 task posted nothing in the channel, so
 * deleting it posts no "🗑 deleted #N" line there either. A task from before
 * task v2 keeps the staging behavior (the line in the channel).
 *
 * A task number is never reused in a channel: a v2 task has no host message
 * to keep its number, so the channel's high-water mark does
 * (`channels.task_number_high_water`); deleting the newest task leaves a gap.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, externalMessageLinks, featureFlagRules, inboxNotificationFacts, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
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
    name: `delete-${randomUUID().slice(0, 6)}`,
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

type EmittedEvent = { rooms: string[]; event: string; payload: any };

/** Records socket emits (task:deleted) for the requests that follow. */
function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  type Audience = { to(room: string): Audience; emit(event: string, payload: unknown): void };
  const audience = (rooms: string[]): Audience => ({
    to: (room: string) => audience([...rooms, room]),
    emit: (event: string, payload: unknown) => { events.push({ rooms, event, payload }); },
  });
  app.set("io", { to: (room: string) => audience([room]) });
  return events;
}

async function seeded(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Delete ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-room`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-a-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  return { owner, member, server, channel, agent, key: await agentKey(agent.id), board: `#${channel.name}` };
}

/** A v2 task with a conversation the owner and the member follow, a reply from each and the member's inbox facts. */
async function v2TaskWithDiscussion(app: { baseUrl: string }, fx: Awaited<ReturnType<typeof seeded>>, word: string, createdBy: { type: "user" | "agent"; id: string }) {
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, createdBy.type, createdBy.id, [{ title: `${word} task` }], { initiatingServerId: fx.server.id });
  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const memberToken = await login(app.baseUrl, fx.member.email);
  const opened = await fetch(`${app.baseUrl}/api/tasks/${task!.id}/conversation`, { method: "POST", headers: humanHeaders(memberToken, fx.server.id) });
  assert.equal(opened.status, 200, await opened.clone().text());
  const { conversationChannelId } = await opened.json() as { conversationChannelId: string };
  for (const [token, content] of [[memberToken, `${word} from the member`], [ownerToken, `${word} from the owner`]] as const) {
    const res = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST", headers: humanHeaders(token, fx.server.id), body: JSON.stringify({ channelId: conversationChannelId, content }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  }
  await waitFor("follows and facts", async () => {
    const follows = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationChannelId));
    const facts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.sourceChannelId, conversationChannelId));
    return follows.length >= 2 && facts.length >= 1;
  });
  return { task: task!, conversationChannelId, ownerToken, memberToken };
}

/** An external bridge (e.g. Slack) row on a conversation message: ON DELETE RESTRICT on messages. */
async function bridgeMessage(messageId: string, key: string) {
  const [link] = await getDb().insert(externalMessageLinks).values({
    provider: "slack",
    installId: `install-${key}`,
    providerAuthorityId: `workspace-${key}`,
    providerConversationId: `conversation-${key}`,
    providerMessageId: `message-${key}`,
    bindingId: `binding-${key}`,
    bindingEpoch: 1,
    connectionEpoch: 1,
    raftMessageId: messageId,
    firstDirection: "raft_outbound",
    payloadFingerprint: "d".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  }).returning();
  return link!;
}

async function assertConversationGone(app: { baseUrl: string }, fx: Awaited<ReturnType<typeof seeded>>, taskId: string, conversationChannelId: string, word: string, token: string) {
  const db = getDb();
  assert.deepEqual(await db.select().from(tasks).where(eq(tasks.id, taskId)), []);
  assert.deepEqual(await db.select().from(channels).where(eq(channels.taskId, taskId)), [], "no face (canonical or joint) still names the task");
  const [conversation] = await db.select().from(channels).where(eq(channels.id, conversationChannelId));
  assert.ok(conversation, "the conversation row stays, soft-deleted, so bridged messages keep their row");
  assert.equal(conversation.type, "task");
  assert.equal(conversation.taskId, null, "detached from the deleted task");
  assert.ok(conversation.deletedAt !== null, "soft-deleted, like a deleted channel");
  assert.deepEqual(await db.select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationChannelId)), [], "its follows are deleted");

  const opened = await fetch(`${app.baseUrl}/api/channels/${conversationChannelId}`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(opened.status, 404, "the conversation reads as not found");

  const followed = await fetch(`${app.baseUrl}/api/channels/threads/followed`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(followed.status, 200);
  assert.equal(((await followed.json()) as { threads: any[] }).threads.some((row) => row.threadChannelId === conversationChannelId), false, "gone from the followed list");
  const done = await fetch(`${app.baseUrl}/api/channels/inbox/done?limit=50`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { items: any[] }).items.some((row) => row.threadChannelId === conversationChannelId), false, "gone from the Done history");
  const inbox = await fetch(`${app.baseUrl}/api/channels/inbox?filter=all&limit=50&includeUnfollowedThreads=true`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(inbox.status, 200);
  assert.equal(((await inbox.json()) as { items: any[] }).items.some((row) => row.threadChannelId === conversationChannelId), false, "gone from Activity");
  const search = await fetch(`${app.baseUrl}/api/messages/search?q=${encodeURIComponent(word)}`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(search.status, 200);
  assert.equal(JSON.stringify(await search.json()).includes(`${word} from the member`), false, "gone from search");
}

test("web delete of a v2 task: its conversation goes with it, clients are told, and the channel gets no deleted line", async ({ app }) => {
  const fx = await seeded("del-web");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { task, conversationChannelId, ownerToken } = await v2TaskWithDiscussion(app, fx, "zebrafish", { type: "user", id: fx.owner.id });
  const channelBefore = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, fx.channel.id));

  const events = installFakeIo(app.app);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}`, { method: "DELETE", headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());

  const deleted = events.filter((event) => event.event === "task:deleted");
  assert.deepEqual(deleted.map((event) => event.payload), [{ channelId: fx.channel.id, taskId: task.id, conversationChannelId }], "task:deleted names the conversation the surface loses");
  await settle();
  const channelAfter = await getDb().select({ id: messages.id, content: messages.content }).from(messages).where(eq(messages.channelId, fx.channel.id));
  assert.equal(channelAfter.length, channelBefore.length, "no 🗑 deleted line: creating it posted nothing in the channel");
  await assertConversationGone(app, fx, task.id, conversationChannelId, "zebrafish", ownerToken);
});

test("agent delete of a v2 task: the conversation goes with it, no deleted line, the response names the ref", async ({ app }) => {
  const fx = await seeded("del-agent");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { task, conversationChannelId, ownerToken } = await v2TaskWithDiscussion(app, fx, "okapi", { type: "agent", id: fx.agent.id });
  const events = installFakeIo(app.app);

  const res = await agentPost(app.baseUrl, fx.key, "tasks/delete", { channel: fx.board, task_number: task.taskNumber });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.taskRef, `${fx.board}:#${task.taskNumber}`);
  assert.deepEqual(events.filter((event) => event.event === "task:deleted").map((event) => event.payload.conversationChannelId), [conversationChannelId]);
  await settle();
  assert.equal((await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id))).some((row) => row.content.includes("deleted #")), false);
  await assertConversationGone(app, fx, task.id, conversationChannelId, "okapi", ownerToken);
});

test("deleting a v2 task whose conversation was bridged externally cannot fail: the bridged message keeps its row", async ({ app }) => {
  const fx = await seeded("del-bridged");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { task, conversationChannelId, ownerToken } = await v2TaskWithDiscussion(app, fx, "narwhal", { type: "user", id: fx.owner.id });
  const [reply] = await getDb().select().from(messages).where(eq(messages.channelId, conversationChannelId)).limit(1);
  assert.ok(reply, "the conversation has a reply to bridge");
  const link = await bridgeMessage(reply.id, `del-bridged-${randomUUID().slice(0, 8)}`);

  const events = installFakeIo(app.app);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}`, { method: "DELETE", headers: humanHeaders(ownerToken, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(events.filter((event) => event.event === "task:deleted").map((event) => event.payload), [{ channelId: fx.channel.id, taskId: task.id, conversationChannelId }]);

  const [kept] = await getDb().select().from(messages).where(eq(messages.id, reply.id));
  assert.ok(kept, "the bridged message is not hard-deleted");
  const [keptLink] = await getDb().select().from(externalMessageLinks).where(eq(externalMessageLinks.id, link.id));
  assert.ok(keptLink, "the bridge row is untouched");
  await assertConversationGone(app, fx, task.id, conversationChannelId, "narwhal", ownerToken);
});

test("deleting a v2 task without a conversation yet: no deleted line, task:deleted without a conversation", async ({ app }) => {
  const fx = await seeded("del-lazy");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { tasks: [task] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "never discussed" }], { initiatingServerId: fx.server.id });
  const token = await login(app.baseUrl, fx.owner.email);
  const events = installFakeIo(app.app);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task!.id}`, { method: "DELETE", headers: humanHeaders(token, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(events.filter((event) => event.event === "task:deleted").map((event) => event.payload), [{ channelId: fx.channel.id, taskId: task!.id }]);
  await settle();
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id)), []);
});

test("deleting a pre-v2 task keeps the staging behavior: the 🗑 deleted line in the channel, the host message stays", async ({ app }) => {
  const fx = await seeded("del-legacy");
  installRecordingOrchestrator(app.app);
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "old style" }]);
  const token = await login(app.baseUrl, fx.owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task!.id}`, { method: "DELETE", headers: humanHeaders(token, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  const line = await waitFor("deleted line", async () => {
    const rows = await getDb().select().from(messages).where(and(eq(messages.channelId, fx.channel.id), eq(messages.systemSubtype, "task.deleted_summary")));
    return rows[0] ?? null;
  });
  assert.match(line.content, new RegExp(`^🗑 .+ deleted #${task!.taskNumber} "old style"$`));
  assert.equal((await getDb().select().from(messages).where(inArray(messages.id, [host!.id]))).length, 1, "the host message stays");
});

async function deleteTaskAsOwner(app: { baseUrl: string }, fx: Awaited<ReturnType<typeof seeded>>, taskId: string) {
  const token = await login(app.baseUrl, fx.owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${taskId}`, { method: "DELETE", headers: humanHeaders(token, fx.server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.id, taskId)), []);
}

async function highWater(channelId: string) {
  const [row] = await getDb().select({ highWater: channels.taskNumberHighWater }).from(channels).where(eq(channels.id, channelId));
  return row!.highWater;
}

test("deleting the newest v2 task does not free its number: the next v2 task gets max + 1", async ({ app }) => {
  const fx = await seeded("del-renumber-v2");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { tasks: created } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "first" }, { title: "second" }], { initiatingServerId: fx.server.id });
  assert.deepEqual(created.map((task) => task.taskNumber), [1, 2]);
  assert.equal(await highWater(fx.channel.id), 2, "allocation records the highest number handed out");

  await deleteTaskAsOwner(app, fx, created[1]!.id);
  assert.equal(await highWater(fx.channel.id), 2, "deleting a task leaves the mark");

  const { tasks: [next] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "third" }], { initiatingServerId: fx.server.id });
  assert.equal(next!.taskNumber, 3, "#2 is not reused: an old #2 ref must not point at this task");
  assert.equal(await highWater(fx.channel.id), 3);

  // The agent path allocates the same way.
  // Assigned creation (the agent `task create --assign` path) allocates the same way.
  const { tasks: [assigned] } = await taskService.createTasksWithAssignmentReceipt(
    fx.channel.id, "agent", fx.agent.id, [{ title: "fourth" }], { type: "agent", id: fx.agent.id }, { assigneeName: fx.agent.name },
  );
  assert.equal(assigned!.taskNumber, 4);
  assert.equal(await taskService.getTaskByNumber(fx.channel.id, 2), null, "#2 stays gone rather than naming another task");
});

test("after a v2 delete, a pre-v2 task (flag off) also gets max + 1, not the deleted number", async ({ app }) => {
  const fx = await seeded("del-renumber-legacy");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { tasks: created } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "one" }, { title: "two" }, { title: "three" }], { initiatingServerId: fx.server.id });
  assert.deepEqual(created.map((task) => task.taskNumber), [1, 2, 3]);
  await deleteTaskAsOwner(app, fx, created[2]!.id);

  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY));
  const { tasks: [legacy], hostMessages: [host] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "pre-v2 style" }]);
  assert.ok(host, "flag off: the task has a visible host message");
  assert.equal(legacy!.taskNumber, 4, "#3 is not reused by a pre-v2 task either");

  // Converting a message (flag off) allocates past the mark too.
  const token = await login(app.baseUrl, fx.owner.email);
  const sent = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST", headers: humanHeaders(token, fx.server.id), body: JSON.stringify({ channelId: fx.channel.id, content: "convert me" }),
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const plain = await waitFor("the plain message", async () => {
    const [row] = await getDb().select().from(messages).where(and(eq(messages.channelId, fx.channel.id), eq(messages.content, "convert me")));
    return row ?? null;
  });
  await deleteTaskAsOwner(app, fx, legacy!.id);
  const converted = await taskService.convertMessageToTask(plain.id, "user", fx.owner.id, fx.channel.id);
  assert.ok(typeof converted !== "string", String(converted));
  assert.equal(converted.taskNumber, 5, "#4 (deleted) is not reused by a convert");
});

test("concurrent creates after a delete still get distinct numbers, all past the deleted one", async ({ app }) => {
  const fx = await seeded("del-renumber-race");
  await enableTaskV2ConversationsForServer(fx.server.id);
  installRecordingOrchestrator(app.app);
  const { tasks: created } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "a" }, { title: "b" }], { initiatingServerId: fx.server.id });
  await deleteTaskAsOwner(app, fx, created[1]!.id);

  const batches = await Promise.all([
    taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "race 1" }, { title: "race 2" }], { initiatingServerId: fx.server.id }),
    taskService.createTasks(fx.channel.id, "user", fx.member.id, [{ title: "race 3" }], { initiatingServerId: fx.server.id }),
    taskService.createTasks(fx.channel.id, "agent", fx.agent.id, [{ title: "race 4" }], { initiatingServerId: fx.server.id }),
    taskService.createTasksWithAssignmentReceipt(
      fx.channel.id, "agent", fx.agent.id, [{ title: "race 5" }], { type: "agent", id: fx.agent.id }, { assigneeName: fx.agent.name },
    ),
  ]);
  const numbers = batches.flatMap((batch) => batch.tasks.map((task) => task.taskNumber)).sort((a, b) => a - b);
  assert.deepEqual(numbers, [3, 4, 5, 6, 7], "distinct, consecutive, and none reuses the deleted #2");
  assert.equal(await highWater(fx.channel.id), 7);
});
