import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { test } from "vitest";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { attachmentUploadSessions, channels, servers, users } from "../db/schema";
import { createPendingAttachmentProjectionWithExecutor } from "./attachmentProjectionWriterService";
import { buildAttachmentTransferArtifactPlan, createAttachmentTransferIntent } from "./attachmentTransferIntentService";
import { assertNoActiveAttachmentTransfers, ChannelConversionUploadsInFlightError } from "./channelConversionPreparation";

// #triage:#103: an upload past its expires_at can no longer publish, so it must
// not hold a channel's conversion (49 abandoned, expired reservations did).

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const HOUR_MS = 60 * 60 * 1000;

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({ id: USER_ID, email: "conversion-uploads@slock.test", name: "conversion-uploads", passwordHash: "test" });
  await db.insert(servers).values({ id: SERVER_ID, name: "Conversion uploads", slug: "conversion-uploads", ownerId: USER_ID });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "converting" });
  return { client, db };
}

async function inFlight(db: Database): Promise<ChannelConversionUploadsInFlightError | null> {
  try {
    await db.transaction((tx) => assertNoActiveAttachmentTransfers(tx, { serverId: SERVER_ID, sourceChannelId: CHANNEL_ID }));
    return null;
  } catch (error) {
    if (error instanceof ChannelConversionUploadsInFlightError) return error;
    throw error;
  }
}

function intentInput(id: string, expiresAt: Date) {
  const storageKey = `${SERVER_ID}/${id}`;
  return {
    id: randomUUID(),
    reservationId: id,
    objectId: randomUUID(),
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user" as const,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    declaredSizeBytes: 42,
    expiresAt,
    artifacts: buildAttachmentTransferArtifactPlan({ storageKey, mimeType: "text/plain" }),
  };
}

/** A completed upload that was never sent: a pending reservation that expires an hour after `completedAt`. */
async function unsentUpload(db: Database, completedAt: Date): Promise<string> {
  const id = randomUUID();
  const intent = intentInput(id, new Date(completedAt.getTime() + 15 * 60 * 1000));
  await createAttachmentTransferIntent(intent, db, completedAt);
  await db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, {
    id,
    objectId: intent.objectId,
    transferIntentId: intent.id,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: intent.filename,
    mimeType: intent.mimeType,
    sizeBytes: intent.declaredSizeBytes,
    storageKey: `${SERVER_ID}/${id}`,
  }, completedAt));
  return id;
}

async function uploadSession(db: Database, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(attachmentUploadSessions).values({
    id,
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    attachmentId: randomUUID(),
    clientRequestId: randomUUID(),
    filename: "draft.txt",
    mimeType: "text/plain",
    declaredSizeBytes: 42,
    storageKey: `${SERVER_ID}/session-${id}`,
    state: "pending",
    quotaMonth: "2026-10",
    quotaReservedBytes: 42,
    quotaLimited: false,
    expiresAt,
  });
  return id;
}

test("an unsent upload whose reservation expired doesn't block conversion; a live one does", async () => {
  const { client, db } = await fixture();
  try {
    await unsentUpload(db, new Date(Date.now() - 3 * HOUR_MS));
    assert.equal(await inFlight(db), null);

    const live = await unsentUpload(db, new Date());
    const blocked = await inFlight(db);
    assert.ok(blocked);
    assert.equal(blocked.uploadCount, 1);
    assert.deepEqual(blocked.uploadScope.reservationIds, [live]);
  } finally {
    await client.close();
  }
});

test("a planned transfer past its expiry doesn't block conversion; a live one does", async () => {
  const { client, db } = await fixture();
  try {
    const now = new Date();
    await createAttachmentTransferIntent(intentInput(randomUUID(), new Date(now.getTime() - HOUR_MS)), db, new Date(now.getTime() - 2 * HOUR_MS));
    assert.equal(await inFlight(db), null);

    const live = intentInput(randomUUID(), new Date(now.getTime() + HOUR_MS));
    await createAttachmentTransferIntent(live, db, now);
    const blocked = await inFlight(db);
    assert.ok(blocked);
    assert.deepEqual(blocked.uploadScope.transferIntentIds, [live.id]);
  } finally {
    await client.close();
  }
});

test("an upload session past its expiry doesn't block conversion; a live one does", async () => {
  const { client, db } = await fixture();
  try {
    await uploadSession(db, new Date(Date.now() - HOUR_MS));
    assert.equal(await inFlight(db), null);

    const live = await uploadSession(db, new Date(Date.now() + HOUR_MS));
    const blocked = await inFlight(db);
    assert.ok(blocked);
    assert.deepEqual(blocked.uploadScope.sessionIds, [live]);
  } finally {
    await client.close();
  }
});
