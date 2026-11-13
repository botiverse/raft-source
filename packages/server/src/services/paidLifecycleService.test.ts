import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import type { Request, Response as ExpressResponse } from "express";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  openTestDatabase,
  closeTestDatabase,
} from "../test/integration/database";
import {
  paidLifecycleJourneys as journeys,
  paidLifecyclePayments as payments,
  paidLifecycleReceipts as receipts,
  users,
  servers,
  serverMembers,
  subscriptions,
  newsletterWebhookEvents,
  webhookEvents,
  appSumoLicenses,
  appSumoLicenseBindings,
} from "../db/schema";
import { parseAppSumoLicenseKey } from "./appSumoContracts";
import {
  paidJourneyId,
  paidReceiptMarker,
  paidInvoiceId,
  paidInvoicePaymentId,
  paidChargeId,
} from "./paidLifecycleContracts";
import {
  recordPaidLifecycleProjection,
  paidServerCount,
  syncPaidLifecycleUser,
  recordVerifiedPaidDispatch,
  syncPaidLifecycleReceipts,
  verifyPaidLifecyclePayment,
} from "./paidLifecycleService";
import { resendNewsletterWebhookHandler } from "../routes/newsletterWebhooks";
import { verifyResendWebhookSignature } from "./newsletterService";
import {
  __setStripeForTests,
  __resetStripeForTests,
  handleWebhookEvent,
} from "./billingService";

const ENV = [
  "PAID_LIFECYCLE_EMAIL_MODE",
  "RESEND_API_KEY",
  "PAID_LIFECYCLE_RECEIPT_MARKER_SECRET",
  "PAID_LIFECYCLE_START_AT",
  "OPSHUB_PAID_EMAIL_RECEIPT_URL",
  "OPSHUB_PAID_EMAIL_RECEIPT_SECRET",
  "RESEND_NEWSLETTER_WEBHOOK_SECRET",
  "RESEND_NEWSLETTER_SEGMENT_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
] as const;
const originalEnv = new Map(ENV.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const key = "synthetic-marker-key-only-for-local-regressions";
const contactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const started = new Date(Date.now() - 3600_000),
  until = new Date(Date.now() + 365 * 86400_000);
let calls: Array<{
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}>;
let respond: (
  url: string,
  body: Record<string, unknown> | undefined,
) => Promise<Response>;
const json = (value: unknown, status = 200) => Response.json(value, { status });

beforeEach(async () => {
  if (process.env.RAFT_PAID_EMAIL_PG_TEST_URL) {
    const url = new URL(process.env.RAFT_PAID_EMAIL_PG_TEST_URL);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
        /^\/(task53_|paid_lifecycle_test)/.test(url.pathname),
      "real PG fixtures require a dedicated local test database",
    );
  }
  await openTestDatabase(
    process.env.RAFT_PAID_EMAIL_PG_TEST_URL ?? "pglite://",
  );
  if (process.env.RAFT_PAID_EMAIL_PG_TEST_URL)
    await getDb().execute(
      "TRUNCATE users, newsletter_webhook_events, webhook_events CASCADE",
    );
  process.env.PAID_LIFECYCLE_EMAIL_MODE = "enabled";
  process.env.RESEND_API_KEY = "re_synthetic_never_used_for_network";
  process.env.PAID_LIFECYCLE_RECEIPT_MARKER_SECRET = key;
  process.env.PAID_LIFECYCLE_START_AT = "2026-01-01T00:00:00Z";
  delete process.env.OPSHUB_PAID_EMAIL_RECEIPT_URL;
  delete process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET;
  calls = [];
  respond = async (url) =>
    url.includes("/contacts/")
      ? json({ id: contactId, unsubscribed: true })
      : json({ event: "raft.first_paid", object: "event" });
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input),
      body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
    assert.ok(
      url.startsWith("https://api.resend.com/") ||
        url.startsWith("https://slock-internal-ops-hub.botiverse.dev/"),
      "unexpected outbound destination",
    );
    if (url.includes("botiverse.dev")) {
      const headers = new Headers(init?.headers),
        timestamp = headers.get("x-receipt-timestamp");
      const expected = createHmac(
        "sha256",
        process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET!,
      )
        .update(
          `paid-email-receipt-v1\nPOST\n/api/services/paid-email-receipts\n${timestamp}\n${init!.body}`,
        )
        .digest("hex");
      assert.equal(headers.get("x-receipt-signature"), expected);
      assert.equal(
        headers.has("authorization"),
        false,
        "must not reuse an Agent credential",
      );
      assert.equal(init?.redirect, "error");
    }
    calls.push({ url, method: init?.method ?? "GET", body });
    return respond(url, body);
  }) as typeof fetch;
});
afterEach(async () => {
  __resetStripeForTests();
  globalThis.fetch = originalFetch;
  for (const name of ENV) {
    const old = originalEnv.get(name);
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
  await closeTestDatabase();
});

async function seed() {
  const db = getDb(),
    id = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      name: `paid-${id}`,
      email: `${id}@example.invalid`,
      passwordHash: "synthetic",
      emailVerified: true,
    })
    .returning();
  const [server] = await db
    .insert(servers)
    .values({
      name: "Synthetic paid server",
      slug: randomUUID(),
      ownerId: user.id,
      plan: "pro",
    })
    .returning();
  await db
    .insert(serverMembers)
    .values({ serverId: server.id, userId: user.id, role: "owner" });
  const subId = `sub_${randomUUID()}`;
  await db.insert(subscriptions).values({
    serverId: server.id,
    stripeCustomerId: "cus_synthetic",
    stripeSubscriptionId: subId,
    status: "active",
    currentPeriodEnd: until,
    createdByUserId: user.id,
    billingInterval: "annual",
    cancelAtPeriodEnd: true,
  });
  const cash = {
    invoiceId: paidInvoiceId(`in_${randomUUID()}`),
    paymentId: paidInvoicePaymentId(`inpay_${randomUUID()}`),
    chargeId: paidChargeId(`ch_${randomUUID()}`),
    amount: 500,
    paidAt: started,
  };
  await db.transaction((tx) =>
    recordPaidLifecycleProjection(tx, {
      serverId: server.id,
      payerUserId: user.id,
      stripeSubscriptionId: subId,
      paidUntil: until,
      payment: {
        cash,
        paidUntil: until,
        canStartJourney: true,
        recipientUserId: user.id,
      },
    }),
  );
  const [journey] = await db
    .select()
    .from(journeys)
    .where(eq(journeys.userId, user.id));
  return { user, server, subId, cash, journey };
}

