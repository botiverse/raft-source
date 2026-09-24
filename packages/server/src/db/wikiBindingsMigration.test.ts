import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyThrough(client: PGlite, lastIndex: number): Promise<void> {
  const journal = JSON.parse(
    await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of journal.entries.filter((candidate) => candidate.idx <= lastIndex)) {
    const migration = await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);
  }
}

test("0205 starts Wiki bindings from zero without touching pre-release state", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 203);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        'wiki-bindings@example.com',
        'wiki-bindings-owner',
        'test'
      );
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES (
        '22222222-2222-4222-8222-222222222222',
        'Wiki Bindings Server',
        'wiki-bindings-server',
        '11111111-1111-4111-8111-111111111111'
      );
      INSERT INTO "agents" ("id", "server_id", "name")
      VALUES (
        '33333333-3333-4333-8333-333333333333',
        '22222222-2222-4222-8222-222222222222',
        'LegacyWikiAgent'
      );
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES (
        '44444444-4444-4444-8444-444444444444',
        '22222222-2222-4222-8222-222222222222',
        'legacy-wiki'
      );
      INSERT INTO "wiki_spaces" (
        "id",
        "server_id",
        "wiki_agent_id",
        "wiki_channel_id",
        "status",
        "created_by_user_id"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        'active',
        '11111111-1111-4111-8111-111111111111'
      );
      INSERT INTO "reminders" (
        "id",
        "server_id",
        "owner_agent_id",
        "title",
        "fire_at",
        "payload",
        "created_by_type",
        "created_by_id"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        'Legacy Wiki ingest',
        '2026-07-27T00:00:00.000Z',
        '{"kind":"wiki.incremental_discovery","wikiSpaceId":"55555555-5555-4555-8555-555555555555"}',
        'agent',
        '33333333-3333-4333-8333-333333333333'
      );
    `);

    const migration = await readFile(
      path.join(DRIZZLE_DIR, "0205_create_wiki_bindings.sql"),
      "utf8",
    );
    for (const statement of statements(migration)) await client.exec(statement);

    const bindings = await client.query<{ id: string }>(`SELECT "id" FROM "wiki_bindings"`);
    assert.deepEqual(bindings.rows, []);

    const legacySpaces = await client.query<{ id: string; status: string }>(`
      SELECT "id", "status"
      FROM "wiki_spaces"
    `);
    assert.deepEqual(legacySpaces.rows, [{
      id: "55555555-5555-4555-8555-555555555555",
      status: "active",
    }]);

    const legacyReminders = await client.query<{ id: string; title: string }>(`
      SELECT "id", "title"
      FROM "reminders"
    `);
    assert.deepEqual(legacyReminders.rows, [{
      id: "55555555-5555-4555-8555-555555555555",
      title: "Legacy Wiki ingest",
    }]);

    await client.exec(`
      INSERT INTO "wiki_bindings" (
        "id",
        "server_id",
        "wiki_agent_id",
        "wiki_channel_id",
        "created_by_user_id"
      ) VALUES (
        '66666666-6666-4666-8666-666666666666',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        '11111111-1111-4111-8111-111111111111'
      )
    `);
    const fresh = await client.query<{ id: string; status: string }>(`
      SELECT "id", "status"
      FROM "wiki_bindings"
    `);
    assert.deepEqual(fresh.rows, [{
      id: "66666666-6666-4666-8666-666666666666",
      status: "ready_uninitialized",
    }]);
  } finally {
    await client.close();
  }
});
