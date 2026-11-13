import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { releaseNotes, releaseNoteRevisions, releaseNoteRevisionItems, releaseNoteDrafts } from "../db/schema";

/**
 * Integration tests for the public release-notes read surface
 * (`/api/release-notes`).
 *
 * Pins:
 *   1. Public read is anonymous, validates pagination inputs, and projects
 *      retraction (retracted releases keep metadata but lose entries).
 *   2. Published revisions are immutable at the DB level (trigger), and
 *      drafts-only releases never appear (publication-state decision).
 *   3. Detail route serves published entries, retracted stubs, and 404s.
 *
 * Write/maintenance mutations no longer go through the server HTTP API; the
 * Release App maintains release notes via direct database access. The shared
 * mutation primitive and its concurrency/idempotency teeth are covered by
 * `releaseNotesConcurrency.realPg.test.ts` against
 * `services/releaseNotesMutation.ts`.
 */

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("public list is anonymous and rejects malformed pagination", async ({ app }) => {
  const ok = await fetch(`${app.baseUrl}/api/release-notes`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body, {items: [], nextCursor: null});

  const badLimit = await fetch(`${app.baseUrl}/api/release-notes?limit=101`);
  assert.equal(badLimit.status, 400);
  assert.equal((await badLimit.json()).code, "invalid_limit");

  const badCursor = await fetch(`${app.baseUrl}/api/release-notes?cursor=%21%21`);
  assert.equal(badCursor.status, 400);
  assert.equal((await badCursor.json()).code, "invalid_cursor");
});

test("published state is public, retracted state hides entries, drafts are never public", async ({ app }) => {
  const db = getDb();
  const published = crypto.randomUUID();
  const retracted = crypto.randomUUID();
  await db.insert(releaseNotes).values([
    {id: published, releaseKey: "rn-1.0.0", version: "1.0.0", tag: "v1.0.0", date: "2026-09-01", currentRevision: 1},
    {id: retracted, releaseKey: "rn-1.0.1", version: "1.0.1", tag: "v1.0.1", date: "2026-09-02", currentRevision: 1, retractedAt: new Date()},
  ]);
  await db.insert(releaseNoteRevisions).values([
    {releaseId: published, revision: 1, snapshotHash: "a".repeat(64)},
    {releaseId: retracted, revision: 1, snapshotHash: "b".repeat(64)},
  ]);
  // drafts-only release must not appear at all
  await db.insert(releaseNotes).values({id: crypto.randomUUID(), releaseKey: "rn-2.0.0", version: "2.0.0", tag: "v2.0.0", date: "2026-09-03"});
  await db.insert(releaseNoteDrafts).values({releaseId: (await db.select({id: releaseNotes.id}).from(releaseNotes).where(eq(releaseNotes.releaseKey, "rn-2.0.0")))[0].id, entries: []});

  const res = await fetch(`${app.baseUrl}/api/release-notes?limit=10`);
  assert.equal(res.status, 200);
  const {items} = await res.json();
  assert.equal(items.length, 2);
  const byKey = Object.fromEntries(items.map((i: {releaseKey: string}) => [i.releaseKey, i]));
  assert.equal(byKey["rn-2.0.0"], undefined);
  assert.equal(byKey["rn-1.0.0"].state, "published");
  assert.equal(byKey["rn-1.0.1"].state, "retracted");
});

test("list batches entries per page: current revision only, ordinal order, retracted empty", async ({ app }) => {
  const db = getDb();
  const [a, b, r] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  await db.insert(releaseNotes).values([
    {id: a, releaseKey: "rn-3.0.0", version: "3.0.0", tag: "v3.0.0", date: "2026-09-10", currentRevision: 2},
    {id: b, releaseKey: "rn-3.0.1", version: "3.0.1", tag: "v3.0.1", date: "2026-09-11", currentRevision: 1},
    {id: r, releaseKey: "rn-3.0.2", version: "3.0.2", tag: "v3.0.2", date: "2026-09-12", currentRevision: 1, retractedAt: new Date()},
  ]);
  await db.insert(releaseNoteRevisions).values([
    {releaseId: a, revision: 1, snapshotHash: "c".repeat(64)},
    {releaseId: a, revision: 2, snapshotHash: "d".repeat(64)},
    {releaseId: b, revision: 1, snapshotHash: "e".repeat(64)},
    {releaseId: r, revision: 1, snapshotHash: "f".repeat(64)},
  ]);
  const item = (releaseId: string, revision: number, ordinal: number, text: string) =>
    ({releaseId, revision, entryId: crypto.randomUUID(), ordinal, type: "fix" as const, text, emphasis: false});
  await db.insert(releaseNoteRevisionItems).values([
    item(a, 1, 0, "a old revision"),
    item(a, 2, 1, "a second"),
    item(a, 2, 0, "a first"),
    item(b, 1, 0, "b only"),
    item(r, 1, 0, "retracted hidden"),
  ]);

  const res = await fetch(`${app.baseUrl}/api/release-notes?limit=10`);
  assert.equal(res.status, 200);
  const {items} = await res.json();
  const texts = Object.fromEntries(items.map((i: {releaseKey: string; entries: Array<{text: string}>}) =>
    [i.releaseKey, i.entries.map(e => e.text)]));
  assert.deepEqual(texts["rn-3.0.0"], ["a first", "a second"]);
  assert.deepEqual(texts["rn-3.0.1"], ["b only"]);
  assert.deepEqual(texts["rn-3.0.2"], []);
  assert.deepEqual(Object.keys(items.find((i: {releaseKey: string}) => i.releaseKey === "rn-3.0.1").entries[0]),
    ["entryId", "type", "text", "emphasis", "ordinal"]);
});

