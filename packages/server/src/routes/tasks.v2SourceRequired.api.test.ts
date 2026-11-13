import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2: a task always has a source, the message that asked for it
 * (#wg-task-v2:#23).
 *  - an agent's create without `source_message_id` is refused
 *    (`task_source_required`, with the create left to fill as `next`) on the
 *    Agent API and the legacy agent route; flag off it still works;
 *  - a reply in one of the channel's threads stands for the thread's root
 *    (`sourceThreadReplyId` names the reply given); a message elsewhere is
 *    still no source;
 *  - a person's web create without one posts their own channel message first
 *    and hangs the tasks under it (once per `sourceRandomId`), and its thread
 *    gets the "created from this message" line like any source;
 *  - a task without a recorded source reads as such (`sourceRecorded: false`,
 *    `tasks/view` sourceMessage null).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, messageMentions, messages, serverMembers, tasks, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel, findOrCreateDM, getOrCreateThreadForChannel } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";

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

async function webCreate(baseUrl: string, token: string, serverId: string, channelId: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/tasks/channel/${channelId}`, {
    method: "POST",
    headers: humanHeaders(token, serverId),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function tasksIn(channelId: string) {
  return getDb().select().from(tasks).where(eq(tasks.channelId, channelId));
}

async function taskByNumber(channelId: string, taskNumber: number) {
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channelId), eq(tasks.taskNumber, taskNumber)));
  assert.ok(row, `task #${taskNumber} exists`);
  return row!;
}

/** The channel's ordinary (non-system) messages, oldest first. */
async function chatMessagesIn(channelId: string) {
  const rows = await getDb().select().from(messages).where(and(eq(messages.channelId, channelId), eq(messages.messageType, "chat")));
  return rows.sort((a, b) => a.seq - b.seq);
}

/** Owner + author (people) and an agent in one public channel; task v2 on unless `taskV2: false`. */
async function setup(slug: string, opts: { taskV2?: boolean } = {}) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const author = await seedUser(`${slug}-author`);
  const server = await createServer(`Source required ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: author.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, author.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  if (opts.taskV2 !== false) await enableTaskV2ConversationsForServer(server.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `source-required-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return { owner, author, server, channel, agent, key: apiKey, board: `#${channel.name}` };
}

function assertSourceRequired(answer: { status: number; body: any }, board: string) {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.code, "task_source_required");
  assert.equal(typeof answer.body.error, "string");
  assert.ok(!answer.body.error.includes("raft "), `the sentence names no command: ${answer.body.error}`);
  assert.ok(!answer.body.error.includes("--"), `the sentence names no flag: ${answer.body.error}`);
  assert.ok(Array.isArray(answer.body.next?.cli), JSON.stringify(answer.body));
  assert.ok(answer.body.next.cli.includes("--message-id"), JSON.stringify(answer.body.next));
  assert.equal(answer.body.suggestedNextAction, `raft task create --target "${board}" --message-id <id> --title "…"`);
}

// ── an agent's create without a source ──

test("agent-api create without a source on a task v2 server: 400 task_source_required, nothing created", async ({ app }) => {
  const fx = await setup("req-agent");
  installRecordingOrchestrator(app.app);

  const bare = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "no source" }] });
  assertSourceRequired(bare, fx.board);

  // One item without a source refuses the whole create.
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "please do the first thing");
  const mixed = await agentPost(app.baseUrl, fx.key, "tasks", {
    channel: fx.board,
    tasks: [{ title: "with a source", source_message_id: source.id }, { title: "without one" }],
  });
  assertSourceRequired(mixed, fx.board);

  assert.deepEqual(await tasksIn(fx.channel.id), [], "nothing was created");
});

