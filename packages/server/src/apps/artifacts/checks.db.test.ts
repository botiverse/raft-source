// Publish checks' rows (checks.ts, task #130) on the migrated schema: what a
// push records (nothing without a check Worker, for a kind the shell draws or a PDF;
// `unchanged` when the files are the previous version's byte for byte;
// a daily cap, the server's then the platform's, counted per UTC day and
// never counting skipped rows; idempotent per version), only the newest three
// versions keeping screenshots (core object files of the Artifact, hung on
// their version), the screenshots read only while the deployment has a check
// Worker (core's file read, checkShotReadable; the cards', cardCheckShots),
// and deleting the Artifact (its checks and every file of it
// in its transaction, the bytes after). A soft-deleted server's files are
// core's sweep's (objectFiles.db.test.ts).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { asServerId, type ObjectFileId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectFiles } from "../../db/schema";
import { putObjectFile } from "../../services/objectFiles";
import { testPng } from "../../test/objectFileTestImages";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { r2KeyOf } from "./blobStore";
import {
  artifactFileObject,
  cardCheckShots,
  checkShotFileOf,
  checkShotPart,
  checkShotReadable,
  keepNewestCheckShots,
  mayCheck,
  recordVersionCheck,
} from "./checks";
import { deleteArtifact } from "./manage";
import { artifactBlobs, artifactItems, artifactVersionChecks, artifactVersionFiles, artifactVersions, type ArtifactVersionRow } from "./schema";

const NOW = new Date("2026-11-02T15:00:00Z");
const PNG = (label: string) => testPng(label);

/** A deployment with a check Worker: what turns publish checks on (checkWorkerToken.ts checksConfigured). */
const WITH_WORKER = { ARTIFACTS_CHECK_WORKER_TOKEN: "k".repeat(40) };

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  storage = installMemoryObjectFilesStorage();
  vi.stubEnv("ARTIFACTS_CHECK_WORKER_TOKEN", WITH_WORKER.ARTIFACTS_CHECK_WORKER_TOKEN);
});
afterEach(() => {
  storage.restore();
  vi.unstubAllEnvs();
});

/** A server, its owner, and a way to push versions of one Artifact. */
async function seedServer(seed: ReturnType<typeof createSeed>) {
  const db = getDb();
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const makeItem = async () => {
    const id = `pt_${randomUUID()}`;
    const [item] = await db.insert(artifactItems).values({ id, serverId, urlKey: id, name: id, title: id, homeKind: "server", createdByType: "user", createdById: owner.id }).returning();
    return item!;
  };
  /** Version `number` of `itemId` with these files (path → text), published and current. */
  const push = async (itemId: string, number: number, files: Record<string, string>, opts: { entry?: string; spa?: boolean } = {}): Promise<ArtifactVersionRow> => {
    const [version] = await db.insert(artifactVersions).values({
      id: `v_${randomUUID()}`, itemId, number, entry: opts.entry ?? Object.keys(files)[0]!, spa: opts.spa ?? false,
      fileCount: Object.keys(files).length, sizeBytes: 1, publishDigest: "digest", status: "published",
      publisherType: "user", publisherId: owner.id, position: number,
    }).returning();
    for (const [path, text] of Object.entries(files)) {
      const sha256 = createHash("sha256").update(text).digest("hex");
      // One blob per server and sha256, as the publish path keeps them.
      let [blob] = await db.select().from(artifactBlobs).where(and(eq(artifactBlobs.serverId, serverId), eq(artifactBlobs.sha256, sha256))).limit(1);
      if (!blob) {
        const id = `b_${randomUUID()}`;
        [blob] = await db.insert(artifactBlobs).values({ id, serverId, sha256, sizeBytes: text.length, r2Key: r2KeyOf(serverId, sha256, id) }).returning();
      }
      await db.insert(artifactVersionFiles).values({ versionId: version!.id, path, sha256, sizeBytes: text.length, blobId: blob!.id });
    }
    await db.update(artifactItems).set({ currentVersionId: version!.id, lastPosition: number }).where(eq(artifactItems.id, itemId));
    return version!;
  };
  return { owner, server, serverId, makeItem, push };
}

/**
 * A finished check of `version` with both screenshots, stored as the check
 * task stores them: core object files of the Artifact, hung on the version,
 * uploaded by its publisher, then their ids on the row.
 */
