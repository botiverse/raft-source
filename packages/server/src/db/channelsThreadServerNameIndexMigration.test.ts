import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { DEVICE_SESSION_KEY_INDEXES } from "../../scripts/device-session-key-indexes";

// Migration channels_thread_server_name_index: live threads by (server_id,
// name), for resolveThreadByShortId. Built in the migration only on a small
// channels table (by pg_relation_size); a large one is left to
// db:create-device-session-key-indexes (CONCURRENTLY), never a plain CREATE
// INDEX under the migration's transaction on a hot table. That the migrated
// database has it valid, and that the lookup uses it, is
// deviceSessionKeyIndexes.test.ts.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const NAME = "idx_channels_thread_server_name";

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_channels_thread_server_name_index"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("builds the index only inside the size guard, under bounded timeouts, and the create script knows it", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "channels thread server name index", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '30s';");
  assert.equal(steps.length, 3);
  const body = steps[2]!;
  assert.ok(!/CREATE INDEX CONCURRENTLY/i.test(body), "no CONCURRENTLY inside the migration's transaction");
  assert.ok(!/UNIQUE/i.test(body), "short ids can collide: not unique");
  assert.equal(body.match(/CREATE INDEX/g)?.length, 1);
  assert.match(body, new RegExp(`IF pg_relation_size\\('public\\.channels'::regclass\\) <= 1048576 THEN\\s+CREATE INDEX IF NOT EXISTS "${NAME}" ON "channels"`));
  assert.ok(DEVICE_SESSION_KEY_INDEXES.some((spec) => spec.name === NAME && spec.table === "channels" && !spec.unique), `${NAME} is built CONCURRENTLY on a large table`);
});

test("a small channels table gets the index here; a large one is left to the concurrent build", async () => {
  for (const rows of [0, 6000]) {
    const db = new PGlite();
    try {
      await db.exec(`
        CREATE TABLE channels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), server_id uuid NOT NULL, name text NOT NULL, type text NOT NULL, deleted_at timestamptz, pad text);
        INSERT INTO channels (server_id, name, type, pad)
          SELECT gen_random_uuid(), 'thread-' || i, 'thread', repeat('x', 200) FROM generate_series(1, ${rows}) AS i;`);
      await db.exec("BEGIN");
      for (const step of await migration()) await db.exec(step);
      await db.exec("COMMIT");
      const built = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE indexname = $1`, [NAME]);
      assert.equal(built.rows.length, rows === 0 ? 1 : 0, `${rows} rows`);
    } finally {
      await db.close();
    }
  }
});
