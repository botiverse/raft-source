import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  attachmentObjectArtifacts,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachments,
  attachmentUploadSessions,
  messages,
  users,
} from "../db/schema";
import type { StorageBackend } from "./storageService";
import { resetStorageForTests } from "./storageService";
import { createChannel } from "./channelService";
import { createServer } from "./serverService";
import { DurableAttachmentUploadSessionService } from "./attachmentUploadSessionService";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import {
  DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS,
  DIRECT_UPLOAD_THUMBNAIL_MAX_SOURCE_BYTES,
  claimNextDirectUploadThumbnailForTests,
  processDirectUploadThumbnail,
  processNextDirectUploadThumbnail,
} from "./attachmentDirectUploadThumbnailService";

// Task #57: a direct upload gets its thumbnail from a worker after completion.

afterEach(async () => {
  await closeTestDatabase();
  resetStorageForTests();
});

/** Direct-upload bucket holding real bytes, so the worker reads what the client PUT. */
class ByteStorage implements StorageBackend {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  failGets = 0;
  /** Replaces the next read's body (a reset or stalled connection). */
  nextBody: (() => Readable) | null = null;
  readonly gets: string[] = [];
  async put(): Promise<void> {}
  async get(key: string): Promise<Readable> {
    this.gets.push(key);
    if (this.failGets > 0) {
      this.failGets -= 1;
      throw new Error("storage unavailable");
    }
    if (this.nextBody) {
      const body = this.nextBody();
      this.nextBody = null;
      return body;
    }
    const object = this.objects.get(key);
    if (!object) throw new Error("missing");
    return Readable.from([object.bytes]);
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { sizeBytes: object.bytes.length, contentType: object.contentType, etag: "etag" } : null;
  }
  async getPresignedPutUrl(key: string): Promise<string> { return `https://r2.example.test/${key}`; }
}

class CdnStorage implements StorageBackend {
  readonly puts = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly deletes: string[] = [];
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> { this.puts.set(key, { bytes, contentType }); }
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.puts.delete(key);
  }
}

async function fixture() {
  await openTestDatabase("pglite://");
  const [owner] = await getDb().insert(users).values({
    email: `thumb-${randomUUID()}@slock.test`,
    name: `thumb-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Thumbs", `thumbs-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, `thumbs-${randomUUID()}`);
  const context = { serverId: server.id as ServerId, userId: owner.id };
  const storage = new ByteStorage();
  const kicks: number[] = [];
  let now = new Date("2026-10-22T00:00:00Z");
  const clock = () => now;
  const service = new DurableAttachmentUploadSessionService(storage, clock, {}, {
    onThumbnailPending: () => kicks.push(1),
  });
  const upload = async (mimeType: string, bytes: Buffer, filename = "image.png") => {
    const created = await service.create(context, {
      channelId: channel.id,
      filename,
      mimeType,
      sizeBytes: bytes.length,
      clientRequestId: randomUUID(),
    });
    assert.equal(created.status, 201);
    const { uploadId, attachmentId } = created.body as { uploadId: string; attachmentId: string };
    const [session] = await getDb().select().from(attachmentUploadSessions).where(eq(attachmentUploadSessions.id, uploadId));
    storage.objects.set(session.storageKey, { bytes, contentType: mimeType });
    const completed = await service.complete(context, uploadId);
    assert.equal(completed.status, 200);
    return { uploadId, attachmentId };
  };
  const session = async (uploadId: string) =>
    (await getDb().select().from(attachmentUploadSessions).where(eq(attachmentUploadSessions.id, uploadId)))[0]!;
  return {
    owner, server, channel, context, storage, kicks, upload, session, clock,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
  };
}

async function png(width = 640, height = 480): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
}

