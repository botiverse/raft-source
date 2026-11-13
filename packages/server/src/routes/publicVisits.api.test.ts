import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { register } from "../metrics";
import * as redis from "../redis";
import { channels, featureFlags, servers, users } from "../db/schema";
import { createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { PRODUCT_EVENT_SINK_APP_KEY, PUBLIC_VISITOR_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink, PublicVisitorRow, PublicVisitorSink } from "../services/productEventScopeDbWriter";
import {
  referrerSite,
  resetPublicVisitCountsForTest,
} from "../services/publicVisitCounts";
import { addMember } from "../services/serverService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

// Public Server visit counts (design reviewed in #proj-analytics, Tenny
// 2026-10-14): count-only, unauthenticated, always 204.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/** Registry properties only: the `$` request context is covered on its own. */
function withoutContext(properties: ProductEventRow["properties"]) {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith("$")));
}

function memorySink() {
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = {
    enqueue(batch) {
      rows.push(...batch);
    },
    async flush() {},
  };
  return { rows, sink };
}

async function enableFlags() {
  const db = getDb();
  await db.update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
}

function memoryVisitorSink() {
  const rows: PublicVisitorRow[] = [];
  const sink: PublicVisitorSink = {
    enqueue(batch) {
      rows.push(...batch);
    },
    async flush() {},
  };
  return { rows, sink };
}

async function seedPublicServer(slug: string) {
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const server = await createServer(`Public ${slug}`, slug, owner.id);
  const open = await createChannel(server.id, "open", undefined, "channel", { type: "user", id: owner.id });
  const closed = await createChannel(server.id, "closed", undefined, "channel", { type: "user", id: owner.id });
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
  await getDb().update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
  return { owner, server, open, closed };
}

async function ingestCount(outcome: string): Promise<number> {
  const metric = await register.getSingleMetric("slock_product_event_ingest_total")?.get();
  return metric?.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
}

async function ingestCounts(outcomes: readonly string[]): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all(outcomes.map(async (o) => [o, await ingestCount(o)] as const)));
}

function visit(
  baseUrl: string,
  slug: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/api/public-visits/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site", ...headers },
    body: JSON.stringify(body),
  });
}

test("public visits: anonymous and signed-in visits are counted per visited server, with the class decided by the server", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { owner, server, open } = await seedPublicServer("visits-counted");
  // Sharing is on unless turned off (RFC-067 default on): the owner turned it off.
  await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, owner.id));
  const outsider = await seedUser("visits-outsider@slock.test", "visits-outsider");
  await getDb().update(users).set({ shareUsageData: true }).where(eq(users.id, outsider.id));
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);

  const anonymous = await visit(app.baseUrl, "visits-counted", { uuid: randomUUID(), event: "public_page_viewed" });
  assert.equal(anonymous.status, 204);
  assert.equal(await anonymous.text(), "");
  const outsiderToken = await tokenForHuman(outsider.email);
  await visit(app.baseUrl, "visits-counted", { uuid: randomUUID(), event: "public_page_channel_opened", channel_id: open.id }, {
    Authorization: `Bearer ${outsiderToken}`,
  });
  await visit(app.baseUrl, "visits-counted", { uuid: randomUUID(), event: "public_page_viewed" }, {
    Authorization: `Bearer ${await tokenForHuman(owner.email)}`,
  });
  // A bad token is just anonymous: the client cannot claim to be signed in.
  await visit(app.baseUrl, "visits-counted", { uuid: randomUUID(), event: "public_page_viewed" }, {
    Authorization: "Bearer not-a-token",
  });

  assert.deepEqual(store.rows.map((row) => [row.event, row.properties.visitor, row.server_id, row.source]), [
    ["public_page_viewed", "anonymous", server.id, "server"],
    ["public_page_channel_opened", "signed_in_non_member", server.id, "server"],
    ["public_page_viewed", "signed_in_member", server.id, "server"],
    ["public_page_viewed", "anonymous", server.id, "server"],
  ]);
  // Only the sharing signed-in visitor carries a user key; nothing else does.
  assert.equal(store.rows[0].analytics_id, null);
  assert.match(String(store.rows[1].analytics_id), /^[0-9a-f-]{36}$/);
  assert.equal(store.rows[2].analytics_id, null, "the owner turned sharing off");
  assert.equal(store.rows[3].analytics_id, null);
  assert.deepEqual(store.rows.map((row) => withoutContext(row.properties)), [
    { visitor: "anonymous" },
    { visitor: "signed_in_non_member", channel_id: open.id },
    { visitor: "signed_in_member" },
    { visitor: "anonymous" },
  ]);
  for (const row of store.rows) assert.equal(row.client_session_id, null);
});

