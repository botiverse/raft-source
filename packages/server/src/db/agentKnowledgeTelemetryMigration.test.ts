import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = path.resolve(import.meta.dirname, "../../drizzle/0254_workable_sally_floyd.sql");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

test("0254 adds nullable Manual operation and bounded retrieval-path values without backfill", async () => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE "agent_knowledge_events" (
        "id" text PRIMARY KEY,
        "resolution" text
      );
      INSERT INTO "agent_knowledge_events" ("id", "resolution") VALUES
        ('legacy-null', NULL),
        ('legacy-token-route', 'token_route');
    `);

    const migration = await readFile(MIGRATION, "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const legacy = await client.query<{
      id: string;
      operation: string | null;
      resolution: string | null;
    }>(`
      SELECT "id", "operation", "resolution"
      FROM "agent_knowledge_events"
      ORDER BY "id"
    `);
    assert.deepEqual(legacy.rows, [
      { id: "legacy-null", operation: null, resolution: null },
      { id: "legacy-token-route", operation: null, resolution: "token_route" },
    ]);

    const operations = ["get", "search"] as const;
    const resolutions = [
      "exact_id",
      "alias",
      "token_route",
      "lexical",
      "concept_expansion",
      "typo_correction",
      "mixed",
      "language_gate",
    ] as const;
    for (const [index, resolution] of resolutions.entries()) {
      await client.query(
        `INSERT INTO "agent_knowledge_events" ("id", "operation", "resolution") VALUES ($1, $2, $3)`,
        [`valid-${index}`, operations[index % operations.length], resolution],
      );
    }

    await assert.rejects(
      client.exec(`
        INSERT INTO "agent_knowledge_events" ("id", "operation", "resolution")
        VALUES ('invalid-operation', 'list', 'lexical')
      `),
      /agent_knowledge_events_operation_valid/,
    );
    await assert.rejects(
      client.exec(`
        INSERT INTO "agent_knowledge_events" ("id", "operation", "resolution")
        VALUES ('invalid-resolution', 'search', 'translated')
      `),
      /agent_knowledge_events_resolution_valid/,
    );

    const count = await client.query<{ count: number }>(`
      SELECT count(*)::int AS "count" FROM "agent_knowledge_events"
    `);
    assert.equal(count.rows[0]?.count, 2 + resolutions.length);
  } finally {
    await client.close();
  }
});
