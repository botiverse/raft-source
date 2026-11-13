import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelHumans, channels } from "../db/schema";
import { seedBoundGuest } from "../test/guestFixture";
import { createAgent } from "./agentService";
import {
  addHuman,
  canUserAccessChannel,
  createChannel,
  filterUserAccessibleChannelIds,
  findOrCreateDM,
  getOrCreateThreadForChannel,
} from "./channelService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

test("filterUserAccessibleChannelIds answers every channel type exactly as canUserAccessChannel, for members and guests", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [member, guest] });
  const other = await seed.server({ owner });
  const db = getDb();

  const label = () => randomUUID().slice(0, 8);
  const open = await createChannel(server.id, `parity-open-${label()}`);
  const guestOpen = await createChannel(server.id, `parity-guest-open-${label()}`);
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, guestOpen.id));
  const joined = await createChannel(server.id, `parity-joined-${label()}`, undefined, "private");
  await addHuman(joined.id, member.id);
  // The guest's one channel (#wg-rbac:#15); another it is a member of grants it nothing.
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: joined.id });
  const guestOther = await createChannel(server.id, `parity-guest-other-${label()}`, undefined, "private");
  await addHuman(guestOther.id, guest.id);
  const closed = await createChannel(server.id, `parity-closed-${label()}`, undefined, "private");
  const archived = await createChannel(server.id, `parity-archived-${label()}`);
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));
  const deleted = await createChannel(server.id, `parity-deleted-${label()}`);
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted.id));
  const elsewhere = await createChannel(other.id, `parity-elsewhere-${label()}`);
  const agent = await createAgent(server.id, `parity-agent-${label()}`, { runtime: "claude", model: "sonnet" });
  const memberDm = (await findOrCreateDM(server.id, member.id, agent.id))!;
  const guestDm = (await findOrCreateDM(server.id, guest.id, agent.id))!;
  const ownerDm = (await findOrCreateDM(server.id, owner.id, agent.id))!;

  const threadOf = async (channel: { id: string; name: string; type: string }) => {
    const root = await seed.message({ channel: channel as never, author: owner, content: `root ${channel.name}` });
    return (await getOrCreateThreadForChannel(channel.id, root.id, owner.id, "user")).id;
  };
  const threads = {
    open: await threadOf(open),
    guestOpen: await threadOf(guestOpen),
    joined: await threadOf(joined),
    guestOther: await threadOf(guestOther),
    closed: await threadOf(closed),
  };
  const [orphanThread] = await db.insert(channels).values({ serverId: server.id, name: `parity-orphan-${label()}`, type: "thread" }).returning();
  // A legacy membership row on a parentless thread (addHuman refuses threads).
  await db.insert(channelHumans).values({ channelId: orphanThread.id, userId: member.id });
  // Emulate pre-CHECK orphan history; current writes must satisfy the cache invariant.
  await db.execute(sql`ALTER TABLE channels DROP CONSTRAINT channels_parent_message_requires_channel`);
  const [missingParentThread] = await db.insert(channels).values({ serverId: server.id, name: `parity-missing-${label()}`, type: "thread", parentMessageId: randomUUID() }).returning();

  const ids = [
    open.id, guestOpen.id, joined.id, guestOther.id, closed.id, archived.id, deleted.id, elsewhere.id,
    memberDm.id, guestDm.id, ownerDm.id,
    ...Object.values(threads), orphanThread.id, missingParentThread.id, randomUUID(),
  ];
  for (const user of [owner, member, guest]) {
    const batch = await filterUserAccessibleChannelIds(ids, user.id, server.id as ServerId);
    const single = new Set<string>();
    for (const id of ids) if (await canUserAccessChannel(id, user.id, server.id as ServerId)) single.add(id);
    assert.deepEqual([...batch].sort(), [...single].sort(), `user ${user.name}`);
  }
  // The matrix reaches both answers for both kinds of user (parity is not vacuous).
  const memberBatch = await filterUserAccessibleChannelIds(ids, member.id, server.id as ServerId);
  assert.ok(memberBatch.has(memberDm.id) && !memberBatch.has(ownerDm.id) && memberBatch.has(threads.joined) && !memberBatch.has(threads.closed) && memberBatch.has(orphanThread.id));
  const guestBatch = await filterUserAccessibleChannelIds(ids, guest.id, server.id as ServerId);
  assert.deepEqual([...guestBatch].sort(), [joined.id, threads.joined].sort(), "a guest: its one channel and its threads, nothing else");
});

test("filterUserAccessibleChannelIds checks threads and DMs in a fixed number of queries", async ({ seed }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const room = await createChannel(server.id, `count-room-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(room.id, member.id);
  const ids: string[] = [];
  const addThreadsAndDms = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const root = await seed.message({ channel: room as never, author: owner, content: `root ${i}` });
      ids.push((await getOrCreateThreadForChannel(room.id, root.id, owner.id, "user")).id);
      const agent = await createAgent(server.id, `count-agent-${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
      ids.push((await findOrCreateDM(server.id, member.id, agent.id))!.id);
    }
  };
  const count = async () => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const accessible = await filterUserAccessibleChannelIds(ids, member.id, server.id as ServerId);
      return { queries, accessible };
    } finally {
      pg.query = originalQuery;
    }
  };

  await addThreadsAndDms(2);
  const few = await count();
  await addThreadsAndDms(8);
  const many = await count();
  assert.equal(few.accessible.size, 4);
  assert.equal(many.accessible.size, 20);
  assert.equal(many.queries, few.queries, `4 ids: ${few.queries} queries, 20 ids: ${many.queries}`);
});