// Where visits come from (cindyz, 2026-10-14): the referring site's
// registrable domain and utm_* on the landing view only, the public channel's id on opens; a bad field is dropped
// without losing the visit.
test("public visits: a view keeps its source fields, an open keeps its channel, and a bad field costs only itself", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { open } = await seedPublicServer("visits-sources");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);

  await visit(app.baseUrl, "visits-sources", {
    uuid: randomUUID(),
    event: "public_page_viewed",
    entry: "landing",
    referrer_domain: "news.ycombinator.com",
    utm_source: "newsletter",
    utm_medium: "email",
    utm_campaign: "launch-2026",
  });
  await visit(app.baseUrl, "visits-sources", { uuid: randomUUID(), event: "public_page_viewed", entry: "in_app" });
  await visit(app.baseUrl, "visits-sources", {
    uuid: randomUUID(),
    event: "public_page_viewed",
    entry: "landing",
    referrer_domain: "https://x.com/someone/status/1",
    utm_source: "someone@example.com",
    utm_campaign: "Spring Sale",
  });
  // Source fields belong to views; on an open they are ignored.
  await visit(app.baseUrl, "visits-sources", {
    uuid: randomUUID(),
    event: "public_page_channel_opened",
    channel_id: open.id.toUpperCase(),
    referrer_domain: "x.com",
  });
  // An unknown entry is refused by the request schema, like any other bad body.
  await visit(app.baseUrl, "visits-sources", { uuid: randomUUID(), event: "public_page_viewed", entry: "bookmark" });

  assert.deepEqual(store.rows.map((row) => withoutContext(row.properties)), [
    {
      visitor: "anonymous",
      entry: "landing",
      referrer_domain: "ycombinator.com",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "launch-2026",
    },
    { visitor: "anonymous", entry: "in_app" },
    { visitor: "anonymous", entry: "landing" },
    { visitor: "anonymous", channel_id: open.id },
  ]);
});

// cindyz, 2026-10-15 (via Tenny): thread opens on a public page. Kept only for a
// live thread whose parent message sits in the public channel sent with it.
test("public visits: a thread open keeps its public channel and thread, and only a public thread under that channel counts", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { owner, server, open, closed } = await seedPublicServer("visits-threads");
  const creator = { type: "user" as const, id: owner.id };
  const otherOpen = await createChannel(server.id, "other-open", undefined, "channel", creator);
  await getDb().update(channels).set({ guestVisible: true }).where(eq(channels.id, otherOpen.id));
  const thread = await getOrCreateThread((await createMessage(open.id, "user", owner.id, "public parent")).id, owner.id, "user");
  const closedThread = await getOrCreateThread((await createMessage(closed.id, "user", owner.id, "closed parent")).id, owner.id, "user");
  const archivedThread = await getOrCreateThread((await createMessage(open.id, "user", owner.id, "archived parent")).id, owner.id, "user");
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archivedThread.id));
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const opened = (body: Record<string, unknown>) =>
    visit(app.baseUrl, "visits-threads", { uuid: randomUUID(), event: "public_page_thread_opened", ...body });

  await opened({ channel_id: open.id.toUpperCase(), thread_channel_id: thread.id.toUpperCase() });
  // Refused: a missing id, a thread under a channel that is not public, a
  // public thread sent with another public channel, an archived thread, and a
  // plain channel posing as a thread.
  await opened({ channel_id: open.id });
  await opened({ thread_channel_id: thread.id });
  await opened({ channel_id: closed.id, thread_channel_id: closedThread.id });
  await opened({ channel_id: otherOpen.id, thread_channel_id: thread.id });
  await opened({ channel_id: open.id, thread_channel_id: archivedThread.id });
  await opened({ channel_id: open.id, thread_channel_id: otherOpen.id });
  // The thread id belongs to thread opens only.
  await visit(app.baseUrl, "visits-threads", {
    uuid: randomUUID(),
    event: "public_page_channel_opened",
    channel_id: open.id,
    thread_channel_id: thread.id,
  });

  assert.deepEqual(store.rows.map((row) => [row.event, withoutContext(row.properties)]), [
    ["public_page_thread_opened", { visitor: "anonymous", channel_id: open.id, thread_channel_id: thread.id }],
    ["public_page_channel_opened", { visitor: "anonymous", channel_id: open.id }],
  ]);
});

