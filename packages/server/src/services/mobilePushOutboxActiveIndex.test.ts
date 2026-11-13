// The drain's candidate read must be servable by the partial index
// idx_mobile_push_outbox_active_created, the index the migration builds must
// match what the CONCURRENTLY create/verify scripts expect (they run first in
// staging/prod and make the migration a no-op), and the table carries the
// autovacuum / no-truncate options of migration 0359.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { notificationOutboxDrainCandidatesQuery as mobilePushOutboxDrainCandidatesQuery } from "./notifications/dispatcher";
import {
  ACTIVE_INDEX_COLUMNS,
  ACTIVE_INDEX_NAME,
  ACTIVE_INDEX_PREDICATE,
} from "../../scripts/mobile-push-outbox-active-index";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(async () => {
  await closeTestDatabase();
});

test("migrations build the active-row index exactly as the create/verify scripts expect", async ({ db }) => {
  void db;
  const result = await getDb().execute(sql`
    SELECT i.indisunique AS "isUnique",
           array_to_string(array_agg(a.attname ORDER BY k.ord), ',') AS "columns",
           pg_get_expr(i.indpred, i.indrelid) AS "predicate"
    FROM pg_class idx
    JOIN pg_index i ON i.indexrelid = idx.oid
    JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE idx.relname = ${ACTIVE_INDEX_NAME}
    GROUP BY i.indisunique, i.indpred, i.indrelid
  `);
  const rows = (result as unknown as { rows: Array<{ isUnique: boolean; columns: string; predicate: string }> }).rows;
  assert.equal(rows.length, 1, "index must exist after migrations");
  assert.equal(rows[0]!.isUnique, false);
  assert.equal(rows[0]!.columns, ACTIVE_INDEX_COLUMNS);
  assert.equal(rows[0]!.predicate, ACTIVE_INDEX_PREDICATE);

  const migration = await readFile(path.join(SERVER_ROOT, "drizzle/0359_mobile_push_outbox_active_index.sql"), "utf8");
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "idx_mobile_push_outbox_active_created"/);
  const statements = migration.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  assert.doesNotMatch(statements.replace(/'[^']*'/g, "''"), /CONCURRENTLY/, "migrations run in a transaction");
  // Fail closed instead of a blocking build on a large table (Tenny, #9994).
  assert.match(statements, /to_regclass\('public\.idx_mobile_push_outbox_active_created'\) IS NULL/);
  assert.match(statements, /RAISE EXCEPTION/);
});

test("the outbox table vacuums at 2% dead tuples and never truncates its tail", async ({ db }) => {
  void db;
  // Renamed to notification_outbox (migration notification_outbox); the options moved with it.
  const result = await getDb().execute(sql`SELECT reloptions FROM pg_class WHERE relname = 'notification_outbox'`);
  const options = ((result as unknown as { rows: Array<{ reloptions: string[] | string | null }> }).rows[0]?.reloptions) ?? [];
  const list = Array.isArray(options) ? options : String(options).replace(/^\{|\}$/g, "").split(",");
  assert.ok(list.includes("autovacuum_vacuum_scale_factor=0.02"), String(list));
  assert.ok(list.includes("autovacuum_analyze_scale_factor=0.02"), String(list));
  assert.ok(list.includes("vacuum_truncate=false"), String(list));
});

test("the drain's candidate read uses the active-row index", async ({ db }) => {
  void db;
  const query = mobilePushOutboxDrainCandidatesQuery(getDb(), new Date(), 50).toSQL();
  const client = (getDb() as unknown as { $client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }> } }).$client;
  await client.query("SET enable_seqscan = off");
  try {
    const plan = await client.query(`EXPLAIN ${query.sql}`, query.params);
    const text = plan.rows.map((r) => Object.values(r)[0]).join("\n");
    assert.match(text, new RegExp(ACTIVE_INDEX_NAME), text);
  } finally {
    await client.query("RESET enable_seqscan");
  }
});

test("the migration's guard refuses a missing index on a large outbox and passes otherwise", async ({ db }) => {
  void db;
  const migration = await readFile(path.join(SERVER_ROOT, "drizzle/0359_mobile_push_outbox_active_index.sql"), "utf8");
  const guard = migration.split("--> statement-breakpoint").find((part) => part.includes("RAISE EXCEPTION"))!;
  // The guard names the table as it was then (mobile_push_outbox); run it
  // against its current name (migration notification_outbox renamed it).
  const block = guard.slice(guard.indexOf("DO $$")).replace("'public.mobile_push_outbox'::regclass", "'public.notification_outbox'::regclass");
  // Index present (as after migrations): the guard is a no-op.
  await getDb().execute(sql.raw(block));
  // Present but invalid (a failed concurrent build): the guard raises.
  await getDb().execute(sql`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.idx_mobile_push_outbox_active_created'::regclass`);
  await assert.rejects(getDb().execute(sql.raw(block)), /exists but is invalid/);
  await getDb().execute(sql`UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'public.idx_mobile_push_outbox_active_created'::regclass`);
  // Missing index on a table the planner believes is large: the guard raises.
  await getDb().execute(sql`DROP INDEX "idx_mobile_push_outbox_active_created"`);
  await getDb().execute(sql`UPDATE pg_class SET reltuples = 7000000 WHERE oid = 'public.notification_outbox'::regclass`);
  await assert.rejects(getDb().execute(sql.raw(block)), /db:create-mobile-push-outbox-active-index/);
});
