import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { seedPrepaidPurchase } from "../test/prepaidProFixture";
import { getDb } from "../db/index";
import { prepaidProPurchases, servers, users } from "../db/schema";
import { __resetStripeForTests, __setStripeForTests, handleWebhookEvent } from "./billingService";
import { __resetPrepaidPriceCacheForTests, PrepaidRequestError, recordPrepaidCheckout } from "./prepaidProBilling";
import { getServerBillingEntitlement } from "./planService";
import { PREPAID_PRO_PRICE_LOOKUP_KEYS, PREPAID_PRO_PRICING_CONTRACT } from "./prepaidProContracts";
import { createPrepaidSeatsCheckout, getPrepaidSeatsQuote, parsePrepaidSeatQuantity } from "./prepaidProSeats";
import { createServer } from "./serverService";

const ENV_KEYS = ["STRIPE_BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_prepaid_seats";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_prepaid_seats";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] == null) delete process.env[key]; else process.env[key] = envSnapshot[key];
  }
  __resetStripeForTests();
  __resetPrepaidPriceCacheForTests();
  await closeTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;
const UNIT = { 1: 1000, 12: 10560 } as const;

function price(months: 1 | 12, overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: `price_prepaid_${months}m`, active: true, type: "one_time", currency: "usd", product: "prod_raft_pro",
    lookup_key: PREPAID_PRO_PRICE_LOOKUP_KEYS[months], unit_amount: UNIT[months], ...overrides,
  } as Stripe.Price;
}

function fakeStripe(options: { prices?: Stripe.Price[]; line?: { unitAmount: number; quantity: number } } = {}) {
  const calls = {
    create: [] as Array<{ params: Stripe.Checkout.SessionCreateParams; options: Record<string, unknown> }>,
    refunds: [] as Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>,
  };
  const prices = options.prices ?? [price(1), price(12)];
  const stripe = {
    prices: { list: async (params: { lookup_keys: string[] }) => ({ data: prices.filter(p => params.lookup_keys.includes(p.lookup_key!)), has_more: false }) },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, requestOptions: Record<string, unknown>) => {
          calls.create.push({ params, options: requestOptions });
          return { id: `cs_test_${randomUUID()}`, url: "https://checkout.stripe.test/seats" };
        },
        retrieve: async (id: string) => ({ id, status: "complete", mode: "payment", metadata: {} }),
        expire: async (id: string) => ({ id, status: "expired" }),
        listLineItems: async () => options.line
          ? { data: [{ price: { type: "one_time", currency: "usd", unit_amount: options.line.unitAmount }, quantity: options.line.quantity }], has_more: false }
          : { data: [], has_more: false },
      },
    },
    refunds: {
      create: async (params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        calls.refunds.push({ params, options: requestOptions });
        return { id: `re_${calls.refunds.length}` };
      },
      list: async () => ({ data: [], has_more: false }),
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, latest_charge: { id: "ch_x", amount: 1, amount_refunded: 0, refunded: false } }),
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

async function seedOwnerServer(label: string) {
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning();
  const server = await createServer(label, `${label}-${randomUUID()}`, owner.id);
  return { owner, server };
}

/** A month of prepaid Pro at 2 seats, 10 days in and 20 left (30-day period). */
async function seedPrepaidMonth(serverId: string, now: Date, overrides: { startsAt?: Date; endsAt?: Date } = {}) {
  await seedPrepaidPurchase(getDb(), {
    serverId, months: 1, seatQuantity: 2,
    startsAt: overrides.startsAt ?? new Date(now.getTime() - 10 * DAY), endsAt: overrides.endsAt ?? new Date(now.getTime() + 20 * DAY),
  });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, serverId));
}

const request = { seatQuantity: 3, successUrl: "https://app/s", cancelUrl: "https://app/c", entry: "settings", openedFrom: null };

function event(object: unknown): Stripe.Event {
  return { id: `evt_${randomUUID()}`, type: "checkout.session.completed", data: { object } } as Stripe.Event;
}

