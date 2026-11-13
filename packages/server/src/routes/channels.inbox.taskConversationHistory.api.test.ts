/**
 * Task v2: a task conversation's Done / Unfollowed history is Activity history
 * like a thread's. Done on a followed task conversation moves it to
 * GET /channels/inbox/done (kind "task", the task's identity, no parent
 * message); an explicit unfollow lists it in GET /channels/inbox/unfollowed
 * and in Activity All's unfollowed rows (includeUnfollowedThreads). Flag off
 * for the reader's server: threads only, as before.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { featureFlagRules, serverMembers, servers, users } from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation } from "../services/taskConversationService";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";

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

async function fixture(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`History ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await enableTaskV2ConversationsForServer(server.id);
  const created = await createTasks(channel.id, "user", owner.id, [{ title: `ship the ${slug} page` }], { initiatingServerId: server.id });
  const task = created.tasks[0]!;
  // Task conversations are lazy (like threads): the first action that needs
  // it creates it, and its creation makes the creator follow (`authored`).
  assert.equal(task.conversationChannelId, null, "creating a task creates no conversation");
  const conversation = (await ensureTaskConversation(task.id, { initiatingServerId: server.id }))!.conversation;
  assert.ok(conversation, "the first use creates the conversation");
  await createMessage(conversation.canonicalChannelId, "user", member.id, "first draft is up");
  return { owner, member, server, channel, task, conversationId: conversation.canonicalChannelId };
}

async function get(baseUrl: string, path: string, token: string, serverId: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: headers(token, serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { items: any[] };
}

async function post(baseUrl: string, path: string, token: string, serverId: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: headers(token, serverId), body: JSON.stringify(body) });
  assert.ok(res.status < 300, `${path}: ${res.status} ${await res.clone().text()}`);
}

test("a done task conversation is in Done history as a kind 'task' row, and leaves the active list", async ({ app }) => {
  const { owner, server, channel, task, conversationId } = await fixture("done");
  const token = await tokenForHuman(owner.email);

  const before = await get(app.baseUrl, "/api/channels/inbox?filter=all&limit=50", token, server.id);
  assert.ok(before.items.some((item) => item.kind === "task" && item.threadChannelId === conversationId), "active before Done");

  await post(app.baseUrl, "/api/channels/threads/done", token, server.id, { threadChannelId: conversationId });

  const active = await get(app.baseUrl, "/api/channels/inbox?filter=all&limit=50", token, server.id);
  assert.equal(active.items.some((item) => item.threadChannelId === conversationId), false, "Done leaves the active list");

  const done = await get(app.baseUrl, "/api/channels/inbox/done?limit=50", token, server.id);
  const row = done.items.find((item) => item.threadChannelId === conversationId);
  assert.ok(row, "the done task conversation is in Done history");
  assert.equal(row.kind, "task");
  assert.equal(row.taskId, task.id);
  assert.equal(row.taskNumber, task.taskNumber);
  assert.equal(row.taskTitle, "ship the done page");
  assert.equal(row.parentMessageId, null);
  assert.equal(row.parentChannelId, channel.id);
  assert.equal(row.replyCount, 1);
  assert.equal(row.unreadCount, 0);
  assert.ok(row.doneAt, "carries its Done time");
  assert.equal(row.latestActivityPreview, "first draft is up");

  // The channel facet filters it by its parent channel, search by the task title.
  const faceted = await get(app.baseUrl, `/api/channels/inbox/done?limit=50&channelId=${channel.id}`, token, server.id);
  assert.ok(faceted.items.some((item) => item.threadChannelId === conversationId));
  const searched = await get(app.baseUrl, "/api/channels/inbox/done?limit=50&q=ship%20the%20done", token, server.id);
  assert.ok(searched.items.some((item) => item.threadChannelId === conversationId));
});

test("an unfollowed task conversation is in the Unfollowed history and Activity All's unfollowed rows", async ({ app }) => {
  const { owner, server, task, conversationId } = await fixture("unf");
  const token = await tokenForHuman(owner.email);

  await post(app.baseUrl, "/api/channels/threads/unfollow", token, server.id, { threadChannelId: conversationId });

  const unfollowed = await get(app.baseUrl, "/api/channels/inbox/unfollowed?limit=50", token, server.id);
  const row = unfollowed.items.find((item) => item.threadChannelId === conversationId);
  assert.ok(row, "the unfollowed task conversation is in the Unfollowed history");
  assert.equal(row.kind, "task");
  assert.equal(row.taskId, task.id);
  assert.equal(row.isFollowing, false);
  assert.ok(row.unfollowedAt);

  const all = await get(app.baseUrl, "/api/channels/inbox?filter=all&limit=50&includeUnfollowedThreads=true", token, server.id);
  const allRow = all.items.find((item) => item.threadChannelId === conversationId);
  assert.ok(allRow, "Activity All lists the unfollowed, not-done task conversation");
  assert.equal(allRow.kind, "task");
  assert.equal(allRow.isFollowing, false);
});

test("flag off for the reader's server (rollback): a v2 task's conversation stays in the Done history (per-task mode)", async ({ app }) => {
  const { owner, server, conversationId } = await fixture("off");
  const token = await tokenForHuman(owner.email);
  await post(app.baseUrl, "/api/channels/threads/done", token, server.id, { threadChannelId: conversationId });
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY));

  const done = await get(app.baseUrl, "/api/channels/inbox/done?limit=50", token, server.id);
  assert.equal(done.items.find((item) => item.threadChannelId === conversationId)?.kind, "task");
});

test("on a Free server, Activity search still finds a task conversation by its title (the history window cuts messages, not titles)", async ({ app }) => {
  const { owner, server, conversationId } = await fixture("free-search");
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  const token = await tokenForHuman(owner.email);
  for (const filter of ["all", "unread"]) {
    const searched = await get(app.baseUrl, `/api/channels/inbox?filter=${filter}&limit=50&q=ship%20the%20free-search`, token, server.id);
    const row = searched.items.find((item) => item.threadChannelId === conversationId);
    assert.ok(row, `found by its title (${filter})`);
    assert.equal(row.kind, "task");
  }
});
