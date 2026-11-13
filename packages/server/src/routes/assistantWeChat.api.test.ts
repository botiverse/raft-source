// The personal assistant's WeChat bridge, PR 1 (design "微信接入 Ottie" v8):
// the gate, the QR binding flow bound to the starting browser and person,
// single use, one poll at a time, one WeChat account per binding, disconnect,
// the connected notice in the owner's DM (committed with the binding), and the
// cleanup when the owner leaves, deletes their account, archives their
// assistant or the server is deleted. iLink is a scripted fake; no answer may
// ever carry the bot token or iLink's user or bot id.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, featureFlagRules, featureFlags, integrationAuditEvents, messages, serverMembers, wechatBridgeAttempts, wechatBridgeBindings, wechatBridgeInboundMessages } from "../db/schema";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { addMember, deleteServer, removeMember } from "../services/serverService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { WECHAT_BRIDGE_CREDENTIAL_KEY_ENV, wechatBridgeCredentialCipher } from "../services/wechatBridgeCredentialCipher";
import { __setWeChatILinkTransportForTests, type ILinkTransport, type WeChatContextToken } from "../services/wechatILinkClient";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { tokenForHuman } from "../test/integration/credentials";
import { enablePersonalAssistants, withHostedRuntime } from "../test/hostedAssistantFixture";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

// ── A scripted iLink ────────────────────────────────────────────────────────

const ilink = {
  issued: 0,
  /** Status answers per QR handle, in order; `wait` once they run out. */
  statuses: new Map<string, Array<Record<string, unknown>>>(),
  calls: [] as string[],
};

const fakeILink: ILinkTransport = async (url) => {
  ilink.calls.push(url);
  const parsed = new URL(url);
  if (parsed.pathname === "/ilink/bot/get_bot_qrcode") {
    ilink.issued += 1;
    return Response.json({ qrcode: `qr-${ilink.issued}`, qrcode_img_content: `https://liteapp.weixin.qq.com/q/${ilink.issued}` });
  }
  if (parsed.pathname === "/ilink/bot/get_qrcode_status") {
    const queue = ilink.statuses.get(parsed.searchParams.get("qrcode") ?? "") ?? [];
    return Response.json(queue.shift() ?? { status: "wait" });
  }
  return new Response("not found", { status: 404 });
};

const SECRET_MARK = "SECRET-bot-token";
function confirmation(n: number, ilinkUserId: string) {
  return { status: "confirmed", bot_token: `${SECRET_MARK}-${n}`, ilink_bot_id: `bot-${n}@im.bot`, ilink_user_id: ilinkUserId, baseurl: "https://sh.ilinkai.weixin.qq.com" };
}

const savedKey = process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
beforeEach(() => {
  process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = Buffer.alloc(32, 3).toString("base64");
  ilink.issued = 0;
  ilink.statuses.clear();
  ilink.calls.length = 0;
  __setWeChatILinkTransportForTests(fakeILink);
});
afterEach(() => {
  __setWeChatILinkTransportForTests(null);
  if (savedKey === undefined) delete process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]; else process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = savedKey;
});

// ── Fixtures ────────────────────────────────────────────────────────────────

async function enableWeChatFor(userId: string): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, randomizationUnit: "user", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ flagKey: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, stage: "user", priority: 0, decision: "allow", values: [userId] });
}

type Person = Awaited<ReturnType<typeof seedUser>>;

async function createOttie(baseUrl: string, serverId: string, person: Person) {
  const created = await fetch(`${baseUrl}/api/servers/${serverId}/assistant`, {
    method: "POST",
    headers: headers(await tokenForHuman(person.email), serverId),
    body: JSON.stringify({}),
  });
  assert.equal(created.status, 201);
  return (await created.json() as { assistant: { agentId: string; dmChannelId: string } }).assistant;
}

