import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { channels, messages, servers, users } from "../db/schema.js";
import { getMessageContext, getMessageContextByShortId, listMessages, resolveMessageIdInServer, resolveMessageSeqAnchor } from "../services/messageService.js";
import { resolveMessageInChannel } from "../services/taskService.js";
import { classifyHistoryAroundCursor, paginateHistoryProbe } from "./historyCursor.js";
import { applyHistoryThreadMetadata, getHistoryThreadParentMessageIds } from "./historyThreadMetadata.js";
import { resolveReminderMsgId } from "./internal.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedReminderMsgIdFixtures() {
  const db = getDb();

  const [owner] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  }).returning();

  const [channel] = await db.insert(channels).values({
    id: "33333333-3333-3333-3333-333333333333",
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();

  await db.insert(messages).values([
    {
      id: "943de343-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "anchored one",
    },
    {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "ambiguous one",
    },
    {
      id: "aaaaaaaa-2222-4222-8222-222222222222",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "ambiguous two",
    },
    {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "upper edge",
    },
  ]);

  return { server, agentId: "44444444-4444-4444-8444-444444444444" };
}

test("classifyHistoryAroundCursor distinguishes seq, short message ids, and full ids", () => {
  assert.equal(classifyHistoryAroundCursor("12345"), "seq");
  assert.equal(classifyHistoryAroundCursor("12345678"), "short_id");
  assert.equal(classifyHistoryAroundCursor("b648e174"), "short_id");
  assert.equal(classifyHistoryAroundCursor("B648E174"), "short_id");
  assert.equal(classifyHistoryAroundCursor("b2c23a3e-d0de-4dcd-98a5-573b61d0603d"), "message_id");
});

test("paginateHistoryProbe trims the probe from the direction it was fetched", () => {
  assert.deepEqual(paginateHistoryProbe([1, 2, 3], 2, "latest"), {
    messages: [2, 3],
    hasOlder: true,
    hasNewer: false,
  });
  assert.deepEqual(paginateHistoryProbe([1, 2, 3], 2, "before"), {
    messages: [2, 3],
    hasOlder: true,
    hasNewer: false,
  });
  assert.deepEqual(paginateHistoryProbe([1, 2, 3], 2, "after"), {
    messages: [1, 2],
    hasOlder: false,
    hasNewer: true,
  });
  assert.deepEqual(paginateHistoryProbe([1, 2], 2, "latest"), {
    messages: [1, 2],
    hasOlder: false,
    hasNewer: false,
  });
});

test("resolveMessageSeqAnchor accepts seq, full id, and short id anchors", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));
  const [message] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, "943de343-1111-4111-8111-111111111111"));

  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, String(message.seq), "pagination"), {
    ok: true,
    seq: message.seq,
  });
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "943de343-1111-4111-8111-111111111111", "around"), {
    ok: true,
    seq: message.seq,
  });
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "943de343", "around"), {
    ok: true,
    seq: message.seq,
  });

  const [upperEdge] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, "ffffffff-ffff-4fff-8fff-ffffffffffff"));
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "ffffffff", "around"), {
    ok: true,
    seq: upperEdge.seq,
  });
});

test("resolveMessageSeqAnchor reports unknown and ambiguous short ids", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));

  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "deadbeef", "around"), {
    ok: false,
    reason: "not_found",
  });
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "aaaaaaaa", "around"), {
    ok: false,
    reason: "ambiguous",
  });
});

test("resolveMessageSeqAnchor disambiguates 8-digit pagination seqs from around short ids", async ({ db: database }) => {
  // Regression: a UUID prefix of 8 decimal-only chars (e.g. `63508141…`)
  // happens ~3.6% of the time (10^8 / 16^8). Before the fix, the all-digits
  // branch fired first and returned `{ ok:true, seq: 63508141 }` — pointing
  // at a non-existent row 60M seqs in — so /history?around=<shortid>
  // intermittently 404'd. Aligns the resolver with classifyHistoryAroundCursor.

  const { server } = await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));

  const [decimalPrefixMsg] = await db.insert(messages).values({
    id: "63508141-1111-4111-8111-111111111111",
    channelId: channel.id,
    senderType: "user",
    senderId: "11111111-1111-1111-1111-111111111111",
    content: "decimal-prefix shortid",
  }).returning({ seq: messages.seq });

  // `around` is a locator, so an 8-character value keeps short-id semantics.
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "63508141", "around"), {
    ok: true,
    seq: decimalPrefixMsg.seq,
  });

  // `before` / `after` are pagination cursors. Once seq crosses 10M, its
  // 8-digit decimal representation must not be reinterpreted as a short id.
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "63508141", "pagination"), {
    ok: true,
    seq: 63508141,
  });

  // Lengths other than 8 still resolve as seq (e.g. small or large numerics
  // typed by humans / passed through from cursors).
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "1", "pagination"), {
    ok: true,
    seq: 1,
  });
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "1234567", "pagination"), {
    ok: true,
    seq: 1234567,
  });
  assert.deepEqual(await resolveMessageSeqAnchor(channel.id, "123456789", "pagination"), {
    ok: true,
    seq: 123456789,
  });

  // Suppress unused-var on `server` (matches the surrounding test pattern).
  void server;
});

