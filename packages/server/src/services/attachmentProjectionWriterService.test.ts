import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  attachmentObjectCharges,
  attachmentObjectArtifacts,
  attachmentObjects,
  attachmentStorageArtifacts,
  attachmentTransferIntents,
  attachmentUploadReservations,
  attachments,
  channels,
  messages,
  servers,
  users,
} from "../db/schema.js";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";
import {
  createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor,
  createIdempotentPendingAttachmentProjectionWithExecutor,
  createPendingAttachmentProjectionWithExecutor,
  type PendingAttachmentProjectionInput,
} from "./attachmentProjectionWriterService.js";
import {
  buildAttachmentTransferArtifactPlan,
  createAttachmentTransferIntent,
} from "./attachmentTransferIntentService.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({
    id: USER_ID,
    email: "projection-writer@slock.test",
    name: "projection-writer",
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Projection writer",
    slug: "projection-writer",
    ownerId: USER_ID,
  });
  await db.insert(channels).values({
    id: CHANNEL_ID,
    serverId: SERVER_ID,
    name: "projection-writer",
  });
  await db.insert(messages).values({
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: USER_ID,
    content: "host",
  });
  return { client, db };
}

function input(id: string, storageKey = `projection-writer/${id}`): PendingAttachmentProjectionInput {
  return {
    id,
    objectId: randomUUID(),
    transferIntentId: randomUUID(),
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user" as const,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 12,
    storageKey,
  };
}

type WriterInput = ReturnType<typeof input>;

async function plan(db: Database, value: WriterInput, now = new Date("2026-07-30T12:00:00.000Z")) {
  await createAttachmentTransferIntent({
    id: value.transferIntentId,
    reservationId: value.id,
    objectId: value.objectId,
    serverId: value.serverId,
    channelId: value.channelId,
    uploaderId: value.uploaderId,
    uploaderType: value.uploaderType,
    filename: value.filename,
    mimeType: value.mimeType,
    declaredSizeBytes: value.sizeBytes,
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    artifacts: buildAttachmentTransferArtifactPlan(value),
  }, db, now);
}

test("dual writer atomically creates one object, charge, and pending projection then linking publishes it", async () => {
  const { client, db } = await fixture();
  try {
    const projectionId = "55555555-5555-4555-8555-555555555555";
    const upload = input(projectionId);
    const completedAt = new Date("2026-07-30T12:00:00.000Z");
    await plan(db, upload, completedAt);
    const created = await db.transaction((tx) =>
      createPendingAttachmentProjectionWithExecutor(
        tx,
        { ...upload, chargeMonth: "2026-06" },
        completedAt,
      )
    );
    assert.equal(created.id, projectionId);
    assert.equal(created.messageId, null);
    assert.equal(created.pendingChannelId, CHANNEL_ID);
    assert.equal(created.createdById, USER_ID);
    assert.equal(created.createdByType, "user");
    assert.ok(created.objectId);

    const [object] = await db.select().from(attachmentObjects).where(eq(attachmentObjects.id, created.objectId!));
    const [charge] = await db.select().from(attachmentObjectCharges).where(eq(attachmentObjectCharges.objectId, created.objectId!));
    assert.equal(object?.storageKey, created.storageKey);
    assert.equal(object?.lifecycleState, "active");
    assert.equal(charge?.originServerId, SERVER_ID);
    assert.equal(charge?.chargeMonth, "2026-06-01");
    assert.equal(charge?.sizeBytes, 12);

    const [linked] = await db.transaction((tx) =>
      linkAttachmentsToMessageWithExecutor(
        tx,
        [projectionId],
        MESSAGE_ID,
        USER_ID,
        "new",
        new Date("2026-07-30T12:01:00.000Z"),
      )
    );
    assert.equal(linked.messageId, MESSAGE_ID);
    assert.equal(linked.pendingChannelId, null);
    assert.equal(linked.objectId, created.objectId);
  } finally {
    await client.close();
  }
});