/** The session Stripe completes for a Checkout this test created: its metadata, paid. */
function paid(params: Stripe.Checkout.SessionCreateParams, subtotal: number, overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: `cs_test_${randomUUID()}`, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
    amount_subtotal: subtotal, amount_total: subtotal, currency: "usd", total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    payment_intent: `pi_${randomUUID()}`, customer: "cus_seats", metadata: params.metadata, ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

async function seatRows(serverId: string) {
  return (await getDb().select().from(prepaidProPurchases).where(eq(prepaidProPurchases.serverId, serverId))).filter(row => row.kind === "seats");
}

test("seat quantity: a positive integer, from the body or the query string", async ({ db: _db }) => {
  assert.equal(parsePrepaidSeatQuantity(3), 3);
  assert.equal(parsePrepaidSeatQuantity("4"), 4);
  for (const bad of [0, 1.5, "1.5", "-1", "", null, undefined, 10_001]) {
    assert.throws(() => parsePrepaidSeatQuantity(bad), (err: unknown) => err instanceof PrepaidRequestError && err.code === "invalid_seat_quantity", String(bad));
  }
});

test("quote: by the days left to the end of the paid time; refused off, without prepaid time, in grace or unconfigured", async ({ db: _db }) => {
  const { server } = await seedOwnerServer("seats-quote");
  const now = new Date();
  const { stripe } = fakeStripe();
  const quote = (input: Partial<Parameters<typeof getPrepaidSeatsQuote>[0]> = {}) => getPrepaidSeatsQuote({ stripe, serverId: server.id, enabled: true, seatQuantity: 3, now, ...input });

  assert.equal((await quote({ enabled: false })).unavailableReason, "disabled");
  assert.equal((await quote()).unavailableReason, "not_prepaid", "a Free server has no prepaid time");

  await seedPrepaidMonth(server.id, now);
  const ok = await quote();
  assert.equal(ok.unavailableReason, null);
  assert.equal(ok.unitAmount, Math.round(1000 * 20 / 30));
  assert.equal(ok.amountTotal, ok.unitAmount * 3);
  assert.equal(ok.days, 20);
  assert.equal(ok.endsAt, new Date(now.getTime() + 20 * DAY).toISOString());
  assert.equal(ok.minimumApplied, false);

  assert.equal((await quote({ stripe: null })).unavailableReason, "not_configured");
  __resetPrepaidPriceCacheForTests();
  assert.equal((await quote({ stripe: fakeStripe({ prices: [price(1, { product: undefined as unknown as string }), price(12)] }).stripe })).unavailableReason, "not_configured",
    "the seats are sold under the Price's product");
  __resetPrepaidPriceCacheForTests();

  const late = new Date(now.getTime() + 21 * DAY);
  assert.equal((await quote({ now: late })).unavailableReason, "in_grace", "after the end: renew instead");
  const lastHour = new Date(now.getTime() + 20 * DAY - 60 * 60 * 1000);
  const tiny = await quote({ now: lastHour, seatQuantity: 1 });
  assert.equal(tiny.unitAmount, 33);
  assert.deepEqual([tiny.amountTotal, tiny.minimumApplied], [50, true], "Stripe's minimum charge");
});

test("checkout: Alipay, the price computed here, no promotion codes, a 30-minute session; refused in grace", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("seats-checkout");
  const now = new Date();
  await seedPrepaidMonth(server.id, now);
  const { stripe, calls } = fakeStripe();
  const before = Date.now();
  const started = await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
  const unit = Math.round(1000 * 20 / 30);
  const { expiresAt, ...rest } = started;
  assert.deepEqual(rest, { url: "https://checkout.stripe.test/seats", seatQuantity: 3, previousSeatQuantity: 2, amountTotal: unit * 3, days: 20 });
  assert.equal(expiresAt, new Date((calls.create[0].params.expires_at ?? 0) * 1000).toISOString(), "the web knows when the price stops");
  const { params, options } = calls.create[0];
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.payment_method_types, ["alipay"]);
  assert.deepEqual(params.line_items, [{ price_data: { currency: "usd", product: "prod_raft_pro", unit_amount: unit }, quantity: 3 }]);
  assert.equal(params.allow_promotion_codes, false);
  assert.deepEqual(params.adaptive_pricing, { enabled: false });
  assert.equal(params.metadata?.pricingContract, PREPAID_PRO_PRICING_CONTRACT);
  assert.equal(params.metadata?.kind, "seats");
  assert.equal(params.metadata?.unitAmount, String(unit));
  assert.equal(params.metadata?.endsAt, new Date(now.getTime() + 20 * DAY).toISOString());
  assert.equal(params.metadata?.segments, `1:1000:20:30`);
  const lifetime = (params.expires_at ?? 0) * 1000 - before;
  assert.ok(lifetime >= 30 * 60 * 1000 && lifetime <= 34 * 60 * 1000, "about as short as Stripe allows: the price is for now");
  assert.match(String(options.idempotencyKey), /^raft-prepaid-seats-checkout-/);

  const { server: lapsed, owner: lapsedOwner } = await seedOwnerServer("seats-checkout-grace");
  await seedPrepaidMonth(lapsed.id, now, { startsAt: new Date(now.getTime() - 31 * DAY), endsAt: new Date(now.getTime() - DAY) });
  await assert.rejects(createPrepaidSeatsCheckout(stripe, lapsed.id, lapsedOwner.id, request),
    (err: unknown) => err instanceof PrepaidRequestError && err.status === 409 && err.code === "in_grace");
  const { server: free, owner: freeOwner } = await seedOwnerServer("seats-checkout-free");
  await assert.rejects(createPrepaidSeatsCheckout(stripe, free.id, freeOwner.id, request),
    (err: unknown) => err instanceof PrepaidRequestError && err.code === "not_prepaid");
});

