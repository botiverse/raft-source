import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Migration tasks_last_activity: tasks.last_activity_at (the Tasks page's
// activity sort) is nullable with no default and no backfill (tasks is large:
// adding it rewrites no rows), under a bounded lock wait; the activity and
// creation-time indexes are built in the migration only on a small table (otherwise by
// db:create-device-session-key-indexes, CONCURRENTLY).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_tasks_last_activity"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

const TABLE = `CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL,
  "task_number" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
)`;

test("adds a nullable last_activity_at with no default and no backfill, under a bounded lock wait; the index only inside the size guard", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "tasks last activity", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '30s';");
  assert.equal(steps[2], `ALTER TABLE "tasks" ADD COLUMN "last_activity_at" timestamp with time zone;`);
  assert.ok(!steps.some((step) => /\bDEFAULT\b/i.test(step)), "no default: adding the column must not rewrite the table");
  assert.ok(!steps.some((step) => /^UPDATE\b/i.test(step)), "no backfill");
  assert.equal(steps.length, 4);
  assert.match(steps[3]!, /IF pg_relation_size\('public\.tasks'::regclass\) <= 1048576 THEN\s+CREATE INDEX IF NOT EXISTS "idx_tasks_channel_activity"[^\n]*\n\s+CREATE INDEX IF NOT EXISTS "idx_tasks_channel_created"/);
});

test("existing rows read NULL and order by updated_at through COALESCE; the small-table index is built and serves one channel's activity order", async () => {
  const db = new PGlite();
  try {
    await db.exec(`${TABLE};
      INSERT INTO "tasks" (id, channel_id, task_number, updated_at) VALUES
        ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, '2026-01-01T00:00:00Z'),
        ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 2, '2026-02-01T00:00:00Z');`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    assert.deepEqual((await db.query(`SELECT last_activity_at FROM tasks ORDER BY task_number`)).rows, [
      { last_activity_at: null },
      { last_activity_at: null },
    ]);
    // An older node's insert (no last_activity_at) still succeeds.
    await db.query(`INSERT INTO tasks (id, channel_id, task_number) VALUES ('33333333-3333-4333-8333-333333333333', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 3)`);
    await db.query(`UPDATE tasks SET last_activity_at = '2026-03-01T00:00:00Z' WHERE task_number = 1`);
    const ordered = await db.query<{ task_number: number }>(`SELECT task_number FROM tasks
      WHERE channel_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND task_number <> 3
      ORDER BY COALESCE(last_activity_at, updated_at) DESC, id DESC`);
    assert.deepEqual(ordered.rows.map((row) => row.task_number), [1, 2], "a stamped row sorts by its stamp, an older row by updated_at");

    const indexes = await db.query<{ name: string; def: string; valid: boolean }>(`SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('idx_tasks_channel_activity', 'idx_tasks_channel_created') ORDER BY c.relname`);
    assert.deepEqual(indexes.rows.map((row) => [row.name, row.valid]), [
      ["idx_tasks_channel_activity", true],
      ["idx_tasks_channel_created", true],
    ], "both built on a small table");
    assert.match(indexes.rows[0]!.def, /USING btree \(channel_id, COALESCE\(last_activity_at, updated_at\) DESC, id DESC\)$/);
    assert.match(indexes.rows[1]!.def, /USING btree \(channel_id, created_at DESC, id DESC\)$/);
  } finally {
    await db.close();
  }
});
