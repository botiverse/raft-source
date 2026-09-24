import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
/**
 * Selection contract for `listUndismissedForUser` after the 2026-08-07 change:
 * the OLDEST still-live announcement the user has not finished reading wins.
 *
 * ⚠️ These tests deliberately pin the REPLACEMENT of an earlier invariant.
 * Before this change the newest started row was authoritative and an older
 * campaign could never resurface. @cindyz decided the opposite. A future reader
 * who finds the old "never resurrects an older campaign" comment in git history
 * should NOT treat `oldest-first` as a regression to be fixed back.
 */
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { dismiss, listUndismissedForUser, publish } from "./announcementService.js";


afterEach(async () => {
  await closeTestDatabase();
});

const FAMILY = "30000000-0000-4000-8000-00000000000a";

async function seedEligibleUser(email: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name: email.split("@")[0],
    displayName: "Oldest First",
    passwordHash: "hash",
    emailVerified: true,
    // Eligible: completed onboarding in a DIFFERENT login family than the one we query with.
    firstOnboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    firstOnboardingCompletedSessionFamilyId: "30000000-0000-4000-8000-00000000000b",
  }).returning();
  return user;
}

const page = [{ body: "b" }] as never;

test("① an OLDER unread announcement wins over a NEWER one the user already read", async ({ db }) => {

  const user = await seedEligibleUser("oldest-first-1@example.com");

  const older = await publish({ title: "older", pages: page, startsAt: new Date("2026-02-01T00:00:00Z") });
  const newer = await publish({ title: "newer", pages: page, startsAt: new Date("2026-03-01T00:00:00Z") });

  assert.equal(await dismiss(user.id, newer.id), true, "precondition: the newer one is marked read");

  const got = await listUndismissedForUser(user.id, FAMILY);
  assert.equal(got.length, 1, "the older unread row must still be delivered");
  assert.equal(
    got[0].id,
    older.id,
    "oldest-first: reading the newer announcement must not bury the older unread one",
  );
});

test("② when every live announcement has been read, nothing is returned", async ({ db }) => {

  const user = await seedEligibleUser("oldest-first-2@example.com");

  const a = await publish({ title: "a", pages: page, startsAt: new Date("2026-02-01T00:00:00Z") });
  const b = await publish({ title: "b", pages: page, startsAt: new Date("2026-03-01T00:00:00Z") });
  await dismiss(user.id, a.id);
  await dismiss(user.id, b.id);

  assert.deepEqual(await listUndismissedForUser(user.id, FAMILY), []);
});

test("③ rows outside the visibility window do not participate", async ({ db }) => {

  const user = await seedEligibleUser("oldest-first-3@example.com");

  // Oldest, but already ended -> must be skipped rather than winning on age.
  await publish({
    title: "ended",
    pages: page,
    startsAt: new Date("2026-01-01T00:00:00Z"),
    endsAt: new Date("2026-01-02T00:00:00Z"),
  });
  // Not started yet -> must not be delivered early.
  await publish({ title: "future", pages: page, startsAt: new Date("2099-01-01T00:00:00Z") });
  const live = await publish({ title: "live", pages: page, startsAt: new Date("2026-02-01T00:00:00Z") });

  const got = await listUndismissedForUser(user.id, FAMILY);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, live.id, "an ended row must not win merely by being oldest");
});

test("④ with two UNREAD announcements the OLDER one is delivered first", async ({ db }) => {

  const user = await seedEligibleUser("oldest-first-4@example.com");

  // Neither is dismissed, so the dismissal filter cannot decide this case.
  // Only the ORDER BY direction can — which is exactly what this test pins.
  // (Tests ①–③ all still pass if `asc` is flipped back to `desc`; found by
  // asking "which mutation would redden this?" rather than by the suite going green.)
  const older = await publish({ title: "older", pages: page, startsAt: new Date("2026-02-01T00:00:00Z") });
  await publish({ title: "newer", pages: page, startsAt: new Date("2026-03-01T00:00:00Z") });

  const got = await listUndismissedForUser(user.id, FAMILY);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, older.id, "ordering must be oldest-first, not newest-first");
});

test("⑤ a request-scoped frontier advances to the next unread row without dismissing the oldest", async ({ db }) => {

  const user = await seedEligibleUser("oldest-first-5@example.com");

  const older = await publish({ title: "older", pages: page, startsAt: new Date("2026-02-01T00:00:00Z") });
  const newer = await publish({ title: "newer", pages: page, startsAt: new Date("2026-03-01T00:00:00Z") });

  const advanced = await listUndismissedForUser(user.id, FAMILY, undefined, older.id);
  assert.deepEqual(
    advanced.map((announcement) => announcement.id),
    [newer.id],
    "advancing past the failed oldest write must select the next unread row before LIMIT 1",
  );
  assert.deepEqual(
    (await listUndismissedForUser(user.id, FAMILY)).map((announcement) => announcement.id),
    [older.id],
    "the frontier is request-scoped and must not create a durable dismissal",
  );
});
