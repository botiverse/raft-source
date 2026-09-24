import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import {
  PRO_AGENT_SEAT_BLOCK_SIZE,
  calculateAgentSeatBlockQuantity,
  calculateProPackQuantity,
  BasicTracer,
  MemoryTraceSink,
  type TraceEvent,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { subscriptions, servers, users, webhookEvents } from "../db/schema.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";
import { createServer } from "./serverService.js";
import { createAgent } from "./agentService.js";
import {
  __resetBillingPreviewClockForTests,
  __resetStripeForTests,
  __setBillingPreviewClockForTests,
  __setStripeForTests,
  cancelSubscriptionAtPeriodEnd,
  createCheckoutSession,
  getBillingSummary,
  handleWebhookEvent,
  previewProPackQuantityUpdate,
  updateProPackQuantity,
} from "./billingService.js";
import { getServerBillingEntitlement, requireTeamBillingFeature } from "./planService.js";


const ENV_KEYS = [
  "STRIPE_BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
  "JWT_SECRET",
] as const;

const AFTER_FULL_FEATURE_TRIAL = new Date("2026-06-23T12:00:00Z");

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<typeof ENV_KEYS[number], string | undefined>;
}

function restoreEnv(snapshot: Record<typeof ENV_KEYS[number], string | undefined>) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function configureStripeEnv() {
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_pro_pack";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_pro_pack";
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
  process.env.JWT_SECRET = "billing-preview-test-signing-secret";
}

afterEach(async () => {
  __resetBillingPreviewClockForTests();
  __resetStripeForTests();
  await closeTestDatabase();
});

async function captureBillingTrace<T>(work: () => Promise<T>): Promise<{ result: T; events: readonly TraceEvent[] }> {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "b".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  const result = await runWithTraceSpan(span, work);
  span.end();
  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  return { result, events: recorded.events };
}

async function captureRejectedBillingTrace(work: () => Promise<unknown>): Promise<{ error: unknown; events: readonly TraceEvent[] }> {
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => "c".repeat(32),
    spanIdGenerator: (() => {
      let next = 1;
      return () => String(next++).padStart(16, "0");
    })(),
  });
  const span = tracer.startSpan("server.http.request", { surface: "server", kind: "server" });
  let caught: unknown;
  try {
    await runWithTraceSpan(span, work);
  } catch (error) {
    caught = error;
  } finally {
    span.end(caught ? "error" : "ok");
  }
  assert.ok(caught, "expected work to reject");
  const [recorded] = sink.getAllSpans();
  assert.ok(recorded);
  return { error: caught, events: recorded.events };
}

function traceEvent(events: readonly TraceEvent[], name: string): TraceEvent {
  const event = events.find((candidate) => candidate.name === name);
  assert.ok(event, `missing trace event ${name}`);
  return event;
}

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user;
}

