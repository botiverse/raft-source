import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, users } from "../db/schema";
import { createServer } from "./serverService";
import { getOrCreateThreadForChannel } from "./channelService";
import { createMessage } from "./messageService";

// #triage task #30: two requests creating the same server's projection of
// a joint thread at once each inserted a local thread row; only one could
// register the (joint thread, server) mapping, and the loser still returned its
// own unmapped row, so a message could land in a thread nobody can see.
const test = createApiTest();

test("concurrent first opens of a joint thread on a server share one mapped projection", async ({ app }) => {
  assert.ok(app.baseUrl);
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `projection-race-${suffix}@slock.test`, name: `projection-race-${suffix}`, passwordHash: "test-only", emailVerified: true,
  }).returning();
  const host = await createServer("Race Host", `race-host-${suffix}`, owner!.id);
  const peer = await createServer("Race Peer", `race-peer-${suffix}`, owner!.id);
  const [canonical, hostLocal, peerLocal] = await db.insert(channels).values([
    { serverId: host.id, name: `race-canonical-${suffix}`, type: "joint" },
    { serverId: host.id, name: `race-host-${suffix}`, type: "joint" },
    { serverId: peer.id, name: `race-peer-${suffix}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id, createdByServerId: host.id, createdByUserId: owner!.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: owner!.id,
  });

  // The thread exists before the peer joins, so the peer has no projection yet.
  const root = await createMessage(canonical!.id, "user", owner!.id, "race root");
  await getOrCreateThreadForChannel(hostLocal!.id, root.id, owner!.id, "user");
  await db.insert(jointChannelServers).values({
    jointChannelId: joint!.id, serverId: peer.id, localChannelId: peerLocal!.id, role: "participant", status: "active", joinedByUserId: owner!.id,
  });

  const [first, second] = await Promise.all([
    getOrCreateThreadForChannel(peerLocal!.id, root.id, owner!.id, "user"),
    getOrCreateThreadForChannel(peerLocal!.id, root.id, owner!.id, "user"),
  ]);

  assert.equal(first.id, second.id, "both callers get the same local thread");
  const peerThreads = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, peer.id), eq(channels.type, "thread")));
  assert.deepEqual(peerThreads.map((row) => row.id), [first.id], "no unmapped thread row is left on the peer");
  const [mapping] = await db.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, first.id));
  assert.ok(mapping, "the returned thread is the mapped projection");
});
