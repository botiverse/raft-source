import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Migration read_mutations_principal_stats: extended statistics on the
// principal prefix, so the planner sees that a (server, type, principal)
// prefix matches a principal's rows, not 1, and the full-key lookup keeps the
// unique index instead of walking worker_order_idx.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_read_mutations_principal_stats"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("bounded timeouts, then the statistics and an analyze, nothing else", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "read_mutations principal stats", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '120s';");
  assert.equal(steps.length, 4);
  assert.match(steps[2]!, /^CREATE STATISTICS IF NOT EXISTS "read_mutations_principal_stats" \(dependencies, ndistinct\) ON "server_id", "principal_type", "principal_id" FROM "read_mutations";$/);
  assert.equal(steps[3], `ANALYZE "read_mutations";`);
});

test("the statistics exist with both kinds, and the prefix estimate follows the principal", async () => {
  const db = new PGlite();
  try {
    // Each principal belongs to one server: the dependency the planner misses.
    await db.exec(`
      CREATE TABLE read_mutations (server_id uuid NOT NULL, principal_type text NOT NULL, principal_id uuid NOT NULL, mutation_id uuid NOT NULL DEFAULT gen_random_uuid());
      CREATE TABLE principals AS SELECT gen_random_uuid() AS server_id, gen_random_uuid() AS principal_id, i FROM generate_series(1, 200) AS i;
      INSERT INTO read_mutations (server_id, principal_type, principal_id)
        SELECT p.server_id, CASE WHEN p.i % 2 = 0 THEN 'human' ELSE 'agent' END, p.principal_id FROM principals p, generate_series(1, 100);`);
    const probe = async () => {
      const principal = await db.query<{ server_id: string; principal_type: string; principal_id: string }>(`SELECT server_id, principal_type, principal_id FROM read_mutations LIMIT 1`);
      const p = principal.rows[0]!;
      const plan = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT 1 FROM read_mutations WHERE server_id = '${p.server_id}' AND principal_type = '${p.principal_type}' AND principal_id = '${p.principal_id}'`);
      return Number(/rows=(\d+)/.exec(plan.rows[0]!["QUERY PLAN"])![1]);
    };
    await db.exec(`ANALYZE read_mutations`);
    assert.ok(await probe() <= 2, "independence: the prefix is estimated at about one row");
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    const stats = await db.query<{ kinds: string }>(`SELECT array_to_string(stxkind, '') AS kinds FROM pg_statistic_ext WHERE stxname = 'read_mutations_principal_stats'`);
    assert.equal(stats.rows[0]?.kinds.split("").sort().join(""), "df", "ndistinct (d) and dependencies (f)");
    assert.ok(await probe() >= 50, "with the dependency the prefix is estimated near the principal's 100 rows");
  } finally {
    await db.close();
  }
});
