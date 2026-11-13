import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type Stripe from "stripe";
import { getEffectiveLimits, TRIAL_START_DATE } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { isBillingPreviewPath } from "./billing";
import { getDb } from "../db/index";
import { servers as serversTable, subscriptions, users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { __resetStripeForTests, __setStripeForTests } from "../services/billingService";
import { PRODUCT_EVENT_SINK_APP_KEY } from "../services/productEventIngest";
import type { ProductEventRow, ProductEventSink } from "../services/productEventScopeDbWriter";
import { eq } from "drizzle-orm";

import { __setAgentHistoryBlockStoreForTests } from "../services/agentHistoryBlocks";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const BILLING_ENV_KEYS = [
  "STRIPE_BILLING_ENABLED",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
] as const;

function snapshotBillingEnv() {
  return Object.fromEntries(BILLING_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<typeof BILLING_ENV_KEYS[number], string | undefined>;
}

function restoreBillingEnv(snapshot: Record<typeof BILLING_ENV_KEYS[number], string | undefined>) {
  for (const key of BILLING_ENV_KEYS) {
    if (snapshot[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function configureBillingEnv() {
  process.env.STRIPE_BILLING_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_permission_matrix";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_permission_matrix";
  process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
}

async function seedVerifiedUser(email: string, name = email.split("@")[0]) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

test("billing summary is owner/admin readable and owner-only mutable", async ({ app }) => {

  const billingEnv = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const owner = await seedVerifiedUser("billing-owner@slock.test");
    const admin = await seedVerifiedUser("billing-admin@slock.test");
    const member = await seedVerifiedUser("billing-member@slock.test");
    const server = await createServer("Billing Permissions", `billing-permissions-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, member.id, "member");

    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const memberToken = await tokenForHuman(member.email);

    const ownerSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(ownerSummary.status, 200);
    const ownerBody = await ownerSummary.json() as {
      plan: string;
      displayName: string;
      capacity: { maxAgents: number };
      usage: { humans: number; agents: number; universalSeats: number };
      permissions: { canReadBillingSummary: boolean; canManageBilling: boolean };
      stripeConfigured: boolean;
    };
    assert.equal(ownerBody.plan, "free");
    assert.equal(ownerBody.displayName, "Free");
    assert.equal(ownerBody.capacity.maxAgents, getEffectiveLimits("free").maxAgents);
    assert.deepEqual(ownerBody.usage, { humans: 3, agents: 0, universalSeats: 3 });
    assert.equal("activeUsage28d" in ownerBody, false);
    assert.deepEqual(ownerBody.permissions, { canReadBillingSummary: true, canManageBilling: true });
    assert.equal(ownerBody.stripeConfigured, true);

    await getDb().update(serversTable).set({ plan: "partner" }).where(eq(serversTable.id, server.id));
    await getDb().insert(subscriptions).values({
      serverId: server.id,
      stripeCustomerId: "cus_partner_shadow",
      stripeSubscriptionId: "sub_partner_shadow",
      stripeProPackItemId: "si_partner_shadow",
      status: "active",
      provisionedHumanSeats: 1,
      provisionedAgentSeats: 10,
      proPackQuantity: 1,
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      createdByUserId: owner.id,
    });
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => ({
          id: "sub_partner_shadow",
          customer: "cus_partner_shadow",
          status: "active",
          cancel_at_period_end: false,
          pending_update: null,
          schedule: null,
          metadata: {
            serverId: server.id,
            userId: owner.id,
            pricingContract: "raft-pro-seat-v1",
            targetPlan: "pro",
            seatQuantity: "1",
            proPackQuantity: "1",
            trialFreePackQuantity: "0",
          },
          items: {
            data: [
              {
                id: "si_partner_shadow",
                quantity: 1,
                current_period_start: 1_717_200_000,
                current_period_end: 1_719_878_400,
                price: { id: "price_pro_seat" },
              },
            ],
          },
        }),
      },
    } as unknown as Stripe);
    const partnerSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(partnerSummary.status, 200);
    const partnerBody = await partnerSummary.json() as {
      plan: string;
      displayName: string;
      source: string;
      capacity: { maxHumans: number; maxAgents: number; maxUniversalSeats: number };
      price: null | unknown;
      subscription: null | unknown;
      fileUploadQuota: { plan: string; limited: boolean; enforced: boolean; limitBytes: number };
      permissions: { canReadBillingSummary: boolean; canManageBilling: boolean };
    };
    assert.equal(partnerBody.plan, "partner");
    assert.equal(partnerBody.displayName, "Partner");
    assert.equal(partnerBody.source, "server");
    assert.deepEqual(partnerBody.capacity, { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 });
    assert.equal(partnerBody.price, null);
    assert.equal(partnerBody.subscription, null);
    assert.equal(partnerBody.fileUploadQuota.plan, "partner");
    assert.equal(partnerBody.fileUploadQuota.limited, false);
    assert.equal(partnerBody.fileUploadQuota.enforced, false);
    assert.equal(partnerBody.fileUploadQuota.limitBytes, -1);
    assert.deepEqual(partnerBody.permissions, { canReadBillingSummary: true, canManageBilling: true });

    const adminSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(adminToken, server.id),
    });
    assert.equal(adminSummary.status, 200);
    const adminBody = await adminSummary.json() as { permissions: { canReadBillingSummary: boolean; canManageBilling: boolean } };
    assert.deepEqual(adminBody.permissions, { canReadBillingSummary: true, canManageBilling: false });

    const memberSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(memberToken, server.id),
    });
    assert.equal(memberSummary.status, 403);

    const adminCheckout = await fetch(`${app.baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({
        successUrl: "http://127.0.0.1:4173/billing/success",
        cancelUrl: "http://127.0.0.1:4173/billing/cancel",
      }),
    });
    assert.equal(adminCheckout.status, 403);
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(billingEnv);
    await app.close();
  }
});

test("billing Pro seat quantity update is owner-only and does not grant capacity before webhook", async ({ app }) => {

  const billingEnv = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const owner = await seedVerifiedUser("billing-pack-owner@slock.test");
    // Not sharing, explicitly (independent of the default): the seat update
    // still counts toward the workspace, without the owner's analytics id.
    await getDb().update(users).set({ shareUsageData: false }).where(eq(users.id, owner.id));
    const admin = await seedVerifiedUser("billing-pack-admin@slock.test");
    const member = await seedVerifiedUser("billing-pack-member@slock.test");
    const server = await createServer("Billing Pack Permissions", `billing-pack-permissions-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await addMember(server.id, member.id, "member");
    await getDb().insert(subscriptions).values({
      serverId: server.id,
      stripeCustomerId: "cus_pack_route",
      stripeSubscriptionId: "sub_pack_route",
      stripeProPackItemId: "si_pro_seat",
      status: "active",
      provisionedHumanSeats: 1,
      provisionedAgentSeats: 10,
      proPackQuantity: 1,
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      createdByUserId: owner.id,
    });
    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, server.id));

    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const memberToken = await tokenForHuman(member.email);
    const productRows: ProductEventRow[] = [];
    const productSink: ProductEventSink = { enqueue: (rows) => { productRows.push(...rows); }, flush: async () => {} };
    app.app.set(PRODUCT_EVENT_SINK_APP_KEY, productSink);
    let updateCount = 0;
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => ({
          id: "sub_pack_route",
          customer: "cus_pack_route",
          status: "active",
          cancel_at_period_end: false,
          pending_update: null,
          schedule: null,
          metadata: {
            serverId: server.id,
            userId: owner.id,
            pricingContract: "raft-pro-seat-v1",
            targetPlan: "pro",
            seatQuantity: "1",
            proPackQuantity: "1",
            trialFreePackQuantity: "0",
          },
          items: {
            data: [
              {
                id: "si_pro_seat",
                quantity: 1,
                current_period_start: 1_700_000_000,
                current_period_end: 1_702_592_000,
                price: { id: "price_pro_seat" },
              },
            ],
          },
        }),
        update: async (_id: string, params: Record<string, unknown>) => {
          updateCount += 1;
          assert.deepEqual(params.items, [{ id: "si_pro_seat", quantity: 4 }]);
          assert.equal((params.metadata as Record<string, string>).proPackQuantity, "4");
          return {
            id: "sub_pack_route",
            customer: "cus_pack_route",
            status: "active",
            cancel_at_period_end: false,
            pending_update: null,
            schedule: null,
            metadata: {
              serverId: server.id,
              userId: owner.id,
              pricingContract: "raft-pro-seat-v1",
              targetPlan: "pro",
              seatQuantity: "4",
              proPackQuantity: "4",
              trialFreePackQuantity: "0",
            },
            items: {
              data: [
                {
                  id: "si_pro_seat",
                  quantity: 4,
                  current_period_start: 1_700_000_000,
                  current_period_end: 1_702_592_000,
                  price: { id: "price_pro_seat" },
                },
              ],
            },
          };
        },
      },
      invoices: {
        createPreview: async (params: Record<string, unknown>) => ({
          amount_due: params.preview_mode === "recurring" ? 4_000 : 1_000,
          total: params.preview_mode === "recurring" ? 4_000 : 1_000,
          currency: "usd",
          total_discount_amounts: [],
          lines: {
            data: params.preview_mode === "recurring"
              ? []
              : [{
                  amount: 1_000,
                  taxes: [],
                  parent: { type: "subscription_item_details", subscription_item_details: { proration: true } },
                }],
          },
        }),
      },
    } as unknown as Stripe);

    const adminPreview = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity/preview`, {
      method: "POST",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({ packQuantity: 4 }),
    });
    assert.equal(adminPreview.status, 403);

    const ownerPreview = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity/preview`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ packQuantity: 4 }),
    });
    assert.equal(ownerPreview.status, 200);
    const ownerPreviewBody = await ownerPreview.json() as {
      status: string;
      prorationAmount: number;
      recurringAmount: number;
      previewToken: string;
    };
    assert.equal(ownerPreviewBody.status, "preview");
    assert.equal(ownerPreviewBody.prorationAmount, 1_000);
    assert.equal(ownerPreviewBody.recurringAmount, 4_000);
    assert.ok(ownerPreviewBody.previewToken.length > 32);

    const memberUpdate = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity`, {
      method: "POST",
      headers: headers(memberToken, server.id),
      body: JSON.stringify({ packQuantity: 2 }),
    });
    assert.equal(memberUpdate.status, 403);

    const ownerBelowFloorUpdate = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ packQuantity: 2 }),
    });
    assert.equal(ownerBelowFloorUpdate.status, 400);
    const ownerBelowFloorBody = await ownerBelowFloorUpdate.json() as { error: string };
    assert.match(ownerBelowFloorBody.error, /seatQuantity must be at least 3 to cover current server usage/);
    assert.equal(updateCount, 0);

    const ownerUpdate = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ packQuantity: 4, entry: "seat_limit_agent_create" }),
    });
    assert.equal(ownerUpdate.status, 200);
    const ownerBody = await ownerUpdate.json() as { status: string };
    assert.equal(ownerBody.status, "pending_webhook");
    assert.equal(updateCount, 1);

    // billing_seats_updated (xxchan via Till, 2026-10-20): only the update
    // Stripe accepted, with where the owner came from. The owner does not
    // share usage data, so the row counts toward the server only.
    for (let i = 0; i < 50 && productRows.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(productRows.map((row) => ({
      event: row.event,
      source: row.source,
      analytics_id: row.analytics_id,
      server_id: row.server_id,
      properties: row.properties,
    })), [{
      event: "billing_seats_updated",
      source: "server",
      analytics_id: null,
      server_id: server.id,
      properties: { entry: "seat_limit_agent_create", previous_seat_quantity: 1, seat_quantity: 4, result: "pending_webhook" },
    }]);

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.proPackQuantity, 1);
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(billingEnv);
    await app.close();
  }
});

