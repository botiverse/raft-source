import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 (decided 2026-10-21): whoever takes a task follows its conversation,
 * the same as an assignee (reason `assigned`, no notification). Paths: the web
 * claim route, web / agent assign-to-self ("took"), agent `raft task claim`
 * (by number). Like assignment by someone else, claiming reactivates an
 * explicit unfollow (personal attention, as a direct @mention is). A task
 * without a conversation gets one first on a flag-on initiating server (the
 * follow lands on it); flag off: nothing changes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { messageMentions, serverMembers, tasks, threadFollows, users } from "../db/schema";
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

/** Owner (task creator) + member + an agent in one public channel; tasks are created by the owner. */
async function setup(slug: string, opts: { taskV2?: boolean } = {}) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`ClaimFollow ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${slug}-bot-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);
  if (opts.taskV2 !== false) await enableTaskV2ConversationsForServer(server.id);
  const newTask = async (title: string) => {
    const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title }]);
    return task!;
  };
  return { owner, member, agent, server, channel, newTask };
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["send", "read", "tasks", "channels"],
    name: `claim-follow-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer", createdByUserId: null,
  });
  return apiKey;
}

type AgentBody = { [key: string]: unknown; results: Array<{ success: boolean }>; changed?: boolean };

async function agentPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as AgentBody };
}

async function conversationId(taskId: string): Promise<string | null> {
  const [row] = await getDb().select({ id: tasks.conversationChannelId }).from(tasks).where(eq(tasks.id, taskId));
  return row?.id ?? null;
}

async function followRow(taskId: string, followerType: "user" | "agent", followerId: string) {
  const id = await conversationId(taskId);
  if (!id) return null;
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, id),
    eq(threadFollows.followerType, followerType),
    eq(threadFollows.followerId, followerId),
  ));
  return row ?? null;
}

async function activeFollowReason(taskId: string, followerType: "user" | "agent", followerId: string) {
  const row = await followRow(taskId, followerType, followerId);
  return row && !row.unfollowedAt ? row.reason : null;
}

test("web claim (v2): the claimer follows the task conversation as `assigned`, without a mention", async ({ app }) => {
  const { member, server, newTask } = await setup("web-claim");
  installRecordingOrchestrator(app.app);
  const task = await newTask("claim me");
  const token = await login(app.baseUrl, member.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, { method: "PATCH", headers: humanHeaders(token, server.id) });
  assert.equal(res.status, 200, await res.clone().text());

  assert.equal(
    await waitFor("claimer follow", () => activeFollowReason(task.id, "user", member.id)),
    "assigned",
  );
  const mentions = await getDb().select().from(messageMentions).where(and(
    eq(messageMentions.targetType, "user"),
    eq(messageMentions.targetId, member.id),
  ));
  assert.deepEqual(mentions, [], "taking a task yourself notifies nobody");
});

test("web assign to yourself (\"took\"): you follow as `assigned`", async ({ app }) => {
  const { member, server, newTask } = await setup("web-took");
  installRecordingOrchestrator(app.app);
  const task = await newTask("take me");
  const token = await login(app.baseUrl, member.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(token, server.id),
    body: JSON.stringify({ assignee: { type: "user", id: member.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await waitFor("self-assign follow", () => activeFollowReason(task.id, "user", member.id)), "assigned");
});

test("agent raft task claim (by number) and agent assign-to-self: the agent follows as `assigned`, never woken by it", async ({ app }) => {
  const { agent, channel, newTask } = await setup("agent-claim");
  const deliveries = installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);

  const claimed = await newTask("agent claims");
  const claim = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [claimed.taskNumber] });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  // The claim route answers after the follow is written.
  assert.equal(await activeFollowReason(claimed.id, "agent", agent.id), "assigned");

  const took = await newTask("agent takes");
  const assign = await agentPost(app.baseUrl, key, "tasks/assign", {
    channel: `#${channel.name}`, task_number: took.taskNumber, assignee: `@${agent.name}`,
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  assert.equal(await waitFor("agent self-assign follow", () => activeFollowReason(took.id, "agent", agent.id)), "assigned");

  await settle();
  assert.equal(deliveries.some((d) => d.agentId === agent.id && d.payload.mentioned === true), false);
});

test("an explicit unfollow is reactivated by claiming, and by being assigned by someone else", async ({ app }) => {
  const { owner, agent, server, channel, newTask } = await setup("claim-unfollowed");
  installRecordingOrchestrator(app.app);
  const key = await agentKey(agent.id);
  const leave = async (taskNumber: number) => {
    const ref = { channel: `#${channel.name}`, task_number: taskNumber };
    assert.equal((await agentPost(app.baseUrl, key, "tasks/follow", ref)).status, 200);
    const unfollow = await agentPost(app.baseUrl, key, "tasks/unfollow", ref);
    assert.equal(unfollow.status, 200, JSON.stringify(unfollow.body));
    assert.equal(unfollow.body.changed, true);
  };

  const claimed = await newTask("followed, left, then claimed");
  await leave(claimed.taskNumber);
  assert.ok((await followRow(claimed.id, "agent", agent.id))?.unfollowedAt, "unfollowed before the claim");
  const claim = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [claimed.taskNumber] });
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  // The claim route answers after the follow is written.
  const afterClaim = await followRow(claimed.id, "agent", agent.id);
  assert.ok(afterClaim, "the claimer has a follow row");
  assert.equal(afterClaim.unfollowedAt, null, "claiming follows it again");

  const assigned = await newTask("followed, left, then assigned");
  await leave(assigned.taskNumber);
  const token = await login(app.baseUrl, owner.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${assigned.id}/assignee`, {
    method: "PATCH",
    headers: humanHeaders(token, server.id),
    body: JSON.stringify({ assignee: { type: "agent", id: agent.id } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  // The follow is written with the (async) assignment line.
  await waitFor("assignee follows again", () => activeFollowReason(assigned.id, "agent", agent.id));
});

test("pre-v2 task on a flag-on server: the claim gives it its conversation and the claimer follows it", async ({ app }) => {
  const { agent, server, channel, newTask } = await setup("claim-lazy", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const task = await newTask("from before task v2");
  assert.equal(await conversationId(task.id), null);
  await enableTaskV2ConversationsForServer(server.id);

  const key = await agentKey(agent.id);
  const claim = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [task.taskNumber] });
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  assert.ok(await conversationId(task.id), "the claim created the conversation");
  assert.equal(await activeFollowReason(task.id, "agent", agent.id), "assigned");
});

test("flag off: claiming creates no conversation and no follow", async ({ app }) => {
  const { member, agent, server, channel, newTask } = await setup("claim-off", { taskV2: false });
  installRecordingOrchestrator(app.app);
  const webTask = await newTask("web claim, flag off");
  const token = await login(app.baseUrl, member.email);
  const res = await fetch(`${app.baseUrl}/api/tasks/${webTask.id}/claim`, { method: "PATCH", headers: humanHeaders(token, server.id) });
  assert.equal(res.status, 200, await res.clone().text());

  const agentTask = await newTask("agent claim, flag off");
  const key = await agentKey(agent.id);
  const claim = await agentPost(app.baseUrl, key, "tasks/claim", { channel: `#${channel.name}`, task_numbers: [agentTask.taskNumber] });
  assert.equal(claim.body.results[0].success, true, JSON.stringify(claim.body));
  await settle();

  assert.equal(await conversationId(webTask.id), null);
  assert.equal(await conversationId(agentTask.id), null);
});