test("legacy agent route create without a source on a task v2 server: 400 task_source_required, nothing created", async ({ app }) => {
  const fx = await setup("req-legacy");
  installRecordingOrchestrator(app.app);
  const { machine, apiKey: machineKey } = await registerMachine(fx.server.id, fx.owner.id, `req-legacy-${randomUUID().slice(0, 6)}`);
  await placeAgentOnMachine(fx.agent.id, machine.id);

  const res = await fetch(`${app.baseUrl}/internal/agent/${fx.agent.id}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${machineKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: fx.board, tasks: [{ title: "legacy, no source" }] }),
  });
  assertSourceRequired({ status: res.status, body: await res.json() }, fx.board);
  assert.deepEqual(await tasksIn(fx.channel.id), [], "nothing was created");
});

test("flag off: an agent's create without a source still works", async ({ app }) => {
  const fx = await setup("req-off", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "pre-v2 task" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const row = await taskByNumber(fx.channel.id, created.body.tasks[0].taskNumber);
  assert.equal(row.ownConversation, false, "a pre-v2 task");
  assert.ok(row.messageId, "posted as its host message, as before");
});

// ── a thread reply as the source ──

test("agent-api create from a reply in one of the channel's threads: the task hangs under the thread's root, the reply is named", async ({ app }) => {
  const fx = await setup("req-reply");
  installRecordingOrchestrator(app.app);
  const root = await createMessage(fx.channel.id, "user", fx.owner.id, "the launch checklist");
  const thread = await getOrCreateThreadForChannel(fx.channel.id, root.id, fx.author.id, "user");
  const reply = await createMessage(thread.id, "user", fx.author.id, "could someone update the changelog?");

  const created = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "update the changelog", source_message_id: reply.id }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.tasks[0].sourceMessageId, root.id);
  assert.equal(created.body.tasks[0].sourceThreadReplyId, reply.id);
  const row = await taskByNumber(fx.channel.id, created.body.tasks[0].taskNumber);
  assert.equal(row.sourceMessageId, root.id, "the source is the thread's root message");

  // The reply's short id works the same way.
  const byShortId = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "and the release notes", source_message_id: reply.id.slice(0, 8) }] });
  assert.equal(byShortId.status, 200, JSON.stringify(byShortId.body));
  assert.equal(byShortId.body.tasks[0].sourceMessageId, root.id);
  assert.equal(byShortId.body.tasks[0].sourceThreadReplyId, reply.id);
  assert.equal((await taskByNumber(fx.channel.id, byShortId.body.tasks[0].taskNumber)).sourceMessageId, root.id);

  // A top-level source names no reply.
  const own = await createMessage(fx.channel.id, "agent", fx.agent.id, "I'll also tidy the docs");
  const topLevel = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "tidy the docs", source_message_id: own.id }] });
  assert.equal(topLevel.status, 200, JSON.stringify(topLevel.body));
  assert.equal(topLevel.body.tasks[0].sourceMessageId, own.id);
  assert.equal(topLevel.body.tasks[0].sourceThreadReplyId, undefined);
});

test("a message from another channel, its threads, or a DM is still no source: 400 invalid_source_message, nothing created", async ({ app }) => {
  const fx = await setup("req-elsewhere");
  installRecordingOrchestrator(app.app);
  const other = await createChannel(fx.server.id, `req-other-${randomUUID().slice(0, 6)}`);
  await addHuman(other.id, fx.owner.id);
  await addAgent(other.id, fx.agent.id);
  const elsewhere = await createMessage(other.id, "user", fx.owner.id, "this belongs to another channel");
  const otherThread = await getOrCreateThreadForChannel(other.id, elsewhere.id, fx.owner.id, "user");
  const elsewhereReply = await createMessage(otherThread.id, "user", fx.owner.id, "a reply over there");
  const dm = await findOrCreateDM(fx.server.id, fx.owner.id, fx.agent.id);
  assert.ok(dm, "the DM exists");
  const inDm = await createMessage(dm!.id, "user", fx.owner.id, "a private ask");

  for (const [label, id] of [["another channel", elsewhere.id], ["another channel's thread", elsewhereReply.id], ["a DM", inDm.id]] as const) {
    const answer = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: `from ${label}`, source_message_id: id }] });
    assert.equal(answer.status, 400, `${label}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.body.code, "invalid_source_message", label);
  }
  assert.deepEqual(await tasksIn(fx.channel.id), [], "nothing was created");
});

// ── a person's web create without a source ──

test("web create without a source (task v2): the creator's own message is posted and is the task's source; its thread says so", async ({ app }) => {
  const fx = await setup("req-web");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const before = await chatMessagesIn(fx.channel.id);

  const created = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "write the launch post" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const after = await chatMessagesIn(fx.channel.id);
  assert.equal(after.length, before.length + 1, "exactly one new message in the channel");
  const posted = after[after.length - 1]!;
  assert.deepEqual([posted.senderType, posted.senderId, posted.content], ["user", fx.owner.id, "write the launch post"]);
  const row = (await tasksIn(fx.channel.id)).find((task) => task.id === created.body.tasks[0].id)!;
  assert.ok(row, "the task exists");
  assert.equal(row.sourceMessageId, posted.id, "the posted message is its source");
  assert.equal(row.messageId, null, "a task v2 task, no host message");

  // The "created … from this message" line, as for any source (a person's
  // create and an agent's do not differ, the creator's own message included).
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [thread] = await getDb().select().from(channels).where(eq(channels.parentMessageId, posted.id));
  const lines = thread ? await getDb().select().from(messages).where(eq(messages.channelId, thread.id)) : [];
  assert.equal(lines.length, 1, JSON.stringify(lines.map((line) => line.content)));
  assert.ok(lines[0]!.content.endsWith(`#${created.body.tasks[0].taskNumber} "write the launch post" from this message`), lines[0]!.content);

  // A description goes under the title.
  const described = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "pricing page", description: "new tiers\nand the FAQ" }] });
  assert.equal(described.status, 200, JSON.stringify(described.body));
  const latest = (await chatMessagesIn(fx.channel.id)).at(-1)!;
  assert.equal(latest.content, "pricing page\n\nnew tiers\nand the FAQ");
  assert.equal((await tasksIn(fx.channel.id)).find((task) => task.id === described.body.tasks[0].id)?.sourceMessageId, latest.id);
});

