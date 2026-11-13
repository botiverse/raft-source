import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { seedPrepaidPurchase } from "../test/prepaidProFixture";
import { getDb } from "../db/index";
import { isInTransaction } from "../db/ambientTransaction";
import { billingCheckoutAttempts, prepaidProPurchases, servers, subscriptions, users } from "../db/schema";
import { __resetStripeForTests, __setStripeForTests, getBillingSummary, handleWebhookEvent } from "./billingService";
import { PrepaidActiveError, PrepaidPaidSourceError, reserveStripeCheckout } from "./billingCheckoutCustody";
import { getServerBillingEntitlement } from "./planService";
import { __resetPrepaidPriceCacheForTests, PrepaidRequestError, createPrepaidCheckout, getPrepaidOffer, getPrepaidPrices, parsePrepaidCheckoutBody } from "./prepaidProBilling";
import { PREPAID_PRO_PRICE_LOOKUP_KEYS, PREPAID_PRO_PRICING_CONTRACT } from "./prepaidProContracts";
import { __resetPrepaidSweepFailuresForTests, sweepLapsedPrepaidServers } from "./prepaidProSweep";
import { addMember, createServer } from "./serverService";

const ENV_KEYS = ["STRIPE_BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID", "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID"] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_prepaid";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_prepaid";
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] == null) delete process.env[key]; else process.env[key] = envSnapshot[key];
  }
  __resetStripeForTests();
  __resetPrepaidPriceCacheForTests();
  __resetPrepaidSweepFailuresForTests();
  await closeTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;
const UNIT = { 1: 1000, 12: 10560 } as const;

function price(months: 1 | 12, overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return { id: `price_prepaid_${months}m`, active: true, type: "one_time", currency: "usd", lookup_key: PREPAID_PRO_PRICE_LOOKUP_KEYS[months], unit_amount: UNIT[months], ...overrides } as Stripe.Price;
}

interface FakeOptions {
  prices?: Stripe.Price[];
  sessions?: Map<string, Partial<Stripe.Checkout.Session>>;
  lineItems?: (sessionId: string) => { data: unknown[]; has_more: boolean };
  refundFails?: () => boolean;
  /** Stripe answers charge_already_refunded (an idempotency key older than 24 hours). */
  alreadyRefunded?: () => boolean;
  /** The payment's charge, as paymentIntents.retrieve expands it. */
  charge?: { amount: number; amount_refunded: number; refunded: boolean };
  subscription?: Stripe.Subscription;
  invoicePayments?: unknown[];
  invoiceStatus?: string;
}

