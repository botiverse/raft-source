import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const TAG_SUFFIX = "_attachment_object_holds";

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function journal(): Promise<JournalEntry[]> {
  return (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] }).entries;
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  await client.exec("BEGIN");
  try {
    for (const entry of entries) {
      const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
      for (const statement of statements(migration)) await client.exec(statement);
    }
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

test("the holds migration is lock-bounded, additive, and touches no attachments table", async () => {
  const entries = await journal();
  const target = entries.find((entry) => entry.tag.endsWith(TAG_SUFFIX));
  assert.ok(target, "holds migration is in the journal");
  const sqlText = await readFile(path.join(DRIZZLE_DIR, `${target.tag}.sql`), "utf8");
  const executable = statements(sqlText).map((statement) =>
    statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim()
  ).filter(Boolean);
  assert.match(executable[0] ?? "", /^SET LOCAL lock_timeout = '\d+s';$/);
  for (const statement of executable) {
    assert.doesNotMatch(statement, /\b(ALTER|UPDATE|DELETE FROM|INSERT INTO)\s+(TABLE\s+)?"?attachments"?\b/i);
    assert.doesNotMatch(statement, /attachment_upload_reservations/i);
    assert.doesNotMatch(statement, /\bDEFAULT\b.*unheld_since|unheld_since.*\bDEFAULT\b/i, "no default: catalog-only ADD COLUMN");
  }

  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < target.idx));
    await client.exec(`
      INSERT INTO "attachment_objects" ("id", "origin_server_id", "uploader_id", "uploader_type", "storage_key", "mime_type", "size_bytes")
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'u', 'user', 'k', 'text/plain', 1);
    `);
    await apply(client, [target]);

    const [object] = (await client.query<{ unheld_since: Date | null }>(
      `SELECT "unheld_since" FROM "attachment_objects"`,
    )).rows;
    assert.equal(object?.unheld_since, null, "existing objects start untracked");
    assert.equal((await client.query(`SELECT 1 FROM "attachment_object_holds"`)).rows.length, 0);

    await client.exec(`
      INSERT INTO "attachment_object_holds" ("holder_type", "holder_id", "object_id")
      VALUES ('attachment', 'a', '11111111-1111-4111-8111-111111111111');
    `);
    await assert.rejects(client.exec(`
      INSERT INTO "attachment_object_holds" ("holder_type", "holder_id", "object_id")
      VALUES ('attachment', 'a', '11111111-1111-4111-8111-111111111111');
    `), /duplicate key/);
    await assert.rejects(client.exec(`
      INSERT INTO "attachment_object_holds" ("holder_type", "holder_id", "object_id")
      VALUES ('artifact_version', 'v', '11111111-1111-4111-8111-111111111111');
    `), /attachment_object_holds_holder_type/);
    await assert.rejects(client.exec(`
      INSERT INTO "attachment_object_holds" ("holder_type", "holder_id", "object_id")
      VALUES ('attachment', 'b', '33333333-3333-4333-8333-333333333333');
    `), /foreign key/);
    await assert.rejects(
      client.exec(`DELETE FROM "attachment_objects" WHERE "id" = '11111111-1111-4111-8111-111111111111'`),
      /foreign key/,
      "a held object row cannot be deleted",
    );
  } finally {
    await client.close();
  }
});
