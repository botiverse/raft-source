import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { servers, users, agents, channels, channelHumans, channelAgents, serverMembers, messages, messageMentions, mentionDeliveryOccurrences, threadFollows, inboxNotificationFacts, inboxServingRows } from "../db/schema.js";
import {
  broadcastAndDeliver,
  drainSenderReadReceiptsForTests,
  getSenderPendingMentionActions,
  getSenderUnresolvedMentionHandles,
  getSenderReadReceiptInFlightCountForTests,
  listMessages,
  MentionValidationError,
  __setMessageServiceDepsForTests,
  __resetMessageServiceDepsForTests,
} from "./messageService.js";
import { getInboxItems, markRead } from "./channelService.js";
import { eq, and } from "drizzle-orm";


let previousFixtureDb: ReturnType<typeof getDb> | null = null;

afterEach(async () => {
  __resetMessageServiceDepsForTests();
  await drainSenderReadReceiptsForTests();
  assert.equal(getSenderReadReceiptInFlightCountForTests(), 0, "sender read receipts must quiesce before DB close");
  const fixtureDb = getDb();
  if (previousFixtureDb) {
    assert.notEqual(fixtureDb, previousFixtureDb, "each fixture must use a fresh DB identity");
  }
  previousFixtureDb = fixtureDb;
  await closeTestDatabase();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as any;
}

const noopOrchestrator = { deliverMessage: async () => undefined } as any;

async function seedPublicChannel() {
  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();

  const [user2] = await db.insert(users).values({
    email: "bob@test.com", name: "Bob", passwordHash: "x", emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "test", ownerId: user.id,
  }).returning();

  await db.insert(serverMembers).values([
    { serverId: server.id, userId: user.id, role: "owner" },
    { serverId: server.id, userId: user2.id, role: "member" },
  ]);

  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "TestBot", status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc",
  }).returning();
// PLACEHOLDER_SEED_CONTINUE

  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();

  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: user.id },
    { channelId: channel.id, userId: user2.id },
  ]);

  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });

  return { db, user, user2, server, agent, channel };
}

async function seedPrivateChannel() {
  const { db, user, user2, server, agent, channel: publicChannel } = await seedPublicChannel();

  // user3 is a server member but NOT in the private channel
  const [user3] = await db.insert(users).values({
    email: "carol@test.com", name: "Carol", passwordHash: "x", emailVerified: true,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: user3.id, role: "member" });

  const [privateChannel] = await db.insert(channels).values({
    serverId: server.id, name: "secret", type: "private",
  }).returning();

  // Only user and user2 are in the private channel
  await db.insert(channelHumans).values([
    { channelId: privateChannel.id, userId: user.id },
    { channelId: privateChannel.id, userId: user2.id },
  ]);

  return { db, user, user2, user3, server, agent, publicChannel, privateChannel };
}

async function seedAmbiguousMentionChannel() {
  const db = getDb();
  const [sender] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [sameHandleHuman] = await db.insert(users).values({
    email: "applepi@test.com", name: "applepi", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "ambiguous-mention", ownerId: sender.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: sender.id, role: "owner" },
    { serverId: server.id, userId: sameHandleHuman.id, role: "member" },
  ]);
  const [sameHandleAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "applepi",
    status: "active",
    model: "sonnet",
    runtime: "claude",
    executionMode: "byoc",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: sender.id },
    { channelId: channel.id, userId: sameHandleHuman.id },
  ]);
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: sameHandleAgent.id });
  return { db, sender, sameHandleHuman, sameHandleAgent, server, channel };
}

