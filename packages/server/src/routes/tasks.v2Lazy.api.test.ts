import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 (spec §4–§7), the pieces that depend on the server flag:
 *  - a task created before task v2 gets its own conversation lazily, the first
 *    time a task event line must be written or someone opens it to write
 *    (`POST /api/tasks/:id/conversation`); its old host thread is untouched;
 *  - `task convert` / `task claim --message-id` (agent API + legacy daemon
 *    route) and the web convert route refuse with `task_v2_use_create`;
 *  - creating a task posts nothing in the channel (no created summary, no
 *    channel assignment receipt); an assignment is announced in the task's
 *    own conversation;
 *  - task v2 tasks get their conversation lazily too, like a thread (decided
 *    2026-10-21): creating a task creates only the task; the first action that
 *    needs the conversation creates it, and its creator (`authored`) and
 *    assignee (`assigned`) follow it from then on.
 * Flag off, every one of these keeps its pre-v2 behavior.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, messageMentions, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { registerMachine } from "../services/machineService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { ensureTaskConversation } from "../services/taskConversationService";
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
  assert.equal(res.status, 200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/**
 * Owner + member + agent in one channel and ONE PRE-V2 TASK (created while the
 * flag is off: its conversation parent is a visible host chat message).
 * `taskV2` turns the flag on afterwards.
 */
async function setup(slug: string, opts: { taskV2?: boolean } = {}) {
  const db = getDb();
  const owner = await seedUser(`${slug}-o`);
  const member = await seedUser(`${slug}-m`);
  const server = await createServer(`Lazy ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 4)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} old task` }],
  );
  if (opts.taskV2) await enableTaskV2ConversationsForServer(server.id);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks", "channels"],
    name: `lazy-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return { owner, member, agent, server, channel, task: task!, host: host!, apiKey };
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
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return { status: res.status, body: await res.json() as any };
}

async function threadOf(parentMessageId: string) {
  const [thread] = await getDb().select({ id: channels.id }).from(channels).where(and(
    eq(channels.parentMessageId, parentMessageId),
    eq(channels.type, "thread"),
  ));
  return thread?.id ?? null;
}

async function threadMessages(parentMessageId: string) {
  const threadId = await threadOf(parentMessageId);
  if (!threadId) return [];
  return getDb().select().from(messages).where(eq(messages.channelId, threadId));
}

async function taskRow(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

async function channelSystemLines(channelId: string, subtype: string) {
  return getDb().select().from(messages).where(and(eq(messages.channelId, channelId), eq(messages.systemSubtype, subtype)));
}

// ── Lazy conversation for pre-v2 tasks ──

for (const taskV2 of [true, false]) test(`pre-v2 task, web assign: the event line goes to ${taskV2 ? "a new conversation (old host thread untouched)" : "the host message thread, as before"}`, async ({ app }) => {
  const { owner, member, server, task, host } = await setup(`assign-${taskV2 ? "on" : "off"}`, { taskV2 });
  installRecordingOrchestrator(app.app);
  const ownerToken = await login(app.baseUrl, owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const responded = (await res.json() as { task: { messageId: string; conversationAnchored: boolean } }).task;

  if (!taskV2) {
    // Flag off: exactly the pre-v2 (staging) line in the host thread — the
    // assignee's display name, no mention, no follow.
    assert.deepEqual([responded.messageId, responded.conversationAnchored], [host.id, false]);
    const [notice] = await waitFor("host-thread notice", async () => {
      const rows = await threadMessages(host.id);
      return rows.length > 0 ? rows : null;
    });
    assert.match(notice!.content, new RegExp(`to ${member.displayName}$`));
    assert.deepEqual(await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, notice!.id)), []);
    assert.equal((await taskRow(task.id)).conversationChannelId, null, "flag off never creates a conversation");
    return;
  }

  const conversationId = await waitFor("lazy conversation", async () => (await taskRow(task.id)).conversationChannelId);
  assert.deepEqual([responded.messageId, responded.conversationAnchored, (responded as { conversationChannelId?: string }).conversationChannelId], [host.id, true, conversationId], "the response already names the new conversation");
  const [conversation] = await getDb().select().from(channels).where(eq(channels.id, conversationId!));
  assert.equal(conversation!.type, "task");
  assert.equal((await taskRow(task.id)).messageId, host.id, "the old host message stays (earlier discussion)");
  const [notice] = await waitFor("conversation notice", async () => {
    const rows = await getDb().select().from(messages).where(eq(messages.channelId, conversationId!));
    return rows.length > 0 ? rows : null;
  });
  assert.match(notice!.content, new RegExp(`to @${member.name}$`));
  assert.deepEqual((await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, notice!.id))).map((m) => m.targetId), [member.id]);
  const [assigneeFollow] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId!),
    eq(threadFollows.followerId, member.id),
  ));
  assert.equal(assigneeFollow?.reason, "assigned", "being assigned by someone else follows");
  await settle();
  assert.equal(await threadOf(host.id), null, "the old host message thread is never written");
});

test("pre-v2 task on a v2 server: claim by number and status updates go to its new conversation", async ({ app }) => {
  const { channel, task, host, apiKey } = await setup("claim-on", { taskV2: true });
  installRecordingOrchestrator(app.app);

  const claim = await agentPost(app.baseUrl, apiKey, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [task.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const conversationId = (await taskRow(task.id)).conversationChannelId!;
  assert.ok(conversationId, "claiming opened the task's own conversation");
  assert.equal((await taskRow(task.id)).messageId, host.id);

  // Claiming started it (in_progress); in_review is not used for task v2
  // tasks, so the status change here is done.
  const status = await agentPost(app.baseUrl, apiKey, "tasks/update-status", {
    channel: `#${channel.name}`, task_number: task.taskNumber, status: "done",
  });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  await waitFor("status line", async () => (await getDb().select().from(messages).where(eq(messages.channelId, conversationId))).length > 0);
  await settle();
  assert.equal(await threadOf(host.id), null);
});

