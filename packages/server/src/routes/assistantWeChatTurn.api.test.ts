// A personal assistant's WeChat messages on its main line (design "微信接入
// Ottie", #proj-assistant:742b8915): they reach the assistant through its own
// credential like the owner's DM messages, it reads everything as usual, and
// the server records what it hands over (`/events`, services/wechatTurn.ts)
// only to decide which replies go back to WeChat (wechatMirrorDecision.ts).
// Its push registration is set only by its runtime provider while the flags
// are on (routes/runtimeProviderControl.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentInboxPushRegistrations, agentRuntimeProvisions, agents, agentTurnTriggers, featureFlagRules, featureFlags, integrationAuditEvents, wechatBridgeInboundMessages } from "../db/schema";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel, findOrCreateDM } from "../services/channelService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { __setExternalAgentInboxChainSelectorForTests, createMessage } from "../services/messageService";
import { addMember } from "../services/serverService";
import type { WeChatContextToken } from "../services/wechatILinkClient";
import { getWeChatMirrorDecision } from "../services/wechatMirrorDecision";
import { __resetAssistantWeChatGateCacheForTests } from "../services/wechatTurn";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { withHostedRuntime } from "../test/hostedAssistantFixture";
import { createServer, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

// CI has no RisingWave: an external agent's inbox pull reads the test-only reference chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));

type App = { app: { set(name: string, value: unknown): unknown }; baseUrl: string };

async function enableFlags(serverId: string, wechatForUserId: string | null) {
  await getDb().insert(featureFlags).values([
    { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false },
    { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false },
  ]).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId] });
  if (wechatForUserId) {
    await getDb().insert(featureFlagRules).values({ flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [wechatForUserId] });
  }
}