test("webhook: a paid seats Checkout adds the seats until the paid end at once; a retry records nothing", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("seats-webhook");
  const now = new Date();
  await seedPrepaidMonth(server.id, now);
  const { stripe, calls } = fakeStripe();
  await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
  const { params } = calls.create[0];
  const unit = Number(params.metadata!.unitAmount);
  // Tax on top is not a mismatch: the subtotal is what is checked.
  const session = paid(params, unit * 3, { amount_total: unit * 3 + 120 });
  __setStripeForTests(fakeStripe({ line: { unitAmount: unit, quantity: 3 } }).stripe);
  const recorded: unknown[] = [];
  await handleWebhookEvent(event(session), { productEvents: { enqueue: (rows: readonly unknown[]) => { recorded.push(...rows); }, flush: async () => {} } });
  const [row] = await seatRows(server.id);
  assert.equal(row.status, "paid");
  assert.equal(row.months, null);
  assert.equal(row.seatQuantity, 3);
  assert.equal(row.endsAt.toISOString(), params.metadata!.endsAt);
  assert.ok(row.startsAt.getTime() >= now.getTime() - 1000);
  const entitlement = await getServerBillingEntitlement(getDb(), server.id);
  assert.equal(entitlement.source, "prepaid");
  assert.equal(entitlement.capacity.maxUniversalSeats, 5, "2 seats bought with the month + 3 added");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(JSON.stringify(recorded).includes("billing_prepaid_seats_checkout_completed") && JSON.stringify(recorded).includes("granted"));

  await handleWebhookEvent(event(session));
  assert.equal((await seatRows(server.id)).length, 1, "one row per session");
});

test("webhook: a wrong amount, or prepaid time gone or shorter than priced, records a conflict and refunds", async ({ db: _db }) => {
  const now = new Date();
  const cases: Array<[string, (serverId: string) => Promise<void>, (params: Stripe.Checkout.SessionCreateParams) => Stripe.Checkout.Session, string]> = [
    ["wrong subtotal", async () => {}, params => paid(params, Number(params.metadata!.unitAmount) * 3 - 1), "amount_mismatch"],
    ["period refunded", async serverId => {
      await getDb().update(prepaidProPurchases).set({ status: "refunded" }).where(eq(prepaidProPurchases.serverId, serverId));
    }, params => paid(params, Number(params.metadata!.unitAmount) * 3), "paid_source"],
    ["metadata past the paid end", async () => {}, params => paid({ ...params, metadata: { ...params.metadata, endsAt: new Date(now.getTime() + 40 * DAY).toISOString() } }, Number(params.metadata!.unitAmount) * 3), "paid_source"],
  ];
  for (const [label, change, completed, reason] of cases) {
    const { owner, server } = await seedOwnerServer(`seats-conflict-${label.replaceAll(" ", "-")}`);
    await seedPrepaidMonth(server.id, now);
    const { stripe, calls } = fakeStripe();
    await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
    const session = completed(calls.create[0].params);
    await change(server.id);
    const refunds = fakeStripe({ line: { unitAmount: Number(calls.create[0].params.metadata!.unitAmount), quantity: 3 } });
    __setStripeForTests(refunds.stripe);
    await handleWebhookEvent(event(session));
    const [row] = await seatRows(server.id);
    assert.equal(row.status, "conflict", label);
    assert.equal(row.conflictReason, reason, label);
    assert.equal(refunds.calls.refunds.length, 1, `${label}: refunded once`);
    assert.equal(refunds.calls.refunds[0].options.idempotencyKey, `raft-prepaid-conflict-refund-${session.id}`, label);
  }
});

