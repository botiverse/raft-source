import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { serverMembers, servers, users } from "../db/schema.js";
import { markSetupHandoffAcknowledged } from "./serverService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("setup handoff stamps the account-global announcement gate once", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "announcement-gate-owner@example.com",
    name: "announcement-gate-owner",
    displayName: "Announcement Gate Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [firstServer, secondServer] = await db.insert(servers).values([
    { name: "First", slug: "announcement-gate-first", ownerId: owner.id },
    { name: "Second", slug: "announcement-gate-second", ownerId: owner.id },
  ]).returning();
  await db.insert(serverMembers).values([
    { serverId: firstServer.id, userId: owner.id, role: "owner" },
    { serverId: secondServer.id, userId: owner.id, role: "owner" },
  ]);

  const firstFamilyId = "10000000-0000-4000-8000-000000000001";
  const secondFamilyId = "10000000-0000-4000-8000-000000000002";
  await markSetupHandoffAcknowledged(firstServer.id, owner.id, firstFamilyId);

  const [afterFirst] = await db.select({
    completedAt: users.firstOnboardingCompletedAt,
    completionFamilyId: users.firstOnboardingCompletedSessionFamilyId,
  }).from(users).where(eq(users.id, owner.id));
  assert.ok(afterFirst.completedAt);
  assert.equal(afterFirst.completionFamilyId, firstFamilyId);

  await markSetupHandoffAcknowledged(secondServer.id, owner.id, secondFamilyId);
  const [afterSecond] = await db.select({
    completedAt: users.firstOnboardingCompletedAt,
    completionFamilyId: users.firstOnboardingCompletedSessionFamilyId,
  }).from(users).where(eq(users.id, owner.id));
  assert.equal(afterSecond.completedAt?.toISOString(), afterFirst.completedAt.toISOString());
  assert.equal(
    afterSecond.completionFamilyId,
    firstFamilyId,
    "later server handoffs cannot move the account-global gate",
  );

  for (const serverId of [firstServer.id, secondServer.id]) {
    const [membership] = await db.select({
      acknowledgedAt: serverMembers.setupHandoffAcknowledgedAt,
    }).from(serverMembers).where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, owner.id),
    ));
    assert.ok(membership.acknowledgedAt, "each server keeps its own handoff receipt");
  }
});
