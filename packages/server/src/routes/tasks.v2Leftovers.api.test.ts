import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 phase 2a (server leftovers): the surfaces that list or act on
 * sub-conversations treat a task conversation (`channels.type = 'task'`) like
 * a thread, with the task in place of the parent message.
 *  - web followed-threads list: followed task conversations, `kind: "task"`
 *    (flag on for the reader's server; joint: the reader's local projection);
 *  - channel Files card: attachments posted in the channel's task conversations;
 *  - mention actions (notify / add an outsider) inside a task conversation;
 *  - saved items and forwarding labels name the task;
 *  - web follow bell / Done / read on a task conversation id, `conversationFollowed`
 *    on the task DTO, task identity on search hits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channelHumans,
  featureFlagRules,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  servers,
  tasks,
  threadFollows,
  users,
} from "../db/schema";
import { addHuman, createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { searchMessagesForUser } from "../services/searchService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation, getTaskConversation, insertTaskConversationFollow } from "../services/taskConversationService";

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

async function disableTaskV2Conversations() {
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY));
}

/**
 * A flag-on task with its conversation; returns the task and its conversation
 * faces. Task conversations are lazy: creating the task creates none, so the
 * first use (here: ensureTaskConversation, as a reply / follow / lifecycle
 * line would) creates it, with the creator following (`authored`).
 */
async function createTaskWithConversation(storageChannelId: string, creatorId: string, title: string, initiatingServerId: string) {
  const created = await createTasks(storageChannelId, "user", creatorId, [{ title }], { initiatingServerId });
  const task = created.tasks[0]!;
  assert.equal(task.conversationChannelId, null, "creating a task creates no conversation");
  assert.equal(await getTaskConversation(task.id), null);
  const ensured = await ensureTaskConversation(task.id, { initiatingServerId, createdByUserId: creatorId });
  assert.ok(ensured?.created, "the first use creates the task's conversation");
  const conversation = await getTaskConversation(task.id);
  assert.ok(conversation);
  return { task: { ...task, conversationChannelId: conversation!.canonicalChannelId }, conversation: conversation! };
}

async function ordinaryFixture(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Leftovers ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await enableTaskV2ConversationsForServer(server.id);
  return { owner, member, server, channel };
}