async function seed(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const serverOwner = await seedUser(`wx-server-owner-${suffix}@slock.test`, `wx-server-owner-${suffix}`);
  const owner = await seedUser(`wx-owner-${suffix}@slock.test`, `wx-owner-${suffix}`);
  const other = await seedUser(`wx-other-${suffix}@slock.test`, `wx-other-${suffix}`);
  const server = await createServer("WeChat Bridge", `wx-${suffix}`, serverOwner.id);
  await addMember(server.id, owner.id);
  await addMember(server.id, other.id);
  await enablePersonalAssistants(server.id);
  const ottie = await createOttie(baseUrl, server.id, owner);
  await enableWeChatFor(owner.id);
  return { serverOwner, owner, other, server, ottie };
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Every response body seen, to check no token or iLink id ever left. */
const seenBodies: string[] = [];

async function call(baseUrl: string, s: { server: { id: string } }, person: Person, method: string, path: string, cookie?: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/servers/${s.server.id}/assistant/wechat${path}`, {
    method,
    headers: { ...headers(await tokenForHuman(person.email), s.server.id), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  seenBodies.push(text);
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null,
    setCookies: res.headers.getSetCookie(),
  };
}

/** Start an attempt; answers its id and the browser's cookie (`name=value`). */
async function start(baseUrl: string, s: { server: { id: string } }, person: Person) {
  const res = await call(baseUrl, s, person, "POST", "/attempts");
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const setCookie = res.setCookies.find((c) => c.startsWith("raft_wechat_bind_"));
  assert.ok(setCookie, "the start binds the attempt to this browser");
  return { attemptId: String(res.body!.attemptId), cookie: setCookie.split(";")[0]!, setCookie, body: res.body! };
}

async function bindingOf(serverId: string, userId: string) {
  const [row] = await getDb().select().from(wechatBridgeBindings)
    .where(and(eq(wechatBridgeBindings.serverId, serverId), eq(wechatBridgeBindings.userId, userId)));
  return row ?? null;
}

async function auditRows(eventType: string, subjectId: string) {
  return getDb().select({ metadata: integrationAuditEvents.metadata, targetId: integrationAuditEvents.targetId, category: integrationAuditEvents.eventCategory })
    .from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, eventType), eq(integrationAuditEvents.subjectId, subjectId)));
}

/** An inbound tag on the binding, as the poll worker (PR 2) will write it. */
async function tagInbound(binding: { id: string; userId: string; dmChannelId: string }) {
  const randomId = `wechat:${randomUUID()}`;
  await getDb().insert(wechatBridgeInboundMessages).values({
    bindingId: binding.id, ownerUserId: binding.userId, dmChannelId: binding.dmChannelId,
    wechatMessageKey: randomUUID(), randomId, contextToken: "ctx-secret" as WeChatContextToken,
  });
  return randomId;
}

async function inboundRow(randomId: string) {
  const [row] = await getDb().select({ bindingId: wechatBridgeInboundMessages.bindingId, contextToken: wechatBridgeInboundMessages.contextToken })
    .from(wechatBridgeInboundMessages).where(eq(wechatBridgeInboundMessages.randomId, randomId));
  return row ?? null;
}

async function connectedNotices(dmChannelId: string) {
  return getDb().select({ content: messages.content, messageType: messages.messageType }).from(messages)
    .where(and(eq(messages.channelId, dmChannelId), eq(messages.systemSubtype, "assistant.wechat_connected")));
}

/** Bind `person`'s WeChat (`ilinkUserId`) through the whole flow. */
async function bind(baseUrl: string, s: Seed, ilinkUserId: string) {
  const started = await start(baseUrl, s, s.owner);
  ilink.statuses.set(`qr-${ilink.issued}`, [confirmation(ilink.issued, ilinkUserId)]);
  const confirmed = await call(baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
  assert.deepEqual([confirmed.status, confirmed.body], [200, { status: "confirmed" }]);
  return started;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("unavailable unless the person's flag, the server's assistant flag and the key are all on", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    // `other` has an Ottie but no assistant_wechat_v0.
    await createOttie(app.baseUrl, s.server.id, s.other);
    assert.deepEqual((await call(app.baseUrl, s, s.other, "GET", "/status")).body, { available: false, binding: null });
    const refused = await call(app.baseUrl, s, s.other, "POST", "/attempts");
    assert.deepEqual([refused.status, refused.body?.code], [404, "wechat_unavailable"]);

    assert.deepEqual((await call(app.baseUrl, s, s.owner, "GET", "/status")).body, { available: true, binding: null });

    // No key: unavailable for everyone.
    delete process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV];
    assert.equal((await call(app.baseUrl, s, s.owner, "GET", "/status")).body?.available, false);
    assert.equal((await call(app.baseUrl, s, s.owner, "POST", "/attempts")).status, 404);
    process.env[WECHAT_BRIDGE_CREDENTIAL_KEY_ENV] = Buffer.alloc(32, 3).toString("base64");

    // personal_assistant off for the server.
    await getDb().update(featureFlags).set({ defaultEnabled: false }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    assert.equal((await call(app.baseUrl, s, s.owner, "GET", "/status")).body?.available, false);
    assert.equal((await call(app.baseUrl, s, s.owner, "POST", "/attempts")).status, 404);
    assert.equal(ilink.calls.length, 0, "nothing asked of iLink while unavailable");
  });
});

test("a person without an Ottie cannot start; a connected person must disconnect first", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await enableWeChatFor(s.other.id);
    const noOttie = await call(app.baseUrl, s, s.other, "POST", "/attempts");
    assert.deepEqual([noOttie.status, noOttie.body?.code], [404, "assistant_not_found"]);
    await bind(app.baseUrl, s, "wx-user-1@im.wechat");
    const again = await call(app.baseUrl, s, s.owner, "POST", "/attempts");
    assert.deepEqual([again.status, again.body?.code], [409, "wechat_already_connected"]);
  });
});

test("a Guest has no WeChat bridge but can take theirs out: refused status, start and poll, as the guest-hidden surfaces; Disconnect still works", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const setOwnerRole = async (role: "member" | "guest") => {
      if (role === "guest") await seedBoundGuest({ serverId: s.server.id, userId: s.owner.id });
      else await getDb().update(serverMembers).set({ role, guestChannelId: null })
        .where(and(eq(serverMembers.serverId, s.server.id), eq(serverMembers.userId, s.owner.id)));
    };
    // Started while a member, and WeChat would confirm it: polling it is the bind.
    const begun = await start(app.baseUrl, s, s.owner);
    ilink.statuses.set("qr-1", [confirmation(1, "wx-owner@im.wechat")]);
    await setOwnerRole("guest");

    const refusedToGuest = [
      ["GET", "/status", undefined],
      ["POST", `/attempts/${begun.attemptId}/poll`, begun.cookie],
      ["POST", "/attempts", undefined],
    ] as const;
    const answers: unknown[] = [];
    for (const [method, path, cookie] of refusedToGuest) {
      const res = await call(app.baseUrl, s, s.owner, method, path, cookie);
      answers.push([method, path, res.status, res.body]);
    }
    const guestHidden = { error: "Guests can't access server management" };
    assert.deepEqual(answers, refusedToGuest.map(([method, path]) => [method, path, 403, guestHidden]));
    // Nothing bound, nothing more asked of iLink than the member's QR code, the attempt untouched.
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    assert.deepEqual(ilink.calls.map((url) => new URL(url).pathname), ["/ilink/bot/get_bot_qrcode"]);
    const [attempt] = await getDb().select({ status: wechatBridgeAttempts.status }).from(wechatBridgeAttempts)
      .where(eq(wechatBridgeAttempts.id, begun.attemptId));
    assert.equal(attempt?.status, "pending");

    // A member again: the same attempt binds, and the status reads.
    await setOwnerRole("member");
    const bound = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${begun.attemptId}/poll`, begun.cookie);
    assert.deepEqual([bound.status, bound.body], [200, { status: "confirmed" }]);
    assert.equal((await call(app.baseUrl, s, s.owner, "GET", "/status")).status, 200);
    assert.equal((await bindingOf(s.server.id, s.owner.id))?.state, "active");

    // A Guest again, with that binding: they can still take their WeChat credential out.
    await setOwnerRole("guest");
    const removed = await call(app.baseUrl, s, s.owner, "DELETE", "/binding");
    assert.deepEqual([removed.status, removed.body], [200, { binding: null }]);
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    assert.equal((await call(app.baseUrl, s, s.owner, "GET", "/status")).status, 403);
  });
});

