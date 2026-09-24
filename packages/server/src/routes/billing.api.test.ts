import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type Stripe from "stripe";
import { getEffectiveLimits, TRIAL_START_DATE } from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { servers as serversTable, subscriptions, users } from "../db/schema.js";
import { addMember, createServer } from "../services/serverService.js";
import { __resetStripeForTests, __setStripeForTests } from "../services/billingService.js";
import { eq } from "drizzle-orm";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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
      body: JSON.stringify({ packQuantity: 4 }),
    });
    assert.equal(ownerUpdate.status, 200);
    const ownerBody = await ownerUpdate.json() as { status: string };
    assert.equal(ownerBody.status, "pending_webhook");
    assert.equal(updateCount, 1);

    const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(sub.proPackQuantity, 1);
  } finally {
    __resetStripeForTests();
    restoreBillingEnv(billingEnv);
    await app.close();
  }
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false, clock: trialActiveClock });
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
