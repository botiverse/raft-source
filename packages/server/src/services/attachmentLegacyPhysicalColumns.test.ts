import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import { attachmentObjects, channels, messages, servers, users } from "../db/schema";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import {
  createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor,
  createIdempotentPendingAttachmentProjectionWithExecutor,
  createPendingAttachmentProjectionWithExecutor,
  type PendingAttachmentProjectionInput,
} from "./attachmentProjectionWriterService";
import { buildAttachmentTransferArtifactPlan, createAttachmentTransferIntent } from "./attachmentTransferIntentService";

// Storage step 2c: the physical metadata lives only on attachment_objects.
// Part A stopped writing the legacy copies on `attachments` (mime_type,
// size_bytes, storage_key, thumbnail_key, content_hash, width, height) and
// removed them from the model; part B dropped them from the database.
const LEGACY_COLUMNS = ["mime_type", "size_bytes", "storage_key", "thumbnail_key", "content_hash", "width", "height"] as const;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-26T12:00:00.000Z");

async function fixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({ id: USER_ID, email: "storage-2c@slock.test", name: "storage-2c", passwordHash: "test" });
  await db.insert(servers).values({ id: SERVER_ID, name: "Storage 2c", slug: "storage-2c", ownerId: USER_ID });
  await db.insert(channels).values({ id: CHANNEL_ID, serverId: SERVER_ID, name: "storage-2c" });
  await db.insert(messages).values({ id: MESSAGE_ID, channelId: CHANNEL_ID, senderType: "user", senderId: USER_ID, content: "host" });
  return { client, db };
}

function upload(id: string): PendingAttachmentProjectionInput {
  return {
    id,
    objectId: randomUUID(),
    transferIntentId: randomUUID(),
    serverId: SERVER_ID,
    channelId: CHANNEL_ID,
    uploaderId: USER_ID,
    uploaderType: "user",
    filename: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 12,
    storageKey: `storage-2c/${id}`,
    thumbnailKey: `storage-2c/${id}.thumb`,
    contentHash: "c".repeat(64),
    width: 4,
    height: 3,
  };
}

async function plan(db: Database, value: PendingAttachmentProjectionInput): Promise<void> {
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
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    artifacts: buildAttachmentTransferArtifactPlan(value),
  }, db, NOW);
}

async function attachmentColumns(db: Database): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'attachments'
     ORDER BY column_name
  `);
  return (result.rows as Array<{ column_name: string }>).map((row) => row.column_name);
}

test("the legacy physical columns and their index are gone from the database", async () => {
  const { client, db } = await fixture();
  try {
    const columns = await attachmentColumns(db);
    assert.ok(columns.includes("object_id") && columns.includes("filename"), "the projection columns stay");
    assert.deepEqual(columns.filter((column) => (LEGACY_COLUMNS as readonly string[]).includes(column)), []);
    const indexes = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_attachments_content_hash'
    `);
    assert.deepEqual(indexes.rows, []);
  } finally {
    await client.close();
  }
});

test("every projection writer answers with the object's metadata", async () => {
  const { client, db } = await fixture();
  try {
    const plain = upload("55555555-5555-4555-8555-555555555551");
    const idempotent = upload("55555555-5555-4555-8555-555555555552");
    await plan(db, plain);
    await plan(db, idempotent);

    const created = await db.transaction((tx) => createPendingAttachmentProjectionWithExecutor(tx, plain, NOW));
    const replayable = await db.transaction((tx) => createIdempotentPendingAttachmentProjectionWithExecutor(tx, idempotent, NOW));
    const replayed = await db.transaction((tx) => createIdempotentPendingAttachmentProjectionWithExecutor(tx, idempotent, NOW));
    const shared = await db.transaction((tx) => createIdempotentPendingAttachmentProjectionForExistingObjectWithExecutor(tx, {
      id: "55555555-5555-4555-8555-555555555553",
      objectId: plain.objectId,
      serverId: SERVER_ID,
      channelId: CHANNEL_ID,
      uploaderId: "external-actor",
      uploaderType: "external_projection",
      filename: "shared.png",
      mimeType: plain.mimeType,
      sizeBytes: plain.sizeBytes,
      contentHash: plain.contentHash!,
    }, NOW));
    const [linked] = await db.transaction((tx) => linkAttachmentsToMessageWithExecutor(tx, [plain.id], MESSAGE_ID, USER_ID, "new", NOW));

    const projections = await db.execute(sql`SELECT id::text AS id FROM attachments ORDER BY id`);
    assert.deepEqual(projections.rows, [
      { id: plain.id },
      { id: idempotent.id },
      { id: "55555555-5555-4555-8555-555555555553" },
    ]);

    const metadata = (value: PendingAttachmentProjectionInput) => ({
      storageKey: value.storageKey,
      thumbnailKey: value.thumbnailKey,
      contentHash: value.contentHash,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes,
      width: value.width,
      height: value.height,
    });
    const pick = (row: Record<string, unknown>) => Object.fromEntries(
      ["storageKey", "thumbnailKey", "contentHash", "mimeType", "sizeBytes", "width", "height"].map((key) => [key, row[key]]),
    );
    assert.deepEqual(pick(created), metadata(plain));
    assert.deepEqual(pick(replayable), metadata(idempotent));
    assert.deepEqual(pick(replayed), metadata(idempotent), "a replay answers from the object too");
    assert.deepEqual(pick(shared), metadata(plain), "an occurrence of an existing object reads that object");
    assert.deepEqual(pick(linked!), metadata(plain), "the linked message attachment reads the object");
    assert.equal((await db.select().from(attachmentObjects)).length, 2);
  } finally {
    await client.close();
  }
});