test("webhook: a wrong line with the right subtotal, or a discount, is a mismatch", async ({ db: _db }) => {
  const now = new Date();
  const variants: Array<[string, (unit: number) => { unitAmount: number; quantity: number }, Partial<Stripe.Checkout.Session>]> = [
    ["wrong quantity", unit => ({ unitAmount: unit * 3, quantity: 1 }), {}],
    ["wrong unit", unit => ({ unitAmount: unit + 1, quantity: 3 }), {}],
    ["discounted", unit => ({ unitAmount: unit, quantity: 3 }), { total_details: { amount_discount: 100, amount_shipping: 0, amount_tax: 0 } }],
  ];
  for (const [label, line, overrides] of variants) {
    const { owner, server } = await seedOwnerServer(`seats-line-${label.replaceAll(" ", "-")}`);
    await seedPrepaidMonth(server.id, now);
    const { stripe, calls } = fakeStripe();
    await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
    const unit = Number(calls.create[0].params.metadata!.unitAmount);
    __setStripeForTests(fakeStripe({ line: line(unit) }).stripe);
    await handleWebhookEvent(event(paid(calls.create[0].params, unit * 3, overrides)));
    const [row] = await seatRows(server.id);
    assert.equal(row.conflictReason, "amount_mismatch", label);
  }
});

test("under Stripe's minimum: one line of 50 cents is created and accepted", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("seats-minimum");
  const now = new Date();
  // An hour left of a 30-day month: one day charged, 33 cents a seat.
  await seedPrepaidMonth(server.id, now, { startsAt: new Date(now.getTime() - 30 * DAY + 60 * 60 * 1000), endsAt: new Date(now.getTime() + 60 * 60 * 1000) });
  const { stripe, calls } = fakeStripe();
  await createPrepaidSeatsCheckout(stripe, server.id, owner.id, { ...request, seatQuantity: 1 });
  const { params } = calls.create[0];
  assert.deepEqual(params.line_items, [{ price_data: { currency: "usd", product: "prod_raft_pro", unit_amount: 50 }, quantity: 1 }]);
  assert.equal(params.metadata?.unitAmount, "33", "the terms keep the real per-seat share");
  __setStripeForTests(fakeStripe({ line: { unitAmount: 50, quantity: 1 } }).stripe);
  await handleWebhookEvent(event(paid(params, 50)));
  const [row] = await seatRows(server.id);
  assert.equal(row.status, "paid");
  assert.equal(row.amountTotal, 50);
});

test("webhook: a renewal bought between the Checkout and the payment keeps the seats to the end they were priced for", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("seats-renewal-between");
  const now = new Date();
  await seedPrepaidMonth(server.id, now);
  const { stripe, calls } = fakeStripe();
  await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
  const { params } = calls.create[0];
  const oldEnd = new Date(now.getTime() + 20 * DAY);
  await seedPrepaidPurchase(getDb(), { serverId: server.id, months: 1, seatQuantity: 2, startsAt: oldEnd, endsAt: new Date(oldEnd.getTime() + 30 * DAY) });
  __setStripeForTests(fakeStripe({ line: { unitAmount: Number(params.metadata!.unitAmount), quantity: 3 } }).stripe);
  await handleWebhookEvent(event(paid(params, Number(params.metadata!.unitAmount) * 3)));
  const [row] = await seatRows(server.id);
  assert.equal(row.status, "paid");
  assert.equal(row.endsAt.toISOString(), oldEnd.toISOString());
});

test("webhook: paid after the paid time ended (its grace days) is a conflict, refunded, and its row still a valid range", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("seats-paid-in-grace");
  const now = new Date();
  await seedPrepaidMonth(server.id, now);
  const { stripe, calls } = fakeStripe();
  await createPrepaidSeatsCheckout(stripe, server.id, owner.id, request);
  const { params } = calls.create[0];
  const unit = Number(params.metadata!.unitAmount);
  const refunds = fakeStripe({ line: { unitAmount: unit, quantity: 3 } });
  const late = new Date(now.getTime() + 21 * DAY);
  await recordPrepaidCheckout(refunds.stripe, paid(params, unit * 3), late);
  const [row] = await seatRows(server.id);
  assert.equal(row.status, "conflict");
  assert.equal(row.conflictReason, "paid_source");
  assert.ok(row.startsAt.getTime() < row.endsAt.getTime());
  assert.equal(refunds.calls.refunds.length, 1);
});