// cindyz / Tenny, 2026-10-14: an anonymous visit gets the same coarse request
// context as signed-in events; the raw user agent is never stored.
test("public visits: a visit carries the browser, OS, device type and country derived from its request", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  await seedPublicServer("visits-context");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  await visit(app.baseUrl, "visits-context", { uuid: randomUUID(), event: "public_page_viewed" }, {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "CloudFront-Viewer-Country": "JP",
  });
  assert.deepEqual(store.rows.map((row) => row.properties), [{
    $browser: "safari",
    $browser_version: 17,
    $os: "ios",
    $device_type: "mobile",
    $country: "JP",
    visitor: "anonymous",
  }]);
  assert.equal(JSON.stringify(store.rows).includes("iPhone OS"), false, "the raw user agent is never stored");
});

test("public visits: every refusal is an indistinguishable 204 that records nothing", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { server, open, closed } = await seedPublicServer("visits-refused");
  const privateOwner = await seedUser("visits-private-owner@slock.test", "visits-private-owner");
  await createServer("Private", "visits-private", privateOwner.id);
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const viewed = () => ({ uuid: randomUUID(), event: "public_page_viewed" });
  // Every refusal reason keeps its own outcome (AndyLok, Tenny 2026-10-15):
  // a flag that is off must never read like "no store" or "no visits".
  const reasons = [
    "public_visit_no_target",
    "public_visit_flag_off",
    "public_visit_workspace_off",
    "public_visit_bad_channel",
    "public_visit_not_same_site",
    "rejected_malformed",
    "unconfigured",
  ] as const;
  const before = await ingestCounts(reasons);
  const counted = async () => {
    const now = await ingestCounts(reasons);
    return Object.fromEntries(reasons.map((r) => [r, now[r] - before[r]]));
  };

  const responses = await Promise.all([
    visit(app.baseUrl, "no-such-slug", viewed()),
    visit(app.baseUrl, "visits-private", viewed()),
    visit(app.baseUrl, "visits-refused", viewed(), { "Sec-Fetch-Site": "cross-site" }),
    fetch(`${app.baseUrl}/api/public-visits/visits-refused`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(viewed()),
    }),
    visit(app.baseUrl, "visits-refused", { ...viewed(), visitor: "signed_in_member" }),
    visit(app.baseUrl, "visits-refused", { uuid: "not-a-uuid", event: "public_page_viewed" }),
    visit(app.baseUrl, "visits-refused", { uuid: randomUUID(), event: "message_read" }),
    visit(app.baseUrl, "visits-refused", { uuid: randomUUID(), event: "public_page_channel_opened" }),
    visit(app.baseUrl, "visits-refused", { uuid: randomUUID(), event: "public_page_channel_opened", channel_id: closed.id }),
    // Over 1 KB, and not JSON at all: refused while parsing, still an empty 204.
    visit(app.baseUrl, "visits-refused", { ...viewed(), padding: "x".repeat(2048) }),
    fetch(`${app.baseUrl}/api/public-visits/visits-refused`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
      body: "{not json",
    }),
  ]);
  for (const res of responses) {
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  assert.equal(store.rows.length, 0);
  // Unknown slug + private server; cross-site + no header; a client-sent
  // visitor, a bad uuid, an unregistered event, too large, not JSON; the open
  // without a channel + the closed channel.
  assert.deepEqual(await counted(), {
    public_visit_no_target: 2,
    public_visit_flag_off: 0,
    public_visit_workspace_off: 0,
    public_visit_bad_channel: 2,
    public_visit_not_same_site: 2,
    rejected_malformed: 5,
    unconfigured: 0,
  });

  // The visited workspace turned product analytics off: nothing (RFC-067 §9.5, strict).
  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, server.id));
  resetPublicVisitCountsForTest();
  await visit(app.baseUrl, "visits-refused", { uuid: randomUUID(), event: "public_page_channel_opened", channel_id: open.id });
  assert.equal(store.rows.length, 0);

  // public_server_v0 off (here for every server): nothing, counted as flag_off.
  await getDb().update(servers).set({ productAnalyticsEnabled: true }).where(eq(servers.id, server.id));
  await getDb().update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
  resetPublicVisitCountsForTest();
  await visit(app.baseUrl, "visits-refused", viewed());
  assert.equal(store.rows.length, 0);
  assert.equal((await counted()).public_visit_workspace_off, 1);
  assert.equal((await counted()).public_visit_flag_off, 1);

  // No store configured: counted as that, before any flag is looked at.
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, null);
  await visit(app.baseUrl, "visits-refused", viewed());
  assert.equal((await counted()).unconfigured, 1);
  assert.equal((await counted()).public_visit_flag_off, 1);
});

