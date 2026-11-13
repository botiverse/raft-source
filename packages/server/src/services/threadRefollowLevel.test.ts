// An automatic re-follow (replying again, being mentioned) resets a stored
// thread level of `mentions` (= unfollowed) to NULL (`default`) and keeps an
// explicit `none` (docs/contracts/notifications.md §1.1). `all` stays.
import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { messageMentions, threadFollows } from "../db/schema";
import { followThread, getOrCreateThread, unfollowThread } from "./channelService";
import { broadcastAndDeliver, drainSenderReadReceiptsForTests } from "./messageService";
import { executeMentionActionId } from "./mentionActionService";
import { withChannelDelivery } from "../test/orchestratorStub";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setNotificationDispatchRuntimeForTests,
  registerNotificationSocketServer,
} from "./notifications/dispatcher";

type Human = { id: string; name: string };
type Level = "default" | "all" | "mentions" | "none";

const io = {
  to() { return { emit() {} }; },
  in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {}, emit() {} }; },
  emit() {},
} as any;
const orchestrator = withChannelDelivery({ deliverMessage: async () => ({ status: "queued" }) }) as any;

beforeEach(() => {
  registerNotificationSocketServer(null);
  __setNotificationDispatchRuntimeForTests({ schedule: () => {} });
});

afterEach(async () => {
  __resetNotificationDispatchRuntimeForTests();
  await drainSenderReadReceiptsForTests();
});

async function send(channelId: string, sender: Human, content: string, mentions: Human[] = []) {
  return broadcastAndDeliver(io, orchestrator, {
    channelId,
    senderType: "user",
    senderId: sender.id,
    senderName: sender.name,
    content,
    mentions: mentions.map((person) => ({ type: "user" as const, id: person.id, name: person.name })),
  });
}

async function followOf(threadId: string, userId: string) {
  const [row] = await getDb().select().from(threadFollows).where(and(
    eq(threadFollows.threadChannelId, threadId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, userId),
  ));
  assert.ok(row, "a follow row");
  return row;
}

/** Precondition: the stored thread level and follow state a user write leaves (unfollowed for mentions / none). */
async function storeLevel(threadId: string, parentId: string, userId: string, level: Level) {
  await followThread(userId, threadId, parentId);
  if (level === "mentions" || level === "none") await unfollowThread(userId, threadId);
  await getDb().update(threadFollows).set({ notificationLevel: level }).where(and(
    eq(threadFollows.threadChannelId, threadId),
    eq(threadFollows.followerType, "user"),
    eq(threadFollows.followerId, userId),
  ));
}

async function seedThread(seed: any) {
  const pat = await seed.human({ name: "pat" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: pat, members: [bob] });
  const channel = await seed.channel({ server, members: [pat, bob], name: "eng" });
  const parent = await send(channel.id, pat, "parent");
  const thread = await getOrCreateThread(parent.id, pat.id, "user");
  return { pat, bob, server, channel, parent, thread };
}

test("own reply re-follows: a stored mentions level goes back to NULL", async ({ seed }) => {
  const { bob, parent, thread } = await seedThread(seed);
  await storeLevel(thread.id, parent.id, bob.id, "mentions");
  assert.ok((await followOf(thread.id, bob.id)).unfollowedAt, "precondition: unfollowed");

  await send(thread.id, bob, "my reply");
  const row = await followOf(thread.id, bob.id);
  assert.equal(row.unfollowedAt, null, "the reply re-follows");
  assert.equal(row.notificationLevel, null, "mentions is reset to default");
});

test("own reply keeps an explicit none, and a stored all", async ({ seed }) => {
  const { pat, bob, parent, thread } = await seedThread(seed);
  await storeLevel(thread.id, parent.id, bob.id, "none");
  await storeLevel(thread.id, parent.id, pat.id, "all");

  await send(thread.id, bob, "bob reply");
  await send(thread.id, pat, "pat reply");
  assert.equal((await followOf(thread.id, bob.id)).notificationLevel, "none", "none stays silent");
  assert.equal((await followOf(thread.id, pat.id)).notificationLevel, "all", "all stays");
});

test("an @mention re-follows a parent member: mentions -> NULL", async ({ seed }) => {
  const { pat, bob, parent, thread } = await seedThread(seed);
  await storeLevel(thread.id, parent.id, bob.id, "mentions");

  await send(thread.id, pat, `@${bob.name} look`, [bob]);
  const row = await followOf(thread.id, bob.id);
  assert.equal(row.unfollowedAt, null, "the mention re-follows");
  assert.equal(row.notificationLevel, null);
});

test("mention action add re-follows: mentions -> NULL, none stays", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const out = await seed.human({ name: "out" });
  const non = await seed.human({ name: "non" });
  const server = await seed.server({ owner: ann, members: [out, non] });
  const channel = await seed.channel({ server, members: [ann], name: "eng" });
  const parent = await send(channel.id, ann, "parent");
  const thread = await getOrCreateThread(parent.id, ann.id, "user");
  // Server members outside the public parent channel who followed and then set the thread level.
  await storeLevel(thread.id, parent.id, out.id, "mentions");
  await storeLevel(thread.id, parent.id, non.id, "none");

  const sent = await send(thread.id, ann, `@${out.name} @${non.name} look`, [out, non]);
  const mentionRows = await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, sent.id));
  for (const person of [out, non]) {
    const row = mentionRows.find((mention) => mention.targetId === person.id);
    assert.ok(row, `the mention of ${person.name} is stored`);
    assert.equal(row.notifiableAtSend, false, "outside the parent channel: a mention action");
    assert.ok((await followOf(thread.id, person.id)).unfollowedAt, "the send itself does not re-follow");
    const result = await executeMentionActionId(row.id, server.id, "user", ann.id, "add");
    assert.equal(result.status, "delivered");
  }

  const outRow = await followOf(thread.id, out.id);
  assert.equal(outRow.unfollowedAt, null, "add re-follows");
  assert.equal(outRow.notificationLevel, null, "mentions is reset to default");
  assert.equal((await followOf(thread.id, non.id)).notificationLevel, "none", "an explicit none stays");
});
