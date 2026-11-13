// Core's object files (services/objectFiles.ts, platform/objectFiles) on the
// migrated schema, with an Artifact as the object (the one registered kind):
// what putObjectFile stores (the type from the bytes alone, never SVG or
// HTML; the size cap; the pixel cap from the header before any decoding;
// metadata removed, and the pixel size kept on the row; an upload billed to
// the uploader's own server: its total, the uploader's drafts and total
// there, race-safe under its lock, and its monthly file upload quota; the
// platform's own files under none of them), claiming a draft (only the same object and
// uploader, answering what core stored), moving a part's files to another
// part (only that object, only that exact part), letting files go in the
// app's transaction (rows at once, a rollback keeps them; bytes only after
// the commit, a failed delete counted and left to the sweep), the sweep
// (drafts unclaimed for an hour, their monthly bytes given back once; a
// soft-deleted server's files; batches until done or out of time, two
// sweeps never taking the same rows), and
// deleting the Artifact. The read rules (a draft, unclaimed or on a
// `draft:` part, only for its uploader) are shot.api.test.ts's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { asServerId, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { objectFiles, serverFileUploadUsageMonths, servers } from "../../db/schema";
import { objectFileByteDeletesTotal } from "../../metrics";
import { AppObjectStorageUnavailableError } from "../../services/appObjectStorage";
import { billingUsageMonth, FileUploadQuotaExceededError } from "../../services/fileUploadQuotaService";
import {
  __setObjectFilesStorageForTests,
  claimObjectFile,
  deleteObjectFileBytes,
  deleteObjectFiles,
  moveObjectFiles,
  OBJECT_FILE_MAX_BYTES,
  OBJECT_FILE_MAX_PIXELS,
  OBJECT_FILE_UNCLAIMED_TTL_MS,
  OBJECT_FILES_MAX_BYTES_PER_SERVER,
  OBJECT_FILES_MAX_BYTES_PER_UPLOADER,
  OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER,
  ObjectFileRefusedError,
  objectFilesUsage,
  putObjectFile,
  sweepObjectFiles,
  type DeletedObjectFiles,
  type ObjectFileBilling,
  type ObjectFileRefusalReason,
} from "../../services/objectFiles";
import { installMemoryObjectFilesStorage } from "../../test/memoryObjectFilesStorage";
import { jpegHeaderOnly, pngChunk, pngChunksOf, testGif, testJpeg, testPng, testWebp } from "../../test/objectFileTestImages";
import { dbTest as test } from "../../test/integration/dbTest";
import type { createSeed } from "../../test/integration/seed";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { deleteArtifact } from "./manage";
import { artifactItems } from "./schema";

const PNG = (label = "") => testPng(label);
/**
 * putObjectFile as these tests use it: the platform's own (`exempt`: no
 * caps, no monthly quota) unless a test asks for an upload (`monthly`, with
 * the server it is billed to), so the cases about anything else don't depend
 * on a Free server's month or the caps.
 */
const put = (input: Omit<Parameters<typeof putObjectFile>[0], "quota"> & ({ quota?: "exempt" } | ObjectFileBilling)) =>
  putObjectFile(input.quota === "monthly" ? input : { ...input, quota: "exempt" });
/** An upload by `uploadedBy`, billed to `billedTo`. */
const upload = (input: Omit<Parameters<typeof putObjectFile>[0], "quota">, billedTo: ServerId) => putObjectFile({ ...input, quota: "monthly", billedTo });

let storage: ReturnType<typeof installMemoryObjectFilesStorage>;
beforeEach(() => {
  storage = installMemoryObjectFilesStorage();
});
afterEach(() => {
  storage.restore();
});

/** A server, its owner, and live Artifacts in it (the objects files belong to). */
async function seedServer(seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const serverId = asServerId(server.id);
  const makeItem = async () => {
    const id = `pt_${randomUUID()}`;
    await getDb().insert(artifactItems).values({ id, serverId, urlKey: id, name: id, title: id, homeKind: "server", createdByType: "user", createdById: owner.id });
    return { kind: ARTIFACT_OBJECT_KIND, id };
  };
  return { owner, server, serverId, makeItem, by: { type: "user" as const, id: owner.id } };
}

const rowOf = async (id: string) => (await getDb().select().from(objectFiles).where(eq(objectFiles.id, id)))[0];
const refusedWith = (reason: ObjectFileRefusalReason) => (error: unknown) => error instanceof ObjectFileRefusedError && error.reason === reason;
async function byteDeletes(outcome: "deleted" | "failed", caller: "after_commit" | "sweep"): Promise<number> {
  const metric = await objectFileByteDeletesTotal.get();
  return metric.values.find((value) => value.labels.outcome === outcome && value.labels.caller === caller)?.value ?? 0;
}