function setupDepsForIntegration(serverId: string) {
  // We need to override deps that don't use getDb() or that need special handling.
  // writeMentionFacts uses getDb() directly, so it will use PGlite.
  // But broadcastAndDeliver also calls deps.getChannel, getChannelAgents, etc.
  // For integration tests, we use the real implementations by NOT overriding them.
  // However, we need to stub io-related and push-related deps.
  __setMessageServiceDepsForTests({
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
    buildPushTargets: async () => new Map(),
    sendPushNotifications: async () => undefined,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("mention write: resolves user and agent @handles in public channel (server-wide scope)", async ({ db: database }) => {

  const { db, user, user2, agent, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Bob and @TestBot check this out",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 2);

  const userMention = rows.find((r) => r.targetType === "user");
  const agentMention = rows.find((r) => r.targetType === "agent");

  assert.ok(userMention);
  assert.equal(userMention.targetId, user2.id);
  assert.equal(userMention.handleAtSendTime, "Bob"); // raw case preserved
  assert.equal(userMention.source, "send_path");
  assert.equal(userMention.confidence, "exact");

  assert.ok(agentMention);
  assert.equal(agentMention.targetId, agent.id);
  assert.equal(agentMention.handleAtSendTime, "TestBot"); // raw case preserved

  const occurrenceRows = await db.select().from(mentionDeliveryOccurrences);
  assert.equal(occurrenceRows.length, 1, "target-visible agent mention must create its durable occurrence before delivery");
  assert.equal(occurrenceRows[0]?.occurrenceId, agentMention.id);
  assert.equal(occurrenceRows[0]?.messageId, agentMention.messageId);
  assert.equal(occurrenceRows[0]?.agentId, agent.id);
  assert.equal(occurrenceRows[0]?.state, "recorded");
});

test("mention write: Slock Ref user targets mention in angle and named-link forms outside code", async ({ db: database }) => {

  const { db, user, user2, agent, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "angle <@Bob> named [same](<@Bob>) escaped \\<@Nope> code `@TestBot` ```txt\n@TestBot\n```",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    rows.map((row) => row.handleAtSendTime).sort(),
    ["Bob"],
  );
  assert.equal(rows.find((row) => row.handleAtSendTime === "Bob")?.targetId, user2.id);
  assert.equal(rows.some((row) => row.targetId === agent.id), false, "code-wrapped names are literal references, not recipients");
});

test("mention write: stores message_seq from the created message", async ({ db: database }) => {

  const { db, user, user2, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const enriched = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "ping @Bob",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].messageSeq, enriched.seq);
});
// PLACEHOLDER_TESTS_CONTINUE

test("mention write: private channel scopes resolution to channel members only", async ({ db: database }) => {

  const { db, user, user2, user3, privateChannel, server } = await seedPrivateChannel();
  setupDepsForIntegration(server.id);

  // user3 (Carol) is a server member but NOT in the private channel.
  // Mentioning @Carol should NOT produce a mention row.
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: privateChannel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Bob and @Carol",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, privateChannel.id));
  // Only Bob should be mentioned (he's in the private channel); Carol should not.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetId, user2.id);
  assert.equal(rows[0].handleAtSendTime, "Bob");
});

test("mention write: replay (duplicate agentSendKey) does not duplicate mention facts", async ({ db: database }) => {

  const { db, user2, agent, channel } = await seedPublicChannel();
  // Deliberately keep the real production deps here. Any test override selects
  // the legacy non-transactional persistence seam and would miss a nested DB
  // read/deadlock inside the winning agent-send transaction.

  const opts = {
    channelId: channel.id,
    senderType: "agent" as const,
    senderId: agent.id,
    senderName: "TestBot",
    content: "hello @Bob",
    agentSendKey: "idempotent-key-1",
  };

  // First send
  const first = await broadcastAndDeliver(createIo(), noopOrchestrator, opts);
  // Replay (same agentSendKey)
  const replay = await broadcastAndDeliver(createIo(), noopOrchestrator, opts);

  assert.equal(replay.id, first.id);

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  // Should have exactly 1 mention row, not 2
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetId, user2.id);
});

test("mention write: user randomId replay preserves winning mention facts after target rename", async ({ db: database }) => {

  const { db, user, user2, channel } = await seedPublicChannel();
  // Keep production deps so randomId persistence and mention/inbox facts share
  // the real executor-bound transaction.

  const winningRequest = {
    channelId: channel.id,
    senderType: "user" as const,
    senderId: user.id,
    senderName: "Alice",
    content: "hello @Bob",
    mentions: [{ type: "user" as const, id: user2.id, name: "Bob" }],
    randomId: "human-mention-replay-rename",
  };
  const first = await broadcastAndDeliver(createIo(), noopOrchestrator, winningRequest);
  const beforeReplay = {
    messages: (await db.select().from(messages)).length,
    mentions: (await db.select().from(messageMentions)).length,
    inboxFacts: (await db.select().from(inboxNotificationFacts)).length,
    inboxServingRows: (await db.select().from(inboxServingRows)).length,
  };

  await db.update(users).set({ name: "Robert" }).where(eq(users.id, user2.id));

  const replay = await broadcastAndDeliver(createIo(), noopOrchestrator, winningRequest);
  assert.equal(replay.id, first.id);
  assert.deepEqual({
    messages: (await db.select().from(messages)).length,
    mentions: (await db.select().from(messageMentions)).length,
    inboxFacts: (await db.select().from(inboxNotificationFacts)).length,
    inboxServingRows: (await db.select().from(inboxServingRows)).length,
  }, beforeReplay, "replay must not create new message, mention, or inbox facts");

  const [persistedMention] = await db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, first.id));
  assert.equal(persistedMention?.targetId, user2.id);
  assert.equal(persistedMention?.handleAtSendTime, "Bob");

  const fresh = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    ...winningRequest,
    randomId: "human-mention-fresh-after-rename",
  });
  assert.equal(fresh.content, winningRequest.content);
  assert.deepEqual(fresh.mentions, [], "stale structured identity degrades to plain text");
  assert.equal((await db.select().from(messages)).length, beforeReplay.messages + 1);
  assert.equal((await db.select().from(messageMentions)).length, beforeReplay.mentions);
  const freshFacts = (await db.select().from(inboxNotificationFacts))
    .filter((fact) => fact.messageId === fresh.id);
  assert.ok(freshFacts.length > 0, "fresh message still creates ordinary channel inbox facts");
  assert.equal(freshFacts.some((fact) => fact.personalMention), false, "stale identity creates no personal mention fact");
  assert.ok((await db.select().from(inboxServingRows)).length >= beforeReplay.inboxServingRows);
});

