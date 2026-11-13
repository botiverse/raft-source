// The WeChat bridge's poll and mirror worker (services/wechatBridgeWorker.ts;
// design "微信接入 Ottie" v8-v11) end to end: a scripted iLink that records
// every request, the worker's runner for one binding, and the personal
// assistant answering through the Agent API as production runs it, with its
// one (main) credential: WeChat messages reach it like its owner's DM
// messages; only the replies of a turn a WeChat message triggered or was
// merged into are marked (wechatTurn.ts, wechatMirrorDecision.ts).
//
// What must hold: inbound text from the bound WeChat user only, tagged before
// it is posted as the owner; replays make one message; the greeting once;
// only replies of a WeChat turn go back, with the right context token and the
// Raft message id as client_id, never twice; everything else stays in Raft
// and is only counted; the no-reply notice once per batch; context tokens
// gone after 24 hours; -14 needs a reconnect. And the counter-example: what
// a Raft-triggered turn read elsewhere never reaches any iLink request.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agentInboxPushRegistrations,
  agentRuntimeProvisions,
  agents,
  assistantWechatMirrorMarks,
  channels,
  featureFlagRules,
  featureFlags,
  integrationAuditEvents,
  messages,
  serverSsoConnections,
  serverSsoDomains,
  wechatBridgeBindings,
  wechatBridgeInboundMessages,
  wechatBridgeOutboundMessages,
} from "../db/schema";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { __setAppWebhookEncryptionKeyForTests } from "../services/appWebhookConfigService";
import { getWeChatMirrorDecision } from "../services/wechatMirrorDecision";
import { withHostedRuntime } from "../test/hostedAssistantFixture";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addHuman, createChannel, findOrCreateDM, getOrCreateThreadForChannel } from "../services/channelService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { forgetSsoRequirementCache } from "../services/sso/ssoEnforcement";
import { createSession } from "../services/sessionService";
import { proofForSsoLogin } from "../services/sessionIssueGate";
import { __setExternalAgentInboxChainSelectorForTests, createMessage } from "../services/messageService";
import { addMember } from "../services/serverService";
import { WECHAT_BRIDGE_CREDENTIAL_KEY_ENV, wechatBridgeCredentialCipher } from "../services/wechatBridgeCredentialCipher";
import { pollWeChatAttempt, startWeChatAttempt, wechatAttemptCookie } from "../services/wechatBridgeService";
import {
  claimWeChatBindingLease,
  markWeChatBindingStale,
  startWeChatBridgeWorker,
  sweepWeChatBridgeExpiry,
  WECHAT_BRIDGE_WORKER_DISABLED_ENV,
  WECHAT_NO_REPLY_NOTICE_TEXT,
  WECHAT_PUSH_STOPPED_NOTICE_TEXT,
  WECHAT_RECONNECT_NOTICE_TEXT,
  WeChatBindingRunner,
  weChatBindingGateOpen,
  wechatGreetingText,
  wechatLeftInRaftText,
  type WeChatRunnerDeps,
} from "../services/wechatBridgeWorker";
import {
  __setWeChatILinkTransportForTests,
  createWeChatILinkClient,
  type ILinkBotId,
  type ILinkBotToken,
  type ILinkTransport,
  type ILinkUserId,
  type WeChatContextToken,
} from "../services/wechatILinkClient";
import { __resetAssistantWeChatGateCacheForTests } from "../services/wechatTurn";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { createApiTest } from "../test/integration/apiTest";
import { createServer, seedUser } from "./channels.api.fixtures";

const apiTest = createApiTest();

/**
 * Every case runs with the hosted runtime configured, as an assistant runs in
 * production: its provider registers the push endpoint on the provider's
 * own token.
 */
function test(name: string, body: (context: { app: App }) => Promise<void>) {
  apiTest(name, async ({ app }) => withHostedRuntime(() => body({ app })));
}

/** The receiving runtime's push secret (the provider registers it; notices are signed with it). */
const PUSH_SECRET = "Q2hvb3NlLWEtcmFuZG9tLXNlY3JldC1vZi0zMi1ieXRlcw_x";
/** withHostedRuntime's provisioning token: the provider's own credential. */
const PROVIDER_TOKEN = "pt-fake-provider-token-0123456789abcdef";
__setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));

// CI has no RisingWave: an external agent's inbox pull reads the test-only reference chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

// ── A scripted iLink that records every request ─────────────────────────────

type Captured = { path: string; url: string; body: string; authorization: string };

const ilink = {
  requests: [] as Captured[],
  /** getupdates answers, in order; an empty answer once they run out. */
  updates: [] as Array<Record<string, unknown>>,
  /** Runs while a getupdates is in flight (the long poll), before it answers. */
  duringGetUpdates: null as null | (() => Promise<void>),
  /** sendmessage answers, in order (a function may throw: unreachable); `{ ret: 0 }` once they run out. */
  sends: [] as Array<Record<string, unknown> | (() => Response)>,
  /** The QR binding flow's status answer (a reconnect). */
  qrStatus: { status: "wait" } as Record<string, unknown>,
};

const fakeILink: ILinkTransport = async (url, init) => {
  const path = new URL(url).pathname;
  ilink.requests.push({ path, url, body: init.body ?? "", authorization: init.headers.Authorization ?? "" });
  if (path === "/ilink/bot/getupdates") {
    await ilink.duringGetUpdates?.();
    return Response.json(ilink.updates.shift() ?? { ret: 0, msgs: [] });
  }
  if (path === "/ilink/bot/get_bot_qrcode") return Response.json({ qrcode: "qr-1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/1" });
  if (path === "/ilink/bot/get_qrcode_status") return Response.json(ilink.qrStatus);
  if (path === "/ilink/bot/sendmessage") {
    const answer = ilink.sends.shift();
    return typeof answer === "function" ? answer() : Response.json(answer ?? { ret: 0 });
  }
  return new Response("not found", { status: 404 });
};

const OWNER_WX = "owner-wx@im.wechat";
const BOT_WX = "bot-wx@im.bot";
const BASE_URL = "https://ilinkai.weixin.qq.com";

function wx(input: { id: number; text?: string | null; ctx?: string; from?: string; type?: number; items?: Array<Record<string, unknown>>; createdAtMs?: number }) {
  return {
    message_id: input.id,
    from_user_id: input.from ?? OWNER_WX,
    to_user_id: BOT_WX,
    message_type: input.type ?? 1,
    ...(input.createdAtMs === undefined ? {} : { create_time_ms: input.createdAtMs }),
    context_token: input.ctx ?? `ctx-${input.id}`,
    item_list: input.items ?? (input.text === null ? [] : [{ type: 1, text_item: { text: input.text ?? `message ${input.id}` } }]),
  };
}

function queueUpdates(msgs: Array<Record<string, unknown>>, buf: string) {
  ilink.updates.push({ ret: 0, msgs, get_updates_buf: buf });
}

/** Every sendmessage iLink received: who to, answering which context, with which client id, saying what. */
function sentMessages() {
  return ilink.requests.filter((r) => r.path === "/ilink/bot/sendmessage").map((r) => {
    const { msg } = JSON.parse(r.body) as { msg: { to_user_id: string; client_id: string; context_token?: string; item_list: Array<{ text_item: { text: string } }> } };
    return { to: msg.to_user_id, clientId: msg.client_id, ctx: msg.context_token ?? null, text: msg.item_list[0]!.text_item.text };
  });
}