test("Plan & Billing's owner actions record theirs: a scheduled cancellation, Keep Pro withdrawing it, the billing portal", async ({ app }) => {

  const billingEnv = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const owner = await seedVerifiedUser("billing-cancel-owner@slock.test");
    const admin = await seedVerifiedUser("billing-cancel-admin@slock.test");
    const server = await createServer("Billing Cancel Events", `billing-cancel-events-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    await getDb().insert(subscriptions).values({
      serverId: server.id,
      stripeCustomerId: "cus_cancel_route",
      stripeSubscriptionId: "sub_cancel_route",
      stripeProPackItemId: "si_pro_seat",
      status: "active",
      provisionedHumanSeats: 3,
      provisionedAgentSeats: 30,
      proPackQuantity: 3,
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      createdByUserId: owner.id,
    });
    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, server.id));

    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const productRows: ProductEventRow[] = [];
    const productSink: ProductEventSink = { enqueue: (rows) => { productRows.push(...rows); }, flush: async () => {} };
    app.app.set(PRODUCT_EVENT_SINK_APP_KEY, productSink);
    // Five billing writes a minute: one refused admin request, then the owner's four.
    let cancelAtPeriodEnd = false;
    const stripeSub = () => ({
      id: "sub_cancel_route",
      customer: "cus_cancel_route",
      status: "active",
      cancel_at_period_end: cancelAtPeriodEnd,
      pending_update: null,
      schedule: null,
      metadata: {
        serverId: server.id,
        userId: owner.id,
        pricingContract: "raft-pro-seat-v1",
        targetPlan: "pro",
        seatQuantity: "3",
        proPackQuantity: "3",
        trialFreePackQuantity: "0",
      },
      items: {
        data: [{
          id: "si_pro_seat",
          quantity: 3,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: "price_pro_seat_annual" },
        }],
      },
    });
    __setStripeForTests({
      subscriptions: {
        retrieve: async () => stripeSub(),
        update: async (_id: string, params: Record<string, unknown>) => {
          assert.equal(typeof params.cancel_at_period_end, "boolean");
          cancelAtPeriodEnd = params.cancel_at_period_end as boolean;
          return stripeSub();
        },
      },
      billingPortal: {
        sessions: { create: async () => ({ url: "https://billing.stripe.com/p/session_test" }) },
      },
    } as unknown as Stripe);
    const events = async (count: number) => {
      for (let i = 0; i < 50 && productRows.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      return productRows.map((row) => ({ event: row.event, source: row.source, server_id: row.server_id, properties: row.properties }));
    };
    const post = (path: string, token: string, body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/billing/${path}`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify(body),
    });

    assert.equal((await post("cancel", adminToken, { entry: "settings" })).status, 403);
    const cancel = await post("cancel", ownerToken, { entry: "settings" });
    assert.equal(cancel.status, 200);
    // The event's fields stay off the response.
    assert.deepEqual(Object.keys(await cancel.json() as object).sort(), ["currentPeriodEnd", "status"]);
    assert.deepEqual(await events(1), [{
      event: "billing_cancellation_scheduled",
      source: "server",
      server_id: server.id,
      properties: { entry: "settings", seat_quantity: 3, billing_interval: "annual" },
    }]);

    // Keep Pro: the same seats, so only the withdrawal (no billing_seats_updated).
    const keep = await post("seat-pack-quantity", ownerToken, { seatQuantity: 3, entry: "seat_limit_invite" });
    assert.equal(keep.status, 200);
    const keepBody = await keep.json() as Record<string, unknown>;
    assert.equal(keepBody.status, "reactivated");
    assert.equal("cancellationWithdrawn" in keepBody, false);
    assert.equal(cancelAtPeriodEnd, false);
    assert.deepEqual((await events(2)).slice(1), [{
      event: "billing_cancellation_withdrawn",
      source: "server",
      server_id: server.id,
      properties: { entry: "seat_limit_invite", seat_quantity: 3, billing_interval: "annual" },
    }]);

    const returnUrl = "http://127.0.0.1:4173/settings/billing";
    assert.equal((await post("portal", ownerToken, { returnUrl, entry: "settings", from: "past_due_banner" })).status, 200);
    // An older client says neither.
    assert.equal((await post("portal", ownerToken, { returnUrl })).status, 200);
    assert.deepEqual((await events(4)).slice(2).map((row) => ({ event: row.event, properties: row.properties })), [
      { event: "billing_portal_opened", properties: { entry: "settings", from: "past_due_banner" } },
      { event: "billing_portal_opened", properties: { entry: "unknown", from: "unknown" } },
    ]);
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(billingEnv);
    await app.close();
  }
});

