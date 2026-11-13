// task #24: a joint (cross-server) thread has a local projection on each
// participating server whose parent_message_id / parent_channel_id are null by
// design (the messages live in the canonical thread; joint_channel_servers maps
// the projection). Two agent-runtime reads joined on those parent fields and
// missed every joint thread: the inbox purge when an agent leaves the joint
// channel, and the agent's followed-threads list.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  servers,
  users,
} from "../db/schema";
import type { Database } from "../db/index";
import { and, eq } from "drizzle-orm";
import { getOrCreateThreadForChannel, listAgentFollowedThreads, listThreadChannelIdsForParentChannel, recordThreadFollow } from "./channelService";

async function jointThreadFixture(db: Database) {
  const [owner, sender] = await db.insert(users).values(
    ["owner", "sender"].map((name) => ({
      email: `joint-thread-runtime-${name}@test.com`, name: `jtr${name}`, passwordHash: "x", emailVerified: true,
    })),
  ).returning();
  const [senderServer, receiverServer, storage] = await db.insert(servers).values([
    { name: "JTR Sender", slug: "jtr-sender", ownerId: owner.id },
    { name: "JTR Receiver", slug: "jtr-receiver", ownerId: owner.id },
    { name: "JTR Storage", slug: "__jtr_storage__", ownerId: owner.id, kind: "joint_storage" },
  ]).returning();
  const [canonical, senderLocal, receiverLocal] = await db.insert(channels).values([
    { serverId: storage.id, name: "jtr-canonical", type: "joint" },
    { serverId: senderServer.id, name: "jtr-sender-local", type: "joint" },
    { serverId: receiverServer.id, name: "jtr-receiver-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: senderServer.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: senderServer.id, localChannelId: senderLocal.id, role: "host", status: "active", joinedByUserId: owner.id },
    { jointChannelId: joint.id, serverId: receiverServer.id, localChannelId: receiverLocal.id, role: "participant", status: "active", joinedByUserId: owner.id },
  ]);
  const [agent] = await db.insert(agents).values({ serverId: receiverServer.id, name: "jtr-agent", status: "active" }).returning();
  await db.insert(channelHumans).values({ channelId: senderLocal.id, userId: sender.id });
  await db.insert(channelAgents).values({ channelId: receiverLocal.id, agentId: agent.id });
  const [parent] = await db.insert(messages).values({
    channelId: canonical.id, senderType: "user", senderId: sender.id, content: "joint parent",
  }).returning();
  // The real create path: canonical thread, joint thread, and a projection on each server.
  const thread = await getOrCreateThreadForChannel(senderLocal.id, parent.id, sender.id, "user");
  const [receiverProjection] = await db
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(
      eq(jointChannels.canonicalChannelId, thread.canonicalThreadChannelId),
      eq(jointChannelServers.serverId, receiverServer.id),
    ));
  assert.ok(receiverProjection, "the receiver server has its own projection of the joint thread");
  return { receiverServer, receiverLocal, agent, parent, receiverThreadId: receiverProjection.localChannelId, canonicalThreadId: thread.canonicalThreadChannelId };
}

test("task #24: leaving a joint channel purges the agent's inbox for the joint threads too (their projections have no parent message)", async ({ db }) => {
  const { receiverLocal, receiverThreadId } = await jointThreadFixture(db);
  const threadIds = await listThreadChannelIdsForParentChannel(receiverLocal.id);
  assert.ok(threadIds.includes(receiverThreadId), `projection ${receiverThreadId} missing from ${JSON.stringify(threadIds)}`);
});

test("task #24: an agent's followed-threads list includes a joint thread, with the local parent channel", async ({ db }) => {
  const { receiverServer, receiverLocal, agent, parent, receiverThreadId } = await jointThreadFixture(db);
  await recordThreadFollow("agent", agent.id, receiverThreadId, parent.id, "manual");
  const items = await listAgentFollowedThreads(receiverServer.id, agent.id);
  const item = items.find((entry) => entry.threadChannelId === receiverThreadId);
  assert.ok(item, `joint thread missing from ${JSON.stringify(items)}`);
  assert.equal(item.parentChannelRef, `#${receiverLocal.name}`);
  assert.equal(item.parentMessageId, parent.id);
  assert.equal(item.target, `#${receiverLocal.name}:${parent.id.slice(0, 8)}`);
});
