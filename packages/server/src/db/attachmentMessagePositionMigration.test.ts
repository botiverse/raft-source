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

test("0200 deterministically backfills linked attachment order while remaining rolling-writer compatible", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 199);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'attachment-migration@slock.test', 'attachment-migration', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Attachment migration', 'attachment-migration', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'attachment-migration');
      INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content")
      VALUES
        ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'user', '11111111-1111-4111-8111-111111111111', 'first'),
        ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', 'user', '11111111-1111-4111-8111-111111111111', 'second');
      INSERT INTO "attachments" (
        "id", "message_id", "channel_id", "uploader_id", "uploader_type",
        "filename", "mime_type", "size_bytes", "storage_key", "created_at"
      ) VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'a2.png', 'image/png', 1, 'a2.png', '2026-07-24T00:00:01.000Z'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'a1.png', 'image/png', 1, 'a1.png', '2026-07-24T00:00:01.000Z'),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'a3.png', 'image/png', 1, 'a3.png', '2026-07-24T00:00:00.000Z'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'b1.png', 'image/png', 1, 'b1.png', '2026-07-24T00:00:02.000Z'),
        ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', NULL, '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'user', 'unlinked.png', 'image/png', 1, 'unlinked.png', '2026-07-24T00:00:03.000Z');
    `);

    const migration = await readFile(path.join(DRIZZLE_DIR, "0200_youthful_radioactive_man.sql"), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const linked = await client.query<{
      id: string;
      message_id: string;
      message_position: number;
    }>(`
      SELECT "id", "message_id", "message_position"
      FROM "attachments"
      WHERE "message_id" IS NOT NULL
      ORDER BY "message_id", "message_position", "id"
    `);
    assert.deepEqual(linked.rows, [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", message_id: "44444444-4444-4444-8444-444444444444", message_position: 0 },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", message_id: "44444444-4444-4444-8444-444444444444", message_position: 1 },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", message_id: "44444444-4444-4444-8444-444444444444", message_position: 2 },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", message_id: "55555555-5555-4555-8555-555555555555", message_position: 0 },
    ]);

    const [unlinked] = (await client.query<{ message_position: number | null }>(`
      SELECT "message_position"
      FROM "attachments"
      WHERE "id" = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
    `)).rows;
    assert.equal(unlinked?.message_position, null);

    await client.exec(`
      INSERT INTO "attachments" (
        "id", "message_id", "channel_id", "uploader_id", "uploader_type",
        "filename", "mime_type", "size_bytes", "storage_key", "created_at"
      ) VALUES (
        'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        '55555555-5555-4555-8555-555555555555',
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        'user', 'legacy-after-migration.png', 'image/png', 1,
        'legacy-after-migration.png', '2026-07-24T00:00:04.000Z'
      )
    `);
    const [legacyWriterRow] = (await client.query<{ message_position: number | null }>(`
      SELECT "message_position"
      FROM "attachments"
      WHERE "id" = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
    `)).rows;
    assert.equal(
      legacyWriterRow?.message_position,
      null,
      "phase 1 must not add the linked-position check before old writers are gone",
    );
  } finally {
    await client.close();
  }
});
