import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db/index.js";
import { getDb } from "../db/index.js";
import {
  agents,
  attachmentObjects,
  attachments,
  channelAgents,
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  resolveBoundAttachmentAuthorityContext,
  resolveReadableAttachmentAuthorityContext,
  type AttachmentAuthorityPrincipal,
} from "./attachmentAuthorityService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(db: Database, label: string) {
  const suffix = randomUUID();
  const [user] = await db.insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  return user;
}

async function seedAgent(db: Database, serverId: string, label: string) {
  const [agent] = await db.insert(agents).values({
    serverId,
    name: `${label}-${randomUUID()}`,
  }).returning();
  return agent;
}

async function seedProjection(
  db: Database,
  input: {
    messageId: string | null;
    channelId: string;
    serverId: string;
    uploaderId: string;
    pendingChannelId?: string | null;
    revoked?: boolean;
    lifecycleState?: "active" | "gc_pending";
  },
) {
  const objectId = randomUUID();
  const projectionId = randomUUID();
  const lifecycleState = input.lifecycleState ?? "active";
  await db.insert(attachmentObjects).values({
    id: objectId,
    originServerId: input.serverId,
    uploaderId: input.uploaderId,
    uploaderType: "user",
    storageKey: `authority/${objectId}`,
    mimeType: "text/plain",
    sizeBytes: 8,
    lifecycleState,
    ...(lifecycleState === "gc_pending"
      ? { gcToken: randomUUID(), gcStartedAt: new Date() }
      : {}),
  });
  await db.insert(attachments).values({
    id: projectionId,
    objectId,
    messageId: input.messageId,
    pendingChannelId: input.pendingChannelId ?? null,
    createdById: input.uploaderId,
    createdByType: "user",
    channelId: input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: "user",
    filename: `${projectionId}.txt`,
    mimeType: "text/plain",
    sizeBytes: 8,
    storageKey: `authority/${objectId}`,
    ...(input.revoked
      ? {
          revokedAt: new Date(),
          revokedById: input.uploaderId,
          revokedByType: "user" as const,
          revokeReason: "test",
        }
      : {}),
  });
  return projectionId;
}

async function readable(
  projectionId: string,
  serverId: string,
  principal: AttachmentAuthorityPrincipal,
) {
  return resolveReadableAttachmentAuthorityContext({
    projectionId,
    requestServerId: asServerId(serverId),
    principal,
  });
}