test("a second logical upload cannot reuse an existing physical artifact key", async () => {
  const { client, db } = await fixture();
  try {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const sharedKey = "projection-writer/shared.txt";
    const first = input("66666666-6666-4666-8666-666666666666", sharedKey);
    await plan(db, first, now);
    await db.transaction((tx) =>
      createPendingAttachmentProjectionWithExecutor(
        tx,
        first,
        now,
      )
    );
    const second = input("77777777-7777-4777-8777-777777777777", sharedKey);
    await assert.rejects(
      plan(db, second),
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23505",
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 1);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 1);
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 1);
    assert.equal((await db.select().from(attachmentStorageArtifacts)).length, 1);
    assert.equal((await db.select().from(attachmentObjectArtifacts)).length, 1);
    assert.equal((await db.select().from(attachments)).length, 1);
  } finally {
    await client.close();
  }
});

test("a failed writer transaction leaves no detached object, charge, or projection", async () => {
  const { client, db } = await fixture();
  try {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const upload = input("88888888-8888-4888-8888-888888888888");
    await plan(db, upload, now);
    await assert.rejects(
      db.transaction(async (tx) => {
        await createPendingAttachmentProjectionWithExecutor(
          tx,
          upload,
          now,
        );
        throw new Error("injected failure");
      }),
      /injected failure/,
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
    assert.equal((await db.select().from(attachments)).length, 0);
    assert.equal((await db.select().from(attachmentTransferIntents)).length, 1);
  } finally {
    await client.close();
  }
});

test("deterministic system artifact retries converge on one object, charge, and projection", async () => {
  const { client, db } = await fixture();
  try {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const deterministic = {
      ...input("99999999-9999-4999-8999-999999999999"),
      objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };
    await plan(db, deterministic, now);
    const first = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionWithExecutor(tx, deterministic, now)
    );
    const replay = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionWithExecutor(tx, deterministic)
    );
    assert.equal(replay.id, first.id);
    assert.equal(replay.objectId, first.objectId);
    assert.equal((await db.select().from(attachmentObjects)).length, 1);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 1);
    assert.equal((await db.select().from(attachments)).length, 1);
  } finally {
    await client.close();
  }
});

test("existing immutable object reuse creates occurrence-owned reservations and projections only", async () => {
  const { client, db } = await fixture();
  try {
    const now = new Date("2026-07-30T12:00:00.000Z");
    const objectId = "abababab-abab-4bab-8bab-abababababab";
    const contentHash = "a".repeat(64);
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: SERVER_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      storageKey: "projection-writer/shared-object.txt",
      contentHash,
      mimeType: "text/plain",
      sizeBytes: 12,
    });
    await db.insert(attachmentObjectCharges).values({
      objectId,
      originServerId: SERVER_ID,
      chargeMonth: "2026-07-01",
      sizeBytes: 12,
    });
    const firstInput = {
      id: "acacacac-acac-4cac-8cac-acacacacacac",
      objectId,
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      uploaderId: "external-actor-a",
      uploaderType: "external_projection" as const,
      filename: "shared-object.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      contentHash,
    };
    const secondInput = {
      ...firstInput,
      id: "adadadad-adad-4dad-8dad-adadadadadad",
      uploaderId: "external-actor-b",
    };
    const first = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(tx, firstInput, now)
    );
    const second = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(tx, secondInput, now)
    );
    const replay = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(tx, secondInput, now)
    );
    assert.equal(first.objectId, objectId);
    assert.equal(first.uploaderId, "external-actor-a");
    assert.equal(second.objectId, objectId);
    assert.equal(second.uploaderId, "external-actor-b");
    assert.equal(replay.id, second.id);
    assert.equal((await db.select().from(attachmentObjects)).length, 1);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 1);
    assert.equal((await db.select().from(attachmentUploadReservations)).length, 2);
    assert.equal((await db.select().from(attachments)).length, 2);
  } finally {
    await client.close();
  }
});

