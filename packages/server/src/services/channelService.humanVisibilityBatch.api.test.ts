import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelHumans, channels, serverMembers, servers } from "../db/schema";
import { seedBoundGuest } from "../test/guestFixture";
import { actorsShownToPerson } from "../platform/actors";
import {
  addHuman,
  canUserSeeHumanThroughLocalChannel,
  canUserSeeHumansThroughLocalChannel,
  createChannel,
  findOrCreateUserDM,
  getSystemAllChannel,
  removeHuman,
} from "./channelService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

// The batched canUserSeeHumansThroughLocalChannel is pinned to the single
// canUserSeeHumanThroughLocalChannel (the member profile route's rule), which
// stays the oracle: every requester and target below gets the same answer.
test("canUserSeeHumansThroughLocalChannel answers every target exactly as canUserSeeHumanThroughLocalChannel, for owners, members and guests", async ({ seed }) => {
  const db = getDb();
  const label = () => randomUUID().slice(0, 8);
  const owner = await seed.human();
  const member = await seed.human();
  const guest = await seed.human();
  const people = {
    joined: await seed.human(), // the guest's one channel (#wg-rbac:#15), private, with the member
    guestOpen: await seed.human(), // only a public channel guest-visible by the old flag, the guest not in it
    open: await seed.human(), // only a plain public channel, with the member, the guest not in it
    joinedOpen: await seed.human(), // a plain public channel the guest is in, not its channel
    archived: await seed.human(), // an archived private conversation with the guest and the member
    deleted: await seed.human(), // a deleted private conversation with the guest and the member
    left: await seed.human(), // left the private conversation with the guest and the member
    dm: await seed.human(), // a DM with the guest, and one with the member
    onlyAll: await seed.human(), // only #all
  };
  const elsewhere = await seed.human(); // a conversation with the guest on another server only
  const stranger = await seed.human(); // not of the server
  const server = await seed.server({ owner, members: [member, guest, ...Object.values(people)] });
  const other = await seed.server({ owner, members: [guest, elsewhere] });

  const conversation = async (type: "channel" | "private", humans: Array<{ id: string }>, set: Partial<typeof channels.$inferInsert> = {}, serverId = server.id) => {
    const channel = await createChannel(serverId, `seen-${label()}`, undefined, type);
    for (const human of humans) await addHuman(channel.id, human.id);
    if (Object.keys(set).length > 0) await db.update(channels).set(set).where(eq(channels.id, channel.id));
    return channel;
  };
  const home = await conversation("private", [member, people.joined]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: home.id });
  await conversation("channel", [people.guestOpen], { guestVisible: true });
  await conversation("channel", [member, people.open]);
  await conversation("channel", [guest, people.joinedOpen]);
  await conversation("private", [guest, member, people.archived], { archivedAt: new Date() });
  await conversation("private", [guest, member, people.deleted], { deletedAt: new Date() });
  const leftRoom = await conversation("private", [guest, member, people.left]);
  await removeHuman(leftRoom.id, people.left.id, { self: true });
  await findOrCreateUserDM(server.id, guest.id, people.dm.id);
  await findOrCreateUserDM(server.id, member.id, people.dm.id);
  await conversation("private", [guest, elsewhere], {}, other.id);
  // A stale row for someone not of the server, in a conversation with the guest.
  const strangerRoom = await conversation("private", [guest, member]);
  await db.insert(channelHumans).values({ channelId: strangerRoom.id, userId: stranger.id });

  const targets = [owner, member, guest, ...Object.values(people), elsewhere, stranger].map((user) => user.id);
  targets.push(randomUUID());
  const parity = async (state: string) => {
    const answers = new Map<string, Set<string>>();
    for (const requester of [owner, member, guest]) {
      const batch = await canUserSeeHumansThroughLocalChannel(server.id, requester.id, targets);
      const single = new Set<string>();
      for (const target of targets) if (await canUserSeeHumanThroughLocalChannel(server.id, requester.id, target)) single.add(target);
      assert.deepEqual([...batch].sort(), [...single].sort(), `${state}: requester ${requester.name}`);
      answers.set(requester.id, batch);
    }
    return answers;
  };

  // The matrix reaches both answers (parity is not vacuous).
  const base = await parity("#all hidden from guests");
  const guestSees = base.get(guest.id)!;
  // A guest sees only the people of its one channel.
  assert.deepEqual([...guestSees].sort(), [guest.id, member.id, people.joined.id].sort());
  for (const unseen of [owner, people.guestOpen, people.open, people.joinedOpen, people.archived, people.deleted, people.left, people.dm, people.onlyAll, elsewhere, stranger]) assert.ok(!guestSees.has(unseen.id), `guest does not see ${unseen.name}`);
  const memberSees = base.get(member.id)!;
  for (const seen of [member, guest, people.joined, people.open, people.archived, people.dm, stranger]) assert.ok(memberSees.has(seen.id), `member sees ${seen.name}`);
  for (const unseen of [owner, people.guestOpen, people.deleted, people.left, people.onlyAll, elsewhere]) assert.ok(!memberSees.has(unseen.id), `member does not see ${unseen.name}`);

  // #all revealed and guest-visible by the old flag: a guest sees no one more.
  const allChannel = (await getSystemAllChannel(server.id))!;
  await db.update(channels).set({ type: "channel", guestVisible: true }).where(eq(channels.id, allChannel.id));
  const withAll = (await parity("#all open to guests")).get(guest.id)!;
  assert.deepEqual([...withAll].sort(), [...guestSees].sort(), "#all grants a guest no one");

  // Its channel archived: a guest sees only itself.
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, home.id));
  assert.deepEqual([...(await parity("guest channel archived")).get(guest.id)!], [guest.id]);
  await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, home.id));

  // Removed from its channel: a guest sees only itself.
  await db.delete(channelHumans).where(and(eq(channelHumans.channelId, home.id), eq(channelHumans.userId, guest.id)));
  assert.deepEqual([...(await parity("guest removed from its channel")).get(guest.id)!], [guest.id]);
});

