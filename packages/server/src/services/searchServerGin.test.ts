import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { executeSearchSql as executeSearchSqlFromDb } from "../db/index";
import { channels, messageServerTimeline, messages } from "../db/schema";
import { createSeed } from "../test/integration/seed";
import { acceptJointChannelInvite, addHuman, createJointChannel, getOrCreateThreadForChannel } from "./channelService";
import { createMessage } from "./messageService";
import {
  __resetSearchServiceDepsForTests,
  __setSearchServiceDepsForTests,
  MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT,
  searchMessagesForUser,
} from "./searchService";
import type { MessageSearchSort, MessageSearchWalkCursor } from "./searchService";

// #raft-architecture:#29: the text match reads the searched server's
// message_server_timeline rows (0658 search_vector) instead of every server's
// messages. A viewer gets the matching messages of what they can see, joint
// conversations included, and a timeline copy that disagrees with its message
// must never show the message.
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
  return { host, peer, hostOwner, hostMember, peerMember, local, elsewhere, jointLocalId: made.channel.id, canonicalId: made.jointChannel.canonicalChannelId };
}

async function search(params: { userId: string; serverId: string; query: string; sort: MessageSearchSort }) {
  const page = await searchMessagesForUser({ ...params, historyCutoff: undefined, limit: 20 });
  return page.results.map((row) => row.id).sort();
}