test("task list: a pre-v2 task without its conversation is conversationPending on v2 servers only", async ({ app }) => {
  const on = await setup("list-on", { taskV2: true });
  const off = await setup("list-off");
  const listOn = await agentGet(app.baseUrl, on.apiKey, `tasks?channel=${encodeURIComponent(`#${on.channel.name}`)}`);
  assert.equal(listOn.status, 200, JSON.stringify(listOn.body));
  assert.equal(listOn.body.tasks[0].conversationPending, true);
  const listOff = await agentGet(app.baseUrl, off.apiKey, `tasks?channel=${encodeURIComponent(`#${off.channel.name}`)}`);
  assert.equal("conversationPending" in listOff.body.tasks[0], false, "flag off: pre-v2 shape");

  await ensureTaskConversation(on.task.id);
  const after = await agentGet(app.baseUrl, on.apiKey, `tasks?channel=${encodeURIComponent(`#${on.channel.name}`)}`);
  assert.equal(after.body.tasks[0].conversationAnchored, true);
  assert.equal("conversationPending" in after.body.tasks[0], false);
});

test("POST /api/tasks/:id/conversation: creates the task conversation once (v2); flag off answers task_v2_not_enabled", async ({ app }) => {
  const on = await setup("conv-on", { taskV2: true });
  const memberToken = await login(app.baseUrl, on.member.email);
  const open = () => fetch(`${app.baseUrl}/api/tasks/${on.task.id}/conversation`, {
    method: "POST",
    headers: humanHeaders(memberToken, on.server.id),
  });
  const first = await open();
  assert.equal(first.status, 200, await first.clone().text());
  const body = await first.json() as { conversationChannelId: string; canonicalConversationChannelId: string; created: boolean };
  assert.equal(body.created, true);
  assert.equal(body.conversationChannelId, body.canonicalConversationChannelId, "an ordinary channel's surface sees the canonical conversation");
  assert.equal((await taskRow(on.task.id)).conversationChannelId, body.conversationChannelId);
  const second = await (await open()).json() as typeof body;
  assert.deepEqual(second, { ...body, created: false }, "idempotent");
  assert.equal(await threadOf(on.host.id), null, "the host thread is not created");

  const off = await setup("conv-off");
  const ownerToken = await login(app.baseUrl, off.owner.email);
  const offRes = await fetch(`${app.baseUrl}/api/tasks/${off.task.id}/conversation`, {
    method: "POST",
    headers: humanHeaders(ownerToken, off.server.id),
  });
  assert.equal(offRes.status, 409);
  assert.equal((await offRes.json() as { code: string }).code, "task_v2_not_enabled", "flag off: the discussion is the host message thread");
  assert.equal((await taskRow(off.task.id)).conversationChannelId, null);

  // Someone outside the channel cannot open it.
  const outsider = await seedUser("conv-outsider");
  await getDb().insert(serverMembers).values({ serverId: on.server.id, userId: outsider.id, role: "member" });
  const privateChannel = await createChannel(on.server.id, `conv-private-${randomUUID().slice(0, 4)}`, undefined, "private");
  await addHuman(privateChannel.id, on.owner.id);
  const { tasks: [privateTask] } = await taskService.createTasks(privateChannel.id, "user", on.owner.id, [{ title: "private" }]);
  const outsiderToken = await login(app.baseUrl, outsider.email);
  const denied = await fetch(`${app.baseUrl}/api/tasks/${privateTask!.id}/conversation`, {
    method: "POST",
    headers: humanHeaders(outsiderToken, on.server.id),
  });
  assert.equal(denied.status, 404);
});

// ── convert / claim --message-id refusals ──

test("v2 server: agent convert is refused with task_v2_use_create and the create command; nothing is written", async ({ app }) => {
  const { owner, agent, channel, apiKey } = await setup("convert-on", { taskV2: true });
  installRecordingOrchestrator(app.app);
  const message = await createMessage(channel.id, "user", owner.id, "ship the \"pricing\" page");
  const res = await agentPost(app.baseUrl, apiKey, "tasks/convert", { channel: `#${channel.name}`, message_id: message.id.slice(0, 8) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "task_v2_use_create");
  assert.ok(res.body.error.includes(
    `raft task create --target "#${channel.name}" --message-id ${message.id.slice(0, 8)} --title "ship the \\"pricing\\" page"`,
  ), res.body.error);
  assert.ok(res.body.error.includes(`--assignee @${agent.name}`));
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id))).length, 1, "only the seeded task");
});

