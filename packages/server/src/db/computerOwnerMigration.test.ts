import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Computer owner v1 (#wg-rbac:#32): daemons.owner_user_id, nullable, no
// backfill (every Computer starts Public), a NOT VALID foreign key to users
// with ON DELETE SET NULL, under a 2 s lock wait (daemons and users are hot).
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

test("adds a nullable column and a NOT VALID ON DELETE SET NULL foreign key, nothing else (no backfill)", async () => {
  const steps = await migration("_computer_owner");
  assertBoundedLockTimeout(steps[0], "computer owner", { maxMs: 2_000 });
  assert.deepEqual(steps.slice(1), [
    `SET LOCAL statement_timeout = '30s';`,
    `ALTER TABLE "daemons" ADD COLUMN "owner_user_id" uuid;`,
    `ALTER TABLE "daemons" ADD CONSTRAINT "daemons_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;`,
  ]);
});

test("existing Computers stay Public; an owner whose users row goes leaves the Computer Public", async () => {
  const db = new PGlite();
  const user = "10000000-0000-4000-8000-000000000001";
  const existing = "20000000-0000-4000-8000-000000000001";
  const owned = "20000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY);
      CREATE TABLE "daemons" ("id" uuid PRIMARY KEY, "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE, "name" text NOT NULL);
      INSERT INTO "users" VALUES ('${user}');
      INSERT INTO "daemons" VALUES ('${existing}', '${user}', 'existing');
    `);
    await db.exec("BEGIN");
    for (const step of await migration("_computer_owner")) await db.exec(step);
    await db.exec("COMMIT");

    assert.deepEqual((await db.query(`SELECT owner_user_id FROM daemons`)).rows, [{ owner_user_id: null }]);
    const column = (await db.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'daemons' AND column_name = 'owner_user_id'`)).rows[0];
    assert.deepEqual(column, { is_nullable: "YES", column_default: null });

    await assert.rejects(db.query(`UPDATE daemons SET owner_user_id = '10000000-0000-4000-8000-0000000000ff'`), /daemons_owner_user_id_users_id_fk/);
    const other = "10000000-0000-4000-8000-000000000002";
    await db.exec(`INSERT INTO "users" VALUES ('${other}'); INSERT INTO "daemons" VALUES ('${owned}', '${user}', 'owned')`);
    await db.query(`UPDATE daemons SET owner_user_id = '${other}' WHERE id = '${owned}'`);
    await db.query(`DELETE FROM users WHERE id = '${other}'`);
    assert.deepEqual((await db.query(`SELECT id, owner_user_id FROM daemons ORDER BY id`)).rows, [
      { id: existing, owner_user_id: null },
      { id: owned, owner_user_id: null },
    ]);
  } finally {
    await db.close();
  }
});
