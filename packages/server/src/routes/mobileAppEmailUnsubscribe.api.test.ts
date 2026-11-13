import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import {
  newsletterAudienceContacts,
  onboardingEmailJourneys,
  users,
} from "../db/schema";
import {
  resetComputerMobileAppEmailJourneyTestOverrides,
  setComputerMobileAppEmailJourneyConfigForTest,
} from "../services/computerMobileAppEmailJourneyService";
import { MOBILE_APP_EMAIL_AUDIENCE_ID } from "../services/mobileAppEmailUnsubscribeService";
import { createMobileAppEmailUnsubscribeToken } from "../services/mobileAppEmailUnsubscribeToken";

const test = createApiTest({
  humanActivityMuteFlagDefaultEnabled: true,
});

afterEach(() => {
  resetComputerMobileAppEmailJourneyTestOverrides();
});

async function seedUser(db: Database) {
  const [user] = await db.insert(users).values({
    email: "mobile-opt-out@example.com",
    name: "mobile-opt-out",
    displayName: "Mobile Opt Out",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

test("visible and one-click unsubscribe share a signed URL and persist one local opt-out", async ({
  app,
  db,
}) => {
  const user = await seedUser(db);
  const token = createMobileAppEmailUnsubscribeToken(user.id);
  const endpoint = `${app.baseUrl}/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(token)}`;

  const confirmation = await fetch(endpoint);
  assert.equal(confirmation.status, 200);
  assert.match(await confirmation.text(), /Unsubscribe from mobile-app emails\?/);
  assert.equal((await db.select().from(newsletterAudienceContacts)).length, 0);

  const oneClick = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(oneClick.status, 200);
  assert.equal(await oneClick.text(), "");

  const visible = await fetch(`${endpoint}&source=visible`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(visible.status, 200);
  assert.match(await visible.text(), /You are unsubscribed/);

  const rows = await db.select().from(newsletterAudienceContacts).where(eq(
    newsletterAudienceContacts.audienceId,
    MOBILE_APP_EMAIL_AUDIENCE_ID,
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.userId, user.id);
  assert.equal(rows[0]?.email, "mobile-opt-out@example.com");
  assert.equal(rows[0]?.status, "unsubscribed");
  assert.ok(rows[0]?.optedOutAt);
});

test("tampered unsubscribe tokens fail closed without writing contact state", async ({ app, db }) => {
  const user = await seedUser(db);
  const token = createMobileAppEmailUnsubscribeToken(user.id);
  const tampered = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;

  const response = await fetch(
    `${app.baseUrl}/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(tampered)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    },
  );

  assert.equal(response.status, 400);
  assert.equal((await db.select().from(newsletterAudienceContacts)).length, 0);
});

test("the signed locale keeps the confirmation and success states in Simplified Chinese", async ({
  app,
  db,
}) => {
  const user = await seedUser(db);
  const token = createMobileAppEmailUnsubscribeToken(user.id, "zh-CN");
  const endpoint = `${app.baseUrl}/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(token)}`;

  const confirmation = await fetch(endpoint);
  const confirmationHtml = await confirmation.text();
  assert.equal(confirmation.status, 200);
  assert.match(confirmationHtml, /<html lang="zh-CN">/);
  assert.match(confirmationHtml, /要退订移动端应用邮件吗？/);
  assert.match(confirmationHtml, />退订<\/button>/);

  const success = await fetch(`${endpoint}&source=visible`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  const successHtml = await success.text();
  assert.equal(success.status, 200);
  assert.match(successHtml, /<html lang="zh-CN">/);
  assert.match(successHtml, /你已退订。/);
});

test("one-click POST fails closed without the RFC 8058 confirmation body", async ({ app, db }) => {
  const user = await seedUser(db);
  const token = createMobileAppEmailUnsubscribeToken(user.id);

  const response = await fetch(
    `${app.baseUrl}/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );

  assert.equal(response.status, 400);
  assert.equal((await db.select().from(newsletterAudienceContacts)).length, 0);
});

test("unsubscribe cancels an already scheduled mobile-app email through the existing journey path", async ({
  app,
  db,
}) => {
  const user = await seedUser(db);
  await db.insert(onboardingEmailJourneys).values({
    userId: user.id,
    email: user.email,
    journeyKey: "first_computer_mobile_app_48h",
    releaseMode: "all",
    qualifiedAt: new Date("2026-09-15T00:00:00.000Z"),
    day0Status: "skipped",
    day1Status: "scheduled",
    day1EmailId: "scheduled-mobile-email",
    day1ScheduledAt: new Date("2026-09-17T00:00:00.000Z"),
  });
  const canceled: string[] = [];
  setComputerMobileAppEmailJourneyConfigForTest({
    cancelEmail: async (emailId) => {
      canceled.push(emailId);
    },
  });
  const token = createMobileAppEmailUnsubscribeToken(user.id);

  const response = await fetch(
    `${app.baseUrl}/api/email/mobile-app/unsubscribe?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(canceled, ["scheduled-mobile-email"]);
  const [journey] = await db.select().from(onboardingEmailJourneys);
  assert.equal(journey?.day1Status, "skipped");
  assert.equal(journey?.suppressedReason, "unsubscribed");
  assert.ok(journey?.canceledAt);
});