test("put: the type from the bytes alone (PNG, JPEG, WebP, GIF; never SVG or HTML named as an image), under the size cap, for a live object", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const images = [
    [PNG("x"), "image/png", [2, 2]],
    [await testJpeg("x", { width: 4, height: 2 }), "image/jpeg", [4, 2]],
    [await testWebp("x", { width: 6, height: 3 }), "image/webp", [6, 3]],
    [await testGif("x", { width: 5, height: 1 }), "image/gif", [5, 1]],
  ] as const;
  for (const [bytes, type, [width, height]] of images) {
    const stored = await put({ object, parent: "version:v_1", bytes, uploadedBy: world.by });
    const row = (await rowOf(stored.id))!;
    // What is answered and recorded is what was stored (a JPEG or WebP encoded again): its type, size and pixel size.
    const kept = storage.objects.get(row.storageKey)!;
    assert.deepEqual(stored, { id: stored.id, contentType: type, sizeBytes: kept.bytes.length, width, height });
    assert.deepEqual([row.serverId, row.objectKind, row.objectId, row.parent, row.state, row.contentType, row.sizeBytes, row.width, row.height], [world.serverId, object.kind, object.id, "version:v_1", "claimed", type, kept.bytes.length, width, height]);
    assert.equal(kept.contentType, type);
    assert.equal((await sharp(kept.bytes).metadata()).format, type.slice("image/".length));
    assert.ok(row.storageKey.startsWith(`servers/${world.serverId}/files/`), "a relative key under core's prefix");
  }
  const before = storage.objects.size;
  const refused: Array<[Buffer, ObjectFileRefusalReason]> = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "unsupported_type"],
    [Buffer.from("<!doctype html><script>alert(1)</script>"), "unsupported_type"],
    [Buffer.from("\xef\xbb\xbf<svg/>", "latin1"), "unsupported_type"],
    [Buffer.from("%PDF-1.7"), "unsupported_type"],
    // The first bytes of an image, but no header that parses: no image core keeps.
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x3c, 0x73, 0x76, 0x67]), "unsupported_type"],
    [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "unsupported_type"],
    [Buffer.alloc(0), "empty"],
    [Buffer.concat([PNG(), Buffer.alloc(OBJECT_FILE_MAX_BYTES)]), "too_large"],
  ];
  for (const [bytes, reason] of refused) {
    await assert.rejects(put({ object, parent: null, bytes, uploadedBy: world.by }), refusedWith(reason), reason);
  }
  // The largest file there may be is stored (its pixel data padded: a PNG's is kept byte for byte).
  const largest = await put({ object, parent: null, bytes: testPng("largest", { padTo: OBJECT_FILE_MAX_BYTES }), uploadedBy: world.by });
  assert.equal(largest.sizeBytes, OBJECT_FILE_MAX_BYTES);
  assert.equal(storage.objects.size, before + 1, "nothing refused was stored");
  // An object the kind doesn't report (unknown, or deleted) has no files.
  await assert.rejects(put({ object: { kind: ARTIFACT_OBJECT_KIND, id: `pt_${randomUUID()}` }, parent: null, bytes: PNG(), uploadedBy: world.by }), refusedWith("object_not_found"));
  await getDb().update(artifactItems).set({ deletedAt: new Date() }).where(eq(artifactItems.id, object.id));
  await assert.rejects(put({ object, parent: null, bytes: PNG(), uploadedBy: world.by }), refusedWith("object_not_found"));
  // A kind nobody registered, or a part reference that isn't one, is the caller's bug.
  await assert.rejects(put({ object: { kind: "nope", id: "x" }, parent: null, bytes: PNG(), uploadedBy: world.by }), /not a registered object kind/);
  const live = await world.makeItem();
  await assert.rejects(put({ object: live, parent: "version", bytes: PNG(), uploadedBy: world.by }), /not a part reference/);
  // Without the platform's bucket: nothing stored.
  storage.restore();
  storage = installMemoryObjectFilesStorage({ configured: false });
  await assert.rejects(put({ object: live, parent: null, bytes: PNG(), uploadedBy: world.by }), AppObjectStorageUnavailableError);
  assert.equal((await getDb().select().from(objectFiles).where(eq(objectFiles.objectId, live.id))).length, 0);
});

test("put: an upload is billed to the uploader's own server, never the object's; over that server's total nothing is stored; the platform's own files are under no cap", async ({ seed }) => {
  const world = await seedServer(seed);
  const peer = await seedServer(seed);
  const object = await world.makeItem();
  // A member of another server (a joint channel's) uploads to world's Artifact: their own server is billed.
  const agent = { type: "agent" as const, id: randomUUID() };
  const stored = await upload({ object, parent: "comment:c_1", bytes: PNG("peer"), uploadedBy: peer.by }, peer.serverId);
  const byAgent = await upload({ object, parent: null, bytes: PNG("agent"), uploadedBy: agent }, world.serverId);
  const shot = await put({ object, parent: "version:v_1", bytes: PNG("shot"), uploadedBy: world.by });
  assert.deepEqual([(await rowOf(stored.id))!.serverId, (await rowOf(stored.id))!.billedServerId, (await rowOf(stored.id))!.quota], [world.serverId, peer.serverId, "monthly"]);
  assert.deepEqual([(await rowOf(byAgent.id))!.uploadedByType, (await rowOf(byAgent.id))!.uploadedById, (await rowOf(byAgent.id))!.billedServerId], ["agent", agent.id, world.serverId]);
  assert.deepEqual([(await rowOf(shot.id))!.billedServerId, (await rowOf(shot.id))!.quota, (await rowOf(shot.id))!.quotaMonth], [world.serverId, "exempt", null], "the platform's own: the object's server, counted by nothing");
  // Each server's usage: its uploads (whoever's object they hang on), and its platform files apart.
  assert.deepEqual(await objectFilesUsage(peer.serverId), { uploadedBytes: stored.sizeBytes, platformBytes: 0, limitBytes: OBJECT_FILES_MAX_BYTES_PER_SERVER });
  assert.deepEqual(await objectFilesUsage(world.serverId), { uploadedBytes: byAgent.sizeBytes, platformBytes: shot.sizeBytes, limitBytes: OBJECT_FILES_MAX_BYTES_PER_SERVER });

  // Fill world to just under its total: rows standing for files already there, written before
  // billed_server_id (NULL: read as their object's server), by several uploaders (each under their own cap).
  const used = OBJECT_FILES_MAX_BYTES_PER_SERVER - 100 - (await objectFilesUsage(world.serverId)).uploadedBytes;
  const fillers = [1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000, used - 4_000_000_000];
  await getDb().insert(objectFiles).values(fillers.map((sizeBytes, at) => ({
    id: randomUUID(), serverId: world.serverId, objectKind: object.kind, objectId: object.id, parent: "version:v_old", state: "claimed" as const,
    uploadedByType: "user" as const, uploadedById: randomUUID(), contentType: "image/png" as const, sizeBytes, storageKey: `servers/${world.serverId}/files/filler-${at}`,
  })));
  const keys = storage.objects.size;
  await assert.rejects(
    upload({ object, parent: null, bytes: testPng("big", { padTo: 300 }), uploadedBy: world.by }, world.serverId),
    (error: unknown) => error instanceof ObjectFileRefusedError && error.reason === "server_quota_exceeded" && error.details.limit === OBJECT_FILES_MAX_BYTES_PER_SERVER,
  );
  assert.equal(storage.objects.size, keys, "no bytes written");
  // What still fits is stored; the peer, billed on its own server, uploads to the full server's Artifact as before;
  // the platform's screenshots are kept however full the server is.
  assert.ok(PNG("fits").length < 100);
  await upload({ object, parent: null, bytes: PNG("fits"), uploadedBy: world.by }, world.serverId);
  await upload({ object, parent: null, bytes: testPng("big", { padTo: 300 }), uploadedBy: peer.by }, peer.serverId);
  await put({ object, parent: "version:v_2", bytes: testPng("shot", { padTo: 300 }), uploadedBy: world.by });
  // A billed server that isn't live is the caller's bug: refused, never billed to the object's server.
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, peer.server.id));
  await assert.rejects(upload({ object, parent: null, bytes: PNG("orphan"), uploadedBy: peer.by }, peer.serverId), /not a live server/);
  await assert.rejects(upload({ object, parent: null, bytes: PNG("nowhere"), uploadedBy: peer.by }, asServerId(randomUUID())), /not a live server/);
});