test("pre-v2 server: agent convert still converts", async ({ app }) => {
  const { owner, channel, apiKey } = await setup("convert-off");
  installRecordingOrchestrator(app.app);
  const message = await createMessage(channel.id, "user", owner.id, "convert me");
  const res = await agentPost(app.baseUrl, apiKey, "tasks/convert", { channel: `#${channel.name}`, message_id: message.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.task.messageId, message.id);
});

test("v2 server: a claim mixing --number and --message-id claims nothing", async ({ app }) => {
  const { owner, channel, task, apiKey } = await setup("claim-mixed", { taskV2: true });
  installRecordingOrchestrator(app.app);
  const message = await createMessage(channel.id, "user", owner.id, "something");
  const res = await agentPost(app.baseUrl, apiKey, "tasks/claim", {
    channel: `#${channel.name}`, task_numbers: [task.taskNumber], message_ids: [message.id],
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "task_v2_use_create");
  assert.match(res.body.error, /--number tasks in this call included/);
  assert.equal((await taskRow(task.id)).claimedById, null);
});

for (const taskV2 of [true, false]) test(`legacy daemon claim --message-id: ${taskV2 ? "refused with the same hint" : "converts + claims as before"}`, async ({ app }) => {
  const { owner, agent, server, channel, task, host } = await setup(`legacy-${taskV2 ? "on" : "off"}`, { taskV2 });
  installRecordingOrchestrator(app.app);
  const { machine, apiKey } = await registerMachine(server.id, owner.id, `lazy-machine-${randomUUID().slice(0, 4)}`);
  await placeAgentOnMachine(agent.id, machine.id);
  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/tasks/claim`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: `#${channel.name}`, message_ids: [host.id.slice(0, 8)] }),
  });
  const body = await res.json() as any;
  if (taskV2) {
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, "task_v2_use_create");
    assert.ok(body.error.includes(`raft task claim --target "#${channel.name}" --number ${task.taskNumber}`), body.error);
    assert.equal((await taskRow(task.id)).claimedById, null);
  } else {
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].success, true);
    assert.equal((await taskRow(task.id)).claimedById, agent.id);
  }
});

