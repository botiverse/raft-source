import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
// Teeth for the /channels/inbox exit of the #632 SSOT fix (task #632).
//
// Layer 1 (unit): mapInboxPolicyRowsToItems builds readState — the frozen
// InboxScopeReadFrontier union under the SAME field name as the other exits —
// with structural presence (readCursorPresent, never value-guessed), raw value
// pass-through into the single total constructor (no asNumber/asString
// padding), batch isolation at the exit level (one corrupt row leaves every
// other scope byte-intact, exactly one alarm, throwing/async sinks harmless),
// and the frontier-source rule (authority pair on PG-enriched rows; RW pair
// with the zero-reply parent fallback excluded).
//
// Layer 2 (real DB): getInboxItems against pglite (serving-rows backend) —
// absent without a cursor row, present-at-zero, the union frontier is the
// scope's own latest message (NULL for a zero-reply thread while the display
// pair keeps its parent fallback), and the same scope through /channels/unread
// yields the identical union (cross-exit consistency).
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  featureFlags,
  messages,
  servers,
  threadFollows,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import { getInboxItems, getUnreadSummary } from "./channelService.js";
import { mapInboxPolicyRowsToItems } from "./inboxPolicyModel.js";
import { recordInboxNotificationFacts } from "./inboxNotificationService.js";
import { HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY } from "./featureFlagService.js";


const SCOPE_A = "11111111-1111-4111-8111-111111111111";
const SCOPE_B = "22222222-2222-4222-8222-222222222222";
const SCOPE_C = "33333333-3333-4333-8333-333333333333";
const PARENT_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

function rawChannel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "channel",
    channelId: SCOPE_A,
    channelName: "general",
    channelType: "channel",
    lastMessageId: "msg-100",
    latestActivitySeq: "100",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-30 00:00:00.000000+00",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-1",
    lastMessageSenderName: "alice",
    unreadCount: 1,
    hasMention: false,
    ...overrides,
  };
}

function rawThread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "thread",
    threadChannelId: SCOPE_B,
    parentMessageId: PARENT_MESSAGE_ID,
    parentChannelId: SCOPE_A,
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent preview",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply preview",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "msg-200",
    latestActivitySeq: "200",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastActivityAt: "2026-07-30 00:00:00.000000+00",
    lastReplyAt: "2026-07-30 00:00:00.000000+00",
    replyCount: 1,
    unreadCount: 1,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
}

test("unit: every item carries readState; no cursor row -> absent (presence is structural, not value-guessed)", () => {
  const items = mapInboxPolicyRowsToItems([
    rawChannel(),
    rawThread(),
    // A present=FALSE marker with value columns set must STILL be absent:
    // presence is the structural JOIN fact, never synthesized from values.
    rawChannel({ channelId: SCOPE_C, readCursorPresent: false, readStateVersion: 3, maxReadSeq: "9" }),
  ]);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.equal(Object.hasOwn(item, "readState"), true, "both kinds expose readState (same field name as the other exits)");
    assert.deepEqual(item.readState, { kind: "absent" });
  }
});

test("unit: cursor at version 0 / seq \"0\" is present — presence is not value-derived", () => {
  const [item] = mapInboxPolicyRowsToItems([
    rawChannel({
      readCursorPresent: true,
      readStateVersion: 0,
      maxReadSeq: "0",
      latestActivityMessageId: "msg-100",
      latestActivitySeq: "100",
    }),
  ]);
  assert.deepEqual(item!.readState, {
    kind: "present",
    readStateVersion: 0,
    maxReadSeq: "0",
    latestActivity: { messageId: "msg-100", seq: "100" },
  });
});

test("unit: half-missing frontier fails closed to null (present, NOT corrupt, no alarm)", () => {
  let calls = 0;
  const [item] = mapInboxPolicyRowsToItems(
    [rawChannel({
      readCursorPresent: true,
      readStateVersion: 2,
      maxReadSeq: "5",
      latestActivityMessageId: "msg-100",
      latestActivitySeq: null,
    })],
    () => { calls += 1; },
  );
  assert.deepEqual(item!.readState, {
    kind: "present",
    readStateVersion: 2,
    maxReadSeq: "5",
    latestActivity: null,
  });
  assert.equal(calls, 0, "a null frontier pair is not corruption");
});

