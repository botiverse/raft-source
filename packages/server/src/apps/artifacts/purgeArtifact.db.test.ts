// An operator's purge of one Artifact (purge.ts purgeArtifact, the script's
// `purge`): everything of it goes (rows by cascade from the item, its core
// object files and their bytes, its object events and Activity rows), and of
// its blobs only those no other Artifact of the server uses, rows and
// objects, in one transaction with no takedown first; the purge record stays,
// with only the counts and the reason, and a storage key only while its
// delete failed; a second run writes nothing and only retries those deletes,
// clearing each that goes;
// planArtifactPurge counts the same and deletes nothing.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { asServerId, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectEvents, objectFiles, objectInboxStates } from "../../db/schema";
import { putObjectFile } from "../../services/objectFiles";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { testPng } from "../../test/objectFileTestImages";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import type { ArtifactR2Store } from "./blobStore";
import { r2KeyOf } from "./blobStore";
import { artifactFileObject } from "./checks";
import { recordArtifactEvent } from "./events";
import { planArtifactPurge, purgeArtifact } from "./purge";
import {
  artifactAudit,
  artifactBlobs,
  artifactComments,
  artifactItems,
  artifactPurges,
  artifactReadPositions,
  artifactSearch,
  artifactSubscriptions,
  artifactVersionChecks,
  artifactVersionFiles,
  artifactVersions,
} from "./schema";
import { indexArtifactSearch } from "./search";

let files: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  files = installMemoryObjectFilesStorage();
});
afterEach(() => {
  files.restore();
});