for (const taskV2 of [true, false]) test(`web convert-message: ${taskV2 ? "refused with task_v2_use_create" : "converts as before"}`, async ({ app }) => {
  const { owner, server, channel } = await setup(`webconv-${taskV2 ? "on" : "off"}`, { taskV2 });
  installRecordingOrchestrator(app.app);
  const message = await createMessage(channel.id, "user", owner.id, "from the menu");
  const ownerToken = await login(app.baseUrl, owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/convert-message`, {
    method: "POST",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ messageId: message.id }),
  });
  const body = await res.json() as any;
  if (taskV2) {
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, "task_v2_use_create");
    assert.equal((await getDb().select().from(tasks).where(eq(tasks.sourceMessageId, message.id))).length, 0);
  } else {
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.task.messageId, message.id);
  }
});

// ── creation posts nothing in the channel (v2) ──

for (const taskV2 of [true, false]) test(`creation channel notices: ${taskV2 ? "none on a v2 server; the assignee is told in the task conversation" : "created summary + assignment receipt as before"}`, async ({ app }) => {
  const { owner, member, agent, server, channel, apiKey } = await setup(`create-${taskV2 ? "on" : "off"}`, { taskV2 });
  installRecordingOrchestrator(app.app);
  // Task v2: an agent's task always has a source (its own message here);
  // flag off a source is refused, so none.
  const agentSource = async (content: string) => (taskV2
    ? { source_message_id: (await createMessage(channel.id, "agent", agent.id, content)).id }
    : {});
  const ownerToken = await login(app.baseUrl, owner.email);

  const web = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, {
    method: "POST",
    headers: humanHeaders(ownerToken, server.id),
    body: JSON.stringify({ tasks: [{ title: "from the web" }] }),
  });
  assert.equal(web.status, 200, await web.clone().text());
  const assigned = await agentPost(app.baseUrl, apiKey, "tasks", {
    channel: `#${channel.name}`, tasks: [{ title: "handed over", ...await agentSource("handed over") }], assignee: `@${member.name}`,
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const unassigned = await agentPost(app.baseUrl, apiKey, "tasks", { channel: `#${channel.name}`, tasks: [{ title: "open work", ...await agentSource("open work") }] });
  assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body));
  await settle();

  const summaries = await channelSystemLines(channel.id, "task.created_summary");
  const receipts = await channelSystemLines(channel.id, "task.assignment_receipt");
  if (!taskV2) {
    await waitFor("created summaries", async () => (await channelSystemLines(channel.id, "task.created_summary")).length === 2);
    assert.equal(receipts.length, 1);
    assert.ok(assigned.body.assignmentReceipt);
    return;
  }
  assert.deepEqual(summaries, [], "creating a task posts no created summary in the channel");
  assert.deepEqual(receipts, [], "no channel assignment receipt either");
  assert.equal(assigned.body.assignmentReceipt, undefined);
  const handed = assigned.body.tasks[0];
  assert.equal(handed.conversationAnchored, true);
  const [handedRow] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, handed.taskNumber)));
  const conversationId = handedRow!.conversationChannelId!;
  // Lazy: the assignment line (posted before the create call answers) is the
  // first thing the conversation is needed for, so it exists now.
  assert.ok(conversationId, "the assignment line created the handed-over task's conversation");
  const handedFollows = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationId));
  assert.deepEqual(
    handedFollows.map((row) => [row.followerType, row.followerId, row.reason]).sort(),
    [["agent", agent.id, "authored"], ["user", member.id, "assigned"]].sort(),
    "its creation made the creator and the assignee follow",
  );
  // Nothing needed the other tasks' conversations yet: they have none.
  for (const title of ["from the web", "open work"]) {
    const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.title, title)));
    assert.equal(row!.ownConversation, true, `${title}: a task v2 task`);
    assert.equal(row!.conversationChannelId, null, `${title}: creating a task creates only the task`);
  }
  const [line] = await waitFor("assignment line in the task conversation", async () => {
    const rows = await getDb().select().from(messages).where(eq(messages.channelId, conversationId));
    return rows.length > 0 ? rows : null;
  });
  assert.match(line!.content, new RegExp(`assigned #${handed.taskNumber} ".*" to @${member.name}$`));
  const mentions = await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, line!.id));
  assert.deepEqual(mentions.map((m) => [m.targetType, m.targetId]), [["user", member.id]], "the assignee is notified once");
});

// ── Lazy conversation for task v2 tasks (decided 2026-10-21) ──

async function followOf(conversationId: string, followerType: "user" | "agent", followerId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row ?? null;
}