test("binding end to end: QR bound to this browser, scan, confirm; encrypted token, audit, notice in the owner's DM", async ({ app }) => {
  await withHostedRuntime(async () => {
    seenBodies.length = 0;
    const s = await seed(app.baseUrl);
    const started = await start(app.baseUrl, s, s.owner);
    assert.equal(started.body.qrContent, "https://liteapp.weixin.qq.com/q/1");
    assert.ok(Date.parse(String(started.body.expiresAt)) > Date.now());
    assert.deepEqual(Object.keys(started.body).sort(), ["attemptId", "expiresAt", "qrContent"]);
    // HttpOnly, path-scoped to the attempts route, lives as long as the attempt.
    assert.match(started.setCookie, new RegExp(`Path=/api/servers/${s.server.id}/assistant/wechat/attempts;`));
    assert.match(started.setCookie, /HttpOnly/);
    assert.match(started.setCookie, /SameSite=Lax/);
    assert.match(started.setCookie, /Max-Age=(29\d|300)/);
    const [attempt] = await getDb().select().from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.id, started.attemptId));
    assert.equal(attempt?.status, "pending");
    assert.ok(!started.cookie.includes(attempt!.stateHash), "the row keeps only the state's hash");

    ilink.statuses.set("qr-1", [
      { status: "wait" },
      { status: "scaned" },
      { status: "need_verifycode" },
      { status: "scaned_but_redirect", redirect_host: "sz.ilinkai.weixin.qq.com" },
      confirmation(1, "wx-owner@im.wechat"),
    ]);
    const poll = () => call(app.baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
    assert.deepEqual((await poll()).body, { status: "wait" });
    assert.deepEqual((await poll()).body, { status: "scanned" });
    assert.deepEqual((await poll()).body, { status: "need_verify_code" });
    // The code goes in a POST body (never a URL Raft serves), and on to iLink.
    const verify = (body: unknown, cookie: string | undefined = started.cookie, who: Person = s.owner) =>
      call(app.baseUrl, s, who, "POST", `/attempts/${started.attemptId}/poll`, cookie, body);
    const notText = await verify({ verifyCode: 123456 });
    assert.deepEqual([notText.status, notText.body?.code], [400, "invalid_verify_code"]);
    assert.equal((await verify({ verifyCode: "12 34" })).status, 400);
    assert.equal((await verify({ verifyCode: "123456" }, "")).status, 403, "the code too only from the starting browser");
    assert.equal((await verify({ verifyCode: "123456" }, started.cookie, s.other)).status, 404);
    assert.ok(!ilink.calls.some((url) => url.includes("verify_code")), "refused codes never reach iLink");
    assert.deepEqual((await verify({ verifyCode: "123456" })).body, { status: "scanned" });
    assert.match(ilink.calls.at(-1)!, /get_qrcode_status\?qrcode=qr-1&verify_code=123456$/);
    const [redirected] = await getDb().select({ qrBaseUrl: wechatBridgeAttempts.qrBaseUrl }).from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.id, started.attemptId));
    assert.equal(redirected?.qrBaseUrl, "https://sz.ilinkai.weixin.qq.com");
    const confirmed = await poll();
    assert.deepEqual([confirmed.status, confirmed.body], [200, { status: "confirmed" }]);
    assert.ok(ilink.calls.at(-1)!.startsWith("https://sz.ilinkai.weixin.qq.com/"), "polled at the redirect host");
    assert.ok(confirmed.setCookies.some((c) => c.startsWith(started.cookie.split("=")[0]!) && /Max-Age=0/.test(c)), "the browser binding is spent");

    const binding = await bindingOf(s.server.id, s.owner.id);
    assert.ok(binding);
    assert.equal(binding.agentId, s.ottie.agentId);
    assert.equal(binding.dmChannelId, s.ottie.dmChannelId);
    assert.equal(binding.ilinkUserId, "wx-owner@im.wechat");
    assert.equal(binding.baseUrl, "https://sh.ilinkai.weixin.qq.com");
    assert.equal(binding.state, "active");
    assert.ok(!binding.encryptedBotToken.includes(SECRET_MARK), "stored encrypted");
    assert.equal(wechatBridgeCredentialCipher()!.unseal({ ...binding, bindingId: binding.id }), `${SECRET_MARK}-1`);
    const [spent] = await getDb().select().from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.id, started.attemptId));
    assert.equal(spent?.status, "confirmed");
    assert.ok(spent?.consumedAt);
    assert.equal(spent?.qrcode, null, "the QR handle is forgotten");

    const bound = await auditRows("assistant.wechat_bound", s.owner.id);
    assert.equal(bound.length, 1);
    assert.equal(bound[0]!.targetId, binding.id);
    assert.equal(bound[0]!.category, "install");
    assert.deepEqual(bound[0]!.metadata, { agentId: s.ottie.agentId, channelId: s.ottie.dmChannelId, replacedBinding: false });

    const notices = await connectedNotices(s.ottie.dmChannelId);
    assert.equal(notices.length, 1, "one system notice, in the owner's DM with their Ottie");
    assert.equal(notices[0]!.messageType, "system");
    assert.match(notices[0]!.content, /^微信已在 \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\) 连接。如果不是你本人操作，请在 Ottie 设置里断开微信。$/);

    const status = await call(app.baseUrl, s, s.owner, "GET", "/status");
    assert.deepEqual(status.body, { available: true, binding: { bindingId: binding.id, state: "active", connectedAt: binding.createdAt.toISOString() } });

    for (const body of seenBodies) {
      assert.ok(!body.includes(SECRET_MARK), `no bot token in ${body}`);
      // (The QR content is iLink's and may embed its polling handle: not checked here.)
      assert.ok(!body.includes("wx-owner@im.wechat") && !body.includes("bot-1@im.bot"), `no iLink user or bot id in ${body}`);
    }
  });
});

