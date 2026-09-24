import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach } from "vitest";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import {
  channels,
  inboxNotificationFacts,
  inboxServingRows,
  inboxTargetMuteStates,
  messages,
  mobilePushOutbox,
  serverMembers,
  servers,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import { markRead } from "./channelService.js";
import {
  rebuildInboxServingRowsForReceiverTargets,
  recordInboxNotificationFacts,
  type InboxNotificationFactInput,
} from "./inboxNotificationService.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import { __resetMobilePushDeliveryRuntimeForTests, __setMobilePushDeliveryRuntimeForTests } from "./pushService.js";


beforeEach(() => {
  __setMobilePushDeliveryRuntimeForTests({
    schedule: () => {},
  });
});

afterEach(() => {
  __resetMobilePushDeliveryRuntimeForTests();
});

async function seedInboxNotificationFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "notification-owner@test.com",
    name: "NotifyOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [other] = await db.insert(users).values({
    email: "notification-other@test.com",
    name: "NotifyOther",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Inbox Notifications",
    slug: "inbox-notifications",
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: other.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();
  const [parent] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "parent",
    seq: 1,
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  const [ownMessage] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "own activity",
    seq: 2,
  }).returning();
  const [mention] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "hi @NotifyOwner",
    seq: 3,
  }).returning();
  const [broadcastMention] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "heads up @channel",
    seq: 4,
  }).returning();
  const [threadReply] = await db.insert(messages).values({
    channelId: thread.id,
    senderType: "user",
    senderId: other.id,
    content: "thread reply",
    seq: 4,
  }).returning();
  const [unfollowedThreadReply] = await db.insert(messages).values({
    channelId: thread.id,
    senderType: "user",
    senderId: other.id,
    content: "thread reply after unfollow",
    seq: 5,
  }).returning();
  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: channel.id,
    lastReadSeq: 1,
  });

  return { owner, other, server, channel, thread, parent, ownMessage, mention, broadcastMention, threadReply, unfollowedThreadReply };
}

function normalizeServingRows(rows: (typeof inboxServingRows.$inferSelect)[]) {
  return rows
    .map(({ updatedAt, ...row }) => ({
      ...row,
      latestNotifiedAt: row.latestNotifiedAt.toISOString(),
      lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    }))
    .sort((a, b) => `${a.receiverType}:${a.receiverId}:${a.sourceChannelId}`.localeCompare(`${b.receiverType}:${b.receiverId}:${b.sourceChannelId}`));
}

test("recordInboxNotificationFacts persists facts and rebuilds serving rows from read cursors", async ({ db }) => {
  const { owner, server, channel, parent, ownMessage, mention } = await seedInboxNotificationFixture();
  const activityAt = new Date("2026-06-27T00:00:00.000Z");

  await recordInboxNotificationFacts([
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: parent.id,
      messageSeq: parent.seq,
      activityAt,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: ownMessage.id,
      messageSeq: ownMessage.seq,
      activityAt: new Date(activityAt.getTime() + 1000),
      unreadEligible: false,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: mention.id,
      messageSeq: mention.seq,
      activityAt: new Date(activityAt.getTime() + 2000),
      personalMention: true,
    },
  ]);

  const factRows = await getDb().select().from(inboxNotificationFacts);
  assert.equal(factRows.length, 3);

  const [serving] = await getDb().select().from(inboxServingRows);
  assert.equal(serving.latestNotifiedMessageId, mention.id);
  assert.equal(serving.latestNotifiedSeq, mention.seq);
  assert.equal(serving.lastActivityAt?.toISOString(), new Date(activityAt.getTime() + 2000).toISOString());
  assert.equal(serving.firstUnreadMessageId, mention.id);
  assert.equal(serving.unreadCount, 1);
  assert.equal(serving.latestPersonalMentionMessageId, mention.id);
  assert.equal(serving.unreadMentionCount, 1);
  assert.equal(serving.hasAnyMention, true);

  await markRead(owner.id, channel.id, mention.seq);
  const [afterRead] = await getDb().select().from(inboxServingRows);
  assert.equal(afterRead.latestNotifiedMessageId, mention.id);
  assert.equal(afterRead.unreadCount, 0);
  assert.equal(afterRead.firstUnreadMessageId, null);
  assert.equal(afterRead.unreadMentionCount, 0);
  assert.equal(afterRead.latestPersonalMentionMessageId, mention.id);
  assert.equal(afterRead.hasAnyMention, true);
});

