import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";

import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db/index";
import { agents, channelAgents, channelHumans, channels, dmChannelIdentities, messages, serverMembers, users } from "../db/schema";
import { createAgent, deleteAgent } from "./agentService";
import {
  findOrCreateAgentDM,
  findOrCreateDM,
  findOrCreateUserDM,
  getReadableDMChannelForUser,
  listDMChannels,
} from "./channelService";
import { createServer } from "./serverService";


test("findOrCreateDM creates one human-agent DM under concurrent calls", async ({ db }) => {
  const owner = await seedUser("dm-agent-owner@slock.test", "dm-agent-owner");
  const server = await createServer("DM Agent Lock", "dm-agent-lock", owner.id);
  const agent = await createAgent(server.id, "dm-agent-peer", { runtime: "codex" });

  const dms = await Promise.all(
    Array.from({ length: 12 }, () => findOrCreateDM(server.id, owner.id, agent.id)),
  );

  const ids = dms.map((dm) => dm?.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(await countHumanAgentDms(server.id, owner.id, agent.id), 1);
});

test("findOrCreateUserDM creates one user-user DM under concurrent reversed calls", async ({ db }) => {
  const owner = await seedUser("dm-user-owner@slock.test", "dm-user-owner");
  const peer = await seedUser("dm-user-peer@slock.test", "dm-user-peer");
  const server = await createServer("DM User Lock", "dm-user-lock", owner.id);

  const dms = await Promise.all(
    Array.from({ length: 12 }, (_, index) => (
      index % 2 === 0
        ? findOrCreateUserDM(server.id, owner.id, peer.id)
        : findOrCreateUserDM(server.id, peer.id, owner.id)
    )),
  );

  const ids = dms.map((dm) => dm?.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(await countUserDms(server.id, owner.id, peer.id), 1);
});

test("findOrCreateUserDM returns the peer's uploaded avatar and an empty deprecated peerGravatarHash", async ({ db }) => {
  const owner = await seedUser("dm-avatar-owner@slock.test", "dm-avatar-owner");
  const peerEmail = "  DM-Avatar-Peer@SLOCK.TEST  ";
  const peer = await seedUser(peerEmail, "dm-avatar-peer");
  const avatarUrl = "https://cdn.slock.test/avatars/dm-avatar-peer.png";
  await getDb().update(users).set({ avatarUrl }).where(eq(users.id, peer.id));
  const server = await createServer("DM Avatar Projection", "dm-avatar-projection", owner.id);

  const dm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(dm);
  assert.equal(dm.peerType, "user");
  assert.equal(dm.peerId, peer.id);
  assert.equal(dm.peerAvatarUrl, avatarUrl);
  assert.equal(dm.peerGravatarHash, "");
});

test("listDMChannels attaches a bounded latest-message preview and sender name without extra queries", async ({ db }) => {
  // A day ago: inside the Free plan's 30-day history window.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const owner = await seedUser("dm-preview-owner@slock.test", "DM Preview Owner");
  const peer = await seedUser("dm-preview-peer@slock.test", "DM Preview Peer");
  const boundaryPeer = await seedUser("dm-preview-boundary@slock.test", "DM Preview Boundary");
  const server = await createServer("DM Preview Projection", "dm-preview-projection", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: peer.id, role: "member" },
    { serverId: server.id, userId: boundaryPeer.id, role: "member" },
  ]);
  const agent = await createAgent(server.id, "dm-preview-agent", { runtime: "codex" });
  await db.update(agents).set({ displayName: "DM Preview Agent" }).where(eq(agents.id, agent.id));

  const userDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  const boundaryDm = await findOrCreateUserDM(server.id, owner.id, boundaryPeer.id);
  const agentDm = await findOrCreateDM(server.id, owner.id, agent.id);
  const selfDm = await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(userDm);
  assert.ok(boundaryDm);
  assert.ok(agentDm);
  assert.ok(selfDm);

  await db.insert(messages).values([
    {
      channelId: userDm.id,
      senderType: "user",
      senderId: owner.id,
      content: "older message",
      createdAt: new Date(dayAgo + 0 * 1000),
    },
    {
      channelId: userDm.id,
      senderType: "user",
      senderId: peer.id,
      content: `  ${"x".repeat(139)}\n\tyy  `,
      createdAt: new Date(dayAgo + 120 * 1000),
    },
    {
      channelId: boundaryDm.id,
      senderType: "user",
      senderId: boundaryPeer.id,
      content: "b".repeat(140),
      createdAt: new Date(dayAgo + 90 * 1000),
    },
    {
      channelId: agentDm.id,
      senderType: "agent",
      senderId: agent.id,
      content: " \n\t ",
      createdAt: new Date(dayAgo + 60 * 1000),
    },
  ]);

  const queryNames: string[] = [];
  const dms = await listDMChannels(server.id, owner.id, {
    traceQuery: async (queryName, query, attrs) => {
      queryNames.push(queryName);
      const result = await query();
      attrs?.(result);
      return result;
    },
  });

  assert.deepEqual(dms.map((dm) => dm.id), [userDm.id, boundaryDm.id, agentDm.id, selfDm.id]);
  assert.equal(dms[0]?.lastMessageAt?.toISOString(), new Date(dayAgo + 120 * 1000).toISOString());
  assert.equal(dms[0]?.lastMessagePreview, `${"x".repeat(139)}…`);
  assert.ok((dms[0]?.lastMessagePreview?.length ?? Infinity) <= 140);
  assert.equal(dms[0]?.lastMessageSenderName, peer.displayName);
  assert.equal(dms[1]?.lastMessagePreview, "b".repeat(140), "the exact limit is not ellipsized");
  assert.equal(dms[1]?.lastMessagePreview?.length, 140);
  assert.equal(dms[1]?.lastMessageSenderName, boundaryPeer.displayName);
  assert.equal(dms[2]?.lastMessagePreview, null, "blank attachment-only bodies stay unlabelled");
  assert.equal(dms[2]?.lastMessageSenderName, "DM Preview Agent");
  assert.equal(dms[3]?.lastMessageAt, null);
  assert.equal(dms[3]?.lastMessagePreview, null);
  assert.equal(dms[3]?.lastMessageSenderName, null);
  assert.equal(queryNames.filter((name) => name === "dm_channels.last_messages_by_channels").length, 1);
});

