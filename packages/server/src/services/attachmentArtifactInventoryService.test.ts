import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  attachmentArtifactInventoryObservations,
  attachmentArtifactInventoryRuns,
  attachmentObjectArtifacts,
  attachmentObjectCharges,
  attachmentObjectInventoryClassifications,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachments,
  attachmentUploadReservations,
  channels,
  messages,
  servers,
  users,
} from "../db/schema.js";
import {
  inspectAttachmentArtifactInventory,
  inventoryAttachmentArtifacts,
} from "./attachmentArtifactInventoryService.js";
import type { StorageBackend } from "./storageService.js";

class InventoryStorage implements Pick<StorageBackend, "head"> {
  readonly heads: string[] = [];

  constructor(readonly results: Map<string, number | null | Error>) {}

  async head(key: string) {
    this.heads.push(key);
    const result = this.results.get(key);
    if (result instanceof Error) throw result;
    return typeof result === "number"
      ? { sizeBytes: result, contentType: null, etag: null }
      : null;
  }
}

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  const userId = randomUUID();
  const serverId = randomUUID();
  const channelId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.invalid`,
    name: userId,
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: serverId,
    name: "inventory",
    slug: `inventory-${serverId}`,
    ownerId: userId,
  });
  await db.insert(channels).values({ id: channelId, serverId, name: "inventory" });
  const [message] = await db.insert(messages).values({
    channelId,
    senderType: "user",
    senderId: userId,
    content: "host",
  }).returning();
  return { client, db, userId, serverId, channelId, messageId: message.id };
}

async function insertObject(input: {
  db: Database;
  serverId: string;
  userId: string;
  storageKey: string;
  thumbnailKey?: string | null;
  mimeType?: string;
  sizeBytes?: number;
}) {
  const [object] = await input.db.insert(attachmentObjects).values({
    id: randomUUID(),
    originServerId: input.serverId,
    uploaderId: input.userId,
    uploaderType: "user",
    storageKey: input.storageKey,
    thumbnailKey: input.thumbnailKey,
    mimeType: input.mimeType ?? "application/octet-stream",
    sizeBytes: input.sizeBytes ?? 10,
  }).returning();
  assert.ok(object);
  return object;
}

async function insertProjection(input: {
  db: Database;
  channelId: string;
  userId: string;
  object: typeof attachmentObjects.$inferSelect;
  messageId?: string | null;
  revokedAt?: Date | null;
}) {
  const [projection] = await input.db.insert(attachments).values({
    id: randomUUID(),
    objectId: input.object.id,
    messageId: input.messageId,
    pendingChannelId: input.messageId ? null : input.channelId,
    channelId: input.channelId,
    uploaderId: input.userId,
    uploaderType: "user",
    filename: input.object.storageKey,
    mimeType: input.object.mimeType,
    sizeBytes: input.object.sizeBytes,
    storageKey: input.object.storageKey,
    thumbnailKey: input.object.thumbnailKey,
    contentHash: input.object.contentHash,
    width: input.object.width,
    height: input.object.height,
    revokedAt: input.revokedAt,
    revokedById: input.revokedAt ? "inventory-test" : null,
    revokedByType: input.revokedAt ? "system" : null,
  }).returning();
  assert.ok(projection);
  return projection;
}

async function insertObjectlessProjection(input: {
  db: Database;
  channelId: string;
  userId: string;
  storageKey: string;
}) {
  const [projection] = await input.db.insert(attachments).values({
    id: randomUUID(),
    objectId: null,
    messageId: null,
    pendingChannelId: input.channelId,
    channelId: input.channelId,
    uploaderId: input.userId,
    uploaderType: "user",
    filename: input.storageKey,
    mimeType: "application/octet-stream",
    sizeBytes: 10,
    storageKey: input.storageKey,
  }).returning();
  assert.ok(projection);
  return projection;
}

test("inventory collapses shared keys, records every owner and fails closed on missing/unverified bytes", async () => {
  const f = await fixture();
  try {
    const sharedKey = `${f.serverId}/shared.svg`;
    const thumbnailKey = `thumbs/${f.serverId}/shared.png`;
    const live = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: sharedKey,
      thumbnailKey,
      mimeType: "image/svg+xml",
      sizeBytes: 20,
    });
    const pending = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: sharedKey,
      thumbnailKey,
      mimeType: "image/svg+xml",
      sizeBytes: 20,
    });
    const unknown = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: `${f.serverId}/unknown.bin`,
      sizeBytes: 30,
    });
    await insertProjection({ ...f, object: live, messageId: f.messageId });
    await insertProjection({ ...f, object: pending, messageId: null });

    const attachmentStorage = new InventoryStorage(new Map<string, number | null | Error>([
      [sharedKey, 20],
      [unknown.storageKey, new Error("simulated access failure")],
    ]));
    const cdnStorage = new InventoryStorage(new Map<string, number | null | Error>([
      [thumbnailKey, null],
      [`previews/${f.serverId}/shared.png`, 11],
    ]));
    const observedAt = new Date("2026-08-12T09:00:00.000Z");
    const report = await inventoryAttachmentArtifacts(f.db, {
      runId: randomUUID(),
      evidenceSource: "test-inventory",
      sourceRevision: "test-head",
      scopeServerId: f.serverId,
      observedAt,
      attachmentStorage,
      cdnStorage,
    });

    assert.equal(report.objectCount, 3);
    assert.equal(report.artifactCount, 4, "shared original/thumbnail/raster identities collapse across owners");
    assert.deepEqual(report.observations, { exists: 2, missing: 1, unverified: 1 });
    assert.deepEqual(report.bytesEvidence, {
      bytes_verified: 0,
      bytes_missing: 2,
      bytes_unverified: 1,
    });
    assert.deepEqual(report.semantics, {
      live: 1,
      pending_migratable: 1,
      terminal_proven: 0,
      shared_artifact_blocked: 0,
      legacy_unknown: 1,
    });
    assert.equal(report.coverageEligible, false);
    assert.equal(report.fullMigrationEligible, false);
    assert.deepEqual(attachmentStorage.heads.sort(), [sharedKey, unknown.storageKey].sort());
    assert.deepEqual(cdnStorage.heads.sort(), [thumbnailKey, `previews/${f.serverId}/shared.png`].sort());

    const artifacts = await f.db.select().from(attachmentStorageArtifacts);
    assert.equal(artifacts.length, 4);
    assert.equal((await f.db.select().from(attachmentObjectArtifacts)).length, 7);
    assert.equal(
      (await f.db.select().from(attachmentObjectArtifacts))
        .filter((row) => row.artifactId === artifacts.find((row) => row.storageKey === sharedKey)?.id).length,
      2,
      "one physical key retains both immutable object owners",
    );
    assert.equal((await f.db.select().from(attachmentArtifactInventoryRuns)).length, 1);
    assert.equal((await f.db.select().from(attachmentArtifactInventoryObservations)).length, 4);
    assert.equal((await f.db.select().from(attachmentObjectInventoryClassifications)).length, 3);
    assert.equal((await f.db.select().from(attachmentObjectCharges)).length, 0);
  } finally {
    await f.client.close();
  }
});

test("read-only inspection persists nothing and upload receipt without a message stays pending, not live", async () => {
  const f = await fixture();
  try {
    const object = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: `${f.serverId}/receipt-only.bin`,
    });
    const projection = await insertProjection({ ...f, object, messageId: null });
    await f.db.insert(attachmentUploadReservations).values({
      id: projection.id,
      objectId: object.id,
      originServerId: f.serverId,
      channelId: f.channelId,
      creatorId: f.userId,
      creatorType: "user",
      filename: projection.filename,
      expiresAt: new Date("2026-08-12T11:00:00.000Z"),
    });
    const storage = new InventoryStorage(new Map([[object.storageKey, object.sizeBytes]]));

    const report = await inspectAttachmentArtifactInventory(f.db, {
      runId: randomUUID(),
      evidenceSource: "receipt-visibility-test",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T10:00:00.000Z"),
      attachmentStorage: storage,
      cdnStorage: null,
    });
    assert.equal(report.semantics.pending_migratable, 1);
    assert.equal(report.semantics.live, 0, "storage existence/upload receipt does not make a pre-message object reader-live");
    assert.equal(report.coverageEligible, true);
    assert.equal(report.fullMigrationEligible, true);
    assert.equal((await f.db.select().from(attachmentStorageArtifacts)).length, 0);
    assert.equal((await f.db.select().from(attachmentObjectArtifacts)).length, 0);
    assert.equal((await f.db.select().from(attachmentArtifactInventoryRuns)).length, 0);
  } finally {
    await f.client.close();
  }
});

test("verified objectless history satisfies byte coverage but not migration completion", async () => {
  const f = await fixture();
  try {
    const storageKey = `${f.serverId}/legacy-objectless.bin`;
    await insertObjectlessProjection({ ...f, storageKey });

    const report = await inspectAttachmentArtifactInventory(f.db, {
      evidenceSource: "legacy-objectless-coverage-test",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T10:00:00.000Z"),
      attachmentStorage: new InventoryStorage(new Map([[storageKey, 10]])),
      cdnStorage: null,
    });

    assert.equal(report.legacyObjectlessProjectionCount, 1);
    assert.deepEqual(report.observations, { exists: 1, missing: 0, unverified: 0 });
    assert.equal(report.coverageEligible, true, "inventory coverage includes pre-backfill objectless history");
    assert.equal(report.fullMigrationEligible, false, "objectless backlog remains a completion blocker");
  } finally {
    await f.client.close();
  }
});

test("server-state drift during HEAD invalidates the receipt before any inventory write", async () => {
  const f = await fixture();
  try {
    const object = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: `${f.serverId}/server-state-race.bin`,
    });
    await insertProjection({ ...f, object, messageId: f.messageId });
    let changed = false;
    const attachmentStorage: Pick<StorageBackend, "head"> = {
      head: async () => {
        if (!changed) {
          changed = true;
          await f.db.update(servers).set({ deletedAt: new Date("2026-08-12T10:00:00.000Z") })
            .where(eq(servers.id, f.serverId));
        }
        return { sizeBytes: object.sizeBytes, contentType: null, etag: null };
      },
    };

    await assert.rejects(
      inventoryAttachmentArtifacts(f.db, {
        runId: randomUUID(),
        evidenceSource: "server-state-race-test",
        sourceRevision: "test-head",
        observedAt: new Date("2026-08-12T10:00:00.000Z"),
        attachmentStorage,
        cdnStorage: null,
      }),
      /candidate set changed during external observation/,
    );
    assert.equal((await f.db.select().from(attachmentArtifactInventoryRuns)).length, 0);
    assert.equal((await f.db.select().from(attachmentStorageArtifacts)).length, 0);
    assert.equal((await f.db.select().from(attachmentObjectArtifacts)).length, 0);
  } finally {
    await f.client.close();
  }
});

test("a stale inventory cannot overwrite newer availability evidence", async () => {
  const f = await fixture();
  try {
    const object = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: `${f.serverId}/ordered.bin`,
    });
    await insertProjection({ ...f, object, messageId: f.messageId });

    const newer = await inventoryAttachmentArtifacts(f.db, {
      runId: randomUUID(),
      evidenceSource: "newer",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T10:00:00.000Z"),
      attachmentStorage: new InventoryStorage(new Map([[object.storageKey, object.sizeBytes]])),
      cdnStorage: null,
    });
    assert.equal(newer.coverageEligible, true);

    const older = await inventoryAttachmentArtifacts(f.db, {
      runId: randomUUID(),
      evidenceSource: "older",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T09:00:00.000Z"),
      attachmentStorage: new InventoryStorage(new Map([[object.storageKey, null]])),
      cdnStorage: null,
    });
    assert.equal(older.coverageEligible, false, "each run honestly reports its own missing result");

    const [artifact] = await f.db.select().from(attachmentStorageArtifacts);
    assert.equal(artifact?.availabilityState, "verified", "older evidence cannot regress the current materialized state");
    assert.equal(artifact?.availabilityObservedAt?.toISOString(), "2026-08-12T10:00:00.000Z");
    assert.equal((await f.db.select().from(attachmentArtifactInventoryObservations)).length, 2);
  } finally {
    await f.client.close();
  }
});

test("an inventory run id is immutable and rejects replay", async () => {
  const f = await fixture();
  try {
    const object = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey: `${f.serverId}/replay.bin`,
    });
    await insertProjection({ ...f, object, messageId: f.messageId });
    const runId = randomUUID();
    const input = {
      runId,
      evidenceSource: "replay-test",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T10:00:00.000Z"),
      attachmentStorage: new InventoryStorage(new Map([[object.storageKey, object.sizeBytes]])),
      cdnStorage: null,
    };
    await inventoryAttachmentArtifacts(f.db, input);
    await assert.rejects(
      inventoryAttachmentArtifacts(f.db, input),
      new RegExp(`inventory run ${runId} already exists`),
    );
    assert.equal((await f.db.select().from(attachmentArtifactInventoryRuns)).length, 1);
  } finally {
    await f.client.close();
  }
});

test("shared bytes migrate all owners but keep terminal physical deletion blocked", async () => {
  const f = await fixture();
  try {
    const storageKey = `${f.serverId}/terminal-shared.bin`;
    const live = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey,
    });
    const terminal = await insertObject({
      db: f.db,
      serverId: f.serverId,
      userId: f.userId,
      storageKey,
    });
    await insertProjection({ ...f, object: live, messageId: f.messageId });
    await insertProjection({ ...f, object: terminal, messageId: null, revokedAt: new Date("2026-08-12T08:00:00Z") });

    const report = await inspectAttachmentArtifactInventory(f.db, {
      evidenceSource: "shared-terminal-test",
      sourceRevision: "test-head",
      observedAt: new Date("2026-08-12T10:00:00Z"),
      attachmentStorage: new InventoryStorage(new Map([[storageKey, 10]])),
      cdnStorage: null,
    });
    assert.equal(report.semantics.live, 1);
    assert.equal(report.semantics.shared_artifact_blocked, 1);
    assert.equal(report.semantics.terminal_proven, 0, "shared bytes must block terminal action until sibling ownership clears");
    assert.equal(report.coverageEligible, true, "shared ownership is fully inventoried");
    assert.equal(report.fullMigrationEligible, true, "shared ownership blocks deletion, not ownership migration");
  } finally {
    await f.client.close();
  }
});