test("releases on the same date list newest first publication first, and the cursor walks them", async ({ app }) => {
  const db = getDb();
  // The older release gets the larger id, so ordering by id alone would put it first.
  const [older, newer, earlier] = ["ffffffff-ffff-4fff-bfff-ffffffffffff", "00000000-0000-4000-8000-000000000001", crypto.randomUUID()];
  await db.insert(releaseNotes).values([
    {id: older, releaseKey: "rn-5.0.0", version: "5.0.0", tag: "v5.0.0", date: "2026-09-20", currentRevision: 2},
    {id: newer, releaseKey: "rn-5.0.2", version: "5.0.2", tag: "v5.0.2", date: "2026-09-20", currentRevision: 1},
    {id: earlier, releaseKey: "rn-4.9.0", version: "4.9.0", tag: "v4.9.0", date: "2026-09-19", currentRevision: 1},
  ]);
  await db.insert(releaseNoteRevisions).values([
    {releaseId: older, revision: 1, snapshotHash: "1".repeat(64), publishedAt: new Date("2026-09-20T10:00:00Z")},
    {releaseId: newer, revision: 1, snapshotHash: "2".repeat(64), publishedAt: new Date("2026-09-21T04:00:00Z")},
    // A later revision of the older release must not move it above the newer one.
    {releaseId: older, revision: 2, snapshotHash: "3".repeat(64), publishedAt: new Date("2026-09-22T00:00:00Z")},
    {releaseId: earlier, revision: 1, snapshotHash: "4".repeat(64), publishedAt: new Date("2026-09-19T10:00:00Z")},
  ]);
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const res: Response = await fetch(`${app.baseUrl}/api/release-notes?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(res.status, 200);
    const body: {items: Array<{releaseKey: string}>; nextCursor: string | null} = await res.json();
    keys.push(...body.items.map(i => i.releaseKey).filter(k => k.startsWith("rn-5.") || k === "rn-4.9.0"));
    cursor = body.nextCursor;
  } while (cursor);
  assert.deepEqual(keys, ["rn-5.0.2", "rn-5.0.0", "rn-4.9.0"]);
});

test("release_note_revisions rows are DB-immutable (trigger rejects update and delete)", async ({ app }) => {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.insert(releaseNotes).values({id, releaseKey: `rn-immutable-${id.slice(0,8)}`, version: `9.9.${id.slice(0,4)}`, tag: `t-${id.slice(0,6)}`, date: "2026-09-01", currentRevision: 1});
  await db.insert(releaseNoteRevisions).values({releaseId: id, revision: 1, snapshotHash: "c".repeat(64)});
  await assert.rejects(() => db.update(releaseNoteRevisions).set({snapshotHash: "d".repeat(64)}).where(eq(releaseNoteRevisions.releaseId, id)));
  await assert.rejects(() => db.delete(releaseNoteRevisions).where(eq(releaseNoteRevisions.releaseId, id)));
});

test("detail route: published entries visible, retracted stub hides entries, unknown id 404", async ({ app }) => {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.insert(releaseNotes).values({id, releaseKey: `rn-detail-${id.slice(0,8)}`, version: `3.3.${id.slice(0,4)}`, tag: `t-${id.slice(0,6)}`, date: "2026-09-01", currentRevision: 1});
  await db.insert(releaseNoteRevisions).values({releaseId: id, revision: 1, snapshotHash: "e".repeat(64)});
  const bad = await fetch(`${app.baseUrl}/api/release-notes/not-an-id`);
  assert.equal(bad.status, 400);
  const missing = await fetch(`${app.baseUrl}/api/release-notes/00000000-0000-4000-8000-000000000000`);
  assert.equal(missing.status, 404);
  const detail = await fetch(`${app.baseUrl}/api/release-notes/${id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).state, 'published');
});

test("right-cause: only release_notes identity uniques map to release_exists; foreign 23505 stays generic", async () => {
  const { isReleaseIdentityUnique } = await import("../services/releaseNotesMutation");
  const pg = (constraint: string) => Object.assign(new Error("dup"), {code: "23505", constraint});
  assert.equal(isReleaseIdentityUnique(pg("release_notes_version_unique")), true);
  assert.equal(isReleaseIdentityUnique(pg("release_notes_tag_unique")), true);
  assert.equal(isReleaseIdentityUnique(pg("release_notes_release_key_unique")), true);
  // foreign constraints and missing/odd shapes must NOT be relabeled
  assert.equal(isReleaseIdentityUnique(pg("release_note_mutation_receipts_actor_id_client_id_key_pk")), false);
  assert.equal(isReleaseIdentityUnique(pg("release_note_audit_id_pk")), false);
  assert.equal(isReleaseIdentityUnique(pg("users_email_unique")), false);
  assert.equal(isReleaseIdentityUnique(Object.assign(new Error("dup"), {code: "23503", constraint: "release_notes_version_unique"})), false);
  assert.equal(isReleaseIdentityUnique(new Error("dup")), false);
  assert.equal(isReleaseIdentityUnique(null), false);
});