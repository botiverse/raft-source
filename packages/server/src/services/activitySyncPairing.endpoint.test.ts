import { createApiTest } from "../test/integration/apiTest.js";
/**
 * task #364 — endpoint-level proof that `latestActivityMessageId` and
 * `latestActivitySeq` are SAME-SOURCE on the real Activity snapshot path.
 *
 * Why this file exists (@赵梓淇's freeze, @John's contract of 7/29):
 *
 * `requireLatestActivitySeq` in activitySyncService is a SHAPE gate — it rejects
 * null / empty / "0" / non-canonical decimals. It cannot detect a row that pairs
 * message A's id with message B's seq, because both fields are individually
 * valid. The contract requires id and seq to come from the SAME selected
 * message ("不得分别拼"), and nothing enforced that end-to-end.
 *
 * So these teeth never assert "seq is non-null". They take the id the endpoint
 * returned, look that message up in the database, and require the seq to match
 * it exactly. That is the only assertion that distinguishes "both fields legal"
 * from "the pair is authoritative".
 *
 * Deliberately NOT mapper unit tests and NOT hand-built Core events — those were
 * ruled insufficient because they can be satisfied by a fixture the system never
 * produces. Everything here comes from a seeded database through the real
 * snapshot path.
 *
 * THE ORACLE MUST STAY INDEPENDENT AND LOSSLESS:
 *
 * - the "true seq" is fetched by a direct `db.select` on `messages` using the id
 *   the endpoint returned — never through a production mapper/helper, or a
 *   broken mapper would validate itself;
 * - nothing in this file may pass a seq through `Number`. The contract covers
 *   UInt64 beyond 2^53, so arithmetic on a seq would make the test its own lossy
 *   oracle. Compare canonical decimal strings only.
 *
 * THE CORRECT REVERSE CUT (@赵梓淇): replace the emitted seq with the real seq of
 * ANOTHER known message in the SAME scope, taken from the fixture. Do NOT use
 * `String(Number(seq) - 1)`: that narrows through Number, and "one less" does not
 * establish that the value belongs to a real sibling message. Injecting a real
 * sibling's seq proves all three at once — both values individually valid, the
 * mis-paired seq genuinely exists in that scope, and no width loss anywhere.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  threadFollows,
  users,
  userChannelReadCursors,
} from "../db/schema.js";
import { getActivitySnapshot } from "./activitySyncService.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type AnyRow = Record<string, unknown>;

/** The seq the database actually holds for a message id. */
async function seqOfMessage(messageId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, messageId));
  return row?.seq == null ? null : String(row.seq);
}

/**
 * The assertion this whole file is for.
 *
 * NOT "seq is present" — that is already guaranteed by the shape gate and
 * proves nothing about pairing.
 */
async function assertSameSourcePair(row: AnyRow, idField: string, label: string): Promise<void> {
  const messageId = row[idField];
  const seq = row.latestActivitySeq;
  assert.equal(typeof messageId, "string", `${label}: ${idField} must be present`);
  assert.equal(typeof seq, "string", `${label}: latestActivitySeq must be present`);

  const trueSeq = await seqOfMessage(messageId as string);
  assert.ok(trueSeq !== null, `${label}: ${idField} must resolve to a real message`);
  assert.equal(
    seq,
    trueSeq,
    `${label}: latestActivitySeq must be the seq OF ${idField} — a valid seq belonging to a different message is exactly the defect this pins`,
  );
}

async function seedServerWithChannel() {
  const db = getDb();
  const passwordHash = await argon2.hash("password123");
  const [owner, sender] = await db.insert(users).values([
    {
      email: `pair-owner-${randomUUID()}@test.invalid`,
      name: `PairOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash,
      emailVerified: true,
    },
    {
      email: `pair-sender-${randomUUID()}@test.invalid`,
      name: `PairSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      passwordHash,
      emailVerified: true,
    },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "Pairing",
    slug: `pairing-${randomUUID()}`,
    ownerId: owner.id,
    plan: "founder",
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "pairing",
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: channel.id,
    lastReadSeq: 0,
    readStateVersion: 0,
  });
  return { owner, sender, server, channel };
}