test("attachment authority characterizes public, private, DM, thread, user, agent, and server-scoped machine reads", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser(db, "authority-owner");
  const deniedUser = await seedUser(db, "authority-denied");
  const otherOwner = await seedUser(db, "authority-other-owner");
  const server = await createServer("Attachment Authority", `attachment-authority-${randomUUID()}`, owner.id);
  const otherServer = await createServer("Other Authority", `other-authority-${randomUUID()}`, otherOwner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: deniedUser.id, role: "member" });
  const allowedAgent = await seedAgent(db, server.id, "authority-allowed-agent");
  const deniedAgent = await seedAgent(db, server.id, "authority-denied-agent");

  const [publicChannel, privateChannel, dmChannel, threadParentChannel] = await db.insert(channels).values([
    { serverId: server.id, name: `authority-public-${randomUUID()}`, type: "channel" },
    { serverId: server.id, name: `authority-private-${randomUUID()}`, type: "private" },
    { serverId: server.id, name: `authority-dm-${randomUUID()}`, type: "dm" },
    { serverId: server.id, name: `authority-parent-${randomUUID()}`, type: "private" },
  ]).returning();
  await db.insert(channelHumans).values([
    { channelId: privateChannel.id, userId: owner.id },
    { channelId: dmChannel.id, userId: owner.id },
    { channelId: threadParentChannel.id, userId: owner.id },
  ]);
  await db.insert(channelAgents).values([
    { channelId: privateChannel.id, agentId: allowedAgent.id },
    { channelId: dmChannel.id, agentId: allowedAgent.id },
    { channelId: threadParentChannel.id, agentId: allowedAgent.id },
  ]);

  const [publicMessage, privateMessage, dmMessage, threadParentMessage] = await db.insert(messages).values([
    { channelId: publicChannel.id, senderType: "user", senderId: owner.id, content: "public" },
    { channelId: privateChannel.id, senderType: "user", senderId: owner.id, content: "private" },
    { channelId: dmChannel.id, senderType: "user", senderId: owner.id, content: "dm" },
    { channelId: threadParentChannel.id, senderType: "user", senderId: owner.id, content: "parent" },
  ]).returning();
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `authority-thread-${randomUUID()}`,
    type: "thread",
    parentMessageId: threadParentMessage.id,
  }).returning();
  const [threadMessage] = await db.insert(messages).values({
    channelId: threadChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "reply",
  }).returning();

  const projections = await Promise.all([
    seedProjection(db, { messageId: publicMessage.id, channelId: publicChannel.id, serverId: server.id, uploaderId: owner.id }),
    seedProjection(db, { messageId: privateMessage.id, channelId: privateChannel.id, serverId: server.id, uploaderId: owner.id }),
    seedProjection(db, { messageId: dmMessage.id, channelId: dmChannel.id, serverId: server.id, uploaderId: owner.id }),
    seedProjection(db, { messageId: threadMessage.id, channelId: threadChannel.id, serverId: server.id, uploaderId: owner.id }),
  ]);

  for (const projectionId of projections) {
    assert.ok(await readable(projectionId, server.id, { type: "user", id: owner.id }));
    assert.ok(await readable(projectionId, server.id, { type: "agent", id: allowedAgent.id }));
    assert.ok(await readable(projectionId, server.id, { type: "machine", id: randomUUID() }));
    assert.equal(await readable(projectionId, otherServer.id, { type: "machine", id: randomUUID() }), null);
  }

  assert.ok(await readable(projections[0]!, server.id, { type: "user", id: deniedUser.id }));
  assert.ok(await readable(projections[0]!, server.id, { type: "agent", id: deniedAgent.id }));
  for (const projectionId of projections.slice(1)) {
    assert.equal(await readable(projectionId, server.id, { type: "user", id: deniedUser.id }), null);
    assert.equal(await readable(projectionId, server.id, { type: "agent", id: deniedAgent.id }), null);
  }
});

