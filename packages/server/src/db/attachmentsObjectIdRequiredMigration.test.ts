import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Storage step 2c (PR A): the legacy physical columns on `attachments` become
// nullable and stay; object_id becomes NOT NULL through a NOT VALID CHECK, its
// VALIDATE, then SET NOT NULL, one migration (one transaction) each.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIXES = [
  "_attachments_legacy_physical_nullable",
  "_attachments_object_id_validate",
  "_attachments_object_id_not_null",
] as const;
const LEGACY_COLUMNS = ["mime_type", "size_bytes", "storage_key", "thumbnail_key", "content_hash", "width", "height"];

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function journal(): Promise<JournalEntry[]> {
  return (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
}

async function targets(): Promise<{ entries: JournalEntry[]; steps: JournalEntry[] }> {
  const entries = await journal();
  const steps = SUFFIXES.map((suffix) => {
    const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
    assert.ok(entry, `${suffix} is in the journal`);
    return entry;
  });
  assert.deepEqual(steps.map((step) => step.idx), [steps[0]!.idx, steps[0]!.idx + 1, steps[0]!.idx + 2], "consecutive");
  return { entries, steps };
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
  VALUES ('11111111-1111-4111-8111-111111111111', 'storage-2c@slock.test', 'storage-2c', 'test');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id")
  VALUES ('22222222-2222-4222-8222-222222222222', 'Storage 2c', 'storage-2c', '11111111-1111-4111-8111-111111111111');
  INSERT INTO "channels" ("id", "server_id", "name")
  VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'storage-2c');
  INSERT INTO "attachment_objects" ("id", "origin_server_id", "uploader_id", "uploader_type", "storage_key", "mime_type", "size_bytes")
  VALUES ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'user', 'k', 'image/png', 7);
`;

function attachmentInsert(id: string, objectId: string | null, legacy: boolean): string {
  const object = objectId ? `'${objectId}'` : "NULL";
  return legacy
    ? `INSERT INTO "attachments" ("id", "object_id", "channel_id", "uploader_id", "uploader_type", "filename", "mime_type", "size_bytes", "storage_key", "content_hash")
       VALUES ('${id}', ${object}, '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'a.png', 'image/png', 7, 'k', 'h')`
    : `INSERT INTO "attachments" ("id", "object_id", "channel_id", "uploader_id", "uploader_type", "filename")
       VALUES ('${id}', ${object}, '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'a.png')`;
}

test("the step 2c migrations are lock-bounded, catalog-only or VALIDATE, and drop nothing", async () => {
  const { steps } = await targets();
  const [nullable, validate, notNull] = await Promise.all(steps.map(migrationStatements));
  for (const executable of [nullable!, validate!, notNull!]) {
    assert.match(executable[0] ?? "", /^SET LOCAL lock_timeout = '\d+s';$/);
    for (const statement of executable) {
      assert.doesNotMatch(statement, /\bDROP\s+(COLUMN|INDEX|TABLE)\b/i, "the legacy columns stay for one release");
      assert.doesNotMatch(statement, /\b(UPDATE|DELETE FROM|INSERT INTO|ADD COLUMN|SET DATA TYPE|TYPE\s+\w+\s+USING)\b/i, "no rewrite, no data change");
    }
  }
  assert.deepEqual(nullable!.slice(1), [
    `ALTER TABLE "attachments" ALTER COLUMN "mime_type" DROP NOT NULL;`,
    `ALTER TABLE "attachments" ALTER COLUMN "size_bytes" DROP NOT NULL;`,
    `ALTER TABLE "attachments" ALTER COLUMN "storage_key" DROP NOT NULL;`,
    `ALTER TABLE "attachments" ADD CONSTRAINT "attachments_object_id_not_null" CHECK ("attachments"."object_id" IS NOT NULL) NOT VALID;`,
  ]);
  assert.deepEqual(validate!.slice(1), [
    `ALTER TABLE "attachments" VALIDATE CONSTRAINT "attachments_object_id_not_null";`,
  ], "the scan runs alone, under SHARE UPDATE EXCLUSIVE");
  assert.deepEqual(notNull!.slice(1), [
    `ALTER TABLE "attachments" ALTER COLUMN "object_id" SET NOT NULL;`,
    `ALTER TABLE "attachments" DROP CONSTRAINT "attachments_object_id_not_null";`,
  ], "SET NOT NULL comes after the validated CHECK, so it needs no scan");
});

test("existing rows keep their legacy values; new rows may omit them but must name an object", async () => {
  const { entries, steps } = await targets();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < steps[0]!.idx));
    await client.exec(SEED);
    await client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "44444444-4444-4444-8444-444444444444", true));
    await assert.rejects(
      client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9", "44444444-4444-4444-8444-444444444444", false)),
      /null value in column "mime_type"/,
      "before: the legacy copies are required",
    );

    await apply(client, [steps[0]!]);
    // The previous release (still running during the rollout) writes both.
    await client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "44444444-4444-4444-8444-444444444444", true));
    // This release writes the projection only.
    await client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "44444444-4444-4444-8444-444444444444", false));
    await assert.rejects(
      client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", null, false)),
      /attachments_object_id_not_null/,
      "the NOT VALID CHECK already guards new rows",
    );

    await apply(client, steps.slice(1));
    await assert.rejects(
      client.exec(attachmentInsert("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", null, false)),
      /null value in column "object_id"/,
    );

    const columns = (await client.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'attachments'
    `)).rows;
    const nullability = new Map(columns.map((column) => [column.column_name, column.is_nullable]));
    assert.equal(nullability.get("object_id"), "NO");
    for (const column of LEGACY_COLUMNS) assert.equal(nullability.get(column), "YES", `${column} kept, nullable`);
    const constraints = (await client.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.attachments'::regclass AND conname = 'attachments_object_id_not_null'
    `)).rows;
    assert.deepEqual(constraints, [], "the helper CHECK is gone once NOT NULL holds");

    const rows = (await client.query<{ id: string; mime_type: string | null; size_bytes: number | null; storage_key: string | null; content_hash: string | null }>(`
      SELECT id, mime_type, size_bytes, storage_key, content_hash FROM attachments ORDER BY id
    `)).rows;
    assert.deepEqual(rows, [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", mime_type: "image/png", size_bytes: 7, storage_key: "k", content_hash: "h" },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", mime_type: "image/png", size_bytes: 7, storage_key: "k", content_hash: "h" },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", mime_type: null, size_bytes: null, storage_key: null, content_hash: null },
    ]);
  } finally {
    await client.close();
  }
});

test("a projection without an object stops the deploy at VALIDATE, before NOT NULL", async () => {
  const { entries, steps } = await targets();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < steps[0]!.idx));
    await client.exec(SEED);
    await client.exec(attachmentInsert("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", null, true));
    await apply(client, [steps[0]!]);
    await assert.rejects(apply(client, [steps[1]!]), /attachments_object_id_not_null/);
    const [objectId] = (await client.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'attachments' AND column_name = 'object_id'
    `)).rows;
    assert.equal(objectId?.is_nullable, "YES");
  } finally {
    await client.close();
  }
});