test("seat price previews don't spend the billing writes' budget of 5 a minute", async ({ app }) => {
  const owner = await seedVerifiedUser(`billing-preview-limit-${randomUUID()}@slock.test`);
  const server = await createServer("Billing Preview Limit", `billing-preview-limit-${randomUUID()}`, owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  // An owner nudging the add-seats dialog's count: more previews than the writes' limit.
  for (let i = 0; i < 7; i += 1) {
    const preview = await fetch(`${app.baseUrl}/api/billing/seat-pack-quantity/preview`, {
      method: "POST",
      headers: { ...headers(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ seatQuantity: 2 + i }),
    });
    assert.notEqual(preview.status, 429, `preview ${i + 1} was rate limited`);
  }
});

test("seat price previews get their own rate limit, apart from billing mutations", () => {
  assert.equal(isBillingPreviewPath("/seat-pack-quantity/preview"), true);
  assert.equal(isBillingPreviewPath("/pack-quantity/preview"), true);
  assert.equal(isBillingPreviewPath("/seat-pack-quantity"), false);
  assert.equal(isBillingPreviewPath("/checkout"), false);
  assert.equal(isBillingPreviewPath("/seat-pack-quantity/preview/extra"), false);
});

test("billing requires explicit Stripe billing flag plus all required env", async ({ app }) => {

  const billingEnv = snapshotBillingEnv();
  try {
    const owner = await seedVerifiedUser("billing-disabled-owner@slock.test");
    const server = await createServer("Billing Disabled", `billing-disabled-${randomUUID()}`, owner.id);
    const ownerToken = await tokenForHuman(owner.email);

    process.env.STRIPE_SECRET_KEY = "sk_test_disabled";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_disabled";
    process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID = "price_pro_seat";
    process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_pro_seat_annual";
    delete process.env.STRIPE_BILLING_ENABLED;

    const disabledSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(disabledSummary.status, 200);
    const disabledBody = await disabledSummary.json() as { stripeConfigured: boolean };
    assert.equal(disabledBody.stripeConfigured, false);

    const disabledCheckout = await fetch(`${app.baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        targetPlan: "pro",
        successUrl: "http://127.0.0.1:4173/billing/success",
        cancelUrl: "http://127.0.0.1:4173/billing/cancel",
      }),
    });
    assert.equal(disabledCheckout.status, 503);

    const disabledPortal = await fetch(`${app.baseUrl}/api/billing/portal`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ returnUrl: "http://127.0.0.1:4173/billing" }),
    });
    assert.equal(disabledPortal.status, 503);

    const disabledWebhook = await fetch(`${app.baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "invalid-signature",
      },
      body: "{}",
    });
    assert.equal(disabledWebhook.status, 503);

    process.env.STRIPE_BILLING_ENABLED = "false";
    const falseFlagCheckout = await fetch(`${app.baseUrl}/api/billing/checkout`, {
      method: "POST",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({
        targetPlan: "pro",
        successUrl: "http://127.0.0.1:4173/billing/success",
        cancelUrl: "http://127.0.0.1:4173/billing/cancel",
      }),
    });
    assert.equal(falseFlagCheckout.status, 503);

    configureBillingEnv();
    const enabledSummary = await fetch(`${app.baseUrl}/api/billing/subscription`, {
      headers: headers(ownerToken, server.id),
    });
    assert.equal(enabledSummary.status, 200);
    const enabledBody = await enabledSummary.json() as { stripeConfigured: boolean };
    assert.equal(enabledBody.stripeConfigured, true);

    const enabledWebhookInvalidSignature = await fetch(`${app.baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "invalid-signature",
      },
      body: "{}",
    });
    assert.equal(enabledWebhookInvalidSignature.status, 400);
  } finally {
    restoreBillingEnv(billingEnv);
    await app.close();
  }
});

test("joint channel creation allows Free during full-featured trial and Pro after upgrade", async () => {
  // Pin the app clock to a trial-active instant (just after TRIAL_START_DATE)
  // so the Free-during-trial joint-create gate is exercised deterministically
  // rather than depending on the ambient real clock vs TRIAL_END_DATE. The host
  // server stays on the default `free` plan — clock injection (not founder-pin)
  // is required here so the "Free allowed during trial" semantic is genuinely
  // tested and not masked by a full-featured plan.
  const trialActiveClock = { now: () => new Date(TRIAL_START_DATE.getTime() + 60_000) };
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, clock: trialActiveClock });
  try {
    const hostOwner = await seedVerifiedUser("billing-joint-host@slock.test", "billing-joint-host");
    const targetOwner = await seedVerifiedUser("billing-joint-target@slock.test", "billing-joint-target");
    const hostServer = await createServer("Billing Joint Host", `billing-joint-host-${randomUUID()}`, hostOwner.id);
    const targetServer = await createServer("Billing Joint Target", `billing-joint-target-${randomUUID()}`, targetOwner.id);
    const hostToken = await tokenForHuman(hostOwner.email);

    const originalConsoleLog = console.log;
    console.log = () => {};
    let trialAllowed: Response;
    try {
      trialAllowed = await fetch(`${app.baseUrl}/api/channels`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({
          name: "trial-allowed-joint",
          visibility: "joint",
          targetServerSlug: targetServer.slug,
          invitedPeople: [targetOwner.email],
        }),
      });
    } finally {
      console.log = originalConsoleLog;
    }
    assert.equal(trialAllowed.status, 200);

    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, hostServer.id));

    console.log = () => {};
    let allowed: Response;
    try {
      allowed = await fetch(`${app.baseUrl}/api/channels`, {
        method: "POST",
        headers: headers(hostToken, hostServer.id),
        body: JSON.stringify({
          name: "allowed-joint",
          visibility: "joint",
          targetServerSlug: targetServer.slug,
          invitedPeople: [targetOwner.email],
        }),
      });
    } finally {
      console.log = originalConsoleLog;
    }
    assert.equal(allowed.status, 200);
  } finally {
    await app.close();
  }
});

test("retired referral preview is absent and legacy codes are rejected before Checkout creation", async ({ app }) => {
  const billingEnv = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const owner = await seedVerifiedUser("retired-preview-owner@slock.test");
    const server = await createServer("Retired preview", `retired-preview-${randomUUID()}`, owner.id);
    const token = await tokenForHuman(owner.email);
    let creates = 0;
    __setStripeForTests({ checkout: { sessions: { create: async () => {
      creates += 1;
      return { url: "https://checkout.stripe.test/session" };
    } } } } as unknown as Stripe);
    const preview = await fetch(`${app.baseUrl}/api/billing/referral-discount/preview`, {
      method: "POST", headers: headers(token, server.id), body: JSON.stringify({ referralCode: "RETIRED" }),
    });
    assert.equal(preview.status, 404);
    const checkout = await fetch(`${app.baseUrl}/api/billing/checkout`, {
      method: "POST", headers: headers(token, server.id), body: JSON.stringify({
        successUrl: "http://127.0.0.1:4173/billing/success",
        cancelUrl: "http://127.0.0.1:4173/billing/cancel",
        referralCode: "RETIRED",
      }),
    });
    assert.equal(checkout.status, 400);
    assert.match((await checkout.json() as { error: string }).error, /Stripe Checkout/);
    assert.equal(creates, 0);
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(billingEnv);
  }
});

test("first Checkout invalid code is a generic owner-only 400 without Stripe creation or raw-code leakage", async ({ app }) => {
  const env = snapshotBillingEnv(); configureBillingEnv();
  try {
    const owner = await seedVerifiedUser("native-code-api-owner@slock.test");
    const member = await seedVerifiedUser("native-code-api-member@slock.test");
    const server = await createServer("Native Code", `native-code-${randomUUID()}`, owner.id); await addMember(server.id, member.id, "member");
    let creates = 0;
    __setStripeForTests({ checkout: { sessions: { create: async () => { creates++; return { url: "unexpected" }; } } } } as unknown as Stripe);
    const body = JSON.stringify({ targetPlan: "pro", promotionCode: "PRIVATE\u0000CODE", successUrl: "http://127.0.0.1:4173/billing/success", cancelUrl: "http://127.0.0.1:4173/billing/cancel" });
    const denied = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(await tokenForHuman(member.email), server.id), body });
    assert.equal(denied.status, 403);
    const response = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(await tokenForHuman(owner.email), server.id), body });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "Promotion code is unavailable", code: "promotion_code_unavailable" }); assert.equal(creates, 0);
  } finally { __resetStripeForTests(); restoreBillingEnv(env); }
});

test("ambiguous Stripe checkout returns an actionable error and never silently creates another", async ({ app }) => {
  const env = snapshotBillingEnv(); configureBillingEnv();
  try {
    const owner = await seedVerifiedUser(`unknown-checkout-${randomUUID()}@slock.test`);
    const server = await createServer("Unknown checkout", `unknown-checkout-${randomUUID()}`, owner.id);
    const token = await tokenForHuman(owner.email);
    let calls = 0;
    __setStripeForTests({ checkout: { sessions: { create: async () => { calls++; throw new Error("provider-detail-not-for-client"); } } } } as unknown as Stripe);
    const body = JSON.stringify({ targetPlan: "pro", successUrl: "http://127.0.0.1:4173/billing/success", cancelUrl: "http://127.0.0.1:4173/billing/cancel" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(token, server.id), body });
      assert.equal(result.status, 409);
      const response = await result.json() as { code: string; error: string };
      assert.equal(response.code, "checkout_outcome_unknown");
      assert.doesNotMatch(JSON.stringify(response), /provider-detail-not-for-client/);
    }
    assert.equal(calls, 1);
  } finally { __resetStripeForTests(); restoreBillingEnv(env); }
});

test("AppSumo billing summary is key-free and direct Stripe mutations refuse the lifetime source", async ({ app, db }) => {
  const env = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const { appSumoLicenses, appSumoLicenseBindings } = await import("../db/schema");
    const { parseAppSumoLicenseKey } = await import("../services/appSumoContracts");
    const owner = await seedVerifiedUser(`appsumo-owner-${randomUUID()}@slock.test`);
    const admin = await seedVerifiedUser(`appsumo-admin-${randomUUID()}@slock.test`);
    const server = await createServer("AppSumo billing", `appsumo-http-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    const key = parseAppSumoLicenseKey(randomUUID())!;
    await db.insert(appSumoLicenses).values({ productId: "test", licenseKey: key, tier: 4, status: "active", verifiedAt: new Date() });
    await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId: "test", originalLicenseKey: key, currentLicenseKey: key, boundByUserId: owner.id });
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const response = await fetch(`${app.baseUrl}/api/billing/subscription`, { headers: headers(ownerToken, server.id) });
    assert.equal(response.status, 200);
    const summary = await response.json() as { source: string; appsumo: { tier: number }; price: object | null };
    assert.equal(summary.source, "appsumo");
    assert.equal(summary.appsumo.tier, 4);
    assert.equal(summary.price, null);
    assert.equal(JSON.stringify(summary).includes(key), false);
    for (const path of ["checkout", "seat-pack-quantity/preview", "seat-pack-quantity", "cancel", "portal"]) {
      const result = await fetch(`${app.baseUrl}/api/billing/${path}`, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({}) });
      assert.equal(result.status, 409, path);
      assert.equal((await result.json() as { code: string }).code, "APPSUMO_BILLING_MANAGED");
    }
    const denied = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(adminToken, server.id), body: JSON.stringify({}) });
    assert.equal(denied.status, 403);
  } finally { restoreBillingEnv(env); }
});

