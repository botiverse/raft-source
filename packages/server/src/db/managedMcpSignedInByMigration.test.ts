import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// managed_mcp_credentials.signed_in_by_user_id: nullable, backfilled in batches from
// created_by_user_id for the rows that hold a secret, then a NOT VALID ON DELETE SET NULL key to
// users, last, under a 2 s lock wait (users is hot).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(suffix: string): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, `${suffix} is in the journal`);
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("a bounded lock wait, the column, the backfill, and the foreign key last and NOT VALID", async () => {
  const steps = await migration("_managed_mcp_credentials_signed_in_by");
  assertBoundedLockTimeout(steps[0], "signed in by", { maxMs: 2_000 });
  assert.equal(steps[2], `ALTER TABLE "managed_mcp_credentials" ADD COLUMN "signed_in_by_user_id" uuid;`);
  assert.match(steps[3]!, /^DO \$\$/);
  assert.equal(
    steps.at(-1),
    `ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_signed_in_by_user_id_users_id_fk" FOREIGN KEY ("signed_in_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;`,
  );
});

test("rows holding a secret name their creator; signed-out, never signed in and creator-less rows stay NULL", async () => {
  const db = new PGlite();
  const creator = "10000000-0000-4000-8000-000000000001";
  const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  try {
    await db.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY);
      CREATE TABLE "managed_mcp_credentials" (
        "id" uuid PRIMARY KEY,
        "encrypted_headers" text,
        "encrypted_oauth" text,
        "auth_status" text NOT NULL DEFAULT 'ready',
        "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL
      );
      INSERT INTO "users" VALUES ('${creator}');
      INSERT INTO "managed_mcp_credentials" ("id", "encrypted_headers", "encrypted_oauth", "auth_status", "created_by_user_id") VALUES
        ('${id(1)}', 'key', NULL, 'ready', '${creator}'),
        ('${id(2)}', NULL, 'tokens', 'ready', '${creator}'),
        ('${id(3)}', NULL, 'tokens', 'expired', '${creator}'),
        ('${id(4)}', NULL, 'client-only', 'needs_auth', '${creator}'),
        ('${id(5)}', NULL, NULL, 'needs_auth', '${creator}'),
        ('${id(6)}', 'key', NULL, 'ready', NULL);
      -- More than one batch.
      INSERT INTO "managed_mcp_credentials" ("id", "encrypted_headers", "created_by_user_id")
        SELECT ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'key', '${creator}' FROM generate_series(1, 2500) AS n;
    `);
    await db.exec("BEGIN");
    for (const step of await migration("_managed_mcp_credentials_signed_in_by")) await db.exec(step);
    await db.exec("COMMIT");

    const named = (await db.query<{ id: string; signed_in_by_user_id: string | null }>(
      `SELECT id, signed_in_by_user_id FROM managed_mcp_credentials WHERE id::text LIKE '20000000%' ORDER BY id`)).rows;
    assert.deepEqual(named.map((row) => row.signed_in_by_user_id), [creator, creator, creator, null, null, null]);
    const bulk = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM managed_mcp_credentials WHERE id::text LIKE '30000000%' AND signed_in_by_user_id = '${creator}'`)).rows[0];
    assert.equal(bulk?.n, 2500);

    const constraint = (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'managed_mcp_credentials_signed_in_by_user_id_users_id_fk'`)).rows[0];
    assert.equal(constraint?.convalidated, false);
    await assert.rejects(db.query(`UPDATE managed_mcp_credentials SET signed_in_by_user_id = '10000000-0000-4000-8000-0000000000ff' WHERE id = '${id(5)}'`), /signed_in_by_user_id_users_id_fk/);
    await db.query(`UPDATE managed_mcp_credentials SET created_by_user_id = NULL`);
    await db.query(`DELETE FROM users WHERE id = '${creator}'`);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM managed_mcp_credentials WHERE signed_in_by_user_id IS NOT NULL`)).rows[0]?.n, 0, "ON DELETE SET NULL");
  } finally {
    await db.close();
  }
});
