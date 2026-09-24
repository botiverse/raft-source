import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import fc from "fast-check";

import { getDb } from "../db/index.js";
import {
  channelHumans,
  channels,
  featureFlags,
  inboxNotificationFacts,
  inboxTargetMuteStates,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  serverMembers,
  servers,
  threadFollows,
  userChannelReadCursors,
  userChannelInboxStates,
  users,
} from "../db/schema.js";
import { getInboxItems, getUnreadCounts, markRead } from "./channelService.js";
import {
  applyInboxPolicyFilterPageRows,
  mapInboxPolicyRowsToItems,
  projectCurrentInboxPolicy,
  projectInboxServingRowsFromNotificationFacts,
  projectInboxReceiverEffects,
  selectInboxPolicyActiveUnreadCount,
  selectInboxPolicyPageRows,
  type InboxPolicyMentionFact,
  type InboxPolicyModel,
  type InboxPolicyNotificationFact,
  type InboxPolicyNotificationClass,
} from "./inboxPolicyModel.js";
import { recordInboxNotificationFacts } from "./inboxNotificationService.js";
import { HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY } from "./featureFlagService.js";


const USER = "user-a";
const OTHER_USER = "user-b";
const AGENT = "agent-a";
const LONG_TEXT = "x".repeat(160);
const BASE_TIME = Date.UTC(2026, 5, 25, 0, 0, 0);

async function initCurrentPolicyDatabase() {
  await openTestDatabase("pglite://");
  await getDb()
    .update(featureFlags)
    .set({ defaultEnabled: true })
    .where(eq(featureFlags.key, HUMAN_ACTIVITY_MUTE_FEATURE_FLAG_KEY));
}

function message(channelId: string, seq: number, senderId = OTHER_USER) {
  return {
    id: `${channelId}-m${seq}`,
    channelId,
    seq,
    createdAt: seq,
    content: `message ${seq}`,
    senderType: "user" as const,
    senderId,
  };
}

function baseModel(overrides: Partial<InboxPolicyModel> = {}): InboxPolicyModel {
  return {
    userId: USER,
    channels: [
      { id: "c-general", name: "general", type: "channel" },
    ],
    messages: [
      message("c-general", 1),
      message("c-general", 2),
      message("c-general", 3),
    ],
    channelMemberUserIds: { "c-general": [USER, OTHER_USER] },
    lastReadSeqByChannel: {},
    doneChannelIds: [],
    threadFollows: [],
    mentionFacts: [],
    ...overrides,
  };
}

function visibleMention(targetId: string, channelId: string, seq: number): InboxPolicyMentionFact {
  return {
    messageId: `${channelId}-m${seq}`,
    messageSeq: seq,
    channelId,
    targetType: "user",
    targetId,
    notifiableAtSend: true,
  };
}

function broadcastMention(targetId: string, channelId: string, seq: number): InboxPolicyMentionFact {
  return {
    ...visibleMention(targetId, channelId, seq),
    mentionKind: "broadcast",
  };
}

function visibleAgentMention(targetId: string, channelId: string, seq: number): InboxPolicyMentionFact {
  return {
    messageId: `${channelId}-m${seq}`,
    messageSeq: seq,
    channelId,
    targetType: "agent",
    targetId,
    notifiableAtSend: true,
  };
}

function dbMessageToModel(row: {
  id: string;
  channelId: string;
  seq: number;
  createdAt: Date;
  content: string;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
}) {
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    createdAt: row.createdAt.getTime(),
    content: row.content,
    senderType: row.senderType,
    senderId: row.senderId,
  };
}

function projectionSummary(projection: ReturnType<typeof projectCurrentInboxPolicy>) {
  return {
    totalCount: projection.totalCount,
    totalUnreadCount: projection.totalUnreadCount,
    rows: projection.rows.map((row) => ({
      key: `${row.kind}:${row.sourceChannelId}`,
      unreadCount: row.unreadCount,
      hasMention: row.hasMention,
      firstUnreadMessageId: row.firstUnreadMessageId,
    })),
  };
}

function inboxSummary(result: Awaited<ReturnType<typeof getInboxItems>>) {
  return {
    totalCount: result.totalCount,
    totalUnreadCount: result.totalUnreadCount,
    rows: result.items.map((item) => ({
      key: item.kind === "thread" ? `thread:${item.threadChannelId}` : `${item.kind}:${item.channelId}`,
      unreadCount: item.unreadCount,
      hasMention: item.hasMention,
      firstUnreadMessageId: item.firstUnreadMessageId,
    })),
  };
}

function receiverEffectSummary(model: InboxPolicyModel) {
  return projectInboxReceiverEffects(model).rows.map((row) => ({
    key: row.key,
    inAll: row.inAll,
    inUnread: row.inUnread,
    inMentions: row.inMentions,
    unreadCount: row.unreadCount,
    hasMention: row.hasMention,
    mentionOnly: row.mentionOnly,
    notification: row.notification,
  }));
}

async function seedPgliteInboxFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "inbox-owner@test.com",
    name: "InboxOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [other] = await db.insert(users).values({
    email: "inbox-other@test.com",
    name: "InboxOther",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Inbox Diff",
    slug: "inbox-diff",
    ownerId: owner.id,
  }).returning();
  const [general] = await db.insert(channels).values({
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();
  const [dm] = await db.insert(channels).values({
    serverId: server.id,
    name: "dm",
    type: "dm",
  }).returning();

  await db.insert(channelHumans).values([
    { channelId: general.id, userId: owner.id },
    { channelId: general.id, userId: other.id },
    { channelId: dm.id, userId: owner.id },
    { channelId: dm.id, userId: other.id },
  ]);

  const [parent] = await db.insert(messages).values({
    channelId: general.id,
    senderType: "user",
    senderId: owner.id,
    content: "parent",
    createdAt: new Date(BASE_TIME + 1_000),
  }).returning();
  const [generalLatest] = await db.insert(messages).values({
    channelId: general.id,
    senderType: "user",
    senderId: other.id,
    content: "mentioning owner",
    createdAt: new Date(BASE_TIME + 2_000),
  }).returning();
  const [thread] = await db.insert(channels).values({
    serverId: server.id,
    name: "thread",
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  const [threadReply] = await db.insert(messages).values({
    channelId: thread.id,
    senderType: "user",
    senderId: other.id,
    content: "thread reply",
    createdAt: new Date(BASE_TIME + 3_000),
  }).returning();
  const [dmMessage] = await db.insert(messages).values({
    channelId: dm.id,
    senderType: "user",
    senderId: owner.id,
    content: "self dm latest",
    createdAt: new Date(BASE_TIME + 4_000),
  }).returning();

  await db.insert(userChannelReadCursors).values([
    { userId: owner.id, channelId: general.id, lastReadSeq: parent.seq },
    { userId: owner.id, channelId: dm.id, lastReadSeq: dmMessage.seq },
  ]);
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  await db.insert(messageMentions).values({
    messageId: generalLatest.id,
    messageSeq: generalLatest.seq,
    serverId: server.id,
    channelId: general.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: "InboxOwner",
    notifiableAtSend: true,
  });
  await recordInboxNotificationFacts([
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: general.id,
      messageId: parent.id,
      messageSeq: parent.seq,
      activityAt: parent.createdAt,
      personalMention: false,
      unreadEligible: false,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "channel",
      sourceChannelId: general.id,
      messageId: generalLatest.id,
      messageSeq: generalLatest.seq,
      activityAt: generalLatest.createdAt,
      personalMention: true,
      unreadEligible: true,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: threadReply.id,
      messageSeq: threadReply.seq,
      activityAt: threadReply.createdAt,
      personalMention: false,
      unreadEligible: true,
    },
    {
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "dm",
      sourceChannelId: dm.id,
      messageId: dmMessage.id,
      messageSeq: dmMessage.seq,
      activityAt: dmMessage.createdAt,
      personalMention: false,
      unreadEligible: false,
    },
  ]);

  return {
    server,
    owner,
    other,
    general,
    dm,
    thread,
    messages: [parent, generalLatest, threadReply, dmMessage],
  };
}

async function seedPgliteReadMentionFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "read-mention-owner@test.com",
    name: "ReadMentionOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [other] = await db.insert(users).values({
    email: "read-mention-other@test.com",
    name: "ReadMentionOther",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Read Mention Diff",
    slug: "read-mention-diff",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();

  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: other.id },
  ]);

  const [mentioned] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "read mention",
    createdAt: new Date(BASE_TIME + 1_000),
  }).returning();

  await db.insert(userChannelReadCursors).values({
    userId: owner.id,
    channelId: channel.id,
    lastReadSeq: mentioned.seq,
  });
  await db.insert(messageMentions).values({
    messageId: mentioned.id,
    messageSeq: mentioned.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: "ReadMentionOwner",
    notifiableAtSend: true,
  });
  await recordInboxNotificationFacts([{
    receiverType: "user",
    receiverId: owner.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: mentioned.id,
    messageSeq: mentioned.seq,
    activityAt: mentioned.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);

  return { server, owner, other, channel, messages: [mentioned] };
}

async function seedPglitePublicNonMemberMentionFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "public-mention-owner@test.com",
    name: "PublicMentionOwner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [other] = await db.insert(users).values({
    email: "public-mention-other@test.com",
    name: "PublicMentionOther",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Public Mention Diff",
    slug: "public-mention-diff",
    ownerId: other.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "public",
    type: "channel",
  }).returning();

  await db.insert(channelHumans).values({ channelId: channel.id, userId: other.id });

  const [mentioned] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: other.id,
    content: "notified public mention",
    createdAt: new Date(BASE_TIME + 1_000),
  }).returning();

  await db.insert(messageMentions).values({
    messageId: mentioned.id,
    messageSeq: mentioned.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: owner.id,
    handleAtSendTime: "PublicMentionOwner",
    notifiableAtSend: true,
    notifiedAt: new Date(BASE_TIME + 2_000),
    notifiedByType: "user",
    notifiedById: other.id,
    notifiedAction: "notify_only",
  });
  await recordInboxNotificationFacts([{
    receiverType: "user",
    receiverId: owner.id,
    serverId: server.id,
    kind: "channel",
    sourceChannelId: channel.id,
    messageId: mentioned.id,
    messageSeq: mentioned.seq,
    activityAt: mentioned.createdAt,
    personalMention: true,
    unreadEligible: true,
  }]);

  return { server, owner, other, channel, messages: [mentioned] };
}

test("current model projects joined chats and followed threads without mute state", () => {
  const model = baseModel({
    channels: [
      { id: "c-general", name: "general", type: "channel" },
      { id: "t-general-1", name: "thread", type: "thread", parentMessageId: "c-general-m1" },
      { id: "dm-ab", name: "dm", type: "dm" },
    ],
    messages: [
      message("c-general", 1, USER),
      message("c-general", 2),
      message("t-general-1", 1),
      message("dm-ab", 1),
      message("dm-ab", 2, USER),
    ],
    channelMemberUserIds: {
      "c-general": [USER, OTHER_USER],
      "dm-ab": [USER, OTHER_USER],
    },
    lastReadSeqByChannel: {
      "c-general": 1,
      "t-general-1": 0,
      "dm-ab": 1,
    },
    threadFollows: [
      { threadChannelId: "t-general-1", followerType: "user", followerId: USER },
    ],
  });

  const projection = projectCurrentInboxPolicy(model, "all");

  assert.deepEqual(
    projection.rows.map((row) => `${row.kind}:${row.sourceChannelId}`),
    ["channel:c-general", "dm:dm-ab", "thread:t-general-1"],
  );
  assert.equal(projection.totalUnreadCount, 2);
  assert.equal(projection.rows.find((row) => row.sourceChannelId === "c-general")?.unreadCount, 1);
  assert.equal(projection.rows.find((row) => row.sourceChannelId === "t-general-1")?.unreadCount, 1);
  assert.equal(projection.rows.find((row) => row.sourceChannelId === "dm-ab")?.unreadCount, 0);
});