test("mention write: unmatched handle case does not resolve a target", async ({ db: database }) => {

  const { db, user, user2, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @BOB are you there?",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 0);
  assert.equal(getSenderPendingMentionActions(sent).length, 0);
  assert.notEqual(user2.name, "BOB");
});

test("mention write: no rows written when no @handles match any member", async ({ db: database }) => {

  const { db, user, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @nonexistent_user check this",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 0);
});

test("mention write: DM scopes resolution to DM participants only", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user2] = await db.insert(users).values({
    email: "bob@test.com", name: "Bob", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user3] = await db.insert(users).values({
    email: "carol@test.com", name: "Carol", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "test", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: user.id, role: "owner" },
    { serverId: server.id, userId: user2.id, role: "member" },
    { serverId: server.id, userId: user3.id, role: "member" },
  ]);
  // DM channel with only Alice and Bob
  const [dmChannel] = await db.insert(channels).values({
    serverId: server.id, name: "dm-alice-bob", type: "dm",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: dmChannel.id, userId: user.id },
    { channelId: dmChannel.id, userId: user2.id },
  ]);

  setupDepsForIntegration(server.id);

  // Mention @Carol who is a server member but NOT in this DM
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: dmChannel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Carol and @Bob",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, dmChannel.id));
  assert.equal(rows.length, 2);
  const bobMention = rows.find((row) => row.targetId === user2.id);
  const carolMention = rows.find((row) => row.targetId === user3.id);
  assert.ok(bobMention, "DM participant should be resolved");
  assert.equal(bobMention.handleAtSendTime, "Bob");
  assert.equal(bobMention.notifiableAtSend, true);
  assert.ok(carolMention, "same-server DM outsider should be recorded as an inert mention fact");
  assert.equal(carolMention.handleAtSendTime, "Carol");
  assert.equal(carolMention.notifiableAtSend, false);
});