test("attachment authority resolves both joint channel and joint thread faces without exposing canonical storage", async ({ app }) => {
  const db = getDb();
  const ownerA = await seedUser(db, "authority-joint-a");
  const ownerB = await seedUser(db, "authority-joint-b");
  const storageOwner = await seedUser(db, "authority-joint-storage");
  const serverA = await createServer("Authority Joint A", `authority-joint-a-${randomUUID()}`, ownerA.id);
  const serverB = await createServer("Authority Joint B", `authority-joint-b-${randomUUID()}`, ownerB.id);
  const storageServer = await createServer("Authority Joint Storage", `authority-joint-storage-${randomUUID()}`, storageOwner.id);
  const agentA = await seedAgent(db, serverA.id, "authority-joint-agent-a");
  const agentB = await seedAgent(db, serverB.id, "authority-joint-agent-b");

  const [localA, localB, canonical] = await db.insert(channels).values([
    { serverId: serverA.id, name: `joint-local-a-${randomUUID()}`, type: "joint" },
    { serverId: serverB.id, name: `joint-local-b-${randomUUID()}`, type: "joint" },
    { serverId: storageServer.id, name: `joint-canonical-${randomUUID()}`, type: "channel" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: serverA.id, localChannelId: localA.id, role: "host", joinedByUserId: ownerA.id },
    { jointChannelId: joint.id, serverId: serverB.id, localChannelId: localB.id, role: "participant", joinedByUserId: ownerB.id },
  ]);
  await db.insert(channelHumans).values([
    { channelId: localA.id, userId: ownerA.id },
    { channelId: localB.id, userId: ownerB.id },
  ]);
  await db.insert(channelAgents).values([
    { channelId: localA.id, agentId: agentA.id },
    { channelId: localB.id, agentId: agentB.id },
  ]);

  const [jointParent] = await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "user",
    senderId: ownerA.id,
    content: "joint parent",
  }).returning();
  const [localThreadA, localThreadB, canonicalThread] = await db.insert(channels).values([
    { serverId: serverA.id, name: `joint-thread-a-${randomUUID()}`, type: "thread" },
    { serverId: serverB.id, name: `joint-thread-b-${randomUUID()}`, type: "thread" },
    { serverId: storageServer.id, name: `joint-thread-canonical-${randomUUID()}`, type: "thread", parentMessageId: jointParent.id },
  ]).returning();
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: serverA.id,
    createdByUserId: ownerA.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: jointThread.id, serverId: serverA.id, localChannelId: localThreadA.id, role: "host", joinedByUserId: ownerA.id },
    { jointChannelId: jointThread.id, serverId: serverB.id, localChannelId: localThreadB.id, role: "participant", joinedByUserId: ownerB.id },
  ]);

  const [jointMessage, jointThreadMessage] = await db.insert(messages).values([
    { channelId: canonical.id, senderType: "user", senderId: ownerA.id, content: "joint message" },
    { channelId: canonicalThread.id, senderType: "user", senderId: ownerA.id, content: "joint reply" },
  ]).returning();
  const jointProjection = await seedProjection(db, {
    messageId: jointMessage.id,
    channelId: canonical.id,
    serverId: serverA.id,
    uploaderId: ownerA.id,
  });
  const jointThreadProjection = await seedProjection(db, {
    messageId: jointThreadMessage.id,
    channelId: canonicalThread.id,
    serverId: serverA.id,
    uploaderId: ownerA.id,
  });

  for (const [serverId, userId, agentId, expectedChannelIds] of [
    [serverA.id, ownerA.id, agentA.id, [localA.id, localThreadA.id]],
    [serverB.id, ownerB.id, agentB.id, [localB.id, localThreadB.id]],
  ] as const) {
    const channelContext = await readable(jointProjection, serverId, { type: "user", id: userId });
    const threadContext = await readable(jointThreadProjection, serverId, { type: "agent", id: agentId });
    assert.equal(channelContext?.localHostChannel.id, expectedChannelIds[0]);
    assert.equal(threadContext?.localHostChannel.id, expectedChannelIds[1]);
    assert.ok(await readable(jointProjection, serverId, { type: "machine", id: randomUUID() }));
    assert.ok(await readable(jointThreadProjection, serverId, { type: "machine", id: randomUUID() }));
  }

  assert.equal(await readable(jointProjection, serverB.id, { type: "user", id: ownerA.id }), null);
  assert.equal(await readable(jointProjection, storageServer.id, { type: "machine", id: randomUUID() }), null);
  assert.equal(await readable(jointThreadProjection, storageServer.id, { type: "machine", id: randomUUID() }), null);
});

test("attachment authority fails closed for pending, revoked, missing-object, and non-active projections", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser(db, "authority-state-owner");
  const server = await createServer("Authority State", `authority-state-${randomUUID()}`, owner.id);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `authority-state-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "host",
  }).returning();
  const pending = await seedProjection(db, {
    messageId: null,
    channelId: channel.id,
    pendingChannelId: channel.id,
    serverId: server.id,
    uploaderId: owner.id,
  });
  const revoked = await seedProjection(db, {
    messageId: message.id,
    channelId: channel.id,
    serverId: server.id,
    uploaderId: owner.id,
    revoked: true,
  });
  const gcPending = await seedProjection(db, {
    messageId: message.id,
    channelId: channel.id,
    serverId: server.id,
    uploaderId: owner.id,
    lifecycleState: "gc_pending",
  });
  const legacyProjectionId = randomUUID();
  await db.insert(attachments).values({
    id: legacyProjectionId,
    messageId: message.id,
    channelId: channel.id,
    uploaderId: owner.id,
    uploaderType: "user",
    filename: "legacy.txt",
    mimeType: "text/plain",
    sizeBytes: 8,
    storageKey: "authority/legacy",
  });

  for (const projectionId of [pending, revoked, gcPending, legacyProjectionId, randomUUID()]) {
    assert.equal(await resolveBoundAttachmentAuthorityContext({
      projectionId,
      requestServerId: asServerId(server.id),
      principal: { type: "user", id: owner.id },
    }), null);
  }
});