test("channel row: latestActivitySeq is the seq of the returned lastMessageId, not merely a valid seq", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const fx = await seedServerWithChannel();

    // Several messages so that a mis-paired seq would still be "valid": if the
    // implementation ever took max(seq) of the scope instead of the seq of the
    // selected message, only a same-source assertion can tell the difference.
    await db.insert(messages).values([
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "one", seq: 1 },
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "two", seq: 2 },
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "three", seq: 3 },
    ]);

    const snapshot = await getActivitySnapshot({
      serverId: fx.server.id,
      principalId: fx.owner.id,
      filter: "all",
      requestId: `pairing-channel-${randomUUID()}`,
      humanActivityMuteEnabled: false,
    }) as unknown as { window?: { rows?: AnyRow[] }; rows?: AnyRow[] };

    const rows = snapshot.window?.rows ?? snapshot.rows ?? [];
    assert.ok(rows.length > 0, "the snapshot must contain the seeded channel row");

    for (const row of rows) {
      const idField = row.type === "thread" ? "latestActivityMessageId" : "lastMessageId";
      await assertSameSourcePair(row, idField, `row type=${String(row.type)}`);
    }
  } finally {
    await app.close?.();
  }
});

test("zero-reply thread: the pair falls back to the PARENT message, id and seq together", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const fx = await seedServerWithChannel();

    // Noise in the parent channel so the parent's own seq is NOT the newest
    // thing around — a fallback that reached for "latest in channel" instead of
    // "the parent message" would still produce a valid-looking seq.
    await db.insert(messages).values([
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "noise 1", seq: 1 },
    ]);
    const [parent] = await db.insert(messages).values({
      channelId: fx.channel.id,
      senderType: "user",
      senderId: fx.sender.id,
      content: "thread parent",
      seq: 2,
    }).returning();
    await db.insert(messages).values([
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "noise 2", seq: 3 },
    ]);

    const [thread] = await db.insert(channels).values({
      serverId: fx.server.id,
      name: "pairing-thread-empty",
      type: "thread",
      parentMessageId: parent.id,
    }).returning();
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: fx.owner.id,
      parentMessageId: parent.id,
      reason: "manual",
    });
    // Deliberately NO replies inside the thread channel.

    const snapshot = await getActivitySnapshot({
      serverId: fx.server.id,
      principalId: fx.owner.id,
      filter: "all",
      requestId: `pairing-thread-zero-${randomUUID()}`,
      humanActivityMuteEnabled: false,
    }) as unknown as { window?: { rows?: AnyRow[] }; rows?: AnyRow[] };

    const rows = snapshot.window?.rows ?? snapshot.rows ?? [];
    const threadRows = rows.filter((r) => r.type === "thread");
    assert.ok(threadRows.length > 0, "the zero-reply thread must appear in the snapshot at all");

    for (const row of threadRows) {
      await assertSameSourcePair(row, "latestActivityMessageId", "zero-reply thread");
      // And specifically: the contract says a reply-less thread reports the
      // PARENT. Anything else means the fallback picked a different message.
      assert.equal(
        row.latestActivityMessageId,
        parent.id,
        "a thread with no replies must report the parent message as its latest activity",
      );
    }
  } finally {
    await app.close?.();
  }
});