test("mention write: thread resolves via parent public channel (server-wide scope)", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user2] = await db.insert(users).values({
    email: "bob@test.com", name: "Bob", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user3] = await db.insert(users).values({
    email: "carol@test.com", name: "Carol", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "test", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: user.id, role: "owner" },
    { serverId: server.id, userId: user2.id, role: "member" },
    { serverId: server.id, userId: user3.id, role: "member" },
  ]);
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: parentChannel.id, userId: user.id },
    { channelId: parentChannel.id, userId: user2.id },
  ]);
  // Create a parent message for the thread
  const [parentMsg] = await db.insert(messages).values({
    channelId: parentChannel.id, senderType: "user", senderId: user.id,
    content: "parent message", messageType: "chat", searchText: "parent message",
  }).returning();
  // Thread channel
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id, name: `thread-${parentMsg.id.slice(0, 8)}`, type: "thread",
    parentMessageId: parentMsg.id,
  }).returning();
  // Only Alice is in the thread channel (as a follower)
  await db.insert(channelHumans).values({ channelId: threadChannel.id, userId: user.id });

  setupDepsForIntegration(server.id);

  // Mention @Carol in thread — parent is public channel, so server-wide scope applies.
  // Carol is a server member, so she should be resolved even though she's not in the thread.
  const enriched = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: threadChannel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Carol check this thread",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, threadChannel.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetId, user3.id);
  assert.equal(rows[0].handleAtSendTime, "Carol");
  const followRows = await db.select()
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannel.id),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, user3.id),
    ));
  assert.equal(followRows.length, 0, "server-wide thread mention resolution must not auto-follow parent-channel outsiders");

  await db.update(messageMentions).set({
    notifiedAt: new Date(),
    notifiedByType: "user",
    notifiedById: user.id,
    notifiedAction: "notify_only",
  }).where(eq(messageMentions.id, rows[0].id));

  const notifiedMentions = await getInboxItems(server.id, user3.id, { filter: "mentions" });
  const notifiedThreadItem = notifiedMentions.items.find((item) => item.kind === "thread" && item.threadChannelId === threadChannel.id);
  assert.ok(notifiedThreadItem, "notified outsider public-thread mention should appear in Activity/Mentions");
  assert.equal(notifiedThreadItem.kind, "thread");
  assert.equal(notifiedThreadItem.latestActivityMessageId, enriched.id, "thread mention-only row should open the notified reply");
  assert.equal(notifiedThreadItem.firstUnreadMessageId, enriched.id, "thread mention-only row should use the notified reply as its anchor");
  const followRowsAfterNotify = await db.select()
    .from(threadFollows)
    .where(and(
      eq(threadFollows.threadChannelId, threadChannel.id),
      eq(threadFollows.followerType, "user"),
      eq(threadFollows.followerId, user3.id),
    ));
  assert.equal(followRowsAfterNotify.length, 0, "notify-only thread mention must not create a follow row");
});
// PLACEHOLDER_MORE_TESTS

test("mention write: thread under DM resolves via DM participants only", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user2] = await db.insert(users).values({
    email: "bob@test.com", name: "Bob", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user3] = await db.insert(users).values({
    email: "carol@test.com", name: "Carol", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "test", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: user.id, role: "owner" },
    { serverId: server.id, userId: user2.id, role: "member" },
    { serverId: server.id, userId: user3.id, role: "member" },
  ]);
  // DM between Alice and Bob
  const [dmChannel] = await db.insert(channels).values({
    serverId: server.id, name: "dm-alice-bob", type: "dm",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: dmChannel.id, userId: user.id },
    { channelId: dmChannel.id, userId: user2.id },
  ]);
  // Parent message in the DM
  const [parentMsg] = await db.insert(messages).values({
    channelId: dmChannel.id, senderType: "user", senderId: user.id,
    content: "DM parent", messageType: "chat", searchText: "DM parent",
  }).returning();
  // Thread under the DM
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id, name: `thread-${parentMsg.id.slice(0, 8)}`, type: "thread",
    parentMessageId: parentMsg.id,
  }).returning();
  await db.insert(channelHumans).values({ channelId: threadChannel.id, userId: user.id });

  setupDepsForIntegration(server.id);

  // Mention @Carol in DM thread — parent is DM, so only DM participants are in scope.
  // Carol is a server member but NOT a DM participant.
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: threadChannel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Carol and @Bob",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, threadChannel.id));
  assert.equal(rows.length, 2);
  const bobMention = rows.find((row) => row.targetId === user2.id);
  const carolMention = rows.find((row) => row.targetId === user3.id);
  assert.ok(bobMention, "DM parent participant should be resolved");
  assert.equal(bobMention.notifiableAtSend, true);
  assert.ok(carolMention, "same-server DM parent outsider should be recorded as an inert mention fact");
  assert.equal(carolMention.notifiableAtSend, false);
});