test("unit: corrupt present rows alarm — raw pass-through, never padded into a clean value", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    // Non-canonical decimal seq.
    [{ readStateVersion: 1, maxReadSeq: "12x" }, "field=maxReadSeq reason=not_canonical_decimal"],
    // Wrong TYPE (number, not string): asString would have produced "" and
    // mislabeled the reason; the raw value must reach the constructor.
    [{ readStateVersion: 1, maxReadSeq: 42 }, "field=maxReadSeq reason=not_a_string"],
    // Negative version.
    [{ readStateVersion: -1, maxReadSeq: "5" }, "field=readStateVersion reason=negative"],
    // NULL version on a present row: asNumber would have padded this to 0 and
    // silently produced present-at-0 — the exact failure the raw pass-through
    // forbids.
    [{ readStateVersion: null, maxReadSeq: "5" }, "field=readStateVersion reason=not_an_integer"],
  ];
  for (const [values, expectedLine] of cases) {
    const lines: string[] = [];
    const [item] = mapInboxPolicyRowsToItems(
      [rawChannel({ readCursorPresent: true, latestActivityMessageId: null, latestActivitySeq: null, ...values })],
      (scopeId, corruption) => {
        lines.push(`inbox_cursor_corrupt scope=${scopeId} field=${corruption.field} reason=${corruption.reason}`);
      },
    );
    assert.deepEqual(item!.readState, { kind: "corrupt" }, expectedLine);
    assert.deepEqual(lines, [`inbox_cursor_corrupt scope=${SCOPE_A} ${expectedLine}`]);
  }
});

test("unit: batch isolation — one corrupt scope leaves the rest byte-exact, exactly one alarm, throwing sink harmless", () => {
  const lines: string[] = [];
  const items = mapInboxPolicyRowsToItems(
    [
      rawChannel({ readCursorPresent: true, readStateVersion: 1, maxReadSeq: "5", latestActivityMessageId: "msg-100", latestActivitySeq: "100" }),
      rawChannel({ channelId: SCOPE_B, readCursorPresent: true, readStateVersion: 2, maxReadSeq: "BROKEN", latestActivityMessageId: null, latestActivitySeq: null }),
      rawThread({ readCursorPresent: true, readStateVersion: 0, maxReadSeq: "0", latestActivityMessageId: "msg-200", latestActivitySeq: "200" }),
    ],
    (scopeId, corruption) => {
      lines.push(`scope=${scopeId} field=${corruption.field} reason=${corruption.reason}`);
      throw new Error("sink exploded");
    },
  );
  assert.deepEqual(items[0]!.readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "5",
    latestActivity: { messageId: "msg-100", seq: "100" },
  });
  assert.deepEqual(items[1]!.readState, { kind: "corrupt" });
  assert.deepEqual(items[2]!.readState, {
    kind: "present",
    readStateVersion: 0,
    maxReadSeq: "0",
    latestActivity: { messageId: "msg-200", seq: "200" },
  });
  assert.equal(lines.length, 1, "exactly one alarm for the batch");
  assert.equal(lines[0], `scope=${SCOPE_B} field=maxReadSeq reason=not_canonical_decimal`);
});