test("pending AppSumo replacement blocks checkout until confirmed deactivation", async ({ app, db }) => {
  const env = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const { appSumoLicenses, appSumoLicenseBindings } = await import("../db/schema");
    const { parseAppSumoLicenseKey } = await import("../services/appSumoContracts");
    const owner = await seedVerifiedUser(`appsumo-transition-${randomUUID()}@slock.test`);
    const server = await createServer("Transition", `appsumo-transition-${randomUUID()}`, owner.id);
    const key = parseAppSumoLicenseKey(randomUUID())!;
    await db.insert(appSumoLicenses).values({ productId: "test", licenseKey: key, tier: 4, status: "active", verifiedAt: new Date() });
    await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId: "test", originalLicenseKey: key, currentLicenseKey: key, boundByUserId: owner.id });
    const ownerToken = await tokenForHuman(owner.email);
    const { receiveAppSumoEvent } = await import("../services/appSumoLifecycleService");
    const nextKey = parseAppSumoLicenseKey(randomUUID())!;
    const at = new Date();
    await receiveAppSumoEvent({ db, productId: "test", requestDigest: "a".repeat(64), now: at,
      event: { event: "downgrade", license_key: nextKey, prev_license_key: key, tier: 1, license_status: "inactive",
        event_timestamp: at.getTime(), created_at: at.getTime(), test: false } });
    const pendingResponse = await fetch(`${app.baseUrl}/api/billing/subscription`, { headers: headers(ownerToken, server.id) });
    const pending = await pendingResponse.json() as { appsumo: object | null; appsumoBillingReserved: boolean };
    assert.equal(pending.appsumo, null, "unverified successor grants no entitlement");
    assert.equal(pending.appsumoBillingReserved, true);
    const blocked = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({}) });
    assert.equal(blocked.status, 409, "real checkout route rejects the transition before reaching Stripe");
    await receiveAppSumoEvent({ db, productId: "test", requestDigest: "b".repeat(64), now: new Date(at.getTime() + 1_000),
      event: { event: "deactivate", license_key: nextKey, tier: 1, license_status: "inactive",
        event_timestamp: at.getTime(), created_at: at.getTime(), test: false } });
    const refunded = await fetch(`${app.baseUrl}/api/billing/checkout`, { method: "POST", headers: headers(ownerToken, server.id), body: JSON.stringify({}) });
    assert.equal(refunded.status, 400, "confirmed deactivation does not keep billing reserved");
  } finally { restoreBillingEnv(env); }
});