test("public visits: a repeated uuid counts once and the daily cap stops counting", async ({ app }) => {
  resetPublicVisitCountsForTest({ dailyCap: 2 });
  await enableFlags();
  await seedPublicServer("visits-capped");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);

  const uuid = randomUUID();
  await visit(app.baseUrl, "visits-capped", { uuid, event: "public_page_viewed" });
  await visit(app.baseUrl, "visits-capped", { uuid, event: "public_page_viewed" });
  assert.equal(store.rows.length, 1);
  for (let i = 0; i < 3; i += 1) {
    await visit(app.baseUrl, "visits-capped", { uuid: randomUUID(), event: "public_page_viewed" });
  }
  assert.equal(store.rows.length, 2, "rows stop at the cap; a server-day at the cap reads as 'at least'");
  resetPublicVisitCountsForTest();
});

// cindyz / Tenny, 2026-10-14: after cookie consent a logged-out visitor's
// random id is personal data. It goes only to product.public_visitors (395-day
// retention), never into product.events, and never for a signed-in view.
test("public visits: a consenting logged-out visitor's id is kept only in product.public_visitors", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { owner, server } = await seedPublicServer("visits-visitor-id");
  const store = memorySink();
  const visitors = memoryVisitorSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  app.app.set(PUBLIC_VISITOR_SINK_APP_KEY, visitors.sink);
  const offered = async (headers: Record<string, string> = {}) => {
    const res = await fetch(`${app.baseUrl}/api/public/servers/visits-visitor-id`, { headers });
    assert.equal(res.headers.get("cache-control"), "no-store", "a cache must never hand one visitor's answer to another");
    return ((await res.json()) as { visitorIdMode?: string }).visitorIdMode;
  };
  // By the visitor's country (cindyz, 2026-10-15): ask first where the law
  // requires it, or when the country is unknown; on by default elsewhere.
  assert.equal(await offered(), "ask", "no country header: ask");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "DE" }), "ask");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "CN" }), "ask");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "US" }), "default_on");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "CA", "CloudFront-Viewer-Country-Region": "QC" }), "ask");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "CA", "CloudFront-Viewer-Country-Region": "ON" }), "default_on");
  assert.equal(await offered({ "CloudFront-Viewer-Country": "US", "Sec-GPC": "1" }), "default_off", "Global Privacy Control");

  const anonymousId = randomUUID();
  const uuid = randomUUID();
  await visit(app.baseUrl, "visits-visitor-id", { uuid, event: "public_page_viewed", anonymous_id: anonymousId.toUpperCase() });
  assert.equal(store.rows.length, 1);
  assert.equal(JSON.stringify(store.rows).includes(anonymousId), false, "the visitor id never enters product.events");
  assert.deepEqual(visitors.rows.map(({ received_at: _at, ...row }) => row), [
    { uuid, event: "public_page_viewed", server_id: server.id, anonymous_id: anonymousId },
  ]);

  // A malformed id is dropped on its own; the visit still counts.
  await visit(app.baseUrl, "visits-visitor-id", { uuid: randomUUID(), event: "public_page_viewed", anonymous_id: "not-a-uuid" });
  assert.equal(store.rows.length, 2);
  assert.equal(visitors.rows.length, 1);

  // A signed-in view is never linked; only a join is (recordPublicServerJoin).
  await visit(app.baseUrl, "visits-visitor-id", { uuid: randomUUID(), event: "public_page_viewed", anonymous_id: randomUUID() }, {
    Authorization: `Bearer ${await tokenForHuman(owner.email)}`,
  });
  assert.equal(store.rows.length, 3);
  assert.equal(visitors.rows.length, 1);
});

test("public visits: the retired public join (404) records no join and links no visitor id, even for a joiner who shares usage data", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
  const { server } = await seedPublicServer("visits-join-link");
  const store = memorySink();
  const visitors = memoryVisitorSink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  app.app.set(PUBLIC_VISITOR_SINK_APP_KEY, visitors.sink);
  const join = async (email: string) => fetch(`${app.baseUrl}/api/public/servers/visits-join-link/join-as-guest`, {
    method: "POST",
    headers: headers(await tokenForHuman(email), server.id),
    body: JSON.stringify({ anonymous_id: randomUUID() }),
  });

  // A Guest is created only by accepting an external invite to its channel (#wg-rbac:#15).
  const sharing = await seedUser("visits-join-sharing@slock.test", "visits-join-sharing");
  await getDb().update(users).set({ shareUsageData: true }).where(eq(users.id, sharing.id));
  assert.equal((await join(sharing.email)).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(store.rows.filter((row) => row.event === "public_page_server_joined").length, 0);
  assert.equal(visitors.rows.length, 0);
});