test("replied thread: the pair is the LATEST REPLY, id and seq together", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const fx = await seedServerWithChannel();

    // Parent lives in the parent channel; replies live in the thread channel.
    // Noise on BOTH sides in the PARENT channel, with a parent-channel message
    // newer than every reply: a pair that reached for "latest in the parent
    // channel" instead of "latest reply in this thread" would still emit a
    // perfectly valid id and seq.
    const [parent] = await db.insert(messages).values({
      channelId: fx.channel.id,
      senderType: "user",
      senderId: fx.sender.id,
      content: "thread parent",
      seq: 1,
    }).returning();

    const [thread] = await db.insert(channels).values({
      serverId: fx.server.id,
      name: "pairing-thread-replied",
      type: "thread",
      parentMessageId: parent.id,
    }).returning();
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: fx.owner.id,
      parentMessageId: parent.id,
      reason: "manual",
    });

    // Replies, ascending. The LAST one is the contract's answer.
    await db.insert(messages).values([
      { channelId: thread.id, senderType: "user", senderId: fx.sender.id, content: "reply one", seq: 2 },
    ]);
    const [latestReply] = await db.insert(messages).values({
      channelId: thread.id,
      senderType: "user",
      senderId: fx.sender.id,
      content: "reply two",
      seq: 3,
    }).returning();

    // Parent-channel traffic NEWER than the newest reply.
    await db.insert(messages).values([
      { channelId: fx.channel.id, senderType: "user", senderId: fx.sender.id, content: "parent-channel noise", seq: 4 },
    ]);

    const snapshot = await getActivitySnapshot({
      serverId: fx.server.id,
      principalId: fx.owner.id,
      filter: "all",
      requestId: `pairing-thread-replied-${randomUUID()}`,
      humanActivityMuteEnabled: false,
    }) as unknown as { window?: { rows?: AnyRow[] }; rows?: AnyRow[] };

    const rows = snapshot.window?.rows ?? snapshot.rows ?? [];
    const threadRow = rows.find((r) => r.type === "thread" && r.threadChannelId === thread.id);
    assert.ok(threadRow, "the replied thread must appear in the snapshot at all");

    await assertSameSourcePair(threadRow, "latestActivityMessageId", "replied thread");
    assert.equal(
      threadRow.latestActivityMessageId,
      latestReply.id,
      "a thread with replies must report its LATEST REPLY — not the parent, and not the parent channel's newer traffic",
    );
  } finally {
    await app.close?.();
  }
});

/**
 * Case 5 — JOINT.
 *
 * REACHABILITY WAS PROVEN BEFORE THIS TOOTH WAS WRITTEN (@赵梓淇's frozen order).
 * Measured inside the real `getActivitySnapshot` call, backend `pg_legacy`
 * (route=all, fallback_reason=pglite_dev):
 *
 *   - the emitted row's `channelId` is the LOCAL projection, which holds zero
 *     messages of its own;
 *   - the emitted `lastMessageId` resolves to a message that lives in the
 *     CANONICAL storage channel.
 *
 * The only stage that can produce that combination is
 * `COALESCE(joint_storage.canonical_channel_id, c.id) AS storage_channel_id`
 * in the pg_legacy `eligible_chats` CTE (channelService ~8798), which the
 * emitter's latest-message lateral then reads via `p."storageChannelId"`.
 * Flipping that one expression to `c.id` takes this fixture's row count from
 * 1 to 0 — the cut bites, so the assertions below are actually guarded.
 *
 * WHY THE FIXTURE HAS THE SHAPE IT DOES: a mis-paired row here must still look
 * completely legal, otherwise the shape gate would already catch it. So the
 * scope contains three different real (id, seq) pairs that an implementation
 * could wrongly reach for —
 *   1. the canonical storage channel's own latest message (the correct answer),
 *   2. a SIBLING joint projection's newer message ("picked the wrong member"),
 *   3. an out-of-scope channel's newer message ("picked the scope-wide latest").
 * Every one of those is a real message with a real seq, so only a same-source
 * assertion can distinguish the authoritative pair from a plausible one.
 */