test("legacy linked deterministic artifact replay succeeds without fabricating an object or charge", async () => {
  const { client, db } = await fixture();
  try {
    const projectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const replayInput = input(projectionId);
    const { objectId: _objectId, transferIntentId: _transferIntentId, ...legacyInput } = replayInput;
    await db.insert(attachments).values({ ...legacyInput, messageId: MESSAGE_ID });
    const replay = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionWithExecutor(tx, {
        ...replayInput,
        objectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      })
    );
    assert.equal(replay.id, projectionId);
    assert.equal(replay.messageId, MESSAGE_ID);
    assert.equal(replay.objectId, null);
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
  } finally {
    await client.close();
  }
});

test("mismatched legacy deterministic artifact replay fails without detached object state", async () => {
  const { client, db } = await fixture();
  try {
    const projectionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const replayInput = input(projectionId);
    const { objectId: _objectId, transferIntentId: _transferIntentId, ...legacyInput } = replayInput;
    await db.insert(attachments).values({ ...legacyInput, filename: "different.txt", messageId: MESSAGE_ID });
    await assert.rejects(
      db.transaction((tx) => createIdempotentPendingAttachmentProjectionWithExecutor(tx, {
        ...replayInput,
        objectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      })),
      /replay conflict/,
    );
    assert.equal((await db.select().from(attachmentObjects)).length, 0);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
    const [legacy] = await db.select().from(attachments).where(eq(attachments.id, projectionId));
    assert.equal(legacy?.objectId, null);
  } finally {
    await client.close();
  }
});

test("backfilled deterministic artifact replay accepts its existing uncharged object", async () => {
  const { client, db } = await fixture();
  try {
    const projectionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const backfilledObjectId = "12121212-1212-4212-8212-121212121212";
    const replayInput = input(projectionId);
    await db.insert(attachmentObjects).values({
      id: backfilledObjectId,
      originServerId: SERVER_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      storageKey: replayInput.storageKey,
      mimeType: replayInput.mimeType,
      sizeBytes: replayInput.sizeBytes,
    });
    const { objectId: _objectId, transferIntentId: _transferIntentId, ...legacyInput } = replayInput;
    await db.insert(attachments).values({
      ...legacyInput,
      objectId: backfilledObjectId,
      messageId: MESSAGE_ID,
      createdById: USER_ID,
      createdByType: "user",
    });
    const replay = await db.transaction((tx) =>
      createIdempotentPendingAttachmentProjectionWithExecutor(tx, {
        ...replayInput,
        objectId: "13131313-1313-4313-8313-131313131313",
      })
    );
    assert.equal(replay.objectId, backfilledObjectId);
    assert.equal((await db.select().from(attachmentObjects)).length, 1);
    assert.equal((await db.select().from(attachmentObjectCharges)).length, 0);
  } finally {
    await client.close();
  }
});

test("production attachment inserts are limited to the dual upload writer and atomic forward copier", () => {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const directInsertFiles: string[] = [];
  const artifactInsertFiles: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(absolute, "utf8");
        if (/\.insert\s*\(\s*attachments\s*\)/.test(source)) {
          directInsertFiles.push(path.relative(sourceRoot, absolute));
        }
        if (/\.insert\s*\(\s*attachmentStorageArtifacts\s*\)/.test(source)) {
          artifactInsertFiles.push(path.relative(sourceRoot, absolute));
        }
      }
    }
  };
  visit(sourceRoot);
  assert.deepEqual(directInsertFiles, [
    "services/attachmentForwardService.ts",
    "services/attachmentProjectionWriterService.ts",
  ]);
  assert.deepEqual(artifactInsertFiles, [
    "services/attachmentArtifactOwnershipService.ts",
    "services/attachmentTransferIntentService.ts",
  ]);
});