test("a projection without an object cannot be stored", async () => {
  const { client, db } = await fixture();
  try {
    await assert.rejects(db.execute(sql`
      INSERT INTO attachments (id, channel_id, uploader_id, uploader_type, filename)
      VALUES (${randomUUID()}, ${CHANNEL_ID}, ${USER_ID}, 'user', 'orphan.png')
    `), (error: Error & { cause?: Error }) => /null value in column "object_id"/.test(error.cause?.message ?? error.message));
  } finally {
    await client.close();
  }
});

// The drizzle model does not declare the legacy columns, so TypeScript
// rejects them in query-builder code. Raw SQL is not typed: this scan names
// any source that still reads or writes them through an alias of
// `attachments`, which now fails at runtime because the columns are dropped.
// Migrations and migration tests (historical schemas) are out of scope.
const SERVER_ROOT = path.resolve(import.meta.dirname, "../..");
const SCAN_ROOTS = ["src", "scripts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|mjs|js|sql)$/.test(entry.name) ? [full] : [];
  });
}

export function legacyAttachmentColumnReferences(source: string): string[] {
  const aliases = new Set<string>(["attachments", "\"attachments\""]);
  const aliasPattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?"?attachments"?(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  for (const match of source.matchAll(aliasPattern)) {
    const alias = match[1];
    if (alias && !/^(where|on|set|values|join|inner|left|order|group|limit|for|using|select|returning)$/i.test(alias)) {
      aliases.add(alias);
    }
  }
  const hits: string[] = [];
  for (const alias of aliases) {
    const escaped = alias.replace(/"/g, "\"?");
    const pattern = new RegExp(`(?<![\\w.])${escaped}\\."?(${LEGACY_COLUMNS.join("|")})\\b`, "g");
    for (const match of source.matchAll(pattern)) hits.push(`${alias.replace(/"/g, "")}.${match[1]}`);
  }
  const insertPattern = /INSERT\s+INTO\s+"?attachments"?\s*\(([^)]*)\)/gi;
  for (const match of source.matchAll(insertPattern)) {
    const columns = match[1]!.split(",").map((column) => column.trim().replace(/"/g, ""));
    for (const column of columns) {
      if ((LEGACY_COLUMNS as readonly string[]).includes(column)) hits.push(`INSERT INTO attachments (... ${column} ...)`);
    }
  }
  const updatePattern = /UPDATE\s+(?:public\.)?"?attachments"?(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|`|$)/gi;
  for (const match of source.matchAll(updatePattern)) {
    for (const column of LEGACY_COLUMNS) {
      if (new RegExp(`(?:^|[\\s,"])${column}"?\\s*=`).test(match[1]!)) hits.push(`UPDATE attachments SET ${column}`);
    }
  }
  return hits;
}

test("the legacy-column scan finds raw SQL through an alias and in an INSERT column list", () => {
  assert.deepEqual(legacyAttachmentColumnReferences("SELECT a.mime_type FROM attachments a"), ["a.mime_type"]);
  assert.deepEqual(legacyAttachmentColumnReferences("SELECT p.width FROM attachments AS p"), ["p.width"]);
  assert.deepEqual(legacyAttachmentColumnReferences(`UPDATE "attachments" SET x = 1 WHERE "attachments"."storage_key" = $1`), ["attachments.storage_key"]);
  assert.deepEqual(legacyAttachmentColumnReferences("INSERT INTO attachments (id, content_hash) VALUES ($1, $2)"), ["INSERT INTO attachments (... content_hash ...)"]);
  assert.deepEqual(legacyAttachmentColumnReferences("UPDATE attachments SET filename = $1, thumbnail_key = $2 WHERE id = $3"), ["UPDATE attachments SET thumbnail_key"]);
  assert.deepEqual(legacyAttachmentColumnReferences("UPDATE attachment_objects SET thumbnail_key = $1"), []);
  assert.deepEqual(legacyAttachmentColumnReferences("SELECT o.mime_type FROM attachments a JOIN attachment_objects o ON o.id = a.object_id"), []);
});

test("no server source reads or writes the legacy physical columns of attachments", () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(SERVER_ROOT, root))) {
      const relative = path.relative(SERVER_ROOT, file);
      if (/Migration\.test\.ts$|migration\d+.*\.test\.ts$/i.test(relative)) continue;
      if (relative === path.join("src", "services", "attachmentLegacyPhysicalColumns.test.ts")) continue;
      for (const hit of legacyAttachmentColumnReferences(readFileSync(file, "utf8"))) offenders.push(`${relative}: ${hit}`);
    }
  }
  assert.deepEqual(offenders, []);
});
