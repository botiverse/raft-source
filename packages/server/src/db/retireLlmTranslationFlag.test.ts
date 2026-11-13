import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { openTestApp } from "../test/integration/app";
import { getFeatureFlag } from "../services/featureFlagService";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

test("retiring the LLM translation flag removes its rules but preserves other flags", async () => {
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const migrations = journal.entries.filter((entry) => entry.tag.endsWith("_retire_llm_translation"));
  assert.equal(migrations.length, 1);
  const migration = await readFile(path.join(DRIZZLE_DIR, `${migrations[0].tag}.sql`), "utf8");
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE feature_flags (key text PRIMARY KEY);
      CREATE TABLE feature_flag_rules (flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE);
      CREATE TABLE feature_flag_config_versions (scope text PRIMARY KEY, version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by text, last_audit_event_id text);
      INSERT INTO feature_flags (key) VALUES ('llm_translation_v0'), ('other_flag');
      INSERT INTO feature_flag_rules (flag_key) VALUES ('llm_translation_v0'), ('other_flag');
      INSERT INTO feature_flag_config_versions (scope, version, updated_by, last_audit_event_id)
        VALUES ('global', 41, 'old-writer', 'old-audit');
    `);

    for (const attempt of [1, 2]) {
      await client.exec("BEGIN");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.exec(statement);
      }
      await client.exec("COMMIT");
      assert.deepEqual((await client.query("SELECT key FROM feature_flags ORDER BY key")).rows, [{ key: "other_flag" }], `flags after attempt ${attempt}`);
      assert.deepEqual((await client.query("SELECT flag_key FROM feature_flag_rules ORDER BY flag_key")).rows, [{ flag_key: "other_flag" }], `rules after attempt ${attempt}`);
      assert.deepEqual((await client.query("SELECT version::int, updated_by, last_audit_event_id FROM feature_flag_config_versions WHERE scope = 'global'")).rows,
        [{ version: 42, updated_by: "migration:retire-llm-translation", last_audit_event_id: null }], `version after attempt ${attempt}`);
    }
    await client.exec("DELETE FROM feature_flag_config_versions; INSERT INTO feature_flags (key) VALUES ('llm_translation_v0')");
    await client.exec("BEGIN");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
    await client.exec("COMMIT");
    assert.deepEqual((await client.query("SELECT version::int FROM feature_flag_config_versions WHERE scope = 'global'")).rows, [{ version: 1 }]);
  } finally {
    await client.close();
  }
});

test("a freshly migrated database does not expose the retired LLM flag", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    assert.equal(await getFeatureFlag("llm_translation_v0"), null);
  } finally {
    await close();
  }
});
