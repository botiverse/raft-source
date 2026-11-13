import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelHumans, channels, messageMentions, messages, serverMembers, servers, users } from "../db/schema";
import {
  broadcastAndDeliver,
  broadcastSystemMessage,
  drainSenderReadReceiptsForTests,
  recordInboxFactsForPersistedMessages,
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
} from "./messageService";
import type { InboxFactNotificationContext } from "./notifications/enqueue";
import { withChannelDelivery } from "../test/orchestratorStub";

// The notification outbox is written from the inbox facts, so the fact
// recording must hand it what it cannot derive from the facts alone: the
// system producer and the public-channel mention-only audience.

afterEach(async () => {
  __resetMessageServiceDepsForTests();
  await drainSenderReadReceiptsForTests();
  await closeTestDatabase();
});

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

const noopOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;

function captureNotificationContexts(): Array<InboxFactNotificationContext | undefined> {
  const captured: Array<InboxFactNotificationContext | undefined> = [];
  __setMessageServiceDepsForTests({
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({ uniqueName: fallbackName, description: null }),
    recordInboxNotificationFacts: async (facts, _executor, notification) => {
      captured.push(notification);
      return facts.length;
    },
  });
  return captured;
}

async function seed(slug: string) {
  const db = getDb();
  const [sender] = await db.insert(users).values({
    email: `${slug}-sender@test.com`, name: `${slug}-sender`, passwordHash: "x", emailVerified: true,
  }).returning();
  const [joined] = await db.insert(users).values({
    email: `${slug}-joined@test.com`, name: `${slug}-joined`, passwordHash: "x", emailVerified: true,
  }).returning();
  const [outsider] = await db.insert(users).values({
    email: `${slug}-outsider@test.com`, name: `${slug}-outsider`, displayName: `${slug}-outsider-display`, passwordHash: "x", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: slug, slug, ownerId: sender.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: sender.id, role: "owner" },
    { serverId: server.id, userId: joined.id, role: "member" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);
  const [publicChannel] = await db.insert(channels).values({ serverId: server.id, name: "general", type: "channel" }).returning();
  const [privateChannel] = await db.insert(channels).values({ serverId: server.id, name: "secret", type: "private" }).returning();
  await db.insert(channelHumans).values([
    { channelId: publicChannel.id, userId: sender.id },
    { channelId: publicChannel.id, userId: joined.id },
    { channelId: privateChannel.id, userId: sender.id },
    { channelId: privateChannel.id, userId: joined.id },
  ]);
  return { db, sender, joined, outsider, server, publicChannel, privateChannel };
}

async function insertChatMessage(channelId: string, senderId: string, content: string) {
  const [message] = await getDb().insert(messages).values({
    channelId, senderType: "user", senderId, content, seq: 1,
  }).returning();
  return message;
}

const mentionPolicy = { mode: "record", producer: "test.notification_context", reason: "unit test" } as const;

test("a send passes its message, channel and target-visible mentions as the notification context", async ({ db: _db }) => {
  const { sender, joined, server, publicChannel } = await seed("ctx-send");
  const captured = captureNotificationContexts();

  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: publicChannel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: sender.name,
    content: `@${joined.name} look`,
    mentions: [{ type: "user", id: joined.id, name: joined.name }],
  });

  assert.equal(captured.length, 1);
  const context = captured[0];
  assert.ok(context, "the message's fact recording must pass its notification context");
  assert.deepEqual(context, {
    message: { id: sent.id, seq: sent.seq, createdAt: context.message.createdAt, messageType: "chat", systemSubtype: null },
    producer: null,
    causalActor: null,
    channel: { id: publicChannel.id, serverId: server.id, type: "channel", parentMessageId: null, parentChannelId: null, taskId: null },
    targetVisibleMentions: [{ type: "user", id: joined.id }],
    // The joined member gets a fact, so no mention-only row.
    mentionOnlyUserIds: [],
  });
});

