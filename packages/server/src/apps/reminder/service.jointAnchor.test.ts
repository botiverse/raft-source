// #460: a joint channel's messages are stored once, in the joint's storage
// channel (a channel of the `joint_storage` server named
// `joint-storage-<uuid>`). A reminder anchored on one names it by the
// reminder's server's own projection of the joint (its name, a link into it),
// never by the storage channel; a server with no projection of it gets no
// anchor ref at all. Anchors outside a joint render as before.
import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase } from "../../test/integration/database";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/index";
import { agents, channelAgents, channelHumans, channels, jointChannels, jointChannelServers, messages, servers, users } from "../../db/schema";
import { getOrCreateThreadForChannel } from "../../services/channelService";
import { createReminder, deliverLegacyReminderWake, fireReminder, toReminderSummaries, type TimeProvider } from "./service";

afterEach(async () => {
  await closeTestDatabase();
});

const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const FIXED_CLOCK: TimeProvider = { now: () => FIXED_NOW };

async function jointFixture(db: Database) {
  const [owner, sender] = await db.insert(users).values(
    ["owner", "sender"].map((name) => ({ email: `reminder-joint-${name}@test.com`, name: `rj${name}`, passwordHash: "x", emailVerified: true })),
  ).returning();
  const [host, reader, outsider, storage] = await db.insert(servers).values([
    { name: "RJ Host", slug: "rj-host", ownerId: owner!.id },
    { name: "RJ Reader", slug: "rj-reader", ownerId: owner!.id },
    { name: "RJ Outsider", slug: "rj-outsider", ownerId: owner!.id },
    { name: "RJ Storage", slug: "__rj_storage__", ownerId: owner!.id, kind: "joint_storage" },
  ]).returning();
  // As channelService creates it: the storage channel is a plain "channel" of the storage server.
  const [canonical, hostLocal, readerLocal, general] = await db.insert(channels).values([
    { serverId: storage!.id, name: "joint-storage-00000000-0000-4000-8000-000000000460", type: "channel" },
    { serverId: host!.id, name: "host-room", type: "joint" },
    { serverId: reader!.id, name: "reader-room", type: "joint" },
    { serverId: reader!.id, name: "general", type: "channel" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical!.id, createdByServerId: host!.id, createdByUserId: owner!.id,
  }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host!.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: owner!.id },
    { jointChannelId: joint!.id, serverId: reader!.id, localChannelId: readerLocal!.id, role: "participant", status: "active", joinedByUserId: owner!.id },
  ]);
  const [agent, outsiderAgent] = await db.insert(agents).values([
    { serverId: reader!.id, name: "rj-agent", status: "active" },
    { serverId: outsider!.id, name: "rj-outsider-agent", status: "active" },
  ]).returning();
  await db.insert(channelHumans).values({ channelId: hostLocal!.id, userId: sender!.id });
  await db.insert(channelAgents).values([{ channelId: readerLocal!.id, agentId: agent!.id }, { channelId: general!.id, agentId: agent!.id }]);
  const [jointMessage, parent, plain] = await db.insert(messages).values([
    { channelId: canonical!.id, senderType: "user", senderId: sender!.id, content: "joint message" },
    { channelId: canonical!.id, senderType: "user", senderId: sender!.id, content: "joint parent" },
    { channelId: general!.id, senderType: "user", senderId: sender!.id, content: "plain message" },
  ]).returning();
  const thread = await getOrCreateThreadForChannel(hostLocal!.id, parent!.id, sender!.id, "user");
  const [readerThread] = await db
    .select({ localChannelId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(eq(jointChannels.canonicalChannelId, thread.canonicalThreadChannelId), eq(jointChannelServers.serverId, reader!.id)));
  assert.ok(readerThread, "the reader server has its own projection of the joint thread");
  const [reply] = await db.insert(messages).values({
    channelId: thread.canonicalThreadChannelId, senderType: "user", senderId: sender!.id, content: "joint reply",
  }).returning();
  const remind = (serverId: string, ownerAgentId: string, msgId: string, title: string) => createReminder({
    serverId, ownerAgentId, msgId, title, fireAt: new Date("2026-04-20T11:00:00.000Z"), payload: null, createdBy: { type: "human", id: owner!.id },
  }, { clock: FIXED_CLOCK });
  return { reader, outsider, canonical: canonical!, readerLocal: readerLocal!, general: general!, agent: agent!, outsiderAgent: outsiderAgent!, jointMessage: jointMessage!, parent: parent!, plain: plain!, reply: reply!, readerThreadId: readerThread.localChannelId, remind };
}