test("findOrCreateAgentDM creates one agent-agent DM under concurrent reversed calls", async ({ db }) => {
  const owner = await seedUser("dm-aa-owner@slock.test", "dm-aa-owner");
  const server = await createServer("DM Agent Agent Lock", "dm-aa-lock", owner.id);
  const agentA = await createAgent(server.id, "dm-aa-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "dm-aa-b", { runtime: "codex" });

  const dms = await Promise.all(
    Array.from({ length: 12 }, (_, index) => (
      index % 2 === 0
        ? findOrCreateAgentDM(server.id, agentA.id, agentB.id)
        : findOrCreateAgentDM(server.id, agentB.id, agentA.id)
    )),
  );

  const ids = dms.map((dm) => dm?.id);
  assert.equal(new Set(ids).size, 1);
  assert.equal(await countAgentDms(server.id, agentA.id, agentB.id), 1);
});

test("identity lookup prefers the active channel when legacy duplicates share a peer key", async ({ db }) => {
  const owner = await seedUser("dm-duplicate-owner@slock.test", "dm-duplicate-owner");
  const server = await createServer("DM Duplicate Identity", "dm-duplicate-identity", owner.id);
  const agent = await createAgent(server.id, "dm-duplicate-agent", { runtime: "codex" });
  const active = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(active);

  const [tombstone] = await getDb().insert(channels).values({
    serverId: server.id,
    name: agent.name,
    type: "dm",
    deletedAt: new Date(),
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: tombstone.id, userId: owner.id });
  await getDb().insert(channelAgents).values({ channelId: tombstone.id, agentId: agent.id });
  await getDb().insert(dmChannelIdentities).values({
    channelId: tombstone.id,
    serverId: server.id,
    kind: "human_agent",
    peerKey: [owner.id, agent.id].sort().join(":"),
  });

  const reopened = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.equal(reopened?.id, active.id);
  const [tombstoneAfter] = await getDb().select({ deletedAt: channels.deletedAt })
    .from(channels).where(eq(channels.id, tombstone.id));
  assert.ok(tombstoneAfter?.deletedAt);
});

test("self-DM lookup never revives a deleted agent DM singleton", async ({ db }) => {
  const owner = await seedUser("dm-self-owner@slock.test", "dm-self-owner");
  const server = await createServer("DM Self Provenance", "dm-self-provenance", owner.id);
  const agent = await createAgent(server.id, "dm-deleted-agent", { runtime: "codex" });
  const agentDm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(agentDm);

  await getDb().insert(messages).values({
    channelId: agentDm.id,
    senderType: "agent",
    senderId: agent.id,
    content: "deleted agent history must stay tombstoned",
  });
  await deleteAgent(agent.id);

  const selfDm = await findOrCreateUserDM(server.id, owner.id, owner.id);
  const repeated = await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(selfDm);
  assert.equal(repeated?.id, selfDm.id);
  assert.notEqual(selfDm.id, agentDm.id);

  const [oldChannel] = await getDb().select({
    deletedAt: channels.deletedAt,
    identityKind: dmChannelIdentities.kind,
  }).from(channels)
    .innerJoin(dmChannelIdentities, eq(dmChannelIdentities.channelId, channels.id))
    .where(eq(channels.id, agentDm.id));
  const [newChannel] = await getDb().select({
    deletedAt: channels.deletedAt,
    identityKind: dmChannelIdentities.kind,
    identityKey: dmChannelIdentities.peerKey,
  }).from(channels)
    .innerJoin(dmChannelIdentities, eq(dmChannelIdentities.channelId, channels.id))
    .where(eq(channels.id, selfDm.id));
  assert.ok(oldChannel?.deletedAt);
  assert.equal(oldChannel.identityKind, "human_agent");
  assert.equal(newChannel?.deletedAt, null);
  assert.equal(newChannel?.identityKind, "human_self");
  assert.equal(newChannel?.identityKey, owner.id);

  const [oldMessages] = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(messages).where(eq(messages.channelId, agentDm.id));
  const [newMessages] = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(messages).where(eq(messages.channelId, selfDm.id));
  assert.equal(oldMessages?.count, 1);
  assert.equal(newMessages?.count, 0);
});

test("self-DM lookup quarantines ambiguous legacy singleton shape", async ({ db }) => {
  const owner = await seedUser("dm-legacy-owner@slock.test", "dm-legacy-owner");
  const server = await createServer("DM Legacy Singleton", "dm-legacy-singleton", owner.id);
  const [legacy] = await getDb().insert(channels).values({
    serverId: server.id,
    name: "ambiguous legacy singleton",
    type: "dm",
    deletedAt: new Date(),
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: legacy.id, userId: owner.id });

  const selfDm = await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(selfDm);
  assert.notEqual(selfDm.id, legacy.id);

  const [legacyAfter] = await getDb().select({ deletedAt: channels.deletedAt })
    .from(channels).where(eq(channels.id, legacy.id));
  assert.ok(legacyAfter?.deletedAt);
});

test("active ambiguous singleton is neither listed nor readable as a self-DM", async ({ db }) => {
  const owner = await seedUser("dm-polluted-owner@slock.test", "dm-polluted-owner");
  const server = await createServer("DM Polluted Singleton", "dm-polluted-singleton", owner.id);
  const deletedAgent = await createAgent(server.id, "dm-polluted-agent", { runtime: "codex" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));

  const [polluted] = await getDb().insert(channels).values({
    serverId: server.id,
    name: deletedAgent.name,
    type: "dm",
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: polluted.id, userId: owner.id });

  assert.equal((await listDMChannels(server.id, owner.id)).some((dm) => dm.id === polluted.id), false);
  assert.equal(await getReadableDMChannelForUser(polluted.id, owner.id), null);

  await getDb().insert(dmChannelIdentities).values({
    channelId: polluted.id,
    serverId: server.id,
    kind: "human_agent",
    peerKey: [owner.id, deletedAgent.id].sort().join(":"),
  });

  assert.equal((await listDMChannels(server.id, owner.id)).some((dm) => dm.id === polluted.id), false);
  const readable = await getReadableDMChannelForUser(polluted.id, owner.id);
  assert.equal(readable?.peerType, "agent");
  assert.equal(readable?.peerId, deletedAgent.id);
});

test("deleteAgent stamps exact legacy DM provenance before removing membership", async ({ db }) => {
  const owner = await seedUser("dm-legacy-delete-owner@slock.test", "dm-legacy-delete-owner");
  const server = await createServer("DM Legacy Delete", "dm-legacy-delete", owner.id);
  const agent = await createAgent(server.id, "dm-legacy-delete-agent", { runtime: "codex" });
  const [legacy] = await getDb().insert(channels).values({
    serverId: server.id,
    name: agent.name,
    type: "dm",
  }).returning();
  await getDb().insert(channelHumans).values({ channelId: legacy.id, userId: owner.id });
  await getDb().insert(channelAgents).values({ channelId: legacy.id, agentId: agent.id });

  await deleteAgent(agent.id);

  const [identity] = await getDb().select({
    kind: dmChannelIdentities.kind,
    peerKey: dmChannelIdentities.peerKey,
  }).from(dmChannelIdentities).where(eq(dmChannelIdentities.channelId, legacy.id));
  assert.equal(identity?.kind, "human_agent");
  assert.equal(identity?.peerKey, [owner.id, agent.id].sort().join(":"));

  const [legacyAfter] = await getDb().select({ deletedAt: channels.deletedAt })
    .from(channels).where(eq(channels.id, legacy.id));
  const [membershipCount] = await getDb().select({ count: sql<number>`count(*)::int` })
    .from(channelAgents).where(eq(channelAgents.channelId, legacy.id));
  assert.ok(legacyAfter?.deletedAt);
  assert.equal(membershipCount?.count, 0);
});

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: "test-password-hash",
    emailVerified: true,
  }).returning();
  return user;
}

