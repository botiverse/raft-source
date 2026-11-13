import { fixturePasswordHash } from "../test/integration/credentials";
import { dbTest as test } from "../test/integration/dbTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
/**
 * Task v2 phase 2a (server leftovers), service level: the per-sub-conversation
 * rules that held for threads now hold for task conversations.
 *  - follow pruning: server member removal and a channel going private drop
 *    task-conversation follows (ordinary + joint projection);
 *  - joint limits: a joint task conversation's record resolves to its parent
 *    joint and is never a top-level joint;
 *  - agent typing line: `raft task reply "#chan:#7"` resolves read-only to the
 *    task's conversation (its own room) and the emitted line names the task;
 *  - agent inbox purge lists, assistant DM scoping.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { AGENT_TYPING_SOCKET_EVENT, type AgentTypingEvent } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, serverMembers, threadFollows, users } from "../db/schema";
import { createAgent } from "./agentService";
import { previewAgentTaskReplyTarget } from "./agentTypingTaskTarget";
import { AgentTypingRegistry } from "./agentTypingService";
import { isDmScopedChannel } from "./assistantService";
import {
  addAgent,
  addHuman,
  createChannel,
  findOrCreateDM,
  getChannel,
  listThreadChannelIdsForParentChannel,
  updateChannel,
} from "./channelService";
import { getJointLimitStatesForJoints, resolveGatingParentJointId, resolveParentJointId } from "./jointChannelLimitState";
import { createServer, removeMember } from "./serverService";
import { createTasks } from "./taskService";
import { ensureTaskConversation, getTaskConversation, insertTaskConversationFollow } from "./taskConversationService";

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

/** A task v2 task and its conversation (created lazily, as the first reply/follow would; the creator follows it). */
async function taskWithConversation(storageChannelId: string, creatorId: string, title: string, initiatingServerId: string) {
  const created = await createTasks(storageChannelId, "user", creatorId, [{ title }], { initiatingServerId });
  const task = created.tasks[0]!;
  assert.equal(await getTaskConversation(task.id), null, "creating a task creates no conversation");
  const ensured = await ensureTaskConversation(task.id, { initiatingServerId });
  assert.equal(ensured?.created, true);
  const conversation = await getTaskConversation(task.id);
  assert.ok(conversation);
  return { task, conversation: conversation! };
}

async function follows(conversationId: string, userId: string) {
  return getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, conversationId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, userId),
  ));
}