const savedKey = process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
beforeEach(() => {
  process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = Buffer.alloc(32, 5).toString("base64");
  ilink.requests.length = 0;
  ilink.updates.length = 0;
  ilink.sends.length = 0;
  ilink.duringGetUpdates = null;
  ilink.qrStatus = { status: "wait" };
  __setWeChatILinkTransportForTests(fakeILink);
  __resetAssistantWeChatGateCacheForTests();
});
afterEach(() => {
  __setWeChatILinkTransportForTests(null);
  if (savedKey === undefined) delete process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]; else process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = savedKey;
});

// ── Fixture: an owner, their hosted Ottie, their DM, a room, a binding ──────

type App = { app: { get(name: string): unknown; set(name: string, value: unknown): unknown }; baseUrl: string };

async function enableFlags(serverId: string, userId: string) {
  await getDb().insert(featureFlags).values([
    { key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false },
    { key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false },
  ]).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values([
    { flagKey: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId] },
    { flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [userId] },
  ]);
}

/** A test clock: real time unless moved. */
function clock() {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    advance(ms: number) { offsetMs += ms; },
  };
}

async function seedFixture(app: App, options: { bindingId?: string; ilinkUserId?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`wxw-owner-${suffix}@slock.test`, `wxw-owner-${suffix}`);
  const peer = await seedUser(`wxw-peer-${suffix}@slock.test`, `wxw-peer-${suffix}`);
  const server = await createServer("WeChat Worker", `wxw-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  await addHuman(room.id, peer.id);

  const assistant = await createAgent(server.id, `ottie-${suffix}`, { runtime: "external", model: "external", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const dm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(dm, "fixture: the owner's DM with the assistant");
  // The main credential, held by the runtime provider (as recordAgentProvisioning mints it).
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send", "reactions"], name: "ottie", issuedVia: "provision", createdByUserId: null });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: assistant.id, serverId: server.id, provider: "antiproton", state: "active", provisionedName: "Ottie", provisionedInstructions: "be helpful",
  });
  await enableFlags(server.id, owner.id);
  // The provider registers the runtime's push endpoint.
  const registered = await fetch(`${app.baseUrl}/internal/runtime-provider/antiproton/agents/${assistant.id}/push-webhook`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${PROVIDER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://receiver.example.com/raft/inbox", secret: PUSH_SECRET }),
  });
  assert.equal(registered.status, 200, await registered.text());

  // Busy unless told idle: every hand-off joins the current turn.
  const orchestrator = new AgentOrchestrator();
  let idleObservedAtMs: number | null = null;
  Object.assign(orchestrator, { getTurnIdleObservedAtMs: async () => idleObservedAtMs });
  app.app.set("agentOrchestrator", orchestrator);

  // The binding, as the QR flow leaves it (wechatBridgeService.confirmAttempt).
  const bindingId = options.bindingId ?? randomUUID();
  const botToken = `SECRET-BOT-TOKEN-${suffix}` as ILinkBotToken;
  const ilinkBotId = BOT_WX as ILinkBotId;
  const sealed = wechatBridgeCredentialCipher()!.seal({ bindingId, userId: owner.id, ilinkBotId, botToken });
  const [top] = await getDb().select({ seq: sql<string>`coalesce(max(${messages.seq}), 0)::text` }).from(messages).where(eq(messages.channelId, dm.id));
  await getDb().insert(wechatBridgeBindings).values({
    id: bindingId,
    serverId: server.id,
    userId: owner.id,
    agentId: assistant.id,
    dmChannelId: dm.id,
    ilinkBotId,
    ilinkUserId: (options.ilinkUserId ?? OWNER_WX) as ILinkUserId,
    baseUrl: BASE_URL,
    ...sealed,
    state: "active",
    outboundSeq: Number(top!.seq),
  });

  const time = clock();
  const io = app.app.get("io") as WeChatRunnerDeps["io"];
  const deps = (overrides: Partial<WeChatRunnerDeps> = {}): WeChatRunnerDeps => ({
    io,
    orchestrator,
    client: createWeChatILinkClient(),
    now: time.now,
    leaseMs: 90_000,
    outboundIntervalMs: 2_000,
    noReplyAfterMs: 10 * 60_000,
    minPollIntervalMs: 0,
    ...overrides,
  });
  return {
    owner, peer, server, room, assistant, dm, apiKey, bindingId, botToken, time, io, orchestrator, deps,
    idle() { idleObservedAtMs = Date.now(); },
    /** As if the holder died: its lease runs out, the next replica may claim. */
    async freeLease() {
      await getDb().update(wechatBridgeBindings).set({ leaseExpiresAt: new Date(0) }).where(eq(wechatBridgeBindings.id, bindingId));
    },
    async wechatFlag(on: boolean) {
      if (on) {
        await getDb().insert(featureFlagRules).values({ flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [owner.id] });
      } else {
        await getDb().delete(featureFlagRules).where(and(
          eq(featureFlagRules.flagKey, ASSISTANT_WECHAT_FEATURE_FLAG_KEY),
          sql`${featureFlagRules.values} @> ${JSON.stringify([owner.id])}::jsonb`,
        ));
      }
    },
    /** Claim the binding's lease as a replica and make its runner. */
    async runner(overrides: Partial<WeChatRunnerDeps> = {}) {
      const lease = await claimWeChatBindingLease({ bindingId, owner: `replica-${randomUUID().slice(0, 6)}`, now: time.now() });
      assert.ok(lease, "the binding's lease is free");
      return new WeChatBindingRunner(lease, deps(overrides));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function agentApi(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const eventIds = (body: Record<string, unknown>) => (body.events as Array<{ message_id?: string }>).flatMap((event) => event.message_id ? [event.message_id] : []);

/** A Raft-triggered turn: Ottie pulls its inbox with its credential. */
async function mainPull(baseUrl: string, f: Fixture): Promise<string[]> {
  const res = await agentApi(baseUrl, f.apiKey, "GET", "/events");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return eventIds(res.body);
}

/** Ottie answers in its DM with the owner; the message id. */
async function mainReply(baseUrl: string, f: Fixture, content: string): Promise<string> {
  return send(baseUrl, f.apiKey, f, content);
}

/** A WeChat message reaching Ottie: the same inbox pull as for any DM message (the hand-off makes the turn a WeChat turn). */
const wechatPull = mainPull;

/** Ottie answers in the DM during the WeChat turn: the same send as any reply. */
const wechatReply = mainReply;

async function send(baseUrl: string, apiKey: string, f: Fixture, content: string): Promise<string> {
  const res = await agentApi(baseUrl, apiKey, "POST", "/v2/send", { target: `dm:@${f.owner.name}`, content });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.state, "sent", JSON.stringify(res.body));
  return res.body.messageId as string;
}

async function binding(f: Fixture) {
  const [row] = await getDb().select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, f.bindingId));
  return row!;
}

async function tags(f: Fixture) {
  return getDb().select().from(wechatBridgeInboundMessages)
    .where(eq(wechatBridgeInboundMessages.bindingId, f.bindingId))
    .orderBy(wechatBridgeInboundMessages.wechatMessageKey);
}

async function tagOf(f: Fixture, wechatMessageId: number) {
  const [row] = await getDb().select().from(wechatBridgeInboundMessages).where(and(
    eq(wechatBridgeInboundMessages.bindingId, f.bindingId),
    eq(wechatBridgeInboundMessages.wechatMessageKey, `id:${wechatMessageId}`),
  ));
  return row ?? null;
}

async function outboundState(messageId: string) {
  const [row] = await getDb().select({ state: wechatBridgeOutboundMessages.state }).from(wechatBridgeOutboundMessages)
    .where(eq(wechatBridgeOutboundMessages.messageId, messageId));
  return row?.state ?? null;
}

const MINUTE = 60_000;

// ── Inbound ─────────────────────────────────────────────────────────────────

test("the owner's WeChat text is tagged, posted as the owner with the tag's randomId, greeted once, and Ottie's WeChat-turn reply goes back answering it", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();

  queueUpdates([wx({ id: 101, text: "hello from WeChat", ctx: "ctx-101" })], "buf-1");
  assert.equal(await runner.pollOnce(), true);
  const tag = await tagOf(f, 101);
  assert.ok(tag?.messageId, "the tag has its message");
  assert.match(tag.randomId, /^wechat:[0-9a-f-]{36}$/u);
  assert.equal(tag.contextToken, "ctx-101");
  const [posted] = await getDb().select().from(messages).where(eq(messages.id, tag.messageId));
  assert.deepEqual(
    { channelId: posted!.channelId, senderType: posted!.senderType, senderId: posted!.senderId, content: posted!.content, randomId: posted!.randomId },
    { channelId: f.dm.id, senderType: "user", senderId: f.owner.id, content: "hello from WeChat", randomId: tag.randomId },
  );
  assert.equal((await binding(f)).getUpdatesBuf, "buf-1", "the cursor moved after the post");
  assert.deepEqual(sentMessages(), [
    { to: OWNER_WX, clientId: `raft-wechat-greeting:${f.bindingId}`, ctx: "ctx-101", text: wechatGreetingText(f.owner.displayName!) },
  ]);
  assert.ok(ilink.requests.every((r) => r.authorization === `Bearer ${f.botToken}`), "every request carries the binding's own token");

  // Ottie takes the message (a WeChat turn) and answers.
  assert.ok((await wechatPull(app.baseUrl, f)).includes(tag.messageId));
  const first = await wechatReply(app.baseUrl, f, "hi, Ottie here");
  assert.equal(await runner.outboundOnce(), true);
  assert.deepEqual(sentMessages().at(-1), { to: OWNER_WX, clientId: first, ctx: "ctx-101", text: "hi, Ottie here" });
  assert.equal(await outboundState(first), "sent");
  assert.ok((await binding(f)).lastMirroredAt, "a mirrored reply ends the batch");

  // A second WeChat message joins the turn: no second greeting; the next reply answers it.
  queueUpdates([wx({ id: 102, text: "and another thing", ctx: "ctx-102" })], "buf-2");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const second = await wechatReply(app.baseUrl, f, "noted");
  await runner.outboundOnce();
  await runner.outboundOnce();
  const sent = sentMessages();
  assert.equal(sent.filter((m) => m.clientId.startsWith("raft-wechat-greeting:")).length, 1, "greeted once per binding");
  assert.deepEqual(sent.at(-1), { to: OWNER_WX, clientId: second, ctx: "ctx-102", text: "noted" });
  assert.equal(sent.filter((m) => m.clientId === first || m.clientId === second).length, 2, "each reply once");
  assert.equal((await binding(f)).getUpdatesBuf, "buf-2");
});

test("a redelivered message, and a replay after a crash between the tag and the post, make one tag and one message", async ({ app }) => {
  const f = await seedFixture(app);
  // A replica that dies between tagging and posting (here: it cannot post at all).
  const crashing = await f.runner({ io: undefined });
  queueUpdates([wx({ id: 201, text: "posted once" })], "buf-201");
  await assert.rejects(crashing.pollOnce());
  const tagged = await tagOf(f, 201);
  assert.ok(tagged, "tagged before the post");
  assert.equal(tagged.messageId, null);
  assert.equal((await binding(f)).getUpdatesBuf, null, "the cursor stays until the message is posted");

  // The next replica: iLink hands the same message again (the cursor did not move).
  crashing.abort();
  await getDb().update(wechatBridgeBindings).set({ leaseExpiresAt: new Date(0) }).where(eq(wechatBridgeBindings.id, f.bindingId));
  const runner = await f.runner();
  queueUpdates([wx({ id: 201, text: "posted once" })], "buf-201");
  await runner.pollOnce();
  const replayed = await tagOf(f, 201);
  assert.equal(replayed!.randomId, tagged.randomId, "the same tag");
  const posted = await getDb().select().from(messages).where(eq(messages.randomId, tagged.randomId));
  assert.equal(posted.length, 1);
  assert.equal(replayed!.messageId, posted[0]!.id);

  // A crash after the post but before message_id was filled: the replay finds the message.
  const late = `wechat:${randomUUID()}`;
  await getDb().insert(wechatBridgeInboundMessages).values({
    bindingId: f.bindingId, ownerUserId: f.owner.id, dmChannelId: f.dm.id, wechatMessageKey: "id:202", randomId: late, contextToken: "ctx-202" as WeChatContextToken,
  });
  const already = await createMessage(f.dm.id, "user", f.owner.id, "posted before the crash", "chat", undefined, { randomId: late });
  queueUpdates([wx({ id: 202, text: "posted before the crash" })], "buf-202");
  await runner.pollOnce();
  assert.equal((await tagOf(f, 202))!.messageId, already.id);
  assert.equal((await getDb().select().from(messages).where(eq(messages.randomId, late))).length, 1);

  // Plain redelivery (twice in one answer, too).
  queueUpdates([wx({ id: 201, text: "posted once" }), wx({ id: 201, text: "posted once" })], "buf-203");
  await runner.pollOnce();
  assert.equal((await getDb().select().from(messages).where(eq(messages.randomId, tagged.randomId))).length, 1);
  assert.equal((await tags(f)).length, 2);
  assert.equal((await binding(f)).getUpdatesBuf, "buf-203");
});

test("a sender other than the bound WeChat user, and anything but text, is dropped without its content and audited by count", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  queueUpdates([
    wx({ id: 301, from: "stranger@im.wechat", text: "STRANGER-SECRET-301" }),
    wx({ id: 302, items: [{ type: 2, image_item: { url: "IMAGE-SECRET-302" } }] }),
    wx({ id: 303, text: "   " }),
    // The bot's own message (an echo of a reply): ignored, not a stranger.
    wx({ id: 304, from: BOT_WX, type: 2, text: "echo" }),
    wx({ id: 305, text: "the real one" }),
  ], "buf-3");
  await runner.pollOnce();

  assert.deepEqual((await tags(f)).map((t) => t.wechatMessageKey), ["id:305"]);
  const dm = await getDb().select({ content: messages.content, senderId: messages.senderId }).from(messages).where(eq(messages.channelId, f.dm.id));
  assert.deepEqual(dm.filter((m) => m.senderId === f.owner.id).map((m) => m.content), ["the real one"]);
  const audits = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "assistant.wechat_messages_dropped"),
    eq(integrationAuditEvents.targetId, f.bindingId),
  ));
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!.metadata, { agentId: f.assistant.id, droppedCount: 3 });
  assert.equal(audits[0]!.subjectId, f.owner.id);
  const everything = JSON.stringify({ audits, dm, tags: await tags(f) });
  for (const secret of ["STRANGER-SECRET-301", "IMAGE-SECRET-302", "stranger@im.wechat"]) {
    assert.ok(!everything.includes(secret), `${secret} is nowhere`);
  }
});

// ── Outbound ────────────────────────────────────────────────────────────────

test("counter-example: a Raft-triggered turn's summary of another channel never reaches iLink; the next WeChat message hears only how many replies stayed in Raft", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const ROOM_SECRET = "ROOM-SECRET-7d1f-quarterly-numbers";
  await createMessage(f.room.id, "user", f.peer.id, `the numbers: ${ROOM_SECRET}`);

  // A turn triggered in Raft: the owner asks in the DM, Ottie reads the room and writes a summary into the DM.
  const asked = await createMessage(f.dm.id, "user", f.owner.id, "what happened in the room?");
  assert.ok((await mainPull(app.baseUrl, f)).includes(asked.id));
  const roomRead = await agentApi(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`);
  assert.equal(roomRead.status, 200, "a Raft turn reads the room");
  assert.ok(JSON.stringify(roomRead.body).includes(ROOM_SECRET));
  const summary = await mainReply(app.baseUrl, f, `Summary of the room: ${ROOM_SECRET}`);
  assert.deepEqual(await getWeChatMirrorDecision(summary), { mirror: false });

  // Never read by the mirror, even if marked: a thread reply in the DM, the owner's own message.
  const someTag = `wechat:${randomUUID()}`;
  await getDb().insert(wechatBridgeInboundMessages).values({
    bindingId: f.bindingId, ownerUserId: f.owner.id, dmChannelId: f.dm.id, wechatMessageKey: "id:399", randomId: someTag, contextToken: "ctx-399" as WeChatContextToken,
  });
  const thread = await getOrCreateThreadForChannel(f.dm.id, summary, f.assistant.id, "agent");
  const inThread = await createMessage(thread.id, "agent", f.assistant.id, `THREAD-SECRET ${ROOM_SECRET}`);
  const ownMessage = await createMessage(f.dm.id, "user", f.owner.id, `OWNER-SECRET ${ROOM_SECRET}`);
  for (const message of [inThread, ownMessage]) {
    await getDb().insert(assistantWechatMirrorMarks).values({ messageId: message.id, agentId: f.assistant.id, turnId: randomUUID(), inboundRandomId: someTag });
  }

  await runner.outboundOnce();
  assert.deepEqual(sentMessages(), [], "nothing sent");
  assert.equal(await outboundState(summary), "not_mirrored");
  assert.equal(await outboundState(inThread.id), null, "a thread reply is never read");
  assert.equal(await outboundState(ownMessage.id), null, "the owner's message is never read");
  assert.equal((await binding(f)).unmirroredCount, 1);

  // The owner writes from WeChat after that turn ended: the greeting, then the count only.
  f.idle();
  queueUpdates([wx({ id: 401, text: "anything new?", ctx: "ctx-401" })], "buf-401");
  await runner.pollOnce();
  assert.deepEqual(sentMessages().map((m) => [m.ctx, m.text]), [
    ["ctx-401", wechatGreetingText(f.owner.displayName!)],
    ["ctx-401", wechatLeftInRaftText(1)],
  ]);
  assert.equal((await binding(f)).unmirroredCount, 0, "the count starts over");

  // Ottie answers in that WeChat turn: that reply goes back.
  const tag = await tagOf(f, 401);
  assert.ok((await wechatPull(app.baseUrl, f)).includes(tag!.messageId!));
  const answer = await wechatReply(app.baseUrl, f, "Nothing new since this morning.");
  await runner.outboundOnce();
  assert.deepEqual(sentMessages().at(-1), { to: OWNER_WX, clientId: answer, ctx: "ctx-401", text: "Nothing new since this morning." });

  for (const request of ilink.requests) {
    for (const secret of [ROOM_SECRET, "THREAD-SECRET", "OWNER-SECRET", "Summary of the room"]) {
      assert.ok(!request.body.includes(secret) && !request.url.includes(secret), `${secret} never reaches iLink (${request.path})`);
    }
  }
});

