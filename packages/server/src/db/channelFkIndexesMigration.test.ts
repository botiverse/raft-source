import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { DEVICE_SESSION_KEY_INDEXES } from "../../scripts/device-session-key-indexes";

// Migration channel_fk_indexes: an index for each foreign key a channel delete
// checks that no index led with. Built in the migration only on a small table
// (by pg_relation_size); a large one is left to
// db:create-device-session-key-indexes (CONCURRENTLY), never a plain CREATE
// INDEX under the migration's transaction. That the migrated database has them
// valid, and that the FK lookup uses them, is deviceSessionKeyIndexes.test.ts.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const INDEXES: Array<[table: string, name: string]> = [
  ["inbox_notification_facts", "idx_inbox_notification_facts_source_channel"],
  ["agent_channel_read_cursors", "idx_agent_channel_read_cursors_channel"],
  ["reminders", "idx_reminders_target_channel"],
  ["user_channel_read_cursors", "idx_user_channel_read_cursors_channel"],
  ["inbox_suppression_states", "idx_inbox_suppression_states_target"],
  ["action_cards", "idx_action_cards_conversion_source_channel"],
];

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_channel_fk_indexes"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("builds each index only inside its table's size guard, under bounded timeouts, and the create script knows every one", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "channel fk indexes", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '30s';");
  assert.equal(steps.length, 3);
  const body = steps[2]!;
  assert.ok(!/CREATE INDEX CONCURRENTLY/i.test(body), "no CONCURRENTLY inside the migration's transaction");
  assert.equal(body.match(/CREATE INDEX/g)?.length, INDEXES.length);
  for (const [table, name] of INDEXES) {
    assert.match(body, new RegExp(`IF pg_relation_size\\('public\\.${table}'::regclass\\) <= 1048576 THEN\\s+CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"`));
    assert.ok(DEVICE_SESSION_KEY_INDEXES.some((spec) => spec.name === name && spec.table === table), `${name} is built CONCURRENTLY on a large table`);
  }
});

test("a small table gets its index here; a large one is left to the concurrent build", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE inbox_notification_facts (id serial PRIMARY KEY, source_channel_id uuid NOT NULL);
      CREATE TABLE agent_channel_read_cursors (agent_id uuid NOT NULL, channel_id uuid NOT NULL, pad text, PRIMARY KEY (agent_id, channel_id));
      CREATE TABLE reminders (id serial PRIMARY KEY, target_channel_id uuid);
      CREATE TABLE user_channel_read_cursors (user_id uuid NOT NULL, channel_id uuid NOT NULL, PRIMARY KEY (user_id, channel_id));
      CREATE TABLE inbox_suppression_states (id serial PRIMARY KEY, target_channel_id uuid NOT NULL);
      CREATE TABLE action_cards (id serial PRIMARY KEY, conversion_source_channel_id uuid);
      INSERT INTO agent_channel_read_cursors (agent_id, channel_id, pad)
        SELECT gen_random_uuid(), gen_random_uuid(), repeat('x', 200) FROM generate_series(1, 6000);`);
    const size = await db.query<{ size: number }>(`SELECT pg_relation_size('public.agent_channel_read_cursors'::regclass)::int AS size`);
    assert.ok(size.rows[0]!.size > 1048576, "agent_channel_read_cursors is over the guard");
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    const built = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname`, [INDEXES.map(([, name]) => name)]);
    assert.deepEqual(
      built.rows.map((row) => row.indexname),
      INDEXES.map(([, name]) => name).filter((name) => name !== "idx_agent_channel_read_cursors_channel").sort(),
    );
  } finally {
    await db.close();
  }
});
