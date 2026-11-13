import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index";
import { agents, assistantWechatMirrorMarks, featureFlagRules, featureFlags, messages, wechatBridgeInboundMessages } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { findOrCreateDM } from "./channelService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";
import { createMessage } from "./messageService";
import type { WeChatContextToken } from "./wechatILinkClient";
import { getWeChatMirrorDecision, markWeChatMirrorInTransaction } from "./wechatMirrorDecision";
import { __resetAssistantWeChatGateCacheForTests, recordAssistantTurnTriggers, type AssistantTurnIdentity } from "./wechatTurn";

// Only what a personal assistant sends while its turn carries a WeChat message
// (it triggered the turn or was merged into it), into that turn's DM, is marked for the WeChat mirror; everything else is
// `{ mirror: false }`. (The send route's wiring: routes/assistantWeChatTurn.api.test.ts.)

const T = Date.UTC(2026, 10, 2, 9, 0, 0);

async function seedAssistant(db: Database, seed: ReturnType<typeof createSeed>) {
  __resetAssistantWeChatGateCacheForTests();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const room = await seed.channel({ server, members: [owner] });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `ottie-${randomUUID().slice(0, 8)}`, assistantOwnerUserId: owner.id }).returning();
  const dm = await findOrCreateDM(server.id, owner.id, agent!.id);
  assert.ok(dm, "fixture: the owner's DM with the assistant");
  await db.insert(featureFlags).values([
    { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false },
    { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false },
  ]).onConflictDoNothing();
  await db.insert(featureFlagRules).values([
    { flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] },
    { flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [owner.id] },
  ]);
  const who: AssistantTurnIdentity = { agentId: agent!.id, serverId: server.id, ownerUserId: owner.id };
  return { owner, server, room, agent: agent!, dm, who };
}

type Assistant = Awaited<ReturnType<typeof seedAssistant>>;

/** A message the WeChat bridge wrote into the DM; `filled`: the bridge already wrote back message_id. */
async function fromWeChat(db: Database, a: Assistant, filled: boolean) {
  const randomId = `wechat:${randomUUID()}`;
  const [inbound] = await db.insert(wechatBridgeInboundMessages).values({
    ownerUserId: a.owner.id,
    dmChannelId: a.dm.id,
    wechatMessageKey: randomUUID(),
    randomId,
    contextToken: "ctx" as WeChatContextToken,
  }).returning();
  const message = await createMessage(a.dm.id, "user", a.owner.id, "from wechat", "chat", undefined, { randomId });
  if (filled) await db.update(wechatBridgeInboundMessages).set({ messageId: message.id }).where(eq(wechatBridgeInboundMessages.id, inbound!.id));
  return { message, randomId };
}

/** The assistant sends `content` into `channelId`, marked as the send transaction does. */
async function assistantSends(db: Database, a: Assistant, channelId: string, content = "reply") {
  return db.transaction(async (tx) => {
    const message = await createMessage(channelId, "agent", a.agent.id, content, "chat", undefined, undefined, tx);
    const marked = await markWeChatMirrorInTransaction({ agentId: a.agent.id, messageId: message.id, channelId: message.channelId }, tx);
    return { message, marked };
  });
}

test("a reply into the DM of a WeChat turn is mirrored, answering the turn's most recent WeChat trigger", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const older = await fromWeChat(db, a, true);
  const newer = await fromWeChat(db, a, false); // matched by randomId before message_id is filled
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [older.message.id, newer.message.id], idleObservedAtMs: null, nowMs: T });
  const sent = await assistantSends(db, a, a.dm.id);
  assert.equal(sent.marked, true);
  assert.deepEqual(await getWeChatMirrorDecision(sent.message.id), { mirror: true, inboundRandomId: newer.randomId });
  assert.deepEqual(await getWeChatMirrorDecision(sent.message.id.toUpperCase()), { mirror: true, inboundRandomId: newer.randomId });
});

test("a Raft-triggered turn is never mirrored, even into the DM", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const typed = await createMessage(a.dm.id, "user", a.owner.id, "summarise the room for me");
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [typed.id], idleObservedAtMs: null, nowMs: T });
  const sent = await assistantSends(db, a, a.dm.id, "the room says ...");
  assert.equal(sent.marked, false);
  assert.deepEqual(await getWeChatMirrorDecision(sent.message.id), { mirror: false });
});

test("a WeChat message injected mid-turn: replies before it are not mirrored, replies after it are", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const typed = await createMessage(a.dm.id, "user", a.owner.id, "typed in Raft");
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [typed.id], idleObservedAtMs: null, nowMs: T });
  const before = await assistantSends(db, a, a.dm.id, "before");
  const wx = await fromWeChat(db, a, true);
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.message.id], idleObservedAtMs: null, nowMs: T + 1_000 });
  const after = await assistantSends(db, a, a.dm.id, "after");
  assert.deepEqual(await getWeChatMirrorDecision(before.message.id), { mirror: false });
  assert.deepEqual(await getWeChatMirrorDecision(after.message.id), { mirror: true, inboundRandomId: wx.randomId });
});

test("during a WeChat turn, a message in another channel is not mirrored", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const wx = await fromWeChat(db, a, true);
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.message.id], idleObservedAtMs: null, nowMs: T });
  const elsewhere = await assistantSends(db, a, a.room.id, "elsewhere");
  assert.equal(elsewhere.marked, false);
  assert.deepEqual(await getWeChatMirrorDecision(elsewhere.message.id), { mirror: false });
});

test("an unknown or malformed message id is not mirrored; a deleted message loses its mark", async ({ db, seed }) => {
  assert.deepEqual(await getWeChatMirrorDecision(randomUUID()), { mirror: false });
  assert.deepEqual(await getWeChatMirrorDecision("not-a-uuid"), { mirror: false });
  const a = await seedAssistant(db, seed);
  const wx = await fromWeChat(db, a, true);
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.message.id], idleObservedAtMs: null, nowMs: T });
  const sent = await assistantSends(db, a, a.dm.id);
  assert.equal(sent.marked, true);
  await db.delete(messages).where(eq(messages.id, sent.message.id));
  assert.deepEqual(await getWeChatMirrorDecision(sent.message.id), { mirror: false });
  assert.equal((await db.select().from(assistantWechatMirrorMarks).where(eq(assistantWechatMirrorMarks.messageId, sent.message.id))).length, 0);
});