test("recordInboxNotificationFacts skips muted ordinary activity while personal mentions pierce", async ({ db }) => {
  const { owner, server, channel, thread, parent, ownMessage, mention, threadReply } = await seedInboxNotificationFixture();
  const base = new Date("2026-06-27T02:00:00.000Z");

  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: owner.id,
    serverId: server.id,
    sourceChannelId: channel.id,
    muteFromSeq: ownMessage.seq,
  });

  await recordInboxNotificationFacts([
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: parent.id,
      messageSeq: parent.seq,
      activityAt: base,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: ownMessage.id,
      messageSeq: ownMessage.seq,
      activityAt: new Date(base.getTime() + 1000),
      unreadEligible: false,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: mention.id,
      messageSeq: mention.seq,
      activityAt: new Date(base.getTime() + 2000),
      personalMention: true,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: threadReply.id,
      messageSeq: threadReply.seq,
      activityAt: new Date(base.getTime() + 3000),
    },
  ]);

  const factRows = await getDb()
    .select({ messageId: inboxNotificationFacts.messageId })
    .from(inboxNotificationFacts);
  assert.deepEqual(new Set(factRows.map((row) => row.messageId)), new Set([
    parent.id,
    mention.id,
    threadReply.id,
  ]));

  const servingRows = normalizeServingRows(await getDb().select().from(inboxServingRows));
  const channelRow = servingRows.find((row) => row.sourceChannelId === channel.id);
  assert.equal(channelRow?.latestNotifiedMessageId, mention.id);
  assert.equal(channelRow?.latestPersonalMentionMessageId, mention.id);
  const threadRow = servingRows.find((row) => row.sourceChannelId === thread.id);
  assert.equal(threadRow?.latestNotifiedMessageId, threadReply.id);

  const outboxRows = await getDb()
    .select({ messageId: mobilePushOutbox.messageId })
    .from(mobilePushOutbox);
  assert.deepEqual(new Set(outboxRows.map((row) => row.messageId)), new Set([
    parent.id,
    mention.id,
    threadReply.id,
  ]));
});