/** Rows standing for `uploader`'s files already billed to `serverId` (sizes, each a row), on `parent` (null: unclaimed). */
async function seedUploads(input: { serverId: ServerId; object: { kind: string; id: string }; uploader: { type: "user" | "agent"; id: string }; sizes: number[]; parent: string | null; state?: "deleted" }) {
  await getDb().insert(objectFiles).values(input.sizes.map((sizeBytes) => {
    const id = randomUUID();
    const state = input.state ?? (input.parent === null ? "unclaimed" as const : "claimed" as const);
    return {
      id, serverId: input.serverId, billedServerId: input.serverId, quota: "monthly" as const, objectKind: input.object.kind, objectId: input.object.id,
      parent: input.parent, state, deletedAt: state === "deleted" ? new Date() : null,
      uploadedByType: input.uploader.type, uploadedById: input.uploader.id, contentType: "image/png" as const, sizeBytes, storageKey: `servers/${input.serverId}/files/${id}`,
    };
  }));
}

test("put: one uploader's drafts on the billed server are capped (unclaimed and on a `draft:` part); posting or deleting them frees room; counted per server, per uploader", async ({ seed }) => {
  const world = await seedServer(seed);
  const peer = await seedServer(seed);
  const object = await world.makeItem();
  const other = { type: "user" as const, id: (await seed.human()).id };
  const near = OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER - 100;
  // Half unclaimed, half on a review draft's part.
  await seedUploads({ serverId: world.serverId, object, uploader: world.by, sizes: [near / 2], parent: null });
  await seedUploads({ serverId: world.serverId, object, uploader: world.by, sizes: [near / 2], parent: "draft:d_1" });
  const big = testPng("big", { padTo: 300 });
  const keys = storage.objects.size;
  await assert.rejects(upload({ object, parent: null, bytes: big, uploadedBy: world.by }, world.serverId), (error: unknown) =>
    error instanceof ObjectFileRefusedError && error.reason === "uploader_quota_exceeded" && error.details.scope === "drafts"
    && error.details.limit === OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER && error.details.used === near
    && /Posting or deleting drafts frees room/.test(error.message));
  await assert.rejects(upload({ object, parent: "draft:d_2", bytes: big, uploadedBy: world.by }, world.serverId), refusedWith("uploader_quota_exceeded"), "a draft part is a draft too");
  assert.equal(storage.objects.size, keys, "no bytes written");
  // Not a draft (put on a part at once), another uploader, and the same person billed on another server: room.
  await upload({ object, parent: "comment:c_1", bytes: big, uploadedBy: world.by }, world.serverId);
  await upload({ object, parent: null, bytes: big, uploadedBy: other }, world.serverId);
  await upload({ object, parent: null, bytes: big, uploadedBy: world.by }, peer.serverId);
  // The same id as an agent is another uploader.
  await upload({ object, parent: null, bytes: big, uploadedBy: { type: "agent", id: world.owner.id } }, world.serverId);
  // Posting the review draft (its files moved to the comment's part) frees room.
  await getDb().transaction((tx) => moveObjectFiles({ object, from: "draft:d_1", to: "comment:c_posted", executor: tx }));
  await upload({ object, parent: null, bytes: big, uploadedBy: world.by }, world.serverId);
});