test("joint channel: the pair comes from ONE message in the canonical storage channel, not a sibling projection or a newer out-of-scope message", async () => {
  const app = await openTestApp("pglite://", 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const passwordHash = await argon2.hash("password123");
    const [owner, sender] = await db.insert(users).values([
      {
        email: `joint-owner-${randomUUID()}@test.invalid`,
        name: `JointOwner${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash,
        emailVerified: true,
      },
      {
        email: `joint-sender-${randomUUID()}@test.invalid`,
        name: `JointSender${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash,
        emailVerified: true,
      },
    ]).returning();

    const [homeServer] = await db.insert(servers).values({
      name: "JointHome",
      slug: `joint-home-${randomUUID()}`,
      ownerId: owner.id,
      plan: "founder",
    }).returning();
    const [peerServer] = await db.insert(servers).values({
      name: "JointPeer",
      slug: `joint-peer-${randomUUID()}`,
      ownerId: owner.id,
      plan: "founder",
    }).returning();
    const [storageServer] = await db.insert(servers).values({
      name: "JointStorage",
      slug: `joint-storage-${randomUUID()}`,
      ownerId: owner.id,
      plan: "founder",
    }).returning();
    await db.insert(serverMembers).values({ serverId: homeServer.id, userId: owner.id, role: "owner" });

    // The principal's local projection of the joint channel.
    const [localChannel] = await db.insert(channels).values({
      serverId: homeServer.id,
      name: "joint-local",
      type: "joint",
    }).returning();
    // A SIBLING projection of the same joint channel on the peer server.
    const [siblingChannel] = await db.insert(channels).values({
      serverId: peerServer.id,
      name: "joint-sibling",
      type: "joint",
    }).returning();
    // Where the joint conversation is actually stored.
    const [canonicalChannel] = await db.insert(channels).values({
      serverId: storageServer.id,
      name: "joint-canonical",
      type: "joint",
    }).returning();

    await db.insert(channelHumans).values({ channelId: localChannel.id, userId: owner.id });
    await db.insert(userChannelReadCursors).values({
      userId: owner.id,
      channelId: localChannel.id,
      lastReadSeq: 0,
      readStateVersion: 0,
    });

    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonicalChannel.id,
      createdByServerId: homeServer.id,
      createdByUserId: owner.id,
      status: "active",
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: joint.id,
        serverId: homeServer.id,
        localChannelId: localChannel.id,
        role: "host",
        status: "active",
      },
      {
        jointChannelId: joint.id,
        serverId: peerServer.id,
        localChannelId: siblingChannel.id,
        role: "participant",
        status: "active",
      },
    ]);

    // (1) The authoritative conversation, in canonical storage.
    await db.insert(messages).values({
      channelId: canonicalChannel.id, senderType: "user", senderId: sender.id, content: "canonical older", seq: 1,
    });
    const [canonicalLatest] = await db.insert(messages).values({
      channelId: canonicalChannel.id, senderType: "user", senderId: sender.id, content: "canonical latest", seq: 2,
    }).returning();

    // (2) A sibling projection carrying a NEWER real message. Reaching for this
    //     would yield a valid id and a valid seq that are simply not ours.
    const [siblingNewer] = await db.insert(messages).values({
      channelId: siblingChannel.id, senderType: "user", senderId: sender.id, content: "sibling newer", seq: 3,
    }).returning();

    // (3) An out-of-scope channel with the newest message of all.
    const [decoyChannel] = await db.insert(channels).values({
      serverId: homeServer.id,
      name: "joint-decoy-out-of-scope",
      type: "channel",
    }).returning();
    const [decoyNewest] = await db.insert(messages).values({
      channelId: decoyChannel.id, senderType: "user", senderId: sender.id, content: "decoy newest", seq: 4,
    }).returning();

    // The three rival pairs must be genuinely distinct, or this fixture cannot
    // tell a correct implementation from a lucky one.
    assert.equal(
      new Set([canonicalLatest.id, siblingNewer.id, decoyNewest.id]).size,
      3,
      "fixture sanity: the three candidate messages must be distinct",
    );

    const snapshot = await getActivitySnapshot({
      serverId: homeServer.id,
      principalId: owner.id,
      filter: "all",
      requestId: `pairing-joint-${randomUUID()}`,
      humanActivityMuteEnabled: false,
    }) as unknown as { window?: { rows?: AnyRow[] }; rows?: AnyRow[] };

    const rows = snapshot.window?.rows ?? snapshot.rows ?? [];
    const jointRow = rows.find((r) => r.channelId === localChannel.id);
    assert.ok(
      jointRow,
      "the joint channel must appear in the snapshot at all — if this fails the joint storage stage was not reached and nothing below is being tested",
    );

    // The invariant this whole file exists for.
    await assertSameSourcePair(jointRow, "lastMessageId", "joint channel");

    // And specifically: the winner is canonical storage's latest, not either rival.
    assert.equal(
      jointRow.lastMessageId,
      canonicalLatest.id,
      "a joint row must report the canonical storage channel's latest message — not a sibling projection's newer message, and not a newer out-of-scope one",
    );
  } finally {
    await app.close?.();
  }
});