/** A PNG whose header claims width×height over a few bytes of pixel data: refused from the header alone. */
function pngHeaderOnly(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(64))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a completed image upload gets a thumbnail owned by its object, on the object and every projection", async () => {
  const { storage, kicks, upload, session, clock } = await fixture();
  const cdn = new CdnStorage();
  const { uploadId, attachmentId } = await upload("image/png", await png());

  assert.equal((await session(uploadId)).thumbnailState, "pending");
  assert.equal(kicks.length, 1, "completion wakes the worker without waiting for it");

  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "done");
  const after = await session(uploadId);
  assert.equal(after.thumbnailState, "done");
  assert.equal(after.thumbnailLeaseExpiresAt, null);

  const [projection] = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  const [object] = await getDb().select().from(attachmentObjects).where(eq(attachmentObjects.id, projection!.objectId!));
  assert.ok(object?.thumbnailKey?.endsWith(`${attachmentId}.webp`));
  const written = cdn.puts.get(object!.thumbnailKey!);
  assert.equal(written?.contentType, "image/webp");
  assert.ok((await sharp(written!.bytes).metadata()).width! <= 320, "a 320px-wide thumbnail");

  const [owned] = await getDb().select({ role: attachmentObjectArtifacts.role, availability: attachmentStorageArtifacts.availabilityState, key: attachmentStorageArtifacts.storageKey })
    .from(attachmentObjectArtifacts)
    .innerJoin(attachmentStorageArtifacts, eq(attachmentStorageArtifacts.id, attachmentObjectArtifacts.artifactId))
    .where(and(eq(attachmentObjectArtifacts.objectId, object!.id), eq(attachmentObjectArtifacts.role, "thumbnail")));
  assert.equal(owned?.key, object?.thumbnailKey, "deleting the attachment deletes the thumbnail");
  assert.equal(owned?.availability, "verified");

  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "idle");
});

test("a file that is not an image is skipped at completion and never read", async () => {
  const { storage, kicks, upload, session, clock } = await fixture();
  const { uploadId } = await upload("text/plain", Buffer.from("hello"), "notes.txt");
  assert.equal((await session(uploadId)).thumbnailState, "skipped");
  assert.equal(kicks.length, 0);
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock }), "idle");
  assert.equal(storage.gets.length, 0);
});

test("an image already sent in a message is re-broadcast once its thumbnail exists", async () => {
  const { storage, upload, channel, context, clock } = await fixture();
  const { attachmentId } = await upload("image/png", await png());
  const [message] = await getDb().insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: context.userId,
    content: "look",
  }).returning();
  await getDb().transaction((tx) => linkAttachmentsToMessageWithExecutor(tx, [attachmentId], message.id, context.userId, "new", clock()));

  const notified: string[][] = [];
  assert.equal(await processNextDirectUploadThumbnail({
    storage,
    cdnStorage: new CdnStorage(),
    now: clock,
    notifyMessagesUpdated: async (ids) => { notified.push([...ids]); },
  }), "done");
  assert.deepEqual(notified, [[message.id]]);
});

test("an image over the pixel cap is skipped from its header, before any decoding", async () => {
  const { storage, upload, session, clock } = await fixture();
  const cdn = new CdnStorage();
  const { uploadId } = await upload("image/png", pngHeaderOnly(20_000, 20_000));
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "skipped");
  assert.equal((await session(uploadId)).thumbnailState, "skipped");
  assert.equal(cdn.puts.size, 0);
});

test("an original over the byte cap is skipped without being read", async () => {
  const { storage, upload, session, clock } = await fixture();
  const { uploadId } = await upload("image/png", await png(), "big.png");
  // Plans allow larger single files than the thumbnail reads; the verified
  // size is what the worker checks.
  await getDb().update(attachmentUploadSessions)
    .set({ verifiedSizeBytes: DIRECT_UPLOAD_THUMBNAIL_MAX_SOURCE_BYTES + 1 })
    .where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock }), "skipped");
  assert.equal((await session(uploadId)).thumbnailState, "skipped");
  assert.equal(storage.gets.length, 0);
});

test("a failing read is retried after a delay and given up after the last attempt", async () => {
  const { storage, upload, session, clock, advance } = await fixture();
  const cdn = new CdnStorage();
  const { uploadId } = await upload("image/png", await png());
  storage.failGets = DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS;

  for (let attempt = 1; attempt < DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "retry");
    assert.equal((await session(uploadId)).thumbnailAttempts, attempt);
    assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "idle", "waits out the retry delay");
    advance(61_000);
  }
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "failed");
  const final = await session(uploadId);
  assert.equal(final.thumbnailState, "failed");
  assert.equal(cdn.puts.size, 0);
});

test("without CDN storage nothing is generated, as for multipart uploads", async () => {
  const { storage, upload, session, clock } = await fixture();
  const { uploadId } = await upload("image/png", await png());
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: null, now: clock }), "skipped");
  assert.equal((await session(uploadId)).thumbnailState, "skipped");
});

