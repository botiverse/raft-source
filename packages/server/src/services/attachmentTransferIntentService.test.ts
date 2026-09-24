import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  attachmentObjectArtifacts,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachmentTransferArtifacts,
  attachmentTransferIntents,
} from "../db/schema.js";
import type { StorageBackend } from "./storageService.js";
import {
  adoptAttachmentTransferIntentWithExecutor,
  buildAttachmentTransferArtifactPlan,
  cleanupAttachmentTransferArtifacts,
  createAttachmentTransferIntent,
  terminalizeAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "22222222-2222-4222-8222-222222222222";
const UPLOADER_ID = "33333333-3333-4333-8333-333333333333";

class FakeStorage implements StorageBackend {
  readonly deletes: string[] = [];
  failDeletes = 0;

  async put(): Promise<void> {}
  async get(): Promise<Readable> { return Readable.from([]); }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      throw new Error("injected delete failure");
    }
  }
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  return { client, db };
}

function intentInput(overrides: Partial<Parameters<typeof createAttachmentTransferIntent>[0]> = {}) {
  const id = overrides.id ?? randomUUID();
  const storageKey = `attachments/${id}`;
  const thumbnailKey = `thumbs/${id}.webp`;
  return {
    id,
    reservationId: randomUUID(),
    objectId: randomUUID(),
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: UPLOADER_ID,
    uploaderType: "user" as const,
    filename: "vector.svg",
    mimeType: "image/svg+xml",
    declaredSizeBytes: 42,
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, thumbnailKey, mimeType: "image/svg+xml" }),
    ...overrides,
  };
}

test("an expired pre-PUT plan deletes every possible key without a byte-created acknowledgement", async () => {
  const { client, db } = await fixture();
  try {
    const input = intentInput();
    await createAttachmentTransferIntent(input, db, NOW);
    const attachmentStorage = new FakeStorage();
    const cdnStorage = new FakeStorage();

    assert.deepEqual(await cleanupAttachmentTransferArtifacts({
      db,
      now: new Date(input.expiresAt.getTime() - 1),
      storage: attachmentStorage,
      cdnStorage,
    }), { deleted: 0, failed: 0 });

    assert.deepEqual(await cleanupAttachmentTransferArtifacts({
      db,
      now: input.expiresAt,
      storage: attachmentStorage,
      cdnStorage,
    }), { deleted: 3, failed: 0 });
    assert.deepEqual(attachmentStorage.deletes, [input.artifacts[0]!.storageKey]);
    assert.deepEqual(new Set(cdnStorage.deletes), new Set(input.artifacts.slice(1).map((row) => row.storageKey)));

    const [intent] = await db.select().from(attachmentTransferIntents)
      .where(eq(attachmentTransferIntents.id, input.id));
    const artifacts = await db.select().from(attachmentTransferArtifacts)
      .where(eq(attachmentTransferArtifacts.intentId, input.id));
    assert.equal(intent?.state, "expired");
    assert.deepEqual(new Set(artifacts.map((row) => row.state)), new Set(["deleted"]));
  } finally {
    await client.close();
  }
});

test("publication adopts only written artifacts and cleanup cannot delete the adopted original", async () => {
  const { client, db } = await fixture();
  try {
    const input = intentInput();
    await createAttachmentTransferIntent(input, db, NOW);
    await db.transaction(async (tx) => {
      await tx.insert(attachmentObjects).values({
        id: input.objectId,
        originServerId: input.serverId,
        uploaderId: input.uploaderId,
        uploaderType: input.uploaderType,
        storageKey: input.artifacts[0]!.storageKey,
        mimeType: input.mimeType,
        sizeBytes: input.declaredSizeBytes,
        createdAt: NOW,
      });
      await adoptAttachmentTransferIntentWithExecutor(tx, {
        id: input.id,
        reservationId: input.reservationId,
        objectId: input.objectId,
        serverId: input.serverId,
        channelId: input.channelId,
        uploaderId: input.uploaderId,
        uploaderType: input.uploaderType,
        filename: input.filename,
        mimeType: input.mimeType,
        declaredSizeBytes: input.declaredSizeBytes,
        storageKey: input.artifacts[0]!.storageKey,
        thumbnailKey: null,
      }, NOW);
    });

    const attachmentStorage = new FakeStorage();
    const cdnStorage = new FakeStorage();
    assert.deepEqual(await cleanupAttachmentTransferArtifacts({
      db,
      now: NOW,
      storage: attachmentStorage,
      cdnStorage,
    }), { deleted: 2, failed: 0 });
    assert.deepEqual(attachmentStorage.deletes, []);
    assert.deepEqual(new Set(cdnStorage.deletes), new Set(input.artifacts.slice(1).map((row) => row.storageKey)));

    const artifacts = await db.select().from(attachmentTransferArtifacts)
      .where(eq(attachmentTransferArtifacts.intentId, input.id))
      .orderBy(asc(attachmentTransferArtifacts.role));
    assert.equal(artifacts.find((row) => row.role === "original")?.state, "adopted");
    assert.equal(artifacts.find((row) => row.role === "thumbnail")?.state, "deleted");
    assert.equal(artifacts.find((row) => row.role === "svg_raster_preview")?.state, "deleted");
    assert.equal((await db.select().from(attachmentStorageArtifacts)).length, 1);
    assert.equal((await db.select().from(attachmentObjectArtifacts)).length, 1);
  } finally {
    await client.close();
  }
});

