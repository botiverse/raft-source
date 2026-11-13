import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channelHumans, channels, threadFollows, userChannelInboxStates, messageMentions } from "../db/schema";
import { getDoneInboxItems, getFollowedThreads, getInboxItems } from "../services/channelService";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
for (const surface of ["done", "followed", "mention"] as const) {
  test(`guest ${surface} reads recheck current visibility`, async ({ seed, db }) => {
    const owner = await seed.human(); const guest = await seed.human();
    const server = await seed.server({ owner, members: [guest] });
    const channel = await seed.channel({ server, members: [owner], visibility: "channel" });
    // The guest reads its one channel while it is a member (#wg-rbac:#15).
    await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
    const parent = await seed.message({ channel, author: owner, content: "audit-inbox-secret" });
    const [thread] = await db.insert(channels).values({ serverId: server.id, name: "audit-thread", type: "thread", parentMessageId: parent.id }).returning();
    await db.insert(threadFollows).values({ threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: guest.id });
    await seed.message({ channel: thread, author: owner, content: "audit-new-thread-secret" });
    if (surface === "done") await db.insert(userChannelInboxStates).values({ userId: guest.id, channelId: channel.id, doneAt: new Date() });
    // Durable notified residue models a mention delivered before visibility
    // revocation (no claim that a fresh hidden mention is initially notifiable).
    if (surface === "mention") await db.insert(messageMentions).values({ messageId: parent.id, serverId: server.id, channelId: channel.id, messageSeq: parent.seq, targetType: "user", targetId: guest.id, handleAtSendTime: guest.name, notifiedAt: new Date() });
    const read = async () => surface === "done" ? (await getDoneInboxItems(server.id, guest.id)).items
      : surface === "followed" ? await getFollowedThreads(server.id, guest.id)
      : (await getInboxItems(server.id, guest.id, { filter: "mentions", forcePostgres: true })).items;
    assert.ok((await read()).length > 0, "positive visible control");
    // Removed from its channel: access ends, whatever residue is left.
    await db.delete(channelHumans).where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, guest.id)));
    assert.deepEqual(await read(), [], "residual follows/done/mentions must not grant access");
  });
}

test("guest followed threads check each parent channel once, not once per thread", async ({ seed, db }) => {
  type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };
  const owner = await seed.human(); const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  const channel = await seed.channel({ server, members: [owner], visibility: "channel" });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: channel.id });
  const followThreads = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const parent = await seed.message({ channel, author: owner, content: `parent ${i}` });
      const [thread] = await db.insert(channels).values({ serverId: server.id, name: `count-thread-${parent.id.slice(0, 8)}`, type: "thread", parentMessageId: parent.id }).returning();
      await db.insert(threadFollows).values({ threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: guest.id });
      await seed.message({ channel: thread, author: owner, content: `reply ${i}` });
    }
  };
  const countFollowed = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let count = 0;
    pg.query = ((...args: unknown[]) => {
      count += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const threads = await getFollowedThreads(server.id, guest.id);
      return { count, threads };
    } finally {
      pg.query = originalQuery;
    }
  };

  await followThreads(1);
  await countFollowed();
  const few = await countFollowed();
  await followThreads(8);
  await countFollowed();
  const many = await countFollowed();

  assert.ok(few.count > 0, "the counter must observe queries");
  assert.equal(many.threads.length, few.threads.length + 8);
  // All threads share one parent channel: one access check, however many threads.
  assert.equal(many.count, few.count, `${few.threads.length} threads: ${few.count} queries, ${many.threads.length} threads: ${many.count}`);
});