function fakeStripe(options: FakeOptions = {}) {
  const calls = {
    pricesList: 0,
    create: [] as Array<{ params: Stripe.Checkout.SessionCreateParams; options: Record<string, unknown> }>,
    expire: [] as string[],
    refunds: [] as Array<{ params: Record<string, unknown>; options: Record<string, unknown> }>,
    cancel: [] as string[],
    voided: [] as string[],
  };
  const prices = options.prices ?? [price(1), price(12)];
  const stripe = {
    prices: { list: async (params: { lookup_keys: string[] }) => { calls.pricesList += 1; return { data: prices.filter(p => params.lookup_keys.includes(p.lookup_key!)), has_more: false }; } },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, requestOptions: Record<string, unknown>) => {
          calls.create.push({ params, options: requestOptions });
          return { id: `cs_test_${randomUUID()}`, url: "https://checkout.stripe.test/prepaid" };
        },
        retrieve: async (id: string) => ({ id, status: "complete", mode: "subscription", metadata: {}, ...options.sessions?.get(id) }),
        expire: async (id: string) => { calls.expire.push(id); return { id, status: "expired" }; },
        listLineItems: async (id: string) => options.lineItems?.(id) ?? { data: [], has_more: false },
      },
    },
    refunds: {
      create: async (params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
        calls.refunds.push({ params, options: requestOptions });
        if (options.refundFails?.()) throw new Error("refund unavailable");
        if (options.alreadyRefunded?.()) throw Object.assign(new Error("already refunded"), { code: "charge_already_refunded" });
        return { id: `re_${calls.refunds.length}` };
      },
      list: async () => ({ data: [{ id: "re_existing" }], has_more: false }),
    },
    paymentIntents: {
      retrieve: async (id: string) => ({ id, latest_charge: { id: "ch_x", amount: 2000, amount_refunded: 0, refunded: false, ...options.charge } }),
    },
    invoices: {
      retrieve: async (id: string) => ({ id, status: options.invoiceStatus ?? "paid" }),
      voidInvoice: async (id: string) => { calls.voided.push(id); return { id, status: "void" }; },
    },
    subscriptions: {
      retrieve: async () => options.subscription,
      cancel: async (id: string) => { calls.cancel.push(id); return { ...options.subscription, status: "canceled" }; },
    },
    invoicePayments: {
      list: () => (async function* () { for (const payment of options.invoicePayments ?? []) yield payment; })(),
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

async function seedUser(label: string) {
  return (await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning())[0];
}

async function seedOwnerServer(label: string) {
  const owner = await seedUser(label);
  const server = await createServer(label, `${label}-${randomUUID()}`, owner.id);
  return { owner, server };
}

function paidSession(input: { serverId: string; userId: string; months?: 1 | 12; seats?: number; amount?: number; id?: string; renewal?: boolean; priceId?: string }): Stripe.Checkout.Session {
  const months = input.months ?? 1;
  const seats = input.seats ?? 2;
  return {
    id: input.id ?? `cs_test_${randomUUID()}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: input.amount ?? UNIT[months] * seats,
    currency: "usd",
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    payment_intent: `pi_${randomUUID()}`,
    customer: "cus_prepaid",
    metadata: {
      pricingContract: PREPAID_PRO_PRICING_CONTRACT, serverId: input.serverId, userId: input.userId, months: String(months), seatQuantity: String(seats),
      priceId: input.priceId ?? `price_prepaid_${months}m`, renewal: String(Boolean(input.renewal)), checkoutEntry: "settings",
    },
  } as unknown as Stripe.Checkout.Session;
}

function lineItemsFor(months: 1 | 12, seats: number) {
  return () => ({ data: [{ price: price(months), quantity: seats }], has_more: false });
}

function event(type: Stripe.Event.Type, object: unknown): Stripe.Event {
  return { id: `evt_${randomUUID()}`, type, data: { object } } as Stripe.Event;
}

async function rowsOf(serverId: string) {
  return getDb().select().from(prepaidProPurchases).where(eq(prepaidProPurchases.serverId, serverId));
}

async function planOf(serverId: string) {
  return (await getDb().select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId)))[0].plan;
}

test("prices: both one-time USD Prices by lookup_key, or none; cached", async ({ db: _db }) => {
  const good = fakeStripe();
  const prices = await getPrepaidPrices(good.stripe, 0);
  assert.deepEqual([...prices!.entries()].map(([months, p]) => [months, p.id, p.unitAmount]), [[1, "price_prepaid_1m", 1000], [12, "price_prepaid_12m", 10560]]);
  await getPrepaidPrices(good.stripe, 1000);
  assert.equal(good.calls.pricesList, 1, "cached");
  for (const broken of [
    [price(1)],
    [price(1), price(12, { type: "recurring" })],
    [price(1), price(12, { currency: "cny" })],
    [price(1), price(12, { unit_amount: 0 })],
    [price(1), price(12), price(12, { id: "price_dup" })],
  ]) {
    __resetPrepaidPriceCacheForTests();
    assert.equal(await getPrepaidPrices(fakeStripe({ prices: broken }).stripe, 0), null);
  }
});

test("offer: disabled, configured, other paid source, and a renewal's start and seats", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-offer");
  const { stripe } = fakeStripe();
  const disabled = await getPrepaidOffer({ stripe, serverId: server.id, enabled: false });
  assert.equal(disabled.unavailableReason, "disabled");
  assert.deepEqual(disabled.periods, []);
  const offer = await getPrepaidOffer({ stripe, serverId: server.id, enabled: true });
  assert.equal(offer.unavailableReason, null);
  assert.deepEqual(offer.periods, [{ months: 1, unitAmount: 1000, currency: "usd" }, { months: 12, unitAmount: 10560, currency: "usd" }]);
  assert.equal(offer.graceDays, 3);
  assert.equal(offer.minimumSeatQuantity, 1);
  assert.equal(offer.renewalStartsAt, null);
  assert.equal((await getPrepaidOffer({ stripe: null, serverId: server.id, enabled: true })).unavailableReason, "not_configured");

  const now = new Date();
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 10 * DAY), seatQuantity: 4, userId: owner.id });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const renewal = await getPrepaidOffer({ stripe, serverId: server.id, enabled: true, now });
  assert.equal(renewal.unavailableReason, null);
  assert.equal(renewal.defaultSeatQuantity, 4);
  assert.equal(renewal.renewalStartsAt, new Date(now.getTime() + 10 * DAY).toISOString());

  for (const setup of [
    () => getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_s", stripeSubscriptionId: "sub_s", status: "active" }),
    () => getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id)),
  ]) {
    await setup();
    assert.equal((await getPrepaidOffer({ stripe, serverId: server.id, enabled: true })).unavailableReason, "other_paid_source");
  }
});

test("checkout: Alipay only, the Stripe Price, seats, a customer, an invoice, a short-lived session; earlier open sessions expire", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-checkout");
  const member = await seedUser("prepaid-checkout-member");
  await addMember(server.id, member.id, "member");
  const openSubscriptionSession = `cs_sub_${randomUUID()}`;
  await getDb().insert(billingCheckoutAttempts).values({ serverId: server.id, state: "known", stripeSessionId: openSubscriptionSession });
  const { stripe, calls } = fakeStripe({ sessions: new Map([[openSubscriptionSession, { status: "open", mode: "subscription" }]]) });

  for (const [body, code] of [[{ months: 2, seatQuantity: 2 }, "invalid_months"], [{ months: 3, seatQuantity: 2 }, "invalid_months"], [{ months: "1", seatQuantity: 2 }, "invalid_months"], [{ months: 1, seatQuantity: 1.5 }, "invalid_seat_quantity"], [{ months: 1 }, "invalid_seat_quantity"]] as const) {
    assert.throws(() => parsePrepaidCheckoutBody(body), (err: unknown) => err instanceof PrepaidRequestError && err.code === code);
  }
  assert.deepEqual(parsePrepaidCheckoutBody({ months: 12, seatQuantity: 4 }), { months: 12, seatQuantity: 4 });
  await assert.rejects(createPrepaidCheckout(stripe, server.id, owner.id, { months: 1 as const, seatQuantity: 1, successUrl: "s", cancelUrl: "c", entry: "settings", openedFrom: null, defaultSeatQuantity: null }),
    (err: unknown) => err instanceof PrepaidRequestError && err.code === "seat_quantity_below_usage", "two humans use two seats");

  const before = Date.now();
  const started = await createPrepaidCheckout(stripe, server.id, owner.id, { months: 12 as const, seatQuantity: 2, successUrl: "https://app/s", cancelUrl: "https://app/c", entry: "settings", openedFrom: null, defaultSeatQuantity: 2 });
  assert.deepEqual(started, { url: "https://checkout.stripe.test/prepaid", months: 12, seatQuantity: 2, renewal: false });
  assert.deepEqual(calls.expire, [openSubscriptionSession], "an open subscription Checkout cannot complete beside it");
  const { params, options } = calls.create[0];
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.payment_method_types, ["alipay"]);
  assert.deepEqual(params.line_items, [{ price: "price_prepaid_12m", quantity: 2 }]);
  assert.equal(params.customer_creation, "always");
  assert.equal(params.customer, undefined);
  assert.equal(params.invoice_creation?.enabled, true);
  assert.equal(params.allow_promotion_codes, undefined, "no discounts: the amount check expects the Price x seats");
  assert.deepEqual(params.adaptive_pricing, { enabled: false }, "the webhook checks a USD amount");
  assert.equal(params.metadata?.pricingContract, PREPAID_PRO_PRICING_CONTRACT);
  assert.equal(params.metadata?.serverId, server.id);
  assert.equal(params.metadata?.months, "12");
  assert.equal(params.metadata?.priceId, "price_prepaid_12m");
  assert.equal(params.payment_intent_data?.metadata?.serverId, server.id);
  const lifetime = (params.expires_at ?? 0) * 1000 - before;
  assert.ok(lifetime >= 30 * 60 * 1000 && lifetime <= 24 * 60 * 60 * 1000, "inside Stripe's 30 minutes to 24 hours");
  assert.match(String(options.idempotencyKey), /^raft-prepaid-checkout-/);
  const [attempt] = await getDb().select().from(billingCheckoutAttempts).where(eq(billingCheckoutAttempts.id, String(params.metadata!.raftCheckoutAttemptId)));
  assert.equal(attempt.state, "known");

  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_known", stripeSubscriptionId: "sub_old", status: "canceled" });
  await createPrepaidCheckout(stripe, server.id, owner.id, { months: 1 as const, seatQuantity: 2, successUrl: "s", cancelUrl: "c", entry: "settings", openedFrom: null, defaultSeatQuantity: null });
  assert.equal(calls.create[1].params.customer, "cus_known", "a returning customer keeps their Stripe customer");
  assert.equal(calls.create[1].params.customer_creation, undefined);
});

test("checkout refuses a Server Pro some other way; a subscription checkout refuses prepaid time", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-exclusive");
  const { stripe } = fakeStripe();
  const request = { months: 1 as const, seatQuantity: 1, successUrl: "s", cancelUrl: "c", entry: "settings", openedFrom: null, defaultSeatQuantity: null };
  const refused = (err: unknown) => err instanceof PrepaidPaidSourceError;
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await assert.rejects(createPrepaidCheckout(stripe, server.id, owner.id, request), refused, "Pro by hand, no prepaid record");
  await getDb().update(servers).set({ plan: "partner" }).where(eq(servers.id, server.id));
  await assert.rejects(createPrepaidCheckout(stripe, server.id, owner.id, request), refused);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_x", status: "past_due" });
  await assert.rejects(createPrepaidCheckout(stripe, server.id, owner.id, request), refused);

  await getDb().update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.serverId, server.id));
  const now = new Date();
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + DAY), seatQuantity: 1 });
  const renewal = await createPrepaidCheckout(stripe, server.id, owner.id, request);
  assert.equal(renewal.renewal, true, "Pro from prepaid time may renew");
  await assert.rejects(reserveStripeCheckout(getDb(), server.id), (err: unknown) => err instanceof PrepaidActiveError, "no subscription on top of prepaid time");
});

test("webhook: a paid prepaid Checkout grants Pro at its seats; a retry records nothing; a renewal continues from the paid end", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-webhook");
  const { stripe } = fakeStripe({ lineItems: lineItemsFor(1, 3) });
  __setStripeForTests(stripe);
  const session = paidSession({ serverId: server.id, userId: owner.id, months: 1, seats: 3 });
  // Save as Artifact's quota paywall opened the dialog (#proj-commercial:#22): the completed event says so.
  session.metadata = { ...session.metadata, checkoutEntry: "upload_monthly_quota", checkoutSurface: "artifact" };
  const recorded: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const before = Date.now();
  await handleWebhookEvent(event("checkout.session.completed", session), { productEvents: { enqueue: (rows) => { recorded.push(...rows); }, flush: async () => {} } });
  const [row] = await rowsOf(server.id);
  assert.equal(row.status, "paid");
  assert.equal(row.seatQuantity, 3);
  assert.equal(row.amountTotal, 3000);
  assert.equal(row.purchasedByUserId, owner.id);
  assert.ok(row.startsAt.getTime() >= before - 1000);
  assert.equal(await planOf(server.id), "pro");
  const entitlement = await getServerBillingEntitlement(getDb(), server.id);
  assert.equal(entitlement.source, "prepaid");
  assert.equal(entitlement.capacity.maxUniversalSeats, 3);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(recorded.filter((row) => row.event === "billing_prepaid_checkout_completed").map((row) => row.properties), [
    { entry: "upload_monthly_quota", months: 1, seat_quantity: 3, renewal: false, surface: "artifact", result: "granted" },
  ]);

  await handleWebhookEvent(event("checkout.session.completed", session));
  assert.equal((await rowsOf(server.id)).length, 1, "one row per session");

  const renewal = paidSession({ serverId: server.id, userId: owner.id, months: 12, seats: 2, renewal: true });
  __setStripeForTests(fakeStripe({ lineItems: lineItemsFor(12, 2) }).stripe);
  await handleWebhookEvent(event("checkout.session.completed", renewal));
  const rows = (await rowsOf(server.id)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  assert.equal(rows[1].startsAt.toISOString(), rows[0].endsAt.toISOString(), "renewing early continues from the paid end");
  const summary = await getBillingSummary(server.id);
  assert.equal(summary.source, "prepaid");
  assert.equal(summary.price, null);
  assert.equal(summary.subscription, null);
  assert.equal(summary.prepaid?.endsAt, rows[1].endsAt.toISOString());
  assert.equal(summary.prepaid?.seatQuantity, 3, "the current period's seats until the renewal starts");
});

test("webhook: a mismatched amount or another paid source records a conflict, grants nothing and refunds once", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-conflict");
  const fake = fakeStripe({ lineItems: lineItemsFor(1, 2) });
  __setStripeForTests(fake.stripe);
  const cheap = paidSession({ serverId: server.id, userId: owner.id, months: 1, seats: 2, amount: 1 });
  await handleWebhookEvent(event("checkout.session.completed", cheap));
  let [row] = await rowsOf(server.id);
  assert.equal(row.status, "conflict");
  assert.equal(row.conflictReason, "amount_mismatch");
  assert.equal(row.stripeRefundId, "re_1");
  assert.equal(fake.calls.refunds[0].params.payment_intent, row.stripePaymentIntentId);
  assert.equal(fake.calls.refunds[0].options.idempotencyKey, `raft-prepaid-conflict-refund-${cheap.id}`);
  assert.equal(await planOf(server.id), "free");

  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_c", stripeSubscriptionId: "sub_c", status: "active" });
  const second = paidSession({ serverId: server.id, userId: owner.id, months: 1, seats: 2 });
  let failRefund = true;
  const flaky = fakeStripe({ lineItems: lineItemsFor(1, 2), refundFails: () => failRefund });
  __setStripeForTests(flaky.stripe);
  await assert.rejects(handleWebhookEvent(event("checkout.session.completed", second)), "a failed refund makes Stripe retry the event");
  [row] = (await rowsOf(server.id)).filter(r => r.stripeCheckoutSessionId === second.id);
  assert.equal(row.status, "conflict");
  assert.equal(row.conflictReason, "paid_source");
  assert.equal(row.stripeRefundId, null);
  failRefund = false;
  const recorded: Array<{ event: string; properties: Record<string, unknown> }> = [];
  await handleWebhookEvent(event("checkout.session.completed", second), { productEvents: { enqueue: (rows: readonly never[]) => { recorded.push(...rows); }, flush: async () => {} } });
  [row] = (await rowsOf(server.id)).filter(r => r.stripeCheckoutSessionId === second.id);
  assert.ok(row.stripeRefundId, "the retry finishes the refund");
  assert.equal(new Set(flaky.calls.refunds.map(call => call.options.idempotencyKey)).size, 1, "same idempotency key: Stripe refunds once");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(JSON.stringify(recorded).includes("billing_prepaid_checkout_completed") && JSON.stringify(recorded).includes("refunded"),
    "the retry that finished the refund reports it");
});

test("a renewal in the hour after grace ends, before the sweep drops the plan, is bought and granted, not refunded", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-gap");
  const now = new Date();
  const lapsedEnd = new Date(now.getTime() - 3 * DAY - 10 * 60_000);
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(lapsedEnd.getTime() - 30 * DAY), endsAt: lapsedEnd, seatQuantity: 1 });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const fake = fakeStripe({ lineItems: lineItemsFor(1, 1) });
  const started = await createPrepaidCheckout(fake.stripe, server.id, owner.id, { months: 1, seatQuantity: 1, successUrl: "s", cancelUrl: "c", entry: "settings", openedFrom: null, defaultSeatQuantity: null });
  assert.equal(started.renewal, false, "the grace days are over: a new period starts now");
  __setStripeForTests(fake.stripe);
  await handleWebhookEvent(event("checkout.session.completed", paidSession({ serverId: server.id, userId: owner.id, months: 1, seats: 1 })));
  const rows = await rowsOf(server.id);
  assert.equal(rows.filter(r => r.status === "paid").length, 2);
  assert.equal(fake.calls.refunds.length, 0);
  assert.equal(await planOf(server.id), "pro");
});

test("webhook: a payment refunded before its Checkout was recorded is kept as refunded and grants nothing", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-refunded-first");
  const fake = fakeStripe({ lineItems: lineItemsFor(1, 2), charge: { amount: 2000, amount_refunded: 2000, refunded: true } });
  __setStripeForTests(fake.stripe);
  await handleWebhookEvent(event("checkout.session.completed", paidSession({ serverId: server.id, userId: owner.id })));
  const [row] = await rowsOf(server.id);
  assert.equal(row.status, "refunded");
  assert.equal(fake.calls.refunds.length, 0);
  assert.equal(await planOf(server.id), "free");
});

test("webhook: a conflict refund Stripe says already happened counts as done", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-already-refunded");
  __setStripeForTests(fakeStripe({ lineItems: lineItemsFor(1, 2), alreadyRefunded: () => true }).stripe);
  await handleWebhookEvent(event("checkout.session.completed", paidSession({ serverId: server.id, userId: owner.id, amount: 1 })));
  const [row] = await rowsOf(server.id);
  assert.equal(row.status, "conflict");
  assert.equal(row.stripeRefundId, "re_existing");
});

test("webhook: an unpaid prepaid Checkout records nothing", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-unpaid");
  __setStripeForTests(fakeStripe({ lineItems: lineItemsFor(1, 2) }).stripe);
  await handleWebhookEvent(event("checkout.session.completed", { ...paidSession({ serverId: server.id, userId: owner.id }), payment_status: "unpaid" }));
  assert.equal((await rowsOf(server.id)).length, 0);
});

test("charge.refunded: a full refund ends the purchase and the Server drops; a partial one changes nothing", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-refund");
  __setStripeForTests(fakeStripe({ lineItems: lineItemsFor(1, 2) }).stripe);
  const session = paidSession({ serverId: server.id, userId: owner.id });
  await handleWebhookEvent(event("checkout.session.completed", session));
  assert.equal(await planOf(server.id), "pro");
  const intent = session.payment_intent as string;
  await handleWebhookEvent(event("charge.refunded", { id: "ch_1", payment_intent: intent, amount: 2000, amount_refunded: 500, refunded: false, refunds: { data: [{ id: "re_part" }] } }));
  assert.equal((await rowsOf(server.id))[0].status, "paid");
  assert.equal(await planOf(server.id), "pro");
  await handleWebhookEvent(event("charge.refunded", { id: "ch_1", payment_intent: intent, amount: 2000, amount_refunded: 2000, refunded: true, refunds: { data: [{ id: "re_full" }] } }));
  const [row] = await rowsOf(server.id);
  assert.equal(row.status, "refunded");
  assert.equal(row.stripeRefundId, "re_existing", "the refund on the payment, asked from Stripe");
  assert.equal(await planOf(server.id), "free");
});

test("a subscription Checkout that completes over prepaid time is canceled and refunded; the Server stays Pro from prepaid", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-sub-race");
  const now = new Date();
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 20 * DAY), seatQuantity: 2 });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const subscription = {
    id: "sub_race", customer: "cus_race", status: "active", cancel_at_period_end: false, cancel_at: null, pending_update: null, schedule: null, trial_end: null, discounts: [],
    latest_invoice: "in_race",
    metadata: { pricingContract: "raft-pro-seat-v1", serverId: server.id, userId: owner.id, targetPlan: "pro", billingInterval: "monthly", seatQuantity: "1", proPackQuantity: "1", packQuantity: "1", provisionedHumanSeats: "1", provisionedAgentSeats: "10", trialFreePackQuantity: "0" },
    items: { data: [{ id: "si_pro_seat", quantity: 1, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, price: { id: "price_pro_seat", product: "prod_pro_seat", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
  const fake = fakeStripe({ subscription, invoicePayments: [{ id: "inpay_1", payment: { type: "payment_intent", payment_intent: "pi_sub" } }], invoiceStatus: "open" });
  // Preserve the SDK's overloaded callable signatures at this test transport boundary.
  const cancel = fake.stripe.subscriptions.cancel.bind(fake.stripe.subscriptions);
  fake.stripe.subscriptions.cancel = ((...args: unknown[]) => {
    assert.equal(isInTransaction(), true, "the subscription mutation is fenced");
    assert.deepEqual(args[2], { timeout: 5_000, maxNetworkRetries: 0 }, "even a previously created client gets bounded mutation options");
    return Reflect.apply(cancel, undefined, args);
  }) as typeof fake.stripe.subscriptions.cancel;
  const list = fake.stripe.invoicePayments.list.bind(fake.stripe.invoicePayments);
  fake.stripe.invoicePayments.list = ((...args: unknown[]) => {
    assert.equal(isInTransaction(), false, "payment iteration must not retain the Server fence");
    return Reflect.apply(list, undefined, args);
  }) as typeof fake.stripe.invoicePayments.list;
  const refund = fake.stripe.refunds.create.bind(fake.stripe.refunds);
  fake.stripe.refunds.create = ((...args: unknown[]) => {
    assert.equal(isInTransaction(), false, "refunds run after the subscription mutation commits");
    return Reflect.apply(refund, undefined, args);
  }) as typeof fake.stripe.refunds.create;
  __setStripeForTests(fake.stripe);
  await handleWebhookEvent(event("checkout.session.completed", {
    id: "cs_sub_race", object: "checkout.session", mode: "subscription", subscription: "sub_race", customer: "cus_race",
    metadata: { serverId: server.id, userId: owner.id, pricingContract: "raft-pro-seat-v1" },
  }));
  assert.deepEqual(fake.calls.cancel, ["sub_race"]);
  assert.equal(fake.calls.refunds[0].params.payment_intent, "pi_sub");
  assert.deepEqual(fake.calls.voided, ["in_race"], "an unpaid first invoice cannot be paid later");
  const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
  assert.equal(sub.status, "canceled");
  assert.equal(await planOf(server.id), "pro");
  assert.equal((await getServerBillingEntitlement(getDb(), server.id)).source, "prepaid");
});

test("a refund that failed while undoing a subscription over prepaid time is finished when Stripe retries, though the subscription is canceled by then (review v1.21.52 M6)", async ({ db: _db }) => {
  const { owner, server } = await seedOwnerServer("prepaid-sub-retry");
  const now = new Date();
  await seedPrepaidPurchase(getDb(), { serverId: server.id, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 20 * DAY), seatQuantity: 2 });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const subscription = {
    id: "sub_retry", customer: "cus_retry", status: "active", cancel_at_period_end: false, cancel_at: null, pending_update: null, schedule: null, trial_end: null, discounts: [],
    latest_invoice: "in_retry",
    metadata: { pricingContract: "raft-pro-seat-v1", serverId: server.id, userId: owner.id, targetPlan: "pro", billingInterval: "monthly", seatQuantity: "1", proPackQuantity: "1", packQuantity: "1", provisionedHumanSeats: "1", provisionedAgentSeats: "10", trialFreePackQuantity: "0" },
    items: { data: [{ id: "si_pro_seat", quantity: 1, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000, price: { id: "price_pro_seat", product: "prod_pro_seat", recurring: { interval: "month" } } }] },
  } as unknown as Stripe.Subscription;
  const completed = event("checkout.session.completed", {
    id: "cs_sub_retry", object: "checkout.session", mode: "subscription", subscription: "sub_retry", customer: "cus_retry",
    metadata: { serverId: server.id, userId: owner.id, pricingContract: "raft-pro-seat-v1" },
  });
  const payments = [{ id: "inpay_1", payment: { type: "payment_intent", payment_intent: "pi_sub_retry" } }];
  const failing = fakeStripe({ subscription, invoicePayments: payments, refundFails: () => true });
  __setStripeForTests(failing.stripe);
  await assert.rejects(handleWebhookEvent(completed), "a failed refund makes Stripe retry the event");
  assert.deepEqual(failing.calls.cancel, ["sub_retry"]);

  // The retry reads the subscription Raft canceled, with the reason it left on it.
  const canceled = { ...subscription, status: "canceled", cancellation_details: { comment: "raft: subscription completed over prepaid time", feedback: null, reason: "cancellation_requested" } } as unknown as Stripe.Subscription;
  const retry = fakeStripe({ subscription: canceled, invoicePayments: payments });
  __setStripeForTests(retry.stripe);
  await handleWebhookEvent(completed);
  assert.equal(retry.calls.refunds.length, 1, "the duplicate charge is refunded");
  assert.equal(retry.calls.refunds[0].params.payment_intent, "pi_sub_retry");
  assert.equal(retry.calls.refunds[0].options.idempotencyKey, failing.calls.refunds[0].options.idempotencyKey, "one refund, however often it is tried");
  assert.deepEqual(retry.calls.cancel, [], "already canceled");

  // A subscription canceled for any other reason is not Raft's to refund.
  const { owner: other, server: otherServer } = await seedOwnerServer("prepaid-sub-canceled-elsewhere");
  await seedPrepaidPurchase(getDb(), { serverId: otherServer.id, startsAt: new Date(now.getTime() - DAY), endsAt: new Date(now.getTime() + 20 * DAY), seatQuantity: 2 });
  const elsewhere = fakeStripe({ subscription: { ...canceled, id: "sub_other", metadata: { ...subscription.metadata, serverId: otherServer.id, userId: other.id }, cancellation_details: { comment: null, feedback: null, reason: "cancellation_requested" } } as unknown as Stripe.Subscription, invoicePayments: payments });
  __setStripeForTests(elsewhere.stripe);
  await handleWebhookEvent(event("checkout.session.completed", {
    id: "cs_sub_other", object: "checkout.session", mode: "subscription", subscription: "sub_other", customer: "cus_retry",
    metadata: { serverId: otherServer.id, userId: other.id, pricingContract: "raft-pro-seat-v1" },
  }));
  assert.equal(elsewhere.calls.refunds.length, 0);
});

test("the lapse sweep alerts after three failing runs in a row and resets on a clean one", async ({ db: _db }) => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const failing = () => { throw new Error("clock broke"); };
    for (let run = 1; run <= 3; run += 1) await assert.rejects(sweepLapsedPrepaidServers(failing));
    assert.ok(errors.some(line => line.includes("ALERT") && line.includes("3 runs in a row")));
    const clean = await sweepLapsedPrepaidServers();
    assert.equal(clean.consecutiveFailures, 0);
  } finally {
    console.error = original;
  }
});