async function doneWithShots(version: ArtifactVersionRow) {
  const [row] = await getDb().insert(artifactVersionChecks).values({ versionId: version.id, status: "running" }).returning();
  const put = (which: string) => putObjectFile({
    object: artifactFileObject(version.itemId),
    parent: checkShotPart(version.id),
    bytes: PNG(`${which} of ${version.number}`),
    uploadedBy: { type: version.publisherType, id: version.publisherId },
    quota: "exempt",
  });
  const desktop = await put("desktop");
  const phone = await put("phone");
  await getDb().update(artifactVersionChecks).set({
    status: "done", finishedAt: new Date(), desktopFileId: desktop.id, phoneFileId: phone.id,
    findings: { consoleErrors: [], blockedResources: [], blank: false, phoneOverflow: null },
  }).where(eq(artifactVersionChecks.id, row!.id));
  return { id: row!.id, versionId: version.id, files: [desktop.id, phone.id] };
}

/** Whether these files are kept: their rows live and their bytes in storage. */
async function kept(files: readonly ObjectFileId[]): Promise<boolean[]> {
  const rows = await getDb().select().from(objectFiles).where(inArray(objectFiles.id, [...files]));
  return files.map((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    return row !== undefined && row.state === "claimed" && storage.objects.has(row.storageKey);
  });
}
const allKept = async (files: readonly ObjectFileId[]) => (await kept(files)).every(Boolean);
const noneKept = async (files: readonly ObjectFileId[]) => (await kept(files)).every((isKept) => !isKept) && (await getDb().select().from(objectFiles).where(inArray(objectFiles.id, [...files]))).length === 0;

test("a push records its check: pending; nothing without a check Worker, for a kind the shell draws or a PDF; once per version", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const item = await world.makeItem();
  const v1 = await world.push(item.id, 1, { "index.html": "<h1>one</h1>" });
  const recorded = await recordVersionCheck(db, { item, version: v1, now: NOW });
  assert.equal(recorded?.status, "pending");
  assert.equal(recorded?.skipReason, null);
  assert.equal(recorded?.finishedAt, null);
  assert.equal(recorded?.createdAt.toISOString(), NOW.toISOString());
  assert.equal((await recordVersionCheck(db, { item, version: v1, now: NOW }))?.id, recorded!.id, "the version's row, not a second one");

  const sheet = await world.push(item.id, 2, { "data.csv": "a,b\n" });
  assert.equal(await recordVersionCheck(db, { item, version: sheet, now: NOW }), null, "a kind the shell draws");
  const markdown = await world.push(item.id, 3, { "README.md": "# three" });
  assert.equal(await recordVersionCheck(db, { item, version: markdown, now: NOW }), null, "Markdown shows an excerpt instead (excerpt.ts)");
  assert.equal((await db.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, markdown.id))).length, 0);
  const pdf = await world.push(item.id, 4, { "report.pdf": "%PDF-1.4\n%%EOF\n" });
  assert.equal(await recordVersionCheck(db, { item, version: pdf, now: NOW }), null, "a PDF is framed but not checked, for now");
  assert.equal((await db.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, pdf.id))).length, 0);

  // A deployment without a check Worker (no token, or one the routes refuse): nothing could run a check, so none is recorded.
  const other = await world.makeItem();
  const unchecked = await world.push(other.id, 1, { "index.html": "<h1>no worker</h1>" });
  for (const env of [{}, { ARTIFACTS_CHECK_WORKER_TOKEN: "" }, { ARTIFACTS_CHECK_WORKER_TOKEN: "too-short" }]) {
    assert.equal(await recordVersionCheck(db, { item: other, version: unchecked, now: NOW, env }), null, `no usable token: no row (${JSON.stringify(env)})`);
  }
  assert.equal((await db.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, unchecked.id))).length, 0);
  // With one, the same version is checked.
  assert.equal((await recordVersionCheck(db, { item: other, version: unchecked, now: NOW, env: WITH_WORKER }))?.status, "pending");
  await assert.rejects(recordVersionCheck(db, { item: other, version: v1, now: NOW }), /not the item's/);
});