test("mention write v2: ambiguous raw handle sends without user or idempotent-agent mention edges", async ({ db: database }) => {

  const { db, sender, sameHandleAgent, server, channel } = await seedAmbiguousMentionChannel();
  setupDepsForIntegration(server.id);

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "legacy @applepi",
  });
  assert.deepEqual(
    (await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id)))
      .map((row) => row.targetType)
      .sort(),
    ["agent", "user"],
    "v1 keeps the legacy all-exact-match behavior",
  );

  const humanSent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "hey @applepi",
    mentionContract: "v2",
  });
  const agentSent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "agent",
    senderId: sameHandleAgent.id,
    senderName: "applepi",
    content: "hey @applepi",
    agentSendKey: "ambiguous-agent-send",
    mentionContract: "v2",
  });

  assert.deepEqual(getSenderUnresolvedMentionHandles(humanSent), ["@applepi"]);
  assert.deepEqual(getSenderUnresolvedMentionHandles(agentSent), ["@applepi"]);
  assert.equal((await db.select().from(messages).where(eq(messages.channelId, channel.id))).length, 3);
  assert.equal(
    (await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id))).length,
    2,
    "v2 ambiguity adds no edges beyond the v1 control",
  );
});

test("mention write: case-only agent handles resolve exact target", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "case-agents", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "owner" });
  const [upperAgent] = await db.insert(agents).values({
    serverId: server.id, name: "Baoyu", status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc",
  }).returning();
  const [lowerAgent] = await db.insert(agents).values({
    serverId: server.id, name: "baoyu", status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: user.id });

  setupDepsForIntegration(server.id);

  const lowerSent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "loop in @baoyu",
  });
  const upperSent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "loop in @Baoyu",
  });
  const missSent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "loop in @BAOYU",
    mentionContract: "v2",
  });

  const lowerPending = getSenderPendingMentionActions(lowerSent);
  assert.equal(lowerPending.length, 1);
  assert.equal(lowerPending[0].targetType, "agent");
  assert.equal(lowerPending[0].targetHandle, "baoyu");

  const upperPending = getSenderPendingMentionActions(upperSent);
  assert.equal(upperPending.length, 1);
  assert.equal(upperPending[0].targetType, "agent");
  assert.equal(upperPending[0].targetHandle, "Baoyu");

  assert.equal(getSenderPendingMentionActions(missSent).length, 0);
  assert.deepEqual(getSenderUnresolvedMentionHandles(lowerSent), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(upperSent), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(missSent), ["@BAOYU"]);

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 2);
  const rowsByHandle = new Map(rows.map((row) => [row.handleAtSendTime, row]));
  assert.equal(rowsByHandle.get("baoyu")?.targetId, lowerAgent.id);
  assert.equal(rowsByHandle.get("Baoyu")?.targetId, upperAgent.id);
  assert.equal(rowsByHandle.has("BAOYU"), false);
});

test("mention write: stale structured identity degrades without falling through to a same-handle actor", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "structured-case-agents", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "owner" });
  const [upperAgent] = await db.insert(agents).values({
    serverId: server.id, name: "Baoyu", status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc",
  }).returning();
  const [lowerAgent] = await db.insert(agents).values({
    serverId: server.id, name: "baoyu", status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: user.id });
  await db.insert(channelAgents).values([
    { channelId: channel.id, agentId: upperAgent.id },
    { channelId: channel.id, agentId: lowerAgent.id },
  ]);

  setupDepsForIntegration(server.id);

  const degraded = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "loop in @baoyu",
    mentions: [{ type: "agent", id: upperAgent.id, name: "baoyu" }],
  });

  assert.equal(degraded.content, "loop in @baoyu");
  assert.deepEqual(degraded.mentions, []);
  assert.deepEqual(getSenderPendingMentionActions(degraded), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(degraded), []);
  const afterDegraded = await db.select().from(messages).where(eq(messages.channelId, channel.id));
  assert.equal(afterDegraded.length, 1, "stale structured identity must not block the message");
  const rowsAfterDegraded = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rowsAfterDegraded.length, 0, "stale identity must not fall back to the other same-handle actor");

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "loop in @baoyu",
    mentions: [{ type: "agent", id: lowerAgent.id, name: "baoyu" }],
  });

  const persisted = await db.select().from(messages).where(eq(messages.channelId, channel.id));
  assert.equal(persisted.length, 2);
  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetId, lowerAgent.id);
  assert.equal(rows[0].handleAtSendTime, "baoyu");
});