function stripeSub(input: {
  id: string;
  serverId: string;
  userId: string;
  status: Stripe.Subscription.Status;
  customer?: string;
  packQuantity?: number;
  itemQuantity?: number;
  pendingUpdate?: boolean;
  schedule?: string | { id: string; current_phase?: { start_date?: number } | null } | null;
  trialEnd?: number | null;
  billingInterval?: "monthly" | "annual";
  cancelAtPeriodEnd?: boolean;
  cancelAt?: number | null;
  billingTraceId?: string;
  discounts?: Array<string | Stripe.Discount>;
}): Stripe.Subscription {
  const packQuantity = input.packQuantity ?? 1;
  const itemQuantity = input.itemQuantity ?? packQuantity;
  const billingInterval = input.billingInterval ?? "monthly";
  const priceId = billingInterval === "annual" ? "price_pro_seat_annual" : "price_pro_seat";
  return {
    id: input.id,
    customer: input.customer ?? "cus_test",
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    cancel_at: input.cancelAt ?? null,
    pending_update: input.pendingUpdate ? { expires_at: 1_700_010_000 } : null,
    schedule: input.schedule ?? null,
    trial_end: input.trialEnd ?? null,
    discounts: input.discounts ?? [],
    metadata: {
      pricingContract: "raft-pro-seat-v1",
      serverId: input.serverId,
      userId: input.userId,
      targetPlan: "pro",
      billingInterval,
      seatQuantity: String(packQuantity),
      humanSeatQuantity: String(packQuantity),
      requestedAgentSeats: "0",
      agentSeatBlockQuantity: "0",
      proPackQuantity: String(packQuantity),
      packQuantity: String(packQuantity),
      stripeInitialPaidPackQuantity: String(packQuantity),
      provisionedHumanSeats: String(packQuantity),
      provisionedAgentSeats: String(packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE),
      trialFreePackQuantity: "0",
      ...(input.billingTraceId ? { billingTraceId: input.billingTraceId } : {}),
    },
    items: {
      data: [
        {
          id: "si_pro_seat",
          quantity: itemQuantity,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: priceId, product: "prod_pro_seat", recurring: { interval: billingInterval === "annual" ? "year" : "month" } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function seatUpdatePromotionCode(input: {
  id?: string;
  code?: string;
  customer?: string | null;
  active?: boolean;
  metadata?: Record<string, string>;
  couponMetadata?: Record<string, string>;
} = {}): Stripe.PromotionCode {
  return {
    id: input.id ?? "promo_seat_update",
    object: "promotion_code",
    active: input.active ?? true,
    code: input.code ?? "SAVE10",
    created: 1_700_000_000,
    customer: input.customer ?? null,
    customer_account: null,
    expires_at: null,
    livemode: false,
    max_redemptions: null,
    metadata: input.metadata ?? { raft_use: "seat_update" },
    promotion: {
      type: "coupon",
      coupon: {
        id: "coupon_save_10",
        object: "coupon",
        amount_off: null,
        applies_to: { products: ["prod_pro_seat"] },
        created: 1_700_000_000,
        currency: null,
        duration: "forever",
        duration_in_months: null,
        livemode: false,
        max_redemptions: null,
        metadata: input.couponMetadata ?? {},
        name: "Seat launch",
        percent_off: 10,
        redeem_by: null,
        times_redeemed: 0,
        valid: true,
      },
    },
    restrictions: {
      first_time_transaction: false,
      minimum_amount: null,
      minimum_amount_currency: null,
    },
    times_redeemed: 0,
  } as Stripe.PromotionCode;
}

function previewInvoice(input: {
  amountDue: number;
  discountAmount?: number;
  prorationAmount?: number;
  prorationTax?: number;
}): Stripe.Invoice {
  const prorationAmount = input.prorationAmount ?? 0;
  return {
    amount_due: input.amountDue,
    total: input.amountDue,
    currency: "usd",
    total_discount_amounts: input.discountAmount == null ? [] : [{ amount: input.discountAmount, discount: "di_preview" }],
    lines: {
      data: prorationAmount === 0
        ? []
        : [{
            amount: prorationAmount,
            taxes: input.prorationTax == null ? [] : [{ amount: input.prorationTax }],
            parent: { type: "subscription_item_details", subscription_item_details: { proration: true } },
          }],
    },
  } as unknown as Stripe.Invoice;
}

function proSeatStripeSub(input: {
  id: string;
  serverId: string;
  userId: string;
  status: Stripe.Subscription.Status;
  customer?: string;
  seatQuantity?: number;
  itemQuantity?: number;
  pendingUpdate?: boolean;
  billingInterval?: "monthly" | "annual";
  cancelAtPeriodEnd?: boolean;
  requestedHumans?: number;
  requestedAgents?: number;
}): Stripe.Subscription {
  const seatQuantity = input.seatQuantity ?? 1;
  const itemQuantity = input.itemQuantity ?? seatQuantity;
  const billingInterval = input.billingInterval ?? "monthly";
  const priceId = billingInterval === "annual" ? "price_pro_seat_annual" : "price_pro_seat";
  const requestedAgents = input.requestedAgents ?? 0;
  return {
    id: input.id,
    customer: input.customer ?? "cus_test",
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    pending_update: input.pendingUpdate ? { expires_at: 1_700_010_000 } : null,
    schedule: null,
    trial_end: null,
    metadata: {
      pricingContract: "raft-pro-seat-v1",
      serverId: input.serverId,
      userId: input.userId,
      targetPlan: "pro",
      billingInterval,
      seatQuantity: String(seatQuantity),
      humanSeatQuantity: String(input.requestedHumans ?? seatQuantity),
      requestedAgentSeats: String(requestedAgents),
      agentSeatBlockQuantity: String(calculateAgentSeatBlockQuantity(requestedAgents)),
      provisionedHumanSeats: String(seatQuantity),
      provisionedAgentSeats: String(seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE),
      proPackQuantity: String(seatQuantity),
      packQuantity: String(seatQuantity),
      stripeInitialPaidPackQuantity: String(seatQuantity),
      trialFreePackQuantity: "0",
    },
    items: {
      data: [
        {
          id: "si_pro_seat",
          quantity: itemQuantity,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: priceId, product: "prod_pro_seat", recurring: { interval: billingInterval === "annual" ? "year" : "month" } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

async function seedLocalProSubscription(input: {
  serverId: string;
  userId: string;
  subscriptionId: string;
  packQuantity: number;
  customerId?: string;
  billingInterval?: "monthly" | "annual";
  cancelAtPeriodEnd?: boolean;
}) {
  await getDb().insert(subscriptions).values({
    serverId: input.serverId,
    stripeCustomerId: input.customerId ?? `cus_${input.subscriptionId}`,
    stripeSubscriptionId: input.subscriptionId,
    stripeProPackItemId: "si_pro_seat",
    billingInterval: input.billingInterval ?? "monthly",
    status: "active",
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    provisionedHumanSeats: input.packQuantity,
    provisionedAgentSeats: input.packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: input.packQuantity,
    trialFreePackQuantity: 0,
    firstPackTrialEndsAt: null,
    currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
    // Far-future on purpose: getSubscription() has an "active but currentPeriodEnd
    // in the past -> verify with Stripe" refresh branch. A near/fixed end date is a
    // time-bomb — this was "2026-07-01", which went stale on 2026-07-01T00:00Z and
    // made getSubscription fire an unexpected stripe.subscriptions.retrieve, breaking
    // retrieveCalls==0 assertions (e.g. the usage-floor reject test). Keep it decades out.
    currentPeriodEnd: new Date("2099-01-01T00:00:00Z"),
    createdByUserId: input.userId,
  });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, input.serverId));
}

function makeEvent(id: string, type: Stripe.Event.Type, object: unknown): Stripe.Event {
  return {
    id,
    type,
    data: { object },
  } as Stripe.Event;
}

async function assertCheckoutSeats(humanSeats: number, requestedAgentSeats: number, billingInterval: "monthly" | "annual" = "annual") {
  const seatQuantity = calculateProPackQuantity(humanSeats, requestedAgentSeats);
  const provisionedAgentSeats = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const owner = await seedUser(`checkout-pro-${billingInterval}-${humanSeats}-${requestedAgentSeats}-owner`);
  const server = await createServer(`Checkout Pro ${billingInterval} ${humanSeats} ${requestedAgentSeats}`, `checkout-pro-${billingInterval}-${humanSeats}-${requestedAgentSeats}-${randomUUID()}`, owner.id);
  const createCalls: unknown[] = [];
  __setStripeForTests({
    checkout: {
      sessions: {
        create: async (params: unknown) => {
          createCalls.push(params);
          return { url: "https://checkout.stripe.test/session" };
        },
      },
    },
  } as unknown as Stripe);

  const url = await createCheckoutSession(
    server.id,
    owner.id,
    "http://localhost:5173/success",
    "http://localhost:5173/cancel",
    { targetPlan: "pro", humanSeatQuantity: humanSeats, agentSeatQuantity: requestedAgentSeats, billingInterval },
  );
  assert.equal(url, "https://checkout.stripe.test/session");
  assert.equal(createCalls.length, 1);
  const params = createCalls[0] as {
    mode: string;
    client_reference_id?: string;
    customer?: string;
    customer_creation?: string;
    allow_promotion_codes?: boolean;
    line_items: Array<{ price: string; quantity: number }>;
    discounts?: Array<{ coupon: string }>;
    metadata: Record<string, string>;
    subscription_data: { metadata: Record<string, string>; trial_end?: number; trial_period_days?: number };
  };
  assert.equal(params.mode, "subscription");
  assert.equal(params.client_reference_id, server.id);
  assert.equal(params.customer, undefined);
  assert.equal(params.customer_creation, undefined, "subscription checkout must not send payment-mode-only customer_creation");
  assert.equal(params.allow_promotion_codes, true);
  const expectedSeatPriceId = billingInterval === "annual" ? "price_pro_seat_annual" : "price_pro_seat";
  assert.deepEqual(params.line_items, [{ price: expectedSeatPriceId, quantity: seatQuantity }]);
  assert.equal(params.discounts, undefined);
  assert.equal(params.metadata.targetPlan, "pro");
  assert.equal(params.metadata.billingInterval, billingInterval);
  assert.equal(params.metadata.serverId, server.id);
  assert.equal(params.metadata.userId, owner.id);
  assert.equal(params.metadata.pricingContract, "raft-pro-seat-v1");
  assert.equal(params.metadata.seatQuantity, String(seatQuantity));
  assert.equal(params.metadata.humanSeatQuantity, String(humanSeats));
  assert.equal(params.metadata.requestedAgentSeats, String(requestedAgentSeats));
  assert.equal(params.metadata.agentSeatBlockQuantity, String(calculateAgentSeatBlockQuantity(requestedAgentSeats)));
  assert.equal(params.metadata.proPackQuantity, String(seatQuantity));
  assert.equal(params.metadata.stripeInitialPaidPackQuantity, String(seatQuantity));
  assert.equal(params.metadata.trialFreePackQuantity, "0");
  assert.equal(params.metadata.provisionedHumanSeats, String(seatQuantity));
  assert.equal(params.metadata.provisionedAgentSeats, String(provisionedAgentSeats));
  assert.equal(params.metadata.firstPackTrialEndsAt, undefined);
  assert.deepEqual(params.subscription_data.metadata, params.metadata);
  assert.equal(params.subscription_data.trial_period_days, undefined);
  assert.equal(params.subscription_data.trial_end, undefined);

  const rows = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
  assert.equal(rows.length, 0, "checkout session creation must not grant local entitlement");
}

test("checkout creates paid Pro seat params and no local entitlement", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    await assertCheckoutSeats(1, 10);
    await assertCheckoutSeats(2, 12);
    await assertCheckoutSeats(2, 12, "monthly");
  } finally {
    restoreEnv(env);
  }
});

test("checkout emits sanitized billing trace events", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("checkout-trace-owner");
    const server = await createServer("Checkout Trace", `checkout-trace-${randomUUID()}`, owner.id);
    const createCalls: unknown[] = [];
    __setStripeForTests({
      checkout: {
        sessions: {
          create: async (params: unknown) => {
            createCalls.push(params);
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      },
    } as unknown as Stripe);

    const { result: url, events } = await captureBillingTrace(() => createCheckoutSession(
      server.id,
      owner.id,
      "http://localhost:5173/success",
      "http://localhost:5173/cancel",
      { targetPlan: "pro", humanSeatQuantity: 2, agentSeatQuantity: 12, billingInterval: "monthly", billingTraceId: "billing_test_123" },
    ));

    assert.equal(url, "https://checkout.stripe.test/session");
    const params = createCalls[0] as { client_reference_id?: string; metadata?: Record<string, string>; subscription_data?: { metadata?: Record<string, string> } };
    assert.equal(params.client_reference_id, server.id);
    assert.equal(params.metadata?.billingTraceId, "billing_test_123");
    assert.equal(params.subscription_data?.metadata?.billingTraceId, "billing_test_123");
    assert.equal(traceEvent(events, "billing.checkout.requested").attrs?.server_id, server.id);
    assert.equal(traceEvent(events, "billing.checkout.requested").attrs?.billing_trace_id, "billing_test_123");
    const built = traceEvent(events, "billing.checkout.contract_built");
    assert.equal(built.attrs?.billing_trace_id, "billing_test_123");
    assert.equal(built.attrs?.pricing_contract, "raft-pro-seat-v1");
    assert.equal(built.attrs?.billing_interval, "monthly");
    assert.equal(built.attrs?.seat_quantity, calculateProPackQuantity(2, 12));
    assert.equal(built.attrs?.requested_human_seats, 2);
    assert.equal(built.attrs?.requested_agent_seats, 12);
    const sessionCreated = traceEvent(events, "billing.checkout.session.created");
    assert.equal(sessionCreated.attrs?.billing_trace_id, "billing_test_123");
    assert.equal(sessionCreated.attrs?.stripe_session_url_present, true);
  } finally {
    restoreEnv(env);
  }
});

test("checkout requires canonical Pro Stripe env vars", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  delete process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID;
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("checkout-env-owner");
    const server = await createServer("Checkout Env", `checkout-env-${randomUUID()}`, owner.id);
    __setStripeForTests({
      checkout: { sessions: { create: async () => ({ url: "unused" }) } },
    } as unknown as Stripe);
    await assert.rejects(
      () => createCheckoutSession(server.id, owner.id, "http://localhost:5173/success", "http://localhost:5173/cancel", { targetPlan: "pro" }),
      /STRIPE_PRO_SEAT_ANNUAL_PRICE_ID is not configured/,
    );
  } finally {
    restoreEnv(env);
  }
});

test("checkout configuration failures emit billing failure trace", async () => {
  const env = snapshotEnv();
  delete process.env.STRIPE_BILLING_ENABLED;
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("checkout-trace-failure-owner");
    const server = await createServer("Checkout Trace Failure", `checkout-trace-failure-${randomUUID()}`, owner.id);
    const { error, events } = await captureRejectedBillingTrace(() => createCheckoutSession(
      server.id,
      owner.id,
      "http://localhost:5173/success",
      "http://localhost:5173/cancel",
      { targetPlan: "pro", seatQuantity: 1 },
    ));
    assert.match((error as Error).message, /STRIPE_BILLING_ENABLED/);
    assert.equal(traceEvent(events, "billing.checkout.requested").attrs?.stripe_billing_flag_enabled, false);
    assert.equal(traceEvent(events, "billing.checkout.failed").attrs?.error_class, "Error");
  } finally {
    restoreEnv(env);
  }
});

test("checkout completed webhook reconciles Pro projection and duplicate events are idempotent", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("webhook-pro-owner");
    const server = await createServer("Webhook Pro", `webhook-pro-${randomUUID()}`, owner.id);
    let retrieveCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          return stripeSub({
            id: "sub_pro",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pro",
            packQuantity: 3,
            billingTraceId: "billing_webhook_123",
          });
        },
      },
    } as unknown as Stripe);

    const session = {
      mode: "subscription",
      metadata: { serverId: server.id, userId: owner.id, billingTraceId: "billing_webhook_123" },
      subscription: "sub_pro",
      customer: "cus_pro",
    };
    const { events } = await captureBillingTrace(() => handleWebhookEvent(makeEvent("evt_checkout_pro", "checkout.session.completed", session)));
    await handleWebhookEvent(makeEvent("evt_checkout_pro", "checkout.session.completed", session));

    assert.deepEqual(
      events.filter((event) => event.name.startsWith("billing.webhook") || event.name === "billing.subscription_projection.synced").map((event) => event.name),
      [
        "billing.webhook.received",
        "billing.webhook.claim.created",
        "billing.subscription_projection.synced",
        "billing.webhook.processed",
      ],
    );
    assert.equal(traceEvent(events, "billing.checkout.completed.received").attrs?.billing_trace_id, "billing_webhook_123");
    const projectionTrace = traceEvent(events, "billing.subscription_projection.synced");
    assert.equal(projectionTrace.attrs?.server_id, server.id);
    assert.equal(projectionTrace.attrs?.billing_trace_id, "billing_webhook_123");
    assert.equal(projectionTrace.attrs?.plan, "pro");
    assert.equal(projectionTrace.attrs?.status, "active");
    assert.equal(projectionTrace.attrs?.seat_quantity, 3);
    assert.equal(projectionTrace.attrs?.stripe_subscription_present, true);
    assert.equal(projectionTrace.attrs?.stripe_customer_present, true);
    assert.equal(projectionTrace.attrs?.stripe_event_id_present, true);

    assert.equal(retrieveCount, 1);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.plan, "pro");
    assert.equal(sub.status, "active");
    assert.equal(sub.stripeProPackItemId, "si_pro_seat");
    assert.equal(sub.provisionedHumanSeats, 3);
    assert.equal(sub.provisionedAgentSeats, 30);
    assert.equal(sub.proPackQuantity, 3);
    assert.equal(sub.trialFreePackQuantity, 0);
    assert.equal(sub.lastProviderEventId, "evt_checkout_pro");
    const [serverRow] = await getDb().select({ plan: servers.plan }).from(servers).where(eq(servers.id, server.id));
    assert.equal(serverRow.plan, "pro");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.plan, "pro");
    assert.equal(entitlement.capacity.maxUniversalSeats, 3);
  } finally {
    restoreEnv(env);
  }
});

