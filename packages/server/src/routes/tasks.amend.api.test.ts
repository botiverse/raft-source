import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Editing a task's title and description from the web (Task v2 to-do list,
 * #wg-task-v2:#10; @stdrc 2026-10-31 msg 7bf6030a): PATCH /api/tasks/:taskId.
 *
 * Pinned, over HTTP with a logged-in session:
 *  - a saved edit changes the task, records the `amended` event (History) and
 *    writes ONE line in the task's own discussion, worded for what changed
 *    ("changed the title" / "the description" / "the title and description");
 *    it mentions nobody and makes nobody follow;
 *  - a stale `expectedRevision` is 409 with the current revision and writes
 *    nothing (row, event, line);
 *  - only a current channel member may edit (an outsider is refused, nothing
 *    written), an empty title is 400;
 *  - `raft task amend` (agent route) writes the same line, so agent and human
 *    edits read the same.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, messageMentions, messages, serverMembers, taskEvents, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import * as taskService from "../services/taskService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliveries: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
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

/** Owner (creator) + member + agent in one public channel, an outsider in the server only, one v2 task. */
async function setup(slug: string, opts: { taskV2?: boolean } = {}) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const outsider = await seedUser(`${slug}-outsider`);
  const server = await createServer(`Amend ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  if (opts.taskV2 !== false) await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} task`, description: `${slug} details` }],
  );
  return { owner, member, outsider, agent, server, channel, task: task! };
}

function editTask(baseUrl: string, token: string, serverId: string, taskId: string, body: unknown) {
  return fetch(`${baseUrl}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: humanHeaders(token, serverId),
    body: JSON.stringify(body),
  });
}

async function readTask(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row!;
}

async function amendedEvents(taskId: string) {
  return getDb().select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.eventType, "amended")));
}

/** Lifecycle lines in the task's own conversation (none until one is written). */
async function lifecycleNotices(taskId: string) {
  const row = await readTask(taskId);
  if (!row.conversationChannelId) return [];
  return getDb().select().from(messages).where(and(
    eq(messages.channelId, row.conversationChannelId),
    inArray(messages.systemSubtype, ["task.lifecycle_thread", "task.assignment_receipt"]),
  ));
}

async function waitForNotices(taskId: string, count: number) {
  return waitFor(`${count} lifecycle line(s)`, async () => {
    const rows = await lifecycleNotices(taskId);
    return rows.length >= count ? rows : null;
  });
}

test("a member edits the title: the task changes, History records it, one line in its discussion that mentions nobody", async ({ app }) => {
  const { member, server, task } = await setup("amend-title");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, member.email);
  const before = await readTask(task.id);

  const res = await editTask(app.baseUrl, token, server.id, task.id, {
    title: "  Ship the edit route  ",
    expectedRevision: before.revision,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { task: { id: string; title: string; description: string | null; revision: number } };
  assert.equal(body.task.title, "Ship the edit route", "the title is trimmed");
  assert.equal(body.task.description, "amend-title details", "the description is untouched");
  assert.equal(body.task.revision, before.revision + 1);

  const after = await readTask(task.id);
  assert.equal(after.title, "Ship the edit route");
  assert.equal(after.revision, before.revision + 1);

  const events = await amendedEvents(task.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actorType, "user");
  assert.equal(events[0]!.actorId, member.id);
  assert.deepEqual((events[0]!.payload as { changes: unknown }).changes, {
    title: { from: "amend-title task", to: "Ship the edit route" },
  });

  const [notice] = await waitForNotices(task.id, 1);
  assert.equal(notice!.content, `✏️ ${member.displayName} changed the title of #${task.taskNumber} "Ship the edit route"`);
  assert.equal(notice!.systemSubtype, "task.lifecycle_thread");
  assert.equal(notice!.channelId, (await readTask(task.id)).conversationChannelId, "the line lives in the task's own conversation");
  assert.deepEqual(await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, notice!.id)), [], "it mentions nobody");
  const memberFollows = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, notice!.channelId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, member.id),
  ));
  assert.deepEqual(memberFollows, [], "editing does not make the editor follow");
  await settle();
  assert.equal((await lifecycleNotices(task.id)).length, 1, "exactly one line");
});

test("clearing the description, and editing both: the line says what changed", async ({ app }) => {
  const { owner, server, task } = await setup("amend-desc");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, owner.email);

  const cleared = await editTask(app.baseUrl, token, server.id, task.id, { clearDescription: true });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  assert.equal(((await cleared.json()) as { task: { description: string | null } }).task.description, null);
  assert.equal((await readTask(task.id)).description, null);
  const [first] = await waitForNotices(task.id, 1);
  assert.equal(first!.content, `✏️ ${owner.displayName} changed the description of #${task.taskNumber} "amend-desc task"`);

  const both = await editTask(app.baseUrl, token, server.id, task.id, { title: "Renamed", description: "New details" });
  assert.equal(both.status, 200, await both.clone().text());
  const after = await readTask(task.id);
  assert.equal(after.title, "Renamed");
  assert.equal(after.description, "New details");
  const notices = await waitForNotices(task.id, 2);
  assert.ok(
    notices.some((row) => row.content === `✏️ ${owner.displayName} changed the title and description of #${task.taskNumber} "Renamed"`),
    JSON.stringify(notices.map((row) => row.content)),
  );
  assert.equal((await amendedEvents(task.id)).length, 2);

  // Saving the text as it is: success, nothing written.
  const same = await editTask(app.baseUrl, token, server.id, task.id, { title: "Renamed" });
  assert.equal(same.status, 200, await same.clone().text());
  assert.equal((await readTask(task.id)).revision, after.revision, "a no-op edit does not burn a revision");
  await settle();
  assert.equal((await amendedEvents(task.id)).length, 2);
  assert.equal((await lifecycleNotices(task.id)).length, 2);
});