test("task v2 task: no conversation after creation; view reports its creator as following, read is an empty page", async ({ app }) => {
  const { owner, agent, server, channel, apiKey } = await setup("v2-none", { taskV2: true });
  installRecordingOrchestrator(app.app);
  const board = `#${channel.name}`;
  const source = await createMessage(channel.id, "agent", agent.id, "lazy one");
  const created = await agentPost(app.baseUrl, apiKey, "tasks", { channel: board, tasks: [{ title: "lazy one", source_message_id: source.id }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;
  assert.equal(created.body.tasks[0].conversationAnchored, true, "its discussion is its own conversation");
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, taskNumber)));
  assert.equal(row!.ownConversation, true);
  assert.equal(row!.messageId, null);
  assert.equal(row!.conversationChannelId, null, "creating a task creates only the task");
  assert.deepEqual(await getDb().select().from(channels).where(and(eq(channels.taskId, row!.id), eq(channels.type, "task"))), []);

  const view = await agentGet(app.baseUrl, apiKey, `tasks/view?channel=${encodeURIComponent(board)}&task_number=${taskNumber}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.conversation.exists, false);
  assert.deepEqual([view.body.following, view.body.followReason], [true, "authored"], "its creator follows it from the moment it exists");
  assert.equal(view.body.task.conversationPending, undefined, "not a pre-v2 task");

  const read = await agentGet(app.baseUrl, apiKey, `tasks/read?channel=${encodeURIComponent(board)}&task_number=${taskNumber}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.target, read.body.messages], [`${board}:#${taskNumber}`, []]);
  assert.equal((await taskRow(row!.id)).conversationChannelId, null, "view and read never create it");

  // `raft task list --following` agrees with view: listed as followed
  // (authored), nothing unread, and listing creates nothing.
  const following = await agentGet(app.baseUrl, apiKey, "tasks/following");
  assert.equal(following.status, 200, JSON.stringify(following.body));
  assert.deepEqual(
    following.body.tasks.map((t: { taskRef: string; unread: number; reason: string }) => [t.taskRef, t.unread, t.reason]),
    [[`${board}:#${taskNumber}`, 0, "authored"]],
  );
  assert.ok(!Number.isNaN(Date.parse(following.body.tasks[0].followedAt)));
  assert.equal((await taskRow(row!.id)).conversationChannelId, null, "listing never creates it");
  // Its assignee (no conversation yet either) is listed as `assigned`.
  const assignedTask = (await taskService.createTasks(channel.id, "user", owner.id, [{ title: "pending assignee" }])).tasks[0]!;
  await getDb().update(tasks).set({ claimedByType: "agent", claimedById: agent.id, claimedAt: new Date(), status: "in_progress" }).where(eq(tasks.id, assignedTask.id));
  const followingBoth = await agentGet(app.baseUrl, apiKey, "tasks/following");
  assert.deepEqual(
    new Map(followingBoth.body.tasks.map((t: { taskNumber: number; reason: string; unread: number }) => [t.taskNumber, [t.reason, t.unread]])),
    new Map([[taskNumber, ["authored", 0]], [assignedTask.taskNumber, ["assigned", 0]]]),
  );
  // An agent that neither created nor holds a task does not list it.
  const bystander = await createAgent(server.id, `v2-none-other-${randomUUID().slice(0, 4)}`, { runtime: "claude" });
  await addAgent(channel.id, bystander.id);
  const { apiKey: bystanderKey } = await mintAgentCredential({ agentId: bystander.id, scopes: ["send", "read", "tasks", "channels"], name: "bystander", issuedVia: "computer", createdByUserId: null });
  assert.deepEqual((await agentGet(app.baseUrl, bystanderKey, "tasks/following")).body.tasks, []);

  // The web lists it, and its (human) creator reads as following.
  const webTask = (await taskService.createTasks(channel.id, "user", owner.id, [{ title: "web lazy" }])).tasks[0]!;
  const ownerToken = await login(app.baseUrl, owner.email);
  const listed = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers: humanHeaders(ownerToken, server.id) });
  assert.equal(listed.status, 200, await listed.clone().text());
  const listedTasks = (await listed.json() as { tasks: Array<{ id: string; conversationFollowed?: boolean; isLegacy?: boolean; conversationChannelId?: string | null }> }).tasks;
  const listedWeb = listedTasks.find((task) => task.id === webTask.id)!;
  assert.ok(listedWeb, "listed without a conversation");
  assert.equal(listedWeb.conversationChannelId ?? null, null);
  assert.equal(listedWeb.isLegacy, false, "a task v2 task without its conversation is not a legacy orphan");
  assert.equal(listedWeb.conversationFollowed, true, "its creator reads as following");
});