async function countHumanAgentDms(serverId: string, userId: string, agentId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId)))
    .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId)))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
    ));
  return row?.count ?? 0;
}

async function countUserDms(serverId: string, userId1: string, userId2: string): Promise<number> {
  const ch2 = alias(channelHumans, "ch2");
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .innerJoin(channelHumans, and(eq(channels.id, channelHumans.channelId), eq(channelHumans.userId, userId1)))
    .innerJoin(ch2, and(eq(channels.id, ch2.channelId), eq(ch2.userId, userId2)))
    .leftJoin(channelAgents, eq(channels.id, channelAgents.channelId))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      isNull(channelAgents.agentId),
    ));
  return row?.count ?? 0;
}

async function countAgentDms(serverId: string, agentId1: string, agentId2: string): Promise<number> {
  const ca2 = alias(channelAgents, "ca2");
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(channels)
    .innerJoin(channelAgents, and(eq(channels.id, channelAgents.channelId), eq(channelAgents.agentId, agentId1)))
    .innerJoin(ca2, and(eq(channels.id, ca2.channelId), eq(ca2.agentId, agentId2)))
    .leftJoin(channelHumans, eq(channels.id, channelHumans.channelId))
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "dm"),
      isNull(channels.deletedAt),
      isNull(channelHumans.userId),
    ));
  return row?.count ?? 0;
}