/** Artifacts' bucket in memory; `failDeletes.on` makes every delete reject (the object stays). */
function memoryR2(objects: Map<string, Buffer>) {
  const failDeletes = { on: false };
  const store: ArtifactR2Store = {
    async read() {
      return null;
    },
    async presign() {
      return null;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async delete(key) {
      if (failDeletes.on) throw new Error("delete failed (test)");
      objects.delete(key);
    },
  };
  return { store, failDeletes };
}

/** A server, its owner and a member, and Artifacts made of blobs (by content) stored in `objects`. */
async function seedServer(seed: ReturnType<typeof createSeed>, objects: Map<string, Buffer>) {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const serverId = asServerId(server.id);
  const blobOf = new Map<string, { id: string; key: string }>();
  /** This server's one blob of `text` (deduplicated by sha256, as publishing does). */
  const blob = async (text: string) => {
    const known = blobOf.get(text);
    if (known) return known;
    const sha256 = createHash("sha256").update(text).digest("hex");
    const id = `b_${randomUUID()}`;
    const key = r2KeyOf(serverId, sha256, id);
    await getDb().insert(artifactBlobs).values({ id, serverId, sha256, sizeBytes: text.length, r2Key: key });
    objects.set(key, Buffer.from(text));
    blobOf.set(text, { id, key });
    return { id, key };
  };
  /** An Artifact of the server home whose versions have these files ({ path: content }), the last one current. */
  const make = async (versions: ReadonlyArray<Record<string, string>>) => {
    const db = getDb();
    const id = `pt_${randomUUID()}`;
    await db.insert(artifactItems).values({ id, serverId, urlKey: id, title: `Purge ${id.slice(3, 11)}`, homeKind: "server", createdByType: "user", createdById: owner.id });
    const made = [];
    for (const [index, fileSet] of versions.entries()) {
      const [version] = await db.insert(artifactVersions).values({
        id: `v_${randomUUID()}`, itemId: id, number: index + 1, entry: "index.html", fileCount: Object.keys(fileSet).length, sizeBytes: 10,
        publishDigest: "digest", status: "published", publisherType: "user", publisherId: owner.id, position: index + 1,
      }).returning();
      for (const [path, text] of Object.entries(fileSet)) {
        const { id: blobId } = await blob(text);
        const sha256 = createHash("sha256").update(text).digest("hex");
        await db.insert(artifactVersionFiles).values({ versionId: version!.id, path, sha256, sizeBytes: text.length, blobId });
      }
      made.push(version!);
    }
    const [item] = await db.update(artifactItems).set({ currentVersionId: made.at(-1)!.id, lastPosition: made.length }).where(eq(artifactItems.id, id)).returning();
    await indexArtifactSearch(db, item!);
    return { item: item!, versions: made };
  };
  return { serverId, owner, member, blob, make, by: { type: "user" as const, id: owner.id } };
}

const blobRows = (serverId: ServerId) => getDb().select({ id: artifactBlobs.id }).from(artifactBlobs).where(eq(artifactBlobs.serverId, serverId)).then((rows) => rows.map((row) => row.id).sort());

test("purge: everything of the Artifact goes, and of its blobs only those no other Artifact uses; the record stays; a second run writes nothing", async ({ seed }) => {
  const objects = new Map<string, Buffer>();
  const { store } = memoryR2(objects);
  const world = await seedServer(seed, objects);
  const db = getDb();
  // The Artifact purged: two versions, `shared.css` also another Artifact's (one blob: deduplicated by the server).
  const { item, versions: [v1, v2] } = await world.make([{ "index.html": "first page" }, { "index.html": "second page", "shared.css": "body {}" }]);
  const other = await world.make([{ "index.html": "the other one", "shared.css": "body {}" }]);
  const [first, second, shared, kept] = await Promise.all(["first page", "second page", "body {}", "the other one"].map((text) => world.blob(text)));
  // Its comment, follower, read position, audit row, publish check with a screenshot, a comment image, an event and an Activity row.
  const commentId = `c_${randomUUID()}`;
  await db.insert(artifactComments).values({ id: commentId, itemId: item.id, versionId: v2!.id, authorType: "user", authorId: world.member.id, body: "leaked", position: 3 });
  await db.insert(artifactSubscriptions).values({ itemId: item.id, actorType: "user", actorId: world.member.id, reason: "followed" });
  await db.insert(artifactReadPositions).values({ itemId: item.id, actorType: "user", actorId: world.member.id, position: 2 });
  await db.insert(artifactAudit).values({ itemId: item.id, actorType: "user", actorId: world.owner.id, action: "home_changed", before: {}, after: {} });
  await db.insert(artifactVersionChecks).values({ versionId: v2!.id, status: "done", finishedAt: new Date() });
  const shot = await putObjectFile({ object: artifactFileObject(item.id), parent: `version:${v2!.id}`, bytes: testPng("shot"), uploadedBy: world.by, quota: "exempt" });
  const image = await putObjectFile({ object: artifactFileObject(item.id), parent: `comment:${commentId}`, bytes: testPng("image"), uploadedBy: world.by, quota: "exempt" });
  const otherShot = await putObjectFile({ object: artifactFileObject(other.item.id), parent: `version:${other.versions[0]!.id}`, bytes: testPng("other"), uploadedBy: world.by, quota: "exempt" });
  await recordArtifactEvent(db, { item, eventKind: "comment", actor: world.by, data: { position: 3 }, recipients: [{ actor: { type: "user", id: world.member.id }, reason: "following" }] });
  assert.equal(files.objects.size, 3, "witness: three files stored");

  const expected = {
    versions: 2, files: 3, versionTexts: 0, checks: 1, comments: 1, commentDrafts: 0, reviews: 0, auditRows: 1, subscriptions: 1, readPositions: 1,
    attachmentSaves: 0, pendingNotices: 0, searchRows: 1, blobsUnshared: 2, blobBytesUnshared: "first page".length + "second page".length, blobsShared: 1,
  };
  // The plan counts and deletes nothing.
  const plan = await planArtifactPurge(item.id);
  assert.deepEqual(plan, { serverId: world.serverId, title: item.title, home: "server", deleted: false, takenDown: false, counts: expected });
  assert.ok((await db.select().from(artifactItems).where(eq(artifactItems.id, item.id))).length === 1, "the plan wrote nothing");

  const purged = await purgeArtifact(item.id, "report #9: personal data", store);
  assert.equal(purged.kind, "purged");
  if (purged.kind !== "purged") return;
  assert.equal(purged.changed, true);
  assert.deepEqual({ ...purged.record, at: "" }, {
    itemId: item.id, serverId: world.serverId, reason: "report #9: personal data", at: "", pendingObjectKeys: [],
    removed: { ...expected, blobsDeleted: 2, blobBytesDeleted: expected.blobBytesUnshared, blobsKept: 1, objectFiles: 2, events: 1, activityRows: 1 },
  });

  // Every row of it: the item and its cascade.
  assert.deepEqual(await db.select().from(artifactItems).where(eq(artifactItems.id, item.id)), []);
  assert.deepEqual(await db.select().from(artifactVersions).where(eq(artifactVersions.itemId, item.id)), []);
  assert.deepEqual(await db.select().from(artifactVersionFiles).where(inArray(artifactVersionFiles.versionId, [v1!.id, v2!.id])), []);
  assert.deepEqual(await db.select().from(artifactComments).where(eq(artifactComments.itemId, item.id)), []);
  assert.deepEqual(await db.select().from(artifactAudit).where(eq(artifactAudit.itemId, item.id)), []);
  assert.deepEqual(await db.select().from(artifactSearch).where(eq(artifactSearch.itemId, item.id)), []);
  assert.deepEqual(await db.select().from(artifactVersionChecks).where(eq(artifactVersionChecks.versionId, v2!.id)), []);
  assert.deepEqual(await db.select().from(objectEvents).where(eq(objectEvents.objectId, item.id)), []);
  assert.deepEqual(await db.select().from(objectInboxStates).where(eq(objectInboxStates.objectId, item.id)), []);
  // Its object files, rows and bytes; the other Artifact's stays.
  assert.deepEqual((await db.select({ id: objectFiles.id }).from(objectFiles).where(inArray(objectFiles.id, [shot.id, image.id, otherShot.id]))).map((row) => row.id), [otherShot.id]);
  assert.equal(files.objects.size, 1);
  // Its blobs no other Artifact uses, rows and objects; the shared one and the other Artifact's own stay.
  assert.deepEqual(await blobRows(world.serverId), [shared.id, kept.id].sort());
  assert.deepEqual([...objects.keys()].sort(), [shared.key, kept.key].sort());
  assert.equal(objects.has(first.key) || objects.has(second.key), false);
  // The other Artifact reads as before.
  assert.equal((await db.select().from(artifactVersionFiles).where(eq(artifactVersionFiles.versionId, other.versions[0]!.id))).length, 2);

  // The record outlives it: only the counts and the reason beside its ids and when (no one's name, no title or content),
  // and no storage key once its delete went.
  const [record] = await db.select().from(artifactPurges).where(eq(artifactPurges.itemId, item.id));
  assert.deepEqual(Object.keys(record!).sort(), ["createdAt", "itemId", "pendingObjectKeys", "reason", "removed", "serverId"]);
  assert.deepEqual([record?.serverId, record?.reason, record?.pendingObjectKeys], [world.serverId, "report #9: personal data", []]);
  assert.equal(JSON.stringify(record).includes(item.title), false, "never its title");

  // Again: nothing new written, nothing else deleted; the same record.
  const again = await purgeArtifact(item.id, "again", store);
  assert.deepEqual(again, { kind: "purged", changed: false, record: purged.record });
  assert.equal((await db.select().from(artifactPurges).where(eq(artifactPurges.itemId, item.id))).length, 1);
  assert.deepEqual(await blobRows(world.serverId), [shared.id, kept.id].sort());
  assert.equal(objects.size, 2);
  assert.equal(await planArtifactPurge(item.id), null, "nothing left to plan");
  assert.deepEqual(await purgeArtifact(`pt_${randomUUID()}`, "x", store), { kind: "not_found" });
});

test("purge: an object whose delete fails stays pending in the record, and the next run deletes it", async ({ seed }) => {
  const objects = new Map<string, Buffer>();
  const { store, failDeletes } = memoryR2(objects);
  const world = await seedServer(seed, objects);
  const { item } = await world.make([{ "index.html": "only here" }]);
  const { key } = await world.blob("only here");

  failDeletes.on = true;
  const purged = await purgeArtifact(item.id, "report #10", store);
  assert.ok(purged.kind === "purged" && purged.changed);
  assert.deepEqual(purged.kind === "purged" ? purged.record.pendingObjectKeys : null, [key], "its row went; its object is still to delete");
  assert.deepEqual(await blobRows(world.serverId), []);
  assert.ok(objects.has(key));

  failDeletes.on = false;
  const again = await purgeArtifact(item.id, "report #10", store);
  assert.ok(again.kind === "purged" && !again.changed);
  assert.deepEqual(again.kind === "purged" ? again.record.pendingObjectKeys : null, []);
  assert.equal(objects.has(key), false);
  // Without a store nothing is deleted: every key stays pending.
  const { item: next } = await world.make([{ "index.html": "no bucket" }]);
  const { key: nextKey } = await world.blob("no bucket");
  const unstored = await purgeArtifact(next.id, "report #11", null);
  assert.deepEqual(unstored.kind === "purged" ? unstored.record.pendingObjectKeys : null, [nextKey]);
});
