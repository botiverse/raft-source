import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2: a task conversation's Agent followers are managed exactly as a
 * thread's (GET /channels/threads/followers, DELETE .../followers/agents/:id,
 * POST .../restore). The task's creator stands where the thread's parent
 * author does; a channel manager may always manage. Thread behaviour is
 * covered unchanged in channels.threads.api.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentActivityEvents, serverMembers, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, canAgentReceiveChannelDelivery, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation, getTaskConversation, insertTaskConversationFollow } from "../services/taskConversationService";
import { installFakeIo } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 6)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user!;
}

function headers(token: string, serverId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

type Roster = { threads: Array<{ threadChannelId: string; canManage: boolean; agents: Array<{ id: string; canRemove?: boolean }> }> };

/**
 * Owner (server owner = channel manager), creator (ordinary member who
 * creates the task), bystander (ordinary member), and an Agent following the
 * task conversation.
 */
async function fixture(slug: string, createdBy: "creator" | "agent" = "creator") {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const creator = await seedUser(`${slug}-creator`);
  const bystander = await seedUser(`${slug}-bystander`);
  const server = await createServer(`Task followers ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: bystander.id, role: "member" },
  ]);
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, creator.id);
  await addHuman(channel.id, bystander.id);
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex" });
  // As in the thread test, the follower Agent is not a channel member unless
  // it creates the task, so its delivery is decided by the follow alone.
  if (createdBy === "agent") await addAgent(channel.id, agent.id);
  await enableTaskV2ConversationsForServer(server.id);

  const created = createdBy === "agent"
    ? await createTasks(channel.id, "agent", agent.id, [{ title: "agent-made task" }], { initiatingServerId: server.id })
    : await createTasks(channel.id, "user", creator.id, [{ title: "write the launch post" }], { initiatingServerId: server.id });
  const task = created.tasks[0]!;
  // Lazy, like a thread: creating the task creates no conversation; the
  // first action that needs it does (here: the test, as a follow would).
  assert.equal(await getTaskConversation(task.id), null, "creating a task creates no conversation");
  const conversation = (await ensureTaskConversation(task.id, { initiatingServerId: server.id }))?.conversation;
  assert.ok(conversation, "a flag-on task gets its conversation on first use");
  const conversationId = conversation.canonicalChannelId;
  await insertTaskConversationFollow(db, {
    conversationChannelId: conversationId,
    taskId: task.id,
    follower: { type: "agent", id: agent.id },
    reason: "manual",
    reactivateUnfollowed: true,
  });
  return {
    owner, creator, bystander, server, channel, agent, task, conversationId,
    ownerToken: await tokenForHuman(owner.email),
    creatorToken: await tokenForHuman(creator.email),
    bystanderToken: await tokenForHuman(bystander.email),
  };
}

test("task conversation Agent followers: the task creator and channel managers manage them as a thread author does", async ({ app }) => {
  const emittedEvents = installFakeIo(app.app);
  const db = getDb();
  const f = await fixture("tcf");
  const rosterUrl = `${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${f.conversationId}`;
  const removeUrl = `${app.baseUrl}/api/channels/threads/${f.conversationId}/followers/agents/${f.agent.id}`;
  const restoreUrl = `${removeUrl}/restore`;

  const activityBroadcasts: Array<{ agentId: string; event: { title: string; text: string; dedupeKey?: string } }> = [];
  const agentOrchestrator = app.app.get("agentOrchestrator") as {
    recordAgentRaftAction: (agentId: string, event: { title: string; text: string; producerFactId?: string; dedupeKey?: string }) => Promise<void>;
  };
  agentOrchestrator.recordAgentRaftAction = async (agentId, event) => {
    activityBroadcasts.push({ agentId, event });
  };

  // The roster answers for a task conversation (it used to be thread-only: 404).
  let response = await fetch(rosterUrl, { headers: headers(f.bystanderToken, f.server.id) });
  assert.equal(response.status, 200, await response.clone().text());
  let roster = await response.json() as Roster;
  assert.equal(roster.threads[0]?.threadChannelId, f.conversationId);
  assert.equal(roster.threads[0]?.canManage, false, "an ordinary member gets a read-only roster");
  assert.deepEqual(roster.threads[0]?.agents.map((agent) => agent.id), [f.agent.id]);

  response = await fetch(rosterUrl, { headers: headers(f.creatorToken, f.server.id) });
  roster = await response.json() as Roster;
  assert.equal(roster.threads[0]?.canManage, true, "the task creator manages its followers");
  assert.equal(roster.threads[0]?.agents[0]?.canRemove, true);

  response = await fetch(removeUrl, { method: "DELETE", headers: headers(f.bystanderToken, f.server.id) });
  assert.equal(response.status, 403, "an ordinary member cannot remove an Agent follower");
  assert.match(((await response.json()) as { error: string }).error, /task creator or a channel manager/);

  response = await fetch(removeUrl, { method: "DELETE", headers: headers(f.creatorToken, f.server.id) });
  assert.equal(response.status, 200, await response.clone().text());
  const removal = await response.json() as { removed: boolean; undoToken: string | null };
  assert.equal(removal.removed, true);
  assert.ok(removal.undoToken);
  assert.equal(await canAgentReceiveChannelDelivery(f.conversationId, f.agent.id), false);
  assert.deepEqual(
    emittedEvents.filter((event) => event.event === "thread:followers-updated"),
    [{ room: `channel:${f.conversationId}`, event: "thread:followers-updated", payload: { threadChannelId: f.conversationId } }],
  );

  // The receipt in the Agent's Activity names the task, not a thread.
  const activity = (await db.select().from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, f.agent.id))
    .orderBy(agentActivityEvents.createdAt))
    .filter((event) => event.dedupeKey?.includes(f.conversationId));
  assert.equal(activity.length, 1);
  const entry = activity[0]?.entries.find((item) => item.kind === "slock_action");
  assert.equal(entry?.kind, "slock_action");
  if (entry?.kind === "slock_action") {
    assert.equal(entry.title, "Removed from task followers");
    assert.match(entry.text, new RegExp(`task: #${f.channel.name}:#${f.task.taskNumber}`));
    assert.match(entry.text, /ordinary task updates stopped/i);
    assert.match(entry.text, /follow the task again/i);
  }
  assert.equal(activityBroadcasts.length, 1);
  assert.equal(activityBroadcasts[0]?.agentId, f.agent.id);

  response = await fetch(rosterUrl, { headers: headers(f.ownerToken, f.server.id) });
  roster = await response.json() as Roster;
  assert.equal(roster.threads[0]?.canManage, true, "a channel manager manages any task's followers");
  assert.deepEqual(roster.threads[0]?.agents, [], "a removed Agent leaves the current roster");

  response = await fetch(restoreUrl, {
    method: "POST",
    headers: headers(f.bystanderToken, f.server.id),
    body: JSON.stringify({ undoToken: removal.undoToken }),
  });
  assert.equal(response.status, 403, "an ordinary member cannot restore either");

  response = await fetch(restoreUrl, {
    method: "POST",
    headers: headers(f.ownerToken, f.server.id),
    body: JSON.stringify({ undoToken: removal.undoToken }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, restored: true });
  assert.equal(await canAgentReceiveChannelDelivery(f.conversationId, f.agent.id), true);
  const restoredEntry = activityBroadcasts[1]?.event;
  assert.equal(restoredEntry?.title, "Restored to task followers");
  assert.match(restoredEntry?.text ?? "", /task updates resumed/i);
});

test("an Agent-created task: no member is its author, so only a channel manager manages its followers", async ({ app }) => {
  installFakeIo(app.app);
  const f = await fixture("tca", "agent");
  const rosterUrl = `${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${f.conversationId}`;
  const removeUrl = `${app.baseUrl}/api/channels/threads/${f.conversationId}/followers/agents/${f.agent.id}`;

  let response = await fetch(rosterUrl, { headers: headers(f.creatorToken, f.server.id) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as Roster).threads[0]?.canManage, false);

  response = await fetch(removeUrl, { method: "DELETE", headers: headers(f.creatorToken, f.server.id) });
  assert.equal(response.status, 403);

  response = await fetch(removeUrl, { method: "DELETE", headers: headers(f.ownerToken, f.server.id) });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { removed: boolean }).removed, true);
});

test("task conversation follower routes stay scoped to the caller's server", async ({ app }) => {
  installFakeIo(app.app);
  const f = await fixture("tcs");
  const other = await seedUser("tcs-other");
  const otherServer = await createServer("Other", `tcs-other-${randomUUID().slice(0, 8)}`, other.id);
  const otherToken = await tokenForHuman(other.email);

  const response = await fetch(`${app.baseUrl}/api/channels/threads/followers?threadChannelIds=${f.conversationId}`, {
    headers: headers(otherToken, otherServer.id),
  });
  assert.equal(response.status, 404, "another server cannot see the task conversation's roster");
  const removal = await fetch(`${app.baseUrl}/api/channels/threads/${f.conversationId}/followers/agents/${f.agent.id}`, {
    method: "DELETE",
    headers: headers(otherToken, otherServer.id),
  });
  assert.equal(removal.status, 404);
});
