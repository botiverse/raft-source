import { fixturePasswordHash } from "../test/integration/credentials";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { newsletterAudienceContacts, onboardingEmailJourneys, users } from "../db/schema";
import {
  enqueueOnboardingEmailJourneyForUser,
  isOnboardingEmailJourneyEnabled,
  resetOnboardingEmailJourneyTestOverrides,
  setOnboardingEmailJourneyConfigForTest,
} from "./onboardingEmailJourneyService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "./emailService";


async function seedVerifiedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function getJourneysForUser(userId: string) {
  return getDb().select()
    .from(onboardingEmailJourneys)
    .where(eq(onboardingEmailJourneys.userId, userId));
}

afterEach(async () => {
  __setEmailDeliveryObserverForTests(null);
  resetOnboardingEmailJourneyTestOverrides();
  await closeTestDatabase().catch(() => {});
});

test("both onboarding deliveries use only a usable display name, never a username fallback", async ({ db }) => {
  const now = new Date("2026-11-19T00:00:00.000Z");
  setOnboardingEmailJourneyConfigForTest({ mode: "all", now, day1DelayHours: 24 });
  const cases = [
    { name: "pending_0123456789abcdef0123", displayName: null, greeting: "Hi there," },
    { name: "ordinary-handle", displayName: "  ", greeting: "Hi there," },
    { name: "pending_123456789abcdef01234", displayName: "  Avery Chen  ", greeting: "Hi Avery Chen," },
    { name: "ordinary-handle-two", displayName: " PeNdInG_abcdef0123456789abcd ", greeting: "Hi there," },
  ];
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));

  for (const [index, value] of cases.entries()) {
    const [user] = await db.insert(users).values({
      email: `greeting-${index}@example.com`,
      name: value.name,
      displayName: value.displayName,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    const before = deliveries.length;
    assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(user), { status: "started" });
    const sent = deliveries.slice(before);
    assert.equal(sent.length, 2);
    for (const delivery of sent) {
      assert.ok(delivery.html.includes(value.greeting));
      assert.ok(!delivery.html.includes(value.name));
      assert.doesNotMatch(delivery.html, /pending_/i);
    }
    assert.equal(sent[1].subject, "How's it going with Raft?");
    assert.equal(sent[1].scheduledAt, "2026-11-20T00:00:00.000Z");
    assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(user), { status: "already_started" });
    assert.equal(deliveries.length, before + 2);
  }
});

test("onboarding email journey starts for verified users by default", async ({ db }) => {

  const user = await seedVerifiedUser("journey-default@example.com", "journey-default");
  const originalLog = console.log;
  console.log = () => {};

  try {
    assert.equal(isOnboardingEmailJourneyEnabled(), true);
    const result = await enqueueOnboardingEmailJourneyForUser(user);

    assert.deepEqual(result, { status: "started" });
    const [journey] = await getJourneysForUser(user.id);
    assert.equal(journey?.releaseMode, "all");
    assert.equal(journey?.day0Status, "sent");
    assert.equal(journey?.day1Status, "scheduled");
  } finally {
    console.log = originalLog;
  }
});

test("explicit disabled mode creates no ledger row", async ({ db }) => {

  setOnboardingEmailJourneyConfigForTest({ mode: "disabled" });
  const user = await seedVerifiedUser("journey-disabled@example.com", "journey-disabled");

  assert.equal(isOnboardingEmailJourneyEnabled(), false);
  const result = await enqueueOnboardingEmailJourneyForUser(user);

  assert.deepEqual(result, { status: "skipped", reason: "disabled" });
  assert.deepEqual(await getJourneysForUser(user.id), []);
});