async function seedFixture(app: App, options: { wechat?: boolean } = {}) {
  __resetAssistantWeChatGateCacheForTests();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`wx-turn-owner-${suffix}@slock.test`, `wx-turn-owner-${suffix}`);
  const peer = await seedUser(`wx-turn-peer-${suffix}@slock.test`, `wx-turn-peer-${suffix}`);
  const server = await createServer("WeChat Turn", `wx-turn-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);
  await createMessage(room.id, "user", peer.id, "room activity");

  // Hosted like every assistant: messages reach it through its inbox pull.
  const assistant = await createAgent(server.id, `ottie-${suffix}`, { runtime: "external", model: "external", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const dm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(dm, "fixture: the owner's DM with the assistant");
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send", "reactions"], name: "ottie", issuedVia: "computer", createdByUserId: null });
  await enableFlags(server.id, options.wechat === false ? null : owner.id);

  // The idle observation the turn record reads; null = busy.
  const orchestrator = new AgentOrchestrator();
  let idleObservedAtMs: number | null = null;
  Object.assign(orchestrator, { getTurnIdleObservedAtMs: async () => idleObservedAtMs });
  app.app.set("agentOrchestrator", orchestrator);
  return {
    owner, peer, server, room, assistant, dm, apiKey,
    /** The assistant's runtime reported its turn ended (now). */
    idle() { idleObservedAtMs = Date.now(); },
    busy() { idleObservedAtMs = null; },
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

/** A message the WeChat bridge wrote into the owner's DM (tag first, then the post as the owner). */
async function fromWeChat(f: Fixture, content: string) {
  return (await fromWeChatWithRandomId(f, content)).message;
}

async function fromWeChatWithRandomId(f: Fixture, content: string) {
  const randomId = `wechat:${randomUUID()}`;
  await getDb().insert(wechatBridgeInboundMessages).values({
    ownerUserId: f.owner.id,
    dmChannelId: f.dm.id,
    wechatMessageKey: randomUUID(),
    randomId,
    contextToken: "ctx" as WeChatContextToken,
  });
  return { message: await createMessage(f.dm.id, "user", f.owner.id, content, "chat", undefined, { randomId }), randomId };
}

/** The assistant's inbox pull: the hand-off the server records. */
async function pull(baseUrl: string, f: Fixture): Promise<string[]> {
  const res = await call(baseUrl, f.apiKey, "GET", "/events");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body.events as Array<{ message_id?: string }>).flatMap((event) => event.message_id ? [event.message_id] : []);
}

const dmHistory = (f: Fixture) => `/history?channel=${encodeURIComponent(`dm:@${f.owner.name}`)}&consume=false`;

test("a WeChat message reaches the assistant's own credential like the owner's DM message, and the turn reads everything as usual", async ({ app }) => {
  const f = await seedFixture(app);
  const wx = await fromWeChat(f, "what's on today?");
  const typed = await createMessage(f.dm.id, "user", f.owner.id, "typed in Raft");
  const handed = await pull(app.baseUrl, f);
  assert.ok(handed.includes(wx.id), "the WeChat message was handed over on the main line");
  assert.ok(handed.includes(typed.id), "and the owner's Raft message with it");
  const [turn] = await getDb().select().from(agentTurnTriggers).where(eq(agentTurnTriggers.agentId, f.assistant.id));
  assert.equal(turn?.wechatRestricted, true, "a WeChat turn (for the mirror only)");

  // The DM, WeChat message included.
  const history = await call(app.baseUrl, f.apiKey, "GET", dmHistory(f));
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const contents = (history.body.messages as Array<{ content: string }>).map((m) => m.content);
  assert.ok(contents.includes("what's on today?") && contents.includes("typed in Raft"), contents.join(" | "));
  // Everything an assistant may read, during the WeChat turn: nothing is refused for it.
  for (const [method, path, body] of [
    ["GET", `/assistant/owner-messages?channelId=${f.room.id}`, undefined],
    ["GET", "/assistant/owner-inbox?filter=unread&limit=50", undefined],
    ["GET", "/assistant/owner-activity", undefined],
    ["GET", `/assistant/owner-resolve?name=${encodeURIComponent(`@${f.peer.name}`)}`, undefined],
    ["GET", "/assistant/told", undefined],
    ["GET", "/context", undefined],
  ] as const) {
    const res = await call(app.baseUrl, f.apiKey, method, path, body);
    assert.equal(res.status, 200, `${method} ${path}: ${JSON.stringify(res.body)}`);
  }
  // Search is never an assistant's (RFC 075 allowlist), WeChat or not.
  const search = await call(app.baseUrl, f.apiKey, "GET", `/search?${new URLSearchParams({ q: "room", limit: "10" })}`);
  assert.equal(search.status, 403);
  assert.equal(search.body.code, "assistant_route_not_allowed");
});

test("a WeChat turn whose DM cannot be told still reads as usual; it only mirrors nothing", async ({ app }) => {
  const f = await seedFixture(app);
  await getDb().insert(agentTurnTriggers).values({
    agentId: f.assistant.id,
    turnId: randomUUID(),
    triggerMessageIds: [],
    wechatRestricted: true,
    wechatAllowedChannelId: null,
    turnStartedAt: new Date(),
    lastTriggerAt: new Date(),
  });
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", dmHistory(f))).status, 200);
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`)).status, 200);
  const sent = await reply(app.baseUrl, f, "answer");
  assert.deepEqual(await getWeChatMirrorDecision(sent), { mirror: false });
});