test("put: all of one uploader's uploads on the billed server are capped; deleted ones don't count; the platform's own files of theirs neither", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const near = OBJECT_FILES_MAX_BYTES_PER_UPLOADER - 100;
  await seedUploads({ serverId: world.serverId, object, uploader: world.by, sizes: [near / 2, near / 2], parent: "comment:c_1" });
  await seedUploads({ serverId: world.serverId, object, uploader: world.by, sizes: [500_000_000], parent: "comment:c_gone", state: "deleted" });
  const big = testPng("big", { padTo: 300 });
  await assert.rejects(upload({ object, parent: "comment:c_2", bytes: big, uploadedBy: world.by }, world.serverId), (error: unknown) =>
    error instanceof ObjectFileRefusedError && error.reason === "uploader_quota_exceeded" && error.details.scope === "total"
    && error.details.limit === OBJECT_FILES_MAX_BYTES_PER_UPLOADER && error.details.used === near);
  // A publish check's screenshot "by" the same person (the version's publisher) is the platform's: kept.
  await put({ object, parent: "version:v_1", bytes: big, uploadedBy: world.by });
  // What still fits is stored.
  assert.ok(PNG("fits").length < 100);
  await upload({ object, parent: "comment:c_3", bytes: PNG("fits"), uploadedBy: world.by }, world.serverId);
});