test("pure SQL-row seam selects page rows, totals, and API item shape used by getInboxItems", () => {
  const rawRows = [
    {
      kind: "channel",
      channelId: "c-general",
      channelName: "general",
      channelType: "channel",
      lastMessageId: "m-2",
      firstUnreadMessageId: null,
      lastMessageAt: "2026-06-25 00:00:02.000000+00",
      lastMessagePreview: LONG_TEXT,
      lastMessageSenderType: "user",
      lastMessageSenderId: OTHER_USER,
      lastMessageSenderName: "Bob",
      unreadCount: 0,
      hasMention: false,
      totalCount: "2",
      totalUnreadCount: "1",
    },
    {
      kind: "thread",
      threadChannelId: "t-general",
      parentMessageId: "pm-1",
      parentChannelId: "c-general",
      parentChannelName: "general",
      parentChannelType: "channel",
      parentMessagePreview: LONG_TEXT,
      parentMessageSenderType: "user",
      parentMessageSenderId: OTHER_USER,
      latestActivityPreview: "",
      latestActivitySenderType: "user",
      latestActivitySenderId: OTHER_USER,
      latestActivityMessageId: "pm-1",
      firstUnreadMessageId: "tm-1",
      lastActivityAt: "2026-06-25 00:00:01.000000+00",
      lastReplyAt: null,
      replyCount: 0,
      unreadCount: 1,
      hasMention: true,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
      totalCount: "2",
      totalUnreadCount: "1",
    },
  ];

  const page = selectInboxPolicyPageRows(rawRows, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.totalCount, 2);
  assert.equal(page.totalUnreadCount, 1);
  assert.equal(page.rows.length, 1);
  assert.equal(selectInboxPolicyActiveUnreadCount([
    { ...rawRows[0], activeUnreadCount: "7" },
  ], page.totalUnreadCount), 7);
  assert.equal(
    selectInboxPolicyActiveUnreadCount(rawRows, page.totalUnreadCount),
    1,
    "legacy rows fall back to their filter total until every server projects the global total",
  );

  const items = mapInboxPolicyRowsToItems(rawRows);
  assert.equal(items[0]!.kind, "channel");
  assert.equal(items[0]!.lastMessagePreview, `${"x".repeat(140)}…`);
  assert.equal(items[1]!.kind, "thread");
  assert.equal(items[1]!.parentMessagePreview, `${"x".repeat(100)}…`);
  assert.equal(items[1]!.latestActivityPreview, `${"x".repeat(140)}…`);
});

test("applyInboxPolicyFilterPageRows centralizes unread and mentions filter policy", () => {
  const rawRows = [
    { kind: "channel", channelId: "c-read-mentioned", activityAt: new Date(BASE_TIME + 1), unreadCount: 0, hasMention: false, hasAnyMention: true, mentionOnly: false },
    { kind: "channel", channelId: "c-unread", activityAt: new Date(BASE_TIME + 3), unreadCount: 2, hasMention: false, hasAnyMention: false, mentionOnly: false },
    { kind: "thread", threadChannelId: "t-mention-only", activityAt: new Date(BASE_TIME + 2), unreadCount: 0, hasMention: true, hasAnyMention: true, mentionOnly: true },
    { kind: "channel", channelId: "c-quiet", activityAt: new Date(BASE_TIME + 4), unreadCount: 0, hasMention: false, hasAnyMention: false, mentionOnly: false },
  ];

  assert.deepEqual(
    applyInboxPolicyFilterPageRows(rawRows, { filter: "all", limit: 10 }).rows.map((row) => row.kind === "thread" ? row.threadChannelId : row.channelId),
    ["c-quiet", "c-unread", "t-mention-only", "c-read-mentioned"],
  );
  assert.deepEqual(
    applyInboxPolicyFilterPageRows(rawRows, { filter: "unread", limit: 10 }).rows.map((row) => row.kind === "thread" ? row.threadChannelId : row.channelId),
    ["c-unread"],
  );
  assert.deepEqual(
    applyInboxPolicyFilterPageRows(rawRows, { filter: "mentions", limit: 10 }).rows.map((row) => row.kind === "thread" ? row.threadChannelId : row.channelId),
    ["t-mention-only", "c-read-mentioned"],
  );
});

test("applyInboxPolicyFilterPageRows owns totals, offset, and hasMore over candidate rows", () => {
  const rawRows = [
    { kind: "channel", channelId: "c1", activityAt: new Date(BASE_TIME + 1), unreadCount: 1, hasAnyMention: true, mentionOnly: false },
    { kind: "channel", channelId: "c2", activityAt: new Date(BASE_TIME + 2), unreadCount: 3, hasAnyMention: true, mentionOnly: false },
    { kind: "thread", threadChannelId: "t1", activityAt: new Date(BASE_TIME + 3), unreadCount: 0, hasAnyMention: true, mentionOnly: true },
  ];

  const page = applyInboxPolicyFilterPageRows(rawRows, { filter: "mentions", limit: 1, offset: 1 });

  assert.equal(page.hasMore, true);
  assert.equal(page.totalCount, 3);
  assert.equal(page.totalUnreadCount, 4);
  assert.deepEqual(page.rows.map((row) => row.kind === "thread" ? row.threadChannelId : row.channelId), ["c2"]);
});

