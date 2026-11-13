import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { messageServerTimeline, messages } from "../db/schema";
import { createSeed } from "../test/integration/seed";
import { acceptJointChannelInvite, addHuman, createJointChannel } from "./channelService";
import { createMessage } from "./messageService";
import {
  __resetSearchServiceDepsForTests,
  __setSearchServiceDepsForTests,
  searchMessagesForUser,
} from "./searchService";
import type { MessageSearchSort } from "./searchService";

// search_server_gin_v0 (#raft-architecture:#29): the text match reads the
// searched server's message_server_timeline rows (0658 search_vector) instead
// of every server's messages. With the flag on, a viewer must get exactly the
// results the corpus-wide match gives, joint conversations included, and a
// timeline copy that disagrees with its message must never show the message.
// PGlite has no btree_gin, so these run without the GIN: they pin the rows,
// not the plan.

async function seedHostAndJoint() {
  const seed = createSeed((await import("../db")).getDb());
  const hostOwner = await seed.human();
  const hostMember = await seed.human();
  const peerAdmin = await seed.human();
  const peerMember = await seed.human();
  const host = await seed.server({ owner: hostOwner, members: [hostMember] });
  const peer = await seed.server({ owner: peerAdmin, members: [peerMember] });
  const local = await seed.channel({ server: host, members: [hostOwner, hostMember] });
  const elsewhere = await seed.channel({ server: peer, members: [peerAdmin, peerMember] });
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: `gin-${host.slug}`.slice(0, 40),
    targetServerSlug: peer.slug,
    invitedPeople: [`@${peerAdmin.name}`],
    userIds: [hostMember.id],
  });
  const entry = await acceptJointChannelInvite({
    inviteId: made.invites[0]!.id,
    targetServerId: peer.id,
    acceptedByUserId: peerAdmin.id,
  });
  await addHuman(entry.id, peerMember.id);
  return { host, peer, hostOwner, hostMember, peerMember, local, elsewhere, canonicalId: made.jointChannel.canonicalChannelId };
}

async function search(params: { userId: string; serverId: string; query: string; sort: MessageSearchSort }, serverGin: boolean) {
  __setSearchServiceDepsForTests({ isServerSearchGinEnabled: async () => serverGin });
  try {
    const page = await searchMessagesForUser({ ...params, historyCutoff: undefined, limit: 20 });
    return page.results.map((row) => row.id).sort();
  } finally {
    __resetSearchServiceDepsForTests();
  }
}

test("server GIN text match: same results as the corpus-wide match, joint conversations included, other servers excluded", async ({ db }) => {
  const f = await seedHostAndJoint();
  const localHit = await createMessage(f.local.id, "user", f.hostMember.id, "ginsentinel deploy notes");
  const localMiss = await createMessage(f.local.id, "user", f.hostMember.id, "nothing to see");
  const jointHit = await createMessage(f.canonicalId, "user", f.peerMember.id, "ginsentinel from the peer");
  // Same term in a channel of the peer server the host member cannot see.
  await createMessage(f.elsewhere.id, "user", f.peerMember.id, "ginsentinel private to the peer");
  void localMiss;

  // The insert trigger copied the vector (0658).
  const [copied] = await db.select({ v: messageServerTimeline.searchVector }).from(messageServerTimeline).where(eq(messageServerTimeline.messageId, localHit.id));
  assert.ok(copied?.v?.includes("ginsentinel"), "the timeline row carries the message's search_vector");

  for (const sort of ["relevance", "recent"] as const) {
    const params = { userId: f.hostMember.id, serverId: f.host.id, query: "ginsentinel", sort };
    const corpus = await search(params, false);
    const server = await search(params, true);
    assert.deepEqual(server, corpus, `${sort}: the server match returns what the corpus-wide match does`);
    assert.deepEqual(server, [localHit.id, jointHit.id].sort(), `${sort}: the local and the joint message, nothing from the peer's own channel`);
  }
});

test("server GIN text match: a timeline copy that disagrees with its message never shows the message", async ({ db }) => {
  const f = await seedHostAndJoint();
  const edited = await createMessage(f.local.id, "user", f.hostMember.id, "ghostword before the edit");
  const unfilled = await createMessage(f.local.id, "user", f.hostMember.id, "ghostword not backfilled yet");

  // A stale copy: the timeline still says ghostword, the message no longer does.
  await db.execute(sql`ALTER TABLE messages DISABLE TRIGGER messages_server_timeline_update`);
  await db.update(messages).set({ content: "rewritten", searchText: "rewritten" }).where(eq(messages.id, edited.id));
  await db.execute(sql`ALTER TABLE messages ENABLE TRIGGER messages_server_timeline_update`);
  // A row the backfill has not reached: dropped while the flag is on (it stays off until the verify is 0).
  await db.update(messageServerTimeline).set({ searchVector: null }).where(eq(messageServerTimeline.messageId, unfilled.id));

  for (const sort of ["relevance", "recent"] as const) {
    const params = { userId: f.hostMember.id, serverId: f.host.id, query: "ghostword", sort };
    assert.deepEqual(await search(params, false), [unfilled.id], `${sort}: corpus-wide match reads the messages`);
    assert.deepEqual(await search(params, true), [], `${sort}: the server match reads the timeline, and re-checks the message`);
  }

  // An edit through the trigger keeps the copy current.
  await db.update(messages).set({ content: "ghostword again", searchText: "ghostword again" }).where(eq(messages.id, edited.id));
  assert.deepEqual(await search({ userId: f.hostMember.id, serverId: f.host.id, query: "ghostword", sort: "recent" }, true), [edited.id]);
});

test("server GIN any-term fallback: skipped over the cap, counting matches before visibility", async ({ db }) => {
  const f = await seedHostAndJoint();
  const seed = createSeed(db);
  // A channel on the same server the searching member cannot see.
  const ownerOnly = await seed.channel({ server: f.host, members: [f.hostOwner], visibility: "private" });
  const visible = await createMessage(f.local.id, "user", f.hostMember.id, "capalpha release notes");
  await createMessage(ownerOnly.id, "user", f.hostOwner.id, "capalpha hidden one");
  await createMessage(ownerOnly.id, "user", f.hostOwner.id, "capbeta hidden two");
  const run = async (relaxedTextMatchCap: number, sort: MessageSearchSort = "relevance") => {
    __setSearchServiceDepsForTests({ isServerSearchGinEnabled: async () => true, relaxedTextMatchCap });
    try {
      // No message has both words, so only the any-term fallback can match.
      return await searchMessagesForUser({ userId: f.hostMember.id, serverId: f.host.id, query: "capalpha capbeta", sort, historyCutoff: undefined, limit: 20 });
    } finally {
      __resetSearchServiceDepsForTests();
    }
  };

  const within = await run(3);
  assert.deepEqual(within.results.map((row) => row.id), [visible.id], "3 matches, cap 3: the fallback runs");
  assert.equal(within.relaxedSkipped, undefined);

  // 3 matches on the server, 1 of them visible: the cap counts all 3.
  const over = await run(2);
  assert.deepEqual(over.results, [], "over the cap the fallback is not run, though only 1 match is visible");
  assert.equal(over.relaxedSkipped, "too_broad");
  assert.equal(over.hasMore, false);

  // Recent sort is bounded by its own plans, not by this cap.
  const recent = await run(2, "recent");
  assert.deepEqual(recent.results.map((row) => row.id), [visible.id]);
  assert.equal(recent.relaxedSkipped, undefined);
});
