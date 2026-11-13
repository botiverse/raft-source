import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";

import {
  broadcastAndDeliver,
  __resetMessageServiceDepsForTests,
  __setMessageServiceDepsForTests,
} from "./messageService";
import { getDb } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  threadFollows,
  users,
} from "../db/schema";
import { withChannelDelivery } from "../test/orchestratorStub";


// Delivery-decision teeth for thread_join_context. Persistence, follow rows,
// mention resolution, and channel/thread relations stay real in PGlite; only
// transport/identity projections are stubbed.

function stubIoAndPushDeps() {
  __setMessageServiceDepsForTests({
    renderAgentReadablePermalinks: async (content: string) => content,
    getSenderIdentity: async (_senderType, _senderId, fallbackName) => ({
      uniqueName: fallbackName,
      description: null,
    }),
  });
}

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@test.com`,
    name: `${slug}Owner`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: slug,
    slug,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: owner.id,
    role: "owner",
  });
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `${slug}-agent`,
    status: "active",
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `${slug}-parent`,
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values({
    channelId: parentChannel.id,
    userId: owner.id,
  });
  await db.insert(channelAgents).values({
    channelId: parentChannel.id,
    agentId: agent.id,
  });
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "the thread topic everyone needs",
  }).returning();
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `thread-${parentMessage.id}`,
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  for (let index = 1; index <= 8; index += 1) {
    await db.insert(messages).values({
      channelId: threadChannel.id,
      senderType: "user",
      senderId: owner.id,
      content: `earlier unseen reply ${index}`,
      threadId: threadChannel.id,
    });
  }
  return { db, owner, agent, parentMessage, threadChannel };
}

function orchestratorSink(sink: Array<{ agentId: string; payload: any }>) {
  return withChannelDelivery({
    deliverMessage: async (agentId: string, payload: any) => {
      sink.push({ agentId, payload });
    },
  }) as any;
}

function ioFake(): any {
  const chain: any = {
    emit: () => {},
    socketsJoin: () => {},
    fetchSockets: async () => [],
  };
  chain.in = () => chain;
  chain.to = () => chain;
  chain.except = () => chain;
  return chain;
}
const io = ioFake();

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function mentionIntoThread(
  slug: string,
  opts: {
    preFollowReason?: "replied" | "manual";
    unfollowedAt?: Date;
    beforeMention?: (seeded: Awaited<ReturnType<typeof seed>>) => Promise<void>;
  } = {},
) {
  const seeded = await seed(slug);
  const { db, owner, agent, parentMessage, threadChannel } = seeded;
  await opts.beforeMention?.(seeded);
  if (opts.preFollowReason) {
    await db.insert(threadFollows).values({
      threadChannelId: threadChannel.id,
      followerType: "agent",
      followerId: agent.id,
      parentMessageId: parentMessage.id,
      reason: opts.preFollowReason,
      unfollowedAt: opts.unfollowedAt,
    });
  }
  const delivered: Array<{ agentId: string; payload: any }> = [];
  await broadcastAndDeliver(io, orchestratorSink(delivered), {
    channelId: threadChannel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: `${slug}Owner`,
    content: `@${agent.name} what do you think?`,
    mentions: [{ type: "agent", id: agent.id, name: agent.name }] as any,
  });
  await settle();
  return { db, owner, agent, threadChannel, delivered };
}

afterEach(async () => {
  __resetMessageServiceDepsForTests();
  await closeTestDatabase();
});

test("control: a thread mention delivers to the mentioned agent at all", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { agent, delivered } = await mentionIntoThread("tjc-c");
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "instrument proof: the mentioned agent must receive a delivery");
  assert.match(String(got.payload?.content ?? ""), /what do you think/);
});

test("A: mention into a not-yet-followed thread attaches thread_join_context without a reactivation reminder", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { agent, delivered } = await mentionIntoThread("tjc-a");
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "agent must receive the mention (see control)");
  assert.ok(
    got.payload.thread_join_context,
    "A: a non-following mentioned agent must get the thread context package",
  );
  assert.equal(got.payload.thread_join_context.parent_message.content, "the thread topic everyone needs");
  assert.equal(got.payload.thread_join_context.recent_messages.length, 6);
  assert.deepEqual(
    got.payload.thread_join_context.recent_messages.map((message: any) => message.content),
    [
      "earlier unseen reply 3",
      "earlier unseen reply 4",
      "earlier unseen reply 5",
      "earlier unseen reply 6",
      "earlier unseen reply 7",
      "earlier unseen reply 8",
    ],
  );
  assert.equal(got.payload.thread_join_context.history_truncated, true);
  assert.equal(
    got.payload.thread_join_context.suggested_read_history_target,
    got.payload.thread_join_context.thread_target,
  );
  assert.equal(
    got.payload.thread_join_context.recent_messages.some(
      (message: any) => /what do you think/.test(message.content),
    ),
    false,
  );
  assert.equal(got.payload.thread_follow_reactivation, undefined);
});

test("B: mention into an already-followed (replied), never-seen thread attaches thread_join_context", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { agent, delivered } = await mentionIntoThread("tjc-b", {
    preFollowReason: "replied",
  });
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "agent must receive the mention (see control)");
  assert.ok(
    got.payload.thread_join_context,
    "B: an already-following, never-model-seen mentioned agent must get the thread context package",
  );
  assert.equal(got.payload.thread_follow_reactivation, undefined);
});

test("C: direct mention reactivates an explicitly unfollowed agent and emits the exact unfollow target", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { db, agent, threadChannel, delivered } = await mentionIntoThread("tjc-r", {
    preFollowReason: "manual",
    unfollowedAt: new Date("2026-08-04T00:00:00.000Z"),
  });
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "explicitly unfollowed agent must receive the direct mention");
  assert.deepEqual(got.payload.thread_follow_reactivation, {
    thread_target: `#tjc-r-parent:${threadChannel.parentMessageId!.slice(0, 8)}`,
  });

  const [follow] = await db
    .select({ reason: threadFollows.reason, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows)
    .where(eq(threadFollows.threadChannelId, threadChannel.id))
    .limit(1);
  assert.equal(follow?.unfollowedAt, null, "direct mention must clear the explicit unfollow tombstone");
  assert.equal(follow?.reason, "manual", "mention reactivation must preserve existing follow provenance");
});

