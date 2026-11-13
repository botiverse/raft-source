import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channelExternalInvites, servers } from "../db/schema";
import { archiveChannel, createChannel, deleteChannel } from "../services/channelService";
import { maskInviteEmail } from "../services/externalInviteService";
import { createApiTest } from "../test/integration/apiTest";
import { seedUser, seedWorld, sha256 } from "../test/externalInviteFixture";
import { captureProductEvents } from "../test/integration/paywallHits";
import { holdsOnceADayKeyForTest } from "../services/serverProductEvents";
import { likelyBotUserAgent } from "../services/externalInviteProductEvents";
import { vi } from "vitest";

// The signed-out landing page of an invite link (#wg-rbac:#39): no sign-in,
// only what the invite email already says, and one answer for every invite
// that can't be accepted now.
const test = createApiTest();

const DAY_MS = 24 * 60 * 60 * 1000;
const NEUTRAL = { error: "This invite link is not valid" };

type World = Awaited<ReturnType<typeof seedWorld>>;

async function seedInvite(world: World, input: {
  email: string;
  channelId?: string;
  hostServerId?: string;
  status?: "pending" | "awaiting_approval" | "connecting" | "accepted" | "revoked" | "expired";
  expiresAt?: Date;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("hex");
  const status = input.status ?? "pending";
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId: input.channelId ?? world.room.id,
    hostServerId: input.hostServerId ?? world.server.id,
    email: input.email,
    tokenHash: sha256(token),
    invitedByUserId: world.owner.id,
    status,
    outcome: status === "accepted" ? "server" : null,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

function preview(baseUrl: string, token: string, auth?: string) {
  return fetch(`${baseUrl}/api/external-invites/${token}/preview`, auth ? { headers: { Authorization: `Bearer ${auth}` } } : {});
}

test("a signed-out link holder sees only that the link is usable and the address masked: no channel, server, inviter or expiry", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invitee = await seedUser(`ext-preview-${randomBytes(4).toString("hex")}`);
  const expiresAt = new Date(Date.now() + 5 * DAY_MS);
  const invite = await seedInvite(world, { email: invitee.email, expiresAt });

  const res = await preview(app.baseUrl, invite.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json() as Record<string, unknown>;
  const [owner] = [world.owner];
  assert.deepEqual(Object.keys(body).sort(), ["invitedEmailMasked", "status"]);
  assert.equal(body.status, "valid");
  assert.equal(body.invitedEmailMasked, maskInviteEmail(invitee.email));
  assert.notEqual(body.invitedEmailMasked, invitee.email);
  // No ids, members, messages or progress, however the body is read.
  const raw = JSON.stringify(body);
  // Nor the names a forwarded link would give away (cindyz #wg-rbac:5433e81b).
  for (const secret of [invitee.email, world.room.id, world.server.id, owner.id, invite.id, world.member.id, owner.email,
    world.room.name, "External Host", owner.displayName || owner.name]) {
    assert.ok(!raw.includes(secret), `the preview must not carry ${secret}`);
  }

  // Signed in or not, the preview is the same; it is not the invitee page.
  const signedIn = await preview(app.baseUrl, invite.token, "not-a-real-token");
  assert.equal(signedIn.status, 200);
  assert.deepEqual(await signedIn.json(), body);
  // The invitee page itself still needs a sign-in.
  assert.equal((await fetch(`${app.baseUrl}/api/external-invites/${invite.token}`)).status, 401);
});

test("an invite waiting for approval still previews; it says nothing about the progress", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  for (const status of ["awaiting_approval"] as const) {
    const channel = await createChannel(world.server.id, `ext-prev-a-${world.tag}`, undefined, "private", { type: "user", id: world.owner.id });
    const invite = await seedInvite(world, { email: `prev-a-${world.tag}@example.com`, channelId: channel.id, status });
    const res = await preview(app.baseUrl, invite.token);
    assert.equal(res.status, 200, status);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, "valid");
    assert.ok(!JSON.stringify(body).includes(status), `no progress state for ${status}`);
  }
});

