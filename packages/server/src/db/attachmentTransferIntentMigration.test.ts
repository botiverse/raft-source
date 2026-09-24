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

test("0230 gives every in-flight direct PUT a durable owner and original-key cleanup plan", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 229);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'transfer-migration@slock.test', 'transfer-migration', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Transfer migration', 'transfer-migration', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'transfer-migration');

      INSERT INTO "attachment_upload_sessions" (
        "id", "server_id", "channel_id", "uploader_id", "uploader_type",
        "attachment_id", "client_request_id", "filename", "mime_type",
        "declared_size_bytes", "storage_key", "quota_month",
        "quota_reserved_bytes", "quota_limited", "expires_at"
      ) VALUES (
        '44444444-4444-4444-8444-444444444444',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        'user',
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
        'pending.txt',
        'text/plain',
        42,
        'attachments/pending/transfer-migration',
        '2026-08',
        42,
        false,
        '2026-08-12T00:15:00.000Z'
      );
    `);

    const migration = await readFile(path.join(DRIZZLE_DIR, "0230_uneven_makkari.sql"), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const [session] = (await client.query<{
      id: string;
      attachment_id: string;
      object_id: string | null;
      transfer_intent_id: string | null;
    }>(`
      SELECT "id", "attachment_id", "object_id", "transfer_intent_id"
      FROM "attachment_upload_sessions"
      WHERE "id" = '44444444-4444-4444-8444-444444444444'
    `)).rows;
    assert.equal(session?.transfer_intent_id, session?.id);
    assert.ok(session?.object_id);

    const [intent] = (await client.query<{
      id: string;
      reservation_id: string;
      object_id: string;
      state: string;
    }>(`
      SELECT "id", "reservation_id", "object_id", "state"
      FROM "attachment_transfer_intents"
      WHERE "id" = '44444444-4444-4444-8444-444444444444'
    `)).rows;
    assert.deepEqual(intent, {
      id: session?.id,
      reservation_id: session?.attachment_id,
      object_id: session?.object_id,
      state: "planned",
    });

    const [artifact] = (await client.query<{
      role: string;
      backend: string;
      storage_key: string;
      state: string;
    }>(`
      SELECT "role", "backend", "storage_key", "state"
      FROM "attachment_transfer_artifacts"
      WHERE "intent_id" = '44444444-4444-4444-8444-444444444444'
    `)).rows;
    assert.deepEqual(artifact, {
      role: "original",
      backend: "attachment",
      storage_key: "attachments/pending/transfer-migration",
      state: "planned",
    });

    await assert.rejects(
      client.exec(`
        UPDATE "attachment_upload_sessions"
        SET "transfer_intent_id" = '77777777-7777-4777-8777-777777777777'
        WHERE "id" = '44444444-4444-4444-8444-444444444444'
      `),
      /foreign key|constraint/i,
    );
  } finally {
    await client.close();
  }
});