test("mention write: identity-backed mention survives a CJK left-boundary edit", async ({ db: database }) => {

  const { db, user, agent, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const content = "先给个草案@TestBot";
  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content,
    randomId: "structured-mention-embedded-in-word",
    mentions: [{ type: "agent", id: agent.id, name: "TestBot" }],
  });

  assert.equal(sent.content, content, "the user's original text must be persisted unchanged");
  assert.deepEqual(sent.mentions, [{ type: "agent", id: agent.id, name: "TestBot" }]);
  assert.deepEqual(getSenderPendingMentionActions(sent), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(sent), []);

  const persisted = await db.select().from(messages).where(eq(messages.channelId, channel.id));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].content, content);
  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetType, "agent");
  assert.equal(rows[0].targetId, agent.id);
  assert.equal(rows[0].handleAtSendTime, "TestBot");
});

test("mention write: unstructured embedded at-sign stays plain text", async ({ db: database }) => {

  const { db, user, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const content = "先给个草案@TestBot";
  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content,
  });

  assert.equal(sent.content, content);
  assert.deepEqual(sent.mentions, []);
  assert.deepEqual(getSenderPendingMentionActions(sent), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(sent), []);
  const persisted = await db.select().from(messages).where(eq(messages.channelId, channel.id));
  assert.equal(persisted.length, 1);
  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 0);
});

test("mention write: stale structured metadata cannot block valid mentions in the same message", async ({ db: database }) => {

  const { db, user, user2, agent, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const content = "先给个草案，另请 @Bob";
  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content,
    randomId: "stale-structured-mention-beside-valid-mention",
    mentions: [
      { type: "agent", id: agent.id, name: "TestBot" },
      { type: "user", id: user2.id, name: "Bob" },
    ],
  });

  assert.equal(sent.content, content);
  assert.deepEqual(sent.mentions, [{ type: "user", id: user2.id, name: "Bob" }]);
  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetType, "user");
  assert.equal(rows[0].targetId, user2.id);
  assert.equal(rows[0].handleAtSendTime, "Bob");
});

test("mention write v2: structured mention selects one same-handle entity", async ({ db: database }) => {

  const { db, sender, sameHandleHuman, sameHandleAgent, server, channel } = await seedAmbiguousMentionChannel();
  setupDepsForIntegration(server.id);

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "legacy @applepi",
    mentions: [{ type: "user", id: sameHandleHuman.id, name: "applepi" }],
  });
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "hey @applepi",
    mentions: [{ type: "user", id: sameHandleHuman.id, name: "applepi" }],
    mentionContract: "v2",
  });
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "hey @applepi",
    mentions: [{ type: "agent", id: sameHandleAgent.id, name: "applepi" }],
    mentionContract: "v2",
  });

  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows
      .map(({ targetType, targetId }) => ({ targetType, targetId }))
      .sort((left, right) => left.targetType.localeCompare(right.targetType)),
    [
      { targetType: "agent", targetId: sameHandleAgent.id },
      { targetType: "user", targetId: sameHandleHuman.id },
      { targetType: "user", targetId: sameHandleHuman.id },
    ],
  );

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: "Alice",
    content: "stale metadata beside valid @applepi",
    mentions: [
      { type: "agent", id: "11111111-1111-4111-8111-111111111111", name: "applepi" },
      { type: "user", id: sameHandleHuman.id, name: "applepi" },
    ],
    mentionContract: "v2",
  });
  const rowsAfterStaleMetadata = await db.select().from(messageMentions).where(eq(messageMentions.channelId, channel.id));
  assert.equal(rowsAfterStaleMetadata.length, 4, "a stale binding must not block a valid same-handle binding");
  assert.equal(rowsAfterStaleMetadata.filter((row) => row.targetId === sameHandleHuman.id).length, 3);

  await assert.rejects(
    broadcastAndDeliver(createIo(), noopOrchestrator, {
      channelId: channel.id,
      senderType: "user",
      senderId: sender.id,
      senderName: "Alice",
      content: "hey @applepi",
      mentions: [
        { type: "user", id: sameHandleHuman.id, name: "applepi" },
        { type: "agent", id: sameHandleAgent.id, name: "applepi" },
      ],
      mentionContract: "v2",
    }),
    (error: unknown) => {
      assert.ok(error instanceof MentionValidationError);
      assert.equal(error.code, "mention_binding_conflict");
      return true;
    },
  );
  assert.equal((await db.select().from(messages).where(eq(messages.channelId, channel.id))).length, 4);
});