test("failed webhook claim can be retried and then reconciles projection", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("webhook-retry-owner");
    const server = await createServer("Webhook Retry", `webhook-retry-${randomUUID()}`, owner.id);
    let retrieveCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          if (retrieveCount === 1) {
            throw new Error("temporary Stripe retrieve failure");
          }
          return stripeSub({
            id: "sub_retry_pro",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_retry",
            packQuantity: 1,
          });
        },
      },
    } as unknown as Stripe);

    const session = {
      mode: "subscription",
      metadata: { serverId: server.id, userId: owner.id },
      subscription: "sub_retry_pro",
      customer: "cus_retry",
    };
    await assert.rejects(
      () => handleWebhookEvent(makeEvent("evt_retry_pro", "checkout.session.completed", session)),
      /temporary Stripe retrieve failure/,
    );
    assert.equal(retrieveCount, 1);
    assert.equal((await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id))).length, 0);

    await handleWebhookEvent(makeEvent("evt_retry_pro", "checkout.session.completed", session));

    assert.equal(retrieveCount, 2);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.plan, "pro");
    assert.equal(sub.status, "active");
    assert.equal(sub.proPackQuantity, 1);
    assert.equal(sub.lastProviderEventId, "evt_retry_pro");
    const [eventRow] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, "evt_retry_pro"));
    assert.equal(eventRow.status, "processed");
  } finally {
    restoreEnv(env);
  }
});

test("stale webhook processing claim is retried and reconciles projection", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("webhook-stale-owner");
    const server = await createServer("Webhook Stale", `webhook-stale-${randomUUID()}`, owner.id);
    const staleClaimedAt = new Date(Date.now() - 10 * 60 * 1000);
    await getDb().insert(webhookEvents).values({
      id: "evt_stale_pro",
      type: "checkout.session.completed",
      status: "processing",
      processedAt: staleClaimedAt,
    });
    let retrieveCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          return stripeSub({
            id: "sub_stale_pro",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_stale",
            packQuantity: 2,
          });
        },
      },
    } as unknown as Stripe);

    const session = {
      mode: "subscription",
      metadata: { serverId: server.id, userId: owner.id },
      subscription: "sub_stale_pro",
      customer: "cus_stale",
    };
    await handleWebhookEvent(makeEvent("evt_stale_pro", "checkout.session.completed", session));

    assert.equal(retrieveCount, 1);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.plan, "pro");
    assert.equal(sub.status, "active");
    assert.equal(sub.proPackQuantity, 2);
    assert.equal(sub.lastProviderEventId, "evt_stale_pro");
    const [eventRow] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, "evt_stale_pro"));
    assert.equal(eventRow.status, "processed");
    assert.ok(eventRow.processedAt > staleClaimedAt);
  } finally {
    restoreEnv(env);
  }
});