test("dry-run mode records the planned journey without sending", async ({ db }) => {

  const now = new Date("2026-07-02T00:00:00.000Z");
  setOnboardingEmailJourneyConfigForTest({ mode: "dry_run", day1DelayHours: 24, now });
  const user = await seedVerifiedUser("journey-dry-run@example.com", "journey-dry-run");

  assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(user), { status: "dry_run" });

  const [journey] = await getJourneysForUser(user.id);
  assert.equal(journey?.releaseMode, "dry_run");
  assert.equal(journey?.day0Status, "dry_run");
  assert.equal(journey?.day1Status, "dry_run");
  assert.equal(journey?.qualifiedAt.toISOString(), now.toISOString());
  assert.equal(journey?.day1ScheduledAt?.toISOString(), "2026-07-03T00:00:00.000Z");
  assert.equal(journey?.day0EmailId, null);
  assert.equal(journey?.day1EmailId, null);
});

test("allowlist mode blocks non-allowlisted users and starts allowlisted journeys", async ({ db }) => {

  const now = new Date("2026-07-02T00:00:00.000Z");
  setOnboardingEmailJourneyConfigForTest({
    mode: "allowlist",
    allowlist: ["allowed@example.com"],
    now,
  });
  const blocked = await seedVerifiedUser("blocked@example.com", "blocked");
  const allowed = await seedVerifiedUser("allowed@example.com", "allowed");
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(
      await enqueueOnboardingEmailJourneyForUser(blocked),
      { status: "skipped", reason: "not_allowlisted" },
    );
    assert.deepEqual(await getJourneysForUser(blocked.id), []);

    assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(allowed), { status: "started" });
    const [journey] = await getJourneysForUser(allowed.id);
    assert.equal(journey?.releaseMode, "allowlist");
    assert.equal(journey?.day0Status, "sent");
    assert.equal(journey?.day1Status, "scheduled");
  } finally {
    console.log = originalLog;
  }
});

test("production mode starts Day 0 immediately and schedules Day 1 idempotently", async ({ db }) => {

  const now = new Date("2026-07-02T00:00:00.000Z");
  setOnboardingEmailJourneyConfigForTest({ mode: "all", day1DelayHours: 24, now });
  const user = await seedVerifiedUser("journey-user@example.com", "journey-user");
  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(user), { status: "started" });
    assert.deepEqual(await enqueueOnboardingEmailJourneyForUser(user), { status: "already_started" });

    const journeys = await getJourneysForUser(user.id);
    assert.equal(journeys.length, 1);
    const journey = journeys[0];
    assert.equal(journey?.releaseMode, "all");
    assert.equal(journey?.day0Status, "sent");
    assert.equal(journey?.day0SentAt?.toISOString(), now.toISOString());
    assert.equal(journey?.day1Status, "scheduled");
    assert.equal(journey?.day1ScheduledAt?.toISOString(), "2026-07-03T00:00:00.000Z");
    assert.equal(journey?.lastError, null);
  } finally {
    console.log = originalLog;
  }
});

test("newsletter opt-out suppresses onboarding journey sends", async ({ db }) => {

  const now = new Date("2026-07-02T00:00:00.000Z");
  setOnboardingEmailJourneyConfigForTest({ mode: "all", now });
  const user = await seedVerifiedUser("journey-optout@example.com", "journey-optout");
  await getDb().insert(newsletterAudienceContacts).values({
    userId: user.id,
    email: user.email,
    audienceId: "newsletter-segment",
    status: "unsubscribed",
    optedOutAt: new Date("2026-07-01T00:00:00.000Z"),
  });

  const result = await enqueueOnboardingEmailJourneyForUser(user);

  assert.deepEqual(result, { status: "skipped", reason: "unsubscribed" });
  const [journey] = await getJourneysForUser(user.id);
  assert.equal(journey?.day0Status, "skipped");
  assert.equal(journey?.day1Status, "skipped");
  assert.equal(journey?.suppressedReason, "unsubscribed");
  assert.equal(journey?.cancelReason, "unsubscribed");
  assert.equal(journey?.canceledAt?.toISOString(), now.toISOString());
});