test("the payment method is the owner's to read: card brand and last four, else the customer's default, never more", async ({ app }) => {
  const env = snapshotBillingEnv();
  configureBillingEnv();
  try {
    const owner = await seedVerifiedUser(`billing-pm-owner-${randomUUID()}@slock.test`);
    const admin = await seedVerifiedUser(`billing-pm-admin-${randomUUID()}@slock.test`);
    const server = await createServer("Billing Payment Method", `billing-pm-${randomUUID()}`, owner.id);
    await addMember(server.id, admin.id, "admin");
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const read = (token: string) => fetch(`${app.baseUrl}/api/billing/payment-method`, { headers: headers(token, server.id) });

    // No subscription yet: nothing on file.
    const none = await read(ownerToken);
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { paymentMethod: null });

    await getDb().insert(subscriptions).values({
      serverId: server.id,
      stripeCustomerId: "cus_pm_route",
      stripeSubscriptionId: "sub_pm_route",
      stripeProPackItemId: "si_pm_route",
      status: "active",
      provisionedHumanSeats: 1,
      provisionedAgentSeats: 10,
      proPackQuantity: 1,
      currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      createdByUserId: owner.id,
    });
    const expands: unknown[] = [];
    let subscriptionMethod: unknown = {
      id: "pm_card", type: "card",
      card: { brand: "visa", last4: "4242", exp_month: 8, exp_year: 2027, fingerprint: "secret-fingerprint" },
      billing_details: { name: "Owner", email: "owner@example.com" },
    };
    __setStripeForTests({
      subscriptions: {
        retrieve: async (_id: string, params: { expand?: string[] }) => {
          expands.push(params?.expand);
          return {
            id: "sub_pm_route",
            default_payment_method: subscriptionMethod,
            customer: { id: "cus_pm_route", invoice_settings: { default_payment_method: { id: "pm_bank", type: "us_bank_account", us_bank_account: { last4: "6789", bank_name: "STRIPE TEST BANK" } } } },
          };
        },
      },
    } as unknown as Stripe);

    const denied = await read(adminToken);
    assert.equal(denied.status, 403, "admins see billing, not the payment method");

    const card = await read(ownerToken);
    assert.equal(card.status, 200);
    assert.equal(card.headers.get("cache-control"), "no-store");
    assert.deepEqual(await card.json(), { paymentMethod: { type: "card", brand: "visa", last4: "4242", expMonth: 8, expYear: 2027 } }, "only brand, last four and expiry");
    assert.deepEqual(expands.at(-1), ["default_payment_method", "customer.invoice_settings.default_payment_method"]);

    // No method on the subscription: the customer's default for invoices, as Stripe charges.
    subscriptionMethod = null;
    assert.deepEqual(await (await read(ownerToken)).json(), { paymentMethod: { type: "bank_account", last4: "6789", bankName: "STRIPE TEST BANK" } });
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(env);
  }
});