async function lifetimeGrant(serverId: string, userId: string) {
  const licenseKey = parseAppSumoLicenseKey(randomUUID());
  assert.ok(licenseKey);
  const db = getDb();
  await db.insert(appSumoLicenses).values({
    productId: "synthetic-paid-email", licenseKey, status: "active",
    tier: 1, verifiedAt: new Date(),
  });
  await db.insert(appSumoLicenseBindings).values({
    productId: "synthetic-paid-email", serverId, boundByUserId: userId,
    originalLicenseKey: licenseKey, currentLicenseKey: licenseKey,
  });
  return licenseKey;
}

test("current AppSumo grant excludes a coexisting Stripe subscription; switching back to subscription can send once, without a permanent User blacklist", async () => {
  const { user, server } = await seed(), db = getDb();
  const licenseKey = await lifetimeGrant(server.id, user.id);
  assert.equal(await paidServerCount(user.id), 0);
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter(c => c.url.endsWith("/events/send")).length, 0);
  assert.ok(calls.some(c => (c.body?.properties as { paid_server_count?: number })?.paid_server_count === 0));
  const [before] = await db.select().from(journeys).where(eq(journeys.userId, user.id));
  assert.equal(before.triggerState, "pending");
  assert.equal(before.needsSync, false);

  // Canonical source transition; no new payment/journey or historical backfill.
  await db.update(appSumoLicenses).set({ status: "deactivated" })
    .where(eq(appSumoLicenses.licenseKey, licenseKey));
  const [dirty] = await db.select().from(journeys).where(eq(journeys.userId, user.id));
  assert.equal(dirty.needsSync, true, "license changes must durably dirty an existing journey");
  assert.equal(await paidServerCount(user.id), 1);
  calls.length = 0;
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter(c => c.url.endsWith("/events/send")).length, 1);
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter(c => c.url.endsWith("/events/send")).length, 1);

  // A later lifetime grant must suppress an already-started follow-up count.
  await db.update(appSumoLicenses).set({ status: "active" })
    .where(eq(appSumoLicenses.licenseKey, licenseKey));
  calls.length = 0;
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter(c => c.url.endsWith("/events/send")).length, 0);
  assert.ok(calls.some(c => (c.body?.properties as { paid_server_count?: number })?.paid_server_count === 0));
});

test("AppSumo alone never enrolls; a separate currently subscribed Server is not globally excluded", async () => {
  const { user, server } = await seed(), db = getDb();
  await lifetimeGrant(server.id, user.id);
  await db.delete(journeys).where(eq(journeys.userId, user.id));
  await db.delete(payments).where(eq(payments.serverId, server.id));
  await db.delete(subscriptions).where(eq(subscriptions.serverId, server.id));
  assert.equal(await paidServerCount(user.id), 0);
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.length, 0);
  assert.equal((await db.select().from(journeys)).length, 0);

  const [other] = await db.insert(servers).values({
    name: "Separate subscription", slug: randomUUID(), ownerId: user.id, plan: "pro",
  }).returning();
  await db.insert(serverMembers).values({ serverId: other.id, userId: user.id, role: "owner" });
  await db.insert(subscriptions).values({
    serverId: other.id, stripeCustomerId: "cus_other_synthetic",
    stripeSubscriptionId: `sub_${randomUUID()}`, status: "active",
    currentPeriodEnd: until, createdByUserId: user.id,
  });
  assert.equal(await paidServerCount(user.id), 1);
  assert.equal((await db.select().from(journeys)).length, 0,
    "subscription state changes do not manufacture first-payment evidence");
});