test("mention write: invisible structured target degrades to plain text", async ({ db: database }) => {

  const { db, user, user3, privateChannel, server } = await seedPrivateChannel();
  setupDepsForIntegration(server.id);

  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: privateChannel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "hey @Carol",
    mentions: [{ type: "user", id: user3.id, name: "Carol" }],
  });

  const persisted = await db.select().from(messages).where(eq(messages.channelId, privateChannel.id));
  assert.equal(persisted.length, 1, "invisible structured target must not block the message");
  assert.equal(persisted[0].content, "hey @Carol");
  assert.deepEqual(sent.mentions, []);
  assert.deepEqual(getSenderPendingMentionActions(sent), []);
  assert.deepEqual(getSenderUnresolvedMentionHandles(sent), []);
  const rows = await db.select().from(messageMentions).where(eq(messageMentions.channelId, privateChannel.id));
  assert.equal(rows.length, 0);
});

test("inbox: hasMention is true for unread mentions and false after markRead", async ({ db: database }) => {

  const db = getDb();

  const [user] = await db.insert(users).values({
    email: "alice@test.com", name: "Alice", passwordHash: "x", emailVerified: true,
  }).returning();
  const [user2] = await db.insert(users).values({
    email: "bob@test.com", name: "Bob", passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "TestServer", slug: "test", ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: user.id, role: "owner" },
    { serverId: server.id, userId: user2.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: "general", type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: user.id },
    { channelId: channel.id, userId: user2.id },
  ]);

  setupDepsForIntegration(server.id);

  // Bob sends a message mentioning Alice
  const enriched = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user2.id,
    senderName: "Bob",
    content: "hey @Alice check this",
  });

  // Alice's inbox should show hasMention=true (she hasn't read yet)
  const before = await getInboxItems(server.id, user.id);
  const channelItem = before.items.find((i) => i.kind === "channel" && i.channelId === channel.id);
  assert.ok(channelItem, "channel should appear in inbox");
  assert.equal(channelItem.hasMention, true, "hasMention should be true before markRead");

  // Alice reads up to the mention message
  await markRead(user.id, channel.id, enriched.seq);

  // Alice's inbox should now show hasMention=false
  const after = await getInboxItems(server.id, user.id);
  const channelItemAfter = after.items.find((i) => i.kind === "channel" && i.channelId === channel.id);
  // After reading, either the item is gone (no unread) or hasMention is false
  if (channelItemAfter) {
    assert.equal(channelItemAfter.hasMention, false, "hasMention should be false after markRead");
  }
  // If item is absent that's also correct — no unread items means no mention badge

  // Plan A (#proj-uiux:6beb878c msg=691ade99): the Mentions filter must keep
  // the row even after the @mention has been read — the user's mental model is
  // "show every channel/thread where someone has @-mentioned me", not "show
  // every channel/thread where there's an unread @mention".
  const mentionsAfter = await getInboxItems(server.id, user.id, { filter: "mentions" });
  assert.ok(
    mentionsAfter.items.some((i) => i.kind === "channel" && i.channelId === channel.id),
    "mentions filter should keep the row after the @mention is read (Plan A)",
  );
});

