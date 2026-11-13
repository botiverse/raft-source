import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";
import { DEVICE_SESSION_KEY_INDEXES } from "../../scripts/device-session-key-indexes";
import { POST_MIGRATION_INDEXES } from "./postMigrationIndexes";

// Migration closed_server_purge_app_fk_indexes: an index for each foreign key to
// oauth_clients the closed-server purge's delete of a never-shared app makes
// Postgres check. Built in the migration only on a small
// table (by pg_relation_size); a large one is left to
// db:create-device-session-key-indexes (CONCURRENTLY), never a plain CREATE
// INDEX under the migration's transaction. That the migrated database has
// them is closedServerPurgeClassification.db.test.ts.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

const INDEXES: Array<[table: string, name: string]> = [
  ["oauth_access_tokens", "idx_oauth_access_tokens_client"],
  ["oauth_app_installation_tokens", "idx_oauth_app_installation_tokens_client"],
  ["official_app_auto_install_transitions", "idx_official_app_auto_install_transitions_client"],
  ["oauth_agent_auto_grant_blocks", "idx_oauth_agent_auto_grant_blocks_client"],
];

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_closed_server_purge_app_fk_indexes"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("builds each index only inside its table's size guard, under bounded timeouts; the create script and the post-migration guard know every one", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "closed-server purge app fk indexes", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '30s';");
  assert.equal(steps.length, 3);
  const body = steps[2]!;
  assert.ok(!/CREATE INDEX CONCURRENTLY/i.test(body), "no CONCURRENTLY inside the migration's transaction");
  assert.equal(body.match(/CREATE INDEX/g)?.length, INDEXES.length);
  for (const [table, name] of INDEXES) {
    assert.match(body, new RegExp(`IF pg_relation_size\\('public\\.${table}'::regclass\\) <= 1048576 THEN\\s+CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"`));
    assert.ok(DEVICE_SESSION_KEY_INDEXES.some((spec) => spec.name === name && spec.table === table), `${name} is built CONCURRENTLY on a large table`);
    assert.ok(POST_MIGRATION_INDEXES.some((spec) => spec.name === name && spec.table === table), `${name} is checked after migrating`);
  }
});

test("a small table gets its index here; a large one is left to the concurrent build", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE oauth_access_tokens (id serial PRIMARY KEY, client_id uuid, pad text);
      CREATE TABLE oauth_app_installation_tokens (id serial PRIMARY KEY, client_id uuid);
      CREATE TABLE official_app_auto_install_transitions (id serial PRIMARY KEY, client_id uuid);
      CREATE TABLE oauth_agent_auto_grant_blocks (id serial PRIMARY KEY, client_id uuid);
      INSERT INTO oauth_access_tokens (client_id, pad) SELECT NULL, repeat('x', 200) FROM generate_series(1, 6000);`);
    const size = await db.query<{ size: number }>(`SELECT pg_relation_size('public.oauth_access_tokens'::regclass)::int AS size`);
    assert.ok(size.rows[0]!.size > 1048576, "oauth_access_tokens is over the guard");
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    const built = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname`, [INDEXES.map(([, name]) => name)]);
    assert.deepEqual(
      built.rows.map((row) => row.indexname),
      INDEXES.map(([, name]) => name).filter((name) => name !== "idx_oauth_access_tokens_client").sort(),
    );
  } finally {
    await db.close();
  }
});