test("put: the caps are re-read under the billed server's lock: two uploads that each fit but not together, at once, keep one", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const a = testPng("a", { padTo: 300 });
  const b = testPng("b", { padTo: 300 });
  // Room for one of them: both pass the first look without the lock, one is refused under it.
  await seedUploads({ serverId: world.serverId, object, uploader: world.by, sizes: [OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER - 450], parent: null });
  const results = await Promise.allSettled([
    upload({ object, parent: null, bytes: a, uploadedBy: world.by }, world.serverId),
    upload({ object, parent: null, bytes: b, uploadedBy: world.by }, world.serverId),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(refused.reason instanceof ObjectFileRefusedError && refused.reason.reason === "uploader_quota_exceeded", String(refused.reason));
  const [drafts] = await getDb().select({ total: sql<string>`sum(${objectFiles.sizeBytes})` }).from(objectFiles)
    .where(and(eq(objectFiles.billedServerId, world.serverId), eq(objectFiles.state, "unclaimed")));
  assert.ok(Number(drafts!.total) <= OBJECT_FILES_MAX_DRAFT_BYTES_PER_UPLOADER, "never over the cap");
});

test("claim: only an unclaimed file of the same object, by the one who uploaded it", async ({ seed }) => {
  const world = await seedServer(seed);
  const other = await seed.human();
  const object = await world.makeItem();
  const elsewhere = await world.makeItem();
  const draft = await put({ object, parent: null, bytes: PNG("draft"), uploadedBy: world.by });
  assert.deepEqual([(await rowOf(draft.id))!.state, (await rowOf(draft.id))!.parent], ["unclaimed", null]);

  const claim = (input: Partial<Parameters<typeof claimObjectFile>[0]>) =>
    claimObjectFile({ object, fileId: draft.id, parent: "comment:c_1", by: world.by, ...input });
  assert.equal(await claim({ by: { type: "user", id: other.id } }), null, "another uploader");
  assert.equal(await claim({ by: { type: "agent", id: world.owner.id } }), null, "the same id as another kind of actor");
  assert.equal(await claim({ object: elsewhere }), null, "another object");
  assert.equal(await claim({ fileId: randomUUID() }), null, "no such file");
  assert.equal(await claim({ fileId: "not-a-uuid" }), null);
  assert.equal((await rowOf(draft.id))!.state, "unclaimed", "nothing changed");
  // Claimed: what core stored, never anything the uploader says.
  assert.deepEqual(await claim({}), draft);
  assert.deepEqual([(await rowOf(draft.id))!.state, (await rowOf(draft.id))!.parent], ["claimed", "comment:c_1"]);
  assert.equal(await claim({ parent: "comment:c_2" }), null, "already claimed");
  // A file put for a part at once is claimed already.
  const direct = await put({ object, parent: "version:v_1", bytes: PNG(), uploadedBy: world.by });
  assert.equal(await claimObjectFile({ object, fileId: direct.id, parent: "comment:c_3", by: world.by }), null);
  // A row from before core read sizes answers none.
  await getDb().update(objectFiles).set({ width: null, height: null }).where(eq(objectFiles.id, direct.id));
  const older = await put({ object, parent: null, bytes: PNG("older"), uploadedBy: world.by });
  await getDb().update(objectFiles).set({ width: null, height: null }).where(eq(objectFiles.id, older.id));
  assert.deepEqual(await claimObjectFile({ object, fileId: older.id, parent: "comment:c_4", by: world.by }), { ...older, width: null, height: null });
});

test("delete: the rows go in the app's transaction (a rollback keeps them), the bytes only after the commit; a failed byte delete is counted and swept", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const other = await world.makeItem();
  const v1 = await put({ object, parent: "version:v_1", bytes: PNG("v1"), uploadedBy: world.by });
  const v2 = await put({ object, parent: "version:v_2", bytes: PNG("v2"), uploadedBy: world.by });
  const kept = await put({ object: other, parent: "version:v_1", bytes: PNG("other"), uploadedBy: world.by });
  const keyOf = async (id: string) => (await rowOf(id))!.storageKey;
  const [v1Key, v2Key, keptKey] = [await keyOf(v1.id), await keyOf(v2.id), await keyOf(kept.id)];

  // Rolled back: nothing let go, and a delete of bytes afterwards touches nothing.
  const rolledBack: { files?: DeletedObjectFiles } = {};
  await assert.rejects(db.transaction(async (tx) => {
    rolledBack.files = await deleteObjectFiles({ object, parent: "version:v_1", executor: tx });
    throw new Error("the app's write failed");
  }), /the app's write failed/);
  assert.deepEqual(rolledBack.files!.fileIds, [v1.id]);
  assert.equal((await rowOf(v1.id))!.state, "claimed");
  assert.equal(await deleteObjectFileBytes(rolledBack.files!), 0);
  assert.ok(storage.objects.has(v1Key));

  // Committed: the part's files only; inside the transaction the rows are let go and the bytes untouched.
  const released = await db.transaction(async (tx) => {
    const files = await deleteObjectFiles({ object, parent: "version:v_1", executor: tx });
    const [row] = await tx.select().from(objectFiles).where(eq(objectFiles.id, v1.id));
    assert.equal(row!.state, "deleted");
    assert.ok(row!.deletedAt);
    assert.ok(storage.objects.has(v1Key), "no bytes before the commit");
    await assert.rejects(deleteObjectFileBytes(files), /after the transaction/);
    return files;
  });
  assert.deepEqual(released.fileIds, [v1.id]);
  assert.equal(await deleteObjectFileBytes(released), 1);
  assert.equal(await rowOf(v1.id), undefined, "the row goes with its bytes");
  assert.equal(storage.objects.has(v1Key), false);
  assert.ok(storage.objects.has(v2Key) && storage.objects.has(keptKey), "another part's and another object's stay");

  // A byte delete that fails: counted, the row stays let go (invisible) for the sweep.
  const failedBefore = await byteDeletes("failed", "after_commit");
  const all = await db.transaction((tx) => deleteObjectFiles({ object, executor: tx }));
  assert.deepEqual(all.fileIds, [v2.id], "every file of the object left");
  storage.failDeletes.on = true;
  assert.equal(await deleteObjectFileBytes(all), 0);
  assert.equal(await byteDeletes("failed", "after_commit"), failedBefore + 1);
  assert.equal((await rowOf(v2.id))!.state, "deleted");
  assert.ok(storage.objects.has(v2Key));
  storage.failDeletes.on = false;
  const sweptBefore = await byteDeletes("deleted", "sweep");
  assert.equal((await sweepObjectFiles()).purged, 1);
  assert.equal(await byteDeletes("deleted", "sweep"), sweptBefore + 1);
  assert.equal(await rowOf(v2.id), undefined);
  assert.equal(storage.objects.has(v2Key), false);
  assert.ok(await rowOf(kept.id));
  // Several parts at once, and none.
  assert.deepEqual((await db.transaction((tx) => deleteObjectFiles({ object: other, parent: [], executor: tx }))).fileIds, []);
  assert.deepEqual((await db.transaction((tx) => deleteObjectFiles({ object: other, parent: ["version:v_9", "version:v_1"], executor: tx }))).fileIds, [kept.id]);
});

test("the sweep lets go of drafts unclaimed for an hour and of a soft-deleted server's files, then deletes their bytes", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const gone = await seedServer(seed);
  const object = await world.makeItem();
  const now = new Date(Date.now() + 1000);
  const age = async (id: string, ms: number) => db.update(objectFiles).set({ createdAt: new Date(now.getTime() - ms) }).where(eq(objectFiles.id, id));
  const old = await put({ object, parent: null, bytes: PNG("old"), uploadedBy: world.by });
  const fresh = await put({ object, parent: null, bytes: PNG("fresh"), uploadedBy: world.by });
  const claimedOld = await put({ object, parent: null, bytes: PNG("claimed"), uploadedBy: world.by });
  await age(old.id, OBJECT_FILE_UNCLAIMED_TTL_MS + 60_000);
  await age(fresh.id, OBJECT_FILE_UNCLAIMED_TTL_MS - 60_000);
  await age(claimedOld.id, OBJECT_FILE_UNCLAIMED_TTL_MS + 60_000);
  assert.ok(await claimObjectFile({ object, fileId: claimedOld.id, parent: "comment:c_1", by: world.by }));
  const ofGone = await put({ object: await gone.makeItem(), parent: "version:v_1", bytes: PNG("gone"), uploadedBy: gone.by });
  const goneKey = (await rowOf(ofGone.id))!.storageKey;

  assert.deepEqual(await sweepObjectFiles({ now }), { released: 1, purged: 1 });
  assert.equal(await rowOf(old.id), undefined, "a draft unclaimed for over an hour");
  assert.ok(await rowOf(fresh.id), "a younger draft stays");
  assert.ok(await rowOf(claimedOld.id), "a claimed file stays, however old");

  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, gone.server.id));
  assert.deepEqual(await sweepObjectFiles({ now }), { released: 1, purged: 1 });
  assert.equal(await rowOf(ofGone.id), undefined);
  assert.equal(storage.objects.has(goneKey), false);
  assert.deepEqual(await sweepObjectFiles({ now }), { released: 0, purged: 0 });

  // Out of time: one batch of each, then it stops (a batch of one, no time left); without the bucket rows wait.
  const a = await put({ object, parent: null, bytes: PNG("a"), uploadedBy: world.by });
  const b = await put({ object, parent: null, bytes: PNG("b"), uploadedBy: world.by });
  await age(a.id, OBJECT_FILE_UNCLAIMED_TTL_MS + 1);
  await age(b.id, OBJECT_FILE_UNCLAIMED_TTL_MS + 1);
  assert.deepEqual(await sweepObjectFiles({ now, batch: 1, budgetMs: 0 }), { released: 1, purged: 1 });
  storage.restore();
  storage = installMemoryObjectFilesStorage({ configured: false });
  assert.deepEqual(await sweepObjectFiles({ now }), { released: 1, purged: 0 });
  assert.equal((await db.select().from(objectFiles).where(and(eq(objectFiles.objectId, object.id), eq(objectFiles.state, "deleted")))).length, 1, "let go, its bytes for a later run");
});