test("every invite that can't be accepted now answers the same 404, signed out", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const elsewhere = await seedWorld(app.baseUrl);
  const flagOff = await seedWorld(app.baseUrl, { flag: false });
  const spare = () => createChannel(world.server.id, `ext-prev-spare-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id });
  const email = (label: string) => `prev-${label}-${world.tag}@example.com`;
  const doomed = await spare();
  const archived = await spare();
  const goneServer = await seedWorld(app.baseUrl);

  const cases: Array<[string, string]> = [
    ["unknown token", randomBytes(32).toString("hex")],
    ["expired by time", (await seedInvite(world, { email: email("time"), channelId: (await spare()).id, expiresAt: new Date(Date.now() - 1000) })).token],
    ["revoked", (await seedInvite(world, { email: email("revoked"), status: "revoked" })).token],
    ["expired", (await seedInvite(world, { email: email("expired"), status: "expired" })).token],
    ["accepted", (await seedInvite(world, { email: email("accepted"), status: "accepted" })).token],
    ["deleted channel", (await seedInvite(world, { email: email("deleted"), channelId: doomed.id })).token],
    ["archived channel", (await seedInvite(world, { email: email("archived"), channelId: archived.id })).token],
    ["channel of another server", (await seedInvite(world, { email: email("other"), channelId: (await spare()).id, hostServerId: elsewhere.server.id })).token],
    ["flag off on the host", (await seedInvite(flagOff, { email: email("flag") })).token],
    ["deleted host server", (await seedInvite(goneServer, { email: email("server") })).token],
  ];
  await deleteChannel(doomed.id);
  await archiveChannel(archived.id, world.owner.id);
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, goneServer.server.id));

  for (const [label, token] of cases) {
    const res = await preview(app.baseUrl, token);
    assert.equal(res.status, 404, label);
    assert.deepEqual(await res.json(), NEUTRAL, label);
  }
});

// external_invite_link_opened (Nova's contract; Tenny's conditions, #wg-rbac:#60).
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 cf-ua-marker";
const BOT_UA = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots) cf-bot-marker";
const openLink = (baseUrl: string, token: string, userAgent: string) => fetch(`${baseUrl}/api/external-invites/${token}/preview`, { headers: { "User-Agent": userAgent } });

test("the signed-out link opened is at most two external_invite_link_opened per invite and day (likely a bot, not): likely_bot only, no person, server or invite; nothing for an unusable invite", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invite = await seedInvite(world, { email: "opened@example.com" });
  const second = await seedInvite(world, { email: "opened-too@example.com", channelId: (await createChannel(world.server.id, `ext-open-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: world.owner.id })).id });
  const events = captureProductEvents(app, "external_invite_link_opened");
  // (b) The User-Agent is judged and dropped: never logged while the open is handled and recorded.
  const logged: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
  try {
    assert.equal((await openLink(app.baseUrl, invite.token, BROWSER_UA)).status, 200);
    const [first] = await events.expect(1, "the first open");
    assert.deepEqual(first!.properties, { likely_bot: false });
    assert.deepEqual({ source: first!.source, who: first!.analytics_id, server: first!.server_id }, { source: "server", who: null, server: null });

    // The same invite again the same day in a browser: still one row.
    assert.equal((await openLink(app.baseUrl, invite.token, BROWSER_UA)).status, 200);
    await events.expect(1, "once per invite, day and likely_bot");
    // A link unfurler on it: its own row (likely_bot is in the key), then no more of those either.
    assert.equal((await openLink(app.baseUrl, invite.token, BOT_UA)).status, 200);
    assert.equal((await openLink(app.baseUrl, invite.token, BOT_UA)).status, 200);
    assert.deepEqual((await events.expect(2, "at most two per invite and day")).map((row) => row.properties), [{ likely_bot: false }, { likely_bot: true }]);
    // A mail scanner opening the other invite first does not hide the person who opens it after.
    assert.equal((await openLink(app.baseUrl, second.token, BOT_UA)).status, 200);
    assert.equal((await openLink(app.baseUrl, second.token, BROWSER_UA)).status, 200);
    const rows = await events.expect(4, "another invite, the scanner first");
    assert.deepEqual(rows.slice(2).map((row) => row.properties), [{ likely_bot: true }, { likely_bot: false }]);

    // An invite that cannot be used: the one 404, no row.
    assert.equal((await openLink(app.baseUrl, randomBytes(32).toString("hex"), BROWSER_UA)).status, 404);
    await events.expect(4, "an unusable invite");

    // (a) The dedupe key (the day and a hash of the invite) is in no row, nor anything of the invite, its host or the User-Agent.
    const raw = JSON.stringify(events.rows());
    for (const secret of [invite.id, second.id, sha256(invite.id), sha256(second.id), invite.token, second.token, world.server.id, world.room.id, "cf-ua-marker", "cf-bot-marker", "Slackbot", "Safari"]) {
      assert.equal(raw.includes(secret), false, `no ${secret} in a row`);
    }
    for (const line of logged) assert.ok(!line.includes("cf-ua-marker") && !line.includes("cf-bot-marker"), `the User-Agent was logged: ${line}`);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  // (a) The key does not outlive the day: this process drops it 26 hours after it was set (Redis: the same TTL).
  const day = new Date().toISOString().slice(0, 10);
  const key = `external-invite-link-opened:${day}:${sha256(invite.id)}:not_bot`;
  assert.equal(holdsOnceADayKeyForTest(key), true, "held today");
  assert.equal(holdsOnceADayKeyForTest(key, Date.now() + 27 * 60 * 60 * 1000), false, "gone after 26 hours");
});

test("(c) external_invite_link_opened: nothing for an invite whose host server has product analytics off, read from the invite's host", async ({ app }) => {
  const world = await seedWorld(app.baseUrl);
  const invite = await seedInvite(world, { email: "host-off@example.com" });
  const events = captureProductEvents(app, "external_invite_link_opened");
  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, world.server.id));
  assert.equal((await openLink(app.baseUrl, invite.token, BROWSER_UA)).status, 200, "the preview itself is unchanged");
  await events.expect(0, "the host's switch is off");
  await getDb().update(servers).set({ productAnalyticsEnabled: true }).where(eq(servers.id, world.server.id));
  assert.equal((await openLink(app.baseUrl, invite.token, BROWSER_UA)).status, 200);
  await events.expect(1, "on again: the skipped open took no once-a-day key");
});

test("likely_bot is a rough judgment from the User-Agent: browsers and the Raft App are not, crawlers, unfurlers, scripts and no User-Agent are", () => {
  assert.equal(likelyBotUserAgent(BROWSER_UA), false);
  assert.equal(likelyBotUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"), false);
  assert.equal(likelyBotUserAgent(BOT_UA), true);
  assert.equal(likelyBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(likelyBotUserAgent("curl/8.7.1"), true);
  assert.equal(likelyBotUserAgent("python-requests/2.32"), true);
  assert.equal(likelyBotUserAgent(undefined), true);
  assert.equal(likelyBotUserAgent(""), true);
});
