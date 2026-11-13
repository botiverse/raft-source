import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Manual requests from the raft SDK (and the cloud runtime, which names no
// client) are recorded as source 'sdk'. The widened CHECK comes NOT VALID:
// every existing row is 'cli', so nothing is rescanned under the DDL lock.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIX = "_agent_knowledge_events_sdk_source";

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migrationStatements(): Promise<string[]> {
  const entries = (JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(SUFFIX));
  assert.ok(entry, `${SUFFIX} is in the journal`);
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("the sdk source migration only swaps the CHECK, under a lock timeout, without a rescan", async () => {
  const steps = await migrationStatements();
  assertBoundedLockTimeout(steps[0]);
  assert.deepEqual(steps.slice(1), [
    `ALTER TABLE "agent_knowledge_events" DROP CONSTRAINT "agent_knowledge_events_source_valid";`,
    `ALTER TABLE "agent_knowledge_events" ADD CONSTRAINT "agent_knowledge_events_source_valid" CHECK ("agent_knowledge_events"."source" IN ('cli', 'sdk')) NOT VALID;`,
  ]);
});

test("after the migration, legacy cli rows stay, sdk rows are accepted, and other sources are still refused", async () => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE "agent_knowledge_events" (
        "id" text PRIMARY KEY,
        "source" text NOT NULL,
        CONSTRAINT "agent_knowledge_events_source_valid" CHECK ("agent_knowledge_events"."source" IN ('cli'))
      );
      INSERT INTO "agent_knowledge_events" ("id", "source") VALUES ('legacy', 'cli');
    `);

    await client.exec("BEGIN");
    for (const statement of await migrationStatements()) await client.exec(statement);
    await client.exec("COMMIT");

    await client.query(`INSERT INTO "agent_knowledge_events" ("id", "source") VALUES ('sdk', 'sdk')`);
    await assert.rejects(
      client.query(`INSERT INTO "agent_knowledge_events" ("id", "source") VALUES ('mcp', 'mcp')`),
      /agent_knowledge_events_source_valid/,
    );

    const rows = await client.query<{ id: string; source: string }>(
      `SELECT "id", "source" FROM "agent_knowledge_events" ORDER BY "id"`,
    );
    assert.deepEqual(rows.rows, [
      { id: "legacy", source: "cli" },
      { id: "sdk", source: "sdk" },
    ]);

    const constraint = await client.query<{ convalidated: boolean }>(
      `SELECT "convalidated" FROM pg_constraint WHERE conname = 'agent_knowledge_events_source_valid'`,
    );
    assert.deepEqual(constraint.rows, [{ convalidated: false }], "catalog-only: existing rows were not rescanned");
  } finally {
    await client.close();
  }
});