test("subscription state and unexpired period determine count: annual/cancel-at-end and no payment journal qualify; non-owner/non-payer, non-Pro, past-due and expiry do not", async () => {
  const { user, server } = await seed(),
    db = getDb();
  assert.equal(
    await paidServerCount(user.id),
    1,
    "owner and payer association counts a Server only once",
  );
  await db.delete(payments).where(eq(payments.serverId, server.id));
  assert.equal(
    await paidServerCount(user.id),
    1,
    "no cash journal is required",
  );
  assert.equal(
    await paidServerCount(user.id, db, new Date(until.getTime() + 1)),
    0,
  );
  for (const status of ["past_due", "canceled", "incomplete"] as const) {
    await db
      .update(subscriptions)
      .set({ status })
      .where(eq(subscriptions.serverId, server.id));
    assert.equal(await paidServerCount(user.id), 0, status);
  }
  await db
    .update(subscriptions)
    .set({ status: "active" })
    .where(eq(subscriptions.serverId, server.id));
  await db
    .update(servers)
    .set({ plan: "founder" })
    .where(eq(servers.id, server.id));
  assert.equal(await paidServerCount(user.id), 0);
  await db
    .update(servers)
    .set({ plan: "pro" })
    .where(eq(servers.id, server.id));
  await db
    .update(serverMembers)
    .set({ role: "member" })
    .where(eq(serverMembers.userId, user.id));
  assert.equal(
    await paidServerCount(user.id),
    1,
    "actual payer still qualifies",
  );
  await db
    .update(subscriptions)
    .set({ createdByUserId: null })
    .where(eq(subscriptions.serverId, server.id));
  assert.equal(
    await paidServerCount(user.id),
    0,
    "ordinary membership alone does not count",
  );
  await db
    .update(serverMembers)
    .set({ role: "owner" })
    .where(eq(serverMembers.userId, user.id));
  assert.equal(await paidServerCount(user.id), 1);
  await db
    .update(servers)
    .set({ deletedAt: new Date() })
    .where(eq(servers.id, server.id));
  assert.equal(await paidServerCount(user.id), 0);
});

test("User journey survives duplicate invoices and additional Servers; multiple owners use only actual paying owner", async () => {
  const { user, server, subId, cash } = await seed(),
    db = getDb();
  await recordPaidLifecycleProjection(db, {
    serverId: server.id,
    payerUserId: user.id,
    stripeSubscriptionId: subId,
    paidUntil: until,
    payment: {
      cash,
      paidUntil: until,
      canStartJourney: true,
      recipientUserId: user.id,
    },
  });
  const [second] = await db
    .insert(users)
    .values({
      name: randomUUID(),
      email: `${randomUUID()}@example.invalid`,
      passwordHash: "synthetic",
    })
    .returning();
  await db
    .insert(serverMembers)
    .values({ serverId: server.id, userId: second.id, role: "owner" });
  await recordPaidLifecycleProjection(db, {
    serverId: server.id,
    payerUserId: second.id,
    stripeSubscriptionId: subId,
    paidUntil: until,
    payment: {
      cash: { ...cash, invoiceId: paidInvoiceId(`in_${randomUUID()}`) },
      paidUntil: until,
      canStartJourney: true,
      recipientUserId: second.id,
    },
  });
  assert.equal((await db.select().from(journeys)).length, 2);
  await db.delete(journeys).where(eq(journeys.userId, second.id));
  await recordPaidLifecycleProjection(db, {
    serverId: server.id,
    payerUserId: null,
    stripeSubscriptionId: subId,
    paidUntil: until,
    payment: {
      cash: { ...cash, invoiceId: paidInvoiceId(`in_${randomUUID()}`) },
      paidUntil: until,
      canStartJourney: true,
      recipientUserId: second.id,
    },
  });
  assert.equal(
    (await db.select().from(journeys)).length,
    1,
    "unknown payer must not choose among owners",
  );
});

test("business mutation and dirty flag commit or roll back together, including owner deletion and User email", async () => {
  const { user, server, journey } = await seed(),
    db = getDb();
  await db
    .update(journeys)
    .set({ needsSync: false })
    .where(eq(journeys.userId, user.id));
  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        await tx
          .update(subscriptions)
          .set({ status: "canceled" })
          .where(eq(subscriptions.serverId, server.id));
        const [dirty] = await tx
          .select()
          .from(journeys)
          .where(eq(journeys.userId, user.id));
        assert.equal(dirty.needsSync, true);
        throw new Error("synthetic rollback");
      }),
    /synthetic rollback/,
  );
  let [row] = await db
    .select()
    .from(journeys)
    .where(eq(journeys.userId, user.id));
  assert.equal(row.needsSync, false);
  assert.equal(row.revision, journey.revision);
  await db.delete(serverMembers).where(eq(serverMembers.userId, user.id));
  [row] = await db.select().from(journeys).where(eq(journeys.userId, user.id));
  assert.equal(row.needsSync, true);
  assert.ok(row.revision > journey.revision);
  await db
    .update(journeys)
    .set({ needsSync: false })
    .where(eq(journeys.userId, user.id));
  await db
    .update(users)
    .set({ email: `${randomUUID()}@example.invalid` })
    .where(eq(users.id, user.id));
  assert.equal(
    (await db.select().from(journeys).where(eq(journeys.userId, user.id)))[0]
      .needsSync,
    true,
  );
});

