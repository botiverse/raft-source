import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
/**
 * Announcement versions (task #38, #wg-announcement:f455efa7): a later published
 * version replaces earlier ones once it starts, and whether a dismissal of an
 * earlier version carries over is the version's `dismissalFloorVersion`.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  isAnnouncementDismissedBySeries,
  isAnnouncementVersionActive,
} from "@botiverse/raft-shared/announcement-version-rules";
import { getDb } from "../db/index";
import { announcements, userAnnouncementDismissals, users } from "../db/schema";
import {
  announcementActiveVersionSql,
  announcementUndismissedBySeriesSql,
  dismiss,
  listUndismissedForUser,
  publish,
} from "./announcementService";

afterEach(async () => {
  await closeTestDatabase();
});

const FAMILY = "30000000-0000-4000-8000-00000000003a";
const page = [{ body: "b" }] as never;

async function seedUser(db: ReturnType<typeof getDb>, email: string) {
  const [user] = await db.insert(users).values({
    email,
    name: email.split("@")[0],
    displayName: "Versions",
    passwordHash: "hash",
    emailVerified: true,
    firstOnboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    firstOnboardingCompletedSessionFamilyId: "30000000-0000-4000-8000-00000000003b",
  }).returning();
  return user;
}

async function version(
  title: string,
  startsAt: string,
  series?: { seriesId: string; version: number; dismissalFloorVersion: number },
) {
  const row = await publish({ title, pages: page, startsAt: new Date(startsAt) });
  if (series) await getDb().update(announcements).set(series).where(eq(announcements.id, row.id));
  return row;
}

const NOW = new Date("2026-06-01T00:00:00Z");
const ids = async (userId: string, now = NOW) => (await listUndismissedForUser(userId, FAMILY, now)).map((row) => row.id);

test("a started later version replaces the earlier one; a scheduled one does not yet", async ({ db }) => {
  const user = await seedUser(db, "versions-1@example.com");
  const v1 = await version("v1", "2026-01-01");
  const v2 = await version("v2", "2026-07-01", { seriesId: v1.id, version: 2, dismissalFloorVersion: 2 });
  assert.deepEqual(await ids(user.id), [v1.id], "v2 is scheduled, so v1 still shows");
  assert.deepEqual(await ids(user.id, new Date("2026-07-02T00:00:00Z")), [v2.id], "never both, never a gap");
  assert.equal(await dismiss(user.id, v1.id, new Date("2026-07-02T00:00:00Z")), false, "a replaced version cannot be dismissed");
  await getDb().update(announcements).set({ status: "expired", endsAt: new Date("2026-07-03T00:00:00Z") }).where(eq(announcements.id, v2.id));
  assert.deepEqual(await ids(user.id, new Date("2026-07-04T00:00:00Z")), [], "ending v2 does not bring v1 back");
});

test("show again: someone who dismissed v1 sees v2", async ({ db }) => {
  const user = await seedUser(db, "versions-2@example.com");
  const v1 = await version("v1", "2026-01-01");
  assert.equal(await dismiss(user.id, v1.id, NOW), true);
  const v2 = await version("v2", "2026-05-01", { seriesId: v1.id, version: 2, dismissalFloorVersion: 2 });
  assert.deepEqual(await ids(user.id), [v2.id]);
});

test("don't show again: a dismissal from the floor on carries, one before a show-again version does not", async ({ db }) => {
  const dismissedV1 = await seedUser(db, "versions-3a@example.com");
  const fresh = await seedUser(db, "versions-3b@example.com");
  const v1 = await version("v1", "2026-01-01");
  assert.equal(await dismiss(dismissedV1.id, v1.id, new Date("2026-02-01T00:00:00Z")), true);
  // v2: typo fix, carries v1 dismissals.
  const v2 = await version("v2", "2026-03-01", { seriesId: v1.id, version: 2, dismissalFloorVersion: 1 });
  assert.deepEqual(await ids(dismissedV1.id, new Date("2026-03-02T00:00:00Z")), [], "dismissed v1, v2 only fixes a typo");
  assert.deepEqual(await ids(fresh.id, new Date("2026-03-02T00:00:00Z")), [v2.id]);
  // v3: show again; v4: typo fix on top of v3 (floor 3), so the v1 dismissal no longer counts.
  const v3 = await version("v3", "2026-04-01", { seriesId: v1.id, version: 3, dismissalFloorVersion: 3 });
  assert.deepEqual(await ids(dismissedV1.id, new Date("2026-04-02T00:00:00Z")), [v3.id]);
  const v4 = await version("v4", "2026-05-01", { seriesId: v1.id, version: 4, dismissalFloorVersion: 3 });
  assert.deepEqual(await ids(dismissedV1.id), [v4.id], "the v1 dismissal is before the floor");
  assert.equal(await dismiss(fresh.id, v4.id, NOW), true);
  assert.deepEqual(await ids(fresh.id), []);
});

test("SQL delivery predicates stay in exact lockstep with shared isAnnouncementVersionActive and isAnnouncementDismissedBySeries across mixed series states", async ({ db }) => {
  const readerA = await seedUser(db, "parity-a@example.com");
  const readerB = await seedUser(db, "parity-b@example.com");
  const freshReader = await seedUser(db, "parity-fresh@example.com");

  const insertMember = async (opts: {
    title: string;
    seriesId?: string | null;
    version?: number;
    dismissalFloorVersion?: number;
    status?: "draft" | "published" | "expired";
    startsAt?: string | null;
    endsAt?: string | null;
    deletedAt?: string | null;
  }) => {
    const content = { en: { title: opts.title, pages: [{ body: opts.title }] } };
    const [row] = await db
      .insert(announcements)
      .values({
        title: opts.title,
        pages: [{ body: opts.title }],
        defaultLocale: "en",
        localizedContent: content,
        status: opts.status ?? "published",
        seriesId: opts.seriesId ?? null,
        version: opts.version ?? 1,
        dismissalFloorVersion: opts.dismissalFloorVersion ?? opts.version ?? 1,
        startsAt: opts.startsAt === null ? null : new Date(opts.startsAt ?? "2026-01-01T00:00:00.000Z"),
        endsAt: opts.endsAt ? new Date(opts.endsAt) : null,
        publishedAt: (opts.status ?? "published") === "draft" ? null : new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: opts.deletedAt ? new Date(opts.deletedAt) : null,
      })
      .returning();
    return row;
  };

  // Series A: published v1, draft v2 (must not replace), scheduled v3 with natural endsAt.
  const a1 = await insertMember({ title: "A-v1", startsAt: "2026-01-01T00:00:00.000Z" });
  await insertMember({
    title: "A-v2-draft",
    seriesId: a1.id,
    version: 2,
    dismissalFloorVersion: 1,
    status: "draft",
    startsAt: "2026-02-01T00:00:00.000Z",
  });
  await insertMember({
    title: "A-v3-windowed",
    seriesId: a1.id,
    version: 3,
    dismissalFloorVersion: 3,
    status: "published",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
  });

  // Series B: published v1 permanently superseded by manually expired v2 once v2 starts.
  const b1 = await insertMember({ title: "B-v1", startsAt: "2026-01-01T00:00:00.000Z" });
  await insertMember({
    title: "B-v2-expired",
    seriesId: b1.id,
    version: 2,
    dismissalFloorVersion: 1,
    status: "expired",
    startsAt: "2026-03-01T00:00:00.000Z",
    endsAt: "2026-03-15T00:00:00.000Z",
  });

  // Series C: deleted draft members alongside live versions (announcements_deleted_draft_only
  // requires deleted rows to carry status = 'draft'; uq_announcements_series_version allows a
  // deleted v2 draft next to a published v2). readerA dismissed v1, which carries to published v2.
  const c1 = await insertMember({
    title: "C-v1",
    startsAt: "2026-01-01T00:00:00.000Z",
  });
  await insertMember({
    title: "C-v2-deleted-draft",
    seriesId: c1.id,
    version: 2,
    dismissalFloorVersion: 1,
    status: "draft",
    startsAt: "2026-02-10T00:00:00.000Z",
    deletedAt: "2026-02-15T00:00:00.000Z",
  });
  await insertMember({
    title: "C-v2-active",
    seriesId: c1.id,
    version: 2,
    dismissalFloorVersion: 1,
    startsAt: "2026-03-01T00:00:00.000Z",
  });
  await insertMember({
    title: "C-v3-deleted-later",
    seriesId: c1.id,
    version: 3,
    dismissalFloorVersion: 3,
    status: "draft",
    startsAt: "2026-04-01T00:00:00.000Z",
    deletedAt: "2026-04-02T00:00:00.000Z",
  });

  // Series D: multi-hop floors with and without "show again" (v1 -> v2 floor 1 -> v3 floor 3 -> v4 floor 3).
  const d1 = await insertMember({ title: "D-v1", startsAt: "2026-01-01T00:00:00.000Z", dismissalFloorVersion: 1 });
  await insertMember({
    title: "D-v2-carry",
    seriesId: d1.id,
    version: 2,
    dismissalFloorVersion: 1,
    startsAt: "2026-02-01T00:00:00.000Z",
  });
  const d3 = await insertMember({
    title: "D-v3-reshow",
    seriesId: d1.id,
    version: 3,
    dismissalFloorVersion: 3,
    startsAt: "2026-03-01T00:00:00.000Z",
  });
  await insertMember({
    title: "D-v4-carry-from-3",
    seriesId: d1.id,
    version: 4,
    dismissalFloorVersion: 3,
    startsAt: "2026-04-01T00:00:00.000Z",
  });

  // Series E: null-startsAt draft v1 + published v2 directly dismissed by readerB.
  const e1Draft = await insertMember({
    title: "E-v1-null-start",
    status: "draft",
    startsAt: null,
  });
  const e2 = await insertMember({
    title: "E-v2-published",
    seriesId: e1Draft.id,
    version: 2,
    dismissalFloorVersion: 2,
    startsAt: "2026-03-01T00:00:00.000Z",
  });

  // Standalone single-version announcements (active, soft-deleted draft, naturally ended).
  await insertMember({ title: "Standalone-active", startsAt: "2026-02-01T00:00:00.000Z" });
  await insertMember({
    title: "Standalone-deleted",
    status: "draft",
    startsAt: "2026-02-01T00:00:00.000Z",
    deletedAt: "2026-02-10T00:00:00.000Z",
  });
  await insertMember({
    title: "Standalone-ended",
    startsAt: "2026-02-01T00:00:00.000Z",
    endsAt: "2026-05-01T00:00:00.000Z",
  });

  await db.insert(userAnnouncementDismissals).values([
    { userId: readerA.id, announcementId: c1.id },
    { userId: readerA.id, announcementId: d1.id },
    { userId: readerB.id, announcementId: d3.id },
    { userId: readerB.id, announcementId: e2.id },
  ]);

  const allRows = await db.select().from(announcements);
  const allDismissals = await db.select().from(userAnnouncementDismissals);
  const dismissedByUser = new Map<string, Set<string>>([
    [readerA.id, new Set()],
    [readerB.id, new Set()],
    [freshReader.id, new Set()],
  ]);
  for (const row of allDismissals) {
    dismissedByUser.get(row.userId)?.add(row.announcementId);
  }

  const checkpoints = [
    new Date("2026-02-20T00:00:00.000Z"),
    new Date("2026-06-01T00:00:00.000Z"),
    new Date("2026-07-01T00:00:00.000Z"), // exact startsAt boundary for A-v3
    new Date("2026-08-01T00:00:00.000Z"), // exact endsAt boundary for A-v3
  ];

  for (const checkpoint of checkpoints) {
    const sqlActiveIds = (
      await db
        .select({ id: announcements.id })
        .from(announcements)
        .where(announcementActiveVersionSql(checkpoint))
    )
      .map((row) => row.id)
      .sort();
    const sharedActiveIds = allRows
      .filter((row) => isAnnouncementVersionActive(row, allRows, checkpoint))
      .map((row) => row.id)
      .sort();
    assert.deepEqual(
      sqlActiveIds,
      sharedActiveIds,
      `active-version SQL vs shared TS mismatch at ${checkpoint.toISOString()}`,
    );

    for (const reader of [readerA, readerB, freshReader]) {
      const sqlUndismissedIds = (
        await db
          .select({ id: announcements.id })
          .from(announcements)
          .leftJoin(
            userAnnouncementDismissals,
            and(
              eq(userAnnouncementDismissals.announcementId, announcements.id),
              eq(userAnnouncementDismissals.userId, reader.id),
            ),
          )
          .where(
            and(
              announcementActiveVersionSql(checkpoint),
              announcementUndismissedBySeriesSql(reader.id),
            ),
          )
      )
        .map((row) => row.id)
        .sort();

      const readerDismissals = dismissedByUser.get(reader.id)!;
      const sharedUndismissedIds = allRows
        .filter(
          (row) =>
            isAnnouncementVersionActive(row, allRows, checkpoint) &&
            !isAnnouncementDismissedBySeries(row, allRows, readerDismissals),
        )
        .map((row) => row.id)
        .sort();

      assert.deepEqual(
        sqlUndismissedIds,
        sharedUndismissedIds,
        `delivery SQL vs shared TS mismatch for ${reader.email} at ${checkpoint.toISOString()}`,
      );

      // Drain listUndismissedForUser end-to-end via afterAnnouncementId to confirm
      // the live route query wires the exact same predicates.
      const deliveredIds: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const [next] = await listUndismissedForUser(reader.id, FAMILY, checkpoint, cursor);
        if (!next) break;
        deliveredIds.push(next.id);
        cursor = next.id;
      }
      assert.deepEqual(
        [...deliveredIds].sort(),
        sharedUndismissedIds,
        `listUndismissedForUser vs shared TS mismatch for ${reader.email} at ${checkpoint.toISOString()}`,
      );
    }
  }
});
