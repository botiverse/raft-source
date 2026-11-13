import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createMessage } from "./messageService";
import { canAgentReceiveChannelDelivery } from "./channelService";
import { agents, channelAgents, channels, jointChannels, jointChannelServers, messages, servers, threadFollows, users } from "../db/schema";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";

// The agent inbox view (rw_agent_inbox_v7, mirrored in CI by
// referenceAgentInboxChain) holds a thread row only when the agent can receive
// the thread. Recovery and `raft inbox check` trust that, so the view's thread
// deliverability must agree with live delivery's per-thread check on every shape
// of thread.
test("the agent inbox view's thread deliverability agrees with the per-thread check", async ({ db }) => {
  const [owner] = await db.insert(users).values({
    email: "thread-delivery-owner@test.com", name: "threadDeliveryOwner", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server, other] = await db.insert(servers).values([
    { name: "Thread Delivery", slug: "thread-delivery", ownerId: owner.id },
    { name: "Thread Delivery Other", slug: "thread-delivery-other", ownerId: owner.id },
  ]).returning();
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: "thread-delivery-agent", status: "active" }).returning();

  const [publicCh, privateMember, privateOutsider, foreignPublic, deletedParent] = await db.insert(channels).values([
    { serverId: server.id, name: "td-public", type: "channel" },
    { serverId: server.id, name: "td-private-member", type: "private" },
    { serverId: server.id, name: "td-private-outsider", type: "private" },
    { serverId: other.id, name: "td-foreign-public", type: "channel" },
    { serverId: server.id, name: "td-deleted", type: "channel" },
  ]).returning();
  await db.insert(channelAgents).values({ channelId: privateMember.id, agentId: agent.id });

  const threads: Record<string, string> = {};
  async function thread(label: string, parentChannelId: string, follow: "active" | "unfollowed" | "none" = "active") {
    const parent = await createMessage(parentChannelId, "user", owner.id, `${label} parent`);
    const [t] = await db.insert(channels).values({
      serverId: server.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
    }).returning();
    await db.update(messages).set({ threadId: t.id }).where(eq(messages.id, parent.id));
    if (follow !== "none") {
      await db.insert(threadFollows).values({
        followerType: "agent", followerId: agent.id, threadChannelId: t.id, parentMessageId: parent.id, reason: "mentioned",
        unfollowedAt: follow === "unfollowed" ? new Date() : null,
      });
    }
    await createMessage(t.id, "user", owner.id, `${label} reply`);
    threads[label] = t.id;
    return { thread: t, parent };
  }
  await thread("public", publicCh.id);
  await thread("private-member", privateMember.id);
  await thread("private-outsider", privateOutsider.id);
  await thread("foreign-public", foreignPublic.id);
  await thread("public-unfollowed", publicCh.id, "unfollowed");
  await thread("public-not-following", publicCh.id, "none");
  await thread("deleted-parent", deletedParent.id);
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deletedParent.id));

  // Joint: canonical parent channel on `other`, local projections on both servers.
  const [canonical, localOther, localHere] = await db.insert(channels).values([
    { serverId: other.id, name: "td-joint-canonical", type: "joint" },
    { serverId: other.id, name: "td-joint-other", type: "joint" },
    { serverId: server.id, name: "td-joint-here", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id, createdByServerId: other.id, createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: other.id, localChannelId: localOther.id, role: "host", status: "active", joinedByUserId: owner.id },
    { jointChannelId: joint.id, serverId: server.id, localChannelId: localHere.id, role: "participant", status: "active", joinedByUserId: owner.id },
  ]);
  async function jointThread(label: string, member: boolean) {
    const parent = await createMessage(canonical.id, "user", owner.id, `${label} joint parent`);
    const [ct] = await db.insert(channels).values({
      serverId: other.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id,
    }).returning();
    await db.update(messages).set({ threadId: ct.id }).where(eq(messages.id, parent.id));
    const [lt] = await db.insert(channels).values({ serverId: server.id, name: `thread-${parent.id.slice(0, 8)}`, type: "thread" }).returning();
    const [tj] = await db.insert(jointChannels).values({
      canonicalChannelId: ct.id, createdByServerId: other.id, createdByUserId: owner.id,
    }).returning();
    await db.insert(jointChannelServers).values({
      jointChannelId: tj.id, serverId: server.id, localChannelId: lt.id, role: "participant", status: "active", joinedByUserId: owner.id,
    });
    await db.insert(threadFollows).values({
      followerType: "agent", followerId: agent.id, threadChannelId: lt.id, parentMessageId: parent.id, reason: "mentioned",
    });
    if (member) {
      await db.insert(channelAgents).values({ channelId: localHere.id, agentId: agent.id }).onConflictDoNothing();
    }
    await createMessage(ct.id, "user", owner.id, `${label} joint reply`);
    threads[label] = lt.id;
  }
  const inView = async () => new Set((await referenceAgentInboxChain(agent.id))
    .filter((row) => row.kind === "thread")
    .map((row) => row.targetId));
  await jointThread("joint-nonmember", false);
  assert.equal((await inView()).has(threads["joint-nonmember"]), false);
  assert.equal(await canAgentReceiveChannelDelivery(threads["joint-nonmember"], agent.id), false);
  await jointThread("joint-member", true);

  const view = await inView();
  const expected: Record<string, boolean> = {};
  const actual: Record<string, boolean> = {};
  for (const [label, id] of Object.entries(threads)) {
    expected[label] = await canAgentReceiveChannelDelivery(id, agent.id);
    actual[label] = view.has(id);
  }
  assert.deepEqual(actual, expected);
  // The shapes really differ: some deliver, some don't.
  assert.deepEqual(
    Object.entries(expected).filter(([, v]) => v).map(([k]) => k).sort(),
    ["joint-member", "joint-nonmember", "private-member", "public"].sort(),
  );
});