test("a public channel mention of a server member outside the channel is a mention-only receiver; the sender, joined members and non-members are not", async ({ db: _db }) => {
  const { db, sender, joined, outsider, publicChannel } = await seed("ctx-public");
  const [stranger] = await db.insert(users).values({
    email: "ctx-public-stranger@test.com", name: "ctx-public-stranger", passwordHash: "x", emailVerified: true,
  }).returning();
  const captured = captureNotificationContexts();
  const message = await insertChatMessage(publicChannel.id, sender.id, "mentions");

  await recordInboxFactsForPersistedMessages([message], {
    inboxFactPolicy: mentionPolicy,
    targetVisibleMentionsByMessageId: new Map([[message.id, [
      { type: "user", id: outsider.id, name: outsider.name },
      { type: "user", id: joined.id, name: joined.name },
      { type: "user", id: sender.id, name: sender.name },
      { type: "user", id: stranger.id, name: stranger.name },
    ]]]),
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.producer, "test.notification_context");
  assert.deepEqual(captured[0]?.mentionOnlyUserIds, [outsider.id]);
});

test("a private channel mention of a server member outside the channel has no mention-only receivers", async ({ db: _db }) => {
  const { sender, outsider, privateChannel } = await seed("ctx-private");
  const captured = captureNotificationContexts();
  const message = await insertChatMessage(privateChannel.id, sender.id, "mentions");

  await recordInboxFactsForPersistedMessages([message], {
    inboxFactPolicy: mentionPolicy,
    targetVisibleMentionsByMessageId: new Map([[message.id, [{ type: "user", id: outsider.id, name: outsider.name }]]]),
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.channel.type, "private");
  assert.equal(captured[0]?.mentionOnlyUserIds, undefined);
});

test("an @mention of a server member outside a public channel is not target-visible at send, so the send adds no mention-only receiver", async ({ db: _db }) => {
  const { sender, outsider, publicChannel } = await seed("ctx-send-outsider");
  const captured = captureNotificationContexts();

  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: publicChannel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: sender.name,
    content: `@${outsider.name} look`,
    mentions: [{ type: "user", id: outsider.id, name: outsider.name }],
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.targetVisibleMentions, []);
  assert.deepEqual(captured[0]?.mentionOnlyUserIds, []);
});

test("a name-only mention that resolves to no mention fact adds no mention-only receiver", async ({ db: _db }) => {
  const { db, sender, outsider, publicChannel } = await seed("ctx-name-only");
  const captured = captureNotificationContexts();

  const sent = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: publicChannel.id,
    senderType: "user",
    senderId: sender.id,
    senderName: sender.name,
    content: `@${outsider.displayName} look`,
  });

  const mentionRows = await db.select().from(messageMentions).where(eq(messageMentions.messageId, sent.id));
  assert.equal(mentionRows.some((row) => row.targetId === outsider.id), false, "fixture: the display name must not resolve");
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.mentionOnlyUserIds, []);
});

test("broadcastSystemMessage passes its producer and causal actor to the notification context", async ({ db: _db }) => {
  const { sender, server, publicChannel } = await seed("ctx-system");
  const captured = captureNotificationContexts();

  const notice = await broadcastSystemMessage(createIo(), noopOrchestrator, publicChannel.id, "a notice", {
    inboxFactPolicy: {
      mode: "record",
      producer: "test.notification_context",
      reason: "unit test",
      causalActor: { type: "user", id: sender.id },
    },
    targetAgentIds: [],
  });

  assert.equal(captured.length, 1);
  const context = captured[0];
  assert.ok(context);
  assert.equal(context.producer, "test.notification_context");
  assert.deepEqual(context.causalActor, { type: "user", id: sender.id });
  assert.equal(context.message.id, notice.id);
  assert.equal(context.message.messageType, "system");
  assert.equal(context.channel.serverId, server.id);
});