test("web create of several tasks without a source (task v2): one list message, every task under it", async ({ app }) => {
  const fx = await setup("req-web-batch");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const before = await chatMessagesIn(fx.channel.id);

  const created = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "a" }, { title: "b" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const after = await chatMessagesIn(fx.channel.id);
  assert.equal(after.length, before.length + 1, "one message for the batch");
  const posted = after.at(-1)!;
  assert.equal(posted.content, "- a\n- b");
  const rows = await tasksIn(fx.channel.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.sourceMessageId), [posted.id, posted.id], "both tasks share it");
});

test("web create with the same sourceRandomId twice (task v2): the message is posted once and the retry returns the same tasks", async ({ app }) => {
  const fx = await setup("req-web-retry");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const before = await chatMessagesIn(fx.channel.id);
  const sourceRandomId = randomUUID();

  const first = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "retry me" }], sourceRandomId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // A retry after a lost response: the same key and the same titles.
  const again = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "retry me" }], sourceRandomId });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.tasks.map((task: { id: string }) => task.id), first.body.tasks.map((task: { id: string }) => task.id), "the same tasks come back");

  const after = await chatMessagesIn(fx.channel.id);
  assert.equal(after.length, before.length + 1, "the source message was posted once");
  const rows = await tasksIn(fx.channel.id);
  assert.equal(rows.length, 1, "nothing was created twice");
  assert.equal(rows[0]!.sourceMessageId, after.at(-1)!.id);

  // The same key with other titles is refused before anything is written.
  const other = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "something else" }], sourceRandomId });
  assert.equal(other.status, 409, JSON.stringify(other.body));
  assert.equal(other.body.code, "source_random_id_reused");
  assert.equal((await chatMessagesIn(fx.channel.id)).length, before.length + 1);
  assert.equal((await tasksIn(fx.channel.id)).length, 1);
});

test("web create without a source (task v2): an @name in a title pings nobody", async ({ app }) => {
  const fx = await setup("req-web-mention");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const created = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: `ask @${fx.author.name} about pricing` }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const posted = (await chatMessagesIn(fx.channel.id)).at(-1)!;
  assert.equal(posted.content, `ask @${fx.author.name} about pricing`);
  assert.deepEqual(await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, posted.id)), [], "no mention recorded");
});

test("web create (task v2): a batch with an unknown given source is refused before the sourceless ones' message is posted", async ({ app }) => {
  const fx = await setup("req-web-unknown");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const before = await chatMessagesIn(fx.channel.id);
  const answer = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "sourceless" }, { title: "unknown", sourceMessageId: randomUUID() }] });
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.code, "invalid_source_message");
  assert.equal((await chatMessagesIn(fx.channel.id)).length, before.length, "nothing posted");
  assert.deepEqual(await tasksIn(fx.channel.id), []);
});

test("a short id matching both a top-level message and a reply is ambiguous; a system reply is no source", async ({ app }) => {
  const fx = await setup("req-ambiguous");
  installRecordingOrchestrator(app.app);
  const root = await createMessage(fx.channel.id, "user", fx.owner.id, "the root");
  const thread = await getOrCreateThreadForChannel(fx.channel.id, root.id, fx.owner.id, "user");
  const prefix = randomUUID().slice(0, 8);
  const [topLevel] = await getDb().insert(messages).values({ id: `${prefix}${randomUUID().slice(8)}`, channelId: fx.channel.id, senderType: "user", senderId: fx.owner.id, content: "top" }).returning();
  await getDb().insert(messages).values({ id: `${prefix}${randomUUID().slice(8)}`, channelId: thread.id, senderType: "user", senderId: fx.owner.id, content: "reply" });
  assert.ok(topLevel);
  const ambiguous = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "which one?", source_message_id: prefix }] });
  assert.equal(ambiguous.status, 400, JSON.stringify(ambiguous.body));
  assert.equal(ambiguous.body.code, "invalid_source_message");

  const systemReply = await createMessage(thread.id, "user", "system", "a lifecycle line", "system");
  const fromSystem = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "from a system line", source_message_id: systemReply.id }] });
  assert.equal(fromSystem.status, 400, JSON.stringify(fromSystem.body));
  assert.equal(fromSystem.body.code, "invalid_source_message");
  assert.deepEqual(await tasksIn(fx.channel.id), []);
});

