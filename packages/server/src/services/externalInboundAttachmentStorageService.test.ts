import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  attachmentObjects,
  attachmentTransferIntents,
  attachments,
  channels,
  externalActorProjections,
  servers,
  users,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import {
  externalInboundAttachmentIntentState,
  storeExternalInboundAttachment,
} from "./externalInboundAttachmentStorageService.js";

const NOW = new Date("2026-09-05T01:00:00.000Z");

beforeEach(async () => {
  await initDatabase("pglite://");
});

afterEach(async () => {
  await closeDatabase();
});

async function fixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `external-stream-${randomUUID()}@raft.test`,
    name: `external-stream-${randomUUID().slice(0, 8)}`,
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External stream",
    slug: `external-stream-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-stream-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "fixture-im",
    appRegistrationId: randomUUID(),
    installId: randomUUID(),
    workspaceId: `workspace-${randomUUID()}`,
    externalActorId: `actor-${randomUUID()}`,
    displayName: "Fixture sender",
    handles: [],
    actorKind: "human",
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  return { db, server, channel, actor };
}

function memoryStorage(writes: Map<string, Buffer>): StorageBackend {
  return {
    async put(key, data) {
      writes.set(key, Buffer.from(data));
    },
    async putStream(key, data, _contentType, contentLength) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      assert.equal(body.length, contentLength);
      writes.set(key, body);
    },
    async get(key) {
      const value = writes.get(key);
      if (!value) throw new Error("missing");
      return Readable.from(value);
    },
    async delete(key) {
      writes.delete(key);
    },
  };
}

test("provider bytes stream into one pending externally-attributed canonical projection", async () => {
  const state = await fixture();
  const writes = new Map<string, Buffer>();
  const body = Buffer.from("provider-neutral-stream", "utf8");
  const assetId = randomUUID();
  const messageFactId = randomUUID();
  async function* bytes() {
    yield body.subarray(0, 8);
    yield body.subarray(8);
  }
  const first = await storeExternalInboundAttachment({
    assetId,
    messageFactId,
    serverId: state.server.id,
    channelId: state.channel.id,
    uploaderId: state.actor.id,
    uploaderType: "external_projection",
    filename: "provider.txt",
    mimeType: "text/plain",
    declaredSizeBytes: body.length,
    maximumSizeBytes: 1024,
    bytes: bytes(),
    storage: memoryStorage(writes),
    db: state.db,
    now: NOW,
  });
  assert.equal(first.messageId, null);
  assert.equal(first.pendingChannelId, state.channel.id);
  assert.equal(first.uploaderId, state.actor.id);
  assert.equal(first.uploaderType, "external_projection");
  const [object] = await state.db.select().from(attachmentObjects)
    .where(eq(attachmentObjects.id, first.objectId!));
  assert.equal(object.contentHash, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(writes.get(object.storageKey), body);
  assert.equal(await externalInboundAttachmentIntentState(state.db, messageFactId), "completed");

  async function* mustNotReadAgain(): AsyncIterable<Uint8Array> {
    throw new Error("idempotent replay consumed provider bytes");
  }
  const replay = await storeExternalInboundAttachment({
    assetId,
    messageFactId,
    serverId: state.server.id,
    channelId: state.channel.id,
    uploaderId: state.actor.id,
    uploaderType: "external_projection",
    filename: "provider.txt",
    mimeType: "text/plain",
    declaredSizeBytes: body.length,
    maximumSizeBytes: 1024,
    bytes: mustNotReadAgain(),
    storage: memoryStorage(writes),
    db: state.db,
    now: NOW,
  });
  assert.equal(replay.id, first.id);
  assert.equal((await state.db.select().from(attachments)).length, 1);
  assert.equal((await state.db.select().from(attachmentObjects)).length, 1);
});

test("a stream that exceeds provider metadata publishes no attachment projection", async () => {
  const state = await fixture();
  const writes = new Map<string, Buffer>();
  const assetId = randomUUID();
  async function* bytes() {
    yield Buffer.from("too-long", "utf8");
  }
  await assert.rejects(storeExternalInboundAttachment({
    assetId,
    messageFactId: randomUUID(),
    serverId: state.server.id,
    channelId: state.channel.id,
    uploaderId: state.actor.id,
    uploaderType: "external_projection",
    filename: "short.txt",
    mimeType: "text/plain",
    declaredSizeBytes: 3,
    maximumSizeBytes: 10,
    bytes: bytes(),
    storage: memoryStorage(writes),
    db: state.db,
    now: NOW,
  }), /exceeded its declared bound/);
  assert.equal((await state.db.select().from(attachments)).length, 0);
  assert.equal((await state.db.select().from(attachmentObjects)).length, 0);
  const [intent] = await state.db.select().from(attachmentTransferIntents);
  assert.equal(intent.state, "planned");
  assert.equal(writes.size, 0);
});

test("declared file type must match bounded content bytes before publication", async () => {
  const state = await fixture();
  const writes = new Map<string, Buffer>();
  const body = Buffer.from("not a pdf", "utf8");
  async function* bytes() { yield body; }
  await assert.rejects(storeExternalInboundAttachment({
    assetId: randomUUID(),
    messageFactId: randomUUID(),
    serverId: state.server.id,
    channelId: state.channel.id,
    uploaderId: state.actor.id,
    uploaderType: "external_projection",
    filename: "spoofed.pdf",
    mimeType: "application/pdf",
    declaredSizeBytes: body.length,
    maximumSizeBytes: 1024,
    bytes: bytes(),
    storage: memoryStorage(writes),
    db: state.db,
    now: NOW,
  }), /did not match the declared MIME type/);
  assert.equal((await state.db.select().from(attachments)).length, 0);
  assert.equal((await state.db.select().from(attachmentObjects)).length, 0);
  assert.equal(writes.size, 0);
});

test("authority loss after storage PUT leaves only a planned cleanup obligation", async () => {
  const state = await fixture();
  const writes = new Map<string, Buffer>();
  const body = Buffer.from("stored before fence", "utf8");
  const assetId = randomUUID();
  const messageFactId = randomUUID();
  async function* bytes() { yield body; }
  await assert.rejects(storeExternalInboundAttachment({
    assetId,
    messageFactId,
    serverId: state.server.id,
    channelId: state.channel.id,
    uploaderId: state.actor.id,
    uploaderType: "external_projection",
    filename: "fenced.txt",
    mimeType: "text/plain",
    declaredSizeBytes: body.length,
    maximumSizeBytes: 1024,
    bytes: bytes(),
    storage: memoryStorage(writes),
    db: state.db,
    beforePublish: async () => { throw new Error("authority revoked"); },
    now: NOW,
  }), /authority revoked/);
  assert.equal((await state.db.select().from(attachments)).length, 0);
  assert.equal((await state.db.select().from(attachmentObjects)).length, 0);
  assert.equal(await externalInboundAttachmentIntentState(state.db, messageFactId), "planned");
  assert.equal(writes.size, 1, "the pre-recorded intent owns cleanup of the possibly-created object");
});
