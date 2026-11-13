import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  channels,
  inboxNotificationFacts,
  inboxTargetMuteStates,
  messages,
  notificationOutbox,
  serverMembers,
  servers,
  userChannelReadCursors,
  users,
} from "../db/schema";
import { markRead } from "./channelService";
import {
  recordInboxNotificationFacts,
  type InboxNotificationFactInput,
} from "./inboxNotificationService";
import { runWithTraceSpan } from "../tracing/semanticTrace";
import { __resetNotificationDispatchRuntimeForTests, __setNotificationDispatchRuntimeForTests } from "./notifications/dispatcher";


beforeEach(() => {
  __setNotificationDispatchRuntimeForTests({
    schedule: () => {},
  });
});

afterEach(() => {
  __resetNotificationDispatchRuntimeForTests();
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

  const outboxRows = await getDb()
    .select({ messageId: notificationOutbox.messageId })
    .from(notificationOutbox);
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

  // serving-row increment/rebuild events died with serving_rows maintenance
  // (2026-09-21 teardown); the decision family above is the surviving contract.
});