test("a WeChat message arriving during a live Raft-triggered turn joins it: the summary written before it is never mirrored, the answer after it is", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const ROOM_SECRET = "ROOM-SECRET-9c2e-hiring-plan";
  await createMessage(f.room.id, "user", f.peer.id, `the plan: ${ROOM_SECRET}`);

  // A turn, triggered in Raft, is live: the owner asked in the DM and Ottie read the room.
  const asked = await createMessage(f.dm.id, "user", f.owner.id, "what is going on in the room?");
  assert.ok((await mainPull(app.baseUrl, f)).includes(asked.id));
  const roomRead = await agentApi(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`);
  assert.equal(roomRead.status, 200);
  assert.ok(JSON.stringify(roomRead.body).includes(ROOM_SECRET));
  // The summary, written before any WeChat message reached the turn.
  const summary = await mainReply(app.baseUrl, f, `Summary of the room: ${ROOM_SECRET}`);
  assert.deepEqual(await getWeChatMirrorDecision(summary), { mirror: false });

  // Meanwhile a WeChat message arrives through the worker.
  queueUpdates([wx({ id: 1901, text: "WECHAT-ONLY quick question", ctx: "ctx-1901" })], "buf-1901");
  await runner.pollOnce();
  const tag = (await tagOf(f, 1901))!;
  assert.ok(tag.messageId, "posted into the DM");

  // It reaches the same credential like any DM message and joins the live turn, which reads as before.
  assert.ok((await wechatPull(app.baseUrl, f)).includes(tag.messageId));
  assert.equal((await agentApi(app.baseUrl, f.apiKey, "GET", `/assistant/owner-messages?channelId=${f.room.id}`)).status, 200, "reads are not restricted");
  await runner.outboundOnce();
  assert.equal(await outboundState(summary), "not_mirrored");

  // The answer after the merge goes back.
  const answer = await wechatReply(app.baseUrl, f, "Here is the quick answer.");
  assert.deepEqual(await getWeChatMirrorDecision(answer), { mirror: true, inboundRandomId: tag.randomId });
  await runner.outboundOnce();
  assert.deepEqual(sentMessages().at(-1), { to: OWNER_WX, clientId: answer, ctx: "ctx-1901", text: "Here is the quick answer." });
  assert.equal(await outboundState(answer), "sent");

  for (const request of ilink.requests) {
    for (const secret of [ROOM_SECRET, "Summary of the room", "what is going on in the room?"]) {
      assert.ok(!request.body.includes(secret) && !request.url.includes(secret), `${secret} never reaches iLink (${request.path})`);
    }
  }
});

test("a reply recorded before a crash is never sent again, and a send that failed is not retried but counted", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  queueUpdates([wx({ id: 501, text: "two questions", ctx: "ctx-501" })], "buf-5");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const greetings = sentMessages().length;

  // The record was written, then the replica died before the send.
  const recorded = await wechatReply(app.baseUrl, f, "answer one");
  await getDb().insert(wechatBridgeOutboundMessages).values({ messageId: recorded, bindingId: f.bindingId, state: "sending", createdAt: f.time.now(), updatedAt: f.time.now() });
  await runner.outboundOnce();
  assert.equal(sentMessages().length, greetings, "never sent after the crash");
  assert.equal(await outboundState(recorded), "sending", "maybe still in flight: left alone for now");
  assert.equal((await binding(f)).unmirroredCount, 0);

  // iLink unreachable for the send: recorded first, so never sent again.
  const unlucky = await wechatReply(app.baseUrl, f, "answer two");
  ilink.sends.push(() => { throw new TypeError("fetch failed"); });
  await runner.outboundOnce();
  await runner.outboundOnce();
  assert.equal(ilink.requests.filter((r) => r.path === "/ilink/bot/sendmessage" && r.body.includes("answer two")).length, 1);
  assert.equal(await outboundState(unlucky), "failed");
  assert.equal((await binding(f)).unmirroredCount, 1, "a failed send stays in Raft and is counted");
  assert.equal((await binding(f)).lastMirroredAt, null);

  // A lease later the crashed reply's record is settled as failed and counted, still never sent.
  f.time.advance(91_000);
  await runner.outboundOnce();
  assert.equal(await outboundState(recorded), "failed");
  assert.equal((await binding(f)).unmirroredCount, 2);
  assert.equal(ilink.requests.filter((r) => r.path === "/ilink/bot/sendmessage" && r.body.includes("answer one")).length, 0);
  queueUpdates([wx({ id: 502, ctx: "ctx-502" })], "buf-502");
  await runner.pollOnce();
  assert.deepEqual(sentMessages().at(-1), { to: OWNER_WX, clientId: `raft-wechat-left:${(await tagOf(f, 502))!.id}`, ctx: "ctx-502", text: wechatLeftInRaftText(2) });
});

test("a greeting that could not be sent is tried again with the next message", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const greetings = () => sentMessages().filter((m) => m.clientId === `raft-wechat-greeting:${f.bindingId}`);
  ilink.sends.push({ ret: -2, errmsg: "refused" });
  queueUpdates([wx({ id: 1001, ctx: "ctx-1001" })], "buf-1001");
  await runner.pollOnce();
  assert.equal(greetings().length, 1, "tried");
  assert.equal((await binding(f)).greetedAt, null, "given back: not sent");

  queueUpdates([wx({ id: 1002, ctx: "ctx-1002" })], "buf-1002");
  await runner.pollOnce();
  assert.deepEqual(greetings().map((m) => m.ctx), ["ctx-1001", "ctx-1002"]);
  assert.ok((await binding(f)).greetedAt, "sent now: claimed for good");
  queueUpdates([wx({ id: 1003, ctx: "ctx-1003" })], "buf-1003");
  await runner.pollOnce();
  assert.equal(greetings().length, 2, "and never again");
});

/** A message the bridge wrote (tag first, then the post), without the runner: a WeChat turn's trigger. */
async function bridged(f: Fixture, key: string, text: string, contextToken: string) {
  const randomId = `wechat:${randomUUID()}`;
  await getDb().insert(wechatBridgeInboundMessages).values({
    bindingId: f.bindingId, ownerUserId: f.owner.id, dmChannelId: f.dm.id, wechatMessageKey: key, randomId,
    contextToken: contextToken as WeChatContextToken, receivedAt: f.time.now(),
  });
  const message = await createMessage(f.dm.id, "user", f.owner.id, text, "chat", undefined, { randomId });
  await getDb().update(wechatBridgeInboundMessages).set({ messageId: message.id }).where(eq(wechatBridgeInboundMessages.randomId, randomId));
  return message;
}

test("a runner being stopped claims nothing it could then fail to send: no count note, no reply record, no notice", async ({ app }) => {
  const f = await seedFixture(app);
  const sendAborting = (runner: WeChatBindingRunner) => () => {
    runner.abort();
    throw new DOMException("aborted", "AbortError");
  };
  await getDb().update(wechatBridgeBindings).set({ unmirroredCount: 2 }).where(eq(wechatBridgeBindings.id, f.bindingId));

  // Stopped while the message was being posted: it is in Raft, but no greeting is claimed or sent.
  let posting: WeChatBindingRunner | null = null;
  const stopsWhilePosting = new Proxy(f.io!, {
    get(target, property) {
      if (property === "to") posting?.abort();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  posting = await f.runner({ io: stopsWhilePosting });
  queueUpdates([wx({ id: 1100_1, ctx: "ctx-1100-1" })], "buf-1100-1");
  assert.equal(await posting.pollOnce(), false);
  assert.ok((await tagOf(f, 1100_1))?.messageId, "posted");
  assert.equal(sentMessages().length, 0, "no greeting");
  assert.equal((await binding(f)).greetedAt, null);
  await f.freeLease();

  // Stopped while the greeting was being sent: the greeting is given back and the count note never taken.
  const first = await f.runner();
  ilink.sends.push(sendAborting(first));
  queueUpdates([wx({ id: 1101, ctx: "ctx-1101" })], "buf-1101");
  assert.equal(await first.pollOnce(), false);
  assert.equal(sentMessages().length, 1, "only the greeting was tried");
  assert.deepEqual([(await binding(f)).greetedAt, (await binding(f)).unmirroredCount], [null, 2]);

  // Stopped the same way with a WeChat-turn reply waiting: the reply is not recorded (a later runner sends it).
  await bridged(f, "id:1100", "an earlier WeChat message", "ctx-1100");
  await wechatPull(app.baseUrl, f);
  const answer = await wechatReply(app.baseUrl, f, "the answer");
  await f.freeLease();
  const second = await f.runner();
  ilink.sends.push(sendAborting(second));
  queueUpdates([wx({ id: 1102, ctx: "ctx-1102" })], "buf-1102");
  assert.equal(await second.pollOnce(), false);
  assert.equal(sentMessages().length, 2);
  assert.equal(await outboundState(answer), null, "not recorded");
  assert.deepEqual([(await binding(f)).greetedAt, (await binding(f)).unmirroredCount], [null, 2]);

  // Stopped while a reply was being sent, with a no-reply notice due: the notice is not claimed.
  await f.freeLease();
  const third = await f.runner();
  ilink.sends.push(sendAborting(third));
  f.time.advance(11 * MINUTE);
  await third.pollOnce();
  assert.equal(await third.outboundOnce(), false);
  assert.equal(await outboundState(answer), "failed", "the reply in flight: failed, counted, never resent");
  assert.equal((await binding(f)).noReplyNoticeAt, null, "the notice was not claimed");

  // The next runner: the greeting, then the note with everything left in Raft, then the notice.
  await f.freeLease();
  const fourth = await f.runner();
  queueUpdates([wx({ id: 1103, ctx: "ctx-1103" })], "buf-1103");
  await fourth.pollOnce();
  assert.deepEqual(sentMessages().slice(3).map((m) => [m.ctx, m.text]), [
    ["ctx-1103", wechatGreetingText(f.owner.displayName!)],
    ["ctx-1103", wechatLeftInRaftText(3)],
  ]);
});

test("a gate that closed during the long poll: nothing it brought is tagged or posted, and the cursor stays", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  ilink.duringGetUpdates = () => f.wechatFlag(false);
  queueUpdates([wx({ id: 1401, text: "arrived as the flag went off" })], "buf-1401");
  assert.equal(await runner.pollOnce(), false);
  assert.equal(runner.stopReason, "gate_closed");
  assert.deepEqual(await tags(f), []);
  assert.deepEqual(await getDb().select().from(messages).where(and(eq(messages.channelId, f.dm.id), eq(messages.senderId, f.owner.id))), []);
  assert.equal((await binding(f)).getUpdatesBuf, null, "iLink keeps the messages");
});

test("the flag going off stops a live runner: no more polls, mirrored replies or notices", async ({ app }) => {
  const f = await seedFixture(app);
  const polls = () => ilink.requests.filter((r) => r.path === "/ilink/bot/getupdates").length;

  // An outbound pass with nothing to send still sees the gate (once its answer is a few seconds old).
  const first = await f.runner();
  await first.pollOnce();
  await f.wechatFlag(false);
  f.time.advance(11_000);
  assert.equal(await first.outboundOnce(), false);
  assert.equal(first.stopReason, "gate_closed");

  // A reply that would be mirrored: the gate is checked again right before the send.
  await f.wechatFlag(true);
  await f.freeLease();
  const second = await f.runner();
  queueUpdates([wx({ id: 1501, ctx: "ctx-1501" })], "buf-1501");
  await second.pollOnce();
  await wechatPull(app.baseUrl, f);
  const answer = await wechatReply(app.baseUrl, f, "an answer after the flag went off");
  assert.equal((await getWeChatMirrorDecision(answer)).mirror, true, "a WeChat-turn reply: only the gate stops it");
  await second.pollOnce();
  await f.wechatFlag(false);
  const sent = sentMessages().length;
  assert.equal(await second.outboundOnce(), false);
  assert.equal(sentMessages().length, sent, "not mirrored");
  assert.equal(await outboundState(answer), null);

  // A no-reply notice that came due: the same.
  await f.wechatFlag(true);
  await f.freeLease();
  const third = await f.runner();
  f.time.advance(11 * MINUTE);
  await getDb().insert(wechatBridgeOutboundMessages).values({ messageId: answer, bindingId: f.bindingId, state: "not_mirrored" });
  await third.pollOnce();
  await f.wechatFlag(false);
  assert.equal(await third.outboundOnce(), false);
  assert.equal(sentMessages().length, sent, "no notice");
  assert.equal((await binding(f)).noReplyNoticeAt, null);

  // And no long poll at all.
  await f.freeLease();
  const fourth = await f.runner();
  const before = polls();
  assert.equal(await fourth.pollOnce(), false);
  assert.equal(polls(), before);
});

test("no-reply notice while the assistant's pushes have stopped: it says Ottie can't get messages now, with no retry advice", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  // agentInboxPushService gave up on the runtime's endpoint.
  await getDb().update(agentInboxPushRegistrations).set({ disabledAt: new Date(), disabledReason: "endpoint_rejected" })
    .where(eq(agentInboxPushRegistrations.agentId, f.assistant.id));

  queueUpdates([wx({ id: 651, ctx: "ctx-651" })], "buf-651");
  await runner.pollOnce();
  f.time.advance(10 * MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(sentMessages().filter((m) => m.clientId?.startsWith("raft-wechat-no-reply:")).map((m) => [m.text, m.ctx]),
    [[WECHAT_PUSH_STOPPED_NOTICE_TEXT, "ctx-651"]]);
  assert.equal(sentMessages().filter((m) => m.text === WECHAT_NO_REPLY_NOTICE_TEXT).length, 0, "no 'send it again' while nothing reaches Ottie");

  // Pushes come back (a new PUT clears disabled_at): the next batch gets the usual notice.
  await getDb().update(agentInboxPushRegistrations).set({ disabledAt: null, disabledReason: null })
    .where(eq(agentInboxPushRegistrations.agentId, f.assistant.id));
  f.time.advance(MINUTE);
  queueUpdates([wx({ id: 652, ctx: "ctx-652" })], "buf-652");
  await runner.pollOnce();
  f.time.advance(10 * MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(sentMessages().filter((m) => m.text === WECHAT_NO_REPLY_NOTICE_TEXT).map((m) => m.ctx), ["ctx-652"]);
});

test("no-reply notice: ten minutes into a batch with no mirrored reply, once; a message after it starts a new batch; a mirrored reply means none", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const notices = () => sentMessages().filter((m) => m.text === WECHAT_NO_REPLY_NOTICE_TEXT);

  queueUpdates([wx({ id: 601, ctx: "ctx-601" }), wx({ id: 602, ctx: "ctx-602" })], "buf-601");
  await runner.pollOnce();
  f.time.advance(9 * MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 0, "not before ten minutes");
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(notices().map((m) => [m.ctx, m.clientId]), [["ctx-602", `raft-wechat-no-reply:${(await tagOf(f, 602))!.id}`]], "answers the batch's newest message");
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 1, "once per batch");

  // The owner tries again: a new batch, its own notice.
  queueUpdates([wx({ id: 603, ctx: "ctx-603" })], "buf-603");
  await runner.pollOnce();
  f.time.advance(9 * MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 1);
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(notices().map((m) => m.ctx), ["ctx-602", "ctx-603"]);

  // A batch answered by a mirrored reply gets none.
  f.time.advance(MINUTE);
  queueUpdates([wx({ id: 604, ctx: "ctx-604" })], "buf-604");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const answer = await wechatReply(app.baseUrl, f, "here you go");
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.equal(sentMessages().at(-1)?.clientId, answer);
  f.time.advance(30 * MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 2);
});

test("context tokens are cleared 24 hours after they arrived (the tags stay); a reply after that is not mirrored and is counted", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  queueUpdates([wx({ id: 701, ctx: "ctx-701" })], "buf-7");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const sentBefore = sentMessages().length;

  f.time.advance(24 * 60 * MINUTE + MINUTE);
  const swept = await sweepWeChatBridgeExpiry(f.time.now());
  assert.equal(swept.tokensCleared, 1);
  const tag = await tagOf(f, 701);
  assert.ok(tag?.messageId, "the tag stays, with its message");
  assert.equal(tag.contextToken, null);

  const late = await wechatReply(app.baseUrl, f, "sorry, late answer");
  assert.equal((await getWeChatMirrorDecision(late)).mirror, true, "a WeChat-turn reply: only the cleared token stops it");
  await runner.outboundOnce();
  assert.equal(sentMessages().length, sentBefore, "nothing answers through a cleared token");
  assert.equal(await outboundState(late), "not_mirrored");
  assert.equal((await binding(f)).unmirroredCount, 1);

  // The window holds even before the sweep has run.
  queueUpdates([wx({ id: 702, ctx: "ctx-702" })], "buf-702");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const sentAfter = sentMessages().length;
  f.time.advance(25 * 60 * MINUTE);
  const tooLate = await wechatReply(app.baseUrl, f, "an answer a day later");
  assert.equal((await getWeChatMirrorDecision(tooLate)).mirror, true, "a WeChat-turn reply: only the window stops it");
  await runner.outboundOnce();
  assert.equal(sentMessages().length, sentAfter);
  assert.equal(await outboundState(tooLate), "not_mirrored");
  assert.equal((await tagOf(f, 702))!.contextToken, "ctx-702", "not swept yet");
});

// ── -14 ─────────────────────────────────────────────────────────────────────

async function reconnectNotices(f: Fixture) {
  return getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, f.dm.id), eq(messages.systemSubtype, "assistant.wechat_reconnect_required")));
}

test("-14 on the long poll: reconnect required, polling stops, audited without content, one notice in the DM", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  ilink.updates.push({ ret: -14, errmsg: "session timeout" });
  assert.equal(await runner.pollOnce(), false);
  assert.equal(runner.stopReason, "token_stale");
  const row = await binding(f);
  assert.deepEqual({ state: row.state, leaseOwner: row.leaseOwner }, { state: "reconnect_required", leaseOwner: null });
  const audits = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "assistant.wechat_token_stale"),
    eq(integrationAuditEvents.targetId, f.bindingId),
  ));
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0]!.metadata, { agentId: f.assistant.id, errorCode: -14 });
  assert.deepEqual(await reconnectNotices(f), [{ content: WECHAT_RECONNECT_NOTICE_TEXT }]);

  // Nobody polls it any more; a second -14 changes nothing.
  assert.equal(await claimWeChatBindingLease({ bindingId: f.bindingId, owner: "replica-x", now: new Date() }), null);
  assert.equal(await markWeChatBindingStale({ binding: row, now: new Date() }), false);
  assert.equal((await reconnectNotices(f)).length, 1);
  assert.equal(ilink.requests.filter((r) => r.path === "/ilink/bot/getupdates").length, 1);
});

test("-14 answering a send does the same", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  queueUpdates([wx({ id: 801, ctx: "ctx-801" })], "buf-8");
  ilink.sends.push({ ret: -14 });
  assert.equal(await runner.pollOnce(), false);
  assert.equal(runner.stopReason, "token_stale");
  assert.equal((await binding(f)).state, "reconnect_required");
  assert.equal((await reconnectNotices(f)).length, 1);
  assert.ok((await tagOf(f, 801))?.messageId, "the message itself reached Raft");
});

// ── The worker ──────────────────────────────────────────────────────────────

async function until(condition: () => Promise<boolean> | boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** iLink as a real long poll: getupdates waits for a queued answer, its deadline or the caller's abort. */
function blockingILink(replica: string, log: Array<{ replica: string; path: string; aborted?: boolean; authorization?: string }>): ILinkTransport {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const entry: { replica: string; path: string; aborted?: boolean; authorization?: string } = { replica, path, authorization: init.headers.Authorization };
    log.push(entry);
    if (path === "/ilink/bot/getupdates") {
      const deadline = Date.now() + 2_000;
      while (ilink.updates.length === 0 && Date.now() < deadline) {
        if (init.signal.aborted) {
          entry.aborted = true;
          throw new DOMException("aborted", "AbortError");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return Response.json(ilink.updates.shift() ?? { ret: 0, msgs: [] });
    }
    return Response.json({ ret: 0 });
  };
}

test("the worker: one replica polls a binding, posts what arrives, and stop() aborts the long poll and releases the lease", async ({ app }) => {
  const f = await seedFixture(app);
  const log: Array<{ replica: string; path: string; aborted?: boolean }> = [];
  const start = (replica: string) => startWeChatBridgeWorker({
    io: f.io!,
    orchestrator: f.orchestrator,
    client: createWeChatILinkClient({ transport: blockingILink(replica, log) }),
    leaseOwner: replica,
    scanIntervalMs: 50,
    outboundIntervalMs: 50,
    minPollIntervalMs: 0,
  });
  const a = start("replica-a");
  const b = start("replica-b");
  try {
    await until(() => log.some((r) => r.path === "/ilink/bot/getupdates"), "a long poll");
    const holder = (await binding(f)).leaseOwner;
    assert.ok(holder === "replica-a" || holder === "replica-b");
    queueUpdates([wx({ id: 901, text: "through the worker" })], "buf-901");
    await until(async () => Boolean((await tagOf(f, 901))?.messageId), "the message posted");
    await until(async () => (await binding(f)).getUpdatesBuf === "buf-901", "the cursor");
    assert.deepEqual([...new Set(log.filter((r) => r.path === "/ilink/bot/getupdates").map((r) => r.replica))], [holder], "only the lease holder polls");
  } finally {
    const stopping = Date.now();
    await Promise.all([a.stop(), b.stop()]);
    assert.ok(Date.now() - stopping < 2_000, "stop does not wait out the long poll");
  }
  assert.ok(log.some((r) => r.path === "/ilink/bot/getupdates" && r.aborted), "the long poll in flight was aborted");
  assert.equal((await binding(f)).leaseOwner, null, "the lease is released");
});

test("the worker leaves a binding alone while its owner's WeChat flag is off, the owner could not post in the DM, with the kill switch, and without the key", async ({ app }) => {
  const f = await seedFixture(app);
  const log: Array<{ replica: string; path: string }> = [];
  const run = async (env: NodeJS.ProcessEnv) => {
    const worker = startWeChatBridgeWorker({
      io: f.io!,
      orchestrator: f.orchestrator,
      client: createWeChatILinkClient({ transport: blockingILink("replica", log) }),
      env,
      scanIntervalMs: 20,
      outboundIntervalMs: 20,
      minPollIntervalMs: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.stop();
  };

  await run({ ...process.env, [WECHAT_BRIDGE_WORKER_DISABLED_ENV]: "1" });
  assert.deepEqual(log, [], "kill switch");

  const key = process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
  delete process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
  await run({ ...process.env });
  process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = key;
  assert.deepEqual(log, [], "no key");

  // The owner could not post in the DM now (archived; billing or quota read-only the same way).
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, f.dm.id));
  await run({ ...process.env });
  await getDb().update(channels).set({ archivedAt: null }).where(eq(channels.id, f.dm.id));
  assert.deepEqual(log, [], "DM archived");

  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, ASSISTANT_WECHAT_FEATURE_FLAG_KEY));
  await run({ ...process.env });
  assert.deepEqual(log, [], "flag off for the owner");
  assert.equal((await binding(f)).leaseOwner, null, "never claimed");
});

test("the bridge writes as the owner only while their organization's require-SSO lets them: closed with no SSO sign-in, open again after one (RFC 083 §6.2)", async ({ app }) => {
  const f = await seedFixture(app);
  const gate = () => weChatBindingGateOpen({ serverId: f.server.id, userId: f.owner.id, agentId: f.assistant.id, dmChannelId: f.dm.id });
  assert.equal(await gate(), true, "nothing required yet");

  // Another Server (the owner's employer) requires SSO for the owner's email domain; the platform reviewed it.
  for (const key of [SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY]) {
    await getDb().insert(featureFlags).values({ key, randomizationUnit: "server", salt: "test", defaultEnabled: true })
      .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: true } });
  }
  const corpOwner = await seedUser(`wxw-corp-${randomUUID().slice(0, 8)}@elsewhere.test`, `wxw-corp-${randomUUID().slice(0, 8)}`);
  const corp = await createServer("Corp", `wxw-corp-${randomUUID().slice(0, 8)}`, corpOwner.id);
  const [connection] = await getDb().insert(serverSsoConnections).values({
    serverId: corp.id, protocol: "oidc", status: "active", required: true, displayName: "Corp",
    config: { protocol: "oidc", issuer: "https://corp.okta.com", clientId: "raft" },
  }).returning();
  await getDb().insert(serverSsoDomains).values({ serverId: corp.id, domain: f.owner.email.split("@")[1]!, verificationToken: randomUUID(), verifiedAt: new Date() });
  forgetSsoRequirementCache();
  try {
    assert.equal(await gate(), false, "the owner has no SSO sign-in: the bridge relays nothing for them");

    const gateResult = await proofForSsoLogin(f.owner.id, connection!.id);
    assert.equal(gateResult.secondFactorRequired, false);
    if (!gateResult.secondFactorRequired) await createSession(gateResult.proof);
    assert.equal(await gate(), true, "signed in with SSO: open again");
  } finally {
    await getDb().update(serverSsoConnections).set({ required: false }).where(eq(serverSsoConnections.id, connection!.id));
    forgetSsoRequirementCache();
  }
});

// ── Reconnect, windows, scans ───────────────────────────────────────────────

test("a reconnect to another WeChat account: the earlier account's reply tokens are gone, nothing answering it reaches the new one, and the assistant's earlier DM messages are not counted", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  queueUpdates([wx({ id: 1301, text: "from account A", ctx: "ctx-A" })], "buf-1301");
  await runner.pollOnce();
  const tagA = (await tagOf(f, 1301))!;
  // Ottie takes A's message: its turn now carries it.
  assert.ok((await wechatPull(app.baseUrl, f)).includes(tagA.messageId!));
  // Two messages of the assistant's in the DM before the new binding.
  await createMessage(f.dm.id, "agent", f.assistant.id, "before the reconnect, one");
  await createMessage(f.dm.id, "agent", f.assistant.id, "before the reconnect, two");

  // The token went stale; the owner scans again, this time with WeChat account B.
  runner.abort();
  await getDb().update(wechatBridgeBindings).set({ state: "reconnect_required", leaseOwner: null, leaseExpiresAt: null }).where(eq(wechatBridgeBindings.id, f.bindingId));
  const attemptsPath = `/api/servers/${f.server.id}/assistant/wechat/attempts`;
  const started = await startWeChatAttempt({ serverId: f.server.id, userId: f.owner.id });
  ilink.qrStatus = { status: "confirmed", bot_token: "SECRET-BOT-TOKEN-B", ilink_bot_id: "bot-b@im.bot", ilink_user_id: "account-b@im.wechat", baseurl: BASE_URL };
  const confirmed = await pollWeChatAttempt({
    serverId: f.server.id, userId: f.owner.id, attemptId: started.attemptId, attemptsPath,
    cookieHeader: wechatAttemptCookie(attemptsPath, started).split(";")[0], io: f.io, orchestrator: f.orchestrator,
  });
  assert.equal(confirmed.status, "confirmed");
  const [rebound] = await getDb().select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.userId, f.owner.id));
  assert.ok(rebound && rebound.id !== f.bindingId);
  const [oldTag] = await getDb().select().from(wechatBridgeInboundMessages).where(eq(wechatBridgeInboundMessages.id, tagA.id));
  assert.deepEqual({ bindingId: oldTag!.bindingId, contextToken: oldTag!.contextToken }, { bindingId: null, contextToken: null }, "A's reply token went with A's binding");

  // The turn that took A's message answers it.
  const toA = await wechatReply(app.baseUrl, f, "an answer meant for account A");
  assert.deepEqual(await getWeChatMirrorDecision(toA), { mirror: true, inboundRandomId: tagA.randomId }, "marked, answering A's message");
  const lease = await claimWeChatBindingLease({ bindingId: rebound.id, owner: "replica-b", now: f.time.now() });
  const onB = new WeChatBindingRunner(lease!, f.deps());
  const before = sentMessages().length;
  await onB.outboundOnce();
  assert.equal(sentMessages().length, before, "nothing reaches account B");
  assert.equal(await outboundState(toA), "not_mirrored");
  assert.equal((await getDb().select().from(wechatBridgeBindings).where(eq(wechatBridgeBindings.id, rebound.id)))[0]!.unmirroredCount, 1,
    "only the answer: the assistant's messages from before the binding are not counted");

  // Even a token an older reconnect left behind is never another binding's to use.
  await getDb().update(wechatBridgeInboundMessages).set({ contextToken: "ctx-A" as WeChatContextToken }).where(eq(wechatBridgeInboundMessages.id, tagA.id));
  const again = await wechatReply(app.baseUrl, f, "another answer meant for account A");
  assert.deepEqual(await getWeChatMirrorDecision(again), { mirror: true, inboundRandomId: tagA.randomId });
  await onB.outboundOnce();
  assert.equal(sentMessages().length, before);
  assert.equal(await outboundState(again), "not_mirrored");
  assert.ok(ilink.requests.every((r) => !r.body.includes("meant for account A")));
});

test("the reply window runs from when the owner sent the message (iLink's create time); the no-reply clock from when it reached Raft", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const notices = () => sentMessages().filter((m) => m.text === WECHAT_NO_REPLY_NOTICE_TEXT);

  // Sent 23 hours ago, delivered only now (iLink held it, or the bridge was down).
  const sentAtMs = f.time.now().getTime() - 23 * 60 * MINUTE;
  const arrivedMs = f.time.now().getTime();
  queueUpdates([wx({ id: 1601, ctx: "ctx-1601", createdAtMs: sentAtMs })], "buf-1601");
  await runner.pollOnce();
  const tag = (await tagOf(f, 1601))!;
  assert.equal(tag.sentAt?.getTime(), sentAtMs);
  assert.ok(tag.receivedAt.getTime() >= arrivedMs, "received_at is the arrival");

  // No "no reply yet" the moment it is posted: ten minutes after it arrived.
  await runner.outboundOnce();
  f.time.advance(9 * MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 0);
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(notices().map((m) => m.ctx), ["ctx-1601"], "sent 23h10m ago: still inside its window");

  // The reply window, though, closed 24 hours after it was sent.
  await wechatPull(app.baseUrl, f);
  f.time.advance(51 * MINUTE);
  const late = await wechatReply(app.baseUrl, f, "past the window by now");
  assert.equal((await getWeChatMirrorDecision(late)).mirror, true, "a WeChat-turn reply: only the window stops it");
  await runner.outboundOnce();
  assert.equal(await outboundState(late), "not_mirrored");
  assert.ok(sentMessages().every((m) => m.clientId !== late));
  assert.equal((await sweepWeChatBridgeExpiry(f.time.now())).tokensCleared, 1, "the sweep goes by the send time too");
  assert.equal((await tagOf(f, 1601))!.contextToken, null);

  // A create time still to come is not believed.
  queueUpdates([wx({ id: 1602, ctx: "ctx-1602", createdAtMs: f.time.now().getTime() + 60 * MINUTE })], "buf-1602");
  await runner.pollOnce();
  assert.equal((await tagOf(f, 1602))!.sentAt, null);
});

test("a message sent before the last mirrored reply but delivered after it starts a batch of its own", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const notices = () => sentMessages().filter((m) => m.text === WECHAT_NO_REPLY_NOTICE_TEXT);
  queueUpdates([wx({ id: 1801, ctx: "ctx-1801" })], "buf-1801");
  await runner.pollOnce();
  await wechatPull(app.baseUrl, f);
  const answer = await wechatReply(app.baseUrl, f, "answered");
  await runner.outboundOnce();
  assert.equal(sentMessages().at(-1)?.clientId, answer, "mirrored: the batch ends here");

  // Sent five minutes before that reply went out, delivered a minute after it.
  const sentBeforeReplyMs = f.time.now().getTime() - 5 * MINUTE;
  f.time.advance(MINUTE);
  queueUpdates([wx({ id: 1802, ctx: "ctx-1802", createdAtMs: sentBeforeReplyMs })], "buf-1802");
  await runner.pollOnce();
  f.time.advance(9 * MINUTE);
  await runner.outboundOnce();
  assert.equal(notices().length, 0);
  f.time.advance(MINUTE);
  await runner.outboundOnce();
  assert.deepEqual(notices().map((m) => m.ctx), ["ctx-1802"]);
});

test("an answer iLink repeats without a new cursor is not audited again", async ({ app }) => {
  const f = await seedFixture(app);
  const runner = await f.runner();
  const stranger = wx({ id: 1701, from: "stranger@im.wechat", text: "hello?" });
  ilink.updates.push({ ret: 0, msgs: [stranger] }, { ret: 0, msgs: [stranger] });
  await runner.pollOnce();
  await runner.pollOnce();
  const drops = () => getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "assistant.wechat_messages_dropped"),
    eq(integrationAuditEvents.targetId, f.bindingId),
  ));
  assert.equal((await drops()).length, 0);
  queueUpdates([stranger], "buf-1701");
  await runner.pollOnce();
  assert.equal((await drops()).length, 1, "audited with the answer that moves past it");
  assert.equal((await binding(f)).getUpdatesBuf, "buf-1701");
});

test("bindings whose gate is closed do not starve the others out of a scan", async ({ app }) => {
  // Sorted first, and closed (its owner's WeChat flag is off): one scan reads one binding.
  const closed = await seedFixture(app, { bindingId: "00000000-0000-4000-8000-000000000001" });
  await closed.wechatFlag(false);
  const open = await seedFixture(app, { bindingId: "ffffffff-ffff-4fff-bfff-ffffffffffff", ilinkUserId: "other-owner@im.wechat" });
  const log: Array<{ replica: string; path: string; aborted?: boolean; authorization?: string }> = [];
  const worker = startWeChatBridgeWorker({
    io: open.io!,
    orchestrator: open.orchestrator,
    client: createWeChatILinkClient({ transport: blockingILink("replica", log) }),
    scanIntervalMs: 20,
    scanBatch: 1,
    outboundIntervalMs: 50,
    minPollIntervalMs: 0,
  });
  try {
    await until(() => log.some((r) => r.path === "/ilink/bot/getupdates" && r.authorization === `Bearer ${open.botToken}`), "the open binding polled");
    assert.ok(log.every((r) => r.authorization !== `Bearer ${closed.botToken}`), "the closed one never");
  } finally {
    await worker.stop();
  }
});