test("server GIN text match: joint conversations included, other servers excluded", async ({ db }) => {
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
    const server = await search(params);
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
  // A timeline row without a vector: dropped (the 0658 verify found none before the switch).
  await db.update(messageServerTimeline).set({ searchVector: null }).where(eq(messageServerTimeline.messageId, unfilled.id));

  for (const sort of ["relevance", "recent"] as const) {
    const params = { userId: f.hostMember.id, serverId: f.host.id, query: "ghostword", sort };
    assert.deepEqual(await search(params), [], `${sort}: the server match reads the timeline, and re-checks the message`);
  }

  // An edit through the trigger keeps the copy current.
  await db.update(messages).set({ content: "ghostword again", searchText: "ghostword again" }).where(eq(messages.id, edited.id));
  assert.deepEqual(await search({ userId: f.hostMember.id, serverId: f.host.id, query: "ghostword", sort: "recent" }), [edited.id]);
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
    __setSearchServiceDepsForTests({ relaxedTextMatchCap });
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

// search_joint_conversation_walk_v0: the recent sort's server timeline walk
// also walks the visible joint conversations (message_server_timeline
// .conversation_id, 0764) under its own row budget, merged newest first.
// The text-match estimate is pinned above the collect-first limit so every
// search here takes the walk.
function walkDeps(options: { jointWalk: boolean; budget?: number }) {
  const dialect = new PgDialect();
  const executed: string[] = [];
  /** The ids each candidate statement returned, before the joint projection. */
  const statementRowIds: string[][] = [];
  __setSearchServiceDepsForTests({
    isJointConversationWalkEnabled: async () => options.jointWalk,
    ...(options.budget ? { walkTimelineRowBudget: options.budget } : {}),
    executeSearchSql: (async (statement: SQL, execOptions?: { signal?: AbortSignal }) => {
      const rendered = dialect.sqlToQuery(statement).sql.replace(/\s+/g, " ").trim();
      if (rendered.startsWith("EXPLAIN (FORMAT JSON)")) {
        return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Bitmap Heap Scan", "Plan Rows": MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT + 1 } }] }] };
      }
      executed.push(rendered);
      const result = await executeSearchSqlFromDb(statement, execOptions);
      if (rendered.includes("search_candidates AS")) statementRowIds.push((result.rows as Array<{ id: string }>).map((row) => row.id));
      return result;
    }) as typeof executeSearchSqlFromDb,
  });
  return { executed, statementRowIds };
}

const WALK_BASE = Date.parse("2030-01-01T00:00:00.000Z");

/** A message at WALK_BASE minus `minutesBefore` (after every fixture message, in a known order). */
async function postAt(channelId: string, senderId: string, content: string, minutesBefore: number) {
  const message = await createMessage(channelId, "user", senderId, content);
  const createdAt = new Date(WALK_BASE - minutesBefore * 60_000);
  // Through the update trigger, which re-derives the timeline row.
  await (await import("../db")).getDb().update(messages).set({ createdAt }).where(eq(messages.id, message.id));
  return { ...message, createdAt };
}

async function recentPage(f: Awaited<ReturnType<typeof seedHostAndJoint>>, query: string, limit: number, cursor?: MessageSearchWalkCursor) {
  return searchMessagesForUser({
    userId: f.hostMember.id,
    serverId: f.host.id,
    query,
    sort: "recent",
    historyCutoff: undefined,
    limit,
    ...(cursor ? { cursor } : {}),
  });
}

test("joint conversation walk: host and joint messages merged newest first; off, the walk reads this server only", async ({ db }) => {
  void db; // starts the test database
  const f = await seedHostAndJoint();
  const h1 = await postAt(f.local.id, f.hostMember.id, "jointwalk host one", 1);
  const j1 = await postAt(f.canonicalId, f.peerMember.id, "jointwalk joint one", 2);
  const h2 = await postAt(f.local.id, f.hostMember.id, "jointwalk host two", 3);
  const j2 = await postAt(f.canonicalId, f.peerMember.id, "jointwalk joint two", 4);
  try {
    const on = walkDeps({ jointWalk: true });
    const page = await recentPage(f, "jointwalk", 20);
    assert.deepEqual(page.results.map((row) => row.id), [h1.id, j1.id, h2.id, j2.id]);
    assert.equal(page.results[1]!.channelId, f.jointLocalId, "the joint hit is projected to the local channel");
    assert.ok(on.executed.some((rendered) => /\bWHERE t\.conversation_id = ANY\(\$\d+::uuid\[\]\)/.test(rendered)), "the joint lane");
    assert.ok(on.executed.some((rendered) => /\bWHERE t\.conversation_id = \$\d+::uuid\b.*\bOFFSET \$\d+ LIMIT 2\b/.test(rendered)), "the joint lane's frontier");
    __resetSearchServiceDepsForTests();

    const off = walkDeps({ jointWalk: false });
    const today = await recentPage(f, "jointwalk", 20);
    assert.deepEqual(today.results.map((row) => row.id), [h1.id, h2.id], "flag off: this server's timeline only");
    assert.ok(off.executed.some((rendered) => /\bFROM message_server_timeline t JOIN messages m ON m\.id = t\.message_id\b/.test(rendered)), "still the timeline walk");
    assert.ok(off.executed.every((rendered) => !/\bt\.conversation_id\b/.test(rendered)), "no joint lane, no joint frontier");
  } finally {
    __resetSearchServiceDepsForTests();
  }
});

test("joint conversation walk: visibility stays per channel inside a visible joint conversation", async ({ db }) => {
  const f = await seedHostAndJoint();
  const root = await postAt(f.canonicalId, f.peerMember.id, "jointvis root", 1);
  const live = await getOrCreateThreadForChannel(f.jointLocalId, root.id, f.hostMember.id, "user");
  const inLive = await postAt(live.canonicalThreadChannelId, f.peerMember.id, "jointvis live thread reply", 2);
  const gone = await postAt(f.canonicalId, f.peerMember.id, "parent of a deleted thread", 3);
  const deleted = await getOrCreateThreadForChannel(f.jointLocalId, gone.id, f.hostMember.id, "user");
  const inDeleted = await postAt(deleted.canonicalThreadChannelId, f.peerMember.id, "jointvis deleted thread reply", 4);
  await db.update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, deleted.canonicalThreadChannelId));
  // Both threads' rows carry the conversation: only visibility can drop one.
  const [row] = await db.select({ c: messageServerTimeline.conversationId }).from(messageServerTimeline).where(eq(messageServerTimeline.messageId, inDeleted.id));
  assert.equal(row?.c, f.canonicalId);
  try {
    const { statementRowIds } = walkDeps({ jointWalk: true });
    const page = await recentPage(f, "jointvis", 20);
    assert.deepEqual(page.results.map((result) => result.id), [root.id, inLive.id]);
    assert.ok(statementRowIds.length > 0 && statementRowIds.every((ids) => !ids.includes(inDeleted.id)), "dropped by the statement, not only by the projection");
  } finally {
    __resetSearchServiceDepsForTests();
  }
});