test("the same files as the previous version, byte for byte, skip the check as unchanged; any change runs it", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const item = await world.makeItem();
  const record = async (version: ArtifactVersionRow) => (await recordVersionCheck(db, { item, version, now: NOW }))!;
  const files = { "index.html": "<h1>page</h1>", "app.js": "run()" };
  assert.equal((await record(await world.push(item.id, 1, files))).status, "pending", "no previous version");
  const same = await record(await world.push(item.id, 2, files));
  assert.deepEqual([same.status, same.skipReason, same.finishedAt?.toISOString()], ["skipped", "unchanged", NOW.toISOString()]);
  assert.equal((await record(await world.push(item.id, 3, { ...files, "app.js": "run(1)" }))).status, "pending", "one byte changed");
  assert.equal((await record(await world.push(item.id, 4, { ...files, "app.js": "run(1)", "extra.css": "" }))).status, "pending", "a file added");
  assert.equal((await record(await world.push(item.id, 5, { "index.html": "<h1>page</h1>", "app.js": "run(1)" }))).status, "pending", "a file removed");
  assert.equal((await record(await world.push(item.id, 6, { "index.html": "<h1>page</h1>", "main.js": "run(1)" }))).status, "pending", "a file renamed");
  assert.equal((await record(await world.push(item.id, 7, { "index.html": "<h1>page</h1>", "main.js": "run(1)" }, { spa: true }))).status, "pending", "spa changed");
  const both = { "index.html": "<h1>page</h1>", "other.html": "<h1>other</h1>" };
  await record(await world.push(item.id, 8, both));
  assert.equal((await record(await world.push(item.id, 9, both, { entry: "other.html" }))).status, "pending", "another entry");
  // The previous version is the published one numbered just below: a revoked one doesn't count.
  const v10 = await world.push(item.id, 10, { "index.html": "<h1>ten</h1>" });
  await record(v10);
  await db.update(artifactVersions).set({ revokedAt: new Date() }).where(eq(artifactVersions.id, v10.id));
  assert.equal((await record(await world.push(item.id, 11, both, { entry: "other.html" }))).skipReason, "unchanged", "compared with v9, v10 revoked");
});

test("daily caps: the server's, then the platform's, per UTC day, counting only the checks that run", async ({ seed }) => {
  const db = getDb();
  const env = { ...WITH_WORKER, ARTIFACTS_CHECK_DAILY_PER_SERVER: "2", ARTIFACTS_CHECK_DAILY_TOTAL: "3" };
  const a = await seedServer(seed);
  const b = await seedServer(seed);
  const itemA = await a.makeItem();
  const itemB = await b.makeItem();
  const record = async (world: typeof a, item: typeof itemA, number: number, now = NOW) =>
    (await recordVersionCheck(db, { item, version: await world.push(item.id, number, { "index.html": `<p>${number}</p>` }), now, env }))!;

  // Yesterday's (UTC) checks don't count today; a skipped row never counts.
  await record(a, itemA, 1, new Date("2026-11-01T23:59:59Z"));
  await record(a, itemA, 2, new Date("2026-11-01T23:00:00Z"));
  assert.deepEqual(await mayCheck(a.serverId, { now: NOW, env }), { ok: true });
  assert.equal((await record(a, itemA, 3)).status, "pending");
  const unchanged = await recordVersionCheck(db, { item: itemA, version: await a.push(itemA.id, 4, { "index.html": "<p>3</p>" }), now: NOW, env });
  assert.equal(unchanged?.skipReason, "unchanged");
  assert.equal((await record(a, itemA, 5)).status, "pending");
  // The server's cap: 2 today.
  const capped = await record(a, itemA, 6);
  assert.deepEqual([capped.status, capped.skipReason], ["skipped", "server_daily_cap"]);
  assert.deepEqual(await mayCheck(a.serverId, { now: NOW, env }), { ok: false, reason: "server_daily_cap" });
  // Another server has its own, under the platform's 3 in all: one more, then the platform's.
  assert.equal((await record(b, itemB, 1)).status, "pending");
  assert.deepEqual([(await record(b, itemB, 2)).skipReason], ["platform_daily_cap"]);
  assert.deepEqual(await mayCheck(b.serverId, { now: NOW, env }), { ok: false, reason: "platform_daily_cap" });
  // Tomorrow (UTC midnight) starts again.
  assert.deepEqual(await mayCheck(a.serverId, { now: new Date("2026-11-03T00:00:00Z"), env }), { ok: true });

  // The defaults (300 a server, 5000 in all), and a value that isn't a whole number falls back to them, with a warning.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    assert.deepEqual(await mayCheck(a.serverId, { now: NOW, env: {} }), { ok: true });
    assert.deepEqual(await mayCheck(a.serverId, { now: NOW, env: { ARTIFACTS_CHECK_DAILY_PER_SERVER: "lots" } }), { ok: true });
    assert.ok(warn.mock.calls.some(([message]) => String(message).includes("ARTIFACTS_CHECK_DAILY_PER_SERVER")));
    assert.deepEqual(await mayCheck(a.serverId, { now: NOW, env: { ARTIFACTS_CHECK_DAILY_PER_SERVER: "0" } }), { ok: false, reason: "server_daily_cap" }, "0 skips every check");
  } finally {
    warn.mockRestore();
  }
});