test("failed stale claimant does not delete a newer processing claim", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("webhook-lease-owner");
    const server = await createServer("Webhook Lease", `webhook-lease-${randomUUID()}`, owner.id);
    let retrieveCount = 0;
    let firstEnteredResolve!: () => void;
    let releaseFirstReject!: () => void;
    let secondEnteredResolve!: () => void;
    let releaseSecondSuccess!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstEnteredResolve = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { releaseFirstReject = resolve; });
    const secondEntered = new Promise<void>((resolve) => { secondEnteredResolve = resolve; });
    const releaseSecond = new Promise<void>((resolve) => { releaseSecondSuccess = resolve; });
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          if (retrieveCount === 1) {
            firstEnteredResolve();
            await releaseFirst;
            throw new Error("first claimant failed after lease was reclaimed");
          }
          secondEnteredResolve();
          await releaseSecond;
          return stripeSub({
            id: "sub_lease_pro",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_lease",
            packQuantity: 1,
          });
        },
      },
    } as unknown as Stripe);

    const session = {
      mode: "subscription",
      metadata: { serverId: server.id, userId: owner.id },
      subscription: "sub_lease_pro",
      customer: "cus_lease",
    };
    const event = makeEvent("evt_lease_pro", "checkout.session.completed", session);
    const firstResult = handleWebhookEvent(event).then(() => null, (err: Error) => err);
    await firstEntered;
    await getDb().update(webhookEvents).set({
      processedAt: new Date(Date.now() - 10 * 60 * 1000),
    }).where(eq(webhookEvents.id, "evt_lease_pro"));

    const secondResult = handleWebhookEvent(event);
    await secondEntered;
    releaseFirstReject();
    const firstErr = await firstResult;
    assert.match(firstErr?.message ?? "", /first claimant failed/);
    const [inProgressEvent] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, "evt_lease_pro"));
    assert.equal(inProgressEvent.status, "processing");

    releaseSecondSuccess();
    await secondResult;
    const [processedEvent] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, "evt_lease_pro"));
    assert.equal(processedEvent.status, "processed");
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.status, "active");
    assert.equal(sub.lastProviderEventId, "evt_lease_pro");
  } finally {
    restoreEnv(env);
  }
});

test("increasing existing Pro pack quantity uses pending update proration and waits for webhook entitlement", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-increase-owner");
    const server = await createServer("Pack Increase", `pack-increase-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_increase",
      packQuantity: 1,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_increase",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_increase",
          packQuantity: 1,
          itemQuantity: 1,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_increase",
            packQuantity: 3,
            itemQuantity: 3,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 3 });
    assert.equal(result.status, "pending_webhook");
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0]?.id, "sub_pack_increase");
    assert.deepEqual(updateCalls[0]?.params.items, [{ id: "si_pro_seat", quantity: 3 }]);
    assert.equal(updateCalls[0]?.params.payment_behavior, "pending_if_incomplete");
    assert.equal(updateCalls[0]?.params.proration_behavior, "always_invoice");
    assert.equal((updateCalls[0]?.params.metadata as Record<string, string>).proPackQuantity, "3");

    const beforeWebhook = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(beforeWebhook.proPackQuantity, 1);
    assert.equal(beforeWebhook.capacity.maxUniversalSeats, 1);

    await handleWebhookEvent(makeEvent("evt_pack_increase", "customer.subscription.updated", stripeSub({
      id: "sub_pack_increase",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_pack_increase",
      packQuantity: 3,
      itemQuantity: 3,
    })));
    const afterWebhook = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(afterWebhook.proPackQuantity, 3);
    assert.equal(afterWebhook.capacity.maxUniversalSeats, 3);
  } finally {
    restoreEnv(env);
  }
});

test("seat increase preview binds the Stripe promotion and proration date used by confirm", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  const previewNowMs = 1_700_100_000_000;
  __setBillingPreviewClockForTests(() => previewNowMs);
  try {
    const owner = await seedUser("pack-promo-owner");
    const server = await createServer("Pack Promo", `pack-promo-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo",
      packQuantity: 2,
    });
    const promotionCode = seatUpdatePromotionCode({ customer: "cus_pack_promo" });
    const previewCalls: Array<Record<string, unknown>> = [];
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_promo",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_promo",
          packQuantity: 2,
          itemQuantity: 2,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_promo",
            packQuantity: 3,
            itemQuantity: 3,
          });
        },
      },
      promotionCodes: {
        list: async () => ({ data: [promotionCode] }),
        retrieve: async () => promotionCode,
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => {
          previewCalls.push(params);
          return params.preview_mode === "recurring"
            ? previewInvoice({ amountDue: 2_700, discountAmount: 300 })
            : previewInvoice({ amountDue: 3_150, discountAmount: 350, prorationAmount: 450, prorationTax: 50 });
        },
      },
    } as unknown as Stripe);

    const preview = await previewProPackQuantityUpdate(server.id, owner.id, {
      seatQuantity: 3,
      promotionCode: " save10 ",
    });

    assert.equal(preview.status, "preview");
    assert.equal(preview.currentPackQuantity, 2);
    assert.equal(preview.requestedPackQuantity, 3);
    assert.equal(preview.currency, "usd");
    assert.equal(preview.prorationAmount, 500);
    assert.equal(preview.recurringAmount, 2_700);
    assert.equal(preview.discountAmount, 300);
    assert.deepEqual(preview.promotion, {
      code: "SAVE10",
      name: "Seat launch",
      percentOff: 10,
      amountOff: null,
      currency: null,
    });
    assert.equal(preview.expiresAt, new Date(previewNowMs + 5 * 60 * 1000).toISOString());
    assert.ok(preview.previewToken.length > 32);
    assert.equal(previewCalls.length, 2);
    const prorationDate = Math.floor(previewNowMs / 1000);
    assert.deepEqual(previewCalls[0], {
      customer: "cus_pack_promo",
      subscription: "sub_pack_promo",
      discounts: [{ promotion_code: "promo_seat_update" }],
      subscription_details: {
        items: [{ id: "si_pro_seat", quantity: 3 }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    assert.deepEqual(previewCalls[1], {
      customer: "cus_pack_promo",
      subscription: "sub_pack_promo",
      discounts: [{ promotion_code: "promo_seat_update" }],
      preview_mode: "recurring",
      subscription_details: {
        items: [{ id: "si_pro_seat", quantity: 3 }],
      },
    });

    const result = await updateProPackQuantity(server.id, owner.id, {
      seatQuantity: 3,
      previewToken: preview.previewToken,
    });
    assert.equal(result.status, "pending_webhook");
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0]?.params.discounts, [{ promotion_code: "promo_seat_update" }]);
    assert.equal(updateCalls[0]?.params.proration_date, prorationDate);
    assert.equal(updateCalls[0]?.params.payment_behavior, "pending_if_incomplete");
    assert.equal(updateCalls[0]?.params.proration_behavior, "always_invoice");

    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("seat update preview rejects promotion codes that are not explicitly allowed for seat updates", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-promo-scope-owner");
    const server = await createServer("Pack Promo Scope", `pack-promo-scope-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo_scope",
      packQuantity: 1,
    });
    let invoicePreviewCalls = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_promo_scope",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_promo_scope",
          packQuantity: 1,
        }),
      },
      promotionCodes: {
        list: async () => ({ data: [seatUpdatePromotionCode({ metadata: {}, couponMetadata: {} })] }),
      },
      invoices: {
        createPreview: async () => {
          invoicePreviewCalls += 1;
          return previewInvoice({ amountDue: 0 });
        },
      },
    } as unknown as Stripe);

    await assert.rejects(
      () => previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 2, promotionCode: "SAVE10" }),
      /Promotion code is not valid for seat updates/,
    );
    assert.equal(invoicePreviewCalls, 0);
  } finally {
    restoreEnv(env);
  }
});

test("seat update preview never crosses customer scope or replaces an existing subscription discount", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-promo-customer-owner");
    const server = await createServer("Pack Promo Customer", `pack-promo-customer-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo_customer",
      packQuantity: 1,
    });
    let invoicePreviewCalls = 0;
    const stripeSubscription = (discounts: Array<string | Stripe.Discount> = []) => stripeSub({
      id: "sub_pack_promo_customer",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_pack_promo_customer",
      packQuantity: 1,
      discounts,
    });

    __setStripeForTests({
      subscriptions: { retrieve: async () => stripeSubscription() },
      promotionCodes: {
        list: async () => ({ data: [seatUpdatePromotionCode({ customer: "cus_someone_else" })] }),
      },
      invoices: {
        createPreview: async () => {
          invoicePreviewCalls += 1;
          return previewInvoice({ amountDue: 0 });
        },
      },
    } as unknown as Stripe);
    await assert.rejects(
      () => previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 2, promotionCode: "SAVE10" }),
      /Promotion code is invalid or expired/,
    );

    let promotionListCalls = 0;
    __setStripeForTests({
      subscriptions: { retrieve: async () => stripeSubscription(["di_existing"]) },
      promotionCodes: {
        list: async () => {
          promotionListCalls += 1;
          return { data: [seatUpdatePromotionCode()] };
        },
      },
      invoices: {
        createPreview: async () => {
          invoicePreviewCalls += 1;
          return previewInvoice({ amountDue: 0 });
        },
      },
    } as unknown as Stripe);
    await assert.rejects(
      () => previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 2, promotionCode: "SAVE10" }),
      /already has a discount; it will not be replaced automatically/,
    );
    assert.equal(promotionListCalls, 0);
    assert.equal(invoicePreviewCalls, 0);
  } finally {
    restoreEnv(env);
  }
});