test("resolveMessageIdInServer is exact-only for cited ids", async ({ db }) => {

  const { server } = await seedReminderMsgIdFixtures();

  assert.deepEqual(await resolveMessageIdInServer(server.id, "943de343"), {
    ok: true,
    messageId: "943de343-1111-4111-8111-111111111111",
  });
  assert.deepEqual(await resolveMessageIdInServer(server.id, "943de343-1111-4111-8111-111111111111"), {
    ok: true,
    messageId: "943de343-1111-4111-8111-111111111111",
  });
  assert.deepEqual(await resolveMessageIdInServer(server.id, "4f9c2210"), {
    ok: false,
    status: 404,
    error: "Message not found",
  });
  assert.deepEqual(await resolveMessageIdInServer(server.id, "ffffffff"), {
    ok: true,
    messageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  assert.deepEqual(await resolveMessageIdInServer(server.id, "aaaaaaaa"), {
    ok: false,
    status: 400,
    error: "Message short id is ambiguous",
  });
});

test("message history anchors keep after/before exclusive and around inclusive", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));
  const [anchor] = await db
    .select({ id: messages.id, seq: messages.seq })
    .from(messages)
    .where(eq(messages.id, "943de343-1111-4111-8111-111111111111"));

  const afterAnchor = await listMessages(channel.id, 10, undefined, anchor.seq);
  assert.equal(afterAnchor.some((message) => message.id === anchor.id), false);
  assert.ok(afterAnchor.every((message) => message.seq > anchor.seq));

  const beforeAnchor = await listMessages(channel.id, 10, anchor.seq);
  assert.equal(beforeAnchor.some((message) => message.id === anchor.id), false);
  assert.ok(beforeAnchor.every((message) => message.seq < anchor.seq));

  const aroundAnchor = await getMessageContextByShortId(channel.id, "943de343", 1, 1);
  assert.ok(aroundAnchor);
  assert.equal(aroundAnchor.messages.some((message) => message.id === anchor.id), true);
});

test("message context short id resolver fails closed for malformed anchors", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));

  assert.equal(await getMessageContextByShortId(channel.id, "abc123456789", 1, 1), null);
  assert.equal(await getMessageContextByShortId(channel.id, "not-a-msg", 1, 1), null);
});

test("message context history cutoff uses a seq lower bound without changing visible rows", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));
  const ownerId = "11111111-1111-1111-1111-111111111111";
  await db
    .update(messages)
    .set({ createdAt: new Date("2026-05-01T00:00:00Z") })
    .where(eq(messages.channelId, channel.id));

  const inserted = await db.insert(messages).values([
    {
      id: "10000000-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: ownerId,
      content: "post-cutoff lower seq but later created",
      createdAt: new Date("2026-06-05T00:00:00Z"),
    },
    {
      id: "20000000-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: ownerId,
      content: "pre-cutoff between retained seqs",
      createdAt: new Date("2026-05-20T00:00:00Z"),
    },
    {
      id: "30000000-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: ownerId,
      content: "post-cutoff earliest created",
      createdAt: new Date("2026-06-02T00:00:00Z"),
    },
    {
      id: "40000000-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: ownerId,
      content: "pre-cutoff nearest seq",
      createdAt: new Date("2026-05-21T00:00:00Z"),
    },
    {
      id: "50000000-1111-4111-8111-111111111111",
      channelId: channel.id,
      senderType: "user",
      senderId: ownerId,
      content: "target",
      createdAt: new Date("2026-06-06T00:00:00Z"),
    },
  ]).returning({ id: messages.id, seq: messages.seq, content: messages.content });

  const target = inserted.find((message) => message.content === "target");
  assert.ok(target);

  const context = await getMessageContext(target.id, 10, 0, new Date("2026-06-01T00:00:00Z"));
  assert.ok(context);
  assert.deepEqual(
    context.messages.map((message) => message.content),
    [
      "post-cutoff lower seq but later created",
      "post-cutoff earliest created",
      "target",
    ],
  );
});

