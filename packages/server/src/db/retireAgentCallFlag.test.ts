import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { openTestApp } from "../test/integration/app";
import { getFeatureFlag } from "../services/featureFlagService";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

test("retiring the agent call flag removes it and its rules, keeps other flags, and is safe to run twice", async () => {
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const migrations = journal.entries.filter((entry) => entry.tag.endsWith("_retire_agent_call_flag"));
  assert.equal(migrations.length, 1);
  const migration = await readFile(path.join(DRIZZLE_DIR, `${migrations[0].tag}.sql`), "utf8");
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE feature_flags (key text PRIMARY KEY);
      CREATE TABLE feature_flag_rules (flag_key text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE);
      CREATE TABLE feature_flag_config_versions (scope text PRIMARY KEY, version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by text, last_audit_event_id text);
      INSERT INTO feature_flags (key) VALUES ('agent_call_v0'), ('other_flag');
      INSERT INTO feature_flag_rules (flag_key) VALUES ('agent_call_v0'), ('other_flag');
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
      assert.deepEqual((await client.query("SELECT version::int, updated_by FROM feature_flag_config_versions WHERE scope = 'global'")).rows,
        [{ version: 42, updated_by: "migration:retire-agent-call" }], `the version moves once, attempt ${attempt}`);
    }
  } finally {
    await client.close();
  }
});

test("a freshly migrated database has no agent call flag", async () => {
  const { close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    assert.equal(await getFeatureFlag("agent_call_v0"), null);
  } finally {
    await close();
  }
});