test("the sweep takes batches until none are left (within its time): every stale draft and every let-go file in one run", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const now = new Date(Date.now() + 1000);
  const drafts = [];
  for (let at = 0; at < 5; at++) drafts.push(await put({ object, parent: null, bytes: PNG(`stale ${at}`), uploadedBy: world.by }));
  await db.update(objectFiles).set({ createdAt: new Date(now.getTime() - OBJECT_FILE_UNCLAIMED_TTL_MS - 60_000) }).where(eq(objectFiles.objectId, object.id));
  assert.deepEqual(await sweepObjectFiles({ now, batch: 2 }), { released: 5, purged: 5 }, "three batches of two, one run");
  for (const draft of drafts) assert.equal(await rowOf(draft.id), undefined);
  assert.equal(storage.objects.size, 0);
  assert.deepEqual(await sweepObjectFiles({ now, batch: 2 }), { released: 0, purged: 0 });
});

// Two instances' sweeps: each batch takes its rows FOR UPDATE SKIP LOCKED (a row the other holds is
// skipped, not waited on); PGlite is one connection, so that half needs real PostgreSQL and is not
// shown here. The purge's lease is: its claim moves deleted_at ahead, so another sweep finds nothing due.
test("a purge's claim leases its rows: a sweep meanwhile finds nothing due; one whose bytes failed comes back once the lease passed", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const now = new Date(Date.now() + 1000);
  const stale = await put({ object, parent: null, bytes: PNG("stale"), uploadedBy: world.by });
  await db.update(objectFiles).set({ createdAt: new Date(now.getTime() - OBJECT_FILE_UNCLAIMED_TTL_MS - 60_000) }).where(eq(objectFiles.id, stale.id));
  storage.failDeletes.on = true;
  assert.deepEqual(await sweepObjectFiles({ now }), { released: 1, purged: 0 });
  const leased = (await rowOf(stale.id))!;
  assert.equal(leased.state, "deleted");
  assert.ok(leased.deletedAt!.getTime() > now.getTime(), "claimed: leased ahead");
  storage.failDeletes.on = false;
  assert.deepEqual(await sweepObjectFiles({ now }), { released: 0, purged: 0 }, "still leased to the first sweep");
  assert.deepEqual(await sweepObjectFiles({ now: new Date(leased.deletedAt!.getTime() + 1) }), { released: 0, purged: 1 });
  assert.equal(await rowOf(stale.id), undefined);
});

test("the sweep gives a stale upload's bytes back to its billed server's month, once, in the transaction that lets it go", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const peer = await seedServer(seed);
  const object = await world.makeItem();
  const now = new Date(Date.now() + 1000);
  const month = billingUsageMonth(now);
  const used = async (serverId: ServerId) => (await db.select().from(serverFileUploadUsageMonths)
    .where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, month))))[0]?.usedBytes ?? 0;
  const stale = (id: string) => db.update(objectFiles).set({ createdAt: new Date(now.getTime() - OBJECT_FILE_UNCLAIMED_TTL_MS - 60_000) }).where(eq(objectFiles.id, id));

  // A peer's upload to world's Artifact, never claimed: its bytes go back to the peer's month (the server billed).
  const [worldBefore, peerBefore] = [await used(world.serverId), await used(peer.serverId)];
  const unused = await upload({ object, parent: null, bytes: PNG("never posted"), uploadedBy: peer.by }, peer.serverId);
  const posted = await upload({ object, parent: null, bytes: PNG("posted"), uploadedBy: peer.by }, peer.serverId);
  assert.ok(await claimObjectFile({ object, fileId: posted.id, parent: "comment:c_1", by: peer.by }));
  // An upload counted in another month, and a platform file: nothing to give back.
  const lastMonth = await upload({ object, parent: null, bytes: PNG("last month"), uploadedBy: peer.by }, peer.serverId);
  await db.update(objectFiles).set({ quotaMonth: "2000-01" }).where(eq(objectFiles.id, lastMonth.id));
  const shot = await put({ object, parent: null, bytes: PNG("a shot nobody claimed"), uploadedBy: world.by });
  for (const file of [unused, posted, lastMonth, shot]) await stale(file.id);
  const counted = await used(peer.serverId);
  assert.equal(counted, peerBefore + unused.sizeBytes + posted.sizeBytes + lastMonth.sizeBytes);

  assert.equal((await sweepObjectFiles({ now })).released, 3);
  assert.equal(await used(peer.serverId), counted - unused.sizeBytes, "only the stale upload counted this month");
  assert.equal(await used(world.serverId), worldBefore, "the object's server was never charged, nor refunded");
  // Exactly once: the row is let go now, so another run (or the same rows again) gives nothing back.
  assert.equal((await sweepObjectFiles({ now })).released, 0);
  assert.equal(await used(peer.serverId), counted - unused.sizeBytes);

  // Never below zero (a month reset by hand, say).
  const again = await upload({ object, parent: null, bytes: PNG("again"), uploadedBy: peer.by }, peer.serverId);
  await stale(again.id);
  await db.update(serverFileUploadUsageMonths).set({ usedBytes: 1 }).where(and(eq(serverFileUploadUsageMonths.serverId, peer.serverId), eq(serverFileUploadUsageMonths.month, month)));
  assert.equal((await sweepObjectFiles({ now })).released, 1);
  assert.equal(await used(peer.serverId), 0);
});

test("deleting the Artifact lets every file of it go in its transaction and deletes their bytes after", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const other = await world.makeItem();
  const files = [
    await put({ object, parent: "version:v_1", bytes: PNG("1"), uploadedBy: world.by }),
    await put({ object, parent: "comment:c_1", bytes: PNG("2"), uploadedBy: world.by }),
    await put({ object, parent: null, bytes: PNG("3"), uploadedBy: world.by }),
  ];
  const kept = await put({ object: other, parent: "version:v_1", bytes: PNG("kept"), uploadedBy: world.by });
  const keptKey = (await rowOf(kept.id))!.storageKey;

  const result = await deleteArtifact({ type: "user", id: world.owner.id, serverId: world.serverId }, object.id);
  assert.equal(result.kind, "deleted");
  for (const file of files) assert.equal(await rowOf(file.id), undefined);
  assert.deepEqual([...storage.objects.keys()], [keptKey], "only another Artifact's bytes are left");
});

