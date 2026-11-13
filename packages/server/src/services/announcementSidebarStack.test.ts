import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
/**
 * Sidebar stack contract (@cindyz, 2026-10-29, task #26): dialog and sidebar
 * cards never share an entry. A dialog head is returned alone; a sidebar head
 * brings up to the requested number of sidebar rows in queue order.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { announcements, users } from "../db/schema";
import { dismiss, listUndismissedForUser, publish } from "./announcementService";

afterEach(async () => {
  await closeTestDatabase();
});

const FAMILY = "30000000-0000-4000-8000-00000000000c";
const page = [{ body: "b" }] as never;

async function seedUser(db: ReturnType<typeof getDb>, email: string) {
  const [user] = await db.insert(users).values({
    email,
    name: email.split("@")[0],
    displayName: "Sidebar Stack",
    passwordHash: "hash",
    emailVerified: true,
    firstOnboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    firstOnboardingCompletedSessionFamilyId: "30000000-0000-4000-8000-00000000000d",
  }).returning();
  return user;
}

async function live(title: string, startsAt: string, opts: { sidebar?: boolean; priority?: number } = {}) {
  const row = await publish({ title, pages: page, startsAt: new Date(startsAt) });
  await getDb().update(announcements).set({
    defaultLocale: "en",
    localizedContent: { en: { title, pages: [{ body: "b" }], ...(opts.sidebar ? { displayMode: "sidebar" as const } : {}) } },
    priority: opts.priority ?? 0,
  }).where(eq(announcements.id, row.id));
  return row;
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

test("a sidebar head brings up to the limit of sidebar rows in queue order, skipping dialogs", async ({ db }) => {
  const user = await seedUser(db, "sidebar-stack-1@example.com");
  const s1 = await live("s1", "2026-01-01", { sidebar: true, priority: 90 });
  const dialog = await live("dialog", "2026-01-02", { priority: 80 });
  const s2 = await live("s2", "2026-01-03", { sidebar: true, priority: 80 });
  const s3 = await live("s3", "2026-01-04", { sidebar: true });
  const s4 = await live("s4", "2026-01-05", { sidebar: true });
  await live("s5", "2026-01-06", { sidebar: true });
  await live("s6", "2026-01-07", { sidebar: true });

  assert.deepEqual(ids(await listUndismissedForUser(user.id, FAMILY)), [s1.id], "without a limit the one-row contract is unchanged");
  const stack = await listUndismissedForUser(user.id, FAMILY, undefined, undefined, undefined, undefined, 5);
  assert.equal(stack.length, 5);
  assert.deepEqual(ids(stack).slice(0, 4), [s1.id, s2.id, s3.id, s4.id]);
  assert.ok(!ids(stack).includes(dialog.id), "a dialog never joins a sidebar stack");
  assert.ok(stack.every((row) => row.displayMode === "sidebar"));
});

test("a dialog head is returned alone even when sidebar rows follow", async ({ db }) => {
  const user = await seedUser(db, "sidebar-stack-2@example.com");
  const dialog = await live("dialog", "2026-01-01", { priority: 50 });
  await live("s1", "2026-01-02", { sidebar: true });
  assert.deepEqual(ids(await listUndismissedForUser(user.id, FAMILY, undefined, undefined, undefined, undefined, 5)), [dialog.id]);
  await dismiss(user.id, dialog.id);
  assert.equal((await listUndismissedForUser(user.id, FAMILY, undefined, undefined, undefined, undefined, 5)).length, 1, "the sidebar row is next once the dialog is read");
});

test("read rows leave the stack and the rest come back on the next entry", async ({ db }) => {
  const user = await seedUser(db, "sidebar-stack-3@example.com");
  const s1 = await live("s1", "2026-01-01", { sidebar: true });
  const s2 = await live("s2", "2026-01-02", { sidebar: true });
  const s3 = await live("s3", "2026-01-03", { sidebar: true });
  await dismiss(user.id, s1.id);
  assert.deepEqual(ids(await listUndismissedForUser(user.id, FAMILY, undefined, undefined, undefined, undefined, 5)), [s2.id, s3.id]);
});