test("only the person who started it, in the browser that started it, may poll an attempt", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const started = await start(app.baseUrl, s, s.owner);
    ilink.statuses.set("qr-1", [confirmation(1, "wx-owner@im.wechat")]);

    // Another member, even holding the owner's cookie: 404 (no flag of their own).
    assert.equal((await call(app.baseUrl, s, s.other, "POST", `/attempts/${started.attemptId}/poll`, started.cookie)).status, 404);
    // With the flag and an Ottie of their own, still a stranger: as if it did not exist.
    await enableWeChatFor(s.other.id);
    await createOttie(app.baseUrl, s.server.id, s.other);
    const stranger = await call(app.baseUrl, s, s.other, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
    assert.deepEqual([stranger.status, stranger.body?.code], [404, "wechat_attempt_not_found"]);

    // The owner from another browser: no cookie, or a forged one.
    const noCookie = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`);
    assert.deepEqual([noCookie.status, noCookie.body?.code], [403, "wechat_attempt_unbound"]);
    const forged = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`, `${started.cookie.split("=")[0]}=forged`);
    assert.equal(forged.status, 403);
    // A malformed id is not found.
    assert.equal((await call(app.baseUrl, s, s.owner, "POST", "/attempts/not-an-id/poll", started.cookie)).status, 404);

    assert.equal(ilink.calls.filter((url) => url.includes("get_qrcode_status")).length, 0, "nothing polled for a refused request");
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    assert.equal(await bindingOf(s.server.id, s.other.id), null);
  });
});