test("a stale expectedRevision is 409 with the current revision and writes nothing", async ({ app }) => {
  const { owner, member, server, task } = await setup("amend-stale");
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, member.email);
  const stale = (await readTask(task.id)).revision;

  // Someone else changes the task first.
  const concurrent = await taskService.assignTask(task.id, { type: "user", id: owner.id }, "user", owner.id);
  assert.notEqual(typeof concurrent, "string", String(concurrent));
  const current = await readTask(task.id);
  assert.equal(current.revision, stale + 1);
  await settle();
  const linesBefore = (await lifecycleNotices(task.id)).length;

  const res = await editTask(app.baseUrl, token, server.id, task.id, { title: "Overwrite", expectedRevision: stale });
  assert.equal(res.status, 409, await res.clone().text());
  const body = await res.json() as { error: string; currentRevision: number | null };
  assert.equal(body.currentRevision, current.revision, "the refusal carries the current token");

  const after = await readTask(task.id);
  assert.equal(after.title, "amend-stale task", "nothing was written");
  assert.equal(after.revision, current.revision);
  assert.deepEqual(await amendedEvents(task.id), []);
  await settle();
  assert.equal((await lifecycleNotices(task.id)).length, linesBefore, "no line");

  // With the current token the same edit lands.
  const retry = await editTask(app.baseUrl, token, server.id, task.id, { title: "Overwrite", expectedRevision: current.revision });
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await readTask(task.id)).title, "Overwrite");
});

test("someone not in the channel is refused and nothing is written; an empty title is 400", async ({ app }) => {
  const { owner, outsider, server, task } = await setup("amend-refused");
  installRecordingOrchestrator(app.app);
  const before = await readTask(task.id);

  const outsiderToken = await login(app.baseUrl, outsider.email);
  const refused = await editTask(app.baseUrl, outsiderToken, server.id, task.id, { title: "Outsider rewrite" });
  assert.equal(refused.status, 403, await refused.clone().text());

  const ownerToken = await login(app.baseUrl, owner.email);
  for (const title of ["", "   "]) {
    const empty = await editTask(app.baseUrl, ownerToken, server.id, task.id, { title });
    assert.equal(empty.status, 400, `title ${JSON.stringify(title)}: ${await empty.clone().text()}`);
  }
  const nothing = await editTask(app.baseUrl, ownerToken, server.id, task.id, {});
  assert.equal(nothing.status, 400, "an edit must name something to change");
  const both = await editTask(app.baseUrl, ownerToken, server.id, task.id, { description: "x", clearDescription: true });
  assert.equal(both.status, 400, "description and clearDescription together are contradictory");

  const after = await readTask(task.id);
  assert.equal(after.title, before.title);
  assert.equal(after.description, before.description);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(await amendedEvents(task.id), []);
  await settle();
  assert.deepEqual(await lifecycleNotices(task.id), []);
});

test("raft task amend writes the same line as a web edit", async ({ app }) => {
  const { agent, channel, task } = await setup("amend-agent");
  installRecordingOrchestrator(app.app);
  const { apiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read", "tasks"],
    name: `amend-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  const res = await fetch(`${app.baseUrl}/internal/agent-api/tasks/amend`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: `#${channel.name}`, task_number: task.taskNumber, description: "Agent details" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await readTask(task.id)).description, "Agent details");

  const [notice] = await waitForNotices(task.id, 1);
  assert.match(notice!.content, new RegExp(`^✏️ .+ changed the description of #${task.taskNumber} "amend-agent task"$`, "u"));
  assert.equal(notice!.messageType, "system");
});

test("flag off (pre-v2 task): the edit line goes to the host message's thread, its discussion", async ({ app }) => {
  const { owner, server, task } = await setup("amend-off", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const token = await login(app.baseUrl, owner.email);

  const res = await editTask(app.baseUrl, token, server.id, task.id, { title: "Renamed pre-v2" });
  assert.equal(res.status, 200, await res.clone().text());
  const row = await readTask(task.id);
  assert.equal(row.title, "Renamed pre-v2");
  assert.equal(row.conversationChannelId, null, "no conversation is created with the flag off");
  assert.ok(row.messageId, "a pre-v2 task has a host message");

  const notice = await waitFor("host-thread line", async () => {
    const [thread] = await getDb().select({ id: channels.id }).from(channels).where(and(
      eq(channels.parentMessageId, row.messageId!),
      eq(channels.type, "thread"),
    ));
    if (!thread) return null;
    const [line] = await getDb().select().from(messages).where(and(
      eq(messages.channelId, thread.id),
      eq(messages.systemSubtype, "task.lifecycle_thread"),
    ));
    return line ?? null;
  });
  assert.equal(notice.content, `✏️ ${owner.displayName} changed the title of #${task.taskNumber} "Renamed pre-v2"`);
});