async function jointFixture(slug: string) {
  const db = getDb();
  const hostOwner = await seedUser(`${slug}-host-owner`);
  const peerOwner = await seedUser(`${slug}-peer-owner`);
  const peerMember = await seedUser(`${slug}-peer-member`);
  const hostServer = await createServer("Leftovers Host", `${slug}-host-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Leftovers Peer", `${slug}-peer-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const roomName = `${slug}-room`;
  const storage = await createChannel(hostServer.id, `${roomName}-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, roomName, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, roomName, undefined, "joint");
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: storage.id,
    createdByServerId: hostServer.id,
    createdByUserId: hostOwner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host", joinedByUserId: hostOwner.id },
    { jointChannelId: joint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant", joinedByUserId: peerOwner.id },
  ]);
  await db.insert(serverMembers).values({ serverId: peerServer.id, userId: peerMember.id, role: "member" });
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerOwner.id);
  await addHuman(peerProjection.id, peerMember.id);
  await enableTaskV2ConversationsForServer(hostServer.id);
  await enableTaskV2ConversationsForServer(peerServer.id);
  return { hostOwner, peerOwner, peerMember, hostServer, peerServer, storage, hostProjection, peerProjection, parentJointId: joint!.id };
}

async function followed(baseUrl: string, email: string, serverId: string) {
  const res = await fetch(`${baseUrl}/api/channels/threads/followed`, { headers: headers(await tokenForHuman(email), serverId) });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { threads: any[] }).threads;
}

// stdrc 2026-10-31 (#triage:c3f04178): a task discussion's unread shows in
// Activity only. The sidebar summary (the mobile app's thread count and pill)
// must not fold it onto the channel, or it is an unread nobody can clear there.
test("unread summary: an unread task conversation keeps its entry but is not counted toward its channel's threads", async ({ app }) => {
  const { owner, member, server, channel } = await ordinaryFixture("sum");
  const { conversation } = await createTaskWithConversation(channel.id, owner.id, "fix the onboarding copy", server.id);
  await createMessage(conversation.canonicalChannelId, "user", member.id, "a reply in the task");

  const res = await fetch(`${app.baseUrl}/api/channels/unread?summary=1`, { headers: headers(await tokenForHuman(owner.email), server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  const summary = await res.json() as {
    channels: Record<string, { unreadCount: number; parentChannelId?: string }>;
    threadUnread: Record<string, { count: number }>;
  };
  assert.equal(summary.channels[conversation.canonicalChannelId]?.unreadCount, 1, "the task conversation keeps its own unread entry");
  assert.equal(summary.channels[conversation.canonicalChannelId]?.parentChannelId, undefined, "it is not folded onto the channel");
  assert.equal(summary.threadUnread[channel.id], undefined, "the channel shows no thread unread for it");
});

test("followed threads list: a followed task conversation is a kind 'task' row, still listed with the flag off (per-task mode)", async ({ app }) => {
  const { owner, member, server, channel } = await ordinaryFixture("fol");
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "write the launch post", server.id);
  const reply = await createMessage(conversation.canonicalChannelId, "user", member.id, "first draft attached");

  const rows = await followed(app.baseUrl, owner.email, server.id);
  const row = rows.find((thread) => thread.threadChannelId === conversation.canonicalChannelId);
  assert.ok(row, "the creator follows the task conversation from creation, so it is listed");
  assert.equal(row.kind, "task");
  assert.equal(row.taskId, task.id);
  assert.equal(row.taskNumber, task.taskNumber);
  assert.equal(row.taskTitle, "write the launch post");
  assert.equal(row.parentMessagePreview, "write the launch post");
  assert.equal(row.parentMessageId, null, "a task conversation has no parent message");
  assert.equal(row.parentChannelId, channel.id);
  assert.equal(row.parentChannelName, channel.name);
  assert.equal(row.replyCount, 1);
  assert.equal(row.unreadCount, 1);
  assert.equal(row.latestActivityMessageId, reply.id);
  assert.equal(row.isFollowing, true);
  // Its place in the channel: the message it hangs under (none here).
  assert.equal(row.sourceMessageId, null);
  assert.equal(row.sourceMessageCreatedAt, null);

  // Hung under an earlier message: that message and its time (not the
  // task's), so the channel's unread pill places the task there.
  const source = await createMessage(channel.id, "user", member.id, "the request");
  await getDb().update(tasks).set({ sourceMessageId: source.id }).where(eq(tasks.id, task.id));
  const sourced = (await followed(app.baseUrl, owner.email, server.id))
    .find((thread) => thread.threadChannelId === conversation.canonicalChannelId);
  assert.equal(sourced?.sourceMessageId, source.id);
  assert.equal(sourced?.sourceMessageCreatedAt, new Date(source.createdAt).toISOString());

  // A followed thread is listed beside it and keeps its shape (no `kind`).
  const parent = await createMessage(channel.id, "user", owner.id, "a plain thread root");
  const { getOrCreateThread } = await import("../services/channelService");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await createMessage(thread.id, "user", member.id, "thread reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id, followerType: "user", followerId: owner.id, parentMessageId: parent.id, reason: "authored",
  }).onConflictDoNothing();
  const withThread = await followed(app.baseUrl, owner.email, server.id);
  const threadRow = withThread.find((entry) => entry.threadChannelId === thread.id);
  assert.ok(threadRow, "the thread is listed too");
  assert.equal("kind" in threadRow, false, "thread rows are unchanged");

  // Flag off for the reader's server (rollback): a v2 task keeps its
  // conversation, so it stays listed beside the thread.
  await disableTaskV2Conversations();
  const off = await followed(app.baseUrl, owner.email, server.id);
  assert.equal(off.find((entry) => entry.threadChannelId === conversation.canonicalChannelId)?.kind, "task");
  assert.ok(off.some((entry) => entry.threadChannelId === thread.id));
});

test("followed threads list on a joint channel: the peer reader sees its local task conversation under its local channel", async ({ app }) => {
  const fx = await jointFixture("foljoint");
  const { task, conversation } = await createTaskWithConversation(fx.storage.id, fx.hostOwner.id, "joint launch copy", fx.hostServer.id);
  const peerLocal = conversation.localByServer.get(fx.peerServer.id)!;
  assert.ok(peerLocal, "the peer server has a local task conversation");
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: peerLocal.localChannelId,
    taskId: task.id,
    follower: { type: "user", id: fx.peerMember.id },
    reason: "manual",
  });
  await createMessage(conversation.canonicalChannelId, "user", fx.hostOwner.id, "copy v1 is up");

  const rows = await followed(app.baseUrl, fx.peerMember.email, fx.peerServer.id);
  const row = rows.find((thread) => thread.kind === "task");
  assert.ok(row, "the peer member's followed task conversation is listed");
  assert.equal(row.threadChannelId, peerLocal.localChannelId, "keyed by the reader's local conversation");
  assert.equal(row.parentChannelId, fx.peerProjection.id, "parent = the reader server's local joint channel");
  assert.equal(row.taskNumber, task.taskNumber);
  assert.equal(row.replyCount, 1, "stats read the canonical conversation");
  assert.equal(row.unreadCount, 1);

  const hostRows = await followed(app.baseUrl, fx.hostOwner.email, fx.hostServer.id);
  const hostRow = hostRows.find((thread) => thread.kind === "task");
  assert.equal(hostRow?.threadChannelId, conversation.localByServer.get(fx.hostServer.id)!.localChannelId);
  assert.equal(hostRow?.unreadCount, 0, "the author's own reply is not unread");
});

test("channel Files card lists attachments posted in the channel's task conversations, whatever the reader's flag", async ({ app }) => {
  const db = getDb();
  const { owner, server, channel } = await ordinaryFixture("files");
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "collect screenshots", server.id);
  const reply = await createMessage(conversation.canonicalChannelId, "user", owner.id, "screenshot");
  await insertAttachmentsWithObjects(db, {
    id: randomUUID(),
    messageId: reply.id,
    channelId: conversation.canonicalChannelId,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "task-shot.png",
    mimeType: "image/png",
    sizeBytes: 42,
    storageKey: "attachments/task-shot.png",
  });
  const token = await tokenForHuman(owner.email);
  const list = async () => {
    const res = await fetch(`${app.baseUrl}/api/channels/${channel.id}/files`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { files: any[] }).files;
  };
  const files = await list();
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, "task-shot.png");
  assert.deepEqual(files[0].source, {
    type: "task",
    channelId: conversation.canonicalChannelId,
    parentMessageId: null,
    parentMessageShortId: null,
    taskId: task.id,
    taskNumber: task.taskNumber,
  });

  // Rollback: the task conversation's files stay listed (per-task mode).
  await disableTaskV2Conversations();
  assert.deepEqual((await list()).map((file: any) => file.filename), ["task-shot.png"]);
});

test("mention actions inside a task conversation: notify an outsider (task fact), add an outsider (joins the channel, follows the task)", async ({ app }) => {
  const db = getDb();
  const { owner, server, channel } = await ordinaryFixture("mact");
  const notified = await seedUser("mact-notified");
  const added = await seedUser("mact-added");
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: notified.id, role: "member" },
    { serverId: server.id, userId: added.id, role: "member" },
  ]);
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "pick a launch date", server.id);
  const token = await tokenForHuman(owner.email);
  const send = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ channelId: conversation.canonicalChannelId, content: `@${notified.name} @${added.name} can you weigh in?` }),
  });
  assert.equal(send.status, 200, await send.clone().text());
  const sent = await send.json() as { message: { id: string }; pendingMentionActions?: Array<{ resolutionId: string; availableActions: string[] }> };
  assert.equal(sent.pendingMentionActions?.length, 2, "both outsiders are pending mention actions");
  const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, sent.message.id));
  const resolutionFor = (userId: string) => mentionRows.find((row) => row.targetId === userId)!.id;

  const execute = async (action: "notify" | "add", resolutionId: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/mention-actions/execute`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ action, resolutionIds: [resolutionId] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { results: Array<{ status: string; reason?: string }> }).results[0]!;
  };

  const notify = await execute("notify", resolutionFor(notified.id));
  assert.equal(notify.status, "queued", JSON.stringify(notify));
  const facts = await db.select().from(inboxNotificationFacts).where(and(
    eq(inboxNotificationFacts.messageId, sent.message.id),
    eq(inboxNotificationFacts.receiverId, notified.id),
  ));
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.personalMention, fact.sourceChannelId]), [["task", true, conversation.canonicalChannelId]]);

  const add = await execute("add", resolutionFor(added.id));
  assert.equal(add.status, "delivered", JSON.stringify(add));
  const [membership] = await db.select().from(channelHumans).where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, added.id)));
  assert.ok(membership, "add joins the task's parent channel");
  const [follow] = await db.select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversation.canonicalChannelId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, added.id),
  ));
  assert.equal(follow?.reason, "mentioned");
  assert.equal(follow?.parentTaskId, task.id);
  assert.equal(follow?.parentMessageId, null);
});