test("task v2 task: the first agent reply creates the conversation — creator authored, assignee assigned, replier replied", async ({ app }) => {
  const { owner, member, agent, channel, apiKey } = await setup("v2-first-reply", { taskV2: true });
  installRecordingOrchestrator(app.app);
  // Assigned creation through the service: no announcement line, so nothing
  // has needed the conversation yet.
  const created = await taskService.createTasksWithAssignmentReceipt(
    channel.id, "user", owner.id, [{ title: "assigned, quiet" }],
    { type: "user", id: member.id }, { assigneeName: member.name },
  );
  const task = created.tasks[0]!;
  assert.equal((await taskRow(task.id)).conversationChannelId, null);

  const reply = await agentPost(app.baseUrl, apiKey, "tasks/reply", { channel: `#${channel.name}`, task_number: task.taskNumber, content: "first word" });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.state, "sent", JSON.stringify(reply.body));
  const conversationId = (await taskRow(task.id)).conversationChannelId;
  assert.ok(conversationId, "the first reply created it");
  const [stored] = await getDb().select().from(messages).where(eq(messages.id, reply.body.messageId));
  assert.equal(stored!.channelId, conversationId);
  assert.equal((await followOf(conversationId!, "user", owner.id))?.reason, "authored");
  assert.equal((await followOf(conversationId!, "user", member.id))?.reason, "assigned");
  assert.equal((await followOf(conversationId!, "agent", agent.id))?.reason, "replied");
});

test("task v2 task: its creator's unfollow creates the conversation and leaves it (with the line); a non-follower's unfollow creates nothing", async ({ app }) => {
  const { owner, agent, channel, apiKey } = await setup("v2-unfollow", { taskV2: true });
  installRecordingOrchestrator(app.app);
  const board = `#${channel.name}`;
  const source = await createMessage(channel.id, "agent", agent.id, "mine, then not");
  const created = await agentPost(app.baseUrl, apiKey, "tasks", { channel: board, tasks: [{ title: "mine, then not", source_message_id: source.id }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;

  const unfollow = await agentPost(app.baseUrl, apiKey, "tasks/unfollow", { channel: board, task_number: taskNumber, reason: "someone else has it" });
  assert.equal(unfollow.status, 200, JSON.stringify(unfollow.body));
  assert.deepEqual([unfollow.body.following, unfollow.body.changed], [false, true]);
  const [row] = await getDb().select().from(tasks).where(and(eq(tasks.channelId, channel.id), eq(tasks.taskNumber, taskNumber)));
  const conversationId = row!.conversationChannelId;
  assert.ok(conversationId, "unfollowing the follow it was created with created the conversation");
  const follow = await followOf(conversationId!, "agent", agent.id);
  assert.ok(follow, "the creator's follow was written when the conversation was created");
  assert.ok(follow!.unfollowedAt, "and then left");
  const line = await waitFor("unfollow line", async () => {
    const rows = await getDb().select().from(messages).where(eq(messages.channelId, conversationId!));
    return rows.find((m) => m.content === `@${agent.name} stopped following this task: someone else has it`) ?? null;
  });
  assert.equal(line.messageType, "system");
  const view = await agentGet(app.baseUrl, apiKey, `tasks/view?channel=${encodeURIComponent(board)}&task_number=${taskNumber}`);
  assert.deepEqual([view.body.conversation.exists, view.body.following], [true, false]);

  // A task the agent neither created nor holds: nothing to leave, nothing created.
  const other = (await taskService.createTasks(channel.id, "user", owner.id, [{ title: "not mine" }])).tasks[0]!;
  const noop = await agentPost(app.baseUrl, apiKey, "tasks/unfollow", { channel: board, task_number: other.taskNumber });
  assert.equal(noop.status, 200, JSON.stringify(noop.body));
  assert.deepEqual([noop.body.following, noop.body.changed], [false, false]);
  assert.equal((await taskRow(other.id)).conversationChannelId, null);
});