test("an attempt is used once and lasts minutes: polling it again, or after it expired, is refused", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const used = await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const again = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${used.attemptId}/poll`, used.cookie);
    assert.deepEqual([again.status, again.body?.code], [410, "wechat_attempt_used"]);

    // Disconnect, start again, let it run out.
    assert.equal((await call(app.baseUrl, s, s.owner, "DELETE", "/binding")).status, 200);
    const stale = await start(app.baseUrl, s, s.owner);
    ilink.statuses.set(`qr-${ilink.issued}`, [confirmation(ilink.issued, "wx-owner@im.wechat")]);
    await getDb().update(wechatBridgeAttempts).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(wechatBridgeAttempts.id, stale.attemptId));
    const polls = ilink.calls.length;
    const expired = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${stale.attemptId}/poll`, stale.cookie);
    assert.deepEqual([expired.status, expired.body?.code], [410, "wechat_attempt_expired"]);
    assert.equal(ilink.calls.length, polls, "an expired attempt is not polled");
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);

    // iLink's own expiry ends it too; a new start replaces the earlier attempt.
    const first = await start(app.baseUrl, s, s.owner);
    const second = await start(app.baseUrl, s, s.owner);
    const pending = await getDb().select({ id: wechatBridgeAttempts.id }).from(wechatBridgeAttempts)
      .where(and(eq(wechatBridgeAttempts.userId, s.owner.id), eq(wechatBridgeAttempts.status, "pending")));
    assert.deepEqual(pending.map((row) => row.id), [second.attemptId], "one pending attempt per person per server");
    assert.equal((await call(app.baseUrl, s, s.owner, "POST", `/attempts/${first.attemptId}/poll`, first.cookie)).status, 404);
    ilink.statuses.set(`qr-${ilink.issued}`, [{ status: "expired" }]);
    assert.deepEqual((await call(app.baseUrl, s, s.owner, "POST", `/attempts/${second.attemptId}/poll`, second.cookie)).body, { status: "expired" });
    assert.equal((await call(app.baseUrl, s, s.owner, "POST", `/attempts/${second.attemptId}/poll`, second.cookie)).status, 410);
  });
});

