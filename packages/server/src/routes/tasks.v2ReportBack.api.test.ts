import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 report-back (#wg-task-v2:98488173): a request taken as a task
 * says so where it was asked.
 *  - a task created from a message leaves one line in that message's
 *    thread, and the message's sender follows the thread; the creator's own
 *    message too (a person's create and an agent's do not differ);
 *  - a message may have any number of tasks (#wg-task-v2:458f336e): a second
 *    agent creating from it is not refused, and each task leaves its own line,
 *    which is what an agent about to create sees (the freshness hold) instead
 *    of a refusal. An `alongside` field from an older CLI is ignored.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";

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


/** A person (the author) and two agents in one public channel, task v2 on. */
async function setup(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const author = await seedUser(`${slug}-author`);
  const server = await createServer(`Report ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: author.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, author.id);
  const mk = async (label: string) => {
    const agent = await createAgent(server.id, `${slug}-${label}-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
    await addAgent(channel.id, agent.id);
    const { apiKey } = await mintAgentCredential({
      agentId: agent.id,
      scopes: ["send", "read", "tasks", "channels"],
      name: `report-back-${label}-${randomUUID().slice(0, 6)}`,
      issuedVia: "computer", createdByUserId: null,
    });
    return { agent, key: apiKey };
  };
  const a = await mk("a");
  const b = await mk("b");
  await enableTaskV2ConversationsForServer(server.id);
  return { owner, author, server, channel, a, b, board: `#${channel.name}` };
}

async function sourceThreadLines(sourceId: string) {
  const db = getDb();
  const [thread] = await db.select().from(channels).where(eq(channels.parentMessageId, sourceId));
  if (!thread) return { thread: null, lines: [] as string[] };
  const rows = await db.select().from(messages).where(eq(messages.channelId, thread.id));
  return { thread, lines: rows.map((row) => row.content) };
}

test("a task taken from someone else's message leaves one line in its thread, and the sender follows it", async ({ app }) => {
  const baseUrl = app.baseUrl;
  installRecordingOrchestrator(app.app);
  const fx = await setup("rb-line");
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "please write the retry note");
  const created = await agentPost(baseUrl, fx.a.key, "tasks", {
    channel: fx.board,
    tasks: [{ title: "Retry note", source_message_id: source.id }],
    assignee: `@${fx.a.agent.name}`,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const taskNumber = created.body.tasks[0].taskNumber as number;

  const { thread, lines } = await sourceThreadLines(source.id);
  assert.ok(thread, "the source message has a thread now");
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0], `📌 ${fx.a.agent.displayName || fx.a.agent.name} created #${fx.channel.name}:#${taskNumber} "Retry note" from this message`);
  const [follow] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, thread.id),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, fx.author.id),
  ));
  assert.equal(follow?.reason, "authored", "the sender follows the thread, as when a reply lands under their message");
});

test("a task made from the creator's own message leaves the same line in its thread", async ({ app }) => {
  const baseUrl = app.baseUrl;
  installRecordingOrchestrator(app.app);
  const fx = await setup("rb-own");
  const token = await login(baseUrl, fx.author.email);
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "note to self: retry note");
  const res = await fetch(`${baseUrl}/api/tasks/channel/${fx.channel.id}`, {
    method: "POST",
    headers: humanHeaders(token, fx.server.id),
    body: JSON.stringify({ tasks: [{ title: "Retry note", sourceMessageId: source.id }] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const { taskNumber } = ((await res.json()) as { tasks: { taskNumber: number }[] }).tasks[0]!;
  let lines: string[] = [];
  for (let attempt = 0; attempt < 30 && lines.length === 0; attempt += 1) {
    ({ lines } = await sourceThreadLines(source.id));
    if (lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0]!.startsWith("📌 ") && lines[0]!.endsWith(`created #${fx.channel.name}:#${taskNumber} "Retry note" from this message`), lines[0]);
});

test("a second agent creating from the same message is not refused: both tasks hang under it, each with its line", async ({ app }) => {
  const baseUrl = app.baseUrl;
  installRecordingOrchestrator(app.app);
  const fx = await setup("rb-second");
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "please write the retry note");
  const first = await agentPost(baseUrl, fx.a.key, "tasks", {
    channel: fx.board,
    tasks: [{ title: "Retry note", source_message_id: source.id }],
    assignee: `@${fx.a.agent.name}`,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstNumber = first.body.tasks[0].taskNumber as number;

  const second = await agentPost(baseUrl, fx.b.key, "tasks", {
    channel: fx.board,
    tasks: [{ title: "Retry note too", source_message_id: source.id }],
    assignee: `@${fx.b.agent.name}`,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondNumber = second.body.tasks[0].taskNumber as number;

  const rows = await getDb().select({ taskNumber: tasks.taskNumber }).from(tasks).where(eq(tasks.sourceMessageId, source.id));
  assert.deepEqual(rows.map((row) => row.taskNumber).sort((x, y) => x - y), [firstNumber, secondNumber], "both tasks hang under the message");

  let lines: string[] = [];
  for (let attempt = 0; attempt < 30 && lines.length < 2; attempt += 1) {
    ({ lines } = await sourceThreadLines(source.id));
    if (lines.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(lines.length, 2, JSON.stringify(lines));
  assert.deepEqual([...lines].sort(), [
    `📌 ${fx.a.agent.displayName || fx.a.agent.name} created #${fx.channel.name}:#${firstNumber} "Retry note" from this message`,
    `📌 ${fx.b.agent.displayName || fx.b.agent.name} created #${fx.channel.name}:#${secondNumber} "Retry note too" from this message`,
  ].sort());
});

test("an older CLI's alongside field is ignored, not refused", async ({ app }) => {
  const baseUrl = app.baseUrl;
  installRecordingOrchestrator(app.app);
  const fx = await setup("rb-alongside");
  const source = await createMessage(fx.channel.id, "user", fx.author.id, "please write the retry note");
  const created = await agentPost(baseUrl, fx.a.key, "tasks", {
    channel: fx.board,
    tasks: [{ title: "Retry note", source_message_id: source.id }],
    alongside: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
});
