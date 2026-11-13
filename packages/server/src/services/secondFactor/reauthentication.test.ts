import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import { sessionFamilies, users } from "../../db/schema";
import { isRecentlyReauthenticated, markSessionReauthenticated, REAUTHENTICATION_WINDOW_MS } from "./reauthentication";

afterEach(async () => { await closeTestDatabase(); });

const CREATED = new Date("2026-10-31T12:00:00Z");
const at = (ms: number) => new Date(CREATED.getTime() + ms);

async function seedFamily(): Promise<string> {
  const db = getDb();
  const [user] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
  const [family] = await db.insert(sessionFamilies).values({ userId: user!.id, createdAt: CREATED }).returning();
  return family!.id;
}

test("a sign-in counts as recent for ten minutes, and re-authenticating renews it", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const familyId = await seedFamily();
  assert.equal(await isRecentlyReauthenticated(db, familyId, at(REAUTHENTICATION_WINDOW_MS)), true, "sign-in itself");
  assert.equal(await isRecentlyReauthenticated(db, familyId, at(REAUTHENTICATION_WINDOW_MS + 1)), false);

  const reauthAt = at(60 * 60_000);
  assert.equal(await markSessionReauthenticated(db, familyId, reauthAt), true);
  assert.equal(await isRecentlyReauthenticated(db, familyId, new Date(reauthAt.getTime() + REAUTHENTICATION_WINDOW_MS)), true);
  assert.equal(await isRecentlyReauthenticated(db, familyId, new Date(reauthAt.getTime() + REAUTHENTICATION_WINDOW_MS + 1)), false);
  assert.equal(await isRecentlyReauthenticated(db, familyId, new Date(reauthAt.getTime() + 60_000), 30_000), false, "custom window");

  assert.equal(await isRecentlyReauthenticated(db, randomUUID(), CREATED), false, "unknown family");
});

test("a revoked or retired sign-in is never recent and cannot be marked", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const revoked = await seedFamily();
  const retired = await seedFamily();
  await db.update(sessionFamilies).set({ revokedAt: CREATED }).where(eq(sessionFamilies.id, revoked));
  await db.update(sessionFamilies).set({ retiredAt: CREATED, retiredReason: "migration" }).where(eq(sessionFamilies.id, retired));
  for (const familyId of [revoked, retired]) {
    assert.equal(await markSessionReauthenticated(db, familyId, CREATED), false);
    assert.equal(await isRecentlyReauthenticated(db, familyId, CREATED), false);
  }
});

test("a device login's sign-in never counts as recent and cannot be marked, however fresh", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const device = await seedFamily();
  await db.update(sessionFamilies).set({ scope: "device" }).where(eq(sessionFamilies.id, device));
  assert.equal(await isRecentlyReauthenticated(db, device, CREATED), false, "created this instant");
  assert.equal(await markSessionReauthenticated(db, device, CREATED), false);
  const [row] = await db.select({ reauthenticatedAt: sessionFamilies.reauthenticatedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, device));
  assert.equal(row!.reauthenticatedAt, null);
});