test("a WeChat account bound to someone's assistant cannot be bound again elsewhere", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await bind(app.baseUrl, s, "wx-shared@im.wechat");

    // Another person, another server: same WeChat account scans their QR code.
    const t = await seed(app.baseUrl);
    const started = await start(app.baseUrl, t, t.owner);
    ilink.statuses.set(`qr-${ilink.issued}`, [confirmation(ilink.issued, "wx-shared@im.wechat")]);
    const refused = await call(app.baseUrl, t, t.owner, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
    assert.deepEqual([refused.status, refused.body?.code], [409, "wechat_account_in_use"]);
    assert.equal(await bindingOf(t.server.id, t.owner.id), null);
    const [attempt] = await getDb().select({ status: wechatBridgeAttempts.status, qrcode: wechatBridgeAttempts.qrcode }).from(wechatBridgeAttempts)
      .where(eq(wechatBridgeAttempts.id, started.attemptId));
    assert.deepEqual(attempt, { status: "failed", qrcode: null }, "spent: the token is dropped, the attempt cannot be retried");
    assert.deepEqual(await connectedNotices(t.ottie.dmChannelId), []);
    assert.ok((await bindingOf(s.server.id, s.owner.id))?.ilinkUserId === "wx-shared@im.wechat", "the first binding is untouched");
  });
});

test("disconnect deletes the binding and its token and is audited; it works with the flag off too", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const binding = await bindingOf(s.server.id, s.owner.id);
    // The flag goes off: the person still sees and removes their connection.
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, ASSISTANT_WECHAT_FEATURE_FLAG_KEY));
    assert.deepEqual((await call(app.baseUrl, s, s.owner, "GET", "/status")).body?.binding, { bindingId: binding!.id, state: "active", connectedAt: binding!.createdAt.toISOString() });
    // Nobody else's Disconnect touches it.
    assert.equal((await call(app.baseUrl, s, s.other, "DELETE", "/binding")).status, 404);
    const randomId = await tagInbound(binding!);
    const removed = await call(app.baseUrl, s, s.owner, "DELETE", "/binding");
    assert.deepEqual([removed.status, removed.body], [200, { binding: null }]);
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    // The tag stays (its turn stays a WeChat turn) but nothing can reply through it any more.
    assert.deepEqual(await inboundRow(randomId), { bindingId: null, contextToken: null });
    const audit = await auditRows("assistant.wechat_disconnected", s.owner.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.targetId, binding!.id);
    assert.equal(audit[0]!.category, "revocation");
    assert.deepEqual(audit[0]!.metadata, { agentId: s.ottie.agentId, reason: "user" });
    assert.deepEqual([(await call(app.baseUrl, s, s.owner, "DELETE", "/binding")).status], [404]);
    assert.deepEqual((await call(app.baseUrl, s, s.owner, "GET", "/status")).body, { available: false, binding: null });
  });
});

test("a disconnect naming a binding removes only that one: an earlier connection's notice never removes the newer connection", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const first = (await bindingOf(s.server.id, s.owner.id))!;
    assert.equal((await call(app.baseUrl, s, s.owner, "DELETE", `/binding?bindingId=${first.id}`)).status, 200, "the binding named");
    await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const second = (await bindingOf(s.server.id, s.owner.id))!;
    assert.notEqual(second.id, first.id);

    // The first connection's notice, clicked now: the newer connection stays.
    const stale = await call(app.baseUrl, s, s.owner, "DELETE", `/binding?bindingId=${first.id}`);
    assert.deepEqual([stale.status, stale.body?.code], [409, "wechat_binding_changed"]);
    assert.equal((await bindingOf(s.server.id, s.owner.id))?.id, second.id, "the newer connection is untouched");
    assert.equal((await auditRows("assistant.wechat_disconnected", s.owner.id)).length, 1, "nothing removed, nothing audited");

    // Not a binding id at all; and someone else naming this binding.
    assert.deepEqual((await call(app.baseUrl, s, s.owner, "DELETE", "/binding?bindingId=not-a-uuid")).body?.code, "invalid_binding_id");
    assert.equal((await call(app.baseUrl, s, s.other, "DELETE", `/binding?bindingId=${second.id}`)).status, 404);
    assert.equal((await bindingOf(s.server.id, s.owner.id))?.id, second.id);

    // The newer one's own id removes it.
    assert.equal((await call(app.baseUrl, s, s.owner, "DELETE", `/binding?bindingId=${second.id}`)).status, 200);
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    assert.equal((await call(app.baseUrl, s, s.owner, "DELETE", `/binding?bindingId=${second.id}`)).status, 404);
  });
});

