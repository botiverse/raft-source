import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import type { ServerId } from "@botiverse/raft-shared";
import { vi } from "vitest";
import { getDb } from "../db/index";
import * as redis from "../redis";
import { servers, userAnalyticsIds, users } from "../db/schema";
import { addMember, createServer } from "./serverService";
import { __resetStripeForTests, __setStripeForTests, createCheckoutSession, handleWebhookEvent } from "./billingService";
import type { ProductEventRow, ProductEventSink } from "./productEventScopeDbWriter";
import { recordPaywallHit, recordServerProductEvent, resetPaywallHitsForTest } from "./serverProductEvents";

// Server-recorded product events for paid features and billing (xxchan via
// Till, 2026-10-20, #proj-analytics:8fc671a3): the gate decides, a hit is
// counted once a day, and purchases carry the paywall that led to them but
// nothing that links to Stripe.

const ENV_KEYS = [
  "STRIPE_BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_product_events";
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
  resetPaywallHitsForTest();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] == null) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
  __resetStripeForTests();
  await closeTestDatabase();
});

function memorySink() {
  const rows: ProductEventRow[] = [];
  const sink: ProductEventSink = { enqueue: (batch) => { rows.push(...batch); }, flush: async () => {} };
  return { rows, sink };
}

async function settle(rows: readonly ProductEventRow[], count: number): Promise<void> {
  for (let i = 0; i < 100 && rows.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function seedUser(label: string, shareUsageData: boolean | null = null) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
    shareUsageData,
  }).returning();
  return user;
}

async function seedServer(name: string, ownerId: string) {
  const server = await createServer(name, `${name.toLowerCase()}-${randomUUID()}`, ownerId);
  return { ...server, id: server.id as ServerId };
}

async function analyticsIdOf(userId: string): Promise<string> {
  const [row] = await getDb().select({ id: userAnalyticsIds.analyticsId }).from(userAnalyticsIds).where(eq(userAnalyticsIds.userId, userId));
  assert.ok(row, "users get an analytics id on insert");
  return row.id;
}

test("server product events follow the gate: analytics_id only when sharing, nothing when the workspace is off", async () => {
  await openTestDatabase("pglite://");
  const sharer = await seedUser("gate-sharer", true);
  const other = await seedUser("gate-other", false);
  const server = await seedServer("Gate", sharer.id);
  const { rows, sink } = memorySink();
  const properties = { gate: "translation", actor: "person", plan: "free" } as const;

  assert.equal(await recordServerProductEvent(sink, { event: "paywall_hit", userId: sharer.id, serverId: server.id, properties }), "written");
  assert.equal(await recordServerProductEvent(sink, { event: "paywall_hit", userId: other.id, serverId: server.id, properties }), "written");
  assert.deepEqual(rows.map((row) => [row.source, row.analytics_id, row.server_id]), [
    ["server", await analyticsIdOf(sharer.id), server.id],
    ["server", null, server.id],
  ]);

  await getDb().update(servers).set({ productAnalyticsEnabled: false }).where(eq(servers.id, server.id));
  assert.equal(await recordServerProductEvent(sink, { event: "paywall_hit", userId: sharer.id, serverId: server.id, properties }), "gated");
  assert.equal(await recordServerProductEvent(null, { event: "paywall_hit", userId: sharer.id, serverId: server.id, properties }), "unconfigured");
  assert.equal(rows.length, 2);
});

test("server product events are checked against the registry", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("registry-owner");
  const server = await seedServer("Registry", owner.id);
  const { rows, sink } = memorySink();
  const outcome = await recordServerProductEvent(sink, {
    event: "paywall_hit",
    userId: owner.id,
    serverId: server.id,
    properties: { gate: "not_a_gate", actor: "person", plan: "free" } as never,
  });
  assert.equal(outcome, "rejected");
  // A client-only event cannot be written as a server fact.
  assert.equal(await recordServerProductEvent(sink, {
    event: "paywall_shown",
    userId: owner.id,
    serverId: server.id,
    properties: { gate: "translation", viewer_role: "owner", plan: "free" },
  }), "rejected");
  assert.equal(rows.length, 0);
});