test("Contact property sync does not reset provider unsubscribe; event attempted once per User, not once per retry", async () => {
  const { user } = await seed(),
    db = getDb();
  await syncPaidLifecycleUser(user.id);
  let [row] = await db
    .select()
    .from(journeys)
    .where(eq(journeys.userId, user.id));
  assert.equal(row.triggerState, "accepted");
  assert.equal(row.needsSync, false);
  assert.equal(row.contactId, contactId);
  assert.equal(row.refreshAfter, null, "direct sync must not schedule expiry work");
  await db
    .update(journeys)
    .set({ needsSync: true })
    .where(eq(journeys.userId, user.id));
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 1);
  for (const call of calls)
    assert.equal(
      JSON.stringify(call.body ?? {}).includes("unsubscribed"),
      false,
    );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 2);
  const event = calls.find((c) => c.url.endsWith("/events/send"))!.body;
  assert.equal(event?.contact_id, contactId);
  assert.equal(
    JSON.stringify(event).includes(user.id),
    false,
    "provider marker must not expose User identity",
  );
});

test("failed properties remain dirty; ambiguous event response is never automatically retried", async () => {
  const { user } = await seed(),
    db = getDb();
  respond = async (url) =>
    url.includes("/contacts/") ? json({ id: contactId }) : json({}, 503);
  await assert.rejects(
    () => syncPaidLifecycleUser(user.id),
    /PAID_TRIGGER_UNKNOWN/,
  );
  let [row] = await db
    .select()
    .from(journeys)
    .where(eq(journeys.userId, user.id));
  assert.equal(row.needsSync, true);
  assert.equal(row.triggerState, "unknown");
  assert.equal(row.leaseToken, null);
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 1);
  await db
    .update(journeys)
    .set({ needsSync: true })
    .where(eq(journeys.userId, user.id));
  respond = async () => json({}, 429);
  await assert.rejects(() => syncPaidLifecycleUser(user.id), /429/);
  [row] = await db.select().from(journeys).where(eq(journeys.userId, user.id));
  assert.equal(row.needsSync, true);
});

test("newer business revision cannot be cleared by stale sync; a later direct attempt uses current state", async () => {
  const { user, server } = await seed(),
    db = getDb();
  let changed = false;
  respond = async (url) => {
    if (url.includes("/contacts/") && !changed) {
      changed = true;
      await db
        .update(subscriptions)
        .set({ status: "past_due" })
        .where(eq(subscriptions.serverId, server.id));
    }
    return json({ id: contactId });
  };
  await syncPaidLifecycleUser(user.id);
  const [row] = await db
    .select()
    .from(journeys)
    .where(eq(journeys.userId, user.id));
  assert.equal(row.needsSync, true);
  assert.equal(row.triggerState, "pending");
  assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 0);
  respond = async () => json({ id: contactId });
  calls.length = 0;
  await syncPaidLifecycleUser(user.id);
  assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, {
    properties: { paid_server_count: 0 },
  });
  assert.equal(calls.filter((call) => call.url.endsWith("/events/send")).length, 0);
  const [synced] = await db.select().from(journeys).where(eq(journeys.userId, user.id));
  assert.equal(synced.needsSync, false);
});

test("email changes stop the original Contact but never re-enroll or resend a User's welcome", async () => {
  const { user } = await seed(),
    db = getDb();
  await syncPaidLifecycleUser(user.id);
  calls.length = 0;
  await db
    .update(users)
    .set({ email: `${randomUUID()}@example.invalid` })
    .where(eq(users.id, user.id));
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { properties: { paid_server_count: 0 } });
});

test("Contact identity collision is enforced by the database, not a race-prone lookup", async () => {
  const first = await seed(),
    second = await seed(),
    db = getDb();
  await syncPaidLifecycleUser(first.user.id);
  await assert.rejects(
    () => syncPaidLifecycleUser(second.user.id),
    /PAID_CONTACT_COLLISION/,
  );
  await assert.rejects(() =>
    db
      .update(journeys)
      .set({ contactId })
      .where(eq(journeys.userId, second.user.id)),
  );
  assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 1);
});

test("verified sent email binds exact provider ID + authentic registered step; receipt retry does not send mail", async () => {
  const { user, journey } = await seed(),
    db = getDb(),
    emailId = randomUUID(),
    sentAt = new Date().toISOString();
  await db
    .update(journeys)
    .set({ triggerState: "accepted" })
    .where(eq(journeys.id, journey.id));
  process.env.OPSHUB_PAID_EMAIL_RECEIPT_URL =
    "https://slock-internal-ops-hub.botiverse.dev/api/services/paid-email-receipts";
  process.env.OPSHUB_PAID_EMAIL_RECEIPT_SECRET =
    "synthetic-dedicated-ops-receipt-key-never-used-live";
  let sinkOk = false;
  respond = async (url) =>
    url.includes("api.resend.com")
      ? json({
          id: emailId,
          html: `<!-- raft-paid-receipt:${paidReceiptMarker(key, paidJourneyId(journey.id), "welcome")} -->`,
        })
      : sinkOk
        ? json({ ok: true, code: "RECEIPT_RECORDED" })
        : json({ ok: false }, 503);
  await recordVerifiedPaidDispatch({
    type: "email.sent",
    created_at: sentAt,
    data: { email_id: emailId },
  });
  assert.equal((await db.select().from(receipts))[0].needsSync, true);
  sinkOk = true;
  await syncPaidLifecycleReceipts();
  await recordVerifiedPaidDispatch({
    type: "email.sent",
    created_at: sentAt,
    data: { email_id: emailId },
  });
  assert.equal((await db.select().from(receipts)).length, 1);
  assert.equal((await db.select().from(receipts))[0].needsSync, false);
  const receipt = calls.find((c) => c.url.includes("botiverse.dev"))!.body;
  assert.deepEqual(receipt, {
    version: 1,
    emailId,
    userId: user.id,
    kind: "welcome",
    sentAt,
  });
  assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 0);
  const before = calls.length;
  for (const type of [
    "email.scheduled",
    "email.delivered",
    "email.failed",
    "email.suppressed",
  ])
    await recordVerifiedPaidDispatch({
      type,
      created_at: sentAt,
      data: { email_id: emailId },
    });
  assert.equal(calls.length, before);
});

