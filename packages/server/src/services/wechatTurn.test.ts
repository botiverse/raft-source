import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database, DatabaseExecutor } from "../db/index";
import { agents, agentTurnTriggers, featureFlagRules, featureFlags, wechatBridgeBindings, wechatBridgeInboundMessages } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { findOrCreateDM } from "./channelService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "./featureFlagService";
import { createMessage } from "./messageService";
import type { ILinkBotId, ILinkUserId, WeChatContextToken } from "./wechatILinkClient";
import {
  __resetAssistantWeChatGateCacheForTests,
  recordAssistantTurnTriggers,
  weChatTriggerOf,
  type AssistantTurnIdentity,
} from "./wechatTurn";

// The server's record of a personal assistant's turn (agent_turn_triggers):
// whether a WeChat message is among what it handed over, and from which DM
// (then that DM's top-level replies are mirrored back). A hand-off after the
// agent was observed idle starts a new turn, any other joins the current one;
// a WeChat message merged into a turn makes it a WeChat turn from then on.

const T = Date.UTC(2026, 10, 2, 9, 0, 0);

async function enableWeChat(db: Database, serverId: string, ownerUserId: string) {
  await db.insert(featureFlags).values([
    { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false },
    { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false },
  ]).onConflictDoNothing();
  await db.insert(featureFlagRules).values([
    { flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId] },
    { flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [ownerUserId] },
  ]);
}

async function seedAssistant(db: Database, seed: ReturnType<typeof createSeed>, options: { wechat?: boolean } = {}) {
  __resetAssistantWeChatGateCacheForTests();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `ottie-${randomUUID().slice(0, 8)}`, assistantOwnerUserId: owner.id }).returning();
  const dm = await findOrCreateDM(server.id, owner.id, agent!.id);
  assert.ok(dm, "fixture: the owner's DM with the assistant");
  if (options.wechat !== false) await enableWeChat(db, server.id, owner.id);
  const who: AssistantTurnIdentity = { agentId: agent!.id, serverId: server.id, ownerUserId: owner.id };
  return { owner, server, agent: agent!, dm, who };
}

type Assistant = Awaited<ReturnType<typeof seedAssistant>>;

/** The bridge's step 1: the tag, before any message exists. */
async function tag(db: Database, a: Assistant, bindingId: string | null = null) {
  const randomId = `wechat:${randomUUID()}`;
  await db.insert(wechatBridgeInboundMessages).values({
    ...(bindingId ? { bindingId } : {}),
    ownerUserId: a.owner.id,
    dmChannelId: a.dm.id,
    wechatMessageKey: randomUUID(),
    randomId,
    contextToken: "ctx" as WeChatContextToken,
  });
  return randomId;
}

/** A message the WeChat bridge wrote into the DM (tag first, then the post). */
async function fromWeChat(db: Database, a: Assistant, content = "from wechat") {
  return createMessage(a.dm.id, "user", a.owner.id, content, "chat", undefined, { randomId: await tag(db, a) });
}

async function typedInRaft(a: Assistant, content = "typed in Raft") {
  return createMessage(a.dm.id, "user", a.owner.id, content);
}

async function row(db: Database, agentId: string) {
  const [found] = await db.select().from(agentTurnTriggers).where(eq(agentTurnTriggers.agentId, agentId));
  return found ?? null;
}

test("a WeChat message is recognised as soon as it exists (random_id), after message_id is filled, and after its binding is gone", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const [binding] = await db.insert(wechatBridgeBindings).values({
    serverId: a.server.id,
    userId: a.owner.id,
    agentId: a.agent.id,
    dmChannelId: a.dm.id,
    ilinkBotId: "bot@im.bot" as ILinkBotId,
    ilinkUserId: `u-${randomUUID()}@im.wechat` as ILinkUserId,
    baseUrl: "https://ilinkai.weixin.qq.com",
    encryptedBotToken: "env-aes-256-gcm:v1:sealed",
    envelopeKeyId: "env:WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1",
    aadVersion: 1,
    outboundSeq: 0,
  }).returning();
  const randomId = await tag(db, a, binding!.id);
  const message = await createMessage(a.dm.id, "user", a.owner.id, "from wechat", "chat", undefined, { randomId });
  assert.deepEqual(await weChatTriggerOf([message.id]), { wechat: true, dmChannelId: a.dm.id });
  await db.update(wechatBridgeInboundMessages).set({ messageId: message.id }).where(eq(wechatBridgeInboundMessages.randomId, randomId));
  assert.deepEqual(await weChatTriggerOf([message.id]), { wechat: true, dmChannelId: a.dm.id });
  await db.delete(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, binding!.id));
  assert.deepEqual(await weChatTriggerOf([message.id]), { wechat: true, dmChannelId: a.dm.id });
});

test("unrelated messages are not WeChat: typed in Raft, another person's message with a tag's randomId, an untagged randomId, unknown or malformed ids", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const typed = await typedInRaft(a);
  const randomId = await tag(db, a);
  const intruder = await seed.human();
  const other = await seed.channel({ server: await seed.server({ owner: intruder }), members: [intruder] });
  const theirs = await createMessage(other.id, "user", intruder.id, "same random id", "chat", undefined, { randomId });
  const ownUntagged = await createMessage(a.dm.id, "user", a.owner.id, "never tagged", "chat", undefined, { randomId: `wechat:${randomUUID()}` });
  assert.deepEqual(await weChatTriggerOf([typed.id, theirs.id, ownUntagged.id]), { wechat: false });
  assert.deepEqual(await weChatTriggerOf([]), { wechat: false });
  assert.deepEqual(await weChatTriggerOf([randomUUID(), "not-a-uuid"]), { wechat: false });
});