test("put: over the pixel cap by its header is refused before anything is decoded or stored", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const keys = storage.objects.size;
  // 48 megapixels declared by a JPEG with nothing to decode: refused for its pixels (decoding it
  // would have failed as unsupported_type), so the header was read before any decoding.
  await assert.rejects(put({ object, parent: null, bytes: jpegHeaderOnly(8000, 6000), uploadedBy: world.by }), (error: unknown) =>
    error instanceof ObjectFileRefusedError && error.reason === "too_many_pixels" && error.details.limit === OBJECT_FILE_MAX_PIXELS);
  await assert.rejects(put({ object, parent: null, bytes: jpegHeaderOnly(100, 100), uploadedBy: world.by }), refusedWith("unsupported_type"));
  // A tiny PNG that declares 50 megapixels (a decode bomb for whoever draws it).
  await assert.rejects(put({ object, parent: null, bytes: testPng("bomb", { width: 10_000, height: 5000, header: true }), uploadedBy: world.by }), refusedWith("too_many_pixels"));
  assert.equal(storage.objects.size, keys, "nothing stored");
  assert.equal((await getDb().select().from(objectFiles).where(eq(objectFiles.objectId, object.id))).length, 0);
});

test("put: metadata is removed from what every uploader stores (JPEG and WebP encoded again, PNG chunks dropped with its pixel data kept, GIF as it is)", async ({ seed }) => {
  const world = await seedServer(seed);
  const object = await world.makeItem();
  const agent = { type: "agent" as const, id: randomUUID() };
  const storedBytes = async (id: string) => storage.objects.get((await rowOf(id))!.storageKey)!.bytes;

  for (const uploadedBy of [world.by, agent]) {
    // A phone photo: EXIF with a place and the camera, turned by its orientation.
    const photo = await testJpeg("photo", { width: 4, height: 2, orientation: 6, exif: { ImageDescription: "51.5N 0.1W", Make: "PhoneCo" } });
    const jpeg = await put({ object, parent: null, bytes: photo, uploadedBy });
    const keptJpeg = await sharp(await storedBytes(jpeg.id)).metadata();
    assert.equal(keptJpeg.exif, undefined, "a JPEG's EXIF is gone");
    assert.equal((await storedBytes(jpeg.id)).includes(Buffer.from("51.5N")), false);
    assert.deepEqual([jpeg.width, jpeg.height, keptJpeg.width, keptJpeg.height], [2, 4, 2, 4], "kept upright, and measured so");

    const webp = await put({ object, parent: null, bytes: await testWebp("pic", { exif: { ImageDescription: "51.5N 0.1W" } }), uploadedBy });
    assert.equal((await sharp(await storedBytes(webp.id)).metadata()).exif, undefined, "a WebP's EXIF is gone");

    const text = pngChunk("tEXt", Buffer.from("Comment\0taken at 51.5N 0.1W"));
    const exif = pngChunk("eXIf", Buffer.from("MM\0*\0\0\0\x08", "latin1"));
    const time = pngChunk("tIME", Buffer.from([0x07, 0xea, 1, 2, 3, 4, 5]));
    const screenshot = testPng("screenshot", { width: 3, height: 2, before: [text, exif], after: [time] });
    const png = await put({ object, parent: null, bytes: screenshot, uploadedBy });
    const keptPng = await storedBytes(png.id);
    assert.deepEqual(pngChunksOf(keptPng).map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"], "the text, EXIF and time chunks are gone");
    const idat = (bytes: Buffer) => pngChunksOf(bytes).filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.bytes);
    assert.deepEqual(idat(keptPng), idat(screenshot), "its pixel data byte for byte (never encoded again)");
    assert.deepEqual([png.sizeBytes, png.width, png.height], [keptPng.length, 3, 2]);

    const animation = await testGif("anim");
    const gif = await put({ object, parent: null, bytes: animation, uploadedBy });
    assert.deepEqual(await storedBytes(gif.id), animation, "a GIF as it was");
  }
});

