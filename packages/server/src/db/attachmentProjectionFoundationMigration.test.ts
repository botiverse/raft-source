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

test("0222 adds the inert attachment object/projection foundation without breaking legacy writers", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 222);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'projection-foundation@slock.test', 'projection-foundation', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Projection foundation', 'projection-foundation', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'projection-foundation');

      INSERT INTO "attachments" (
        "id", "channel_id", "uploader_id", "uploader_type", "filename",
        "mime_type", "size_bytes", "storage_key"
      ) VALUES (
        '44444444-4444-4444-8444-444444444444',
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        'user', 'legacy.txt', 'text/plain', 6, 'legacy.txt'
      );
    `);

    const [legacy] = (await client.query<{
      object_id: string | null;
      pending_channel_id: string | null;
      created_by_id: string | null;
    }>(`
      SELECT "object_id", "pending_channel_id", "created_by_id"
      FROM "attachments"
      WHERE "id" = '44444444-4444-4444-8444-444444444444'
    `)).rows;
    assert.deepEqual(legacy, {
      object_id: null,
      pending_channel_id: null,
      created_by_id: null,
    });
  } finally {
    await client.close();
  }
});

test("0222 keeps object bytes, projection placement, and revocation audit as separate lifecycles", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 222);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'projection-lifecycle@slock.test', 'projection-lifecycle', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Projection lifecycle', 'projection-lifecycle', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'projection-lifecycle');
      INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content")
      VALUES ('44444444-4444-4444-8444-444444444444', '33333333-3333-4333-8333-333333333333', 'user', '11111111-1111-4111-8111-111111111111', 'host');

      INSERT INTO "attachment_objects" (
        "id", "origin_server_id", "uploader_id", "uploader_type", "storage_key",
        "mime_type", "size_bytes"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'user', 'shared.txt', 'text/plain', 6
      );
      INSERT INTO "attachment_object_charges" (
        "object_id", "origin_server_id", "charge_month", "size_bytes"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '2026-07-01', 6
      );
      INSERT INTO "attachments" (
        "id", "object_id", "message_id", "channel_id", "uploader_id",
        "uploader_type", "created_by_id", "created_by_type", "filename",
        "mime_type", "size_bytes", "storage_key"
      ) VALUES (
        '66666666-6666-4666-8666-666666666666',
        '55555555-5555-4555-8555-555555555555',
        '44444444-4444-4444-8444-444444444444',
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111',
        'user', '11111111-1111-4111-8111-111111111111', 'user',
        'shared.txt', 'text/plain', 6, 'shared.txt'
      );
      INSERT INTO "attachment_projection_revocations" (
        "projection_id", "object_id", "host_message_id", "request_server_id",
        "revoked_by_id", "revoked_by_type", "reason", "revoked_at"
      ) VALUES (
        '66666666-6666-4666-8666-666666666666',
        '55555555-5555-4555-8555-555555555555',
        '44444444-4444-4444-8444-444444444444',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'user', 'test revoke', now()
      );

      DELETE FROM "messages"
      WHERE "id" = '44444444-4444-4444-8444-444444444444';
    `);

    const projectionCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count" FROM "attachments"
      WHERE "id" = '66666666-6666-4666-8666-666666666666'
    `);
    const objectCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count" FROM "attachment_objects"
      WHERE "id" = '55555555-5555-4555-8555-555555555555'
    `);
    const auditCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count" FROM "attachment_projection_revocations"
      WHERE "projection_id" = '66666666-6666-4666-8666-666666666666'
    `);

    assert.equal(projectionCount.rows[0]?.count, 0, "host-message deletion should remove its projection");
    assert.equal(objectCount.rows[0]?.count, 1, "projection deletion must not cascade into stored bytes");
    assert.equal(auditCount.rows[0]?.count, 1, "revocation audit must survive projection deletion");
    await assert.rejects(
      client.exec(`
        DELETE FROM "attachment_objects"
        WHERE "id" = '55555555-5555-4555-8555-555555555555'
      `),
      /foreign key|constraint/i,
      "an immutable charge must restrict physical object deletion",
    );
  } finally {
    await client.close();
  }
});

test("0222 restricts deleting an object while a live projection references it", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 222);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'live-projection@slock.test', 'live-projection', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Live projection', 'live-projection', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "channels" ("id", "server_id", "name")
      VALUES ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'live-projection');
      INSERT INTO "attachment_objects" (
        "id", "origin_server_id", "uploader_id", "uploader_type", "storage_key",
        "mime_type", "size_bytes"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'user', 'live.txt', 'text/plain', 4
      );
      INSERT INTO "attachments" (
        "id", "object_id", "channel_id", "uploader_id", "uploader_type",
        "created_by_id", "created_by_type", "filename", "mime_type",
        "size_bytes", "storage_key"
      ) VALUES (
        '66666666-6666-4666-8666-666666666666',
        '55555555-5555-4555-8555-555555555555',
        '33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111111', 'user',
        '11111111-1111-4111-8111-111111111111', 'user',
        'live.txt', 'text/plain', 4, 'live.txt'
      );
    `);

    await assert.rejects(
      client.exec(`
        DELETE FROM "attachment_objects"
        WHERE "id" = '55555555-5555-4555-8555-555555555555'
      `),
      /foreign key|constraint/i,
      "a live projection must restrict physical object deletion without relying on a charge row",
    );

    await client.exec(`
      DELETE FROM "attachments"
      WHERE "id" = '66666666-6666-4666-8666-666666666666';
      DELETE FROM "attachment_objects"
      WHERE "id" = '55555555-5555-4555-8555-555555555555';
    `);
    const objectCount = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count" FROM "attachment_objects"
      WHERE "id" = '55555555-5555-4555-8555-555555555555'
    `);
    assert.equal(
      objectCount.rows[0]?.count,
      0,
      "the projection FK should stop blocking after projection deletion",
    );
  } finally {
    await client.close();
  }
});

test("0222 leaves origin attribution independent from a live server row", async () => {
  const client = new PGlite();
  try {
    await applyThrough(client, 222);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash")
      VALUES ('11111111-1111-4111-8111-111111111111', 'origin-snapshot@slock.test', 'origin-snapshot', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id")
      VALUES ('22222222-2222-4222-8222-222222222222', 'Origin snapshot', 'origin-snapshot', '11111111-1111-4111-8111-111111111111');
      INSERT INTO "attachment_objects" (
        "id", "origin_server_id", "uploader_id", "uploader_type", "storage_key",
        "mime_type", "size_bytes"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'user', 'retained.txt', 'text/plain', 8
      );
      INSERT INTO "attachment_object_charges" (
        "object_id", "origin_server_id", "charge_month", "size_bytes"
      ) VALUES (
        '55555555-5555-4555-8555-555555555555',
        '22222222-2222-4222-8222-222222222222',
        '2026-07-01', 8
      );

      DELETE FROM "servers"
      WHERE "id" = '22222222-2222-4222-8222-222222222222';
    `);

    const [object] = (await client.query<{ origin_server_id: string }>(`
      SELECT "origin_server_id" FROM "attachment_objects"
      WHERE "id" = '55555555-5555-4555-8555-555555555555'
    `)).rows;
    assert.equal(object?.origin_server_id, "22222222-2222-4222-8222-222222222222");
    const [charge] = (await client.query<{ origin_server_id: string }>(`
      SELECT "origin_server_id" FROM "attachment_object_charges"
      WHERE "object_id" = '55555555-5555-4555-8555-555555555555'
    `)).rows;
    assert.equal(charge?.origin_server_id, "22222222-2222-4222-8222-222222222222");
  } finally {
    await client.close();
  }
});
