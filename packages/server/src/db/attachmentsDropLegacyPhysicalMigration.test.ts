import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Storage step 2c (part B): drop the legacy physical copies on `attachments`
// that part A (0452-0454) made nullable and stopped writing, plus their index.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const DROP_SUFFIX = "_attachments_drop_legacy_physical";
const NOT_NULL_SUFFIX = "_attachments_object_id_not_null";
const LEGACY_COLUMNS = ["mime_type", "size_bytes", "storage_key", "thumbnail_key", "content_hash", "width", "height"];

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function targets(): Promise<{ entries: JournalEntry[]; drop: JournalEntry; notNull: JournalEntry }> {
  const entries = (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
  const drop = entries.find((entry) => entry.tag.endsWith(DROP_SUFFIX));
  const notNull = entries.find((entry) => entry.tag.endsWith(NOT_NULL_SUFFIX));
  assert.ok(drop, `${DROP_SUFFIX} is in the journal`);
  assert.ok(notNull, `${NOT_NULL_SUFFIX} is in the journal`);
  return { entries, drop, notNull };
}

async function migrationStatements(entry: JournalEntry): Promise<string[]> {
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of await migrationStatements(entry)) await client.exec(statement);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  }
}

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash")
  VALUES ('11111111-1111-4111-8111-111111111111', 'storage-2c-b@slock.test', 'storage-2c-b', 'test');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id")
  VALUES ('22222222-2222-4222-8222-222222222222', 'Storage 2c B', 'storage-2c-b', '11111111-1111-4111-8111-111111111111');
  INSERT INTO "channels" ("id", "server_id", "name")
  VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'storage-2c-b');
  INSERT INTO "attachment_objects" ("id", "origin_server_id", "uploader_id", "uploader_type", "storage_key", "mime_type", "size_bytes", "content_hash")
  VALUES ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'user', 'k', 'image/png', 7, 'h');
`;

// A row written before part A (it still carries the legacy copies) and one
// written by part A or later (projection only), as the database holds them.
const OLD_ROW = `
  INSERT INTO "attachments" ("id", "object_id", "channel_id", "uploader_id", "uploader_type", "filename", "mime_type", "size_bytes", "storage_key", "thumbnail_key", "content_hash", "width", "height")
  VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'old.png', 'image/png', 7, 'k', 'k.thumb', 'h', 4, 3)
`;
function projectionInsert(id: string): string {
  return `INSERT INTO "attachments" ("id", "object_id", "channel_id", "uploader_id", "uploader_type", "filename")
    VALUES ('${id}', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'new.png')`;
}

async function attachmentColumns(client: PGlite): Promise<string[]> {
  return (await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'attachments'
  `)).rows.map((row) => row.column_name);
}

async function contentHashIndex(client: PGlite): Promise<unknown[]> {
  return (await client.query(`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_attachments_content_hash'
  `)).rows;
}

test("the drop is lock-bounded, catalog-only, and runs after object_id became NOT NULL", async () => {
  const { drop, notNull } = await targets();
  assert.ok(drop.idx > notNull.idx, "an objectless database stops at part A's VALIDATE, before anything is dropped");
  const executable = await migrationStatements(drop);
  assertBoundedLockTimeout(executable[0]);
  assert.deepEqual(executable.slice(1), [
    `DROP INDEX IF EXISTS "idx_attachments_content_hash";`,
    ...LEGACY_COLUMNS.map((column) => `ALTER TABLE "attachments" DROP COLUMN "${column}";`),
  ]);
  for (const statement of executable) {
    assert.doesNotMatch(statement, /\b(CASCADE|UPDATE|DELETE FROM|INSERT INTO|ADD COLUMN|SET DATA TYPE|USING|VACUUM)\b/i, "no rewrite, no data change, no cascade");
  }
  const source = await readFile(path.join(DRIZZLE_DIR, `${drop.tag}.sql`), "utf8");
  assert.match(source, /^-- schema-snapshot: unchanged \(/m, "schema.ts and the snapshots lack the columns since part A");
});

test("dropping the legacy columns keeps every projection and the current writer's insert", async () => {
  const { entries, drop } = await targets();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < drop.idx));
    await client.exec(SEED);
    await client.exec(OLD_ROW);
    await client.exec(projectionInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"));
    assert.equal((await contentHashIndex(client)).length, 1, "the index part A kept is still there");
    for (const column of LEGACY_COLUMNS) assert.ok((await attachmentColumns(client)).includes(column), `${column} present before`);

    await apply(client, [drop]);

    const columns = await attachmentColumns(client);
    assert.deepEqual(columns.filter((column) => LEGACY_COLUMNS.includes(column)), []);
    assert.deepEqual(await contentHashIndex(client), []);
    const rows = (await client.query<{ id: string; object_id: string; filename: string }>(`
      SELECT id, object_id, filename FROM attachments ORDER BY id
    `)).rows;
    assert.deepEqual(rows, [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", object_id: "44444444-4444-4444-8444-444444444444", filename: "old.png" },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", object_id: "44444444-4444-4444-8444-444444444444", filename: "new.png" },
    ]);

    // What the release running during the deploy (and this one) writes.
    await client.exec(projectionInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"));
    // Code that still named a legacy column would fail loudly now.
    await assert.rejects(
      client.exec(`SELECT storage_key FROM attachments`),
      /column "storage_key" does not exist/,
    );
  } finally {
    await client.close();
  }
});