test("seat update confirm rejects tampered, expired, and stale preview tokens before mutation", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  const previewNowMs = 1_700_100_000_000;
  __setBillingPreviewClockForTests(() => previewNowMs);
  try {
    const owner = await seedUser("pack-promo-token-owner");
    const server = await createServer("Pack Promo Token", `pack-promo-token-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo_token",
      packQuantity: 2,
    });
    let stripeQuantity = 2;
    let updateCalls = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_promo_token",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_promo_token",
          packQuantity: stripeQuantity,
          itemQuantity: stripeQuantity,
        }),
        update: async () => {
          updateCalls += 1;
          return stripeSub({
            id: "sub_pack_promo_token",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            packQuantity: 3,
          });
        },
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => params.preview_mode === "recurring"
          ? previewInvoice({ amountDue: 3_000 })
          : previewInvoice({ amountDue: 500, prorationAmount: 500 }),
      },
    } as unknown as Stripe);

    const preview = await previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 3 });
    const tampered = `${preview.previewToken.slice(0, -1)}${preview.previewToken.endsWith("a") ? "b" : "a"}`;
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: tampered }),
      /Seat update preview is invalid or expired/,
    );

    // Deterministic canonicalization teeth (task #125): base64url decoders tolerate
    // spellings that differ only in the unused low bits of the final sextet (or in
    // stray padding), so a tampered spelling can decode to the exact signed bytes.
    // The verifier must bind the exact encoded text, not just the decoded bytes.
    const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const dotIndex = preview.previewToken.lastIndexOf(".");
    const payload = preview.previewToken.slice(0, dotIndex);
    const signature = preview.previewToken.slice(dotIndex + 1);
    // A 32-byte HMAC leaves 2 unused low bits in the final base64url sextet; flipping
    // one always yields a different spelling of the same signature bytes (this is the
    // `Y`→`a` case that made the hosted shard intermittently green on 2026-08-08).
    const sigVariant = `${signature.slice(0, -1)}${B64URL_ALPHABET[B64URL_ALPHABET.indexOf(signature.at(-1)!) ^ 0b10]}`;
    assert.notEqual(sigVariant, signature);
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: `${payload}.${sigVariant}` }),
      /Seat update preview is invalid or expired/,
    );
    // Non-canonical payload spellings must fail closed too: stray padding...
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: `${payload}=.${signature}` }),
      /Seat update preview is invalid or expired/,
    );
    // ...and, when the payload's final sextet has unused low bits, an equivalent
    // re-spelling of the same payload bytes.
    const payloadUnusedBits = [0, 4, 2][Buffer.from(payload, "base64url").length % 3]!;
    if (payloadUnusedBits > 0) {
      const payloadVariant = `${payload.slice(0, -1)}${B64URL_ALPHABET[B64URL_ALPHABET.indexOf(payload.at(-1)!) ^ 0b10]}`;
      assert.notEqual(payloadVariant, payload);
      await assert.rejects(
        () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: `${payloadVariant}.${signature}` }),
        /Seat update preview is invalid or expired/,
      );
    }

    __setBillingPreviewClockForTests(() => previewNowMs + 5 * 60 * 1000 + 1);
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: preview.previewToken }),
      /Seat update preview is invalid or expired/,
    );

    __setBillingPreviewClockForTests(() => previewNowMs);
    stripeQuantity = 3;
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: preview.previewToken }),
      /Seat update changed after preview; review the latest price before confirming/,
    );
    assert.equal(updateCalls, 0);
  } finally {
    restoreEnv(env);
  }
});

test("seat update confirm rejects an existing pending update before any Stripe mutation", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-promo-pending-owner");
    const server = await createServer("Pack Promo Pending", `pack-promo-pending-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo_pending",
      packQuantity: 2,
    });
    let pendingUpdate = false;
    let updateCalls = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_promo_pending",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_promo_pending",
          packQuantity: 2,
          itemQuantity: 2,
          pendingUpdate,
        }),
        update: async () => {
          updateCalls += 1;
          return stripeSub({
            id: "sub_pack_promo_pending",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            packQuantity: 3,
          });
        },
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => params.preview_mode === "recurring"
          ? previewInvoice({ amountDue: 3_000 })
          : previewInvoice({ amountDue: 500, prorationAmount: 500 }),
      },
    } as unknown as Stripe);

    const preview = await previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 3 });
    pendingUpdate = true;
    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: preview.previewToken }),
      /A seat update is already pending Stripe payment confirmation/,
    );
    assert.equal(updateCalls, 0);
  } finally {
    restoreEnv(env);
  }
});