test("put: what people and agents upload counts against the billed server's monthly file upload quota (the uploader's own); the platform's own files don't", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const peer = await seedServer(seed);
  const object = await world.makeItem();
  const month = billingUsageMonth();
  const usage = async (serverId: string) => {
    const [row] = await db.select().from(serverFileUploadUsageMonths).where(and(eq(serverFileUploadUsageMonths.serverId, serverId), eq(serverFileUploadUsageMonths.month, month)));
    return { used: row?.usedBytes ?? 0, reserved: row?.reservedBytes ?? 0 };
  };
  const setUsed = (usedBytes: number) => db.insert(serverFileUploadUsageMonths)
    .values({ serverId: world.server.id, month, usedBytes, reservedBytes: 0 })
    .onConflictDoUpdate({ target: [serverFileUploadUsageMonths.serverId, serverFileUploadUsageMonths.month], set: { usedBytes, reservedBytes: 0 } });

  // Counted once kept (its metadata gone), against the server billed: the uploader's own, not the object's.
  const before = await usage(world.server.id);
  const fromPeer = await upload({ object, parent: null, bytes: testPng("counted", { after: [pngChunk("tEXt", Buffer.alloc(500, 0x61))] }), uploadedBy: peer.by }, peer.serverId);
  assert.ok(fromPeer.sizeBytes < 500, "the bytes kept, not the bytes sent");
  assert.deepEqual(await usage(peer.server.id), { used: fromPeer.sizeBytes, reserved: 0 }, "the uploader's server");
  assert.deepEqual(await usage(world.server.id), before, "not the object's server");
  assert.deepEqual([(await rowOf(fromPeer.id))!.quota, (await rowOf(fromPeer.id))!.quotaMonth], ["monthly", month], "the month that counted it, on the row");
  const stored = await upload({ object, parent: null, bytes: PNG("own"), uploadedBy: world.by }, world.serverId);
  assert.deepEqual(await usage(world.server.id), { used: before.used + stored.sizeBytes, reserved: before.reserved });
  // Exempt (a publish check's screenshots): nothing counted.
  await putObjectFile({ object, parent: "version:v_1", bytes: PNG("shot"), uploadedBy: world.by, quota: "exempt" });
  assert.deepEqual(await usage(world.server.id), { used: before.used + stored.sizeBytes, reserved: before.reserved });

  // No room left this month: refused as attachments are, nothing stored, nothing held.
  await setUsed(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  const keys = storage.objects.size;
  await assert.rejects(upload({ object, parent: null, bytes: PNG("over"), uploadedBy: world.by }, world.serverId), FileUploadQuotaExceededError);
  assert.equal(storage.objects.size, keys, "the refused upload stored nothing");
  // Another server's full month is not the peer's: billed on their own, they still upload here.
  await upload({ object, parent: null, bytes: PNG("peer, still"), uploadedBy: peer.by }, peer.serverId);
  assert.equal(storage.objects.size, keys + 1, "the peer's upload stored");
  assert.deepEqual(await usage(world.server.id), { used: FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, reserved: 0 });
  // Bytes that can't be written give their reservation back: nothing counted.
  await setUsed(0);
  __setObjectFilesStorageForTests({
    configured: true,
    put: async () => { throw new Error("bucket put failed (test)"); },
    get: async () => null,
    delete: async () => {},
    presignGet: async () => "https://objects.example.test/x",
  });
  await assert.rejects(upload({ object, parent: null, bytes: PNG("lost"), uploadedBy: world.by }, world.serverId), /bucket put failed/);
  assert.deepEqual(await usage(world.server.id), { used: 0, reserved: 0 });
});

test("move: a part's files to another part of the same object, in the app's transaction; only files on exactly that part, the uploader kept", async ({ seed }) => {
  const db = getDb();
  const world = await seedServer(seed);
  const other = await seed.human();
  const object = await world.makeItem();
  const elsewhere = await world.makeItem();
  const draftFile = async (owner: { type: "user" | "agent"; id: string }, on: string, target = object) => {
    const file = await put({ object: target, parent: null, bytes: PNG(`${on} ${randomUUID()}`), uploadedBy: owner });
    assert.ok(await claimObjectFile({ object: target, fileId: file.id, parent: on, by: owner }));
    return file;
  };
  const mine = [await draftFile(world.by, "draft:d_1"), await draftFile(world.by, "draft:d_1")];
  const otherDraft = await draftFile(world.by, "draft:d_10");
  const sameNameElsewhere = await draftFile(world.by, "draft:d_1", elsewhere);
  const someoneElses = await draftFile({ type: "user", id: other.id }, "draft:d_2");
  const unclaimed = await put({ object, parent: null, bytes: PNG("unclaimed"), uploadedBy: world.by });

  // Rolled back with the app's write: nothing moved.
  await assert.rejects(db.transaction(async (tx) => {
    assert.equal((await moveObjectFiles({ object, from: "draft:d_1", to: "comment:c_1", executor: tx })).length, 2);
    throw new Error("the app's write failed");
  }), /the app's write failed/);
  assert.deepEqual((await rowOf(mine[0]!.id))!.parent, "draft:d_1");

  const moved = await db.transaction((tx) => moveObjectFiles({ object, from: "draft:d_1", to: "comment:c_1", executor: tx }));
  assert.deepEqual(moved.map((file) => file.id).sort(), mine.map((file) => file.id).sort());
  assert.deepEqual(moved.find((file) => file.id === mine[0]!.id), mine[0], "answers what core stored");
  for (const file of mine) {
    const row = (await rowOf(file.id))!;
    assert.deepEqual([row.parent, row.state, row.uploadedByType, row.uploadedById, row.objectId], ["comment:c_1", "claimed", "user", world.owner.id, object.id]);
  }
  // Exactly that part: not one whose name starts the same, not another object's of the same name, not another's draft, not an unclaimed file.
  assert.equal((await rowOf(otherDraft.id))!.parent, "draft:d_10");
  assert.equal((await rowOf(sameNameElsewhere.id))!.parent, "draft:d_1");
  assert.equal((await rowOf(someoneElses.id))!.parent, "draft:d_2");
  assert.deepEqual([(await rowOf(unclaimed.id))!.state, (await rowOf(unclaimed.id))!.parent], ["unclaimed", null]);
  // Nothing left there: an empty answer. A let go file never moves back.
  assert.deepEqual(await db.transaction((tx) => moveObjectFiles({ object, from: "draft:d_1", to: "comment:c_2", executor: tx })), []);
  await db.transaction((tx) => deleteObjectFiles({ object, parent: "draft:d_10", executor: tx }));
  assert.deepEqual(await db.transaction((tx) => moveObjectFiles({ object, from: "draft:d_10", to: "comment:c_3", executor: tx })), []);
  assert.equal((await rowOf(otherDraft.id))!.state, "deleted");
  // A part reference that isn't one is the caller's bug.
  await assert.rejects(db.transaction((tx) => moveObjectFiles({ object, from: "draft", to: "comment:c_1", executor: tx })), /not a part reference/);
});