// What the Artifacts mention picker runs per keystroke (actorsShownToPerson
// over up to 40 candidates): a fixed number of queries, not one per person.
test("canUserSeeHumansThroughLocalChannel, and actorsShownToPerson over it, answer a guest and a member of a server hiding its people in a fixed number of queries, whatever the number of people asked about", async ({ seed }) => {
  const db = getDb();
  const owner = await seed.human();
  const guest = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [guest, member] });
  const serverId = server.id as ServerId;
  await db.update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));
  const room = await createChannel(server.id, `count-${randomUUID().slice(0, 8)}`, undefined, "private");
  await addHuman(room.id, member.id);
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: room.id });
  const ids: string[] = [];
  const addPeople = async (size: number) => {
    for (let i = 0; i < size; i += 1) {
      const human = await seed.human();
      await db.insert(serverMembers).values({ serverId: server.id, userId: human.id, role: "member" });
      // Half met in the room, half not (so the guest's #all step runs too).
      if (i % 2 === 0) await addHuman(room.id, human.id);
      ids.push(human.id);
    }
  };
  const counted = async <T>(run: () => Promise<T>): Promise<{ queries: number; answer: T }> => {
    const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
    const originalQuery = pg.query.bind(pg);
    let queries = 0;
    pg.query = ((...args: unknown[]) => {
      queries += 1;
      return originalQuery(...args);
    }) as PgliteLike["query"];
    try {
      const answer = await run();
      return { queries, answer };
    } finally {
      pg.query = originalQuery;
    }
  };
  const count = async () => ({
    batch: await counted(() => canUserSeeHumansThroughLocalChannel(server.id, guest.id, ids)),
    guest: await counted(() => actorsShownToPerson(serverId, guest.id, ids.map((id) => ({ type: "user" as const, id })), 40)),
    member: await counted(() => actorsShownToPerson(serverId, member.id, ids.map((id) => ({ type: "user" as const, id })), 40)),
  });

  await addPeople(2);
  const few = await count();
  await addPeople(10);
  const many = await count();
  for (const which of ["batch", "guest", "member"] as const) {
    assert.ok(few[which].queries > 0, `${which}: queries are counted`);
    assert.equal(many[which].queries, few[which].queries, `${which}: 2 people, ${few[which].queries} queries; 12 people, ${many[which].queries}`);
  }
  assert.equal(few.batch.answer.size, 1);
  assert.equal(many.batch.answer.size, 6);
  assert.equal(many.guest.answer.length, 6);
  assert.equal(many.member.answer.length, 6);
});
