import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION_TAG = "0247_charming_barracuda";

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

test("0247 creates typed reusable audiences with cascade and unique membership", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 247);
    await client.exec(`
      INSERT INTO feature_flag_audiences (key, name) VALUES ('founders', 'Founders');
      INSERT INTO feature_flag_audience_members (id, audience_key, kind, target_id)
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'founders',
        'user',
        '22222222-2222-4222-8222-222222222222'
      );
    `);

    await assert.rejects(
      client.exec(`
        INSERT INTO feature_flag_audience_members (id, audience_key, kind, target_id)
        VALUES (
          '33333333-3333-4333-8333-333333333333',
          'founders',
          'user',
          '22222222-2222-4222-8222-222222222222'
        )
      `),
      /idx_feature_flag_audience_members_target/,
    );
    await assert.rejects(
      client.exec(`
        INSERT INTO feature_flag_audience_members (id, audience_key, kind, target_id)
        VALUES (
          '44444444-4444-4444-8444-444444444444',
          'founders',
          'agent',
          '55555555-5555-4555-8555-555555555555'
        )
      `),
      /feature_flag_audience_members_kind_valid/,
    );

    await client.exec("DELETE FROM feature_flag_audiences WHERE key = 'founders'");
    const remaining = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM feature_flag_audience_members",
    );
    assert.equal(remaining.rows[0]?.count, 0);
  } finally {
    await client.close();
  }
});

test("0247 grants only the audience route's bounded user and server projections", async () => {
  const migration = await readFile(path.join(DRIZZLE_DIR, `${MIGRATION_TAG}.sql`), "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reconcile_feature_flag_admin_privileges/);
  assert.match(
    migration,
    /table_name IN \([\s\S]*'announcements'[\s\S]*'announcement_audit_events'[\s\S]*'feature_flag_audiences'[\s\S]*'feature_flag_audience_members'[\s\S]*'users'[\s\S]*'servers'[\s\S]*\)/,
  );
  assert.match(migration, /'operator-surfaces-v2'[\s\S]*'0247_charming_barracuda'/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.feature_flag_audiences/);
  assert.match(migration, /GRANT SELECT, INSERT, DELETE ON TABLE public\.feature_flag_audience_members/);
  assert.doesNotMatch(migration, /GRANT [^;]*DELETE ON TABLE public\.feature_flag_audiences/);
  assert.doesNotMatch(migration, /GRANT [^;]*UPDATE ON TABLE public\.feature_flag_audience_members/);
  assert.match(migration, /GRANT SELECT \(id\) ON TABLE public\.users/);
  assert.match(migration, /GRANT SELECT \(id, slug, deleted_at\) ON TABLE public\.servers/);
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE public\.(users|servers)/);
  assert.doesNotMatch(migration, /GRANT .*\b(email|display_name|name)\b.* ON TABLE public\.(users|servers)/i);
});