test("getHistoryThreadParentMessageIds only keeps parent messages that already have a thread", () => {
  const ids = getHistoryThreadParentMessageIds([
    { id: "m1", threadId: "thread-1" },
    { id: "m2", threadId: null },
    { id: "m3" },
    { id: "m1", threadId: "thread-1" },
  ]);

  assert.deepEqual(ids, ["m1"]);
});

test("applyHistoryThreadMetadata adds replyCount while preserving existing thread ids", () => {
  const messages = applyHistoryThreadMetadata(
    [
      { id: "m1", threadId: "thread-1", content: "parent" },
      { id: "m2", threadId: null, content: "plain" },
    ],
    {
      m1: { threadChannelId: "thread-1", replyCount: 3 },
    },
  );

  assert.deepEqual(messages, [
    { id: "m1", threadId: "thread-1", content: "parent", replyCount: 3 },
    { id: "m2", threadId: null, content: "plain", replyCount: 0 },
  ]);
});

test("resolveReminderMsgId accepts a full UUID anchor", async ({ db }) => {

  const { server, agentId } = await seedReminderMsgIdFixtures();

  const resolved = await resolveReminderMsgId(server.id, agentId, "943de343-1111-4111-8111-111111111111");
  assert.deepEqual(resolved, {
    ok: true,
    messageId: "943de343-1111-4111-8111-111111111111",
  });
});

test("resolveReminderMsgId accepts an 8-char short id anchor", async ({ db }) => {

  const { server, agentId } = await seedReminderMsgIdFixtures();

  const resolved = await resolveReminderMsgId(server.id, agentId, "943de343");
  assert.deepEqual(resolved, {
    ok: true,
    messageId: "943de343-1111-4111-8111-111111111111",
  });
});

test("resolveReminderMsgId accepts ffffffff short id without an upper range bound", async ({ db }) => {

  const { server, agentId } = await seedReminderMsgIdFixtures();

  const resolved = await resolveReminderMsgId(server.id, agentId, "ffffffff");
  assert.deepEqual(resolved, {
    ok: true,
    messageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
});

test("resolveMessageInChannel accepts full and short message ids for task claim anchors", async ({ db: database }) => {

  await seedReminderMsgIdFixtures();
  const db = getDb();
  const [channel] = await db.select().from(channels).where(eq(channels.name, "general"));

  const byFull = await resolveMessageInChannel(channel.id, "943de343-1111-4111-8111-111111111111");
  assert.equal(byFull?.id, "943de343-1111-4111-8111-111111111111");

  const byShort = await resolveMessageInChannel(channel.id, "943de343");
  assert.equal(byShort?.id, "943de343-1111-4111-8111-111111111111");

  const byUpperEdgeShort = await resolveMessageInChannel(channel.id, "ffffffff");
  assert.equal(byUpperEdgeShort?.id, "ffffffff-ffff-4fff-8fff-ffffffffffff");

  assert.equal(await resolveMessageInChannel(channel.id, "aaaaaaaa"), null);
  assert.equal(await resolveMessageInChannel(channel.id, "abc123456789"), null);
  assert.equal(await resolveMessageInChannel(channel.id, "not-a-msg"), null);
  assert.equal(await resolveMessageInChannel(channel.id, "943de343-not-a-full-uuid-but-long"), null);
});

test("resolveReminderMsgId returns not found for an unknown short id", async ({ db }) => {

  const { server, agentId } = await seedReminderMsgIdFixtures();

  const resolved = await resolveReminderMsgId(server.id, agentId, "deadbeef");
  assert.deepEqual(resolved, {
    ok: false,
    status: 404,
    error: "message not found",
  });
});

test("resolveReminderMsgId rejects ambiguous short ids", async ({ db }) => {

  const { server, agentId } = await seedReminderMsgIdFixtures();

  const resolved = await resolveReminderMsgId(server.id, agentId, "aaaaaaaa");
  assert.deepEqual(resolved, {
    ok: false,
    status: 400,
    error: "msgId short id is ambiguous",
  });
});