test("concurrent duplicate seat update confirms share one Stripe idempotency key", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-promo-concurrent-owner");
    const server = await createServer("Pack Promo Concurrent", `pack-promo-concurrent-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_promo_concurrent",
      packQuantity: 2,
    });
    const responsesByIdempotencyKey = new Map<string, Stripe.Subscription>();
    const updateIdempotencyKeys: string[] = [];
    let physicalStripeMutations = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_promo_concurrent",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_promo_concurrent",
          packQuantity: 2,
          itemQuantity: 2,
        }),
        update: async (_id: string, _params: Record<string, unknown>, options?: Stripe.RequestOptions) => {
          const idempotencyKey = options?.idempotencyKey;
          assert.ok(idempotencyKey, "preview confirm must send a Stripe idempotency key");
          updateIdempotencyKeys.push(idempotencyKey);
          let response = responsesByIdempotencyKey.get(idempotencyKey);
          if (!response) {
            physicalStripeMutations += 1;
            response = stripeSub({
              id: "sub_pack_promo_concurrent",
              serverId: server.id,
              userId: owner.id,
              status: "active",
              packQuantity: 2,
              itemQuantity: 2,
              pendingUpdate: true,
            });
            responsesByIdempotencyKey.set(idempotencyKey, response);
          }
          return response;
        },
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => params.preview_mode === "recurring"
          ? previewInvoice({ amountDue: 3_000 })
          : previewInvoice({ amountDue: 500, prorationAmount: 500 }),
      },
    } as unknown as Stripe);

    const preview = await previewProPackQuantityUpdate(server.id, owner.id, { seatQuantity: 3 });
    const [first, second] = await Promise.all([
      updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: preview.previewToken }),
      updateProPackQuantity(server.id, owner.id, { seatQuantity: 3, previewToken: preview.previewToken }),
    ]);

    assert.equal(first.status, "pending_payment");
    assert.equal(second.status, "pending_payment");
    assert.equal(updateIdempotencyKeys.length, 2);
    assert.equal(updateIdempotencyKeys[0], updateIdempotencyKeys[1]);
    assert.equal(updateIdempotencyKeys[0]?.includes(preview.previewToken), false);
    assert.equal(physicalStripeMutations, 1);
  } finally {
    restoreEnv(env);
  }
});

test("reducing existing Pro pack quantity down to occupied usage floor updates Stripe quantity without payment confirmation", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-reduce-owner");
    const server = await createServer("Pack Reduce", `pack-reduce-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_reduce",
      packQuantity: 6,
    });
    for (let i = 0; i < 30; i += 1) {
      await createAgent(server.id, `reduce-a${i}`, {
        creatorType: "user",
        creatorId: owner.id,
      });
    }
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_reduce",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_reduce",
          packQuantity: 6,
          itemQuantity: 6,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_reduce",
            packQuantity: 4,
            itemQuantity: 4,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 4 });
    assert.equal(result.status, "updated");
    assert.equal(result.effectiveAt, "current");
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0]?.id, "sub_pack_reduce");
    assert.deepEqual(updateCalls[0]?.params.items, [{ id: "si_pro_seat", quantity: 4 }]);
    assert.equal(updateCalls[0]?.params.payment_behavior, undefined);
    assert.equal(updateCalls[0]?.params.proration_behavior, "create_prorations");
    assert.equal((updateCalls[0]?.params.metadata as Record<string, string>).proPackQuantity, "4");

    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 4);
    assert.equal(entitlement.capacity.maxUniversalSeats, 4);
  } finally {
    restoreEnv(env);
  }
});

test("reducing existing Pro pack quantity below occupied usage is rejected before Stripe mutation", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-reduce-floor-owner");
    const server = await createServer("Pack Reduce Floor", `pack-reduce-floor-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_reduce_floor",
      packQuantity: 3,
    });
    for (let i = 0; i < 15; i += 1) {
      await createAgent(server.id, `floor-a${i}`, {
        creatorType: "user",
        creatorId: owner.id,
      });
    }

    let retrieveCalls = 0;
    let updateCalls = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCalls += 1;
          return stripeSub({
            id: "sub_pack_reduce_floor",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_reduce_floor",
            packQuantity: 3,
            itemQuantity: 3,
          });
        },
        update: async () => {
          updateCalls += 1;
          return stripeSub({
            id: "sub_pack_reduce_floor",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_reduce_floor",
            packQuantity: 1,
            itemQuantity: 1,
          });
        },
      },
    } as unknown as Stripe);

    await assert.rejects(
      () => updateProPackQuantity(server.id, owner.id, { packQuantity: 1 }),
      /seatQuantity must be at least 3 to cover current server usage/,
    );
    assert.equal(retrieveCalls, 0);
    assert.equal(updateCalls, 0);

    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 3);
    assert.equal(entitlement.capacity.maxUniversalSeats, 3);
  } finally {
    restoreEnv(env);
  }
});

test("annual Pro pack quantity update preserves annual Stripe price and projected interval", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-annual-owner");
    const server = await createServer("Pack Annual", `pack-annual-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_annual",
      packQuantity: 1,
      billingInterval: "annual",
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_annual",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_annual",
          packQuantity: 1,
          itemQuantity: 1,
          billingInterval: "annual",
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_annual",
            packQuantity: 2,
            itemQuantity: 2,
            billingInterval: "annual",
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 2 });
    assert.equal(result.status, "pending_webhook");
    assert.deepEqual(updateCalls[0]?.params.items, [{ id: "si_pro_seat", quantity: 2 }]);
    assert.equal((updateCalls[0]?.params.metadata as Record<string, string>).billingInterval, "annual");

    await handleWebhookEvent(makeEvent("evt_pack_annual", "customer.subscription.updated", stripeSub({
      id: "sub_pack_annual",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_pack_annual",
      packQuantity: 2,
      itemQuantity: 2,
      billingInterval: "annual",
    })));
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.billingInterval, "annual");
    assert.equal(sub.proPackQuantity, 2);
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.billingInterval, "annual");
    assert.equal(entitlement.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("pack quantity update reactivates cancel-scheduled subscription while adding seats", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-cancel-scheduled-owner");
    const server = await createServer("Pack Cancel Scheduled", `pack-cancel-scheduled-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_cancel_scheduled",
      packQuantity: 2,
      billingInterval: "annual",
      cancelAtPeriodEnd: true,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_cancel_scheduled",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_cancel_scheduled",
          packQuantity: 2,
          itemQuantity: 2,
          billingInterval: "annual",
          cancelAtPeriodEnd: true,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          const hasQuantityUpdate = params.items != null;
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_cancel_scheduled",
            packQuantity: hasQuantityUpdate ? 3 : 2,
            itemQuantity: hasQuantityUpdate ? 3 : 2,
            billingInterval: "annual",
            cancelAtPeriodEnd: false,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 3 });
    assert.equal(result.status, "pending_webhook");
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0]?.params.cancel_at_period_end, false);
    assert.equal(updateCalls[0]?.params.payment_behavior, undefined);
    assert.equal(updateCalls[0]?.params.items, undefined);
    assert.deepEqual(updateCalls[1]?.params.items, [{ id: "si_pro_seat", quantity: 3 }]);
    assert.equal(updateCalls[1]?.params.payment_behavior, "pending_if_incomplete");
    assert.equal(updateCalls[1]?.params.proration_behavior, "always_invoice");
    assert.equal(updateCalls[1]?.params.cancel_at_period_end, undefined);
    assert.equal((updateCalls[1]?.params.metadata as Record<string, string>).proPackQuantity, "3");

    await handleWebhookEvent(makeEvent("evt_pack_cancel_reactivated", "customer.subscription.updated", stripeSub({
      id: "sub_pack_cancel_scheduled",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_pack_cancel_scheduled",
      packQuantity: 3,
      itemQuantity: 3,
      billingInterval: "annual",
      cancelAtPeriodEnd: false,
    })));
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.proPackQuantity, 3);
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 3);
  } finally {
    restoreEnv(env);
  }
});

test("seat quantity update reactivates cancel-scheduled subscription before paid seat increase", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("seat-cancel-scheduled-owner");
    const server = await createServer("Seat Cancel Scheduled", `seat-cancel-scheduled-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_seat_cancel_scheduled",
      packQuantity: 6,
      billingInterval: "monthly",
      cancelAtPeriodEnd: true,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => proSeatStripeSub({
          id: "sub_seat_cancel_scheduled",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_seat_cancel_scheduled",
          seatQuantity: 6,
          itemQuantity: 6,
          billingInterval: "monthly",
          cancelAtPeriodEnd: true,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          const hasQuantityUpdate = params.items != null;
          return proSeatStripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_seat_cancel_scheduled",
            seatQuantity: hasQuantityUpdate ? 7 : 6,
            itemQuantity: hasQuantityUpdate ? 7 : 6,
            billingInterval: "monthly",
            cancelAtPeriodEnd: false,
            requestedHumans: hasQuantityUpdate ? 7 : 6,
            requestedAgents: 0,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, {
      humanSeatQuantity: 7,
      agentSeatQuantity: 0,
    });
    assert.equal(result.status, "pending_webhook");
    assert.equal(updateCalls.length, 2);
    assert.equal(updateCalls[0]?.params.cancel_at_period_end, false);
    assert.equal(updateCalls[0]?.params.payment_behavior, undefined);
    assert.equal(updateCalls[0]?.params.items, undefined);
    assert.deepEqual(updateCalls[1]?.params.items, [{ id: "si_pro_seat", quantity: 7 }]);
    assert.equal(updateCalls[1]?.params.payment_behavior, "pending_if_incomplete");
    assert.equal(updateCalls[1]?.params.proration_behavior, "always_invoice");
    assert.equal(updateCalls[1]?.params.cancel_at_period_end, undefined);
    const metadata = updateCalls[1]?.params.metadata as Record<string, string>;
    assert.equal(metadata.pricingContract, "raft-pro-seat-v1");
    assert.equal(metadata.seatQuantity, "7");
    assert.equal(metadata.humanSeatQuantity, "7");
    assert.equal(metadata.requestedAgentSeats, "0");

    const beforeWebhook = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(beforeWebhook.proPackQuantity, 6);
    assert.equal(beforeWebhook.capacity.maxUniversalSeats, 6);

    await handleWebhookEvent(makeEvent("evt_seat_cancel_reactivated", "customer.subscription.updated", proSeatStripeSub({
      id: "sub_seat_cancel_scheduled",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_seat_cancel_scheduled",
      seatQuantity: 7,
      itemQuantity: 7,
      billingInterval: "monthly",
      cancelAtPeriodEnd: false,
    })));
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.proPackQuantity, 7);
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 7);
    assert.equal(entitlement.capacity.maxUniversalSeats, 7);
  } finally {
    restoreEnv(env);
  }
});

