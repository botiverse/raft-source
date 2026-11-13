import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { servers, threadFollows } from "../db/schema";
import { addMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { addHuman, createChannel, getOrCreateThread, inboxItemRowId, recordThreadFollow, type InboxItem } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// GET /channels/inbox?ids=: refresh a few Activity rows by their own id (a
// channel/DM row's channelId, a thread/task row's threadChannelId) with the
// list's row shape and visibility.

type InboxResponse = { items: InboxItem[] };

const LONG_PARENT = "the plan we agreed on in the summer offsite, with every number spelled out in full";

async function seedFixture() {
  const owner = await seedUser("ids-owner@slock.test", "ids-owner");
  const peer = await seedUser("ids-peer@slock.test", "ids-peer");
  const follower = await seedUser("ids-follower@slock.test", "ids-follower");
  const server = await createServer("Ids Server", "ids-server", owner.id);
  // Free plan: messages older than 30 days are behind the history window.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  await addMember(server.id, peer.id);
  await addMember(server.id, follower.id);

  const room = await createChannel(server.id, "ids-room");
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  const parent = await createMessage(room.id, "user", peer.id, LONG_PARENT);
  await getDb().execute(sql`UPDATE messages SET created_at = now() - interval '40 days' WHERE id = ${parent.id}::uuid`);
  const thread = await getOrCreateThread(parent.id, peer.id, "user");
  await createMessage(thread.id, "user", peer.id, "a fresh reply under an old start");
  await recordThreadFollow("user", owner.id, thread.id, parent.id, "manual");
  await recordThreadFollow("user", follower.id, thread.id, parent.id, "manual");
  const otherParent = await createMessage(room.id, "user", peer.id, "another thread start");
  const otherThread = await getOrCreateThread(otherParent.id, peer.id, "user");
  await createMessage(otherThread.id, "user", peer.id, "another reply");
  await recordThreadFollow("user", owner.id, otherThread.id, otherParent.id, "manual");
  // Unfollowed, not Done: Activity All merges it in from a separate read.
  const unfollowedParent = await createMessage(room.id, "user", peer.id, "an unfollowed thread start");
  const unfollowedThread = await getOrCreateThread(unfollowedParent.id, peer.id, "user");
  await createMessage(unfollowedThread.id, "user", peer.id, "an unfollowed reply");
  await getDb().insert(threadFollows).values({
    threadChannelId: unfollowedThread.id, followerType: "user", followerId: owner.id, parentMessageId: unfollowedParent.id, reason: "manual", unfollowedAt: new Date(),
  });
  await createMessage(room.id, "user", peer.id, "room activity");

  const control = await createChannel(server.id, "ids-control");
  await addHuman(control.id, owner.id);
  await createMessage(control.id, "user", peer.id, "control activity");

  // The peer's private channel: the owner is not a member.
  const peerPrivate = await createChannel(server.id, "ids-peer-private", undefined, "private");
  await addHuman(peerPrivate.id, peer.id);
  await createMessage(peerPrivate.id, "user", peer.id, "peer-only secret");

  return { owner, peer, follower, server, room, thread, otherThread, unfollowedThread, control, peerPrivate };
}

async function readInbox(baseUrl: string, token: string, serverId: string, query: string) {
  const res = await fetch(`${baseUrl}/api/channels/inbox?${query}`, { headers: headers(token, serverId) });
  return { status: res.status, body: await res.json() as InboxResponse & { error?: string } };
}

test("GET /channels/inbox?ids= returns exactly the rows with those own ids, as the list shows them", async ({ app }) => {
  const f = await seedFixture();
  const token = await tokenForHuman(f.owner.email);
  const fetchInbox = async (query: string) => {
    const { status, body } = await readInbox(app.baseUrl, token, f.server.id, query);
    assert.equal(status, 200, `${query}: ${JSON.stringify(body)}`);
    return body;
  };

  const list = await fetchInbox("filter=all&limit=100");
  const listRow = (id: string) => list.items.find((item) => inboxItemRowId(item) === id);
  for (const id of [f.room.id, f.thread.id, f.otherThread.id, f.unfollowedThread.id, f.control.id]) {
    assert.ok(listRow(id), `control: ${id} is in the list`);
  }

  // A channel row by its channelId: that row only, not the threads below it.
  const room = await fetchInbox(`ids=${f.room.id}`);
  assert.deepEqual(room.items.map(inboxItemRowId), [f.room.id]);
  assert.equal(room.items[0]!.kind, "channel");
  assert.deepEqual(room.items[0], listRow(f.room.id), "same row as the list");
  assert.deepEqual(Object.keys(room), ["items"], "an ids read is the rows only: no totals, groups, unread counts or hasMore");

  // An unfollowed thread row (the merged read) by its threadChannelId.
  const unfollowed = await fetchInbox(`ids=${f.unfollowedThread.id}`);
  assert.deepEqual(unfollowed.items.map(inboxItemRowId), [f.unfollowedThread.id]);
  assert.deepEqual(unfollowed.items[0], listRow(f.unfollowedThread.id), "same row as the list");

  // A thread row by its threadChannelId, with the history window still applied.
  const thread = await fetchInbox(`ids=${f.thread.id}&filter=all`);
  assert.deepEqual(thread.items.map(inboxItemRowId), [f.thread.id]);
  assert.deepEqual(thread.items[0], listRow(f.thread.id), "same row as the list");
  const threadRow = thread.items[0]!;
  assert.ok(threadRow.kind === "thread");
  assert.equal(threadRow.parentMessagePreview, "the plan we agreed on in the summer off…", "a start behind the window is a glimpse");

  // Several ids, in list order; ids the viewer cannot see or that do not exist are absent.
  const several = await fetchInbox(`ids=${[f.peerPrivate.id, f.thread.id, randomUUID(), f.room.id.toUpperCase(), f.room.id].join(",")}`);
  assert.deepEqual(
    several.items.map(inboxItemRowId),
    list.items.map(inboxItemRowId).filter((id) => id === f.room.id || id === f.thread.id),
  );
  assert.ok(!JSON.stringify(several).includes("peer-only secret"));
});

test("GET /channels/inbox?ids= keeps a guest's limits", async ({ app }) => {
  const f = await seedFixture();
  const token = await tokenForHuman(f.follower.email);
  const query = `ids=${f.thread.id},${f.room.id}`;

  const before = await readInbox(app.baseUrl, token, f.server.id, query);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.items.map(inboxItemRowId), [f.thread.id], "control: a member sees the followed thread, not the room it is not in");

  // The follower becomes a guest of #ids-control, its one channel (#wg-rbac:#15).
  await seedBoundGuest({ serverId: f.server.id, userId: f.follower.id, channelId: f.control.id });
  const after = await readInbox(app.baseUrl, token, f.server.id, query);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.items, [], "a guest does not see the thread below a channel it cannot read");
  const own = await readInbox(app.baseUrl, token, f.server.id, `ids=${f.thread.id},${f.control.id}`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.items.map(inboxItemRowId), [f.control.id], "a guest sees its own channel's row");
});