async function withAppUrl<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.APP_URL;
  process.env.APP_URL = "https://app.example.test";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
  }
}

test("#460: a reminder on a joint message or joint thread names the reminder's server's projection and links into it", async ({ db }) => {
  const f = await jointFixture(db);
  const onJoint = await f.remind(f.reader!.id, f.agent.id, f.jointMessage.id, "joint top-level");
  const onThread = await f.remind(f.reader!.id, f.agent.id, f.reply.id, "joint thread");
  const onPlain = await f.remind(f.reader!.id, f.agent.id, f.plain.id, "plain");

  const summaries = await withAppUrl(() => toReminderSummaries([onJoint, onThread, onPlain], f.reader!.id));
  const byId = new Map(summaries.map((summary) => [summary.reminderId, summary]));

  const joint = byId.get(onJoint.id)!;
  assert.equal(joint.msgRef, `#reader-room:${f.jointMessage.id.slice(0, 8)}`);
  assert.equal(joint.msgPermalink, `https://app.example.test/s/rj-reader/channel/${f.readerLocal.id}?msg=${f.jointMessage.id}`);

  const thread = byId.get(onThread.id)!;
  assert.equal(thread.msgRef, `#reader-room:${f.parent.id.slice(0, 8)}`);
  const threadLink = new URL(thread.msgPermalink!);
  assert.equal(threadLink.pathname, `/s/rj-reader/channel/${f.readerLocal.id}`);
  assert.equal(threadLink.searchParams.get("thread"), `${f.readerLocal.id}:${f.parent.id}`);
  assert.equal(threadLink.searchParams.get("msg"), f.reply.id);

  for (const summary of summaries) {
    assert.ok(!summary.msgRef?.includes("joint-storage"), summary.msgRef ?? "");
    assert.ok(!summary.msgPermalink?.includes(f.canonical.id), summary.msgPermalink ?? "");
  }

  // Outside a joint, unchanged.
  const plain = byId.get(onPlain.id)!;
  assert.equal(plain.msgRef, `#general:${f.plain.id.slice(0, 8)}`);
  assert.equal(plain.msgPermalink, `https://app.example.test/s/rj-reader/channel/${f.general.id}?msg=${f.plain.id}`);
});

test("#460: a server with no projection of the joint gets no anchor ref, never the storage channel", async ({ db }) => {
  const f = await jointFixture(db);
  const onJoint = await f.remind(f.outsider!.id, f.outsiderAgent.id, f.jointMessage.id, "outsider");
  const [summary] = await withAppUrl(() => toReminderSummaries([onJoint], f.outsider!.id));
  assert.equal(summary!.msgRef, null);
  assert.equal(summary!.msgPermalink, null);
});

test("#460: the legacy wake for a joint message reaches the owner agent in its server's projection", async ({ db }) => {
  const f = await jointFixture(db);
  const deliveries: Array<{ agentId: string; payload: Record<string, unknown> }> = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: Record<string, unknown>) => {
      deliveries.push({ agentId, payload });
      return { status: "queued" as const };
    },
  };
  for (const msgId of [f.jointMessage.id, f.reply.id]) {
    const reminder = await f.remind(f.reader!.id, f.agent.id, msgId, "wake");
    const fire = await fireReminder(reminder.id, reminder.version, { clock: FIXED_CLOCK });
    assert.ok(fire.ok, fire.ok ? "" : fire.reason);
    assert.equal(await deliverLegacyReminderWake(orchestrator as never, fire.row, { clock: FIXED_CLOCK }), true);
  }
  assert.deepEqual(deliveries.map((delivery) => delivery.agentId), [f.agent.id, f.agent.id]);
  const [top, reply] = deliveries.map((delivery) => delivery.payload);
  assert.equal(top!.channel_id, f.readerLocal.id);
  assert.equal(top!.channel_name, "reader-room");
  assert.equal(top!.channel_type, "joint");
  assert.ok(String(top!.content).includes(` — #reader-room:${f.jointMessage.id.slice(0, 8)} — "`), String(top!.content));

  assert.equal(reply!.channel_id, f.readerThreadId);
  assert.equal(reply!.channel_type, "thread");
  assert.equal(reply!.parent_channel_id, f.readerLocal.id);
  assert.equal(reply!.parent_channel_name, "reader-room");
  assert.ok(String(reply!.content).includes(` — #reader-room:${f.parent.id.slice(0, 8)} — "`), String(reply!.content));
  for (const payload of [top!, reply!]) assert.ok(!JSON.stringify(payload).includes("joint-storage"), JSON.stringify(payload));
});
