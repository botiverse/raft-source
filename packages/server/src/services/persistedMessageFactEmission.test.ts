import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import { afterEach } from "vitest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import { prepareActionCard } from "./actionCardsService.js";
import { broadcastAndDeliver, broadcastSystemMessage, recordInboxFactsForPersistedMessages } from "./messageService.js";
import * as taskService from "./taskService.js";


afterEach(async () => {
  await closeTestDatabase();
});

function createIoStub() {
  const roomChain = {
    in() {
      return roomChain;
    },
    socketsJoin() {},
  };
  return {
    to() {
      return {
        emit() {},
      };
    },
    in() {
      return roomChain;
    },
  } as any;
}

async function seedSurface() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "boundary-owner@slock.test",
    name: "boundary-owner",
    displayName: "Boundary Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [member] = await db.insert(users).values({
    email: "boundary-member@slock.test",
    name: "boundary-member",
    displayName: "Boundary Member",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Boundary Server",
    slug: "boundary-server",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "boundary-agent",
    displayName: "Boundary Agent",
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "boundary-channel",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: member.id },
  ]);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  return { owner, member, server, agent, channel };
}

async function factsForMessage(messageId: string) {
  return getDb()
    .select()
    .from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, messageId));
}

test("persisted message boundary emits inbox facts for every countable message class", async ({ db }) => {

  const { owner, member, server, agent, channel } = await seedSurface();
  const io = createIoStub();
  const agentOrchestrator = { deliverMessage: async () => undefined } as any;

  const regular = await broadcastAndDeliver(io, agentOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: owner.displayName ?? owner.name,
    content: "regular chat should emit",
  });
  assert.ok((await factsForMessage(regular.id)).length > 0, "regular chat messages must emit inbox facts");

  const system = await broadcastSystemMessage(io, agentOrchestrator, channel.id, "Channel archived", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.channel.archive",
      reason: "test archive notice is shared channel activity",
    },
  });
  assert.ok((await factsForMessage(system.id)).length > 0, "noteworthy system broadcasts must emit inbox facts");

  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", owner.id, [{ title: "task body should emit" }]);
  assert.ok((await factsForMessage(task.messageId)).length > 0, "task body chat rows must emit inbox facts");

  const beforeClaimFactCount = (await factsForMessage(task.messageId)).length;
  // v1.4: the task id is the canonical row id; the host message id is separate.
  const claimed = await taskService.claimTask(task.id, "user", member.id);
  assert.notEqual(claimed, "task not found");
  assert.equal(
    (await factsForMessage(task.messageId)).length,
    beforeClaimFactCount,
    "task status changes must not create new inbox facts",
  );

  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "channel:create",
      name: "boundary-action-created",
      visibility: "public",
    },
  });
  assert.ok((await factsForMessage(card.messageId)).length > 0, "action-card carrier chat rows must emit inbox facts");

  const [cardMessage] = await getDb().select().from(messages).where(eq(messages.id, card.messageId));
  assert.equal(cardMessage?.messageType, "chat");
  assert.equal(cardMessage?.senderType, "agent");
  assert.equal(
    cardMessage?.content,
    "Operation: create channel #boundary-action-created",
    "action-card carriers need plain-text content so inbox/activity previews are visible",
  );
});