test("unregistered, duplicate-step, or changed email identity cannot create an arbitrary CRM receipt", async () => {
  const { journey } = await seed(),
    db = getDb(),
    emailId = randomUUID(),
    sentAt = new Date().toISOString();
  await db
    .update(journeys)
    .set({ triggerState: "accepted" })
    .where(eq(journeys.id, journey.id));
  respond = async () =>
    json({
      id: emailId,
      html: "<p>Thanks for choosing Raft, someone@example.invalid</p>",
    });
  await recordVerifiedPaidDispatch({
    type: "email.sent",
    created_at: sentAt,
    data: { email_id: emailId },
  });
  assert.equal((await db.select().from(receipts)).length, 0);
  respond = async () =>
    json({
      id: emailId,
      html: `<!-- raft-paid-receipt:${paidReceiptMarker(key, paidJourneyId(randomUUID()), "welcome")} -->`,
    });
  await assert.rejects(
    () =>
      recordVerifiedPaidDispatch({
        type: "email.sent",
        created_at: sentAt,
        data: { email_id: emailId },
      }),
    /JOURNEY_UNKNOWN/,
  );
  respond = async () =>
    json({
      id: randomUUID(),
      html: `<!-- raft-paid-receipt:${paidReceiptMarker(key, paidJourneyId(journey.id), "welcome")} -->`,
    });
  await assert.rejects(
    () =>
      recordVerifiedPaidDispatch({
        type: "email.sent",
        created_at: sentAt,
        data: { email_id: emailId },
      }),
    /RESPONSE_INVALID/,
  );
});

