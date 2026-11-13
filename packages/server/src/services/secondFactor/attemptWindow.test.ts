import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../../test/integration/database";
import { getDb } from "../../db/index";
import { reauthAttemptWindows, secondFactorAttemptWindows, users } from "../../db/schema";
import {
  claimReauthAttempt,
  claimSecondFactorAttempt,
  releaseReauthAttempt,
  releaseSecondFactorAttempt,
  SECOND_FACTOR_LOCK_MS,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_WINDOW_MS,
} from "./attemptWindow";

afterEach(async () => { await closeTestDatabase(); });

const T0 = new Date("2026-10-31T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

async function seedUser(): Promise<string> {
  const [user] = await getDb().insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(), passwordHash: "test-only" }).returning();
  return user!.id;
}

test("ten failed claims an hour, then the eleventh starts a 15-minute lock", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const userId = await seedUser();
  const otherId = await seedUser();
  for (let claim = 1; claim <= SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) {
    assert.deepEqual(await claimSecondFactorAttempt(db, userId, at(claim * 60_000)), { ok: true }, `claim ${claim}`);
  }
  const lockAt = at(30 * 60_000);
  assert.deepEqual(await claimSecondFactorAttempt(db, userId, lockAt), {
    ok: false, lockedUntil: new Date(lockAt.getTime() + SECOND_FACTOR_LOCK_MS), lockStarted: true,
  });
  // While locked: refused with the same end, and only the first refusal started it.
  assert.deepEqual(await claimSecondFactorAttempt(db, userId, at(40 * 60_000)), {
    ok: false, lockedUntil: new Date(lockAt.getTime() + SECOND_FACTOR_LOCK_MS), lockStarted: false,
  });
  // Another person is not affected.
  assert.deepEqual(await claimSecondFactorAttempt(db, otherId, lockAt), { ok: true });
  // When the lock ends, a fresh window starts.
  const afterLock = new Date(lockAt.getTime() + SECOND_FACTOR_LOCK_MS);
  assert.deepEqual(await claimSecondFactorAttempt(db, userId, afterLock), { ok: true });
  const [row] = await db.select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, userId));
  assert.deepEqual(row, { userId, windowStartedAt: afterLock, attempts: 1, lockedUntil: null });
});

test("the window starts over an hour after it started", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const userId = await seedUser();
  for (let claim = 0; claim < SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) {
    assert.deepEqual(await claimSecondFactorAttempt(db, userId, T0), { ok: true });
  }
  // Just inside the hour the eleventh is refused; at the hour it is a fresh window.
  const other = await seedUser();
  for (let claim = 0; claim < SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) await claimSecondFactorAttempt(db, other, T0);
  assert.equal((await claimSecondFactorAttempt(db, other, at(SECOND_FACTOR_WINDOW_MS - 1))).ok, false);
  assert.deepEqual(await claimSecondFactorAttempt(db, userId, at(SECOND_FACTOR_WINDOW_MS)), { ok: true });
  const [row] = await db.select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, userId));
  assert.deepEqual(row, { userId, windowStartedAt: at(SECOND_FACTOR_WINDOW_MS), attempts: 1, lockedUntil: null });
});

test("claims racing for one person: exactly ten get through, one starts the lock", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  const results = await Promise.all(Array.from({ length: 30 }, () => claimSecondFactorAttempt(getDb(), userId, T0)));
  assert.equal(results.filter((result) => result.ok).length, SECOND_FACTOR_MAX_ATTEMPTS);
  assert.equal(results.filter((result) => !result.ok && result.lockStarted).length, 1);
});

test("the window goes with its user", async () => {
  await openTestDatabase("pglite://");
  const userId = await seedUser();
  await claimSecondFactorAttempt(getDb(), userId, T0);
  await getDb().delete(users).where(eq(users.id, userId));
  assert.deepEqual(await getDb().select().from(secondFactorAttemptWindows), []);
});

test("right answers give their claim back: 20 sign-ins in an hour never lock", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const userId = await seedUser();
  for (let cycle = 1; cycle <= 2 * SECOND_FACTOR_MAX_ATTEMPTS; cycle += 1) {
    const now = at(cycle * 60_000);
    assert.deepEqual(await claimSecondFactorAttempt(db, userId, now), { ok: true }, `cycle ${cycle}`);
    await db.transaction((tx) => releaseSecondFactorAttempt(tx, userId, now));
  }
  const [row] = await db.select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, userId));
  assert.equal(row!.attempts, 0);
  assert.equal(row!.lockedUntil, null);
  // Never below zero.
  await releaseSecondFactorAttempt(db, userId, T0);
  const [after] = await db.select({ attempts: secondFactorAttemptWindows.attempts }).from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, userId));
  assert.equal(after!.attempts, 0);
  // A release for someone with no window does nothing.
  await releaseSecondFactorAttempt(db, await seedUser(), T0);
});

test("a release after the lock does not unlock", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const userId = await seedUser();
  for (let claim = 0; claim < SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) await claimSecondFactorAttempt(db, userId, T0);
  const locked = await claimSecondFactorAttempt(db, userId, T0);
  assert.equal(locked.ok, false);
  await releaseSecondFactorAttempt(db, userId, T0);
  await releaseSecondFactorAttempt(db, userId, T0);
  assert.deepEqual(await claimSecondFactorAttempt(db, userId, at(60_000)), {
    ok: false, lockedUntil: new Date(T0.getTime() + SECOND_FACTOR_LOCK_MS), lockStarted: false,
  });
});

test("re-authentication is counted apart: neither lock blocks the other", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const reauthLocked = await seedUser();
  for (let claim = 1; claim <= SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) {
    assert.deepEqual(await claimReauthAttempt(db, reauthLocked, T0), { ok: true }, `claim ${claim}`);
  }
  assert.deepEqual(await claimReauthAttempt(db, reauthLocked, T0), {
    ok: false, lockedUntil: new Date(T0.getTime() + SECOND_FACTOR_LOCK_MS), lockStarted: true,
  });
  // Wrong passwords from a stolen session leave the second step open.
  assert.deepEqual(await claimSecondFactorAttempt(db, reauthLocked, T0), { ok: true });
  assert.deepEqual(await db.select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, reauthLocked)), [
    { userId: reauthLocked, windowStartedAt: T0, attempts: 1, lockedUntil: null },
  ]);

  const secondFactorLocked = await seedUser();
  for (let claim = 0; claim <= SECOND_FACTOR_MAX_ATTEMPTS; claim += 1) await claimSecondFactorAttempt(db, secondFactorLocked, T0);
  assert.equal((await claimSecondFactorAttempt(db, secondFactorLocked, T0)).ok, false);
  assert.deepEqual(await claimReauthAttempt(db, secondFactorLocked, T0), { ok: true });

  // A release gives back only its own window's claim.
  await releaseReauthAttempt(db, secondFactorLocked, T0);
  const [reauth] = await db.select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, secondFactorLocked));
  assert.equal(reauth!.attempts, 0);
  const [secondStep] = await db.select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, secondFactorLocked));
  assert.equal(secondStep!.attempts, SECOND_FACTOR_MAX_ATTEMPTS + 1);
  assert.ok(secondStep!.lockedUntil);

  // It goes with its user too.
  await db.delete(users).where(eq(users.id, reauthLocked));
  assert.deepEqual(await db.select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, reauthLocked)), []);
});
