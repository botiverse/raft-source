import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { newsletterAudienceContacts, newsletterWebhookEvents, onboardingEmailJourneys, users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import {
  backfillNewsletterAudience,
  resetNewsletterTestOverrides,
  setNewsletterConfigForTest,
  setNewsletterContactClientForTest,
  syncNewsletterSignup,
} from "./newsletterService.js";
import {
  resetComputerMobileAppEmailJourneyTestOverrides,
  setComputerMobileAppEmailJourneyConfigForTest,
} from "./computerMobileAppEmailJourneyService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const SEGMENT_ID = "78261eea-8f8b-4381-83c6-79fa7120f1cf";
const WEBHOOK_SECRET = `whsec_${Buffer.from("newsletter-webhook-secret").toString("base64")}`;

function signPayload(payload: Buffer, id = "msg_test") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${payload.toString("utf8")}`)
    .digest("base64");
  return {
    id,
    timestamp,
    signature: `v1,${signature}`,
  };
}

async function seedUser(email: string, name: string) {
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

afterEach(async () => {
  resetNewsletterTestOverrides();
  resetComputerMobileAppEmailJourneyTestOverrides();
  await closeTestDatabase().catch(() => {});
});

test("profile-completion newsletter sync is fail-open and records local sync failure", async () => {
  setNewsletterConfigForTest({ apiKey: "re_test", segmentId: SEGMENT_ID });
  setNewsletterContactClientForTest({
    syncContact: async () => {
      throw new Error("resend unavailable");
    },
  });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

  try {
    const res = await fetch(`${app.baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "signup-fail-open@example.com",
        password: "password123",
        name: "signup-fail-open",
        acceptTerms: true,
        termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
        privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { accessToken: string };
    const completeRes = await fetch(`${app.baseUrl}/api/auth/me/complete-profile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "signup-fail-open",
        displayName: "signup-fail-open",
      }),
    });
    assert.equal(completeRes.status, 200);
    const [row] = await getDb()
      .select()
      .from(newsletterAudienceContacts)
      .where(eq(newsletterAudienceContacts.email, "signup-fail-open@example.com"));
    assert.equal(row?.status, "sync_failed");
    assert.match(row?.lastSyncError ?? "", /resend unavailable/);
  } finally {
    await app.close();
  }
});

test("successful signup sync creates a subscribed Resend contact and stores its id", async ({ db }) => {

  const calls: unknown[] = [];
  setNewsletterConfigForTest({ apiKey: "re_test", segmentId: SEGMENT_ID });
  setNewsletterContactClientForTest({
    syncContact: async (input) => {
      calls.push(input);
      return { id: "contact_123" };
    },
  });
  const user = await seedUser("newsletter-user@example.com", "newsletter-user");

  const result = await syncNewsletterSignup(user);

  assert.deepEqual(result, { status: "synced", contactId: "contact_123" });
  assert.deepEqual(calls, [{
    segmentId: SEGMENT_ID,
    email: "newsletter-user@example.com",
    firstName: "newsletter-user",
    unsubscribed: false,
  }]);
  const [row] = await getDb()
    .select()
    .from(newsletterAudienceContacts)
    .where(eq(newsletterAudienceContacts.email, "newsletter-user@example.com"));
  assert.equal(row?.status, "synced");
  assert.equal(row?.resendContactId, "contact_123");
});

test("default Resend client creates a global contact with segment membership", async ({ db }) => {

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  setNewsletterConfigForTest({ apiKey: "re_test", segmentId: SEGMENT_ID, resendMinIntervalMs: 0 });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: "contact_global" }), { status: 200 });
  }) as typeof fetch;

  try {
    const user = await seedUser("global-contact@example.com", "global-contact");
    const result = await syncNewsletterSignup(user, { rateLimited: true });

    assert.deepEqual(result, { status: "synced", contactId: "contact_global" });
    assert.deepEqual(requests, [{
      url: "https://api.resend.com/contacts",
      method: "POST",
      body: {
        email: "global-contact@example.com",
        firstName: "global-contact",
        unsubscribed: false,
        segments: [{ id: SEGMENT_ID }],
      },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default Resend client updates existing contact and idempotently adds it to the segment", async ({ db }) => {

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  setNewsletterConfigForTest({ apiKey: "re_test", segmentId: SEGMENT_ID, resendMinIntervalMs: 0 });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: input.toString(),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ message: "contact already exists" }), { status: 409 });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify({ id: "contact_existing" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "segment_membership" }), { status: 200 });
  }) as typeof fetch;

  try {
    const user = await seedUser("existing@example.com", "existing-user");
    const result = await syncNewsletterSignup(user, { rateLimited: true });

    assert.deepEqual(result, { status: "synced", contactId: "contact_existing" });
    assert.deepEqual(requests, [
      {
        url: "https://api.resend.com/contacts",
        method: "POST",
        body: {
          email: "existing@example.com",
          firstName: "existing-user",
          unsubscribed: false,
          segments: [{ id: SEGMENT_ID }],
        },
      },
      {
        url: "https://api.resend.com/contacts/existing%40example.com",
        method: "PATCH",
        body: {
          unsubscribed: false,
        },
      },
      {
        url: `https://api.resend.com/contacts/existing%40example.com/segments/${SEGMENT_ID}`,
        method: "POST",
        body: undefined,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default Resend client retries retryable Resend rate limits before recording success", async ({ db }) => {

  const originalFetch = globalThis.fetch;
  let attempts = 0;
  setNewsletterConfigForTest({
    apiKey: "re_test",
    segmentId: SEGMENT_ID,
    resendMinIntervalMs: 0,
    resendMaxRetries: 2,
    resendRetryBaseMs: 0,
  });
  globalThis.fetch = (async () => {
    attempts++;
    if (attempts === 1) {
      return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
    }
    return new Response(JSON.stringify({ id: "contact_after_retry" }), { status: 200 });
  }) as typeof fetch;

  try {
    const user = await seedUser("retry-contact@example.com", "retry-contact");
    const result = await syncNewsletterSignup(user, { rateLimited: true });

    assert.equal(attempts, 2);
    assert.deepEqual(result, { status: "synced", contactId: "contact_after_retry" });
    const [row] = await getDb()
      .select()
      .from(newsletterAudienceContacts)
      .where(eq(newsletterAudienceContacts.email, "retry-contact@example.com"));
    assert.equal(row?.status, "synced");
    assert.equal(row?.lastSyncError, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default Resend client records sync failure after retry budget is exhausted", async ({ db }) => {

  const originalFetch = globalThis.fetch;
  let attempts = 0;
  setNewsletterConfigForTest({
    apiKey: "re_test",
    segmentId: SEGMENT_ID,
    resendMinIntervalMs: 0,
    resendMaxRetries: 1,
    resendRetryBaseMs: 0,
  });
  globalThis.fetch = (async () => {
    attempts++;
    return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
  }) as typeof fetch;

  try {
    const user = await seedUser("retry-exhausted@example.com", "retry-exhausted");
    const result = await syncNewsletterSignup(user, { rateLimited: true });

    assert.equal(attempts, 2);
    assert.equal(result.status, "failed");
    const [row] = await getDb()
      .select()
      .from(newsletterAudienceContacts)
      .where(eq(newsletterAudienceContacts.email, "retry-exhausted@example.com"));
    assert.equal(row?.status, "sync_failed");
    assert.match(row?.lastSyncError ?? "", /Too many requests/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("realtime signup sync records retryable rate limits without blocking for retries", async ({ db }) => {

  const originalFetch = globalThis.fetch;
  let attempts = 0;
  setNewsletterConfigForTest({
    apiKey: "re_test",
    segmentId: SEGMENT_ID,
    resendMinIntervalMs: 0,
    resendMaxRetries: 2,
    resendRetryBaseMs: 0,
  });
  globalThis.fetch = (async () => {
    attempts++;
    return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 });
  }) as typeof fetch;

  try {
    const user = await seedUser("realtime-429@example.com", "realtime-429");
    const result = await syncNewsletterSignup(user);

    assert.equal(attempts, 1);
    assert.equal(result.status, "failed");
    const [row] = await getDb()
      .select()
      .from(newsletterAudienceContacts)
      .where(eq(newsletterAudienceContacts.email, "realtime-429@example.com"));
    assert.equal(row?.status, "sync_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend unsubscribe webhook persists local opt-out state idempotently", async () => {
  setNewsletterConfigForTest({ segmentId: SEGMENT_ID, webhookSecret: WEBHOOK_SECRET });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

  try {
    const user = await seedUser("unsubscribe@example.com", "unsubscribe-user");
    const payload = Buffer.from(JSON.stringify({
      type: "contact.updated",
      data: {
        email: "unsubscribe@example.com",
        unsubscribed: true,
      },
    }));
    const headers = signPayload(payload, "msg_unsubscribe");

    const first = await fetch(`${app.baseUrl}/api/webhooks/resend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": headers.id,
        "svix-timestamp": headers.timestamp,
        "svix-signature": headers.signature,
      },
      body: payload,
    });
    const second = await fetch(`${app.baseUrl}/api/webhooks/resend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": headers.id,
        "svix-timestamp": headers.timestamp,
        "svix-signature": headers.signature,
      },
      body: payload,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await first.json() as { processed: boolean }).processed, true);
    assert.equal((await second.json() as { duplicate: boolean }).duplicate, true);
    const [row] = await getDb()
      .select()
      .from(newsletterAudienceContacts)
      .where(and(
        eq(newsletterAudienceContacts.audienceId, SEGMENT_ID),
        eq(newsletterAudienceContacts.email, "unsubscribe@example.com"),
      ));
    assert.equal(row?.userId, user.id);
    assert.equal(row?.status, "unsubscribed");
    assert.ok(row?.optedOutAt);
    const events = await getDb().select().from(newsletterWebhookEvents).where(eq(newsletterWebhookEvents.id, "msg_unsubscribe"));
    assert.equal(events.length, 1);
  } finally {
    await app.close();
  }
});

test("Resend opt-out webhooks cancel already-scheduled mobile lifecycle mail", async () => {
  setNewsletterConfigForTest({ segmentId: SEGMENT_ID, webhookSecret: WEBHOOK_SECRET });
  const canceled: string[] = [];
  setComputerMobileAppEmailJourneyConfigForTest({
    cancelEmail: async (emailId) => {
      canceled.push(emailId);
    },
  });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

  try {
    const cases = [
      { type: "contact.updated", status: "unsubscribed", extra: { unsubscribed: true } },
      { type: "email.bounced", status: "bounced", extra: {} },
      { type: "email.complained", status: "complained", extra: {} },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const email = `scheduled-${item.status}@example.com`;
      const user = await seedUser(email, `scheduled-${item.status}`);
      await getDb().insert(onboardingEmailJourneys).values({
        userId: user.id,
        email,
        journeyKey: "first_computer_mobile_app_48h",
        releaseMode: "all",
        qualifiedAt: new Date("2026-08-22T00:00:00.000Z"),
        day0Status: "skipped",
        day1Status: "scheduled",
        day1EmailId: `scheduled-email-${index}`,
        day1ScheduledAt: new Date("2026-08-24T00:00:00.000Z"),
      });
      const payload = Buffer.from(JSON.stringify({
        type: item.type,
        data: { email, ...item.extra },
      }));
      const headers = signPayload(payload, `msg_cancel_${item.status}`);
      const response = await fetch(`${app.baseUrl}/api/webhooks/resend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": headers.id,
          "svix-timestamp": headers.timestamp,
          "svix-signature": headers.signature,
        },
        body: payload,
      });
      const duplicate = await fetch(`${app.baseUrl}/api/webhooks/resend`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "svix-id": headers.id,
          "svix-timestamp": headers.timestamp,
          "svix-signature": headers.signature,
        },
        body: payload,
      });

      assert.equal(response.status, 200);
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true);
      const [journey] = await getDb().select().from(onboardingEmailJourneys).where(and(
        eq(onboardingEmailJourneys.userId, user.id),
        eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
      ));
      assert.equal(journey?.day1Status, "skipped");
      assert.equal(journey?.suppressedReason, item.status);
      assert.equal(journey?.cancelReason, item.status);
      assert.ok(journey?.canceledAt);
    }

    assert.deepEqual(canceled, ["scheduled-email-0", "scheduled-email-1", "scheduled-email-2"]);
  } finally {
    await app.close();
  }
});

test("failed scheduled-mail cancellation retries the webhook without a second successful side effect", async () => {
  setNewsletterConfigForTest({ segmentId: SEGMENT_ID, webhookSecret: WEBHOOK_SECRET });
  let cancelAttempts = 0;
  let successfulCancellations = 0;
  setComputerMobileAppEmailJourneyConfigForTest({
    cancelEmail: async () => {
      cancelAttempts++;
      if (cancelAttempts === 1) throw new Error("temporary cancellation failure");
      successfulCancellations++;
    },
  });
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

  try {
    const email = "scheduled-retry@example.com";
    const user = await seedUser(email, "scheduled-retry");
    await getDb().insert(onboardingEmailJourneys).values({
      userId: user.id,
      email,
      journeyKey: "first_computer_mobile_app_48h",
      releaseMode: "all",
      qualifiedAt: new Date("2026-08-22T00:00:00.000Z"),
      day0Status: "skipped",
      day1Status: "scheduled",
      day1EmailId: "scheduled-email-retry",
      day1ScheduledAt: new Date("2026-08-24T00:00:00.000Z"),
    });
    const payload = Buffer.from(JSON.stringify({
      type: "contact.updated",
      data: { email, unsubscribed: true },
    }));
    const headers = signPayload(payload, "msg_cancel_retry");
    const request = () => fetch(`${app.baseUrl}/api/webhooks/resend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": headers.id,
        "svix-timestamp": headers.timestamp,
        "svix-signature": headers.signature,
      },
      body: payload,
    });

    const failed = await request();
    assert.equal(failed.status, 400);
    const [stillScheduled] = await getDb().select().from(onboardingEmailJourneys).where(and(
      eq(onboardingEmailJourneys.userId, user.id),
      eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
    ));
    assert.equal(stillScheduled?.day1Status, "scheduled");
    const eventsAfterFailure = await getDb().select().from(newsletterWebhookEvents).where(eq(
      newsletterWebhookEvents.id,
      "msg_cancel_retry",
    ));
    assert.equal(eventsAfterFailure.length, 0);

    const retried = await request();
    assert.equal(retried.status, 200);
    assert.equal((await retried.json() as { processed: boolean }).processed, true);
    assert.equal(cancelAttempts, 2);
    assert.equal(successfulCancellations, 1);
    const [journey] = await getDb().select().from(onboardingEmailJourneys).where(and(
      eq(onboardingEmailJourneys.userId, user.id),
      eq(onboardingEmailJourneys.journeyKey, "first_computer_mobile_app_48h"),
    ));
    assert.equal(journey?.day1Status, "skipped");
    const events = await getDb().select().from(newsletterWebhookEvents).where(eq(
      newsletterWebhookEvents.id,
      "msg_cancel_retry",
    ));
    assert.equal(events.length, 1);
  } finally {
    await app.close();
  }
});

test("newsletter backfill skips existing local opt-outs", async ({ db }) => {

  setNewsletterConfigForTest({ apiKey: "re_test", segmentId: SEGMENT_ID });
  const calls: string[] = [];
  setNewsletterContactClientForTest({
    syncContact: async (input) => {
      calls.push(input.email);
      return { id: `contact-${calls.length}` };
    },
  });
  const included = await seedUser("included@example.com", "included-user");
  const optedOut = await seedUser("opted-out@example.com", "opted-out-user");
  await getDb().insert(newsletterAudienceContacts).values({
    userId: optedOut.id,
    email: optedOut.email,
    audienceId: SEGMENT_ID,
    status: "unsubscribed",
    optedOutAt: new Date(),
  });

  const result = await backfillNewsletterAudience({ batchSize: 10 });

  assert.equal(result.scanned, 1);
  assert.equal(result.synced, 1);
  assert.deepEqual(calls, [included.email]);
});