test("a failed delete is durably delayed and a later sweep retries exactly once", async () => {
  const { client, db } = await fixture();
  try {
    const input = intentInput({
      mimeType: "text/plain",
      filename: "plain.txt",
      artifacts: [{ role: "original", backend: "attachment", storageKey: `attachments/${randomUUID()}` }],
    });
    await createAttachmentTransferIntent(input, db, NOW);
    await terminalizeAttachmentTransferIntent(input.id, "failed", "publish failed", db, NOW);
    const storage = new FakeStorage();
    storage.failDeletes = 1;

    assert.deepEqual(await cleanupAttachmentTransferArtifacts({ db, now: NOW, storage, cdnStorage: null }), {
      deleted: 0,
      failed: 1,
    });
    let [artifact] = await db.select().from(attachmentTransferArtifacts)
      .where(eq(attachmentTransferArtifacts.intentId, input.id));
    assert.equal(artifact?.state, "deleting");
    assert.equal(artifact?.deleteAttempts, 1);

    assert.deepEqual(await cleanupAttachmentTransferArtifacts({
      db,
      now: new Date(NOW.getTime() + 29_999),
      storage,
      cdnStorage: null,
    }), { deleted: 0, failed: 0 });
    assert.equal(storage.deletes.length, 1);

    assert.deepEqual(await cleanupAttachmentTransferArtifacts({
      db,
      now: new Date(NOW.getTime() + 30_000),
      storage,
      cdnStorage: null,
    }), { deleted: 1, failed: 0 });
    [artifact] = await db.select().from(attachmentTransferArtifacts)
      .where(and(
        eq(attachmentTransferArtifacts.intentId, input.id),
        eq(attachmentTransferArtifacts.role, "original"),
      ));
    assert.equal(artifact?.state, "deleted");
    assert.equal(artifact?.deleteAttempts, 2);
    assert.equal(storage.deletes.length, 2);
  } finally {
    await client.close();
  }
});

test("expiry cleanup and publication share a database fence", async () => {
  const { client, db } = await fixture();
  try {
    const input = intentInput();
    await createAttachmentTransferIntent(input, db, NOW);
    const storage = new FakeStorage();
    const cdnStorage = new FakeStorage();
    await cleanupAttachmentTransferArtifacts({
      db,
      now: input.expiresAt,
      storage,
      cdnStorage,
    });

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.insert(attachmentObjects).values({
          id: input.objectId,
          originServerId: input.serverId,
          uploaderId: input.uploaderId,
          uploaderType: input.uploaderType,
          storageKey: input.artifacts[0]!.storageKey,
          mimeType: input.mimeType,
          sizeBytes: input.declaredSizeBytes,
          createdAt: input.expiresAt,
        });
        await adoptAttachmentTransferIntentWithExecutor(tx, {
          id: input.id,
          reservationId: input.reservationId,
          objectId: input.objectId,
          serverId: input.serverId,
          channelId: input.channelId,
          uploaderId: input.uploaderId,
          uploaderType: input.uploaderType,
          filename: input.filename,
          mimeType: input.mimeType,
          declaredSizeBytes: input.declaredSizeBytes,
          storageKey: input.artifacts[0]!.storageKey,
          thumbnailKey: input.artifacts[1]!.storageKey,
        }, input.expiresAt);
      }),
      /no longer publishable/,
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
  } finally {
    await client.close();
  }
});

test("an idempotent retry reuses the original expiry instead of renewing transfer ownership", async () => {
  const { client, db } = await fixture();
  try {
    const input = intentInput();
    const created = await createAttachmentTransferIntent(input, db, NOW);
    const replay = await createAttachmentTransferIntent({
      ...input,
      expiresAt: new Date(input.expiresAt.getTime() + 60 * 60 * 1000),
    }, db, new Date(NOW.getTime() + 1));
    assert.equal(replay.id, created.id);
    assert.equal(replay.expiresAt.getTime(), input.expiresAt.getTime());

    await assert.rejects(
      createAttachmentTransferIntent({
        ...input,
        expiresAt: new Date(input.expiresAt.getTime() + 60 * 60 * 1000),
      }, db, input.expiresAt),
      /no longer publishable/,
    );
  } finally {
    await client.close();
  }
});
