import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import {
  applyDevSeedOnboardingFixture,
  devSeedOnboardingValues,
} from "../../scripts/devSeedOnboarding.js";
import { getDb } from "../db/index.js";
import { serverMembers, users } from "../db/schema.js";
import { createServer } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const NOW = new Date("2026-07-21T00:00:00.000Z");

test("dev seed defaults to canonical completed onboarding state", () => {
  const values = devSeedOnboardingValues(false, NOW);

  assert.deepEqual(values.user, {
    profileSetupCompletedAt: NOW,
    signupSurveyCompletedAt: NOW,
  });
  assert.deepEqual(values.membership, {
    setupModalReminderOptOut: true,
    onboardingWizardCurrentStep: "complete",
    setupStatus: "complete",
    setupDeferredAt: null,
    setupCompletionReason: "grandfathered",
    setupContractVersion: "onboarding-setup-v2",
  });
});

test("--with-onboarding restores fresh-account and fresh-server gates", () => {
  const values = devSeedOnboardingValues(true, NOW);

  assert.deepEqual(values.user, {
    profileSetupCompletedAt: null,
    signupSurveyCompletedAt: null,
  });
  assert.deepEqual(values.membership, {
    setupModalReminderOptOut: false,
    onboardingWizardCurrentStep: null,
    setupStatus: "not_started",
    setupDeferredAt: null,
    setupCompletionReason: null,
    setupContractVersion: "onboarding-setup-v2",
    setupHandoffAcknowledgedAt: null,
  });
});

test("default reseed preserves existing monotonic account completion timestamps", () => {
  const profileCompletedAt = new Date("2026-07-19T01:00:00.000Z");
  const surveyCompletedAt = new Date("2026-07-19T02:00:00.000Z");

  const values = devSeedOnboardingValues(false, NOW, {
    profileSetupCompletedAt: profileCompletedAt,
    signupSurveyCompletedAt: surveyCompletedAt,
  });

  assert.equal(values.user.profileSetupCompletedAt, profileCompletedAt);
  assert.equal(values.user.signupSurveyCompletedAt, surveyCompletedAt);
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  return user;
}

test("explicit onboarding reseed clears a completed handoff and isolates adjacent memberships", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("raftdev-round-trip-owner");
  const adjacentMember = await seedUser("raftdev-round-trip-adjacent");
  const server = await createServer(
    "Raftdev round trip",
    `raftdev-round-trip-${randomUUID()}`,
    owner.id,
  );
  const adjacentServer = await createServer(
    "Raftdev adjacent server",
    `raftdev-adjacent-${randomUUID()}`,
    owner.id,
  );
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: adjacentMember.id,
    role: "member",
  });

  const handoffAcknowledgedAt = new Date("2026-07-20T00:00:00.000Z");
  await db.update(users).set({
    profileSetupCompletedAt: handoffAcknowledgedAt,
    signupSurveyCompletedAt: handoffAcknowledgedAt,
  }).where(eq(users.id, owner.id));
  await db.update(serverMembers).set({
    setupStatus: "complete",
    setupCompletionReason: "normal",
    setupHandoffAcknowledgedAt: handoffAcknowledgedAt,
  }).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, owner.id),
  ));
  await db.update(serverMembers).set({
    setupHandoffAcknowledgedAt: handoffAcknowledgedAt,
  }).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, adjacentMember.id),
  ));
  await db.update(serverMembers).set({
    setupHandoffAcknowledgedAt: handoffAcknowledgedAt,
  }).where(and(
    eq(serverMembers.serverId, adjacentServer.id),
    eq(serverMembers.userId, owner.id),
  ));

  await applyDevSeedOnboardingFixture(db, {
    userId: owner.id,
    serverId: server.id,
    withOnboarding: true,
    now: NOW,
  });

  const [freshOwner] = await db.select({
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    signupSurveyCompletedAt: users.signupSurveyCompletedAt,
  }).from(users).where(eq(users.id, owner.id));
  assert.equal(freshOwner.profileSetupCompletedAt, null);
  assert.equal(freshOwner.signupSurveyCompletedAt, null);

  const [freshMembership] = await db.select({
    setupStatus: serverMembers.setupStatus,
    setupCompletionReason: serverMembers.setupCompletionReason,
    setupHandoffAcknowledgedAt: serverMembers.setupHandoffAcknowledgedAt,
  }).from(serverMembers).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, owner.id),
  ));
  assert.equal(freshMembership.setupStatus, "not_started");
  assert.equal(freshMembership.setupCompletionReason, null);
  assert.equal(freshMembership.setupHandoffAcknowledgedAt, null);

  const memberships = await db.select({
    serverId: serverMembers.serverId,
    userId: serverMembers.userId,
    setupHandoffAcknowledgedAt: serverMembers.setupHandoffAcknowledgedAt,
  }).from(serverMembers).where(
    eq(serverMembers.setupHandoffAcknowledgedAt, handoffAcknowledgedAt),
  );
  assert.equal(memberships.length, 2, "adjacent membership handoff ACKs stay untouched");
  assert.ok(memberships.some((row) => (
    row.serverId === server.id && row.userId === adjacentMember.id
  )));
  assert.ok(memberships.some((row) => (
    row.serverId === adjacentServer.id && row.userId === owner.id
  )));

  await applyDevSeedOnboardingFixture(db, {
    userId: owner.id,
    serverId: server.id,
    withOnboarding: false,
    now: NOW,
  });
  const [completedOwner] = await db.select({
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    signupSurveyCompletedAt: users.signupSurveyCompletedAt,
  }).from(users).where(eq(users.id, owner.id));
  assert.equal(completedOwner.profileSetupCompletedAt?.toISOString(), NOW.toISOString());
  assert.equal(completedOwner.signupSurveyCompletedAt?.toISOString(), NOW.toISOString());

  const [completedAgain] = await db.select({
    setupStatus: serverMembers.setupStatus,
    setupCompletionReason: serverMembers.setupCompletionReason,
    setupHandoffAcknowledgedAt: serverMembers.setupHandoffAcknowledgedAt,
  }).from(serverMembers).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, owner.id),
  ));
  assert.equal(completedAgain.setupStatus, "complete");
  assert.equal(completedAgain.setupCompletionReason, "grandfathered");
  assert.equal(completedAgain.setupHandoffAcknowledgedAt, null);

  const preservedAdjacentAcks = await db.select({
    serverId: serverMembers.serverId,
    userId: serverMembers.userId,
  }).from(serverMembers).where(
    eq(serverMembers.setupHandoffAcknowledgedAt, handoffAcknowledgedAt),
  );
  assert.equal(preservedAdjacentAcks.length, 2, "round trip stays isolated to the exact membership");
});