test("target-side consumers ignore non-notifiable mention rows until notified", async ({ db: database }) => {

  const { db, user, user2, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  const enriched = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "manual pending mention row",
  });

  const [mention] = await db.insert(messageMentions).values({
    messageId: enriched.id,
    messageSeq: enriched.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: user2.id,
    handleAtSendTime: "Bob",
    notifiableAtSend: false,
  }).returning();

  const pendingMentions = await getInboxItems(server.id, user2.id, { filter: "mentions" });
  assert.ok(
    !pendingMentions.items.some((item) => item.kind === "channel" && item.channelId === channel.id),
    "pending non-notifiable mention rows must not appear in target-side Mentions",
  );
  const pendingMessages = await listMessages(channel.id);
  const pendingMessage = pendingMessages.find((message) => message.id === enriched.id);
  assert.ok(pendingMessage);
  assert.deepEqual(pendingMessage.mentions, [], "hydration must not expose non-notifiable pending mention rows");

  await db.update(messageMentions).set({
    notifiedAt: new Date(),
    notifiedByType: "user",
    notifiedById: user.id,
    notifiedAction: "notify_only",
  }).where(eq(messageMentions.id, mention.id));

  const notifiedMentions = await getInboxItems(server.id, user2.id, { filter: "mentions" });
  assert.ok(
    notifiedMentions.items.some((item) => item.kind === "channel" && item.channelId === channel.id),
    "notified mention rows should appear in target-side Mentions",
  );
  const notifiedMessages = await listMessages(channel.id);
  const notifiedMessage = notifiedMessages.find((message) => message.id === enriched.id);
  assert.deepEqual(
    notifiedMessage?.mentions,
    [{ type: "user", id: user2.id, name: "Bob" }],
    "hydration should expose mention rows after notified_at is set",
  );
});

test("notified public outsider human mentions get a mention-only Activity entry", async ({ db: database }) => {

  const { db, user, user2, channel, server } = await seedPublicChannel();
  setupDepsForIntegration(server.id);

  await db.delete(channelHumans)
    .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, user2.id)));

  const enriched = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: channel.id,
    senderType: "user",
    senderId: user.id,
    senderName: "Alice",
    content: "outsider mention needs Activity after notify",
  });

  const [mention] = await db.insert(messageMentions).values({
    messageId: enriched.id,
    messageSeq: enriched.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "user",
    targetId: user2.id,
    handleAtSendTime: "Bob",
    notifiableAtSend: false,
  }).returning();

  const pendingMentions = await getInboxItems(server.id, user2.id, { filter: "mentions" });
  assert.ok(
    !pendingMentions.items.some((item) => item.kind === "channel" && item.channelId === channel.id),
    "pending outsider mention rows must not appear before notify",
  );

  await db.update(messageMentions).set({
    notifiedAt: new Date(),
    notifiedByType: "user",
    notifiedById: user.id,
    notifiedAction: "notify_only",
  }).where(eq(messageMentions.id, mention.id));

  const notifiedMentions = await getInboxItems(server.id, user2.id, { filter: "mentions" });
  const notifiedItem = notifiedMentions.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
  assert.ok(notifiedItem, "notified outsider public mention should appear in Activity/Mentions");
  assert.equal(notifiedItem.kind, "channel");
  assert.equal(notifiedItem.lastMessageId, enriched.id, "mention-only Activity row should open the notified message");
  assert.equal(notifiedItem.firstUnreadMessageId, enriched.id, "mention-only Activity row should use the notified message as its anchor");
  assert.equal(notifiedItem.hasMention, true);
  assert.equal(notifiedItem.unreadCount, 0, "mention-only row must not count the whole non-member channel as unread");

  const allInbox = await getInboxItems(server.id, user2.id, { filter: "all" });
  const allItem = allInbox.items.find((item) => item.kind === "channel" && item.channelId === channel.id);
  assert.ok(allItem, "notified outsider public mention should appear in Activity/All");
  assert.equal(allItem.kind, "channel");
  assert.equal(allItem.lastMessageId, enriched.id, "All mention-only row should open the notified message");
  assert.equal(allItem.firstUnreadMessageId, enriched.id, "All mention-only row should anchor to the notified message");
  assert.equal(allItem.hasMention, true);
  assert.equal(allItem.unreadCount, 0, "mention-only All row must not count the whole non-member channel as unread");
  const channelMembershipRows = await db.select()
    .from(channelHumans)
    .where(and(eq(channelHumans.channelId, channel.id), eq(channelHumans.userId, user2.id)));
  assert.equal(channelMembershipRows.length, 0, "notify must not add outsider human to the channel");
  const followRows = await db.select()
    .from(threadFollows)
    .where(and(eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, user2.id)));
  assert.equal(followRows.length, 0, "notify must not create channel/thread follow state for outsider human");
});