// C+ step 2 (task #proj-commercial:#24): the owner's summary carries how often
// agents reached behind the window in the last 7 days, on a plan with one.
test("billing summary carries the agents' 7-day reaches behind the history window on Free, none on Pro", async ({ app }) => {
  const billingEnv = snapshotBillingEnv();
  configureBillingEnv();
  __setAgentHistoryBlockStoreForTests({
    add: async () => {},
    sizes: async (keys) => keys.map((_, index) => (index === 0 ? 2 : index === 3 ? 1 : 0)),
  });
  try {
    const owner = await seedVerifiedUser("billing-history-blocks@slock.test");
    const server = await createServer("Billing History Blocks", `billing-history-blocks-${randomUUID()}`, owner.id);
    const token = await tokenForHuman(owner.email);
    const summary = async () => {
      const res = await fetch(`${app.baseUrl}/api/billing/subscription`, { headers: headers(token, server.id) });
      assert.equal(res.status, 200);
      return await res.json() as { plan: string; agentHistoryBlocks7d: number | null };
    };
    const free = await summary();
    assert.equal(free.plan, "free");
    assert.equal(free.agentHistoryBlocks7d, 3);

    __setAgentHistoryBlockStoreForTests({ add: async () => {}, sizes: async () => { throw new Error("down"); } });
    assert.equal((await summary()).agentHistoryBlocks7d, null, "unreadable: no number");

    await getDb().update(serversTable).set({ plan: "partner" }).where(eq(serversTable.id, server.id));
    assert.equal((await summary()).agentHistoryBlocks7d, null, "no history window: not counted");
  } finally {
    __setAgentHistoryBlockStoreForTests(null);
    restoreBillingEnv(billingEnv);
  }
});