// Task #266: a human web sender's IANA zone rides on the agent payloads (live
// delivery and the thread join context) and is never recorded for an agent.
test("sender_timezone reaches agents on live delivery and in thread_join_context", async ({ db: _database }) => {
  stubIoAndPushDeps();
  const { db, owner, agent, parentMessage, threadChannel } = await seed("tjc-tz");
  await db.update(messages).set({ senderTimezone: "Asia/Shanghai" }).where(eq(messages.id, parentMessage.id));
  await db.update(messages).set({ senderTimezone: "America/New_York" }).where(eq(messages.channelId, threadChannel.id));

  const delivered: Array<{ agentId: string; payload: any }> = [];
  await broadcastAndDeliver(io, orchestratorSink(delivered), {
    channelId: threadChannel.id,
    senderType: "user",
    senderId: owner.id,
    senderName: "tjc-tzOwner",
    content: `@${agent.name} what time is it for me?`,
    mentions: [{ type: "agent", id: agent.id, name: agent.name }] as any,
    randomId: "tjc-tz-random-1",
    senderTimezone: "Europe/Berlin",
  });
  await settle();

  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "agent must receive the mention");
  assert.equal(got.payload.sender_timezone, "Europe/Berlin");
  assert.equal(got.payload.thread_join_context.parent_message.sender_timezone, "Asia/Shanghai");
  assert.ok(got.payload.thread_join_context.recent_messages.length > 0);
  for (const recent of got.payload.thread_join_context.recent_messages) {
    assert.equal(recent.sender_timezone, "America/New_York");
  }
  const [stored] = await db.select({ senderTimezone: messages.senderTimezone })
    .from(messages)
    .where(eq(messages.randomId, "tjc-tz-random-1"));
  assert.equal(stored?.senderTimezone, "Europe/Berlin", "randomId sends persist the zone");
});