test("unit: an async-rejecting sink still returns corrupt synchronously and never rejects unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const [item] = mapInboxPolicyRowsToItems(
      [rawChannel({ readCursorPresent: true, readStateVersion: 1, maxReadSeq: "BROKEN" })],
      () => Promise.reject(new Error("async sink exploded")),
    );
    assert.deepEqual(item!.readState, { kind: "corrupt" });
    // Give a rejected-thenable several macrotasks to surface if the
    // constructor failed to swallow it.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, [], "the constructor swallows async sink rejections by contract");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("unit: frontier source — authority pair wins on PG-enriched rows (even when NULL)", () => {
  // PG paths pass frontierSource:"authority" explicitly; NULL authority keys
  // mean "the scope has no messages" (a zero-reply thread) and MUST NOT fall
  // back to the display pair (whose parent fallback would compare across seq
  // domains).
  const [item] = mapInboxPolicyRowsToItems(
    [
      rawThread({
        readCursorPresent: true,
        readStateVersion: 1,
        maxReadSeq: "0",
        // Display pair: parent fallback (paired COALESCE) — for the serializer.
        latestActivityMessageId: PARENT_MESSAGE_ID,
        latestActivitySeq: "50",
        // Authority pair: the thread scope itself has no messages.
        readStateActivityMessageId: null,
        readStateActivitySeq: null,
      }),
    ],
    undefined,
    "authority",
  );
  assert.deepEqual(item!.readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "0",
    latestActivity: null,
  });
  // The display pair is untouched.
  assert.equal(item!.kind === "thread" ? item.latestActivityMessageId : null, PARENT_MESSAGE_ID);
  assert.equal(item!.kind === "thread" ? item.latestActivitySeq : null, "50");
});

test("unit: frontier source — authority mode fails closed on unstamped rows (no silent servingPair fallback)", () => {
  // If a PG row ever reaches the mapper WITHOUT the authority stamp (e.g. the
  // enrichment's empty-scope early return), "authority" mode must read the
  // frontier as NULL — never silently fall back to the serving pair's
  // semantics. Presence/cursor values are unaffected.
  const [item] = mapInboxPolicyRowsToItems(
    [
      rawThread({
        readCursorPresent: true,
        readStateVersion: 1,
        maxReadSeq: "0",
        latestActivityMessageId: "msg-200",
        latestActivitySeq: "200",
        // NO readStateActivity* keys.
      }),
    ],
    undefined,
    "authority",
  );
  assert.deepEqual(item!.readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "0",
    latestActivity: null,
  });
});

test("unit: frontier source — RW rows exclude the zero-reply parent fallback", () => {
  // RW serving COALESCEs the parent (id, seq) into the activity pair for
  // display; a reply id never equals the parent id, so equality marks the
  // fallback — the union frontier must read as "no scope messages" (null),
  // matching the authority semantics the PG paths produce.
  const [zeroReply] = mapInboxPolicyRowsToItems(
    [
      rawThread({
        readCursorPresent: true,
        readStateVersion: 1,
        maxReadSeq: "0",
        latestActivityMessageId: PARENT_MESSAGE_ID,
        latestActivitySeq: "50",
      }),
    ],
    undefined,
    "servingPair",
  );
  assert.deepEqual(zeroReply!.readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "0",
    latestActivity: null,
  });

  const [withReply] = mapInboxPolicyRowsToItems(
    [
      rawThread({
        readCursorPresent: true,
        readStateVersion: 1,
        maxReadSeq: "0",
        latestActivityMessageId: "msg-200",
        latestActivitySeq: "200",
      }),
    ],
    undefined,
    "servingPair",
  );
  assert.deepEqual(withReply!.readState, {
    kind: "present",
    readStateVersion: 1,
    maxReadSeq: "0",
    latestActivity: { messageId: "msg-200", seq: "200" },
  });
});

async function initReadStateDatabase() {
  await openTestDatabase("pglite://");
  await getDb()
    .update(featureFlags)
    .set({ defaultEnabled: true })
    .where(eq(featureFlags.key, HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY));
}