test("joint conversation walk: host and joint messages interleaved across pages, each exactly once", async ({ db }) => {
  void db; // starts the test database
  const f = await seedHostAndJoint();
  const h1 = await postAt(f.local.id, f.hostMember.id, "jointpage h1", 1);
  const j1 = await postAt(f.canonicalId, f.peerMember.id, "jointpage j1", 2);
  const h2 = await postAt(f.local.id, f.hostMember.id, "jointpage h2", 3);
  const j2 = await postAt(f.canonicalId, f.peerMember.id, "jointpage j2", 4);
  const h3 = await postAt(f.local.id, f.hostMember.id, "jointpage h3", 5);
  try {
    walkDeps({ jointWalk: true });
    const first = await recentPage(f, "jointpage", 2);
    assert.deepEqual(first.results.map((row) => row.id), [h1.id, j1.id]);
    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    const second = await recentPage(f, "jointpage", 2, first.nextCursor);
    assert.deepEqual(second.results.map((row) => row.id), [h2.id, j2.id]);
    assert.equal(second.hasMore, true);
    const third = await recentPage(f, "jointpage", 2, second.nextCursor);
    assert.deepEqual(third.results.map((row) => row.id), [h3.id]);
    assert.equal(third.hasMore, false);
    assert.equal(third.incomplete, undefined);
    assert.equal(third.nextCursor, undefined);
  } finally {
    __resetSearchServiceDepsForTests();
  }
});

test("joint conversation walk: each lane has its own budget; the window ends at the later lane's budget row", async ({ db }) => {
  void db; // starts the test database
  const f = await seedHostAndJoint();
  // Newest first: J1 H1 J2 H2 J3 H3 J4 H4 (minutes before WALK_BASE).
  const j1 = await postAt(f.canonicalId, f.peerMember.id, "jointbudget j1", 1);
  await postAt(f.local.id, f.hostMember.id, "filler h1", 2);
  const j2 = await postAt(f.canonicalId, f.peerMember.id, "filler j2", 3);
  await postAt(f.local.id, f.hostMember.id, "filler h2", 4);
  await postAt(f.canonicalId, f.peerMember.id, "filler j3", 5);
  const h3 = await postAt(f.local.id, f.hostMember.id, "jointbudget h3", 6);
  const j4 = await postAt(f.canonicalId, f.peerMember.id, "jointbudget j4", 7);
  await postAt(f.local.id, f.hostMember.id, "filler h4", 8);
  try {
    walkDeps({ jointWalk: true, budget: 2 });
    // Host budget row H2, joint budget row J2: the window ends at J2, the later.
    const first = await recentPage(f, "jointbudget", 5);
    assert.deepEqual(first.results.map((row) => row.id), [j1.id]);
    assert.equal(first.incomplete, true);
    assert.equal(first.hasMore, false);
    assert.equal(first.searchedThrough, j2.createdAt.toISOString(), "the joint lane's budget row, not the host's older one");
    assert.ok(first.nextCursor);

    const seen = [...first.results.map((row) => row.id)];
    let cursor: MessageSearchWalkCursor | undefined = first.nextCursor;
    for (let pages = 0; cursor && pages < 20; pages += 1) {
      const page = await recentPage(f, "jointbudget", 5, cursor);
      seen.push(...page.results.map((row) => row.id));
      cursor = page.nextCursor;
    }
    assert.equal(cursor, undefined, "the walk reaches the end");
    assert.deepEqual(seen, [j1.id, h3.id, j4.id], "continuing finds the rest, in order, once each");
  } finally {
    __resetSearchServiceDepsForTests();
  }
});