test("only the newest three versions with screenshots keep them: older rows' ids cleared and their files let go, then their bytes deleted; findings kept", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const item = await world.makeItem();
  const other = await world.makeItem();
  const shots: Array<Awaited<ReturnType<typeof doneWithShots>>> = [];
  for (const number of [1, 2, 3, 4, 5]) shots.push(await doneWithShots(await world.push(item.id, number, { "index.html": `<p>${number}</p>` })));
  // A newer version without screenshots (failed) doesn't take a place.
  const failed = await world.push(item.id, 6, { "index.html": "<p>6</p>" });
  await db.insert(artifactVersionChecks).values({ versionId: failed.id, status: "failed", finishedAt: new Date(), errorClass: "Timeout" });
  const otherShots = await doneWithShots(await world.push(other.id, 1, { "index.html": "<p>other</p>" }));

  assert.equal(await keepNewestCheckShots(item.id), 4, "two versions' two screenshots");
  const rows = await db.select().from(artifactVersionChecks).where(inArray(artifactVersionChecks.id, shots.map((shot) => shot.id)));
  const rowOf = (id: string) => rows.find((row) => row.id === id)!;
  for (const shot of shots.slice(0, 2)) {
    assert.deepEqual([rowOf(shot.id).desktopFileId, rowOf(shot.id).phoneFileId], [null, null]);
    assert.equal(rowOf(shot.id).status, "done");
    assert.ok(rowOf(shot.id).findings, "the findings stay");
    assert.ok(await noneKept(shot.files), "their files and bytes gone");
  }
  for (const shot of [...shots.slice(2), otherShots]) assert.ok(await allKept(shot.files));
  assert.equal(await keepNewestCheckShots(item.id), 0, "nothing more to clear");

  // What a reader of the check is handed: the file id, which core's route serves.
  const v5 = shots[4]!;
  assert.equal(await checkShotFileOf(v5.versionId, "phone"), v5.files[1]);
  assert.equal(await checkShotFileOf(shots[0]!.versionId, "desktop"), null, "cleared");
  assert.equal(await checkShotFileOf(failed.id, "desktop"), null, "failed");
});

test("deleting the Artifact deletes its checks and lets its files go in the same transaction, and their bytes after it", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const item = await world.makeItem();
  const keep = await world.makeItem();
  const shot = await doneWithShots(await world.push(item.id, 1, { "index.html": "<p>1</p>" }));
  await db.insert(artifactVersionChecks).values({ versionId: (await world.push(item.id, 2, { "index.html": "<p>2</p>" })).id, status: "pending" });
  const keptShots = await doneWithShots(await world.push(keep.id, 1, { "index.html": "<p>kept</p>" }));

  const result = await deleteArtifact({ type: "user", id: world.owner.id, serverId: world.serverId }, item.id);
  assert.equal(result.kind, "deleted");
  const left = await db.select({ versionId: artifactVersionChecks.versionId }).from(artifactVersionChecks)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifactVersionChecks.versionId))
    .where(eq(artifactVersions.itemId, item.id));
  assert.deepEqual(left, [], "every check of the Artifact");
  assert.ok(await noneKept(shot.files), "their files and bytes");
  assert.ok(await allKept(keptShots.files), "another Artifact's stay");
});

test("the screenshots only while the deployment has a check Worker: core's file read (checkShotReadable) and the cards' (cardCheckShots)", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const item = await world.makeItem();
  const version = await world.push(item.id, 1, { "index.html": "<p>checked</p>" });
  const done = await doneWithShots(version);
  const [row] = await db.select().from(artifactItems).where(eq(artifactItems.id, item.id));
  const peer = asServerId((await seed.server({ owner: await seed.human() })).id);
  // Its own server's reader, and another server's reader of it in a joint conversation (not an outsider: not public).
  const ask = [{ item: { ...row!, homeKind: "conversation" as const }, number: null }];
  const shots = { desktop: done.files[0]!, phone: done.files[1]! };
  const cards = async (reader: typeof world.serverId, env?: NodeJS.ProcessEnv) => [...(await cardCheckShots(reader, ask, env)).values()];
  const part = checkShotPart(version.id);

  // With a check Worker: core may serve the screenshots, and both readers' cards show them.
  assert.equal(checkShotReadable(part), true);
  assert.deepEqual(await cards(world.serverId), [shots]);
  assert.deepEqual(await cards(peer), [shots]);

  // Without one: hidden, whoever reads. Every other part of the Artifact is core's alone (a comment's images).
  for (const env of [{}, { ARTIFACTS_CHECK_WORKER_TOKEN: "too-short" }]) {
    assert.equal(checkShotReadable(part, env), false, "core answers the file as one there isn't");
    assert.deepEqual(await cards(world.serverId, env), []);
    assert.deepEqual(await cards(peer, env), []);
    assert.equal(checkShotReadable("comment:c_1", env), true);
  }
  assert.equal(checkShotReadable("comment:c_1"), true);
});
