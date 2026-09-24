import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  users,
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import { resolveExternalConversationTarget } from "./externalConversationTargetService.js";
import { resolveSlackOutboundMessageSurface } from "./slackBridgeDatabaseOutboundRuntime.js";
import { listSlackBridgeRaftConversationTargets } from "./slackBridgeProvisioningControlPlane.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("external conversation target preserves ordinary identity and maps only active Joint projections", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `external-target-${randomUUID()}@test.invalid`,
    name: `external-target-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const host = await createServer("External target host", `external-target-host-${randomUUID()}`, owner.id);
  const peer = await createServer("External target peer", `external-target-peer-${randomUUID()}`, owner.id);
  const storage = await createServer("External target storage", `external-target-storage-${randomUUID()}`, owner.id);
  const [ordinary, hostLocal, peerLocal, canonical] = await db.insert(channels).values([
    { serverId: host.id, name: "ordinary", type: "channel" },
    { serverId: host.id, name: "host-local", type: "joint" },
    { serverId: peer.id, name: "peer-local", type: "joint" },
    { serverId: storage.id, name: "canonical", type: "channel" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: host.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([{
    jointChannelId: joint.id,
    serverId: host.id,
    localChannelId: hostLocal.id,
    role: "host",
    joinedByUserId: owner.id,
  }, {
    jointChannelId: joint.id,
    serverId: peer.id,
    localChannelId: peerLocal.id,
    role: "participant",
    joinedByUserId: owner.id,
  }]);

  assert.deepEqual(await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: ordinary.id,
    expectedStorageChannelId: ordinary.id,
  }), {
    kind: "ordinary",
    authorityChannelId: ordinary.id,
    storageChannelId: ordinary.id,
    bindingChannelId: ordinary.id,
    level: "top_level",
    canonicalRootMessageId: null,
    serverId: host.id,
  });

  const hostTarget = await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: hostLocal.id,
    expectedStorageChannelId: canonical.id,
  });
  assert.deepEqual(hostTarget, {
    kind: "joint",
    authorityChannelId: hostLocal.id,
    storageChannelId: canonical.id,
    bindingChannelId: hostLocal.id,
    level: "top_level",
    canonicalRootMessageId: null,
    serverId: host.id,
    jointChannelId: joint.id,
    role: "host",
  });
  assert.deepEqual(await resolveSlackOutboundMessageSurface({
    executor: db,
    requestedChannelId: hostLocal.id,
    messageChannelId: canonical.id,
  }), {
    level: "top_level",
    authorityConversationId: hostLocal.id,
    bindingChannelId: hostLocal.id,
    canonicalRootMessageId: null,
  });
  assert.equal(await resolveSlackOutboundMessageSurface({
    executor: db,
    requestedChannelId: peerLocal.id,
    messageChannelId: canonical.id,
  }), null, "a participant projection cannot attach or reuse the host endpoint");
  assert.equal((await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: peerLocal.id,
  }))?.kind, "joint");
  assert.equal((await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: peerLocal.id,
  }) as { role?: string } | null)?.role, "participant");
  assert.equal(await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: canonical.id,
    expectedStorageChannelId: canonical.id,
  }), null, "canonical storage cannot be presented as the binding authority");
  assert.equal(await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: hostLocal.id,
    expectedStorageChannelId: hostLocal.id,
  }), null, "Joint messages must already be stored in canonical storage");
  const hostProvisioningTargets = await listSlackBridgeRaftConversationTargets(db, host.id);
  const hostTargetIds = new Set(hostProvisioningTargets.map((channel) => channel.id));
  assert.equal(hostTargetIds.has(ordinary.id), true);
  assert.equal(hostTargetIds.has(hostLocal.id), true,
    "provisioning admits the active Joint host projection");
  assert.equal(hostTargetIds.has(canonical.id), false,
    "canonical storage is never a provisioning target");
  const peerTargetIds = new Set((await listSlackBridgeRaftConversationTargets(db, peer.id))
    .map((channel) => channel.id));
  assert.equal(peerTargetIds.has(peerLocal.id), false,
    "a participant projection cannot attach a second external endpoint");

  const [root] = await db.insert(messages).values({
    channelId: canonical.id,
    senderType: "user",
    senderId: owner.id,
    content: "joint root",
  }).returning();
  const [hostThread, peerThread, canonicalThread] = await db.insert(channels).values([
    { serverId: host.id, name: "host-thread", type: "thread" },
    { serverId: peer.id, name: "peer-thread", type: "thread" },
    { serverId: storage.id, name: "canonical-thread", type: "thread", parentMessageId: root.id },
  ]).returning();
  // This test deliberately uses the canonical parent identity written by the
  // Joint thread projection contract.
  await db.update(messages).set({ threadId: canonicalThread.id })
    .where(eq(messages.id, root.id));
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: host.id,
    createdByUserId: owner.id,
  }).returning();
  await db.insert(jointChannelServers).values([{
    jointChannelId: jointThread.id,
    serverId: host.id,
    localChannelId: hostThread.id,
    role: "host",
    joinedByUserId: owner.id,
  }, {
    jointChannelId: jointThread.id,
    serverId: peer.id,
    localChannelId: peerThread.id,
    role: "participant",
    joinedByUserId: owner.id,
  }]);

  assert.deepEqual(await resolveExternalConversationTarget({
    executor: db,
    authorityChannelId: hostThread.id,
    expectedStorageChannelId: canonicalThread.id,
  }), {
    kind: "joint",
    authorityChannelId: hostThread.id,
    storageChannelId: canonicalThread.id,
    bindingChannelId: hostLocal.id,
    level: "thread",
    canonicalRootMessageId: root.id,
    serverId: host.id,
    jointChannelId: jointThread.id,
    role: "host",
  });
  assert.deepEqual(await resolveSlackOutboundMessageSurface({
    executor: db,
    requestedChannelId: hostThread.id,
    messageChannelId: canonicalThread.id,
  }), {
    level: "thread",
    authorityConversationId: hostThread.id,
    bindingChannelId: hostLocal.id,
    canonicalRootMessageId: root.id,
  });
});
