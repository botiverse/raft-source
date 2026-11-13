import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, users } from "../db/schema";
import { createServer } from "./serverService";
import { getMessageStorageChannelIdWithExecutor, resolveLocalMessageStorage } from "./channelService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// The batched storage lookup (Activity turn triggers, #10838) maps a joint
// projection to its canonical channel only while both the projection's link
// and the joint channel are active, like the single-channel helper: a
// disconnected link or a closed joint channel falls back to the channel itself.
test("batched local message storage maps only active joint channels, as the single-channel helper does", async ({ app }) => {
  void app; // the fixture starts the database
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `local-storage-${randomUUID()}@slock.test`,
    name: "local-storage-owner",
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Local Storage", `local-storage-${randomUUID()}`, owner.id);
  const storageServer = await createServer("Local Storage Canonical", `local-storage-canonical-${randomUUID()}`, owner.id);

  const [activeLocal, disconnectedLocal, closedLocal, activeCanonical, disconnectedCanonical, closedCanonical] = await db.insert(channels).values([
    { serverId: server.id, name: "active-local", type: "joint" },
    { serverId: server.id, name: "disconnected-local", type: "joint" },
    { serverId: server.id, name: "closed-local", type: "joint" },
    { serverId: storageServer.id, name: "active-canonical", type: "channel" },
    { serverId: storageServer.id, name: "disconnected-canonical", type: "channel" },
    { serverId: storageServer.id, name: "closed-canonical", type: "channel" },
  ]).returning();
  const [activeJoint, disconnectedJoint, closedJoint] = await db.insert(jointChannels).values([
    { canonicalChannelId: activeCanonical.id, createdByServerId: server.id, createdByUserId: owner.id },
    { canonicalChannelId: disconnectedCanonical.id, createdByServerId: server.id, createdByUserId: owner.id },
    { canonicalChannelId: closedCanonical.id, createdByServerId: server.id, createdByUserId: owner.id, status: "closed" },
  ]).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: activeJoint.id, serverId: server.id, localChannelId: activeLocal.id, role: "host", joinedByUserId: owner.id },
    { jointChannelId: disconnectedJoint.id, serverId: server.id, localChannelId: disconnectedLocal.id, role: "host", joinedByUserId: owner.id, status: "disconnected" },
    { jointChannelId: closedJoint.id, serverId: server.id, localChannelId: closedLocal.id, role: "host", joinedByUserId: owner.id },
  ]);

  const locals = [activeLocal, disconnectedLocal, closedLocal];
  const batched = await resolveLocalMessageStorage(server.id, locals.map((channel) => ({ id: channel.id, type: channel.type })));
  assert.deepEqual(batched.get(activeLocal.id), { storageChannelId: activeCanonical.id });
  assert.equal(batched.has(disconnectedLocal.id), false, "a disconnected link falls back to the channel itself");
  assert.equal(batched.has(closedLocal.id), false, "a closed joint channel falls back to the channel itself");

  for (const channel of locals) {
    const single = await getMessageStorageChannelIdWithExecutor(db, channel.id);
    assert.equal(batched.get(channel.id)?.storageChannelId ?? channel.id, single, `${channel.name}: batched and single-channel helpers agree`);
  }
});