// ── a task without a recorded source ──

test("a task without a recorded source: tasks/view has no sourceMessage, the board says sourceRecorded false; a web task's source is recorded", async ({ app }) => {
  const fx = await setup("req-recorded");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);

  // An older task v2 task created without a source (the service still allows it).
  const { tasks: [sourceless] } = await taskService.createTasks(fx.channel.id, "user", fx.owner.id, [{ title: "from before the rule" }]);
  assert.equal(sourceless!.sourceMessageId ?? null, null);
  const view = await agentGet(app.baseUrl, fx.key, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${sourceless!.taskNumber}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.sourceMessage, null);

  // A web task: its source (the creator's message) is recorded.
  const created = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "with its source" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const webTaskId = created.body.tasks[0].id as string;

  const listed = await fetch(`${app.baseUrl}/api/tasks/channel/${fx.channel.id}`, { headers: humanHeaders(token, fx.server.id) });
  assert.equal(listed.status, 200, await listed.clone().text());
  const board = ((await listed.json()) as { tasks: Array<{ id: string; sourceRecorded?: boolean; sourceMessageId: string | null }> }).tasks;
  const sourcelessDto = board.find((task) => task.id === sourceless!.id);
  const webDto = board.find((task) => task.id === webTaskId);
  assert.ok(sourcelessDto && webDto, "both are listed");
  assert.equal(sourcelessDto!.sourceRecorded, false);
  assert.equal(webDto!.sourceRecorded, true);
  assert.ok(webDto!.sourceMessageId);
});

test("a pre-v2 task posted as its own message has no recorded source: view shows none after the flag goes on", async ({ app }) => {
  const fx = await setup("req-echo", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const created = await agentPost(app.baseUrl, fx.key, "tasks", { channel: fx.board, tasks: [{ title: "posted as a message" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  const hostId = (await taskByNumber(fx.channel.id, taskNumber)).messageId;
  assert.ok(hostId, "a host message (its own echo)");
  // Flag off: unchanged, the host stands for its source.
  const before = await agentGet(app.baseUrl, fx.key, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${taskNumber}`);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.sourceMessage?.id, hostId, "flag off: the host is shown as before");
  await enableTaskV2ConversationsForServer(fx.server.id);

  const view = await agentGet(app.baseUrl, fx.key, `tasks/view?channel=${encodeURIComponent(fx.board)}&task_number=${taskNumber}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.sourceMessage, null, "its own echo is not a source");
});

test("web create without a source (task v2): agents get the posted message with a line saying it is a task's source", async ({ app }) => {
  const fx = await setup("req-web-agent-line");
  const deliveries = installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const created = await webCreate(app.baseUrl, token, fx.server.id, fx.channel.id, { tasks: [{ title: "draft the release notes" }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !deliveries.some((d) => d.agentId === fx.agent.id)) await new Promise((resolve) => setTimeout(resolve, 50));
  const delivered = deliveries.filter((d) => d.agentId === fx.agent.id).map((d) => JSON.stringify(d.payload));
  assert.ok(delivered.some((payload) => payload.includes("Posted automatically as the source of the task")), JSON.stringify(delivered));
  const posted = (await chatMessagesIn(fx.channel.id)).at(-1)!;
  assert.equal(posted.content, "draft the release notes", "people see the titles only");
});

// ── a message sent as a task (the composer's "As task") ──

test("a message sent as a task (task v2): the message is the source, its first line the title, the rest the description, and its thread says so", async ({ app }) => {
  const fx = await setup("req-as-task");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, fx.owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: humanHeaders(token, fx.server.id),
    body: JSON.stringify({ channelId: fx.channel.id, content: "Fix the login redirect\nGo back to the page you came from, not home.", asTask: true }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const messageId = (JSON.parse(text) as { id: string }).id;
  const rows = await tasksIn(fx.channel.id);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  const [task] = rows;
  assert.equal(task!.sourceMessageId, messageId, "the sent message is the source");
  assert.equal(task!.messageId, null, "a task v2 task, no host message");
  assert.equal(task!.title, "Fix the login redirect");
  assert.equal(task!.description, "Go back to the page you came from, not home.");
  let lines: string[] = [];
  for (let attempt = 0; attempt < 30 && lines.length === 0; attempt += 1) {
    const [thread] = await getDb().select().from(channels).where(eq(channels.parentMessageId, messageId));
    lines = thread ? (await getDb().select().from(messages).where(eq(messages.channelId, thread.id))).map((row) => row.content) : [];
    if (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0]!.endsWith(`#${task!.taskNumber} "Fix the login redirect" from this message`), lines[0]);
});