test("unchanged pack quantity reactivates cancel-scheduled subscription", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-reactivate-owner");
    const server = await createServer("Pack Reactivate", `pack-reactivate-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_reactivate",
      packQuantity: 2,
      cancelAtPeriodEnd: true,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_reactivate",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_reactivate",
          packQuantity: 2,
          itemQuantity: 2,
          cancelAtPeriodEnd: true,
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_reactivate",
            packQuantity: 2,
            itemQuantity: 2,
            cancelAtPeriodEnd: false,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 2 });
    assert.equal(result.status, "reactivated");
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0]?.params.cancel_at_period_end, false);
    assert.equal(typeof (updateCalls[0]?.params.metadata as Record<string, string>).reactivatedAt, "string");
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.cancelAtPeriodEnd, false);
    assert.equal(sub.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("same Stripe customer can reactivate one server without changing another server subscription", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-cross-server-owner");
    const serverA = await createServer("Pack Cross Server A", `pack-cross-server-a-${randomUUID()}`, owner.id);
    const serverB = await createServer("Pack Cross Server B", `pack-cross-server-b-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: serverA.id,
      userId: owner.id,
      subscriptionId: "sub_pack_cross_a",
      customerId: "cus_shared_pack_cross",
      packQuantity: 1,
      cancelAtPeriodEnd: true,
    });
    await seedLocalProSubscription({
      serverId: serverB.id,
      userId: owner.id,
      subscriptionId: "sub_pack_cross_b",
      customerId: "cus_shared_pack_cross",
      packQuantity: 2,
      cancelAtPeriodEnd: false,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async (id: string) => {
          if (id === "sub_pack_cross_a") {
            return stripeSub({
              id,
              serverId: serverA.id,
              userId: owner.id,
              status: "active",
              customer: "cus_shared_pack_cross",
              packQuantity: 1,
              itemQuantity: 1,
              cancelAtPeriodEnd: true,
            });
          }
          return stripeSub({
            id,
            serverId: serverB.id,
            userId: owner.id,
            status: "active",
            customer: "cus_shared_pack_cross",
            packQuantity: 2,
            itemQuantity: 2,
            cancelAtPeriodEnd: false,
          });
        },
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          assert.equal(id, "sub_pack_cross_a");
          return stripeSub({
            id,
            serverId: serverA.id,
            userId: owner.id,
            status: "active",
            customer: "cus_shared_pack_cross",
            packQuantity: 1,
            itemQuantity: 1,
            cancelAtPeriodEnd: false,
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(serverA.id, owner.id, { packQuantity: 1 });
    assert.equal(result.status, "reactivated");
    assert.deepEqual(updateCalls.map((call) => call.id), ["sub_pack_cross_a"]);
    const [subA] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, serverA.id));
    const [subB] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, serverB.id));
    assert.equal(subA.cancelAtPeriodEnd, false);
    assert.equal(subA.proPackQuantity, 1);
    assert.equal(subB.cancelAtPeriodEnd, false);
    assert.equal(subB.proPackQuantity, 2);
    assert.equal(subB.stripeSubscriptionId, "sub_pack_cross_b");
  } finally {
    restoreEnv(env);
  }
});

test("pending payment pack increase does not grant additional entitlement", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-pending-owner");
    const server = await createServer("Pack Pending", `pack-pending-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_pending",
      packQuantity: 1,
    });
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_pending",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_pending",
          packQuantity: 1,
          itemQuantity: 1,
        }),
        update: async (id: string) => stripeSub({
          id,
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_pending",
          packQuantity: 1,
          itemQuantity: 1,
          pendingUpdate: true,
        }),
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 2 });
    assert.equal(result.status, "pending_payment");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 1);
    assert.equal(entitlement.capacity.maxUniversalSeats, 1);
  } finally {
    restoreEnv(env);
  }
});

test("decreasing existing Pro pack quantity can reduce capacity without schedule mutation", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-decrease-owner");
    const server = await createServer("Pack Decrease", `pack-decrease-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_decrease",
      packQuantity: 3,
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_pack_decrease",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_pack_decrease",
          packQuantity: 3,
          itemQuantity: 3,
          schedule: "sched_pack_decrease",
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_pack_decrease",
            packQuantity: 2,
            itemQuantity: 2,
            schedule: "sched_pack_decrease",
          });
        },
      },
    } as unknown as Stripe);

    const result = await updateProPackQuantity(server.id, owner.id, { packQuantity: 2 });
    assert.equal(result.status, "updated");
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0]?.params.items, [{ id: "si_pro_seat", quantity: 2 }]);
    assert.equal(updateCalls[0]?.params.payment_behavior, undefined);
    assert.equal(updateCalls[0]?.params.proration_behavior, "create_prorations");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 2);
    assert.equal(entitlement.capacity.maxUniversalSeats, 2);
  } finally {
    restoreEnv(env);
  }
});

