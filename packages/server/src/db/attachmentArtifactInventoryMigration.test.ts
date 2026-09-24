import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

async function applyThrough(client: PGlite, lastIndex: number): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  await client.exec("BEGIN");
  try {
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= lastIndex)) {
      const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
      for (const statement of statements(migration)) await client.exec(statement);
    }
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

test("0231 is additive, evidence-only, and fail-closed", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 231);
    const tables = (await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'attachment_artifact_inventory_runs',
          'attachment_artifact_inventory_observations',
          'attachment_object_inventory_classifications'
        )
      ORDER BY table_name
    `)).rows.map((row) => row.table_name);
    assert.deepEqual(tables, [
      "attachment_artifact_inventory_observations",
      "attachment_artifact_inventory_runs",
      "attachment_object_inventory_classifications",
    ]);

    await assert.rejects(
      client.exec(`
        INSERT INTO attachment_artifact_inventory_runs (
          id, evidence_source, source_revision, inventory_digest,
          object_count, artifact_count, observation_count, classification_count,
          legacy_objectless_projection_count, dangling_projection_count,
          metadata_mismatch_count, deleted_origin_server_object_count, observed_at
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', 'test', 'head', 'digest',
          0, 0, 0, 0, 0, 0, 0, -1, now()
        )
      `),
      /attachment_artifact_inventory_runs_counts_nonnegative/,
    );

    const migration = await readFile(path.join(DRIZZLE_DIR, "0231_hesitant_mister_sinister.sql"), "utf8");
    assert.doesNotMatch(migration, /(^|;)\s*(delete|update|truncate)\b/im, "inventory schema migration must not mutate historical rows");
    assert.doesNotMatch(migration, /attachment_object_gc_jobs|lifecycle_state\s*=/i, "migration must not enable GC or lifecycle work");
  } finally {
    await client.close();
  }
});