async function ordinary(slug: string) {
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const server = await createServer(`Svc ${slug}`, `${slug}-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const channel = await createChannel(server.id, `${slug}-room`);
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await enableTaskV2ConversationsForServer(server.id);
  return { owner, member, server, channel };
}

async function joint(slug: string) {
  const db = getDb();
  const hostOwner = await seedUser(`${slug}-host`);
  const peerOwner = await seedUser(`${slug}-peer`);
  const peerMember = await seedUser(`${slug}-peer-member`);
  const hostServer = await createServer("Svc Host", `${slug}-h-${randomUUID().slice(0, 6)}`, hostOwner.id);
  const peerServer = await createServer("Svc Peer", `${slug}-p-${randomUUID().slice(0, 6)}`, peerOwner.id);
  const storage = await createChannel(hostServer.id, `${slug}-storage`, undefined, "channel");
  const hostProjection = await createChannel(hostServer.id, `${slug}-room`, undefined, "joint");
  const peerProjection = await createChannel(peerServer.id, `${slug}-room`, undefined, "joint");
  const [parentJoint] = await db.insert(jointChannels).values({ canonicalChannelId: storage.id, createdByServerId: hostServer.id }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: parentJoint!.id, serverId: hostServer.id, localChannelId: hostProjection.id, role: "host" },
    { jointChannelId: parentJoint!.id, serverId: peerServer.id, localChannelId: peerProjection.id, role: "participant" },
  ]);
  await db.insert(serverMembers).values({ serverId: peerServer.id, userId: peerMember.id, role: "member" });
  await addHuman(hostProjection.id, hostOwner.id);
  await addHuman(peerProjection.id, peerMember.id);
  await enableTaskV2ConversationsForServer(hostServer.id);
  return { hostOwner, peerMember, hostServer, peerServer, storage, hostProjection, peerProjection, parentJointId: parentJoint!.id };
}

test("server member removal drops the member's task-conversation follows (ordinary and joint projection)", async ({ db: _db }) => {
  const fx = await ordinary("prune");
  const { task, conversation } = await taskWithConversation(fx.channel.id, fx.owner.id, "prune me", fx.server.id);
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: conversation.canonicalChannelId, taskId: task.id, follower: { type: "user", id: fx.member.id }, reason: "manual",
  });
  assert.equal((await follows(conversation.canonicalChannelId, fx.member.id)).length, 1);
  await removeMember(fx.server.id, fx.member.id);
  assert.deepEqual(await follows(conversation.canonicalChannelId, fx.member.id), [], "the removed member's follow is gone");
  assert.equal((await follows(conversation.canonicalChannelId, fx.owner.id)).length, 1, "others keep theirs");

  const jx = await joint("prunejoint");
  const jointTask = await taskWithConversation(jx.storage.id, jx.hostOwner.id, "joint prune", jx.hostServer.id);
  const peerLocal = jointTask.conversation.localByServer.get(jx.peerServer.id)!.localChannelId;
  const hostLocal = jointTask.conversation.localByServer.get(jx.hostServer.id)!.localChannelId;
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: peerLocal, taskId: jointTask.task.id, follower: { type: "user", id: jx.peerMember.id }, reason: "manual",
  });
  await removeMember(jx.peerServer.id, jx.peerMember.id);
  assert.deepEqual(await follows(peerLocal, jx.peerMember.id), [], "the follow held through the peer server is gone");
  assert.equal((await follows(hostLocal, jx.hostOwner.id)).length, 1, "the host creator's follow stays");
});

test("a channel going private drops task-conversation follows of non-members, like thread follows", async ({ db: _db }) => {
  const fx = await ordinary("private");
  const outsider = await seedUser("private-outsider");
  await getDb().insert(serverMembers).values({ serverId: fx.server.id, userId: outsider.id, role: "member" });
  const { task, conversation } = await taskWithConversation(fx.channel.id, fx.owner.id, "secret plan", fx.server.id);
  for (const user of [fx.member, outsider]) {
    await insertTaskConversationFollow(getDb(), {
      conversationChannelId: conversation.canonicalChannelId, taskId: task.id, follower: { type: "user", id: user.id }, reason: "manual",
    });
  }
  await updateChannel(fx.channel.id, { type: "private" });
  assert.deepEqual(await follows(conversation.canonicalChannelId, outsider.id), [], "the non-member's follow is pruned");
  assert.equal((await follows(conversation.canonicalChannelId, fx.member.id)).length, 1, "a member keeps theirs");
});

test("joint limits: a joint task conversation's record resolves to its parent joint (never a top-level joint)", async ({ db: _db }) => {
  const jx = await joint("limit");
  const { conversation } = await taskWithConversation(jx.storage.id, jx.hostOwner.id, "limit me", jx.hostServer.id);
  assert.ok(conversation.jointChannelId, "a joint channel's task conversation has its own joint record");
  assert.equal(await resolveParentJointId(getDb(), conversation.jointChannelId!), jx.parentJointId);
  const states = await getJointLimitStatesForJoints(getDb(), [conversation.jointChannelId!, jx.parentJointId], new Date());
  assert.equal(states.get(conversation.jointChannelId!)?.parentJointId, jx.parentJointId);
  assert.equal(states.get(jx.parentJointId)?.parentJointId, jx.parentJointId);
  const peerLocal = conversation.localByServer.get(jx.peerServer.id)!.localChannelId;
  assert.equal(await resolveGatingParentJointId(getDb(), peerLocal, jx.peerServer.id), jx.parentJointId, "writes to the local task conversation are gated by the parent joint");
  assert.equal(await resolveGatingParentJointId(getDb(), conversation.canonicalChannelId, jx.peerServer.id), jx.parentJointId, "the canonical storage id too");

  // An ordinary channel's task conversation is not joint at all.
  const fx = await ordinary("limitplain");
  const plain = await taskWithConversation(fx.channel.id, fx.owner.id, "plain", fx.server.id);
  assert.equal(await resolveGatingParentJointId(getDb(), plain.conversation.canonicalChannelId, fx.server.id), null);
});

test("typing line: `raft task reply` targets resolve read-only to the task conversation, and the line names the task", async ({ db: _db }) => {
  const fx = await ordinary("typing");
  const agent = await createAgent(fx.server.id, `typing-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const outsiderAgent = await createAgent(fx.server.id, `typing-out-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(fx.channel.id, agent.id);
  const { task, conversation } = await taskWithConversation(fx.channel.id, fx.owner.id, "type at me", fx.server.id);
  const expected = { channelId: conversation.canonicalChannelId, parentMessageId: null, taskId: task.id };

  assert.deepEqual(await previewAgentTaskReplyTarget(fx.server.id, agent.id, `#${fx.channel.name}:#${task.taskNumber}`), expected);
  assert.deepEqual(await previewAgentTaskReplyTarget(fx.server.id, agent.id, `#${fx.channel.name}:task-${task.id.slice(0, 8)}`), expected, "the interim form");
  assert.equal(await previewAgentTaskReplyTarget(fx.server.id, agent.id, `#${fx.channel.name}:#${task.taskNumber + 99}`), null, "unknown task");
  assert.equal(await previewAgentTaskReplyTarget(fx.server.id, outsiderAgent.id, `#${fx.channel.name}:#${task.taskNumber}`), null, "not allowed to post");
  assert.equal(await previewAgentTaskReplyTarget(fx.server.id, agent.id, `#${fx.channel.name}`), null, "a message target falls through");

  const jx = await joint("typingjoint");
  const jointAgent = await createAgent(jx.hostServer.id, `typing-joint-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(jx.hostProjection.id, jointAgent.id);
  const jointTask = await taskWithConversation(jx.storage.id, jx.hostOwner.id, "joint typing", jx.hostServer.id);
  assert.equal(
    await previewAgentTaskReplyTarget(jx.hostServer.id, jointAgent.id, `#${jx.hostProjection.name}:#${jointTask.task.taskNumber}`),
    null,
    "joint parents are refused, as for thread targets",
  );

  // The registry emits to the conversation's own room and names the task; the
  // agent's reply landing in that conversation closes the line.
  const emits: Array<{ room: string; event: string; payload: AgentTypingEvent }> = [];
  const registry = new AgentTypingRegistry({
    now: () => 1_000,
    emit: (room, event, payload) => emits.push({ room, event, payload }),
    previewTarget: (serverId, agentId, target) => previewAgentTaskReplyTarget(serverId, agentId, target),
  });
  const agentRef = { id: agent.id, serverId: fx.server.id, machineId: "machine-1" };
  assert.equal(await registry.handle(agentRef, { agentId: agent.id, callId: "c1", phase: "start", target: `#${fx.channel.name}:#${task.taskNumber}` }), "emitted_start");
  assert.equal(emits[0]!.room, `channel:${conversation.canonicalChannelId}`);
  assert.equal(emits[0]!.event, AGENT_TYPING_SOCKET_EVENT);
  assert.equal(emits[0]!.payload.taskId, task.id);
  assert.equal(emits[0]!.payload.parentMessageId, null);
  assert.equal(registry.endForPostedMessage(agent.id, { channelId: conversation.canonicalChannelId, parentMessageId: null }), 1);
  assert.equal(emits[1]!.payload.state, "end");
  assert.equal(emits[1]!.payload.taskId, task.id);
});

test("agent inbox purge lists a channel's task conversations; a task conversation under a DM is DM-scoped for assistants", async ({ db: _db }) => {
  const fx = await ordinary("purge");
  const { conversation } = await taskWithConversation(fx.channel.id, fx.owner.id, "purge me", fx.server.id);
  assert.ok((await listThreadChannelIdsForParentChannel(fx.channel.id)).includes(conversation.canonicalChannelId));

  const jx = await joint("purgejoint");
  const jointTask = await taskWithConversation(jx.storage.id, jx.hostOwner.id, "joint purge", jx.hostServer.id);
  const peerLocal = jointTask.conversation.localByServer.get(jx.peerServer.id)!.localChannelId;
  assert.ok((await listThreadChannelIdsForParentChannel(jx.peerProjection.id)).includes(peerLocal), "a joint server's local task conversation");

  const agent = await createAgent(fx.server.id, `dm-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const dm = await findOrCreateDM(fx.server.id, fx.owner.id, agent.id);
  assert.ok(dm);
  const dmTask = await taskWithConversation(dm!.id, fx.owner.id, "dm task", fx.server.id);
  const dmConversation = await getChannel(dmTask.conversation.canonicalChannelId);
  assert.equal(await isDmScopedChannel(dmConversation!), true, "under a DM");
  const channelConversation = await getChannel(conversation.canonicalChannelId);
  assert.equal(await isDmScopedChannel(channelConversation!), false, "under a channel");
});

test("task conversations get their parent channel at insert, without the task_conversations/0297 triggers (schema-pushed dev databases)", async ({ db: _db }) => {
  const db = getDb();
  await db.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_parent_channel_id_insert`);
  await db.execute(sql`ALTER TABLE channels DISABLE TRIGGER channels_parent_channel_id_update`);
  try {
    const fx = await ordinary("notrigger");
    const { conversation } = await taskWithConversation(fx.channel.id, fx.owner.id, "no trigger", fx.server.id);
    const [canonical] = await db.select().from(channels).where(eq(channels.id, conversation.canonicalChannelId));
    assert.equal(canonical!.parentChannelId, fx.channel.id);

    const jx = await joint("notriggerjoint");
    const jointTask = await taskWithConversation(jx.storage.id, jx.hostOwner.id, "joint no trigger", jx.hostServer.id);
    const faces = await db.select().from(channels).where(eq(channels.taskId, jointTask.task.id));
    const parentOf = (id: string) => faces.find((face) => face.id === id)?.parentChannelId;
    assert.equal(parentOf(jointTask.conversation.canonicalChannelId), jx.storage.id);
    assert.equal(parentOf(jointTask.conversation.localByServer.get(jx.hostServer.id)!.localChannelId), jx.hostProjection.id);
    assert.equal(parentOf(jointTask.conversation.localByServer.get(jx.peerServer.id)!.localChannelId), jx.peerProjection.id);
  } finally {
    await db.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_parent_channel_id_insert`);
    await db.execute(sql`ALTER TABLE channels ENABLE TRIGGER channels_parent_channel_id_update`);
  }
});