test("GET /channels/inbox?ids= rejects malformed lists and combinations", async ({ app }) => {
  const f = await seedFixture();
  const token = await tokenForHuman(f.owner.email);
  const tooMany = Array.from({ length: 51 }, () => randomUUID()).join(",");
  for (const query of [
    "ids=not-a-uuid",
    `ids=${f.room.id},nope`,
    "ids=",
    `ids=${tooMany}`,
    `ids=${f.room.id}&ids=${f.thread.id}`,
    `ids=${f.room.id}&channelId=${f.room.id}`,
    `ids=${f.room.id}&q=room`,
    `ids=${f.room.id}&scope=pinned`,
    `ids=${f.room.id}&offset=1`,
    `ids=${f.room.id}&filter=unread`,
  ]) {
    const { status, body } = await readInbox(app.baseUrl, token, f.server.id, query);
    assert.equal(status, 400, query);
    assert.match(body.error ?? "", /ids/, query);
  }
  // 50 distinct ids (duplicates collapse) are accepted.
  const fifty = [...Array.from({ length: 49 }, () => randomUUID()), f.room.id, f.room.id].join(",");
  const ok = await readInbox(app.baseUrl, token, f.server.id, `ids=${fifty}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.items.map(inboxItemRowId), [f.room.id]);
});