test("real DB: inbox items carry the authority union — absent / present-at-zero / zero-reply thread null frontier; cross-exit identical to /channels/unread", async () => {
  await initReadStateDatabase();
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "inbox-readstate-owner@test.com",
      name: "InboxReadStateOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [other] = await db.insert(users).values({
      email: "inbox-readstate-other@test.com",
      name: "InboxReadStateOther",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "InboxReadState",
      slug: "inbox-readstate",
      ownerId: owner.id,
    }).returning();
    const mkChannel = async (name: string) => {
      const [ch] = await db.insert(channels).values({ serverId: server.id, name, type: "channel" }).returning();
      await db.insert(channelHumans).values([
        { channelId: ch.id, userId: owner.id },
        { channelId: ch.id, userId: other.id },
      ]);
      return ch;
    };
    const noCursor = await mkChannel("no-cursor");
    const zeroCursor = await mkChannel("zero-cursor");

    const [noCursorMessage] = await db.insert(messages).values({
      channelId: noCursor.id, senderType: "user", senderId: other.id, content: "unread",
    }).returning();
    const [zeroCursorMessage] = await db.insert(messages).values({
      channelId: zeroCursor.id, senderType: "user", senderId: other.id, content: "unread",
    }).returning();
    // Zero-reply followed thread: the parent lives in noCursor's sibling
    // channel, the thread scope itself has no messages at all.
    const [parentMessage] = await db.insert(messages).values({
      channelId: zeroCursor.id, senderType: "user", senderId: other.id, content: "thread parent",
    }).returning();
    const [thread] = await db.insert(channels).values({
      serverId: server.id, name: "thread", type: "thread", parentMessageId: parentMessage.id,
    }).returning();
    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parentMessage.id,
      reason: "manual",
    });

    // Cursors: zeroCursor channel AND the thread at version 0 / seq 0
    // (present-at-zero). noCursor has no row at all (absent).
    await db.insert(userChannelReadCursors).values([
      { userId: owner.id, channelId: zeroCursor.id, lastReadSeq: 0 },
      { userId: owner.id, channelId: thread.id, lastReadSeq: 0 },
    ]);

    await recordInboxNotificationFacts([
      {
        receiverType: "user", receiverId: owner.id, serverId: server.id,
        kind: "channel", sourceChannelId: noCursor.id,
        messageId: noCursorMessage.id, messageSeq: noCursorMessage.seq,
        activityAt: noCursorMessage.createdAt, personalMention: false, unreadEligible: true,
      },
      {
        receiverType: "user", receiverId: owner.id, serverId: server.id,
        kind: "channel", sourceChannelId: zeroCursor.id,
        messageId: zeroCursorMessage.id, messageSeq: zeroCursorMessage.seq,
        activityAt: zeroCursorMessage.createdAt, personalMention: false, unreadEligible: true,
      },
      {
        receiverType: "user", receiverId: owner.id, serverId: server.id,
        kind: "thread", sourceChannelId: thread.id,
        messageId: parentMessage.id, messageSeq: parentMessage.seq,
        activityAt: parentMessage.createdAt, personalMention: false, unreadEligible: false,
      },
    ]);

    const inbox = await getInboxItems(server.id, owner.id, { filter: "all" });
    const byScope = new Map(inbox.items.map((item) => [
      item.kind === "thread" ? item.threadChannelId : item.channelId,
      item,
    ]));

    const absentItem = byScope.get(noCursor.id);
    assert.ok(absentItem, "no-cursor channel appears in the inbox");
    assert.deepEqual(absentItem.readState, { kind: "absent" }, "no cursor row -> absent, not zero");
    assert.equal(absentItem.maxReadSeq, 0, "legacy coalesce field stays byte-compatible");

    const zeroItem = byScope.get(zeroCursor.id);
    assert.ok(zeroItem, "zero-cursor channel appears in the inbox");
    assert.equal(zeroItem.readState?.kind, "present", "cursor at 0 is present — presence is not value-derived");
    if (zeroItem.readState?.kind === "present") {
      assert.equal(zeroItem.readState.readStateVersion, 0);
      assert.equal(zeroItem.readState.maxReadSeq, "0");
      assert.deepEqual(
        zeroItem.readState.latestActivity,
        { messageId: parentMessage.id, seq: String(parentMessage.seq) },
        "union frontier is the scope's OWN latest message",
      );
    }

    const threadItem = byScope.get(thread.id);
    assert.ok(threadItem, "followed zero-reply thread appears in the inbox");
    assert.equal(threadItem.readState?.kind, "present");
    if (threadItem.readState?.kind === "present") {
      assert.equal(
        threadItem.readState.latestActivity,
        null,
        "zero-reply thread: the union frontier is null (scope has no messages; parent seq is a different domain)",
      );
    }
    if (threadItem.kind === "thread") {
      assert.equal(threadItem.latestActivityMessageId, parentMessage.id, "display pair keeps the parent fallback");
      assert.equal(threadItem.latestActivitySeq, String(parentMessage.seq), "display pair keeps the parent seq (paired)");
    }

    // Cross-exit consistency (the frozen gate's server half, extended to this
    // exit): the same scope through /channels/unread must yield the identical
    // union as through /channels/inbox.
    const summary = await getUnreadSummary(server.id, owner.id);
    for (const scopeId of [noCursor.id, zeroCursor.id]) {
      const entry = summary[scopeId];
      assert.ok(entry, `summary covers ${scopeId}`);
      assert.deepEqual(
        byScope.get(scopeId)?.readState,
        entry.readState,
        "same scope -> identical union across exits",
      );
    }
  } finally {
    await closeTestDatabase();
  }
});

