import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../drizzle/0176_wandering_jimmy_woo.sql",
);

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

test("0176 pre-aggregates DM memberships instead of counting per channel", async () => {
  const migration = await readFile(migrationPath, "utf8");

  assert.match(migration, /WITH "human_memberships" AS \(/);
  assert.match(migration, /"agent_memberships" AS \(/);
  assert.match(migration, /GROUP BY "channel_id"/);
  assert.equal(
    migration.match(/INSERT INTO "dm_channel_identities"/g)?.length,
    1,
    "the backfill should be one pre-aggregated insert",
  );
  assert.doesNotMatch(
    migration,
    /\(SELECT\s+count\(\*\)\s+FROM\s+"?channel_(?:humans|agents)"?/i,
    "a correlated count makes the backfill scale once per DM channel",
  );
});

test("0176 backfills only active DMs with exact membership provenance", async () => {
  const client = new PGlite();
  try {
    await client.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY NOT NULL);
      CREATE TABLE "servers" ("id" uuid PRIMARY KEY NOT NULL);
      CREATE TABLE "agents" ("id" uuid PRIMARY KEY NOT NULL);
      CREATE TABLE "channels" (
        "id" uuid PRIMARY KEY NOT NULL,
        "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
        "type" text NOT NULL,
        "deleted_at" timestamp with time zone
      );
      CREATE TABLE "channel_humans" (
        "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        PRIMARY KEY ("channel_id", "user_id")
      );
      CREATE TABLE "channel_agents" (
        "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
        "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
        PRIMARY KEY ("channel_id", "agent_id")
      );

      INSERT INTO "servers" ("id")
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      INSERT INTO "users" ("id") VALUES
        ('10000000-0000-4000-8000-000000000001'),
        ('90000000-0000-4000-8000-000000000009');
      INSERT INTO "agents" ("id") VALUES
        ('20000000-0000-4000-8000-000000000002'),
        ('80000000-0000-4000-8000-000000000008');
      INSERT INTO "channels" ("id", "server_id", "type", "deleted_at") VALUES
        ('00000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', NULL),
        ('00000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', NULL),
        ('00000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', NULL),
        ('00000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', NULL),
        ('00000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', now()),
        ('00000000-0000-4000-8000-000000000006', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'channel', NULL),
        ('00000000-0000-4000-8000-000000000007', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dm', NULL);

      INSERT INTO "channel_humans" ("channel_id", "user_id") VALUES
        ('00000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000009'),
        ('00000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000009'),
        ('00000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000001'),
        ('00000000-0000-4000-8000-000000000007', '90000000-0000-4000-8000-000000000009');
      INSERT INTO "channel_agents" ("channel_id", "agent_id") VALUES
        ('00000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'),
        ('00000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000008'),
        ('00000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002'),
        ('00000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000002'),
        ('00000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000002'),
        ('00000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000002');
    `);

    const migration = await readFile(migrationPath, "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const identities = await client.query<{
      channel_id: string;
      kind: string;
      peer_key: string;
    }>(`
      SELECT "channel_id", "kind", "peer_key"
      FROM "dm_channel_identities"
      ORDER BY "channel_id"
    `);

    assert.deepEqual(identities.rows, [
      {
        channel_id: "00000000-0000-4000-8000-000000000001",
        kind: "human_agent",
        peer_key: "20000000-0000-4000-8000-000000000002:90000000-0000-4000-8000-000000000009",
      },
      {
        channel_id: "00000000-0000-4000-8000-000000000002",
        kind: "human_human",
        peer_key: "10000000-0000-4000-8000-000000000001:90000000-0000-4000-8000-000000000009",
      },
      {
        channel_id: "00000000-0000-4000-8000-000000000003",
        kind: "agent_agent",
        peer_key: "20000000-0000-4000-8000-000000000002:80000000-0000-4000-8000-000000000008",
      },
    ]);
  } finally {
    await client.close();
  }
});
