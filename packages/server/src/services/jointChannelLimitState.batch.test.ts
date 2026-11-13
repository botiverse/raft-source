// Batch joint-limit lookup used by list endpoints (sidebar-order). The sidebar
// used to resolve the parent joint and read its limit state per joint channel
// under Promise.all -- two statements per joint, all concurrent, which drained
// the pool on every sidebar load for servers with many joint channels.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, jointChannels, servers, users } from "../db/schema";
import { createServer } from "./serverService";
import { attachJointChannelMetadata, createJointChannel, getOrCreateThreadForChannel } from "./channelService";
import { createMessage } from "./messageService";
import { getJointLimitState, getJointLimitStatesForJoints, resolveParentJointId } from "./jointChannelLimitState";

afterEach(async () => {
  await closeTestDatabase();
});

type PgliteLike = {
  query: (...args: unknown[]) => Promise<unknown>;
};

async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; count: number }> {
  const client = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = client.query.bind(client);
  let count = 0;
  client.query = ((...args: unknown[]) => {
    count += 1;
    return originalQuery(...args);
  }) as PgliteLike["query"];
  try {
    return { result: await fn(), count };
  } finally {
    client.query = originalQuery;
  }
}

async function seedHost() {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `host-${suffix}@slock.test`,
    name: `host-${suffix}`,
    displayName: "host",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(`host ${suffix}`, `host-${suffix}`, owner.id);
  return { owner, server };
}

async function createJoints(host: Awaited<ReturnType<typeof seedHost>>, n: number) {
  // A joint needs at least one invite; a pending one is enough here.
  const peer = await seedHost();
  // A free server hosts only one joint; these cases need several.
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, host.server.id));
  const created = [];
  for (let i = 0; i < n; i += 1) {
    created.push(await createJointChannel({
      hostServerId: host.server.id,
      createdByUserId: host.owner.id,
      name: `joint-${randomUUID().slice(0, 8)}`,
      jointInvites: [{ targetServerSlug: peer.server.slug, invitedPeople: [peer.owner.email] }],
    }));
  }
  return created;
}

async function localRows(localIds: string[]) {
  const rows = [];
  for (const id of localIds) {
    const [row] = await getDb()
      .select({ id: channels.id, type: channels.type, serverId: channels.serverId })
      .from(channels)
      .where(eq(channels.id, id));
    rows.push(row);
  }
  return rows;
}

test("attachJointChannelMetadata issues the same number of queries for 1 and 5 joint channels", async ({ db: _db }) => {
  const host = await seedHost();
  const joints = await createJoints(host, 5);
  const rows = await localRows(joints.map((joint) => joint.channel.id));

  const one = await countQueries(() => attachJointChannelMetadata(rows.slice(0, 1)));
  const five = await countQueries(() => attachJointChannelMetadata(rows));

  assert.ok(one.count > 0, "the counter must observe queries, or the equality below proves nothing");
  assert.equal(five.count, one.count);
  assert.equal(five.result.filter((row) => row.jointChannelId).length, 5);
});

test("getJointLimitStatesForJoints matches the per-joint lookup for top-level and sub-thread joints", async ({ db: _db }) => {
  const host = await seedHost();
  const [overLimit, clean] = await createJoints(host, 2);
  const since = new Date(Date.now() - 60_000);
  await getDb().update(jointChannels).set({ overLimitSince: since }).where(eq(jointChannels.id, overLimit.jointChannel.id));

  // A sub-thread of the over-limit joint gets its own joint record with no state.
  const parent = await createMessage(overLimit.jointChannel.canonicalChannelId, "user", host.owner.id, "parent");
  const thread = await getOrCreateThreadForChannel(overLimit.channel.id, parent.id, host.owner.id, "user");
  const [threadJoint] = await getDb()
    .select({ id: jointChannels.id })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, thread.canonicalThreadChannelId));
  assert.ok(threadJoint);

  const ids = [overLimit.jointChannel.id, clean.jointChannel.id, threadJoint.id, randomUUID()];
  const now = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const batch = await getJointLimitStatesForJoints(getDb(), ids, now);

  for (const id of ids) {
    const parentJointId = await resolveParentJointId(getDb(), id);
    const expected = parentJointId ? await getJointLimitState(getDb(), parentJointId, now) : null;
    assert.deepEqual(batch.get(id), expected, `joint ${id}`);
  }
  assert.equal(batch.get(threadJoint.id)?.parentJointId, overLimit.jointChannel.id);
  assert.equal(batch.get(threadJoint.id)?.readOnly, true);
  assert.equal(batch.get(clean.jointChannel.id)?.readOnly, false);
});