// Regression tooth for the CI shard-7 hang: when the caller is INSIDE a
// transaction (the activity-sync authority tx passes its executor into
// getInboxItems), the read-state authority read must run on that same
// executor. A global-getDb() read there both misses the transaction's
// snapshot and deadlocks single-connection drivers (pglite): the tx holds
// the only connection while the flow waits on its own query. This test hangs
// (suite timeout) on the pre-fix shape; on the fix it completes and the
// union is read from the caller's transaction snapshot.
test("real DB: tx-scoped caller — getInboxItems inside a caller transaction completes and reads the union (both PG backends)", async () => {
  await initReadStateDatabase();
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "inbox-tx-owner@test.com",
      name: "InboxTxOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [other] = await db.insert(users).values({
      email: "inbox-tx-other@test.com",
      name: "InboxTxOther",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "InboxTx",
      slug: "inbox-tx",
      ownerId: owner.id,
    }).returning();
    const [channel] = await db.insert(channels).values({
      serverId: server.id, name: "general", type: "channel",
    }).returning();
    await db.insert(channelHumans).values([
      { channelId: channel.id, userId: owner.id },
      { channelId: channel.id, userId: other.id },
    ]);
    const [message] = await db.insert(messages).values({
      channelId: channel.id, senderType: "user", senderId: other.id, content: "unread",
    }).returning();
    await db.insert(userChannelReadCursors).values([
      { userId: owner.id, channelId: channel.id, lastReadSeq: 0 },
    ]);
    await recordInboxNotificationFacts([{
      receiverType: "user", receiverId: owner.id, serverId: server.id,
      kind: "channel", sourceChannelId: channel.id,
      messageId: message.id, messageSeq: message.seq,
      activityAt: message.createdAt, personalMention: false, unreadEligible: true,
    }]);

    const assertPage = (items: Awaited<ReturnType<typeof getInboxItems>>["items"]) => {
      const item = items.find((candidate) => candidate.kind === "channel" && candidate.channelId === channel.id);
      assert.ok(item, "channel row present");
      assert.equal(item.readState?.kind, "present");
      if (item.readState?.kind === "present") {
        assert.equal(item.readState.maxReadSeq, "0");
        assert.deepEqual(item.readState.latestActivity, { messageId: message.id, seq: String(message.seq) });
      }
    };

    // pg_legacy canonical backend (no mute flag, no historyCutoff).
    await db.transaction(async (tx) => {
      const page = await getInboxItems(server.id, owner.id, { filter: "all", executor: tx });
      assertPage(page.items);
    });

    // serving-rows backend (humanActivityMuteEnabled forces it).
    await db.transaction(async (tx) => {
      const page = await getInboxItems(server.id, owner.id, {
        filter: "all",
        executor: tx,
        humanActivityMuteEnabled: true,
      });
      assertPage(page.items);
    });
  } finally {
    await closeTestDatabase();
  }
});