test("actual webhook handler authenticates raw bytes before email lookup and handles receipt retries even after newsletter dedupe", async () => {
  const { journey } = await seed(),
    db = getDb(),
    emailId = randomUUID(),
    createdAt = new Date().toISOString();
  await db
    .update(journeys)
    .set({ triggerState: "accepted" })
    .where(eq(journeys.id, journey.id));
  const secret = Buffer.from("synthetic-svix-secret"),
    id = "msg_synthetic_paid",
    timestamp = String(Math.floor(Date.now() / 1000));
  process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET = `whsec_${secret.toString("base64")}`;
  process.env.RESEND_NEWSLETTER_SEGMENT_ID = randomUUID();
  const raw = Buffer.from(
    JSON.stringify({
      type: "email.sent",
      created_at: createdAt,
      data: { email_id: emailId },
    }),
  );
  const signature = `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(raw).digest("base64")}`;
  let status = 200;
  const res = {
    status: (next: number) => {
      status = next;
      return res;
    },
    json: () => res,
  } as unknown as ExpressResponse;
  const request = (signature: string, body = raw) =>
    ({
      headers: {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": signature,
      },
      body,
    }) as unknown as Request;
  await resendNewsletterWebhookHandler(request("v1,wrong"), res);
  assert.equal(status, 400);
  assert.equal(calls.length, 0);
  await db.insert(newsletterWebhookEvents).values({ id, type: "email.sent" });
  respond = async () =>
    json({
      id: emailId,
      html: `<!-- raft-paid-receipt:${paidReceiptMarker(key, paidJourneyId(journey.id), "welcome")} -->`,
    });
  status = 200;
  await resendNewsletterWebhookHandler(request(signature), res);
  assert.equal(status, 200);
  assert.equal((await db.select().from(receipts)).length, 1);
  const replacement = Buffer.from(raw);
  replacement[replacement.length - 3] = 0xff;
  status = 200;
  await resendNewsletterWebhookHandler(request(signature, replacement), res);
  assert.equal(status, 400);
  assert.equal(calls.length, 1);
  // Positive normalization trap: old UTF-8-string verifier accepted invalid
  // bytes signed as the replacement character. Raw-byte verifier must reject.
  const valid = Buffer.from('{"value":"�"}');
  const normalizedSignature = `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.`).update(valid).digest("base64")}`;
  verifyResendWebhookSignature(
    valid,
    { id, timestamp, signature: normalizedSignature },
    process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET!,
  );
  const corrupt = Buffer.from('{"value":"\xff"}', "latin1");
  assert.throws(
    () =>
      verifyResendWebhookSignature(
        corrupt,
        { id, timestamp, signature: normalizedSignature },
        process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET!,
      ),
    /Invalid.*signature/,
  );
});

test("signed unrelated HTML and plain-text sent events continue newsletter processing, while malformed details fail closed", async () => {
  const db = getDb();
  const secret = Buffer.from("synthetic-svix-text-contract");
  process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET = `whsec_${secret.toString("base64")}`;
  process.env.RESEND_NEWSLETTER_SEGMENT_ID = randomUUID();
  for (const sample of [
    { html: "<p>Unrelated synthetic newsletter</p>", text: null, status: 200 },
    { html: null, text: "Unrelated synthetic plain-text mail", status: 200 },
    { html: undefined, text: "missing HTML field", status: 503 },
    { html: 42, text: "malformed HTML field", status: 503 },
    { html: null, text: "wrong exact email ID", status: 503, wrongId: true },
  ]) {
    const id = `msg_synthetic_${randomUUID()}`;
    const emailId = randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = Buffer.from(
      JSON.stringify({
        type: "email.sent",
        created_at: new Date().toISOString(),
        data: { email_id: emailId },
      }),
    );
    const signature = `v1,${createHmac("sha256", secret)
      .update(`${id}.${timestamp}.`)
      .update(raw)
      .digest("base64")}`;
    respond = async () =>
      json({
        id: sample.wrongId ? randomUUID() : emailId,
        html: sample.html,
        text: sample.text,
      });
    let status = 200;
    const res = {
      status: (next: number) => {
        status = next;
        return res;
      },
      json: () => res,
    } as unknown as ExpressResponse;
    await resendNewsletterWebhookHandler(
      {
        headers: {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": signature,
        },
        body: raw,
      } as unknown as Request,
      res,
    );
    assert.equal(
      status,
      sample.status,
      `HTML ${String(sample.html)} wrongId=${sample.wrongId ?? false}`,
    );
    assert.equal(
      (
        await db
          .select()
          .from(newsletterWebhookEvents)
          .where(eq(newsletterWebhookEvents.id, id))
      ).length,
      sample.status === 200 ? 1 : 0,
    );
    assert.equal((await db.select().from(receipts)).length, 0);
  }
});

test("disabled and pre-rollout invoices do not enroll; a historical customer's new renewal starts exactly one journey without scanning history", async () => {
  const { user, server, subId } = await seed(),
    db = getDb();
  const invoice = {
    id: "in_new",
    status: "paid",
    created: Math.floor(Date.now() / 1000),
    currency: "usd",
    customer: "cus_synthetic",
    livemode: false,
  } as Stripe.Invoice;
  const allocation = {
    id: "inpay_new",
    invoice: "in_new",
    status: "paid",
    amount_paid: 500,
    currency: "usd",
    livemode: false,
    status_transitions: { paid_at: invoice.created },
    payment: { type: "charge", charge: "ch_new" },
  } as Stripe.InvoicePayment;
  const charge = {
    id: "ch_new",
    status: "succeeded",
    paid: true,
    captured: true,
    refunded: false,
    amount_refunded: 0,
    amount_captured: 500,
    currency: "usd",
    customer: "cus_synthetic",
    livemode: false,
  } as Stripe.Charge;
  const each = async function* (items: unknown[]) {
    for (const item of items) yield item;
  };
  let historyReads = 0;
  const stripe = {
    invoicePayments: {
      list: (args: { invoice: string }) =>
        each([
          { ...allocation, id: `inpay_${args.invoice}`, invoice: args.invoice },
        ]),
    },
    charges: { retrieve: async () => charge },
    invoices: {
      listLineItems: () =>
        each([
          {
            subscription: subId,
            amount: 500,
            period: {
              start: invoice.created,
              end: Math.floor(until.getTime() / 1000),
            },
          },
        ]),
      list: () => {
        historyReads++;
        return each([
          { id: "in_old", created: invoice.created - 1, amount_paid: 500 },
        ]);
      },
    },
  } as unknown as Stripe;
  const sub = {
    id: subId,
    metadata: { userId: user.id, serverId: server.id },
  } as unknown as Stripe.Subscription;
  process.env.PAID_LIFECYCLE_EMAIL_MODE = "disabled";
  assert.equal(await verifyPaidLifecyclePayment(stripe, invoice, sub), null);
  await syncPaidLifecycleUser(user.id);
  assert.equal(calls.length, 0);
  process.env.PAID_LIFECYCLE_EMAIL_MODE = "enabled";
  await db.delete(journeys).where(eq(journeys.userId, user.id));
  const oldInvoice = {
    ...invoice,
    created: Date.parse(process.env.PAID_LIFECYCLE_START_AT!) / 1000 - 1,
  } as Stripe.Invoice;
  assert.equal(await verifyPaidLifecyclePayment(stripe, oldInvoice, sub), null);
  assert.equal((await db.select().from(journeys)).length, 0);
  const payment = await verifyPaidLifecyclePayment(stripe, invoice, sub);
  assert.equal(payment?.canStartJourney, true);
  const record = (verified: typeof payment) => db.transaction((tx) =>
    recordPaidLifecycleProjection(tx, {
      serverId: server.id,
      payerUserId: user.id,
      stripeSubscriptionId: subId,
      paidUntil: until,
      payment: verified,
    }),
  );
  await record(payment);
  await record(payment); // Same invoice replay must not create another journey.
  await syncPaidLifecycleUser(user.id);
  const nextPayment = await verifyPaidLifecyclePayment(
    stripe, { ...invoice, id: "in_next" } as Stripe.Invoice, sub,
  );
  assert.equal(nextPayment?.canStartJourney, false);
  await record(nextPayment);
  await syncPaidLifecycleUser(user.id);
  assert.equal((await db.select().from(journeys)).length, 1);
  assert.equal(
    calls.filter((call) => call.url.endsWith("/events/send")).length, 1,
  );
  assert.equal(historyReads, 0, "historical billing data is outside campaign admission");
});

test("actual invoice-paid handler rolls subscription, entitlement, cash and enrollment back together, then recovers only once", async () => {
  const { user, server, subId } = await seed(),
    db = getDb();
  await db.delete(journeys).where(eq(journeys.userId, user.id));
  await db.delete(payments).where(eq(payments.serverId, server.id));
  await db
    .update(subscriptions)
    .set({ status: "past_due" })
    .where(eq(subscriptions.serverId, server.id));
  await db
    .update(servers)
    .set({ plan: "free" })
    .where(eq(servers.id, server.id));
  process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID = "price_synthetic_annual";
  const seconds = Math.floor(Date.now() / 1000);
  const invoice = {
    id: "in_actual_handler",
    status: "paid",
    created: seconds,
    currency: "usd",
    customer: "cus_synthetic",
    livemode: false,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: subId },
    },
  } as unknown as Stripe.Invoice;
  const sub = {
    id: subId,
    customer: "cus_synthetic",
    status: "active",
    metadata: {
      pricingContract: "raft-pro-seat-v1",
      serverId: server.id,
      userId: user.id,
      targetPlan: "pro",
      billingInterval: "annual",
      proPackQuantity: "1",
      trialFreePackQuantity: "0",
    },
    items: {
      data: [
        {
          id: "si_synthetic",
          quantity: 1,
          current_period_start: seconds,
          current_period_end: Math.floor(until.getTime() / 1000),
          price: {
            id: "price_synthetic_annual",
            product: "prod_synthetic",
            recurring: { interval: "year" },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
  const allocation = {
    id: "inpay_actual_handler",
    invoice: invoice.id,
    status: "paid",
    amount_paid: 500,
    currency: "usd",
    livemode: false,
    status_transitions: { paid_at: seconds },
    payment: { type: "charge", charge: "ch_actual_handler" },
  } as Stripe.InvoicePayment;
  const charge = {
    id: "ch_actual_handler",
    status: "succeeded",
    paid: true,
    captured: true,
    refunded: false,
    amount_refunded: 0,
    amount_captured: 500,
    currency: "usd",
    customer: "cus_synthetic",
    livemode: false,
  } as Stripe.Charge;
  const each = async function* (items: unknown[]) {
    for (const item of items) yield item;
  };
  __setStripeForTests({
    subscriptions: { retrieve: async () => sub },
    invoicePayments: { list: () => each([allocation]) },
    charges: { retrieve: async () => charge },
    invoices: {
      listLineItems: () =>
        each([
          {
            subscription: subId,
            amount: 500,
            period: { start: seconds, end: Math.floor(until.getTime() / 1000) },
          },
        ]),
      list: () => each([]),
    },
  } as unknown as Stripe);
  const event = {
    id: "evt_actual_handler",
    type: "invoice.paid",
    data: { object: invoice },
  } as unknown as Stripe.Event;
  await db.execute(
    "ALTER TABLE paid_lifecycle_payments ADD CONSTRAINT reject_synthetic_cash CHECK (invoice_id != 'in_actual_handler')",
  );
  try {
    await assert.rejects(() => handleWebhookEvent(event));
    assert.equal(
      (
        await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.serverId, server.id))
      )[0].status,
      "past_due",
    );
    assert.equal(
      (await db.select().from(servers).where(eq(servers.id, server.id)))[0]
        .plan,
      "free",
    );
    assert.equal((await db.select().from(payments)).length, 0);
    assert.equal((await db.select().from(journeys)).length, 0);
    assert.equal(calls.length, 0);
  } finally {
    await db.execute(
      "ALTER TABLE paid_lifecycle_payments DROP CONSTRAINT reject_synthetic_cash",
    );
  }
  await handleWebhookEvent({
    id: "evt_actual_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: sub.id,
        customer: "cus_synthetic",
        metadata: { serverId: server.id, userId: user.id },
      },
    },
  } as unknown as Stripe.Event);
  assert.equal(
    (await db.select().from(journeys)).length,
    0,
    "Checkout alone never enrolls a User",
  );
  assert.equal(calls.length, 0);
  await handleWebhookEvent(event);
  await handleWebhookEvent(event);
  assert.equal((await db.select().from(journeys)).length, 1);
  assert.equal((await db.select().from(payments)).length, 1);
  assert.equal(
    (await db.select().from(servers).where(eq(servers.id, server.id)))[0].plan,
    "pro",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/events/send")).length,
    1,
  );
  const beforeRefundCalls = calls.length;
  await handleWebhookEvent({
    id: "evt_actual_refund",
    type: "charge.refunded",
    data: { object: charge },
  } as Stripe.Event);
  assert.equal(await paidServerCount(user.id), 1);
  assert.equal(
    calls.length,
    beforeRefundCalls,
    "refund has no mail-state side effects",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/events/send")).length,
    1,
    "refund is not another welcome",
  );
  sub.status = "canceled";
  await handleWebhookEvent({
    id: "evt_existing_journey_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        mode: "subscription",
        subscription: sub.id,
        customer: "cus_synthetic",
        metadata: { serverId: server.id, userId: user.id },
      },
    },
  } as unknown as Stripe.Event);
  assert.deepEqual(
    calls.filter((call) => call.method === "PATCH").at(-1)?.body,
    { properties: { paid_server_count: 0 } },
  );
  assert.equal((await db.select().from(journeys)).length, 1);
  assert.equal(
    calls.filter((call) => call.url.endsWith("/events/send")).length,
    1,
    "Checkout refreshes an existing journey, not another welcome",
  );
});

test("an associated old active Server contributes directly from subscriptions without Stripe lookups or historical enrollment", async () => {
  const { user, server } = await seed(),
    db = getDb();
  await db
    .update(journeys)
    .set({ triggerState: "accepted" })
    .where(eq(journeys.userId, user.id));
  await db
    .update(subscriptions)
    .set({ status: "canceled" })
    .where(eq(subscriptions.serverId, server.id));
  const [other] = await db
    .insert(servers)
    .values({
      name: "Synthetic old annual B",
      slug: randomUUID(),
      ownerId: user.id,
      plan: "pro",
    })
    .returning();
  await db
    .insert(serverMembers)
    .values({ serverId: other.id, userId: user.id, role: "owner" });
  await db.insert(subscriptions).values({
    serverId: other.id,
    stripeCustomerId: "cus_old",
    stripeSubscriptionId: "sub_old",
    status: "active",
    currentPeriodEnd: until,
    createdByUserId: user.id,
    billingInterval: "annual",
  });
  const unexpectedStripe = () => {
    throw new Error("count must not look up cash");
  };
  __setStripeForTests({
    subscriptions: { retrieve: unexpectedStripe },
    invoices: { retrieve: unexpectedStripe },
    invoicePayments: { list: unexpectedStripe },
    charges: { retrieve: unexpectedStripe },
  } as unknown as Stripe);
  await syncPaidLifecycleUser(user.id);
  assert.equal(await paidServerCount(user.id), 1);
  assert.equal(
    await paidServerCount(user.id, db, new Date(until.getTime() + 1)),
    0,
  );
  assert.equal((await db.select().from(journeys)).length, 1);
  assert.equal(
    (await db.select().from(payments)).length,
    1,
    "counting old Servers does not manufacture admission records",
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/events/send")).length,
    0,
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "PATCH").at(-1)?.body,
    { properties: { paid_server_count: 1 } },
  );
});

test("refund events are ignored in enabled and disabled modes: no count, dirty, enrollment or provider changes", async () => {
  const { user, cash } = await seed(),
    db = getDb();
  await db
    .update(journeys)
    .set({ triggerState: "accepted", needsSync: false })
    .where(eq(journeys.userId, user.id));
  const before = (await db.select().from(journeys))[0];
  for (const mode of ["enabled", "disabled"]) {
    process.env.PAID_LIFECYCLE_EMAIL_MODE = mode;
    const event = {
      id: "evt_ignored_refund_" + mode,
      type: "charge.refunded",
      data: { object: { id: cash.chargeId } },
    } as unknown as Stripe.Event;
    await handleWebhookEvent(event);
    await handleWebhookEvent(event);
    assert.equal(await paidServerCount(user.id), 1);
    assert.deepEqual((await db.select().from(journeys))[0], before);
    assert.equal((await db.select().from(payments)).length, 1);
    assert.equal(calls.length, 0);
  }
});

// These seats deliberately require real PostgreSQL: PGlite's single connection
// would make a competing-claim test an unreliable concurrency proof.
test.skipIf(!process.env.RAFT_PAID_EMAIL_PG_TEST_URL)(
  "real PG competing workers claim one User only once",
  async () => {
    const { user } = await seed();
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
    respond = async (url) => {
      if (url.includes("/contacts/") && calls.length === 1) {
        entered();
        await wait;
      }
      return json({ id: contactId });
    };
    const first = syncPaidLifecycleUser(user.id);
    try {
      await ready;
      await syncPaidLifecycleUser(user.id);
      assert.equal(
        calls.length,
        1,
        "competitor must not enter provider while lease is live",
      );
    } finally {
      release();
      await first;
    }
    assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 1);
    assert.equal(
      (await getDb().select().from(journeys))[0].triggerState,
      "accepted",
    );
  },
);

test.skipIf(!process.env.RAFT_PAID_EMAIL_PG_TEST_URL)(
  "real PG two Users cannot bind the same provider Contact concurrently",
  async () => {
    const first = await seed(),
      second = await seed();
    let arrive = 0,
      release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    respond = async (url) => {
      if (url.includes("/contacts/") && !calls.at(-1)?.body) {
        if (++arrive === 2) release();
        await both;
      }
      return json({ id: contactId });
    };
    const results = await Promise.allSettled([
      syncPaidLifecycleUser(first.user.id),
      syncPaidLifecycleUser(second.user.id),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const bound = await getDb()
      .select()
      .from(journeys)
      .where(eq(journeys.contactId, contactId));
    assert.equal(bound.length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith("/events/send")).length, 1);
  },
);