test("the binding goes when its owner leaves the server, archives their Ottie, or asks to delete their account", async ({ app }) => {
  await withHostedRuntime(async () => {
    const reasonsOf = async (userId: string) => (await auditRows("assistant.wechat_disconnected", userId)).map((row) => (row.metadata as { reason: string }).reason);

    const left = await seed(app.baseUrl);
    await bind(app.baseUrl, left, "wx-left@im.wechat");
    await removeMember(left.server.id, left.owner.id, { actorUserId: left.serverOwner.id });
    assert.equal(await bindingOf(left.server.id, left.owner.id), null);
    assert.deepEqual(await reasonsOf(left.owner.id), ["owner_departed"]);

    const archived = await seed(app.baseUrl);
    await bind(app.baseUrl, archived, "wx-archived@im.wechat");
    const res = await fetch(`${app.baseUrl}/api/servers/${archived.server.id}/assistant`, {
      method: "DELETE",
      headers: headers(await tokenForHuman(archived.owner.email), archived.server.id),
    });
    assert.equal(res.status, 200);
    assert.equal(await bindingOf(archived.server.id, archived.owner.id), null);
    assert.deepEqual(await reasonsOf(archived.owner.id), ["assistant_archived"]);

    const deleted = await seed(app.baseUrl);
    await bind(app.baseUrl, deleted, "wx-deleted@im.wechat");
    // A second, pending attempt in another server goes too.
    const elsewhere = await createServer("Elsewhere", `wx-else-${randomUUID().slice(0, 8)}`, deleted.serverOwner.id);
    await addMember(elsewhere.id, deleted.owner.id);
    await enablePersonalAssistants(elsewhere.id);
    await createOttie(app.baseUrl, elsewhere.id, deleted.owner);
    await start(app.baseUrl, { server: elsewhere }, deleted.owner);
    const outcome = await requestAccountDeletion({ userId: deleted.owner.id, source: "self", actorUserId: deleted.owner.id });
    assert.equal(outcome.kind, "scheduled");
    assert.equal(await bindingOf(deleted.server.id, deleted.owner.id), null);
    assert.deepEqual(await getDb().select({ id: wechatBridgeAttempts.id }).from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.userId, deleted.owner.id)), []);
    assert.deepEqual(await reasonsOf(deleted.owner.id), ["account_deletion"]);
  });
});

test("polling is a POST: the old GET poll does not exist, so neither a code nor a state change rides a GET", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const started = await start(app.baseUrl, s, s.owner);
    ilink.statuses.set("qr-1", [confirmation(1, "wx-owner@im.wechat")]);
    const res = await fetch(`${app.baseUrl}/api/servers/${s.server.id}/assistant/wechat/attempts/${started.attemptId}?verifyCode=123456`, {
      headers: { ...headers(await tokenForHuman(s.owner.email), s.server.id), Cookie: started.cookie },
    });
    assert.equal(res.status, 404);
    assert.equal(ilink.calls.filter((url) => url.includes("get_qrcode_status")).length, 0);
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
  });
});

test("one poll per attempt at a time: a second poll while one waits on iLink is refused (429) and never reaches iLink", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const started = await start(app.baseUrl, s, s.owner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    let statusCalls = 0;
    __setWeChatILinkTransportForTests(async (url, init) => {
      if (!url.includes("get_qrcode_status")) return fakeILink(url, init);
      statusCalls += 1;
      entered();
      await gate;
      return Response.json({ status: "scaned" });
    });
    const poll = () => call(app.baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
    const first = poll();
    await inFlight;
    const second = await poll();
    assert.deepEqual([second.status, second.body?.code], [429, "wechat_poll_in_flight"]);
    assert.equal(statusCalls, 1, "the refused poll never reached iLink");
    release();
    assert.deepEqual((await first).body, { status: "scanned" });
    // The lease is released: the next poll runs.
    assert.deepEqual((await poll()).body, { status: "scanned" });
    assert.equal(statusCalls, 2);
  });
});