test("with the WeChat flag off nothing changes: no turn is recorded and the assistant reads as before", async ({ app }) => {
  const f = await seedFixture(app, { wechat: false });
  const wx = await fromWeChat(f, "from WeChat");
  assert.ok((await pull(app.baseUrl, f)).includes(wx.id));
  const [recorded] = await getDb().select().from(agentTurnTriggers).where(eq(agentTurnTriggers.agentId, f.assistant.id));
  assert.equal(recorded, undefined);
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`)).status, 200);
});

test("an agent that is not a personal assistant is unaffected", async ({ app }) => {
  const f = await seedFixture(app);
  const ordinary = await createAgent(f.server.id, `ordinary-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external", creatorType: "user", creatorId: f.owner.id });
  await addAgent(f.room.id, ordinary.id);
  const { apiKey } = await mintAgentCredential({ agentId: ordinary.id, scopes: ["read"], name: "ordinary", issuedVia: "computer", createdByUserId: null });
  // With the flags on for the server and a WeChat message in flight.
  await fromWeChat(f, "from WeChat");
  const events = await call(app.baseUrl, apiKey, "GET", "/events");
  assert.equal(events.status, 200);
  const room = await call(app.baseUrl, apiKey, "GET", `/history?channel=${encodeURIComponent(`#${f.room.name}`)}&consume=false`);
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const [recorded] = await getDb().select().from(agentTurnTriggers).where(eq(agentTurnTriggers.agentId, ordinary.id));
  assert.equal(recorded, undefined);
});

/** The assistant replies in its DM with the owner (the Agent API send); returns the message id. */
async function reply(baseUrl: string, f: Fixture, content: string): Promise<string> {
  const res = await call(baseUrl, f.apiKey, "POST", "/v2/send", { target: `dm:@${f.owner.name}`, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, "sent", JSON.stringify(res.body));
  return res.body.messageId as string;
}

test("WeChat mirror: a reply in the DM during a WeChat turn is mirrored, answering the turn's latest WeChat message", async ({ app }) => {
  const f = await seedFixture(app);
  const first = await fromWeChatWithRandomId(f, "first from WeChat");
  await pull(app.baseUrl, f);
  const firstReply = await reply(app.baseUrl, f, "answer one");
  assert.deepEqual(await getWeChatMirrorDecision(firstReply), { mirror: true, inboundRandomId: first.randomId });

  // A second WeChat message joins the turn: later replies answer it.
  const second = await fromWeChatWithRandomId(f, "second from WeChat");
  await pull(app.baseUrl, f);
  const secondReply = await reply(app.baseUrl, f, "answer two");
  assert.deepEqual(await getWeChatMirrorDecision(secondReply), { mirror: true, inboundRandomId: second.randomId });
  assert.deepEqual(await getWeChatMirrorDecision(firstReply), { mirror: true, inboundRandomId: first.randomId }, "decided at send time");
});

test("WeChat mirror: a Raft-triggered turn summarising another channel into the DM is never mirrored", async ({ app }) => {
  const f = await seedFixture(app);
  await createMessage(f.dm.id, "user", f.owner.id, "what happened in the room?");
  await pull(app.baseUrl, f);
  assert.equal((await call(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`)).status, 200);
  const summary = await reply(app.baseUrl, f, "the room says: room activity");
  assert.deepEqual(await getWeChatMirrorDecision(summary), { mirror: false });
});

test("WeChat mirror: a WeChat message injected mid-turn marks only the replies sent after it", async ({ app }) => {
  const f = await seedFixture(app);
  await createMessage(f.dm.id, "user", f.owner.id, "typed in Raft");
  await pull(app.baseUrl, f);
  const before = await reply(app.baseUrl, f, "before the WeChat message");

  const wx = await fromWeChatWithRandomId(f, "mid-turn from WeChat");
  await pull(app.baseUrl, f);
  const after = await reply(app.baseUrl, f, "after the WeChat message");

  assert.deepEqual(await getWeChatMirrorDecision(before), { mirror: false });
  assert.deepEqual(await getWeChatMirrorDecision(after), { mirror: true, inboundRandomId: wx.randomId });
});

test("WeChat mirror: with the WeChat flag off nothing is marked", async ({ app }) => {
  const f = await seedFixture(app, { wechat: false });
  await fromWeChat(f, "from WeChat");
  await pull(app.baseUrl, f);
  const sent = await reply(app.baseUrl, f, "answer");
  assert.deepEqual(await getWeChatMirrorDecision(sent), { mirror: false });
});

// ── Push registration: the runtime provider's, while the WeChat flags are on ──

/** withHostedRuntime's provisioning token: the provider's own credential. */
const PROVIDER_TOKEN = "pt-fake-provider-token-0123456789abcdef";
const PUSH_SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x";
const PUSH_ENDPOINT = "https://receiver.example.com/raft/inbox";

/** The fixture's assistant as hosted on antiproton: a live provision and its provider-held credential. */
async function provisioned(f: Fixture) {
  await mintAgentCredential({ agentId: f.assistant.id, scopes: ["read", "send", "reactions"], name: "ottie-provider", issuedVia: "provision", createdByUserId: null });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: f.assistant.id,
    serverId: f.server.id,
    provider: "antiproton",
    state: "active",
    provisionedName: "Ottie",
    provisionedInstructions: "be helpful",
  });
}

async function provider(baseUrl: string, f: Fixture, method: string, body?: unknown, token = PROVIDER_TOKEN) {
  const res = await fetch(`${baseUrl}/internal/runtime-provider/antiproton/agents/${f.assistant.id}/push-webhook`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { /* not JSON */ }
  return { status: res.status, body: parsed, raw: text };
}

test("push: while the WeChat flags are on, the assistant's own credential cannot set or remove its push registration; only its provider can", async ({ app }) => {
  await withHostedRuntime(async () => {
    const f = await seedFixture(app);
    await provisioned(f);
    for (const [method, body] of [["PUT", { url: "https://attacker.example.com/hook", secret: PUSH_SECRET }], ["DELETE", undefined]] as const) {
      const refused = await call(app.baseUrl, f.apiKey, method, "/push-webhook", body);
      assert.equal(refused.status, 403, `${method} ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, "push_registration_provider_managed");
    }
    // The provider route takes only the provider's token: the agent's key, a wrong token or none is 401.
    for (const token of [f.apiKey, "pt-wrong-token-0123456789abcdef0123", ""]) {
      assert.equal((await provider(app.baseUrl, f, "PUT", { url: "https://attacker.example.com/hook", secret: PUSH_SECRET }, token)).status, 401);
      assert.equal((await provider(app.baseUrl, f, "GET", undefined, token)).status, 401);
      assert.equal((await provider(app.baseUrl, f, "DELETE", undefined, token)).status, 401);
    }
    assert.equal((await getDb().select().from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, f.assistant.id))).length, 0);

    // The provider sets it; a `capabilities` field from an older provider is accepted and ignored.
    const put = await provider(app.baseUrl, f, "PUT", { url: PUSH_ENDPOINT, secret: PUSH_SECRET, capabilities: ["session-scope:wechat.v1"] });
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.url, PUSH_ENDPOINT);
    assert.equal(put.body.configuredBy, "provider");
    assert.ok(!("capabilities" in put.body), put.raw);
    assert.ok(!put.raw.includes(PUSH_SECRET));
    const view = await provider(app.baseUrl, f, "GET");
    assert.equal(view.status, 200);
    assert.equal(view.body.configuredBy, "provider");
    assert.equal((await provider(app.baseUrl, f, "DELETE")).status, 204);
    const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.serverId, f.server.id));
    const types = audits.map((event) => event.eventType);
    assert.ok(types.includes("agent_inbox_push.configured") && types.includes("agent_inbox_push.deleted"), types.join(","));
    assert.ok(!JSON.stringify(audits).includes(PUSH_SECRET));
  });
});

test("push: with the WeChat flag off the assistant's own credential manages its push registration as before", async ({ app }) => {
  const f = await seedFixture(app, { wechat: false });
  const put = await call(app.baseUrl, f.apiKey, "PUT", "/push-webhook", { url: PUSH_ENDPOINT, secret: PUSH_SECRET });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const [row] = await getDb().select().from(agentInboxPushRegistrations).where(eq(agentInboxPushRegistrations.agentId, f.assistant.id));
  assert.equal(row?.configuredBy, "agent");
  assert.equal((await call(app.baseUrl, f.apiKey, "DELETE", "/push-webhook")).status, 204);
});
