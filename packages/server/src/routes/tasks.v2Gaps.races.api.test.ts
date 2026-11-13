import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 coverage gaps — races on a lazy task conversation (coverage matrix
 * F16 / N2, and "two first replies"): the conversation is created by the first
 * action that needs it, so concurrent first actions must still end with one
 * task conversation.
 *  - two agents claim the same v2 task at once: one claim wins, one
 *    conversation, only the winner follows (`assigned`);
 *  - two agents send the first reply at once: both replies land in the one
 *    conversation, each replier follows (`replied`);
 *  - two people open the conversation at once (web): one creation, one id.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { channels, messages, serverMembers, tasks, threadFollows, users } from "../db/schema";
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
    name: `gaps-race-${randomUUID().slice(0, 6)}`,
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

/** Owner + member and two agents in one public channel (task v2 on), one lazy v2 task by the owner. */
async function setup(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Race ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `${slug}-${randomUUID().slice(0, 6)}`);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agentB = await createAgent(server.id, `${slug}-b-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const agentC = await createAgent(server.id, `${slug}-c-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agentB.id);
  await addAgent(channel.id, agentC.id);
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: `${slug} contested` }]);
  const [row] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
  assert.equal(row!.ownConversation, true, "a task v2 task");
  assert.equal(row!.conversationChannelId, null, "no conversation before the race");
  return {
    owner, member, server, channel, agentB, agentC, task: task!,
    keyB: await agentKey(agentB.id),
    keyC: await agentKey(agentC.id),
    board: `#${channel.name}`,
  };
}

async function taskConversations(taskId: string) {
  return getDb().select().from(channels).where(and(eq(channels.taskId, taskId), eq(channels.type, "task")));
}

async function followTriples(conversationId: string) {
  const rows = await getDb().select().from(threadFollows).where(eq(threadFollows.threadChannelId, conversationId));
  return rows.filter((row) => !row.unfollowedAt).map((row) => [row.followerType, row.followerId, row.reason]).sort();
}

test("F16 two agents claim the same v2 task at once: one claim succeeds, one conversation, only the winner follows", async ({ app }) => {
  const fx = await setup("claim-race");
  installRecordingOrchestrator(app.app);
  const claim = (key: string) => agentPost(app.baseUrl, key, "tasks/claim", { channel: fx.board, task_numbers: [fx.task.taskNumber] });

  const [byB, byC] = await Promise.all([claim(fx.keyB), claim(fx.keyC)]);
  assert.equal(byB.status, 200, JSON.stringify(byB.body));
  assert.equal(byC.status, 200, JSON.stringify(byC.body));
  const outcomes = [byB.body.results[0], byC.body.results[0]];
  assert.equal(outcomes.filter((result) => result.success === true).length, 1, `exactly one claim wins: ${JSON.stringify(outcomes)}`);
  const winner = byB.body.results[0].success ? fx.agentB : fx.agentC;
  const loserResult = byB.body.results[0].success ? byC.body.results[0] : byB.body.results[0];
  assert.equal(loserResult.success, false);
  assert.ok(loserResult.reason, "the losing claim says why");

  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, fx.task.id));
  assert.equal(row!.claimedByType, "agent");
  assert.equal(row!.claimedById, winner.id);
  assert.equal(row!.status, "in_progress", "claiming starts the task");
  await settle();
  const conversations = await taskConversations(fx.task.id);
  assert.equal(conversations.length, 1, "exactly one task conversation");
  assert.equal(row!.conversationChannelId, conversations[0]!.id);
  assert.deepEqual(
    await followTriples(conversations[0]!.id),
    [["agent", winner.id, "assigned"], ["user", fx.owner.id, "authored"]].sort(),
    "the creator follows from creation, the winner as assignee; the loser does not follow",
  );
});

test("two first replies race to create the conversation: one conversation, both replies in it, each replier follows", async ({ app }) => {
  const fx = await setup("reply-race");
  installRecordingOrchestrator(app.app);
  const reply = (key: string, content: string) => agentPost(app.baseUrl, key, "tasks/reply", {
    channel: fx.board, task_number: fx.task.taskNumber, content,
  });

  const [fromB, fromC] = await Promise.all([reply(fx.keyB, "first word from B"), reply(fx.keyC, "first word from C")]);
  for (const res of [fromB, fromC]) {
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "sent", JSON.stringify(res.body));
  }
  const conversations = await taskConversations(fx.task.id);
  assert.equal(conversations.length, 1, "exactly one task conversation");
  const conversationId = conversations[0]!.id;
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, fx.task.id));
  assert.equal(row!.conversationChannelId, conversationId);
  const stored = await getDb().select().from(messages).where(inArray(messages.id, [fromB.body.messageId, fromC.body.messageId]));
  assert.equal(stored.length, 2);
  assert.ok(stored.every((message) => message.channelId === conversationId), "both replies are in the one conversation");
  await settle();
  assert.deepEqual(
    await followTriples(conversationId),
    [["agent", fx.agentB.id, "replied"], ["agent", fx.agentC.id, "replied"], ["user", fx.owner.id, "authored"]].sort(),
  );
  const read = await agentGet(app.baseUrl, fx.keyB, `tasks/read?channel=${encodeURIComponent(fx.board)}&task_number=${fx.task.taskNumber}&after=0&limit=50`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const contents = (read.body.messages as Array<{ content: string }>).map((m) => m.content);
  for (const content of ["first word from B", "first word from C"]) {
    assert.ok(contents.some((c) => c.includes(content)), `task read shows "${content}"`);
  }
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, fx.channel.id)), [], "nothing in the channel itself");
});

test("two people open a lazy task's conversation at once (web): one creation, both get the same conversation", async ({ app }) => {
  const fx = await setup("open-race");
  const ownerToken = await login(app.baseUrl, fx.owner.email);
  const memberToken = await login(app.baseUrl, fx.member.email);
  const open = (token: string) => fetch(`${app.baseUrl}/api/tasks/${fx.task.id}/conversation`, {
    method: "POST",
    headers: humanHeaders(token, fx.server.id),
  });
  const [a, b] = await Promise.all([open(ownerToken), open(memberToken)]);
  assert.equal(a.status, 200, await a.clone().text());
  assert.equal(b.status, 200, await b.clone().text());
  const bodies = [await a.json(), await b.json()] as Array<{ conversationChannelId: string; created: boolean }>;
  assert.equal(bodies.filter((body) => body.created).length, 1, `one of them created it: ${JSON.stringify(bodies)}`);
  assert.equal(bodies[0]!.conversationChannelId, bodies[1]!.conversationChannelId);
  const conversations = await taskConversations(fx.task.id);
  assert.deepEqual(conversations.map((row) => row.id), [bodies[0]!.conversationChannelId]);
  assert.deepEqual(await followTriples(bodies[0]!.conversationChannelId), [["user", fx.owner.id, "authored"]], "opening follows nobody new");
});
