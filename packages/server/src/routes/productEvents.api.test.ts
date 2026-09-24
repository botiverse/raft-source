import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { productEvents, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedVerifiedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

test("POST /product-events/onboarding-wizard records a sanitized core wizard event", async ({ app }) => {
  const owner = await seedVerifiedUser("onboarding-event-owner@slock.test", "onboarding-event-owner");
  const server = await createServer("Onboarding Event Contract", "onboarding-event-contract", owner.id);
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/product-events/onboarding-wizard`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      eventType: "onboarding_wizard.primary_clicked",
      idempotencyKey: "onboarding-event-test-primary",
      metadata: {
        step_id: "referral-source",
        wizard_version: "owner-wizard-v3",
        session_id: "session-123",
        action: "submit_referral",
        result: "twitter_x",
        reason: "ignored-but-allowed",
        latency_ms: 123.4,
        raw_text: "must not be stored",
      },
    }),
  });
  assert.equal(res.status, 204, `record event must succeed (status=${res.status})`);

  const rows = await getDb().select().from(productEvents).where(
    and(
      eq(productEvents.subjectType, "onboarding_wizard"),
      eq(productEvents.subjectId, server.id),
      eq(productEvents.eventType, "onboarding_wizard.primary_clicked"),
    ),
  );

  assert.equal(rows.length, 1);
  const [event] = rows;
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, owner.id);
  assert.equal(event.source, "web");
  assert.equal(event.idempotencyKey, "onboarding-event-test-primary");
  assert.deepEqual(event.metadata, {
    step_id: "referral-source",
    wizard_version: "owner-wizard-v3",
    session_id: "session-123",
    action: "submit_referral",
    result: "twitter_x",
    reason: "ignored-but-allowed",
    latency_ms: 123,
  });
});

test("POST /product-events/onboarding-wizard rejects untracked push-notification steps", async ({ app }) => {
  const owner = await seedVerifiedUser("onboarding-event-push@slock.test", "onboarding-event-push");
  const server = await createServer("Onboarding Push Exclusion", "onboarding-push-exclusion", owner.id);
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/product-events/onboarding-wizard`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      eventType: "onboarding_wizard.step_shown",
      metadata: {
        step_id: "enable-notifications",
        wizard_version: "owner-wizard-v3",
        session_id: "session-123",
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? "", /tracked onboarding wizard step/i);

  const rows = await getDb().select().from(productEvents).where(eq(productEvents.subjectId, server.id));
  assert.equal(rows.length, 0);
});