test("persisted message boundary expands joint storage rows to local projection receivers", async ({ db: database }) => {

  const db = getDb();
  const [ownerA] = await db.insert(users).values({
    email: "joint-boundary-owner-a@slock.test",
    name: "joint-boundary-owner-a",
    displayName: "Joint Boundary Owner A",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [ownerB] = await db.insert(users).values({
    email: "joint-boundary-owner-b@slock.test",
    name: "joint-boundary-owner-b",
    displayName: "Joint Boundary Owner B",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [serverA] = await db.insert(servers).values({
    name: "Joint Boundary A",
    slug: "joint-boundary-a",
    ownerId: ownerA.id,
  }).returning();
  const [serverB] = await db.insert(servers).values({
    name: "Joint Boundary B",
    slug: "joint-boundary-b",
    ownerId: ownerB.id,
  }).returning();
  const [storageServer] = await db.insert(servers).values({
    name: "Joint Boundary Storage",
    slug: "joint-boundary-storage",
    kind: "joint_storage",
    ownerId: ownerA.id,
    plan: "founder",
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: serverA.id, userId: ownerA.id, role: "owner" },
    { serverId: serverB.id, userId: ownerB.id, role: "owner" },
  ]);
  const [canonicalChannel] = await db.insert(channels).values({
    serverId: storageServer.id,
    name: "joint-boundary-storage-channel",
    type: "channel",
  }).returning();
  const [localChannelA] = await db.insert(channels).values({
    serverId: serverA.id,
    name: "joint-boundary-local-a",
    type: "joint",
  }).returning();
  const [localChannelB] = await db.insert(channels).values({
    serverId: serverB.id,
    name: "joint-boundary-local-b",
    type: "joint",
  }).returning();
  const [jointChannel] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalChannel.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: jointChannel.id,
      serverId: serverA.id,
      localChannelId: localChannelA.id,
      role: "host",
      status: "active",
      joinedByUserId: ownerA.id,
    },
    {
      jointChannelId: jointChannel.id,
      serverId: serverB.id,
      localChannelId: localChannelB.id,
      role: "participant",
      status: "active",
      joinedByUserId: ownerB.id,
    },
  ]);
  await db.insert(channelHumans).values([
    { channelId: localChannelA.id, userId: ownerA.id },
    { channelId: localChannelB.id, userId: ownerB.id },
  ]);
  const [message] = await db.insert(messages).values({
    channelId: canonicalChannel.id,
    senderType: "user",
    senderId: ownerA.id,
    content: "storage persisted row",
    seq: 1,
  }).returning();

  const factCount = await recordInboxFactsForPersistedMessages([message], {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.joint.storage.boundary",
      reason: "test joint storage persisted messages are projected to local audiences",
    },
  });

  const facts = await factsForMessage(message.id);
  assert.equal(factCount, 2);
  assert.equal(facts.length, 2);
  assert.ok(facts.some((fact) =>
    fact.receiverType === "user"
    && fact.receiverId === ownerA.id
    && fact.serverId === serverA.id
    && fact.sourceChannelId === localChannelA.id
  ));
  assert.ok(facts.some((fact) =>
    fact.receiverType === "user"
    && fact.receiverId === ownerB.id
    && fact.serverId === serverB.id
    && fact.sourceChannelId === localChannelB.id
  ));
  assert.equal(facts.some((fact) => fact.sourceChannelId === canonicalChannel.id), false);
});

test("persisted message boundary skips local joint-face rows", async ({ db: database }) => {

  const db = getDb();
  const [ownerA] = await db.insert(users).values({
    email: "joint-local-owner-a@slock.test",
    name: "joint-local-owner-a",
    displayName: "Joint Local Owner A",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [ownerB] = await db.insert(users).values({
    email: "joint-local-owner-b@slock.test",
    name: "joint-local-owner-b",
    displayName: "Joint Local Owner B",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [serverA] = await db.insert(servers).values({
    name: "Joint Local A",
    slug: "joint-local-a",
    ownerId: ownerA.id,
  }).returning();
  const [serverB] = await db.insert(servers).values({
    name: "Joint Local B",
    slug: "joint-local-b",
    ownerId: ownerB.id,
  }).returning();
  const [storageServer] = await db.insert(servers).values({
    name: "Joint Local Storage",
    slug: "joint-local-storage",
    kind: "joint_storage",
    ownerId: ownerA.id,
    plan: "founder",
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: serverA.id, userId: ownerA.id, role: "owner" },
    { serverId: serverB.id, userId: ownerB.id, role: "owner" },
  ]);
  const [canonicalChannel] = await db.insert(channels).values({
    serverId: storageServer.id,
    name: "joint-local-storage-channel",
    type: "channel",
  }).returning();
  const [localChannelA] = await db.insert(channels).values({
    serverId: serverA.id,
    name: "joint-local-face-a",
    type: "joint",
  }).returning();
  const [localChannelB] = await db.insert(channels).values({
    serverId: serverB.id,
    name: "joint-local-face-b",
    type: "joint",
  }).returning();
  const [jointChannel] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalChannel.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: jointChannel.id,
      serverId: serverA.id,
      localChannelId: localChannelA.id,
      role: "host",
      status: "active",
      joinedByUserId: ownerA.id,
    },
    {
      jointChannelId: jointChannel.id,
      serverId: serverB.id,
      localChannelId: localChannelB.id,
      role: "participant",
      status: "active",
      joinedByUserId: ownerB.id,
    },
  ]);
  await db.insert(channelHumans).values([
    { channelId: localChannelA.id, userId: ownerA.id },
    { channelId: localChannelB.id, userId: ownerB.id },
  ]);
  const [message] = await db.insert(messages).values({
    channelId: localChannelA.id,
    senderType: "user",
    senderId: ownerA.id,
    content: "local joint face row",
    seq: 1,
  }).returning();

  const factCount = await recordInboxFactsForPersistedMessages([message], {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.joint.local.boundary",
      reason: "test local joint-face persisted messages are storage-oracle invisible",
    },
  });

  const facts = await factsForMessage(message.id);
  assert.equal(factCount, 0);
  assert.equal(facts.length, 0);
});
