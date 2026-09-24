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

test("0209 preserves legacy announcement/dismissal data and backfills only completed accounts", async () => {
  const client = new PGlite();
  try {
    await client.exec(`SET TIME ZONE 'UTC'`);
    await applyThrough(client, 208);
    await client.exec(`
      INSERT INTO "users" (
        "id", "email", "name", "password_hash", "profile_setup_completed_at"
      ) VALUES
        (
          '11111111-1111-4111-8111-111111111111',
          'profile-complete@example.com',
          'profile-complete',
          'hash',
          '2026-07-20T01:00:00.000Z'
        ),
        (
          '22222222-2222-4222-8222-222222222222',
          'handoff-complete@example.com',
          'handoff-complete',
          'hash',
          NULL
        ),
        (
          '33333333-3333-4333-8333-333333333333',
          'incomplete@example.com',
          'incomplete',
          'hash',
          NULL
        );

      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES (
        '44444444-4444-4444-8444-444444444444',
        'Handoff server',
        'handoff-server',
        '22222222-2222-4222-8222-222222222222'
      );

      INSERT INTO "server_members" (
        "server_id", "user_id", "role", "setup_handoff_acknowledged_at"
      ) VALUES (
        '44444444-4444-4444-8444-444444444444',
        '22222222-2222-4222-8222-222222222222',
        'owner',
        '2026-07-21T02:00:00.000Z'
      );

      INSERT INTO "announcements" ("id", "title", "pages", "published_at", "created_at")
      VALUES
        (
          '55555555-5555-4555-8555-555555555555',
          'Older legacy announcement',
          '[{"body":"Historical"}]',
          '2026-07-22T03:00:00.000Z',
          '2026-07-22T03:00:00.000Z'
        ),
        (
          '66666666-6666-4666-8666-666666666666',
          'Latest legacy announcement',
          '[{"body":"Still live"}]',
          '2026-07-23T03:00:00.000Z',
          '2026-07-23T03:00:00.000Z'
        );

      INSERT INTO "user_announcement_dismissals" (
        "user_id", "announcement_id", "dismissed_at"
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        '66666666-6666-4666-8666-666666666666',
        '2026-07-24T04:00:00.000Z'
      );
    `);

    const migration = await readFile(
      path.join(DRIZZLE_DIR, "0209_announcement_lifecycle.sql"),
      "utf8",
    );
    for (const statement of statements(migration)) await client.exec(statement);

    const migratedUsers = await client.query<{
      id: string;
      completed_at: string | null;
      completion_family_id: string | null;
    }>(`
      SELECT
        "id",
        "first_onboarding_completed_at"::text AS completed_at,
        "first_onboarding_completed_session_family_id"::text AS completion_family_id
      FROM "users"
      ORDER BY "id"
    `);
    assert.deepEqual(migratedUsers.rows, [
      {
        id: "11111111-1111-4111-8111-111111111111",
        completed_at: "2026-07-20 01:00:00+00",
        completion_family_id: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        completed_at: "2026-07-21 02:00:00+00",
        completion_family_id: null,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        completed_at: null,
        completion_family_id: null,
      },
    ]);

    const announcements = await client.query<{
      id: string;
      status: string;
      default_locale: string;
      localized_content: Record<string, unknown>;
      published_at: string | null;
      starts_at: string | null;
      activated_at: string | null;
    }>(`
      SELECT
        "id",
        "status",
        "default_locale",
        "localized_content",
        "published_at"::text AS published_at,
        "starts_at"::text AS starts_at,
        "activated_at"::text AS activated_at
      FROM "announcements"
      ORDER BY "id"
    `);
    assert.deepEqual(announcements.rows, [
      {
        id: "55555555-5555-4555-8555-555555555555",
        status: "expired",
        default_locale: "en",
        localized_content: {
          en: {
            title: "Older legacy announcement",
            pages: [{ body: "Historical" }],
          },
        },
        published_at: "2026-07-22 03:00:00+00",
        starts_at: "2026-07-22 03:00:00+00",
        activated_at: "2026-07-22 03:00:00+00",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        status: "published",
        default_locale: "en",
        localized_content: {
          en: {
            title: "Latest legacy announcement",
            pages: [{ body: "Still live" }],
          },
        },
        published_at: "2026-07-23 03:00:00+00",
        starts_at: "2026-07-23 03:00:00+00",
        activated_at: "2026-07-23 03:00:00+00",
      },
    ]);

    const dismissals = await client.query<{
      user_id: string;
      announcement_id: string;
      dismissed_at: string;
    }>(`
      SELECT
        "user_id",
        "announcement_id",
        "dismissed_at"::text AS dismissed_at
      FROM "user_announcement_dismissals"
    `);
    assert.deepEqual(dismissals.rows, [{
      user_id: "11111111-1111-4111-8111-111111111111",
      announcement_id: "66666666-6666-4666-8666-666666666666",
      dismissed_at: "2026-07-24 04:00:00+00",
    }]);
  } finally {
    await client.close();
  }
});