test("an Ottie archived while iLink confirms gets no binding (and its owner's attempts go with it)", async ({ app }) => {
  await withHostedRuntime(async () => {
    // Archived through the route, between the status read and the confirm.
    const s = await seed(app.baseUrl);
    const started = await start(app.baseUrl, s, s.owner);
    __setWeChatILinkTransportForTests(async (url, init) => {
      if (!url.includes("get_qrcode_status")) return fakeILink(url, init);
      const archived = await fetch(`${app.baseUrl}/api/servers/${s.server.id}/assistant`, {
        method: "DELETE",
        headers: headers(await tokenForHuman(s.owner.email), s.server.id),
      });
      assert.equal(archived.status, 200);
      assert.deepEqual(await getDb().select({ id: wechatBridgeAttempts.id }).from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.userId, s.owner.id)), [],
        "the archive removed the owner's pending attempt");
      return Response.json(confirmation(1, "wx-owner@im.wechat"));
    });
    const refused = await call(app.baseUrl, s, s.owner, "POST", `/attempts/${started.attemptId}/poll`, started.cookie);
    assert.deepEqual([refused.status, refused.body?.code], [409, "assistant_not_found"]);
    assert.equal(await bindingOf(s.server.id, s.owner.id), null);
    assert.deepEqual(await auditRows("assistant.wechat_bound", s.owner.id), []);

    // Gone some other way at the same moment (the row soft-deleted): refused too, the attempt spent.
    __setWeChatILinkTransportForTests(fakeILink);
    const t = await seed(app.baseUrl);
    const again = await start(app.baseUrl, t, t.owner);
    __setWeChatILinkTransportForTests(async (url, init) => {
      if (!url.includes("get_qrcode_status")) return fakeILink(url, init);
      await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, t.ottie.agentId));
      return Response.json(confirmation(2, "wx-other@im.wechat"));
    });
    const gone = await call(app.baseUrl, t, t.owner, "POST", `/attempts/${again.attemptId}/poll`, again.cookie);
    assert.deepEqual([gone.status, gone.body?.code], [409, "assistant_not_found"]);
    assert.equal(await bindingOf(t.server.id, t.owner.id), null);
    const [spent] = await getDb().select({ status: wechatBridgeAttempts.status }).from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.id, again.attemptId));
    assert.equal(spent?.status, "failed");
  });
});

test("two starts at once by one person: never a 500, and one pending attempt remains", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    const results = await Promise.all([
      call(app.baseUrl, s, s.owner, "POST", "/attempts"),
      call(app.baseUrl, s, s.owner, "POST", "/attempts"),
    ]);
    for (const res of results) assert.ok(res.status === 201 || (res.status === 409 && res.body?.code === "wechat_attempt_in_progress"), JSON.stringify(res.body));
    const pending = await getDb().select({ id: wechatBridgeAttempts.id }).from(wechatBridgeAttempts)
      .where(and(eq(wechatBridgeAttempts.userId, s.owner.id), eq(wechatBridgeAttempts.status, "pending")));
    assert.equal(pending.length, 1);
  });
});

test("the connected notice commits with the binding, exactly once, and reading the status never writes", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const binding = await bindingOf(s.server.id, s.owner.id);
    const notices = await getDb().select({ randomId: messages.randomId, senderId: messages.senderId }).from(messages)
      .where(and(eq(messages.channelId, s.ottie.dmChannelId), eq(messages.systemSubtype, "assistant.wechat_connected")));
    assert.deepEqual(notices, [{ randomId: `wechat-connected:${binding!.id}`, senderId: "system" }], "one notice, keyed by the binding");
    const before = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, s.ottie.dmChannelId));
    for (let i = 0; i < 3; i += 1) assert.equal((await call(app.baseUrl, s, s.owner, "GET", "/status")).status, 200);
    const after = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, s.ottie.dmChannelId));
    assert.equal(after.length, before.length, "GET status posts nothing");
    assert.equal((await connectedNotices(s.ottie.dmChannelId)).length, 1);
  });
});

test("deleting a server removes its WeChat bindings and attempts, audited, and their tags lose the reply tokens", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed(app.baseUrl);
    await bind(app.baseUrl, s, "wx-owner@im.wechat");
    const binding = await bindingOf(s.server.id, s.owner.id);
    const randomId = await tagInbound(binding!);
    await enableWeChatFor(s.other.id);
    await createOttie(app.baseUrl, s.server.id, s.other);
    await start(app.baseUrl, s, s.other);

    const deleted = await deleteServer(s.server.id);
    assert.equal(deleted?.newlyDeleted, true);
    assert.deepEqual(await getDb().select({ id: wechatBridgeBindings.id }).from(wechatBridgeBindings).where(eq(wechatBridgeBindings.serverId, s.server.id)), []);
    assert.deepEqual(await getDb().select({ id: wechatBridgeAttempts.id }).from(wechatBridgeAttempts).where(eq(wechatBridgeAttempts.serverId, s.server.id)), []);
    assert.deepEqual(await inboundRow(randomId), { bindingId: null, contextToken: null });
    const audit = await auditRows("assistant.wechat_disconnected", s.owner.id);
    assert.deepEqual(audit.map((row) => [row.targetId, row.metadata]), [[binding!.id, { agentId: s.ottie.agentId, reason: "server_deleted" }]]);
  });
});