test("sender_timezone is persisted on direct sends and forced to null for agent senders", async ({ db: _database }) => {
  stubIoAndPushDeps();
  const { db, owner, agent, parentMessage } = await seed("tjc-tz-agent");
  const [listener] = await db.insert(agents).values({
    serverId: (await db.select({ serverId: channels.serverId }).from(channels).where(eq(channels.id, parentMessage.channelId)))[0]!.serverId,
    name: "tjc-tz-agent-listener",
    status: "active",
  }).returning();
  await db.insert(channelAgents).values({ channelId: parentMessage.channelId, agentId: listener.id });

  const humanDelivered: Array<{ agentId: string; payload: any }> = [];
  const human = await broadcastAndDeliver(io, orchestratorSink(humanDelivered), {
    channelId: parentMessage.channelId,
    senderType: "user",
    senderId: owner.id,
    senderName: "tjc-tz-agentOwner",
    content: "no randomId on this send",
    senderTimezone: "Asia/Kolkata",
  });
  await settle();
  const [humanRow] = await db.select({ senderTimezone: messages.senderTimezone }).from(messages).where(eq(messages.id, human.id));
  assert.equal(humanRow?.senderTimezone, "Asia/Kolkata");
  assert.equal(humanDelivered.find((delivery) => delivery.agentId === listener.id)?.payload.sender_timezone, "Asia/Kolkata");

  const agentDelivered: Array<{ agentId: string; payload: any }> = [];
  const sent = await broadcastAndDeliver(io, orchestratorSink(agentDelivered), {
    channelId: parentMessage.channelId,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    content: "an agent never carries a browser zone",
    senderTimezone: "Asia/Tokyo",
  });
  await settle();
  const [agentRow] = await db.select({ senderTimezone: messages.senderTimezone }).from(messages).where(eq(messages.id, sent.id));
  assert.equal(agentRow?.senderTimezone, null);
  const toListener = agentDelivered.find((delivery) => delivery.agentId === listener.id);
  assert.ok(toListener, "the other agent must receive the agent's message");
  assert.equal(toListener.payload.sender_timezone, null);
});

// A Free server's 30-day history window (services/historyWindow.ts): the
// context a thread mention carries stays inside it.
const FORTY_DAYS_AGO = () => new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

test("Free: the join context's recent replies stop at the history window", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { agent, delivered } = await mentionIntoThread("tjc-hw", {
    beforeMention: async ({ db, threadChannel }) => {
      const replies = await db.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.channelId, threadChannel.id), inArray(messages.content, [1, 2, 3, 4, 5, 6].map((n) => `earlier unseen reply ${n}`))));
      await db.update(messages).set({ createdAt: FORTY_DAYS_AGO() }).where(inArray(messages.id, replies.map((reply) => reply.id)));
    },
  });
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got?.payload.thread_join_context);
  assert.deepEqual(
    got.payload.thread_join_context.recent_messages.map((message: any) => message.content),
    ["earlier unseen reply 7", "earlier unseen reply 8"],
  );
  assert.equal(got.payload.thread_join_context.history_truncated, false);
});

test("Free: a thread whose start is behind the history window delivers the mention without a join context", async ({ db: database }) => {

  stubIoAndPushDeps();
  const { agent, delivered } = await mentionIntoThread("tjc-hp", {
    beforeMention: async ({ db, parentMessage }) => {
      await db.update(messages).set({ createdAt: FORTY_DAYS_AGO() }).where(eq(messages.id, parentMessage.id));
    },
  });
  const got = delivered.find((delivery) => delivery.agentId === agent.id);
  assert.ok(got, "the mention itself is delivered");
  assert.equal(got.payload.thread_join_context, undefined, "the thread start is not the agent's to read");
});