test("paywall_hit is counted once per user, server, gate and UTC day, with the viewer's role and the plan", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("hit-owner");
  const member = await seedUser("hit-member");
  const server = await seedServer("Hits", owner.id);
  await addMember(server.id, member.id, "member");
  const { rows, sink } = memorySink();
  const day1 = Date.parse("2026-10-20T08:00:00Z");
  const day2 = Date.parse("2026-10-21T00:30:00Z");

  assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: member.id, serverId: server.id, now: day1 }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: member.id, serverId: server.id, now: day1 + 60_000 }), "duplicate");
  assert.equal(await recordPaywallHit(sink, { gate: "translation", userId: member.id, serverId: server.id, now: day1 }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: owner.id, serverId: server.id, now: day1 }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: member.id, serverId: server.id, now: day2 }), "written");

  assert.deepEqual(rows.map((row) => [row.event, row.properties, row.timestamp]), [
    ["paywall_hit", { gate: "history_30d", actor: "person", plan: "free", viewer_role: "member" }, new Date(day1).toISOString()],
    ["paywall_hit", { gate: "translation", actor: "person", plan: "free", viewer_role: "member" }, new Date(day1).toISOString()],
    ["paywall_hit", { gate: "history_30d", actor: "person", plan: "free", viewer_role: "owner" }, new Date(day1).toISOString()],
    ["paywall_hit", { gate: "history_30d", actor: "person", plan: "free", viewer_role: "member" }, new Date(day2).toISOString()],
  ]);
});

test("paywall_hit for the monthly quota: the usage numbers, once per via; an agent's has no person (no viewer_role, no analytics_id), once per server", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("via-owner");
  const server = await seedServer("Via", owner.id);
  const { rows, sink } = memorySink();
  const now = Date.parse("2026-10-20T08:00:00Z");
  const usage = { requestedBytes: 2048, monthUsedBytes: 104_000_000 };

  // A person's attachment upload (no via), then their Artifacts import: two hits the same day.
  assert.equal(await recordPaywallHit(sink, { gate: "upload_monthly_quota", userId: owner.id, serverId: server.id, usage, now }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "upload_monthly_quota", userId: owner.id, serverId: server.id, via: "artifact_import", usage, now }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "upload_monthly_quota", userId: owner.id, serverId: server.id, via: "artifact_import", usage, now }), "duplicate");
  // Agents: one per server, via and day, whichever agent.
  assert.equal(await recordPaywallHit(sink, { gate: "upload_monthly_quota", userId: null, serverId: server.id, via: "artifact_publish", usage, now }), "written");
  assert.equal(await recordPaywallHit(sink, { gate: "upload_monthly_quota", userId: null, serverId: server.id, via: "artifact_publish", usage, now }), "duplicate");

  const numbers = { requested_bytes: 2048, month_used_bytes: 104_000_000 };
  assert.deepEqual(rows.map((row) => row.properties), [
    { gate: "upload_monthly_quota", actor: "person", plan: "free", viewer_role: "owner", ...numbers },
    { gate: "upload_monthly_quota", actor: "person", plan: "free", viewer_role: "owner", via: "artifact_import", ...numbers },
    { gate: "upload_monthly_quota", actor: "agent", plan: "free", via: "artifact_publish", ...numbers },
  ]);
  assert.equal(rows[1]!.analytics_id, await analyticsIdOf(owner.id));
  assert.equal(rows[2]!.analytics_id, null, "an agent's hit counts toward the server only");
  assert.equal(rows[2]!.server_id, server.id);
});

// meichen, 2026-11-11: the user id decides `actor`, not the role. A person
// with no member row on the counted server has no viewer_role and is still a
// person; only a refusal with no person at all is an agent's.
test("paywall_hit's actor follows the user id: a refusal attributed to a user without a member row is a person's, not an agent's", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("actor-owner");
  const outsider = await seedUser("actor-outsider");
  const server = await seedServer("Actor", owner.id);
  const { rows, sink } = memorySink();
  const now = Date.parse("2026-11-11T08:00:00Z");

  // The one path all three reach: an Artifacts write refused for the monthly quota (noteAppPaywallHit).
  const hit = { gate: "upload_monthly_quota", serverId: server.id, via: "artifact_import", usage: { requestedBytes: 1, monthUsedBytes: 2 }, now } as const;
  assert.equal(await recordPaywallHit(sink, { ...hit, userId: outsider.id }), "written");
  assert.equal(await recordPaywallHit(sink, { ...hit, userId: owner.id }), "written");
  assert.equal(await recordPaywallHit(sink, { ...hit, userId: null }), "written");
  // The agents' shared key is its own: neither person's hit used it up, and it is used up once.
  assert.equal(await recordPaywallHit(sink, { ...hit, userId: null }), "duplicate");

  const rest = { plan: "free", via: "artifact_import", requested_bytes: 1, month_used_bytes: 2 };
  assert.deepEqual(rows.map((row) => row.properties), [
    { gate: "upload_monthly_quota", actor: "person", ...rest },
    { gate: "upload_monthly_quota", actor: "person", viewer_role: "owner", ...rest },
    { gate: "upload_monthly_quota", actor: "agent", ...rest },
  ]);
});

