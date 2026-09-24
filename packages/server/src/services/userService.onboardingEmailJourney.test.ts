import { fixturePasswordHash } from "../test/integration/credentials.js";
import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { CURRENT_LEGAL_ACCEPTANCE } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { emailVerifications, onboardingEmailJourneys, users } from "../db/schema.js";
import {
  resetOnboardingEmailJourneyTestOverrides,
  setOnboardingEmailJourneyConfigForTest,
} from "./onboardingEmailJourneyService.js";
import { completeProfile, createSocialUser, verifyEmail } from "./userService.js";


function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

afterEach(async () => {
  resetOnboardingEmailJourneyTestOverrides();
  await closeTestDatabase().catch(() => {});
});

test("verified social signup enqueues onboarding welcome when journey is enabled", async ({ db }) => {

  setOnboardingEmailJourneyConfigForTest({ mode: "dry_run" });

  const user = await createSocialUser(
    {
      provider: "google",
      providerUserId: "google-onboarding-1",
      email: "social-onboarding@example.com",
      emailVerified: true,
      displayName: "Social User",
      avatarUrl: null,
    },
    {
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
  );

  const [journey] = await getDb().select()
    .from(onboardingEmailJourneys)
    .where(eq(onboardingEmailJourneys.userId, user.id));
  assert.equal(journey?.journeyKey, "new_user_day0_day1");
  assert.equal(journey?.day0Status, "dry_run");
  assert.equal(journey?.day1Status, "dry_run");
});

test("pending social signup defers name-dependent onboarding until profile completion", async ({ db }) => {

  setOnboardingEmailJourneyConfigForTest({ mode: "dry_run" });

  const user = await createSocialUser(
    {
      provider: "google",
      providerUserId: "google-onboarding-pending",
      email: "social-onboarding-pending@example.com",
      emailVerified: true,
      displayName: "Pending Social User",
      avatarUrl: null,
    },
    {
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
    {},
    "oauth",
    { deferProfileSetup: true },
  );

  assert.match(user.name, /^pending_[0-9a-f]{20}$/);
  assert.equal(user.profileSetupCompletedAt, null);
  assert.equal(
    (await getDb().select().from(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.userId, user.id))).length,
    0,
  );

  await completeProfile(user.id, { name: "social-final", displayName: "Social Final" });
  assert.equal(
    (await getDb().select().from(onboardingEmailJourneys).where(eq(onboardingEmailJourneys.userId, user.id))).length,
    1,
  );
});

test("pending Apple signup aligns its display name with the suggested public handle", async ({ db }) => {
  const user = await createSocialUser(
    {
      provider: "apple",
      providerUserId: "apple-onboarding-missing-name",
      email: "apple-missing-name@example.com",
      emailVerified: true,
      displayName: null,
      avatarUrl: null,
    },
    {
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    },
    {},
    "oauth",
    { deferProfileSetup: true },
  );

  assert.match(user.name, /^pending_[0-9a-f]{20}$/);
  assert.equal(user.displayName, "apple-missing-name");
  assert.equal(user.profileSetupSuggestedHandle, "apple-missing-name");

  const completed = await completeProfile(user.id, {
    name: "apple-final-handle",
    displayName: "Apple Display Name",
  });
  assert.equal(completed.name, "apple-final-handle");
  assert.equal(completed.displayName, "Apple Display Name");
});

test("email verification enqueues onboarding welcome after marking the user verified", async ({ db }) => {

  setOnboardingEmailJourneyConfigForTest({ mode: "dry_run" });
  const token = "verify-onboarding-token";
  const [user] = await getDb().insert(users).values({
    email: "verify-onboarding@example.com",
    name: "verify-onboarding",
    displayName: "Verify User",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: false,
    profileSetupCompletedAt: new Date(),
  }).returning();
  await getDb().insert(emailVerifications).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 60_000),
  });

  assert.equal(await verifyEmail(token), true);

  const [verifiedUser] = await getDb().select()
    .from(users)
    .where(eq(users.id, user.id));
  assert.equal(verifiedUser?.emailVerified, true);
  const [journey] = await getDb().select()
    .from(onboardingEmailJourneys)
    .where(eq(onboardingEmailJourneys.userId, user.id));
  assert.equal(journey?.journeyKey, "new_user_day0_day1");
  assert.equal(journey?.day0Status, "dry_run");
  assert.equal(journey?.day1Status, "dry_run");
});