test("billing summary refresh reconciles missed subscription update webhook", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("summary-refresh-owner");
    const server = await createServer("Summary Refresh", `summary-refresh-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_summary_refresh",
      packQuantity: 1,
      billingInterval: "annual",
    });
    let retrieveCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          return stripeSub({
            id: "sub_summary_refresh",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_summary_refresh",
            packQuantity: 3,
            itemQuantity: 3,
            billingInterval: "annual",
          });
        },
      },
    } as unknown as Stripe);

    const { result: summary, events } = await captureBillingTrace(() => getBillingSummary(server.id));
    assert.ok(retrieveCount >= 1);
    assert.equal(summary.provisioned.proPackQuantity, 3);
    assert.equal(summary.price?.seatQuantity, 3);
    assert.equal(summary.capacity.maxUniversalSeats, 3);
    assert.equal(summary.subscription?.billingInterval, "annual");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.billingInterval, "annual");
    assert.equal(entitlement.proPackQuantity, 3);
    assert.equal(traceEvent(events, "billing.summary.requested").attrs?.server_id, server.id);
    assert.equal(traceEvent(events, "billing.subscription_refresh.started").attrs?.server_id, server.id);
    const projectionTrace = traceEvent(events, "billing.subscription_projection.synced");
    assert.equal(projectionTrace.attrs?.seat_quantity, 3);
    assert.equal(projectionTrace.attrs?.billing_interval, "annual");
    assert.equal(traceEvent(events, "billing.summary.ready").attrs?.seat_quantity, 3);
  } finally {
    restoreEnv(env);
  }
});

test("agent capacity gate passively refreshes missed active subscription update webhook", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("passive-refresh-owner");
    const server = await createServer("Passive Refresh", `passive-refresh-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_passive_refresh",
      packQuantity: 2,
      billingInterval: "annual",
      cancelAtPeriodEnd: false,
    });
    await getDb().update(subscriptions).set({
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    }).where(eq(subscriptions.serverId, server.id));

    let retrieveCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => {
          retrieveCount += 1;
          return stripeSub({
            id: "sub_passive_refresh",
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_passive_refresh",
            packQuantity: 2,
            itemQuantity: 2,
            billingInterval: "annual",
            cancelAtPeriodEnd: true,
          });
        },
      },
    } as unknown as Stripe);

    await createAgent(server.id, "passive-refresh-agent", { runtime: "codex" });

    assert.equal(retrieveCount, 1);
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.cancelAtPeriodEnd, true);
    assert.equal(sub.status, "active");
    assert.equal(sub.currentPeriodEnd?.toISOString(), "2023-12-14T22:13:20.000Z");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.plan, "pro");
    assert.equal(entitlement.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("canceling Pro subscription schedules whole subscription cancellation at period end", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("cancel-pro-owner");
    const server = await createServer("Cancel Pro", `cancel-pro-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_cancel_pro",
      packQuantity: 2,
      billingInterval: "annual",
    });
    const updateCalls: Array<{ id: string; params: Record<string, unknown> }> = [];
    __setStripeForTests({
      subscriptions: {
        retrieve: async (id: string) => stripeSub({
          id,
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_cancel_pro",
          packQuantity: 2,
          itemQuantity: 2,
          billingInterval: "annual",
        }),
        update: async (id: string, params: Record<string, unknown>) => {
          updateCalls.push({ id, params });
          return stripeSub({
            id,
            serverId: server.id,
            userId: owner.id,
            status: "active",
            customer: "cus_cancel_pro",
            packQuantity: 2,
            itemQuantity: 2,
            billingInterval: "annual",
            cancelAtPeriodEnd: true,
          });
        },
      },
    } as unknown as Stripe);

    const result = await cancelSubscriptionAtPeriodEnd(server.id, owner.id);
    assert.equal(result.status, "scheduled_period_end");
    assert.equal(updateCalls.length, 1);
    assert.deepEqual(updateCalls[0]?.params.cancel_at_period_end, true);
    assert.equal(typeof (updateCalls[0]?.params.metadata as Record<string, string>).cancelRequestedAt, "string");
    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.cancelAtPeriodEnd, true);
    assert.equal(sub.status, "active");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("Stripe Dashboard period-end cancellation webhook syncs subscription cancellation state", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("dashboard-cancel-owner");
    const server = await createServer("Dashboard Cancel Pro", `dashboard-cancel-pro-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_dashboard_cancel",
      packQuantity: 2,
      billingInterval: "annual",
      cancelAtPeriodEnd: false,
    });

    await handleWebhookEvent(makeEvent("evt_dashboard_cancel", "customer.subscription.updated", stripeSub({
      id: "sub_dashboard_cancel",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_dashboard_cancel",
      packQuantity: 2,
      itemQuantity: 2,
      billingInterval: "annual",
      cancelAtPeriodEnd: true,
    })));

    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_dashboard_cancel",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_dashboard_cancel",
          packQuantity: 2,
          itemQuantity: 2,
          billingInterval: "annual",
          cancelAtPeriodEnd: true,
        }),
      },
    } as unknown as Stripe);

    const summary = await getBillingSummary(server.id);
    assert.equal(summary.subscription?.cancelAtPeriodEnd, true);
    assert.equal(summary.subscription?.status, "active");
    assert.equal(summary.plan, "pro");
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.plan, "pro");
    assert.equal(entitlement.proPackQuantity, 2);
  } finally {
    restoreEnv(env);
  }
});

test("Stripe Portal cancellation scheduled by cancel_at syncs subscription cancellation state", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("portal-cancel-owner");
    const server = await createServer("Portal Cancel Pro", `portal-cancel-pro-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_portal_cancel",
      packQuantity: 1,
      billingInterval: "annual",
      cancelAtPeriodEnd: false,
    });

    const portalPeriodEnd = 1_812_384_000;
    await handleWebhookEvent(makeEvent("evt_portal_cancel", "customer.subscription.updated", stripeSub({
      id: "sub_portal_cancel",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_portal_cancel",
      packQuantity: 1,
      itemQuantity: 1,
      billingInterval: "annual",
      cancelAtPeriodEnd: false,
      cancelAt: portalPeriodEnd,
    })));

    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub({
          id: "sub_portal_cancel",
          serverId: server.id,
          userId: owner.id,
          status: "active",
          customer: "cus_portal_cancel",
          packQuantity: 1,
          itemQuantity: 1,
          billingInterval: "annual",
          cancelAtPeriodEnd: false,
          cancelAt: portalPeriodEnd,
        }),
      },
    } as unknown as Stripe);

    const summary = await getBillingSummary(server.id);
    assert.equal(summary.subscription?.cancelAtPeriodEnd, true);
    assert.equal(summary.subscription?.status, "active");
    assert.equal(summary.plan, "pro");
  } finally {
    restoreEnv(env);
  }
});

test("webhook projection trusts Stripe item quantity over stale higher metadata", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("pack-stale-metadata-owner");
    const server = await createServer("Pack Stale Metadata", `pack-stale-metadata-${randomUUID()}`, owner.id);
    await seedLocalProSubscription({
      serverId: server.id,
      userId: owner.id,
      subscriptionId: "sub_pack_stale_metadata",
      packQuantity: 3,
    });

    await handleWebhookEvent(makeEvent("evt_pack_stale_metadata", "customer.subscription.updated", stripeSub({
      id: "sub_pack_stale_metadata",
      serverId: server.id,
      userId: owner.id,
      status: "active",
      customer: "cus_pack_stale_metadata",
      packQuantity: 3,
      itemQuantity: 2,
    })));

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.proPackQuantity, 2);
    assert.equal(sub.provisionedHumanSeats, 2);
    assert.equal(sub.provisionedAgentSeats, 20);
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.proPackQuantity, 2);
    assert.equal(entitlement.capacity.maxUniversalSeats, 2);
  } finally {
    restoreEnv(env);
  }
});

test("non-live subscription webhook records projection but does not grant Pro entitlement", async () => {
  const env = snapshotEnv();
  configureStripeEnv();
  await openTestDatabase("pglite://");
  try {
    const owner = await seedUser("webhook-incomplete-owner");
    const server = await createServer("Webhook Incomplete", `webhook-incomplete-${randomUUID()}`, owner.id);
    await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    await handleWebhookEvent(makeEvent("evt_incomplete_pro", "customer.subscription.updated", stripeSub({
      id: "sub_incomplete",
      serverId: server.id,
      userId: owner.id,
      status: "incomplete",
      customer: "cus_incomplete",
      packQuantity: 2,
    })));

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.status, "incomplete");
    assert.equal(sub.proPackQuantity, 2);
    const entitlement = await getServerBillingEntitlement(getDb(), server.id);
    assert.equal(entitlement.plan, "free");
    await assert.rejects(
      () => requireTeamBillingFeature(getDb(), server.id, "Joint channels", AFTER_FULL_FEATURE_TRIAL),
      /Joint channels requires the Pro plan/,
    );
  } finally {
    restoreEnv(env);
  }
});