test("paywall_hit asks Redis once per key and replica, and drops a hit another replica already counted", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("redis-owner");
  const server = await seedServer("Redis", owner.id);
  const { rows, sink } = memorySink();
  const keys = new Set<string>();
  let setCalls = 0;
  const client = {
    async set(key: string) {
      setCalls += 1;
      if (keys.has(key)) return null;
      keys.add(key);
      return "OK";
    },
  };
  const spies = [
    vi.spyOn(redis, "isRedisAvailable").mockReturnValue(true),
    vi.spyOn(redis, "getRedis").mockReturnValue(client as unknown as ReturnType<typeof redis.getRedis>),
  ];
  try {
    const now = Date.parse("2026-10-20T08:00:00Z");
    assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: owner.id, serverId: server.id, now }), "written");
    assert.equal(await recordPaywallHit(sink, { gate: "history_30d", userId: owner.id, serverId: server.id, now }), "duplicate");
    assert.equal(setCalls, 1, "the repeat is answered by this replica, without a Redis round trip");

    keys.add(`paywall-hit:2026-10-20:${server.id}:${owner.id}:translation`);
    assert.equal(await recordPaywallHit(sink, { gate: "translation", userId: owner.id, serverId: server.id, now }), "duplicate");
    assert.equal(rows.length, 1);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
});

test("checkout: Stripe metadata carries the entry and default seats; billing_checkout_started has them but no billing or Stripe id", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("checkout-owner", true);
  const server = await createServer("Checkout Events", `checkout-events-${randomUUID()}`, owner.id);
  const createCalls: Array<{ metadata: Record<string, string>; subscription_data: { metadata: Record<string, string> } }> = [];
  __setStripeForTests({
    checkout: {
      sessions: {
        create: async (params: (typeof createCalls)[number]) => {
          createCalls.push(params);
          return { id: `cs_test_events_${createCalls.length}`, url: "https://checkout.stripe.test/session" };
        },
      },
    },
  } as unknown as Stripe);
  const { rows, sink } = memorySink();

  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 3,
    billingInterval: "monthly",
    billingTraceId: "trace_checkout_events",
    entry: "history_30d",
    defaultSeatQuantity: 1,
  }, { productEvents: sink });
  await settle(rows, 1);

  const metadata = createCalls[0].metadata;
  assert.equal(metadata.checkoutEntry, "history_30d");
  assert.equal(metadata.defaultSeatQuantity, "1");
  assert.equal(metadata.returningCustomer, "false");
  // Analytics-only keys stay on the session, off the long-lived subscription (Tenny, #10389).
  for (const key of ["checkoutEntry", "defaultSeatQuantity", "returningCustomer"]) {
    assert.equal(createCalls[0].subscription_data.metadata[key], undefined, key);
  }
  assert.equal(createCalls[0].subscription_data.metadata.serverId, server.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "billing_checkout_started");
  assert.equal(rows[0].analytics_id, await analyticsIdOf(owner.id));
  assert.deepEqual(rows[0].properties, {
    entry: "history_30d",
    billing_interval: "monthly",
    seat_quantity: 3,
    default_seat_quantity: 1,
    returning_customer: false,
  });
  const serialized = JSON.stringify(rows[0]);
  for (const linkKey of ["trace_checkout_events", "cs_test_events", owner.id]) {
    assert.ok(!serialized.includes(linkKey), `the product row must not carry ${linkKey}`);
  }

  // An entry the server does not know, or none, is `unknown`; a bad default
  // seat count is dropped, never a failed checkout.
  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 2,
    entry: "<script>",
    defaultSeatQuantity: "lots",
  }, { productEvents: sink });
  await settle(rows, 2);
  assert.equal(createCalls[1].metadata.checkoutEntry, "unknown");
  assert.equal(createCalls[1].metadata.defaultSeatQuantity, undefined);
  assert.deepEqual(rows[1].properties, { entry: "unknown", billing_interval: "annual", seat_quantity: 2, returning_customer: false });

  // An agent's upgrade card opened the dialog: the session and the event say so;
  // a value the server does not know is dropped (a paywall sends none).
  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 1,
    entry: "general",
    openedFrom: "agent_card",
  }, { productEvents: sink });
  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 1,
    entry: "history_30d",
    openedFrom: "paywall",
  }, { productEvents: sink });
  await settle(rows, 4);
  assert.equal(createCalls[2].metadata.checkoutOpenedFrom, "agent_card");
  assert.equal(createCalls[2].subscription_data.metadata.checkoutOpenedFrom, undefined, "session only, never the subscription");
  assert.equal(createCalls[3].metadata.checkoutOpenedFrom, undefined);
  assert.deepEqual(rows.slice(2).map((row) => row.properties), [
    { entry: "general", billing_interval: "annual", seat_quantity: 1, returning_customer: false, opened_from: "agent_card" },
    { entry: "history_30d", billing_interval: "annual", seat_quantity: 1, returning_customer: false },
  ]);

  // Save as Artifact's quota paywall opened the dialog (#proj-commercial:#22): the
  // session keeps its surface and the event carries it; a surface the server does
  // not know is dropped, never a failed checkout.
  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 1,
    entry: "upload_monthly_quota",
    surface: "artifact",
  }, { productEvents: sink });
  await createCheckoutSession(server.id, owner.id, "http://localhost:5173/s", "http://localhost:5173/s", {
    targetPlan: "pro",
    seatQuantity: 1,
    entry: "upload_monthly_quota",
    surface: "attachment",
  }, { productEvents: sink });
  await settle(rows, 6);
  assert.equal(createCalls[4].metadata.checkoutSurface, "artifact");
  assert.equal(createCalls[4].subscription_data.metadata.checkoutSurface, undefined, "session only, never the subscription");
  assert.equal(createCalls[5].metadata.checkoutSurface, undefined);
  assert.deepEqual(rows.slice(4).map((row) => row.properties), [
    { entry: "upload_monthly_quota", billing_interval: "annual", seat_quantity: 1, returning_customer: false, surface: "artifact" },
    { entry: "upload_monthly_quota", billing_interval: "annual", seat_quantity: 1, returning_customer: false },
  ]);
});