// Tenny, 2026-10-14: staging showed a repeat landing on another task got
// written, because the uuid set is per replica. With Redis the check is shared.
function fakeRedis(options: { failing?: boolean } = {}) {
  const keys = new Map<string, string>();
  const fail = () => {
    if (options.failing) throw new Error("redis down");
  };
  const client = {
    keys,
    async set(key: string, value: string, ...args: unknown[]) {
      fail();
      assert.deepEqual(args, ["EX", 86_400, "NX"]);
      if (keys.has(key)) return null;
      keys.set(key, value);
      return "OK";
    },
    async incr(key: string) {
      fail();
      const next = Number(keys.get(key) ?? 0) + 1;
      keys.set(key, String(next));
      return next;
    },
    async expire() {
      fail();
      return 1;
    },
  };
  const spies = [
    vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true),
    vi.spyOn(redis, "getRedis").mockReturnValue(client as unknown as ReturnType<typeof redis.getRedis>),
  ];
  return { keys, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

test("public visits: a uuid another replica already counted is dropped (shared check in Redis)", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  await seedPublicServer("visits-shared-dedupe");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const fake = fakeRedis();
  try {
    // Seen by another replica: this one has never seen it locally.
    const elsewhere = randomUUID();
    fake.keys.set(`public-visits:uuid:${elsewhere}`, "1");
    await visit(app.baseUrl, "visits-shared-dedupe", { uuid: elsewhere, event: "public_page_viewed" });
    assert.equal(store.rows.length, 0);

    const uuid = randomUUID();
    await visit(app.baseUrl, "visits-shared-dedupe", { uuid, event: "public_page_viewed" });
    await visit(app.baseUrl, "visits-shared-dedupe", { uuid, event: "public_page_viewed" });
    assert.equal(store.rows.length, 1);
    const slots = [...fake.keys].filter(([key]) => !key.startsWith("public-visits:uuid:"));
    assert.deepEqual(slots.map(([, count]) => count), ["1"], "a repeat does not take a cap slot");
  } finally {
    fake.restore();
  }
});

test("public visits: a failing Redis falls back to this replica and still counts the visit", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  await seedPublicServer("visits-redis-down");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  const fake = fakeRedis({ failing: true });
  try {
    const uuid = randomUUID();
    await visit(app.baseUrl, "visits-redis-down", { uuid, event: "public_page_viewed" });
    await visit(app.baseUrl, "visits-redis-down", { uuid, event: "public_page_viewed" });
    assert.equal(store.rows.length, 1);
  } finally {
    fake.restore();
  }
});

test("public visits: a member is still a member when they visit (members are counted, not hidden)", async ({ app }) => {
  resetPublicVisitCountsForTest();
  await enableFlags();
  const { server } = await seedPublicServer("visits-member");
  const member = await seedUser("visits-member-user@slock.test", "visits-member-user");
  await addMember(server.id, member.id, "member");
  const store = memorySink();
  app.app.set(PRODUCT_EVENT_SINK_APP_KEY, store.sink);
  await visit(app.baseUrl, "visits-member", { uuid: randomUUID(), event: "public_page_viewed" }, {
    Authorization: `Bearer ${await tokenForHuman(member.email)}`,
  });
  assert.deepEqual(store.rows.map((row) => row.properties.visitor), ["signed_in_member"]);
});

// Tenny, 2026-10-14: a host name can name a person or an internal system, so
// only the registrable domain under an ICANN suffix is kept.
test("referrerSite keeps the registrable domain and nothing that names a person or an internal host", () => {
  const cases: Array<[string, string | null]> = [
    ["x.com", "x.com"],
    ["t.co", "t.co"],
    ["news.ycombinator.com", "ycombinator.com"],
    ["google.co.uk", "google.co.uk"],
    ["mp.weixin.qq.com", "qq.com"],
    ["alice.github.io", "github.io"],
    ["bob.notion.site", "notion.site"],
    ["carol.substack.com", "substack.com"],
    ["my-app.vercel.app", "vercel.app"],
    ["wiki.corp.acme.com", "acme.com"],
    ["jira.corp.internal", null],
    ["intranet.local", null],
    ["com", null],
    ["https://x.com/someone/status/1", null],
    ["192.168.1.10", null],
  ];
  for (const [host, site] of cases) assert.equal(referrerSite(host), site, host);
});
