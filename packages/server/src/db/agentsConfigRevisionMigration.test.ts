import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Reconciler step 11b: agents.config_revision on a hot table, under a 2 s lock
// wait, as a metadata-only change (a constant default rewrites no row).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

async function migration(suffix: string): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, `${suffix} is in the journal`);
  return (await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"))
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

test("adds agents.config_revision with a constant default under a 2 s lock wait, nothing else", async () => {
  const steps = await migration("_agents_config_revision");
  assertBoundedLockTimeout(steps[0], "agents config revision", { maxMs: 2_000 });
  assert.deepEqual(steps.slice(1), [`ALTER TABLE "agents" ADD COLUMN "config_revision" bigint DEFAULT 0 NOT NULL;`]);
});

test("existing agents read revision 0 without a table rewrite", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE "agents" ("id" uuid PRIMARY KEY);
      INSERT INTO "agents" VALUES ('10000000-0000-4000-8000-000000000001');
    `);
    const before = await db.query<{ relfilenode: number }>(`SELECT relfilenode FROM pg_class WHERE relname = 'agents'`);
    await db.exec("BEGIN");
    for (const step of await migration("_agents_config_revision")) await db.exec(step);
    await db.exec("COMMIT");
    const after = await db.query<{ relfilenode: number }>(`SELECT relfilenode FROM pg_class WHERE relname = 'agents'`);
    assert.equal(after.rows[0]!.relfilenode, before.rows[0]!.relfilenode, "no rewrite: the table keeps its file");
    const missing = await db.query<{ atthasmissing: boolean }>(
      `SELECT atthasmissing FROM pg_attribute WHERE attrelid = 'agents'::regclass AND attname = 'config_revision'`,
    );
    assert.equal(missing.rows[0]!.atthasmissing, true, "the default is kept in the catalog, not written to each row");
    const rows = await db.query<{ config_revision: number | string }>(`SELECT config_revision FROM "agents"`);
    assert.equal(Number(rows.rows[0]!.config_revision), 0);
  } finally {
    await db.close();
  }
});