test("checkout completed webhook records billing_checkout_completed once, from the session's metadata", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("completed-owner", false);
  const server = await createServer("Completed Events", `completed-events-${randomUUID()}`, owner.id);
  __setStripeForTests({
    subscriptions: {
      retrieve: async () => ({
        id: "sub_completed",
        customer: "cus_completed",
        status: "active",
        cancel_at_period_end: false,
        pending_update: null,
        schedule: null,
        metadata: { pricingContract: "raft-pro-seat-v1", serverId: server.id, userId: owner.id, targetPlan: "pro", seatQuantity: "4", proPackQuantity: "4" },
        items: { data: [{ id: "si_pro_seat", quantity: 4, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, price: { id: "price_pro_seat" } }] },
      }),
    },
  } as unknown as Stripe);
  const { rows, sink } = memorySink();
  const event = {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_completed",
        mode: "subscription",
        subscription: "sub_completed",
        customer: "cus_completed",
        metadata: {
          serverId: server.id,
          userId: owner.id,
          billingInterval: "annual",
          seatQuantity: "4",
          checkoutEntry: "seat_limit_invite",
          defaultSeatQuantity: "2",
          returningCustomer: "true",
          checkoutOpenedFrom: "agent_card",
          checkoutSurface: "artifact",
          billingTraceId: "trace_completed",
        },
      },
    },
  } as unknown as Stripe.Event;

  await handleWebhookEvent(event, { productEvents: sink });
  await handleWebhookEvent(event, { productEvents: sink });
  await settle(rows, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(rows.map((row) => [row.event, row.analytics_id, row.server_id, row.properties]), [[
    "billing_checkout_completed",
    null,
    server.id,
    { entry: "seat_limit_invite", billing_interval: "annual", seat_quantity: 4, default_seat_quantity: 2, returning_customer: true, opened_from: "agent_card", surface: "artifact" },
  ]]);
  assert.ok(!JSON.stringify(rows[0]).includes("trace_completed"));
});

test("a checkout webhook that fails and is retried records the purchase once", async () => {
  await openTestDatabase("pglite://");
  const owner = await seedUser("retry-owner");
  const server = await createServer("Retry Events", `retry-events-${randomUUID()}`, owner.id);
  let retrieveCalls = 0;
  __setStripeForTests({
    subscriptions: {
      retrieve: async () => {
        retrieveCalls += 1;
        if (retrieveCalls === 1) throw new Error("Stripe is unavailable");
        return {
          id: "sub_retry",
          customer: "cus_retry",
          status: "active",
          cancel_at_period_end: false,
          pending_update: null,
          schedule: null,
          metadata: { pricingContract: "raft-pro-seat-v1", serverId: server.id, userId: owner.id, targetPlan: "pro", seatQuantity: "1", proPackQuantity: "1" },
          items: { data: [{ id: "si_pro_seat", quantity: 1, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, price: { id: "price_pro_seat" } }] },
        };
      },
    },
  } as unknown as Stripe);
  const { rows, sink } = memorySink();
  const event = {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: "sub_retry",
        customer: "cus_retry",
        metadata: { serverId: server.id, userId: owner.id, billingInterval: "monthly", seatQuantity: "1", checkoutEntry: "settings" },
      },
    },
  } as unknown as Stripe.Event;

  await assert.rejects(() => handleWebhookEvent(event, { productEvents: sink }), /Stripe is unavailable/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rows.length, 0, "nothing is recorded for a webhook that failed");
  await handleWebhookEvent(event, { productEvents: sink });
  await settle(rows, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(rows.map((row) => row.event), ["billing_checkout_completed"]);
});