test("recordInboxNotificationFacts emits diagnostic trace decisions with closed-set reasons", async ({ db }) => {
  const { owner, server, channel, thread, parent, ownMessage, mention, broadcastMention, threadReply, unfollowedThreadReply } = await seedInboxNotificationFixture();
  const base = new Date("2026-06-27T02:00:00.000Z");

  await getDb().insert(inboxTargetMuteStates).values({
    receiverType: "user",
    receiverId: owner.id,
    serverId: server.id,
    sourceChannelId: channel.id,
    muteFromSeq: ownMessage.seq,
  });

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "a".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });

  await runWithTraceSpan(span, async () => {
    await recordInboxNotificationFacts([
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: parent.id,
        messageSeq: parent.seq,
        activityAt: base,
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: ownMessage.id,
        messageSeq: ownMessage.seq,
        activityAt: new Date(base.getTime() + 1000),
        unreadEligible: false,
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: mention.id,
        messageSeq: mention.seq,
        activityAt: new Date(base.getTime() + 2000),
        personalMention: true,
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "channel",
        sourceChannelId: channel.id,
        messageId: broadcastMention.id,
        messageSeq: broadcastMention.seq,
        activityAt: new Date(base.getTime() + 2500),
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "thread",
        sourceChannelId: thread.id,
        messageId: threadReply.id,
        messageSeq: threadReply.seq,
        activityAt: new Date(base.getTime() + 3000),
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        kind: "thread",
        sourceChannelId: thread.id,
        messageId: unfollowedThreadReply.id,
        messageSeq: unfollowedThreadReply.seq,
        activityAt: new Date(base.getTime() + 4000),
        suppressionReason: "unfollowed_thread_ordinary",
      },
    ]);
  });
  span.end();

  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  const decisions = recorded.events.filter((event) => event.name === "inbox.notification_fact.decision");
  assert.equal(decisions.length, 6);

  const byMessage = new Map(decisions.map((event) => [event.attrs?.message_id, event.attrs]));
  assert.equal(byMessage.get(parent.id)?.state, "activity_promoted");
  assert.equal(byMessage.get(parent.id)?.reason, "eligible");

  const muted = byMessage.get(ownMessage.id);
  assert.equal(muted?.state, "activity_not_promoted");
  assert.equal(muted?.reason, "muted");
  assert.equal(muted?.negative_evidence_bucket, "muted_not_unfollowed_or_not_eligible");
  assert.equal(muted?.["inbox.trace_join_key"], `user:${owner.id}:${channel.id}:${ownMessage.id}`);
  assert.equal(muted?.mute_from_seq, ownMessage.seq);

  const pierced = byMessage.get(mention.id);
  assert.equal(pierced?.state, "activity_promoted");
  assert.equal(pierced?.reason, "personal_mention_pierced");

  const mutedBroadcast = byMessage.get(broadcastMention.id);
  assert.equal(mutedBroadcast?.state, "activity_not_promoted");
  assert.equal(mutedBroadcast?.reason, "muted");
  assert.equal(mutedBroadcast?.negative_evidence_bucket, "muted_not_unfollowed_or_not_eligible");
  assert.equal(mutedBroadcast?.personal_mention, false);
  assert.equal(mutedBroadcast?.["inbox.trace_join_key"], `user:${owner.id}:${channel.id}:${broadcastMention.id}`);

  const threadDecision = byMessage.get(threadReply.id);
  assert.equal(threadDecision?.state, "activity_promoted");
  assert.equal(threadDecision?.reason, "thread_independent");
  assert.equal(threadDecision?.negative_evidence_bucket, "thread_follow_policy_not_evaluated");

  const unfollowedThread = byMessage.get(unfollowedThreadReply.id);
  assert.equal(unfollowedThread?.state, "activity_not_promoted");
  assert.equal(unfollowedThread?.reason, "unfollowed_thread_ordinary");
  assert.equal(unfollowedThread?.negative_evidence_bucket, "unfollowed_thread_not_muted_or_not_eligible");
  assert.equal(unfollowedThread?.personal_mention, false);
  assert.equal(unfollowedThread?.["inbox.trace_join_key"], `user:${owner.id}:${thread.id}:${unfollowedThreadReply.id}`);

  const rebuilds = recorded.events.filter((event) => event.name === "inbox.serving_row.rebuild");
  assert.equal(rebuilds.length, 2);
  assert.ok(rebuilds.every((event) => event.attrs?.state === "row_upserted"));
  assert.ok(rebuilds.every((event) => typeof event.attrs?.["inbox.trace_join_key"] === "string"));
});

test("serving rows are byte-equivalent after drop and rebuild from notification facts", async ({ db }) => {
  const { owner, server, channel, thread, parent, mention, threadReply } = await seedInboxNotificationFixture();
  const base = new Date("2026-06-27T01:00:00.000Z");
  const facts: InboxNotificationFactInput[] = [
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: parent.id,
      messageSeq: parent.seq,
      activityAt: base,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: channel.id,
      messageId: mention.id,
      messageSeq: mention.seq,
      activityAt: new Date(base.getTime() + 1000),
      personalMention: true,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: threadReply.id,
      messageSeq: threadReply.seq,
      activityAt: new Date(base.getTime() + 2000),
    },
  ];
  await recordInboxNotificationFacts(facts);

  const before = normalizeServingRows(await getDb().select().from(inboxServingRows));
  await getDb().delete(inboxServingRows);
  await rebuildInboxServingRowsForReceiverTargets([
    { receiverType: "user", receiverId: owner.id, sourceChannelId: channel.id },
    { receiverType: "user", receiverId: owner.id, sourceChannelId: thread.id },
  ]);
  const after = normalizeServingRows(await getDb().select().from(inboxServingRows));

  assert.deepEqual(after, before);
});