test("WeChat messages from two DMs, or a lookup that fails, are WeChat with no DM: nothing is mirrored", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const b = await seedAssistant(db, seed);
  const one = await fromWeChat(db, a);
  const two = await fromWeChat(db, b);
  assert.deepEqual(await weChatTriggerOf([one.id, two.id]), { wechat: true, dmChannelId: null });
  const broken = { select() { throw new Error("database unavailable"); } } as unknown as DatabaseExecutor;
  assert.deepEqual(await weChatTriggerOf([one.id], broken), { wechat: true, dmChannelId: null });
});

test("a WeChat hand-off makes a WeChat turn of its DM; a Raft hand-off after the agent went idle starts a turn without WeChat", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const wx = await fromWeChat(db, a);
  const first = await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.id], idleObservedAtMs: null, nowMs: T });
  assert.equal(first?.startedTurn, true);
  assert.deepEqual(first?.wechat, { triggered: true, dmChannelId: a.dm.id });

  // The turn ended (idle observed after the hand-off); the owner then types in Raft.
  const typed = await typedInRaft(a);
  const next = await recordAssistantTurnTriggers({ ...a.who, messageIds: [typed.id], idleObservedAtMs: T + 1_000, nowMs: T + 2_000 });
  assert.equal(next?.startedTurn, true);
  assert.notEqual(next?.turnId, first?.turnId, "the server minted a new turn");
  assert.deepEqual(next?.wechat, { triggered: false });
  const stored = await row(db, a.agent.id);
  assert.deepEqual(stored?.triggerMessageIds, [typed.id]);
  assert.equal(stored?.wechatRestricted, false);
});

test("a WeChat message merged into a Raft turn makes it a WeChat turn from then on, until the turn ends", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const typed = await typedInRaft(a);
  const raftTurn = await recordAssistantTurnTriggers({ ...a.who, messageIds: [typed.id], idleObservedAtMs: null, nowMs: T });
  assert.deepEqual(raftTurn?.wechat, { triggered: false });

  // Not idle since: the WeChat message joins the Raft turn.
  const wx = await fromWeChat(db, a);
  const merged = await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.id], idleObservedAtMs: null, nowMs: T + 1_000 });
  assert.equal(merged?.startedTurn, false);
  assert.equal(merged?.turnId, raftTurn?.turnId);
  assert.deepEqual(merged?.wechat, { triggered: true, dmChannelId: a.dm.id });

  // An idle observation from before the latest hand-off is not the turn's end: a later Raft message joins, still a WeChat turn.
  const typedAgain = await typedInRaft(a, "another");
  const joined = await recordAssistantTurnTriggers({ ...a.who, messageIds: [typedAgain.id], idleObservedAtMs: T - 5_000, nowMs: T + 2_000 });
  assert.equal(joined?.startedTurn, false);
  assert.deepEqual(joined?.wechat, { triggered: true, dmChannelId: a.dm.id });
  assert.deepEqual((await row(db, a.agent.id))?.triggerMessageIds, [typed.id, wx.id, typedAgain.id]);
});

test("a scheduled turn (a hand-off of app events only, no message) after the agent went idle has no WeChat", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const wx = await fromWeChat(db, a);
  await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.id], idleObservedAtMs: null, nowMs: T });
  const scheduled = await recordAssistantTurnTriggers({ ...a.who, messageIds: ["evt_not_a_message"], idleObservedAtMs: T + 1_000, nowMs: T + 2_000 });
  assert.equal(scheduled?.startedTurn, true);
  assert.deepEqual(scheduled?.wechat, { triggered: false });
  assert.deepEqual((await row(db, a.agent.id))?.triggerMessageIds, []);
});

test("a WeChat turn whose DM cannot be told mirrors nothing, and stays so for the rest of the turn", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed);
  const b = await seedAssistant(db, seed);
  const mine = await fromWeChat(db, a);
  const theirs = await fromWeChat(db, b);
  const ambiguous = await recordAssistantTurnTriggers({ ...a.who, messageIds: [mine.id, theirs.id], idleObservedAtMs: null, nowMs: T });
  assert.deepEqual(ambiguous?.wechat, { triggered: true, dmChannelId: null });
  // A later, decidable WeChat message in the same turn does not bring the DM back.
  const again = await fromWeChat(db, a);
  const joined = await recordAssistantTurnTriggers({ ...a.who, messageIds: [again.id], idleObservedAtMs: null, nowMs: T + 1_000 });
  assert.deepEqual(joined?.wechat, { triggered: true, dmChannelId: null });

  // A tag whose DM is not this assistant's DM with its owner: no DM either.
  const c = await seedAssistant(db, seed);
  const foreign = await recordAssistantTurnTriggers({ ...c.who, messageIds: [theirs.id], idleObservedAtMs: null, nowMs: T });
  assert.deepEqual(foreign?.wechat, { triggered: true, dmChannelId: null });
});

test("with the WeChat flag off nothing is recorded", async ({ db, seed }) => {
  const a = await seedAssistant(db, seed, { wechat: false });
  const wx = await fromWeChat(db, a);
  assert.equal(await recordAssistantTurnTriggers({ ...a.who, messageIds: [wx.id], idleObservedAtMs: null, nowMs: T }), null);
  assert.equal(await row(db, a.agent.id), null);
});