test("saving in a task conversation follows it with reason saved; a reply then makes it the person's, so unsaving keeps it", async ({ app }) => {
  const { owner, member, server, channel } = await ordinaryFixture("savedreply");
  const { conversation } = await createTaskWithConversation(channel.id, owner.id, "keep me posted", server.id);
  const conversationId = conversation.canonicalChannelId;
  const message = await createMessage(conversationId, "user", owner.id, "worth keeping");
  const token = await tokenForHuman(member.email);
  const memberFollow = async () => (await getDb()
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, conversationId),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, member.id),
    )))[0] ?? null;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.baseUrl}/api${path}`, {
      method, headers: headers(token, server.id), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`);
  };

  await call("POST", "/channels/saved", { messageId: message.id });
  assert.deepEqual(await memberFollow(), { reason: "saved", unfollowedAt: null });

  // A task-conversation reply keeps an active follow's reason, except 'saved'.
  await call("POST", "/messages", { channelId: conversationId, content: "my reply" });
  assert.equal((await memberFollow())?.reason, "replied");

  await call("DELETE", `/channels/saved/${message.id}`);
  assert.deepEqual(await memberFollow(), { reason: "replied", unfollowedAt: null }, "the reply's follow stays");
});

test("saved items: a task-conversation message saves and lists with its task and parent channel (ordinary and joint)", async ({ app }) => {
  const { owner, server, channel } = await ordinaryFixture("saved");
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "save me", server.id);
  const reply = await createMessage(conversation.canonicalChannelId, "user", owner.id, "worth keeping");
  const token = await tokenForHuman(owner.email);
  const save = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST", headers: headers(token, server.id), body: JSON.stringify({ messageId: reply.id }),
  });
  assert.equal(save.status, 200, await save.clone().text());
  const listRes = await fetch(`${app.baseUrl}/api/channels/saved`, { headers: headers(token, server.id) });
  const list = (await listRes.json()) as { saved: any[]; total: number };
  assert.equal(list.total, 1);
  const [entry] = list.saved;
  assert.equal(entry.messageId, reply.id);
  assert.equal(entry.channelType, "task");
  assert.equal(entry.taskId, task.id);
  assert.equal(entry.taskNumber, task.taskNumber);
  assert.equal(entry.taskTitle, "save me");
  assert.equal(entry.parentChannelId, channel.id);
  assert.equal(entry.parentChannelName, channel.name);
  assert.equal(entry.replyCount, 1);
  const filtered = await fetch(`${app.baseUrl}/api/channels/saved?channelId=${channel.id}`, { headers: headers(token, server.id) });
  assert.equal(((await filtered.json()) as { total: number }).total, 1, "the channel filter finds it under its parent channel");

  const fx = await jointFixture("savedjoint");
  const joint = await createTaskWithConversation(fx.storage.id, fx.hostOwner.id, "joint save", fx.hostServer.id);
  const jointReply = await createMessage(joint.conversation.canonicalChannelId, "user", fx.hostOwner.id, "joint keep");
  const peerToken = await tokenForHuman(fx.peerMember.email);
  const peerSave = await fetch(`${app.baseUrl}/api/channels/saved`, {
    method: "POST", headers: headers(peerToken, fx.peerServer.id), body: JSON.stringify({ messageId: jointReply.id }),
  });
  assert.equal(peerSave.status, 200, await peerSave.clone().text());
  const peerList = (await (await fetch(`${app.baseUrl}/api/channels/saved`, { headers: headers(peerToken, fx.peerServer.id) })).json()) as { saved: any[] };
  assert.equal(peerList.saved[0]?.channelId, joint.conversation.localByServer.get(fx.peerServer.id)!.localChannelId, "the peer's local task conversation");
  assert.equal(peerList.saved[0]?.parentChannelId, fx.peerProjection.id, "the peer's local joint channel");
  assert.equal(peerList.saved[0]?.taskNumber, joint.task.taskNumber);
});

