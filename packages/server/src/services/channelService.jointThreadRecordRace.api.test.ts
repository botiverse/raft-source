import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { vi } from "vitest";
import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, users } from "../db/schema";
import { createServer } from "./serverService";
import { getOrCreateThread, getOrCreateThreadForChannel } from "./channelService";
import { createMessage } from "./messageService";

// #triage task #30: two first opens of the same joint thread at once each read
// "no joint record" for the canonical thread and each inserted one, so their
// local threads hung off different joint records and a reply through one was
// invisible through the other. canonical_channel_id is unique now and the
// loser takes the winner's record.
const test = createApiTest();

test("concurrent first opens of a joint thread share one joint record and one local thread", async ({ app }) => {
  assert.ok(app.baseUrl);
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `joint-record-race-${suffix}@slock.test`, name: `joint-record-race-${suffix}`, passwordHash: "test-only", emailVerified: true,
  }).returning();
  const host = await createServer("Record Race Host", `record-race-host-${suffix}`, owner!.id);
  const peer = await createServer("Record Race Peer", `record-race-peer-${suffix}`, owner!.id);
  const [canonical, hostLocal, peerLocal] = await db.insert(channels).values([
    { serverId: host.id, name: `record-race-canonical-${suffix}`, type: "joint" },
    { serverId: host.id, name: `record-race-host-${suffix}`, type: "joint" },
    { serverId: peer.id, name: `record-race-peer-${suffix}`, type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id, createdByServerId: host.id, createdByUserId: owner!.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: owner!.id },
    { jointChannelId: joint!.id, serverId: peer.id, localChannelId: peerLocal!.id, role: "participant", status: "active", joinedByUserId: owner!.id },
  ]);

  // The canonical thread exists, its joint record does not yet.
  const root = await createMessage(canonical!.id, "user", owner!.id, "record race root");
  const canonicalThread = await getOrCreateThread(root.id, owner!.id, "user");

  // Hold each joint record insert until both openers reach it, so both have
  // already read "no joint record" (the race, made deterministic).
  let arrivals = 0;
  let releaseInserts!: () => void;
  const bothArrived = new Promise<void>((resolve) => { releaseInserts = resolve; });
  const realInsert = db.insert.bind(db);
  const insertSpy = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
    const builder = realInsert(table);
    if (table !== jointChannels) return builder;
    const realValues = builder.values.bind(builder);
    builder.values = ((values: Parameters<typeof realValues>[0]) => {
      const query = realValues(values);
      const realExecute = query.execute;
      query.execute = (async (...args: Parameters<typeof realExecute>) => {
        arrivals += 1;
        if (arrivals >= 2) releaseInserts();
        await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, 5_000))]);
        return realExecute(...args);
      }) as typeof realExecute;
      return query;
    }) as typeof builder.values;
    return builder;
  }) as typeof db.insert);

  let first: Awaited<ReturnType<typeof getOrCreateThreadForChannel>>;
  let second: Awaited<ReturnType<typeof getOrCreateThreadForChannel>>;
  try {
    [first, second] = await Promise.all([
      getOrCreateThreadForChannel(hostLocal!.id, root.id, owner!.id, "user"),
      getOrCreateThreadForChannel(hostLocal!.id, root.id, owner!.id, "user"),
    ]);
  } finally {
    insertSpy.mockRestore();
  }
  assert.equal(arrivals, 2, "both openers tried to create the joint record");

  const records = await db.select({ id: jointChannels.id }).from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, canonicalThread.id));
  assert.equal(records.length, 1, "exactly one joint record for the canonical thread");
  assert.equal(first.id, second.id, "both callers get the same local thread");

  const mappings = await db.select({ serverId: jointChannelServers.serverId, localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .where(eq(jointChannelServers.jointChannelId, records[0]!.id));
  assert.deepEqual(mappings.map((row) => row.serverId).sort(), [host.id, peer.id].sort(), "one projection per server");
  assert.ok(mappings.some((row) => row.localChannelId === first.id), "the returned thread is mapped");

  const threads = await db.select({ id: channels.id }).from(channels)
    .where(and(inArray(channels.serverId, [host.id, peer.id]), eq(channels.type, "thread")));
  const localThreadIds = threads.map((row) => row.id).filter((id) => id !== canonicalThread.id);
  assert.deepEqual(localThreadIds.sort(), mappings.map((row) => row.localChannelId).sort(), "no unmapped local thread is left");
});
