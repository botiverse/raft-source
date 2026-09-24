import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import { attachmentObjects, attachments, channels, messages, servers, users } from "../db/schema.js";
import { cleanupLegacyOrphanAttachmentsWithDependencies } from "./storageService.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const OLD = new Date("2026-08-11T00:00:00.000Z");
const NOW = new Date("2026-08-12T00:00:00.000Z");

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({ id: USER_ID, email: "legacy-cleaner@slock.test", name: "cleaner", passwordHash: "x" });
  await db.insert(servers).values({ id: SERVER_ID, name: "Cleaner", slug: "cleaner", ownerId: USER_ID });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "cleaner" });
  await db.insert(messages).values({
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: USER_ID,
    content: "host",
  });
  return { client, db };
}

function legacyAttachment(id: string) {
  return {
    id,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user" as const,
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
    storageKey: `${SERVER_ID}/${id}`,
    createdAt: OLD,
  };
}

test("a stale legacy candidate is retained when send wins before the guarded row lock", async () => {
  const { client, db } = await fixture();
  try {
    const id = "55555555-5555-4555-8555-555555555555";
    await db.insert(attachments).values(legacyAttachment(id));
    const cleaned = await cleanupLegacyOrphanAttachmentsWithDependencies({
      db,
      now: NOW,
      beforeCandidateLock: async (candidateId) => {
        await db.update(attachments).set({ messageId: MESSAGE_ID }).where(eq(attachments.id, candidateId));
      },
    });
    assert.equal(cleaned, 0);
    const [row] = await db.select().from(attachments).where(eq(attachments.id, id));
    assert.equal(row?.messageId, MESSAGE_ID);
  } finally {
    await client.close();
  }
});

test("legacy cleanup never claims an object-backed pending projection", async () => {
  const { client, db } = await fixture();
  try {
    const id = "66666666-6666-4666-8666-666666666666";
    const objectId = "77777777-7777-4777-8777-777777777777";
    await db.insert(attachmentObjects).values({
      id: objectId,
      originServerId: SERVER_ID,
      uploaderId: USER_ID,
      uploaderType: "user",
      storageKey: `${SERVER_ID}/${id}`,
      mimeType: "text/plain",
      sizeBytes: 1,
      createdAt: OLD,
    });
    await db.insert(attachments).values({ ...legacyAttachment(id), objectId });
    assert.equal(await cleanupLegacyOrphanAttachmentsWithDependencies({ db, now: NOW }), 0);
    assert.equal((await db.select().from(attachments)).length, 1);
    assert.equal((await db.select().from(attachmentObjects)).length, 1);
  } finally {
    await client.close();
  }
});

test("legacy cleaner implementation has no physical storage deletion capability", () => {
  const source = readFileSync(fileURLToPath(new URL("./storageService.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export async function cleanupLegacyOrphanAttachmentsWithDependencies");
  const end = source.indexOf("export async function cleanupOrphanAttachments", start);
  assert.ok(start >= 0 && end > start);
  const implementation = source.slice(start, end);
  assert.doesNotMatch(implementation, /getStorage|getCdnStorage|\b(?:storage|cdnStorage)\.delete\s*\(/);
  assert.match(implementation, /isNull\(attachments\.objectId\)/);
  assert.match(implementation, /for\("update"/);
});