test("forwarding a task-conversation message labels the source with the task ref", async ({ app }) => {
  const db = getDb();
  const { owner, server, channel } = await ordinaryFixture("fwd");
  const destination = await createChannel(server.id, `fwd-dest-${randomUUID().slice(0, 6)}`);
  await addHuman(destination.id, owner.id);
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "forward me", server.id);
  const reply = await createMessage(conversation.canonicalChannelId, "user", owner.id, "the decision");
  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ destinationChannelId: destination.id, sourceMessageIds: [reply.id], note: "" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const [forwarded] = await db.select().from(messages).where(eq(messages.channelId, destination.id));
  const item = (forwarded!.actionMetadata as { forwardedItems: any[] }).forwardedItems[0];
  assert.deepEqual(item.sourceTargetSnapshot, {
    id: channel.id,
    type: "task",
    label: `#${channel.name}:#${task.taskNumber}`,
    labelVisibility: "public",
  });
  assert.equal(item.sourceTargetId, conversation.canonicalChannelId);
  assert.equal(item.parentChannelId, channel.id);
  assert.equal(item.sourceTaskId, task.id);
  assert.equal(item.sourceTaskNumber, task.taskNumber);
  assert.equal(item.sourceMessageId, reply.id);
});

test("follow bell, Done and read accept a task conversation id; the task DTO serves conversationFollowed (ordinary and joint)", async ({ app }) => {
  const db = getDb();
  const { owner, member, server, channel } = await ordinaryFixture("bell");
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "ring the bell", server.id);
  const conversationId = conversation.canonicalChannelId;
  const memberToken = await tokenForHuman(member.email);
  const ownerToken = await tokenForHuman(owner.email);
  const followedFlag = async (token: string, serverId: string, localChannelId: string, taskId: string) => {
    const res = await fetch(`${app.baseUrl}/api/tasks/channel/${localChannelId}`, { headers: headers(token, serverId) });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { tasks: any[] }).tasks.find((entry) => entry.id === taskId)?.conversationFollowed;
  };
  assert.equal(await followedFlag(ownerToken, server.id, channel.id, task.id), true, "the creator follows from creation");
  assert.equal(await followedFlag(memberToken, server.id, channel.id, task.id), false);

  const follow = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST", headers: headers(memberToken, server.id), body: JSON.stringify({ threadChannelId: conversationId }),
  });
  assert.equal(follow.status, 200, await follow.clone().text());
  assert.equal(((await follow.json()) as { threadChannelId: string }).threadChannelId, conversationId);
  const [row] = await db.select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId), eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, member.id),
  ));
  assert.equal(row?.reason, "manual");
  assert.equal(row?.parentTaskId, task.id);
  assert.equal(await followedFlag(memberToken, server.id, channel.id, task.id), true);
  const byNumber = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}/number/${task.taskNumber}`, { headers: headers(memberToken, server.id) });
  assert.equal(((await byNumber.json()) as { task: any }).task.conversationFollowed, true);

  // Done / undone and a row read on the task conversation.
  const reply = await createMessage(conversationId, "user", owner.id, "please review");
  const done = await fetch(`${app.baseUrl}/api/channels/threads/done`, {
    method: "POST", headers: headers(memberToken, server.id),
    body: JSON.stringify({ threadChannelId: conversationId, throughActivitySeq: String(reply.seq), frontierSpace: "storage" }),
  });
  assert.equal(done.status, 200, await done.clone().text());
  const undone = await fetch(`${app.baseUrl}/api/channels/threads/undone`, {
    method: "POST", headers: headers(memberToken, server.id), body: JSON.stringify({ threadChannelId: conversationId }),
  });
  assert.equal(undone.status, 200, await undone.clone().text());
  const read = await fetch(`${app.baseUrl}/api/read-mutations`, {
    method: "POST", headers: headers(memberToken, server.id),
    body: JSON.stringify({ mutationId: randomUUID(), kind: "row_read", scopeId: conversationId, throughSeq: Number(reply.seq) }),
  });
  assert.equal(read.status, 201, await read.clone().text());

  const unfollow = await fetch(`${app.baseUrl}/api/channels/threads/unfollow`, {
    method: "POST", headers: headers(memberToken, server.id), body: JSON.stringify({ threadChannelId: conversationId }),
  });
  assert.equal(unfollow.status, 200, await unfollow.clone().text());
  assert.equal(await followedFlag(memberToken, server.id, channel.id, task.id), false, "unfollow clears it");

  // A thread id is not followed through the task path.
  const notTask = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST", headers: headers(memberToken, server.id), body: JSON.stringify({ threadChannelId: channel.id }),
  });
  assert.equal(notTask.status, 404);

  // Joint: the peer member follows its server's local projection.
  const fx = await jointFixture("belljoint");
  const joint = await createTaskWithConversation(fx.storage.id, fx.hostOwner.id, "joint bell", fx.hostServer.id);
  const peerLocal = joint.conversation.localByServer.get(fx.peerServer.id)!.localChannelId;
  const peerToken = await tokenForHuman(fx.peerMember.email);
  assert.equal(await followedFlag(peerToken, fx.peerServer.id, fx.peerProjection.id, joint.task.id), false);
  const peerFollow = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST", headers: headers(peerToken, fx.peerServer.id), body: JSON.stringify({ threadChannelId: peerLocal }),
  });
  assert.equal(peerFollow.status, 200, await peerFollow.clone().text());
  assert.equal(await followedFlag(peerToken, fx.peerServer.id, fx.peerProjection.id, joint.task.id), true);
  const wrongServer = await fetch(`${app.baseUrl}/api/channels/threads/follow`, {
    method: "POST", headers: headers(peerToken, fx.peerServer.id), body: JSON.stringify({ threadChannelId: joint.conversation.canonicalChannelId }),
  });
  assert.equal(wrongServer.status, 404, "the canonical conversation lives on the storage server, not the reader's");

  // Flag off (per-task mode, ../services/taskV2Mode): a v2 task keeps
  // `conversationFollowed`; a pre-v2 task's DTO is unchanged.
  await disableTaskV2Conversations();
  const preV2 = (await createTasks(channel.id, "user", owner.id, [{ title: "pre-v2" }], { initiatingServerId: server.id })).tasks[0]!;
  const res = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers: headers(memberToken, server.id) });
  const listed = ((await res.json()) as { tasks: Array<{ id: string; conversationFollowed?: boolean }> }).tasks;
  assert.equal("conversationFollowed" in listed.find((row) => row.id === task.id)!, true, "a v2 task keeps it whatever the flag");
  assert.equal("conversationFollowed" in listed.find((row) => row.id === preV2.id)!, false, "a pre-v2 task on a flag-off server is unchanged");
});

test("lazy task conversation: none until first use, the creator reads as following meanwhile, the web open creates it with the creator following", async ({ app }) => {
  const db = getDb();
  const { owner, member, server, channel } = await ordinaryFixture("lazyopen");
  const created = await createTasks(channel.id, "user", owner.id, [{ title: "open me later" }], { initiatingServerId: server.id });
  const task = created.tasks[0]!;
  assert.equal(task.conversationChannelId, null, "creating a task creates only the task");
  assert.equal(task.conversationAnchored, true, "its discussion is still its own conversation");
  assert.equal(task.isLegacy, false, "a task v2 task without a conversation is not a pre-thread orphan");

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const listed = async (token: string) => {
    const res = await fetch(`${app.baseUrl}/api/tasks/channel/${channel.id}`, { headers: headers(token, server.id) });
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { tasks: any[] }).tasks.find((entry) => entry.id === task.id);
  };
  const before = await listed(ownerToken);
  assert.equal(before?.conversationChannelId, null, "listings show the task without a conversation");
  assert.equal(before?.conversationFollowed, true, "its creator follows it from the moment it exists");
  assert.equal((await listed(memberToken))?.conversationFollowed, false);

  const open = await fetch(`${app.baseUrl}/api/tasks/${task.id}/conversation`, { method: "POST", headers: headers(memberToken, server.id) });
  assert.equal(open.status, 200, await open.clone().text());
  const opened = await open.json() as { conversationChannelId: string; canonicalConversationChannelId: string; created: boolean };
  assert.equal(opened.created, true);
  const follows = await db.select().from(threadFollows).where(eq(threadFollows.threadChannelId, opened.conversationChannelId));
  assert.deepEqual(
    follows.map((row) => [row.followerType, row.followerId, row.reason, row.parentTaskId]),
    [["user", owner.id, "authored", task.id]],
    "created with its creator following; the opener does not follow by opening",
  );
  const again = await fetch(`${app.baseUrl}/api/tasks/${task.id}/conversation`, { method: "POST", headers: headers(memberToken, server.id) });
  assert.equal(((await again.json()) as { created: boolean }).created, false, "idempotent");
});

test("search hits in a task conversation carry the task", async ({ db: _db }) => {
  const { owner, server, channel } = await ordinaryFixture("search");
  const { task, conversation } = await createTaskWithConversation(channel.id, owner.id, "find the zebra", server.id);
  await createMessage(conversation.canonicalChannelId, "user", owner.id, "the quokkaword lives in the task");
  const page = await searchMessagesForUser({ serverId: server.id, userId: owner.id, query: "quokkaword", historyCutoff: undefined });
  const hit = page.results.find((result) => result.channelId === conversation.canonicalChannelId);
  assert.ok(hit, JSON.stringify(page.results));
  assert.equal(hit.channelType, "task");
  assert.equal(hit.taskId, task.id);
  assert.equal(hit.taskNumber, task.taskNumber);
  assert.equal(hit.taskTitle, "find the zebra");
});