test("an SVG gets its thumbnail and the lightbox raster, both owned by its object", async () => {
  const { storage, upload, clock } = await fixture();
  const cdn = new CdnStorage();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#f80"/></svg>');
  const { attachmentId } = await upload("image/svg+xml", svg, "diagram.svg");
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: cdn, now: clock }), "done");
  const [projection] = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  const roles = await getDb().select({ role: attachmentObjectArtifacts.role, key: attachmentStorageArtifacts.storageKey })
    .from(attachmentObjectArtifacts)
    .innerJoin(attachmentStorageArtifacts, eq(attachmentStorageArtifacts.id, attachmentObjectArtifacts.artifactId))
    .where(eq(attachmentObjectArtifacts.objectId, projection!.objectId!));
  const byRole = new Map(roles.map((row) => [row.role, row.key]));
  assert.ok(cdn.puts.has(byRole.get("thumbnail")!));
  assert.ok(cdn.puts.has(byRole.get("svg_raster_preview")!));
});

// Review findings on the first version (task #57): each one pinned.

test("a connection reset mid-read is a retry, not an unhandled error", async () => {
  const { storage, upload, session, clock } = await fixture();
  const { uploadId } = await upload("image/png", await png());
  storage.nextBody = () => {
    const body = new PassThrough();
    body.write(Buffer.alloc(1024));
    setImmediate(() => body.destroy(new Error("socket reset")));
    return body;
  };
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock }), "retry");
  assert.equal((await session(uploadId)).thumbnailState, "pending");
});

test("a stalled read is abandoned after the read timeout and retried", async () => {
  const { storage, upload, clock } = await fixture();
  await upload("image/png", await png());
  storage.nextBody = () => new PassThrough();
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock, readTimeoutMs: 20 }), "retry");
});

test("a row whose last attempt died with its worker is failed at the next claim, not processed again", async () => {
  const { storage, upload, session, clock, advance } = await fixture();
  const { uploadId } = await upload("image/png", await png());
  // Each claim's worker dies before writing anything; the lease expires.
  for (let attempt = 0; attempt < DIRECT_UPLOAD_THUMBNAIL_MAX_ATTEMPTS; attempt += 1) {
    assert.ok(await claimNextDirectUploadThumbnailForTests(clock()));
    advance(6 * 60 * 1000);
  }
  assert.equal(await processNextDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock }), "idle");
  assert.equal((await session(uploadId)).thumbnailState, "failed");
  assert.equal(storage.gets.length, 0);
});

test("an attachment deleted while its thumbnail was generated gets no thumbnail and leaves no CDN file", async () => {
  const { storage, upload, session, clock } = await fixture();
  const cdn = new CdnStorage();
  const { uploadId, attachmentId } = await upload("image/png", await png());
  const [projection] = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  const outcome = await processNextDirectUploadThumbnail({
    storage,
    cdnStorage: cdn,
    now: clock,
    afterWrite: async () => {
      await getDb().update(attachmentObjects).set({ lifecycleState: "gc_pending", gcStartedAt: clock(), gcToken: randomUUID() }).where(eq(attachmentObjects.id, projection!.objectId!));
    },
  });
  assert.equal(outcome, "skipped");
  assert.equal(cdn.puts.size, 0, "the written thumbnail is deleted again");
  assert.equal(cdn.deletes.length, 1);
  const [object] = await getDb().select().from(attachmentObjects).where(eq(attachmentObjects.id, projection!.objectId!));
  assert.equal(object?.thumbnailKey, null);
  assert.equal((await session(uploadId)).thumbnailState, "skipped");
});

test("a worker whose lease was taken over cannot write the outcome", async () => {
  const { storage, upload, session, clock } = await fixture();
  const { uploadId, attachmentId } = await upload("image/png", await png());
  const stale = await claimNextDirectUploadThumbnailForTests(clock());
  assert.ok(stale);
  // Another worker reclaimed the row after the stale one's lease ran out.
  await getDb().update(attachmentUploadSessions)
    .set({ thumbnailLeaseExpiresAt: new Date(clock().getTime() + 10 * 60 * 1000) })
    .where(eq(attachmentUploadSessions.id, uploadId));
  assert.equal(await processDirectUploadThumbnail({ storage, cdnStorage: new CdnStorage(), now: clock }, stale), "lost_lease");
  assert.equal((await session(uploadId)).thumbnailState, "pending");
  const [projection] = await getDb().select().from(attachments).where(eq(attachments.id, attachmentId));
  const [object] = await getDb().select().from(attachmentObjects).where(eq(attachmentObjects.id, projection!.objectId));
  assert.equal(object?.thumbnailKey, null);
});