test("PGlite differential: getInboxItems SQL matches current pure policy projection", async () => {
  await initCurrentPolicyDatabase();
  try {
    const fixture = await seedPgliteInboxFixture();
    const model: InboxPolicyModel = {
      userId: fixture.owner.id,
      channels: [
        { id: fixture.general.id, name: fixture.general.name, type: "channel" },
        { id: fixture.dm.id, name: fixture.dm.name, type: "dm" },
        { id: fixture.thread.id, name: fixture.thread.name, type: "thread", parentMessageId: fixture.thread.parentMessageId ?? undefined },
      ],
      messages: fixture.messages.map(dbMessageToModel),
      channelMemberUserIds: {
        [fixture.general.id]: [fixture.owner.id, fixture.other.id],
        [fixture.dm.id]: [fixture.owner.id, fixture.other.id],
      },
      lastReadSeqByChannel: {
        [fixture.general.id]: fixture.messages[0]!.seq,
        [fixture.dm.id]: fixture.messages[3]!.seq,
      },
      doneChannelIds: [],
      threadFollows: [
        {
          threadChannelId: fixture.thread.id,
          followerType: "user",
          followerId: fixture.owner.id,
        },
      ],
      mentionFacts: [
        {
          messageId: fixture.messages[1]!.id,
          messageSeq: fixture.messages[1]!.seq,
          channelId: fixture.general.id,
          targetType: "user",
          targetId: fixture.owner.id,
          notifiableAtSend: true,
        },
      ],
    };

    for (const filter of ["all", "unread", "mentions"] as const) {
      const actual = await getInboxItems(fixture.server.id, fixture.owner.id, { filter });
      const expected = projectCurrentInboxPolicy(model, filter);
      assert.deepEqual(inboxSummary(actual), projectionSummary(expected), `${filter} projection should match`);
    }
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: joint multi-projection serving read matches legacy SQL", async () => {
  await initCurrentPolicyDatabase();
  try {
    const db = getDb();
    const [ownerA] = await db.insert(users).values({
      email: "joint-read-owner-a@test.com",
      name: "JointReadOwnerA",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [ownerB] = await db.insert(users).values({
      email: "joint-read-owner-b@test.com",
      name: "JointReadOwnerB",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [serverA] = await db.insert(servers).values({
      name: "Joint Read A",
      slug: "joint-read-a",
      ownerId: ownerA.id,
    }).returning();
    const [serverB] = await db.insert(servers).values({
      name: "Joint Read B",
      slug: "joint-read-b",
      ownerId: ownerB.id,
    }).returning();
    await db.insert(serverMembers).values([
      { serverId: serverA.id, userId: ownerA.id, role: "owner" },
      { serverId: serverB.id, userId: ownerB.id, role: "owner" },
    ]);

    const [canonical] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-read-canonical",
      type: "joint",
    }).returning();
    const [localA] = await db.insert(channels).values({
      serverId: serverA.id,
      name: "joint-read-local-a",
      type: "joint",
    }).returning();
    const [localB] = await db.insert(channels).values({
      serverId: serverB.id,
      name: "joint-read-local-b",
      type: "joint",
    }).returning();
    const [joint] = await db.insert(jointChannels).values({
      canonicalChannelId: canonical.id,
      createdByServerId: serverA.id,
      createdByUserId: ownerA.id,
    }).returning();
    await db.insert(jointChannelServers).values([
      {
        jointChannelId: joint.id,
        serverId: serverA.id,
        localChannelId: localA.id,
        role: "host",
        status: "active",
        joinedByUserId: ownerA.id,
      },
      {
        jointChannelId: joint.id,
        serverId: serverB.id,
        localChannelId: localB.id,
        role: "participant",
        status: "active",
        joinedByUserId: ownerB.id,
      },
    ]);
    await db.insert(channelHumans).values([
      { channelId: localA.id, userId: ownerA.id },
      { channelId: localB.id, userId: ownerB.id },
    ]);

    const [fromA] = await db.insert(messages).values({
      channelId: canonical.id,
      senderType: "user",
      senderId: ownerA.id,
      content: "canonical message from A",
      createdAt: new Date(BASE_TIME + 1_000),
    }).returning();
    const [fromB] = await db.insert(messages).values({
      channelId: canonical.id,
      senderType: "user",
      senderId: ownerB.id,
      content: "canonical message from B",
      createdAt: new Date(BASE_TIME + 2_000),
    }).returning();

    await db.insert(messageMentions).values([
      {
        messageId: fromB.id,
        messageSeq: fromB.seq,
        serverId: serverA.id,
        channelId: localA.id,
        targetType: "user",
        targetId: ownerA.id,
        handleAtSendTime: "JointReadOwnerA",
        notifiableAtSend: true,
      },
      {
        messageId: fromA.id,
        messageSeq: fromA.seq,
        serverId: serverB.id,
        channelId: localB.id,
        targetType: "user",
        targetId: ownerB.id,
        handleAtSendTime: "JointReadOwnerB",
        notifiableAtSend: true,
      },
    ]);
    await recordInboxNotificationFacts([
      {
        receiverType: "user",
        receiverId: ownerA.id,
        serverId: serverA.id,
        kind: "channel",
        sourceChannelId: localA.id,
        messageId: fromB.id,
        messageSeq: fromB.seq,
        activityAt: fromB.createdAt,
        personalMention: true,
        unreadEligible: true,
      },
      {
        receiverType: "user",
        receiverId: ownerB.id,
        serverId: serverB.id,
        kind: "channel",
        sourceChannelId: localB.id,
        messageId: fromA.id,
        messageSeq: fromA.seq,
        activityAt: fromA.createdAt,
        personalMention: true,
        unreadEligible: true,
      },
      {
        receiverType: "user",
        receiverId: ownerB.id,
        serverId: serverB.id,
        kind: "channel",
        sourceChannelId: localB.id,
        messageId: fromB.id,
        messageSeq: fromB.seq,
        activityAt: fromB.createdAt,
        personalMention: false,
        unreadEligible: false,
      },
    ]);

    const cutoffBeforeFixture = new Date(BASE_TIME - 1_000);
    for (const filter of ["all", "unread", "mentions"] as const) {
      const servingA = await getInboxItems(serverA.id, ownerA.id, { filter });
      const legacyA = await getInboxItems(serverA.id, ownerA.id, { filter, historyCutoff: cutoffBeforeFixture });
      assert.deepEqual(inboxSummary(servingA), inboxSummary(legacyA), `server A ${filter} projection should match legacy SQL`);
      assert.deepEqual(inboxSummary(servingA).rows.map((row) => row.key), [`channel:${localA.id}`], `server A ${filter} must not show sibling projection`);

      const servingB = await getInboxItems(serverB.id, ownerB.id, { filter });
      const legacyB = await getInboxItems(serverB.id, ownerB.id, { filter, historyCutoff: cutoffBeforeFixture });
      assert.deepEqual(inboxSummary(servingB), inboxSummary(legacyB), `server B ${filter} projection should match legacy SQL`);
      assert.deepEqual(inboxSummary(servingB).rows.map((row) => row.key), [`channel:${localB.id}`], `server B ${filter} must not show sibling projection`);
    }
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: read mentions stay in Mentions without unread badge", async () => {
  await initCurrentPolicyDatabase();
  try {
    const fixture = await seedPgliteReadMentionFixture();
    const model: InboxPolicyModel = {
      userId: fixture.owner.id,
      channels: [{ id: fixture.channel.id, name: fixture.channel.name, type: "channel" }],
      messages: fixture.messages.map(dbMessageToModel),
      channelMemberUserIds: { [fixture.channel.id]: [fixture.owner.id, fixture.other.id] },
      lastReadSeqByChannel: { [fixture.channel.id]: fixture.messages[0]!.seq },
      doneChannelIds: [],
      threadFollows: [],
      mentionFacts: [
        {
          messageId: fixture.messages[0]!.id,
          messageSeq: fixture.messages[0]!.seq,
          channelId: fixture.channel.id,
          targetType: "user",
          targetId: fixture.owner.id,
          notifiableAtSend: true,
        },
      ],
    };

    for (const filter of ["all", "unread", "mentions"] as const) {
      const actual = await getInboxItems(fixture.server.id, fixture.owner.id, { filter });
      const expected = projectCurrentInboxPolicy(model, filter);
      assert.deepEqual(inboxSummary(actual), projectionSummary(expected), `${filter} projection should match`);
    }
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: notified public non-member mentions are mention-only rows", async () => {
  await initCurrentPolicyDatabase();
  try {
    const fixture = await seedPglitePublicNonMemberMentionFixture();
    const model: InboxPolicyModel = {
      userId: fixture.owner.id,
      channels: [{ id: fixture.channel.id, name: fixture.channel.name, type: "channel" }],
      messages: fixture.messages.map(dbMessageToModel),
      channelMemberUserIds: { [fixture.channel.id]: [fixture.other.id] },
      lastReadSeqByChannel: {},
      doneChannelIds: [],
      threadFollows: [],
      mentionFacts: [
        {
          messageId: fixture.messages[0]!.id,
          messageSeq: fixture.messages[0]!.seq,
          channelId: fixture.channel.id,
          targetType: "user",
          targetId: fixture.owner.id,
          notifiableAtSend: true,
          notified: true,
        },
      ],
    };

    for (const filter of ["all", "unread", "mentions"] as const) {
      const actual = await getInboxItems(fixture.server.id, fixture.owner.id, { filter });
      const expected = projectCurrentInboxPolicy(model, filter);
      assert.deepEqual(inboxSummary(actual), projectionSummary(expected), `${filter} projection should match`);
    }
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: a legacy mention fact with an unrestored tombstone stays mention-only", async () => {
  await initCurrentPolicyDatabase();
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "thread-mention-owner@test.com",
      name: "ThreadMentionOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [other] = await db.insert(users).values({
      email: "thread-mention-other@test.com",
      name: "ThreadMentionOther",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Thread Mention Diff",
      slug: "thread-mention-diff",
      ownerId: owner.id,
    }).returning();
    const [channel] = await db.insert(channels).values({
      serverId: server.id,
      name: "parent",
      type: "channel",
    }).returning();
    await db.insert(channelHumans).values([
      { channelId: channel.id, userId: owner.id },
      { channelId: channel.id, userId: other.id },
    ]);
    await db.insert(userChannelInboxStates).values({
      userId: owner.id,
      channelId: channel.id,
      doneAt: new Date(BASE_TIME + 1_250),
    });
    const [parent] = await db.insert(messages).values({
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "parent message",
      createdAt: new Date(BASE_TIME + 1_000),
    }).returning();
    const [thread] = await db.insert(channels).values({
      serverId: server.id,
      name: "thread",
      type: "thread",
      parentMessageId: parent.id,
    }).returning();
    const [ordinaryReply] = await db.insert(messages).values({
      channelId: thread.id,
      senderType: "user",
      senderId: other.id,
      content: "ordinary reply after unfollow",
      createdAt: new Date(BASE_TIME + 2_000),
    }).returning();
    const [mentionReply] = await db.insert(messages).values({
      channelId: thread.id,
      senderType: "user",
      senderId: other.id,
      content: "direct mention after unfollow",
      createdAt: new Date(BASE_TIME + 3_000),
    }).returning();

    await db.insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parent.id,
      reason: "manual",
      unfollowedAt: new Date(BASE_TIME + 1_500),
    });
    await db.insert(messageMentions).values({
      messageId: mentionReply.id,
      messageSeq: mentionReply.seq,
      serverId: server.id,
      channelId: thread.id,
      targetType: "user",
      targetId: owner.id,
      handleAtSendTime: "ThreadMentionOwner",
      notifiableAtSend: true,
      notifiedAt: new Date(BASE_TIME + 3_500),
      notifiedByType: "user",
      notifiedById: other.id,
      notifiedAction: "notify_only",
    });
    await recordInboxNotificationFacts([{
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      kind: "thread",
      sourceChannelId: thread.id,
      messageId: mentionReply.id,
      messageSeq: mentionReply.seq,
      activityAt: mentionReply.createdAt,
      personalMention: true,
      unreadEligible: true,
    }]);
    const model: InboxPolicyModel = {
      userId: owner.id,
      channels: [
        { id: channel.id, name: channel.name, type: "channel" },
        { id: thread.id, name: thread.name, type: "thread", parentMessageId: parent.id },
      ],
      messages: [parent, ordinaryReply, mentionReply].map(dbMessageToModel),
      channelMemberUserIds: { [channel.id]: [owner.id, other.id] },
      lastReadSeqByChannel: {},
      doneChannelIds: [channel.id],
      threadFollows: [
        {
          threadChannelId: thread.id,
          followerType: "user",
          followerId: owner.id,
          unfollowed: true,
        },
      ],
      mentionFacts: [{
        messageId: mentionReply.id,
        messageSeq: mentionReply.seq,
        channelId: thread.id,
        targetType: "user",
        targetId: owner.id,
        notifiableAtSend: true,
        notified: true,
      }],
    };

    // This pins serving behavior for historical rows written before the send
    // pipeline began reactivating direct mentions. Policy projection must not
    // mutate persisted follow state on read: the legacy delivered mention is
    // visible in All and Mentions, but not Unread.
    // ref #proj-chat:ae265034
    for (const filter of ["all", "unread", "mentions"] as const) {
      const serving = await getInboxItems(server.id, owner.id, { filter });
      const expected = projectCurrentInboxPolicy(model, filter);
      assert.deepEqual(inboxSummary(serving), projectionSummary(expected), `serving ${filter} projection should match canonical policy`);
    }

    const mentions = await getInboxItems(server.id, owner.id, { filter: "mentions" });
    const mentionThreadItem = mentions.items.find((item) => item.kind === "thread" && item.threadChannelId === thread.id);
    assert.ok(mentionThreadItem, "unfollowed thread direct mention should create a Mentions notification row");
    assert.equal(mentionThreadItem.unreadCount, 0, "mention-only row must not count the whole unfollowed thread as unread");
    assert.equal(mentionThreadItem.firstUnreadMessageId, mentionReply.id);
    const all = await getInboxItems(server.id, owner.id, { filter: "all" });
    const allThreadItem = all.items.find((item) => item.kind === "thread" && item.threadChannelId === thread.id);
    assert.ok(allThreadItem, "All includes delivered mention-only thread notifications");
    assert.equal(allThreadItem.hasMention, true);
    assert.equal(allThreadItem.unreadCount, 0);
    assert.equal(
      allThreadItem.firstUnreadMessageId,
      mentionReply.id,
      "mention-only All row anchors to the delivered mention",
    );
    assert.equal(
      (await getInboxItems(server.id, owner.id, { filter: "unread" })).items.some((item) => item.kind === "thread" && item.threadChannelId === thread.id),
      false,
      "Unread excludes mention-only notifications because they do not count the whole thread as unread",
    );
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: done channel state suppresses active inbox rows", async () => {
  await initCurrentPolicyDatabase();
  try {
    const fixture = await seedPgliteInboxFixture();
    const db = getDb();
    await db.insert(userChannelInboxStates).values({
      userId: fixture.owner.id,
      channelId: fixture.dm.id,
      doneAt: new Date(BASE_TIME + 5_000),
    });

    const model: InboxPolicyModel = {
      userId: fixture.owner.id,
      channels: [
        { id: fixture.general.id, name: fixture.general.name, type: "channel" },
        { id: fixture.dm.id, name: fixture.dm.name, type: "dm" },
        { id: fixture.thread.id, name: fixture.thread.name, type: "thread", parentMessageId: fixture.thread.parentMessageId ?? undefined },
      ],
      messages: fixture.messages.map(dbMessageToModel),
      channelMemberUserIds: {
        [fixture.general.id]: [fixture.owner.id, fixture.other.id],
        [fixture.dm.id]: [fixture.owner.id, fixture.other.id],
      },
      lastReadSeqByChannel: {
        [fixture.general.id]: fixture.messages[0]!.seq,
        [fixture.dm.id]: fixture.messages[3]!.seq,
      },
      doneChannelIds: [fixture.dm.id],
      threadFollows: [
        {
          threadChannelId: fixture.thread.id,
          followerType: "user",
          followerId: fixture.owner.id,
        },
      ],
      mentionFacts: [
        {
          messageId: fixture.messages[1]!.id,
          messageSeq: fixture.messages[1]!.seq,
          channelId: fixture.general.id,
          targetType: "user",
          targetId: fixture.owner.id,
          notifiableAtSend: true,
        },
      ],
    };

    const actual = await getInboxItems(fixture.server.id, fixture.owner.id, { filter: "all" });
    const expected = projectCurrentInboxPolicy(model, "all");
    assert.deepEqual(inboxSummary(actual), projectionSummary(expected));
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: server push mute does not suppress activity rows", async () => {
  await initCurrentPolicyDatabase();
  try {
    const fixture = await seedPgliteInboxFixture();
    const db = getDb();
    await db.insert(serverMembers).values({
      serverId: fixture.server.id,
      userId: fixture.owner.id,
      role: "owner",
      serverPushMuted: true,
    });

    const model: InboxPolicyModel = {
      userId: fixture.owner.id,
      channels: [
        { id: fixture.general.id, name: fixture.general.name, type: "channel" },
        { id: fixture.dm.id, name: fixture.dm.name, type: "dm" },
        { id: fixture.thread.id, name: fixture.thread.name, type: "thread", parentMessageId: fixture.thread.parentMessageId ?? undefined },
      ],
      messages: fixture.messages.map(dbMessageToModel),
      channelMemberUserIds: {
        [fixture.general.id]: [fixture.owner.id, fixture.other.id],
        [fixture.dm.id]: [fixture.owner.id, fixture.other.id],
      },
      lastReadSeqByChannel: {
        [fixture.general.id]: fixture.messages[0]!.seq,
        [fixture.dm.id]: fixture.messages[3]!.seq,
      },
      doneChannelIds: [],
      threadFollows: [
        {
          threadChannelId: fixture.thread.id,
          followerType: "user",
          followerId: fixture.owner.id,
        },
      ],
      mentionFacts: [
        {
          messageId: fixture.messages[1]!.id,
          messageSeq: fixture.messages[1]!.seq,
          channelId: fixture.general.id,
          targetType: "user",
          targetId: fixture.owner.id,
          notifiableAtSend: true,
        },
      ],
    };

    const actual = await getInboxItems(fixture.server.id, fixture.owner.id, { filter: "all" });
    const expected = projectCurrentInboxPolicy(model, "all");
    assert.deepEqual(inboxSummary(actual), projectionSummary(expected));
  } finally {
    await closeTestDatabase();
  }
});

test("PGlite differential: muted ordinary traffic has no Inbox fact while channel catch-up stays cursor-owned", async () => {
  await initCurrentPolicyDatabase();
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "muted-catchup-owner@test.com",
      name: "MutedCatchupOwner",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [other] = await db.insert(users).values({
      email: "muted-catchup-other@test.com",
      name: "MutedCatchupOther",
      passwordHash: "x",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Muted Catchup",
      slug: "muted-catchup",
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
    await db.insert(channelHumans).values([
      { channelId: channel.id, userId: owner.id },
      { channelId: channel.id, userId: other.id },
    ]);
    await db.insert(inboxTargetMuteStates).values({
      receiverType: "user",
      receiverId: owner.id,
      serverId: server.id,
      sourceChannelId: channel.id,
      muteFromSeq: 1,
    });
    const [mutedMessage] = await db.insert(messages).values({
      channelId: channel.id,
      senderType: "user",
      senderId: other.id,
      content: "ordinary while muted",
      createdAt: new Date(BASE_TIME + 1_000),
    }).returning();

    const whileMuted = await getInboxItems(server.id, owner.id, { filter: "unread" });
    assert.deepEqual(inboxSummary(whileMuted), {
      totalCount: 0,
      totalUnreadCount: 0,
      rows: [],
    });
    assert.equal((await db.select().from(inboxNotificationFacts)).length, 0, "muted ordinary message must not create Activity facts");
    assert.equal((await getUnreadCounts(server.id, owner.id, new Date(0)))[channel.id], 1, "muted ordinary message remains channel catch-up unread");

    await db.delete(inboxTargetMuteStates);
    const afterUnmute = await getInboxItems(server.id, owner.id, { filter: "unread" });
    assert.deepEqual(inboxSummary(afterUnmute), {
      totalCount: 0,
      totalUnreadCount: 0,
      rows: [],
    });
    assert.equal((await db.select().from(inboxNotificationFacts)).length, 0, "unmute must not backfill notification facts");
    assert.equal((await getUnreadCounts(server.id, owner.id, new Date(0)))[channel.id], 1, "unmute does not consume channel catch-up");

    await markRead(owner.id, channel.id, mutedMessage.seq);
    const afterRead = await getInboxItems(server.id, owner.id, { filter: "unread" });
    assert.deepEqual(inboxSummary(afterRead), {
      totalCount: 0,
      totalUnreadCount: 0,
      rows: [],
    });
    assert.equal((await getUnreadCounts(server.id, owner.id, new Date(0)))[channel.id] ?? 0, 0, "real read cursor clears channel catch-up");
  } finally {
    await closeTestDatabase();
  }
});

test("parent channel mute leaves followed-thread ordinary replies independent while unfollow hides the row", () => {
  const followedModel = baseModel({
    channels: [
      { id: "c-general", name: "general", type: "channel" },
      { id: "t-general-1", name: "thread", type: "thread", parentMessageId: "c-general-m1" },
    ],
    messages: [
      message("c-general", 1, USER),
      message("t-general-1", 1),
    ],
    channelMemberUserIds: { "c-general": [USER, OTHER_USER] },
    threadFollows: [
      { threadChannelId: "t-general-1", followerType: "user", followerId: USER },
    ],
    mutedChannelIds: ["c-general"],
  });
  const unfollowedModel: InboxPolicyModel = {
    ...followedModel,
    threadFollows: [
      { threadChannelId: "t-general-1", followerType: "user", followerId: USER, unfollowed: true },
    ],
  };

  const followedThread = projectCurrentInboxPolicy(followedModel, "all").rows.find((row) => row.kind === "thread");
  if (!followedThread || followedThread.kind !== "thread") assert.fail("followed thread row remains addressable");
  assert.equal(followedThread.latestActivityMessageId, "t-general-1-m1", "muted parent does not freeze a followed thread row");
  assert.equal(followedThread.unreadCount, 1, "muted parent does not suppress followed-thread unread Activity");
  assert.equal(
    projectCurrentInboxPolicy(unfollowedModel, "all").rows.some((row) => row.kind === "thread"),
    false,
    "explicit unfollow still hides the thread row",
  );
});

test("unfollowed threads surface direct mentions as notification rows without follow restore", () => {
  const model = baseModel({
    channels: [
      { id: "c-general", name: "general", type: "channel" },
      { id: "t-general-1", name: "thread", type: "thread", parentMessageId: "c-general-m1" },
    ],
    messages: [
      message("c-general", 1, OTHER_USER),
      message("t-general-1", 1, OTHER_USER),
      message("t-general-1", 2, OTHER_USER),
    ],
    channelMemberUserIds: { "c-general": [USER, OTHER_USER] },
    lastReadSeqByChannel: { "t-general-1": 0 },
    threadFollows: [
      { threadChannelId: "t-general-1", followerType: "user", followerId: USER, unfollowed: true },
    ],
    mentionFacts: [{ ...visibleMention(USER, "t-general-1", 2), notified: true }],
  });

  assert.equal(
    projectCurrentInboxPolicy(model, "all").rows.some((row) => row.kind === "thread"),
    true,
    "All includes delivered mention-only direct notifications when the thread is unfollowed",
  );
  assert.equal(
    projectCurrentInboxPolicy(model, "unread").rows.some((row) => row.kind === "thread"),
    false,
    "Unread excludes mention-only direct notifications without implying a followed thread",
  );
  assert.deepEqual(projectionSummary(projectCurrentInboxPolicy(model, "mentions")), {
    totalCount: 1,
    totalUnreadCount: 0,
    rows: [{
      key: "thread:t-general-1",
      unreadCount: 0,
      hasMention: true,
      firstUnreadMessageId: "t-general-1-m2",
    }],
  });
  assert.equal(
    projectCurrentInboxPolicy(model, "mentions").rows[0]?.mentionOnly,
    true,
    "direct mention is orthogonal to follow state and does not restore follow",
  );
});

test("channel mute state is scoped to the current receiver actor, not the channel", () => {
  const sharedSurface = {
    channels: [{ id: "c-general", name: "general", type: "channel" as const }],
    messages: [
      message("c-general", 1, "sender-c"),
      message("c-general", 2, "sender-c"),
    ],
    channelMemberUserIds: { "c-general": [USER, OTHER_USER] },
    lastReadSeqByChannel: { "c-general": 1 },
  };
  const aliceMuted = baseModel({
    ...sharedSurface,
    userId: USER,
    mutedChannelIds: ["c-general"],
  });
  const bobUnmuted = baseModel({
    ...sharedSurface,
    userId: OTHER_USER,
    mutedChannelIds: [],
  });

  assert.deepEqual(
    projectionSummary(projectCurrentInboxPolicy(aliceMuted, "all")),
    { totalCount: 0, totalUnreadCount: 0, rows: [] },
    "muted ordinary channel traffic does not create an Activity fact for that receiver",
  );
  assert.deepEqual(
    projectionSummary(projectCurrentInboxPolicy(bobUnmuted, "all")),
    {
      totalCount: 1,
      totalUnreadCount: 1,
      rows: [
        {
          key: "channel:c-general",
          unreadCount: 1,
          hasMention: false,
          firstUnreadMessageId: "c-general-m2",
        },
      ],
    },
    "one receiver muting a channel must not make that channel globally muted for other receivers",
  );
});

test("current model keeps Mentions filter independent from unread mention badge", () => {
  const model = baseModel({
    lastReadSeqByChannel: { "c-general": 3 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });

  const allRow = projectCurrentInboxPolicy(model, "all").rows[0]!;
  const mentionsRow = projectCurrentInboxPolicy(model, "mentions").rows[0]!;

  assert.equal(allRow.hasMention, false, "row badge is unread-scoped");
  assert.equal(mentionsRow.hasMention, false, "mentions tab does not rewrite read mentions into unread badges");
  assert.equal(mentionsRow.hasAnyMention, true, "mentions tab still includes read mention history");
});

test("mute policy treats Activity as receiver notification fact history", () => {
  const mutedModel = baseModel({
    mutedChannelIds: ["c-general"],
    doNotDisturbUserIds: [USER],
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });
  const unmutedModel = baseModel({
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });
  const readMutedModel = baseModel({
    mutedChannelIds: ["c-general"],
    lastReadSeqByChannel: { "c-general": 2 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });

  assert.deepEqual(projectionSummary(projectCurrentInboxPolicy(mutedModel, "all")), {
    totalCount: 1,
    totalUnreadCount: 1,
    rows: [
      {
        key: "channel:c-general",
        unreadCount: 1,
        hasMention: true,
        firstUnreadMessageId: "c-general-m2",
      },
    ],
  });
  assert.deepEqual(projectionSummary(projectCurrentInboxPolicy(unmutedModel, "all")), {
    totalCount: 1,
    totalUnreadCount: 2,
    rows: [
      {
        key: "channel:c-general",
        unreadCount: 2,
        hasMention: true,
        firstUnreadMessageId: "c-general-m2",
      },
    ],
  });
  assert.equal(projectCurrentInboxPolicy(mutedModel, "mentions").rows.length, 1);
  assert.deepEqual(projectionSummary(projectCurrentInboxPolicy(readMutedModel, "all")), {
    totalCount: 1,
    totalUnreadCount: 0,
    rows: [
      {
        key: "channel:c-general",
        unreadCount: 0,
        hasMention: false,
        firstUnreadMessageId: null,
      },
    ],
  });
  assert.equal(projectCurrentInboxPolicy(readMutedModel, "mentions").rows.length, 1);
});

test("mute boundary preserves pre-mute activity history and hides post-mute ordinary traffic", () => {
  const model = baseModel({
    muteFromSeqByChannel: { "c-general": 3 },
    lastReadSeqByChannel: { "c-general": 1 },
  });
  const piercedMentionModel = baseModel({
    muteFromSeqByChannel: { "c-general": 3 },
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [visibleMention(USER, "c-general", 3)],
  });

  const row = projectCurrentInboxPolicy(model, "all").rows[0]!;
  if (row.kind !== "channel") assert.fail(`expected channel row, got ${row.kind}`);
  assert.equal(row.latestMessageId, "c-general-m2");
  assert.equal(row.firstUnreadMessageId, "c-general-m2");
  assert.equal(row.unreadCount, 1);
  assert.equal(row.hasMention, false);

  const piercedRow = projectCurrentInboxPolicy(piercedMentionModel, "all").rows[0]!;
  if (piercedRow.kind !== "channel") assert.fail(`expected channel row, got ${piercedRow.kind}`);
  assert.equal(piercedRow.latestMessageId, "c-general-m3");
  assert.equal(piercedRow.firstUnreadMessageId, "c-general-m2");
  assert.equal(piercedRow.unreadCount, 2);
  assert.equal(piercedRow.hasMention, true);
  assert.equal(projectCurrentInboxPolicy(piercedMentionModel, "mentions").rows.length, 1);
});

test("mute policy does not treat broadcast mention facts as personal attention", () => {
  const model = baseModel({
    mutedChannelIds: ["c-general"],
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [broadcastMention(USER, "c-general", 2)],
  });

  assert.deepEqual(
    projectionSummary(projectCurrentInboxPolicy(model, "all")),
    { totalCount: 0, totalUnreadCount: 0, rows: [] },
    "broadcast/mute does not create a receiver notification fact",
  );
  assert.equal(projectCurrentInboxPolicy(model, "mentions").rows.length, 0);
});

test("mute-from-first corner keeps broadcast-only traffic out while personal mention pierces", () => {
  const messages = [
    message("c-general", 1, "sender-c"),
    message("c-general", 2, "sender-c"),
    message("c-general", 3, "sender-c"),
  ];
  const broadcastOnly = baseModel({
    messages,
    muteFromSeqByChannel: { "c-general": 1 },
    lastReadSeqByChannel: { "c-general": 0 },
    mentionFacts: [broadcastMention(USER, "c-general", 2)],
  });
  const personalAfterMute = baseModel({
    messages,
    muteFromSeqByChannel: { "c-general": 1 },
    lastReadSeqByChannel: { "c-general": 0 },
    mentionFacts: [
      broadcastMention(USER, "c-general", 2),
      visibleMention(USER, "c-general", 3),
    ],
  });
  const readPersonalAfterMute = baseModel({
    ...personalAfterMute,
    lastReadSeqByChannel: { "c-general": 3 },
  });
  const otherReceiver = baseModel({
    ...personalAfterMute,
    userId: OTHER_USER,
    receiverType: "user",
    receiverId: OTHER_USER,
    muteFromSeqByChannel: {},
    lastReadSeqByChannel: { "c-general": 0 },
  });

  assert.deepEqual(projectionSummary(projectCurrentInboxPolicy(broadcastOnly, "all")), {
    totalCount: 0,
    totalUnreadCount: 0,
    rows: [],
  });
  assert.equal(projectCurrentInboxPolicy(broadcastOnly, "mentions").rows.length, 0);

  const pierced = projectCurrentInboxPolicy(personalAfterMute, "all").rows[0]!;
  if (pierced.kind !== "channel") assert.fail(`expected channel row, got ${pierced.kind}`);
  assert.equal(pierced.latestMessageId, "c-general-m3");
  assert.equal(pierced.firstUnreadMessageId, "c-general-m3");
  assert.equal(pierced.unreadCount, 1);
  assert.equal(pierced.hasMention, true);
  assert.equal(projectCurrentInboxPolicy(personalAfterMute, "mentions").rows.length, 1);

  const readPierced = projectCurrentInboxPolicy(readPersonalAfterMute, "all").rows[0]!;
  if (readPierced.kind !== "channel") assert.fail(`expected channel row, got ${readPierced.kind}`);
  assert.equal(readPierced.latestMessageId, "c-general-m3");
  assert.equal(readPierced.firstUnreadMessageId, null);
  assert.equal(readPierced.unreadCount, 0);
  assert.equal(readPierced.hasMention, false);
  assert.equal(projectCurrentInboxPolicy(readPersonalAfterMute, "mentions").rows.length, 1);

  const other = projectCurrentInboxPolicy(otherReceiver, "all").rows[0]!;
  if (other.kind !== "channel") assert.fail(`expected channel row, got ${other.kind}`);
  assert.equal(other.latestMessageId, "c-general-m3");
  assert.equal(other.firstUnreadMessageId, "c-general-m1");
  assert.equal(other.unreadCount, 3);
  assert.equal(other.hasMention, false);
  assert.equal(projectCurrentInboxPolicy(otherReceiver, "mentions").rows.length, 0);
});

test("contract: member mute freezes channel while followed threads stay independent and personal mentions update", () => {
  const channels = [
    { id: "c-main", name: "main", type: "channel" as const },
    { id: "c-other", name: "other", type: "channel" as const },
    { id: "t-main-1", name: "main-thread", type: "thread" as const, parentMessageId: "c-main-m1" },
  ];
  const membership = {
    "c-main": [USER, OTHER_USER],
    "c-other": [USER, OTHER_USER],
  };
  const threadFollow = {
    threadChannelId: "t-main-1",
    followerType: "user" as const,
    followerId: USER,
  };
  const rowSummary = (model: InboxPolicyModel) =>
    projectCurrentInboxPolicy(model, "all").rows.map((row) => ({
      key: `${row.kind}:${row.sourceChannelId}`,
      latestMessageId: row.kind === "thread" ? row.latestActivityMessageId : row.latestMessageId,
      firstUnreadMessageId: row.firstUnreadMessageId,
      unreadCount: row.unreadCount,
      hasMention: row.hasMention,
    }));

  const unmuted = baseModel({
    channels,
    messages: [
      { ...message("c-main", 1, "sender-c"), createdAt: 1 },
      { ...message("c-other", 1, "sender-c"), createdAt: 2 },
      { ...message("c-main", 2, "sender-c"), createdAt: 3 },
    ],
    channelMemberUserIds: membership,
    lastReadSeqByChannel: { "c-main": 2, "c-other": 0, "t-main-1": 0 },
    threadFollows: [threadFollow],
  });
  assert.deepEqual(rowSummary(unmuted), [
    {
      key: "channel:c-main",
      latestMessageId: "c-main-m2",
      firstUnreadMessageId: null,
      unreadCount: 0,
      hasMention: false,
    },
    {
      key: "channel:c-other",
      latestMessageId: "c-other-m1",
      firstUnreadMessageId: "c-other-m1",
      unreadCount: 1,
      hasMention: false,
    },
    {
      key: "thread:t-main-1",
      latestMessageId: "c-main-m1",
      firstUnreadMessageId: null,
      unreadCount: 0,
      hasMention: false,
    },
  ]);

  const muted = baseModel({
    channels,
    messages: [
      { ...message("c-main", 1, "sender-c"), createdAt: 1 },
      { ...message("c-other", 1, "sender-c"), createdAt: 2 },
      { ...message("c-main", 2, "sender-c"), createdAt: 3 },
      { ...message("c-other", 2, "sender-c"), createdAt: 4 },
      { ...message("c-main", 3, "sender-c"), createdAt: 5 },
      { ...message("t-main-1", 4, "sender-c"), createdAt: 6 },
    ],
    channelMemberUserIds: membership,
    lastReadSeqByChannel: { "c-main": 2, "c-other": 0, "t-main-1": 0 },
    threadFollows: [threadFollow],
    muteFromSeqByChannel: { "c-main": 3 },
  });
  assert.deepEqual(rowSummary(muted), [
    {
      key: "thread:t-main-1",
      latestMessageId: "t-main-1-m4",
      firstUnreadMessageId: "t-main-1-m4",
      unreadCount: 1,
      hasMention: false,
    },
    {
      key: "channel:c-other",
      latestMessageId: "c-other-m2",
      firstUnreadMessageId: "c-other-m1",
      unreadCount: 2,
      hasMention: false,
    },
    {
      key: "channel:c-main",
      latestMessageId: "c-main-m2",
      firstUnreadMessageId: null,
      unreadCount: 0,
      hasMention: false,
    },
  ]);

  const mentionedAfterMute = baseModel({
    channels,
    messages: [
      { ...message("c-main", 1, "sender-c"), createdAt: 1 },
      { ...message("c-other", 1, "sender-c"), createdAt: 2 },
      { ...message("c-main", 2, "sender-c"), createdAt: 3 },
      { ...message("c-other", 2, "sender-c"), createdAt: 4 },
      { ...message("c-main", 3, "sender-c"), createdAt: 5 },
      { ...message("t-main-1", 4, "sender-c"), createdAt: 6 },
      { ...message("c-main", 4, "sender-c"), createdAt: 7 },
    ],
    channelMemberUserIds: membership,
    lastReadSeqByChannel: { "c-main": 2, "c-other": 0, "t-main-1": 0 },
    threadFollows: [threadFollow],
    muteFromSeqByChannel: { "c-main": 3 },
    mentionFacts: [visibleMention(USER, "c-main", 4)],
  });
  assert.deepEqual(rowSummary(mentionedAfterMute), [
    {
      key: "channel:c-main",
      latestMessageId: "c-main-m4",
      firstUnreadMessageId: "c-main-m4",
      unreadCount: 1,
      hasMention: true,
    },
    {
      key: "thread:t-main-1",
      latestMessageId: "t-main-1-m4",
      firstUnreadMessageId: "t-main-1-m4",
      unreadCount: 1,
      hasMention: false,
    },
    {
      key: "channel:c-other",
      latestMessageId: "c-other-m2",
      firstUnreadMessageId: "c-other-m1",
      unreadCount: 2,
      hasMention: false,
    },
  ]);

  const threadMentionAfterMute = baseModel({
    channels,
    messages: [
      { ...message("c-main", 1, "sender-c"), createdAt: 1 },
      { ...message("c-other", 1, "sender-c"), createdAt: 2 },
      { ...message("c-main", 2, "sender-c"), createdAt: 3 },
      { ...message("c-other", 2, "sender-c"), createdAt: 4 },
      { ...message("c-main", 3, "sender-c"), createdAt: 5 },
      { ...message("t-main-1", 4, "sender-c"), createdAt: 6 },
    ],
    channelMemberUserIds: membership,
    lastReadSeqByChannel: { "c-main": 2, "c-other": 0, "t-main-1": 0 },
    threadFollows: [threadFollow],
    muteFromSeqByChannel: { "c-main": 3 },
    mentionFacts: [visibleMention(USER, "t-main-1", 4)],
  });
  assert.deepEqual(rowSummary(threadMentionAfterMute), [
    {
      key: "thread:t-main-1",
      latestMessageId: "t-main-1-m4",
      firstUnreadMessageId: "t-main-1-m4",
      unreadCount: 1,
      hasMention: true,
    },
    {
      key: "channel:c-other",
      latestMessageId: "c-other-m2",
      firstUnreadMessageId: "c-other-m1",
      unreadCount: 2,
      hasMention: false,
    },
    {
      key: "channel:c-main",
      latestMessageId: "c-main-m2",
      firstUnreadMessageId: null,
      unreadCount: 0,
      hasMention: false,
    },
  ]);
});

test("property: parent mute, thread subscription, and direct attention remain orthogonal", () => {
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.constantFrom<"ordinary" | "direct" | "broadcast">("ordinary", "direct", "broadcast"),
      (parentMuted, initiallyFollowed, attention) => {
        const directMention = attention === "direct";
        const activeAfterSend = initiallyFollowed || directMention;
        const mentionFacts = attention === "ordinary"
          ? []
          : [attention === "direct" ? visibleMention(USER, "t-main", 2) : broadcastMention(USER, "t-main", 2)];
        const model = baseModel({
          channels: [
            { id: "c-main", name: "main", type: "channel" },
            { id: "t-main", name: "thread", type: "thread", parentMessageId: "c-main-m1" },
          ],
          messages: [
            { ...message("c-main", 1, USER), createdAt: 1 },
            { ...message("c-main", 2), createdAt: 2 },
            { ...message("t-main", 2), createdAt: 3 },
          ],
          channelMemberUserIds: { "c-main": [USER, OTHER_USER] },
          lastReadSeqByChannel: { "c-main": 1, "t-main": 0 },
          threadFollows: [{
            threadChannelId: "t-main",
            followerType: "user",
            followerId: USER,
            unfollowed: !activeAfterSend,
          }],
          muteFromSeqByChannel: parentMuted ? { "c-main": 2 } : {},
          mentionFacts,
        });

        const rows = projectCurrentInboxPolicy(model, "all").rows;
        const root = rows.find((row) => row.kind === "channel" && row.sourceChannelId === "c-main");
        const thread = rows.find((row) => row.kind === "thread" && row.sourceChannelId === "t-main");

        assert.ok(root?.kind === "channel");
        assert.equal(
          root.latestMessageId,
          parentMuted ? "c-main-m1" : "c-main-m2",
          "parent mute only controls the root-channel message",
        );
        assert.equal(
          Boolean(thread),
          activeAfterSend,
          "active follow or a committed direct-mention transition controls future thread delivery",
        );
        if (thread?.kind === "thread") {
          assert.equal(thread.latestActivityMessageId, "t-main-m2");
          assert.equal(thread.hasMention, directMention);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("property: serving rows use notification facts with latest_notified_seq as Activity anchor", () => {
  type Receiver = typeof USER | typeof OTHER_USER | typeof AGENT;
  type Filter = "all" | "unread" | "mentions";
  type ServingEvent =
    | { kind: "message"; channelIndex: number; mentionTarget: "none" | Receiver; mentionKind: "personal" | "broadcast" }
    | { kind: "mute"; channelIndex: number; receiver: Receiver }
    | { kind: "read"; channelIndex: number; receiver: Receiver }
    | { kind: "check"; receiver: Receiver; filter: Filter };
  type MuteFact = {
    receiver: Receiver;
    channelId: string;
    mutedAtSeq: number;
  };

  const receivers = [USER, OTHER_USER, AGENT] as const;
  const eventArbitrary: fc.Arbitrary<ServingEvent> = fc.oneof(
    fc.record({
      kind: fc.constant("message" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      mentionTarget: fc.constantFrom<"none" | Receiver>("none", USER, OTHER_USER, AGENT),
      mentionKind: fc.constantFrom<"personal" | "broadcast">("personal", "broadcast"),
    }),
    fc.record({
      kind: fc.constant("mute" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      receiver: fc.constantFrom<Receiver>(...receivers),
    }),
    fc.record({
      kind: fc.constant("read" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      receiver: fc.constantFrom<Receiver>(...receivers),
    }),
    fc.record({
      kind: fc.constant("check" as const),
      receiver: fc.constantFrom<Receiver>(...receivers),
      filter: fc.constantFrom<Filter>("all", "unread", "mentions"),
    }),
  );

  fc.assert(
    fc.property(
      fc.array(eventArbitrary, { minLength: 1, maxLength: 16 }),
      (events) => {
        const channelIds = ["c-serving-0", "c-serving-1", "c-serving-2"];
        const seqByChannel = Object.fromEntries(channelIds.map((channelId) => [channelId, 0]));
        const readByReceiver: Record<Receiver, Record<string, number>> = {
          [USER]: {},
          [OTHER_USER]: {},
          [AGENT]: {},
        };
        const mutedTargets: Record<Receiver, Set<string>> = {
          [USER]: new Set(),
          [OTHER_USER]: new Set(),
          [AGENT]: new Set(),
        };
        const muteFacts: MuteFact[] = [];
        const notificationFacts: InboxPolicyNotificationFact[] = [];
        const stateMessages: InboxPolicyModel["messages"] = [];
        const stateMentions: InboxPolicyMentionFact[] = [];

        function receiverTypeFor(receiver: Receiver): "user" | "agent" {
          return receiver === AGENT ? "agent" : "user";
        }

        function modelFor(receiver: Receiver): InboxPolicyModel {
          return baseModel({
            userId: receiver === AGENT ? USER : receiver,
            receiverType: receiverTypeFor(receiver),
            receiverId: receiver,
            channels: channelIds.map((id, index) => ({ id, name: `serving-${index}`, type: "channel" as const })),
            messages: stateMessages,
            channelMemberUserIds: Object.fromEntries(channelIds.map((channelId) => [channelId, [USER, OTHER_USER]])),
            channelMemberAgentIds: Object.fromEntries(channelIds.map((channelId) => [channelId, [AGENT]])),
            lastReadSeqByChannel: readByReceiver[receiver],
            mentionFacts: stateMentions,
            muteFromSeqByChannel: Object.fromEntries(
              muteFacts
                .filter((fact) => fact.receiver === receiver)
                .map((fact) => [fact.channelId, fact.mutedAtSeq]),
            ),
          });
        }

        function assertServingMatchesProjection(receiver: Receiver, filter: Filter) {
          const projected = projectCurrentInboxPolicy(modelFor(receiver), filter);
          const expected = projectInboxServingRowsFromNotificationFacts({
            receiverType: receiverTypeFor(receiver),
            receiverId: receiver,
            facts: notificationFacts,
            lastReadSeqByChannel: readByReceiver[receiver],
            filter,
          }).map((row) => ({
            key: row.key,
            activityAt: row.activityAt,
            latestMessageId: row.latestMessageId,
            firstUnreadMessageId: row.firstUnreadMessageId,
            latestNotifiedSeq: row.latestNotifiedSeq,
            firstUnreadSeq: row.firstUnreadSeq,
            unreadCount: row.unreadCount,
            latestPersonalMentionSeq: row.latestPersonalMentionSeq,
            unreadMentionCount: row.unreadMentionCount,
            hasMention: row.hasMention,
            hasAnyMention: row.hasAnyMention,
          }));
          assert.deepEqual(
            projected.rows.map((row) => {
              const sourceChannelId = row.sourceChannelId;
              const readSeq = readByReceiver[receiver][sourceChannelId] ?? 0;
              const facts = notificationFacts.filter((fact) =>
                fact.receiverType === receiverTypeFor(receiver)
                  && fact.receiverId === receiver
                  && fact.sourceChannelId === sourceChannelId
              );
              const personalMentions = facts.filter((fact) => fact.personalMention);
              const unreadMentions = personalMentions.filter((fact) => fact.seq > readSeq);
              return {
                key: `${row.kind}:${sourceChannelId}`,
                activityAt: row.activityAt,
                latestMessageId: row.kind === "thread" ? row.latestActivityMessageId : row.latestMessageId,
                firstUnreadMessageId: row.firstUnreadMessageId,
                latestNotifiedSeq: Math.max(0, ...facts.map((fact) => fact.seq)),
                firstUnreadSeq: facts.find((fact) => fact.seq > readSeq)?.seq ?? null,
                unreadCount: row.unreadCount,
                latestPersonalMentionSeq: personalMentions[personalMentions.length - 1]?.seq ?? null,
                unreadMentionCount: unreadMentions.length,
                hasMention: row.hasMention,
                hasAnyMention: row.hasAnyMention,
              };
            }),
            expected,
          );
          assert.equal(projected.totalCount, expected.length);
          assert.equal(projected.totalUnreadCount, expected.reduce((sum, row) => sum + row.unreadCount, 0));
        }

        events.forEach((event, eventIndex) => {
          if (event.kind === "check") {
            assertServingMatchesProjection(event.receiver, event.filter);
            return;
          }

          const channelId = channelIds[event.channelIndex]!;
          if (event.kind === "mute") {
            if (!mutedTargets[event.receiver].has(channelId)) {
              mutedTargets[event.receiver].add(channelId);
              muteFacts.push({
                receiver: event.receiver,
                channelId,
                mutedAtSeq: (seqByChannel[channelId] ?? 0) + 1,
              });
            }
            return;
          }

          if (event.kind === "read") {
            readByReceiver[event.receiver][channelId] = seqByChannel[channelId] ?? 0;
            return;
          }

          const seq = (seqByChannel[channelId] ?? 0) + 1;
          seqByChannel[channelId] = seq;
          const messageId = `${channelId}-m${seq}`;
          stateMessages.push({
            id: messageId,
            channelId,
            seq,
            createdAt: eventIndex + 1,
            content: `serving message ${seq}`,
            senderType: "user",
            senderId: "sender-c",
          });
          if (event.mentionTarget !== "none") {
            stateMentions.push({
              messageId,
              messageSeq: seq,
              channelId,
              targetType: receiverTypeFor(event.mentionTarget),
              targetId: event.mentionTarget,
              mentionKind: event.mentionKind,
              notifiableAtSend: true,
            });
          }

          for (const receiver of receivers) {
            const personalMention = event.mentionTarget === receiver && event.mentionKind === "personal";
            if (!mutedTargets[receiver].has(channelId) || personalMention) {
              notificationFacts.push({
                receiverType: receiverTypeFor(receiver),
                receiverId: receiver,
                kind: "channel",
                sourceChannelId: channelId,
                seq,
                messageId,
                activityAt: eventIndex + 1,
                personalMention,
              });
            }
          }
        });

        for (const receiver of receivers) {
          for (const filter of ["all", "unread", "mentions"] as const) {
            assertServingMatchesProjection(receiver, filter);
          }
        }
      },
    ),
    { numRuns: 300, seed: 77 },
  );
});

test("receiver mute/DND state for other users is sender-feedback invariant", () => {
  const baseline = baseModel({
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });
  const withOtherReceiverState = baseModel({
    lastReadSeqByChannel: { "c-general": 1 },
    mentionFacts: [visibleMention(USER, "c-general", 2)],
    doNotDisturbUserIds: [OTHER_USER],
  });

  assert.deepEqual(
    projectionSummary(projectCurrentInboxPolicy(withOtherReceiverState, "all")),
    projectionSummary(projectCurrentInboxPolicy(baseline, "all")),
  );
});

test("current model includes notified public non-member mentions as notification rows", () => {
  const model = baseModel({
    channelMemberUserIds: { "c-general": [OTHER_USER] },
    mentionFacts: [{ ...visibleMention(USER, "c-general", 2), notified: true }],
  });

  assert.equal(projectCurrentInboxPolicy(model, "all").rows.length, 1);
  assert.equal(projectCurrentInboxPolicy(model, "unread").rows.length, 0);

  const mentionsRows = projectCurrentInboxPolicy(model, "mentions").rows;
  assert.equal(mentionsRows.length, 1);
  assert.equal(mentionsRows[0]!.mentionOnly, true);
  assert.equal(mentionsRows[0]!.unreadCount, 0);
  assert.equal(mentionsRows[0]!.hasMention, true);
});

test("current model excludes parent-member unfollowed-thread mentions until notified_at is set", () => {
  const model = baseModel({
    channels: [
      { id: "c-general", name: "general", type: "channel" },
      { id: "t-general-1", name: "general thread", type: "thread", parentMessageId: "m-parent" },
    ],
    messages: [
      { ...message("c-general", 1, OTHER_USER), id: "m-parent" },
      message("t-general-1", 2, OTHER_USER),
    ],
    channelMemberUserIds: { "c-general": [USER, OTHER_USER] },
    threadFollows: [{
      threadChannelId: "t-general-1",
      followerType: "user",
      followerId: USER,
      unfollowed: true,
    }],
    mentionFacts: [{
      ...visibleMention(USER, "t-general-1", 2),
      notifiableAtSend: true,
      notified: false,
    }],
  });

  assert.equal(projectCurrentInboxPolicy(model, "all").rows.some((row) => row.kind === "thread"), false);
  assert.equal(projectCurrentInboxPolicy(model, "mentions").rows.some((row) => row.kind === "thread"), false);
  assert.equal(projectCurrentInboxPolicy(model, "unread").rows.some((row) => row.kind === "thread"), false);
});

test("receiver effects distinguish human and agent notification plus Inbox API filters", () => {
  const sharedSurface = {
    channels: [{ id: "c-general", name: "general", type: "channel" as const }],
    messages: [
      message("c-general", 1, OTHER_USER),
      message("c-general", 2, OTHER_USER),
    ],
    lastReadSeqByChannel: { "c-general": 1 },
  };
  const human = baseModel({
    ...sharedSurface,
    userId: USER,
    receiverType: "user",
    receiverId: USER,
    channelMemberUserIds: { "c-general": [USER] },
    mentionFacts: [],
  });
  const mutedHuman = baseModel({
    ...human,
    mutedChannelIds: ["c-general"],
  });
  const mutedMentionedHuman = baseModel({
    ...mutedHuman,
    mentionFacts: [visibleMention(USER, "c-general", 2)],
  });
  const agent = baseModel({
    ...sharedSurface,
    userId: USER,
    receiverType: "agent",
    receiverId: AGENT,
    channelMemberUserIds: { "c-general": [USER] },
    channelMemberAgentIds: { "c-general": [AGENT] },
    mentionFacts: [visibleAgentMention(AGENT, "c-general", 2)],
  });
  const publicNonMemberHumanMention = baseModel({
    ...sharedSurface,
    userId: USER,
    receiverType: "user",
    receiverId: USER,
    channelMemberUserIds: { "c-general": [OTHER_USER] },
    mentionFacts: [{ ...visibleMention(USER, "c-general", 2), notified: true }],
  });

  assert.deepEqual(receiverEffectSummary(human), [
    {
      key: "channel:c-general",
      inAll: true,
      inUnread: true,
      inMentions: false,
      unreadCount: 1,
      hasMention: false,
      mentionOnly: false,
      notification: "unread",
    },
  ]);
  assert.deepEqual(receiverEffectSummary(mutedHuman), []);
  assert.deepEqual(receiverEffectSummary(mutedMentionedHuman), [
    {
      key: "channel:c-general",
      inAll: true,
      inUnread: true,
      inMentions: true,
      unreadCount: 1,
      hasMention: true,
      mentionOnly: false,
      notification: "personal_mention",
    },
  ]);
  assert.deepEqual(receiverEffectSummary(agent), [
    {
      key: "channel:c-general",
      inAll: true,
      inUnread: true,
      inMentions: true,
      unreadCount: 1,
      hasMention: true,
      mentionOnly: false,
      notification: "personal_mention",
    },
  ]);
  assert.deepEqual(receiverEffectSummary(publicNonMemberHumanMention), [
    {
      key: "channel:c-general",
      inAll: true,
      inUnread: false,
      inMentions: true,
      unreadCount: 0,
      hasMention: true,
      mentionOnly: true,
      notification: "personal_mention",
    },
  ]);
});

test("property: receiver effects pin visible notification and Inbox filter outputs", () => {
  fc.assert(
    fc.property(
      fc.record({
        receiverType: fc.constantFrom<"user" | "agent">("user", "agent"),
        member: fc.boolean(),
        mentioned: fc.boolean(),
        muted: fc.boolean(),
        read: fc.boolean(),
      }),
      ({ receiverType, member, mentioned, muted, read }) => {
        const receiverId = receiverType === "agent" ? AGENT : USER;
        const mentionFact = receiverType === "agent"
          ? visibleAgentMention(receiverId, "c-general", 2)
          : visibleMention(receiverId, "c-general", 2);
        const model = baseModel({
          receiverType,
          receiverId,
          messages: [
            message("c-general", 1, OTHER_USER),
            message("c-general", 2, OTHER_USER),
          ],
          channelMemberUserIds: { "c-general": receiverType === "user" && member ? [receiverId] : [OTHER_USER] },
          channelMemberAgentIds: { "c-general": receiverType === "agent" && member ? [receiverId] : [] },
          lastReadSeqByChannel: read ? { "c-general": 2 } : { "c-general": 1 },
          mentionFacts: mentioned ? [{ ...mentionFact, notified: true }] : [],
          mutedChannelIds: muted ? ["c-general"] : [],
        });

        const effects = projectInboxReceiverEffects(model).rows;
        const effect = effects[0];
        const notificationVisible = member ? (!muted || mentioned) : mentioned;
        const unread = notificationVisible && !read;
        const expectedNotification: InboxPolicyNotificationClass = mentioned && (!member || !read)
          ? "personal_mention"
          : unread && !muted
            ? "unread"
            : "none";

        if (!notificationVisible) {
          assert.deepEqual(effects, []);
          return;
        }

        assert.ok(effect);
        assert.equal(effect.inAll, true);
        assert.equal(effect.inUnread, unread && !effect.mentionOnly);
        assert.equal(effect.inMentions, mentioned);
        assert.equal(effect.mentionOnly, !member && mentioned);
        assert.equal(effect.unreadCount, unread && !effect.mentionOnly ? 1 : 0);
        assert.equal(effect.hasMention, mentioned && (!member || !read));
        assert.equal(effect.notification, expectedNotification);
      },
    ),
    { numRuns: 300, seed: 74 },
  );
});

test("property: inbox order and pagination respect mid-conversation mute boundaries", () => {
  fc.assert(
    fc.property(
      fc.record({
        filter: fc.constantFrom<"all" | "unread" | "mentions">("all", "unread", "mentions"),
        offset: fc.integer({ min: 0, max: 5 }),
        limit: fc.integer({ min: 1, max: 5 }),
        channels: fc.array(
          fc.record({
            activityAt: fc.integer({ min: 1, max: 4 }),
            lastReadSeq: fc.integer({ min: 0, max: 3 }),
            // 0 means unmuted. 1..4 means mute starts inclusively at that seq.
            muteFromSeq: fc.integer({ min: 0, max: 4 }),
            // 0 means no personal mention. 1..3 targets that message seq.
            mentionSeq: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
      }),
      ({ filter, offset, limit, channels: channelSpecs }) => {
        const policyChannels = channelSpecs.map((_, index) => ({
          id: `c-order-${index}`,
          name: `order-${index}`,
          type: "channel" as const,
        }));
        const policyMessages = channelSpecs.flatMap((spec, index) => {
          const channelId = `c-order-${index}`;
          return [1, 2, 3].map((seq) => ({
            ...message(channelId, seq, OTHER_USER),
            createdAt: spec.activityAt,
          }));
        });
        const muteFromSeqByChannel = Object.fromEntries(
          channelSpecs
            .map((spec, index) => [index, spec.muteFromSeq] as const)
            .filter(([, muteFromSeq]) => muteFromSeq > 0)
            .map(([index, muteFromSeq]) => [`c-order-${index}`, muteFromSeq]),
        );
        const mentionFacts = channelSpecs.flatMap((spec, index) =>
          spec.mentionSeq > 0 ? [visibleMention(USER, `c-order-${index}`, spec.mentionSeq)] : []
        );
        const model = baseModel({
          channels: policyChannels,
          messages: policyMessages,
          channelMemberUserIds: Object.fromEntries(policyChannels.map((channel) => [channel.id, [USER, OTHER_USER]])),
          lastReadSeqByChannel: Object.fromEntries(
            channelSpecs.map((spec, index) => [`c-order-${index}`, spec.lastReadSeq]),
          ),
          mentionFacts,
          muteFromSeqByChannel,
        });

        const expectedAllRows = channelSpecs.flatMap((spec, index) => {
          const channelId = `c-order-${index}`;
          const includedSeqs = [1, 2, 3].filter((seq) =>
            spec.muteFromSeq === 0 || seq < spec.muteFromSeq || seq === spec.mentionSeq
          );
          const latestSeq = includedSeqs[includedSeqs.length - 1];
          if (latestSeq == null) return [];
          const unreadSeqs = includedSeqs.filter((seq) => seq > spec.lastReadSeq);
          const mentionTargetsReceiver = spec.mentionSeq > 0;
          return [{
            key: `channel:${channelId}`,
            channelId,
            activityAt: spec.activityAt,
            latestMessageId: `${channelId}-m${latestSeq}`,
            firstUnreadMessageId: unreadSeqs[0] == null ? null : `${channelId}-m${unreadSeqs[0]}`,
            unreadCount: unreadSeqs.length,
            hasMention: mentionTargetsReceiver && spec.mentionSeq > spec.lastReadSeq,
            hasAnyMention: mentionTargetsReceiver,
          }];
        });
        const expectedFilteredRows = expectedAllRows
          .filter((row) => {
            if (filter === "all") return true;
            if (filter === "unread") return row.unreadCount > 0;
            return row.hasAnyMention;
          })
          .sort((a, b) => b.activityAt - a.activityAt || a.key.localeCompare(b.key));

        const projected = projectCurrentInboxPolicy(model, filter);
        assert.deepEqual(
          projected.rows.map((row) => ({
            key: `${row.kind}:${row.sourceChannelId}`,
            channelId: row.sourceChannelId,
            activityAt: row.activityAt,
            latestMessageId: row.kind === "thread" ? row.latestActivityMessageId : row.latestMessageId,
            firstUnreadMessageId: row.firstUnreadMessageId,
            unreadCount: row.unreadCount,
            hasMention: row.hasMention,
            hasAnyMention: row.hasAnyMention,
          })),
          expectedFilteredRows,
        );
        assert.equal(projected.totalCount, expectedFilteredRows.length);
        assert.equal(
          projected.totalUnreadCount,
          expectedFilteredRows.reduce((sum, row) => sum + row.unreadCount, 0),
        );

        const candidateRows = expectedAllRows.map((row) => ({
          kind: "channel",
          channelId: row.channelId,
          activityAt: row.activityAt,
          unreadCount: row.unreadCount,
          hasAnyMention: row.hasAnyMention,
          mentionOnly: false,
        }));
        const paged = applyInboxPolicyFilterPageRows(candidateRows, { filter, offset, limit });
        const expectedPage = expectedFilteredRows.slice(offset, offset + limit);
        assert.deepEqual(
          paged.rows.map((row) => `channel:${row.channelId}`),
          expectedPage.map((row) => row.key),
        );
        assert.equal(paged.hasMore, offset + limit < expectedFilteredRows.length);
        assert.equal(paged.totalCount, expectedFilteredRows.length);
        assert.equal(
          paged.totalUnreadCount,
          expectedFilteredRows.reduce((sum, row) => sum + row.unreadCount, 0),
        );
      },
    ),
    { numRuns: 300, seed: 75 },
  );
});

test("trace: Inbox event path pins receiver-specific state transitions", () => {
  type Receiver = typeof USER | typeof AGENT;
  type Filter = "all" | "unread" | "mentions";
  const channelId = "c-trace";
  let seq = 0;
  const stateMessages: InboxPolicyModel["messages"] = [];
  const stateMentions: InboxPolicyMentionFact[] = [];
  const readByReceiver: Record<Receiver, Record<string, number>> = {
    [USER]: {},
    [AGENT]: {},
  };
  const muteByReceiver: Record<Receiver, Record<string, number>> = {
    [USER]: {},
    [AGENT]: {},
  };

  function receiverTypeFor(receiver: Receiver): "user" | "agent" {
    return receiver === AGENT ? "agent" : "user";
  }

  function modelFor(receiver: Receiver): InboxPolicyModel {
    return baseModel({
      userId: receiver === AGENT ? USER : receiver,
      receiverType: receiverTypeFor(receiver),
      receiverId: receiver,
      channels: [{ id: channelId, name: "trace", type: "channel" }],
      messages: stateMessages,
      channelMemberUserIds: { [channelId]: [USER] },
      channelMemberAgentIds: { [channelId]: [AGENT] },
      lastReadSeqByChannel: readByReceiver[receiver],
      mentionFacts: stateMentions,
      muteFromSeqByChannel: muteByReceiver[receiver],
    });
  }

  function appendMessage(mentionTarget: "none" | Receiver = "none") {
    seq += 1;
    const id = `${channelId}-m${seq}`;
    stateMessages.push({
      id,
      channelId,
      seq,
      createdAt: seq,
      content: `trace message ${seq}`,
      senderType: "user",
      senderId: OTHER_USER,
    });
    if (mentionTarget !== "none") {
      stateMentions.push({
        messageId: id,
        messageSeq: seq,
        channelId,
        targetType: receiverTypeFor(mentionTarget),
        targetId: mentionTarget,
        notifiableAtSend: true,
      });
    }
  }

  function view(receiver: Receiver, filter: Filter) {
    const projection = projectCurrentInboxPolicy(modelFor(receiver), filter);
    return {
      totalCount: projection.totalCount,
      totalUnreadCount: projection.totalUnreadCount,
      rows: projection.rows.map((row) => ({
        key: `${row.kind}:${row.sourceChannelId}`,
        latestMessageId: row.kind === "thread" ? row.latestActivityMessageId : row.latestMessageId,
        firstUnreadMessageId: row.firstUnreadMessageId,
        unreadCount: row.unreadCount,
        hasMention: row.hasMention,
        hasAnyMention: row.hasAnyMention,
      })),
    };
  }

  const trace: Array<{ event: string; view: ReturnType<typeof view> }> = [];
  function check(event: string, receiver: Receiver, filter: Filter) {
    trace.push({ event, view: view(receiver, filter) });
  }

  appendMessage();
  check("user checks all after first ordinary message", USER, "all");

  muteByReceiver[USER][channelId] = seq + 1;
  appendMessage();
  check("user checks all after receiver-local mute suppresses ordinary message", USER, "all");
  check("agent checks all and still sees post-mute ordinary message", AGENT, "all");

  appendMessage(USER);
  check("user checks mentions after personal mention pierces mute", USER, "mentions");

  readByReceiver[USER][channelId] = seq;
  check("user checks all after read cursor advances", USER, "all");

  assert.deepEqual(trace, [
    {
      event: "user checks all after first ordinary message",
      view: {
        totalCount: 1,
        totalUnreadCount: 1,
        rows: [{
          key: "channel:c-trace",
          latestMessageId: "c-trace-m1",
          firstUnreadMessageId: "c-trace-m1",
          unreadCount: 1,
          hasMention: false,
          hasAnyMention: false,
        }],
      },
    },
    {
      event: "user checks all after receiver-local mute suppresses ordinary message",
      view: {
        totalCount: 1,
        totalUnreadCount: 1,
        rows: [{
          key: "channel:c-trace",
          latestMessageId: "c-trace-m1",
          firstUnreadMessageId: "c-trace-m1",
          unreadCount: 1,
          hasMention: false,
          hasAnyMention: false,
        }],
      },
    },
    {
      event: "agent checks all and still sees post-mute ordinary message",
      view: {
        totalCount: 1,
        totalUnreadCount: 2,
        rows: [{
          key: "channel:c-trace",
          latestMessageId: "c-trace-m2",
          firstUnreadMessageId: "c-trace-m1",
          unreadCount: 2,
          hasMention: false,
          hasAnyMention: false,
        }],
      },
    },
    {
      event: "user checks mentions after personal mention pierces mute",
      view: {
        totalCount: 1,
        totalUnreadCount: 2,
        rows: [{
          key: "channel:c-trace",
          latestMessageId: "c-trace-m3",
          firstUnreadMessageId: "c-trace-m1",
          unreadCount: 2,
          hasMention: true,
          hasAnyMention: true,
        }],
      },
    },
    {
      event: "user checks all after read cursor advances",
      view: {
        totalCount: 1,
        totalUnreadCount: 0,
        rows: [{
          key: "channel:c-trace",
          latestMessageId: "c-trace-m3",
          firstUnreadMessageId: null,
          unreadCount: 0,
          hasMention: false,
          hasAnyMention: true,
        }],
      },
    },
  ]);
});

test("property: Inbox view checks observe the event-state-machine projection", () => {
  type Receiver = typeof USER | typeof OTHER_USER | typeof AGENT;
  type Filter = "all" | "unread" | "mentions";
  // This is the product-level contract shape:
  // events mutate one global message/read/mute state, while `check` events are
  // observation points that must match the receiver-specific Inbox projection.
  type MachineEvent =
    | { kind: "message"; channelIndex: number; mentionTarget: "none" | Receiver; mentionKind: "personal" | "broadcast" }
    | { kind: "mute"; channelIndex: number; receiver: Receiver }
    | { kind: "read"; channelIndex: number; receiver: Receiver }
    | { kind: "check"; receiver: Receiver; filter: Filter };
  const eventArbitrary: fc.Arbitrary<MachineEvent> = fc.oneof(
    fc.record({
      kind: fc.constant("message" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      mentionTarget: fc.constantFrom<"none" | Receiver>("none", USER, OTHER_USER, AGENT),
      mentionKind: fc.constantFrom<"personal" | "broadcast">("personal", "broadcast"),
    }),
    fc.record({
      kind: fc.constant("mute" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      receiver: fc.constantFrom<Receiver>(USER, OTHER_USER, AGENT),
    }),
    fc.record({
      kind: fc.constant("read" as const),
      channelIndex: fc.integer({ min: 0, max: 2 }),
      receiver: fc.constantFrom<Receiver>(USER, OTHER_USER, AGENT),
    }),
    fc.record({
      kind: fc.constant("check" as const),
      receiver: fc.constantFrom<Receiver>(USER, OTHER_USER, AGENT),
      filter: fc.constantFrom<Filter>("all", "unread", "mentions"),
    }),
  );

  fc.assert(
    fc.property(
      fc.array(eventArbitrary, { minLength: 1, maxLength: 16 }),
      (events) => {
        const channelIds = ["c-machine-0", "c-machine-1", "c-machine-2"];
        const seqByChannel = Object.fromEntries(channelIds.map((channelId) => [channelId, 0]));
        const readByReceiver: Record<Receiver, Record<string, number>> = {
          [USER]: {},
          [OTHER_USER]: {},
          [AGENT]: {},
        };
        const muteByReceiver: Record<Receiver, Record<string, number>> = {
          [USER]: {},
          [OTHER_USER]: {},
          [AGENT]: {},
        };
        const stateMessages: InboxPolicyModel["messages"] = [];
        const stateMentions: InboxPolicyMentionFact[] = [];

        function receiverTypeFor(receiver: Receiver): "user" | "agent" {
          return receiver === AGENT ? "agent" : "user";
        }

        function modelFor(receiver: Receiver): InboxPolicyModel {
          return baseModel({
            userId: receiver === AGENT ? USER : receiver,
            receiverType: receiverTypeFor(receiver),
            receiverId: receiver,
            channels: channelIds.map((id, index) => ({ id, name: `machine-${index}`, type: "channel" as const })),
            messages: stateMessages,
            channelMemberUserIds: Object.fromEntries(channelIds.map((channelId) => [channelId, [USER, OTHER_USER]])),
            channelMemberAgentIds: Object.fromEntries(channelIds.map((channelId) => [channelId, [AGENT]])),
            lastReadSeqByChannel: readByReceiver[receiver],
            mentionFacts: stateMentions,
            muteFromSeqByChannel: muteByReceiver[receiver],
          });
        }

        function expectedRows(receiver: Receiver, filter: Filter) {
          // First-principles oracle: Activity is receiver notification-fact
          // history. A receiver's mute boundary only suppresses ordinary facts
          // at/after that receiver/channel boundary; personal mentions remain
          // visible to that receiver and do not affect other receivers.
          const rows = channelIds.flatMap((channelId) => {
            const messagesForChannel = stateMessages.filter((msg) => msg.channelId === channelId);
            const visibleMentionSeqs = new Set(
              stateMentions
                .filter((mention) =>
                  mention.channelId === channelId
                    && mention.targetType === receiverTypeFor(receiver)
                    && mention.targetId === receiver
                    && (mention.mentionKind ?? "personal") === "personal"
                )
                .map((mention) => mention.messageSeq),
            );
            const muteFromSeq = muteByReceiver[receiver][channelId];
            const included = messagesForChannel.filter((msg) =>
              muteFromSeq == null || msg.seq < muteFromSeq || visibleMentionSeqs.has(msg.seq)
            );
            const latest = included[included.length - 1];
            if (!latest) return [];

            const readSeq = readByReceiver[receiver][channelId] ?? 0;
            const unread = included.filter((msg) => msg.seq > readSeq);
            return [{
              key: `channel:${channelId}`,
              activityAt: latest.createdAt,
              latestMessageId: latest.id,
              firstUnreadMessageId: unread[0]?.id ?? null,
              unreadCount: unread.length,
              hasMention: [...visibleMentionSeqs].some((seq) => seq > readSeq),
              hasAnyMention: visibleMentionSeqs.size > 0,
            }];
          });

          return rows
            .filter((row) => {
              if (filter === "all") return true;
              if (filter === "unread") return row.unreadCount > 0;
              return row.hasAnyMention;
            })
            .sort((a, b) => b.activityAt - a.activityAt || a.key.localeCompare(b.key));
        }

        function assertView(receiver: Receiver, filter: Filter) {
          // A human/agent checking a target Inbox is modeled as an event, not
          // just a final assertion, so intermediate views are pinned too.
          const projected = projectCurrentInboxPolicy(modelFor(receiver), filter);
          const expected = expectedRows(receiver, filter);
          assert.deepEqual(
            projected.rows.map((row) => ({
              key: `${row.kind}:${row.sourceChannelId}`,
              activityAt: row.activityAt,
              latestMessageId: row.kind === "thread" ? row.latestActivityMessageId : row.latestMessageId,
              firstUnreadMessageId: row.firstUnreadMessageId,
              unreadCount: row.unreadCount,
              hasMention: row.hasMention,
              hasAnyMention: row.hasAnyMention,
            })),
            expected,
          );
          assert.equal(projected.totalCount, expected.length);
          assert.equal(projected.totalUnreadCount, expected.reduce((sum, row) => sum + row.unreadCount, 0));
        }

        events.forEach((event, eventIndex) => {
          if (event.kind === "check") {
            assertView(event.receiver, event.filter);
            return;
          }

          const channelId = channelIds[event.channelIndex]!;
          if (event.kind === "message") {
            const seq = (seqByChannel[channelId] ?? 0) + 1;
            seqByChannel[channelId] = seq;
            const id = `${channelId}-m${seq}`;
            stateMessages.push({
              id,
              channelId,
              seq,
              createdAt: eventIndex + 1,
              content: `machine message ${seq}`,
              senderType: "user",
              senderId: "sender-c",
            });
            if (event.mentionTarget !== "none") {
              stateMentions.push({
                messageId: id,
                messageSeq: seq,
                channelId,
                targetType: receiverTypeFor(event.mentionTarget),
                targetId: event.mentionTarget,
                mentionKind: event.mentionKind,
                notifiableAtSend: true,
              });
            }
            return;
          }

          if (event.kind === "mute") {
            muteByReceiver[event.receiver][channelId] ??= (seqByChannel[channelId] ?? 0) + 1;
            return;
          }

          readByReceiver[event.receiver][channelId] = seqByChannel[channelId] ?? 0;
        });

        for (const receiver of [USER, OTHER_USER, AGENT] as const) {
          for (const filter of ["all", "unread", "mentions"] as const) {
            assertView(receiver, filter);
          }
        }
      },
    ),
    { numRuns: 300, seed: 76 },
  );
});

test("property: personal mention attention is recipient-specific A11", () => {
  fc.assert(
    fc.property(
      fc.record({
        mentionedUser: fc.boolean(),
        mentionedOtherUser: fc.boolean(),
        mentionedAgent: fc.boolean(),
        visible: fc.boolean(),
        readSeq: fc.integer({ min: 0, max: 3 }),
        mentionSeq: fc.integer({ min: 1, max: 3 }),
      }),
      ({ mentionedUser, mentionedOtherUser, mentionedAgent, visible, readSeq, mentionSeq }) => {
        const facts: InboxPolicyMentionFact[] = [];
        if (mentionedUser) facts.push({ ...visibleMention(USER, "c-general", mentionSeq), notifiableAtSend: visible });
        if (mentionedOtherUser) facts.push({ ...visibleMention(OTHER_USER, "c-general", mentionSeq), notifiableAtSend: true });
        if (mentionedAgent) {
          facts.push({
            messageId: `c-general-m${mentionSeq}`,
            messageSeq: mentionSeq,
            channelId: "c-general",
            targetType: "agent",
            targetId: AGENT,
            notifiableAtSend: true,
          });
        }

        const model = baseModel({
          lastReadSeqByChannel: { "c-general": readSeq },
          mentionFacts: facts,
        });
        const row = projectCurrentInboxPolicy(model, "all").rows.find((item) => item.sourceChannelId === "c-general");
        const expected = mentionedUser && visible && mentionSeq > readSeq;

        assert.equal(row?.hasMention ?? false, expected);
      },
    ),
    { numRuns: 250, seed: 72 },
  );
});

test("property: advancing read cursor cannot increase current unread projection", () => {
  fc.assert(
    fc.property(
      fc.record({
        messageCount: fc.integer({ min: 1, max: 12 }),
        selfSent: fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 12 }),
        mentionSeqs: fc.uniqueArray(fc.integer({ min: 1, max: 12 }), { maxLength: 12 }),
        readA: fc.integer({ min: 0, max: 12 }),
        readB: fc.integer({ min: 0, max: 12 }),
      }),
      ({ messageCount, selfSent, mentionSeqs, readA, readB }) => {
        const lowerRead = Math.min(readA, readB);
        const higherRead = Math.max(readA, readB);
        const selfSentSet = new Set(selfSent);
        const messages = Array.from({ length: messageCount }, (_, index) => {
          const seq = index + 1;
          return message("c-general", seq, selfSentSet.has(seq) ? USER : OTHER_USER);
        });
        const mentionFacts = mentionSeqs
          .filter((seq) => seq <= messageCount)
          .map((seq) => visibleMention(USER, "c-general", seq));

        const low = projectCurrentInboxPolicy(baseModel({
          messages,
          mentionFacts,
          lastReadSeqByChannel: { "c-general": lowerRead },
        }), "all").rows[0]!;
        const high = projectCurrentInboxPolicy(baseModel({
          messages,
          mentionFacts,
          lastReadSeqByChannel: { "c-general": higherRead },
        }), "all").rows[0]!;

        assert.ok(high.unreadCount <= low.unreadCount);
        if (high.hasMention) assert.equal(low.hasMention, true);
        if (high.firstUnreadMessageId) assert.ok(low.firstUnreadMessageId);
      },
    ),
    { numRuns: 250, seed: 73 },
  );
});
