import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NOTIFICATION_NOT_VALID_CONSTRAINTS, NOTIFICATION_OUTBOX_EVENT_KEY_INDEX } from "./notificationOutboxIndexContract";
import { POST_MIGRATION_INDEXES } from "./postMigrationIndexes";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Unified notifications, expand step: mobile_push_outbox becomes
// notification_outbox (with a compatibility view for the older binaries of a
// rolling deploy), plus the account settings, channel levels, thread levels
// and phone device state. These tests apply the journal only up to the expand
// block, so they check the state an older binary saw during the rollout; the
// contract step that drops the view, the version / count columns and the old
// unique index is notificationContractMigration.test.ts.
const SERVER_ROOT = path.resolve(import.meta.dirname, "../..");
const DRIZZLE_DIR = path.join(SERVER_ROOT, "drizzle");
const SUFFIXES = [
  "_notification_outbox",
  "_user_notification_settings",
  "_user_channel_notification_prefs",
  "_thread_follows_notification_level",
  "_push_registrations_device_state",
] as const;

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function journal(): Promise<{ entries: JournalEntry[]; block: JournalEntry[] }> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;
  const block = SUFFIXES.map((suffix) => {
    const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
    assert.ok(entry, `${suffix} is in the journal`);
    return entry;
  });
  for (let i = 1; i < block.length; i += 1) assert.equal(block[i]!.idx, block[i - 1]!.idx + 1, "the five migrations are consecutive");
  return { entries, block };
}

async function migrationStatements(entry: JournalEntry): Promise<string[]> {
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

async function apply(client: PGlite, entries: JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of await migrationStatements(entry)) await client.exec(statement);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw new Error(`${entry.tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "11111111-1111-4111-8111-111111111112";
const U3 = "11111111-1111-4111-8111-111111111113";
const U4 = "11111111-1111-4111-8111-111111111114";
const SERVER = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const M1 = "44444444-4444-4444-8444-444444444441";
const M2 = "44444444-4444-4444-8444-444444444442";
const OLD_ROW = "55555555-5555-4555-8555-555555555551";

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
    ('${U1}', 'n1@slock.test', 'n1', 'x'), ('${U2}', 'n2@slock.test', 'n2', 'x'),
    ('${U3}', 'n3@slock.test', 'n3', 'x'), ('${U4}', 'n4@slock.test', 'n4', 'x');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Notif', 'notif-migration', '${U1}');
  INSERT INTO "channels" ("id", "server_id", "name") VALUES ('${CHANNEL}', '${SERVER}', 'notif');
  INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content") VALUES
    ('${M1}', '${CHANNEL}', 'user', '${U1}', 'one'), ('${M2}', '${CHANNEL}', 'user', '${U1}', 'two');
  INSERT INTO "mobile_push_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq", "activity_at", "status")
    VALUES ('${OLD_ROW}', 'user', '${U2}', '${SERVER}', 'channel', '${CHANNEL}', '${M1}', 1, now(), 'sent');
  -- Preview modes: U1 hidden + full -> hidden; U2 sender_only + full -> sender_only;
  -- U3 a revoked hidden + a live full -> full; U4 no registration -> no row.
  INSERT INTO "push_registrations" ("id", "installation_id", "provider", "user_id", "device_token", "topic", "env", "preview_mode", "revoked_at") VALUES
    (gen_random_uuid(), 'i-1a', 'apns', '${U1}', 't1a', 'ai.slock.app', 'production', 'hidden', NULL),
    (gen_random_uuid(), 'i-1b', 'fcm', '${U1}', 't1b', 'ai.slock.app', 'production', 'full', NULL),
    (gen_random_uuid(), 'i-2a', 'apns', '${U2}', 't2a', 'ai.slock.app', 'production', 'sender_only', NULL),
    (gen_random_uuid(), 'i-2b', 'apns', '${U2}', 't2b', 'ai.slock.app', 'production', 'full', NULL),
    (gen_random_uuid(), 'i-3a', 'apns', NULL, 't3a', 'ai.slock.app', 'production', 'hidden', now()),
    (gen_random_uuid(), 'i-3b', 'apns', '${U3}', 't3b', 'ai.slock.app', 'production', 'full', NULL);
`;

// What an older binary's drizzle insert sends: every column of its table
// definition, `default` for the ones it does not set.
function oldBinaryInsert(id: string, receiver: string, message: string): string {
  return `INSERT INTO "mobile_push_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq",
      "activity_at", "personal_mention", "unread_eligible", "status", "attempt_count", "attempted_count", "sent_count", "skipped_count",
      "revoked_count", "dropped_count", "last_error", "locked_at", "processed_at", "created_at", "updated_at")
    VALUES ('${id}', 'user', '${receiver}', '${SERVER}', 'channel', '${CHANNEL}', '${message}', 2, now(), false, true, default, default, default,
      default, default, default, default, default, default, default, default, now())
    ON CONFLICT ("receiver_type", "receiver_id", "source_channel_id", "message_id") DO NOTHING
    RETURNING "id"`;
}

test("each migration bounds its lock wait and never rewrites, scans or blocks on a large table", async () => {
  const { block } = await journal();
  for (const entry of block) {
    const executable = await migrationStatements(entry);
    assertBoundedLockTimeout(executable[0], `${entry.tag} sets a lock timeout first`);
    assert.equal(executable[1], "SET LOCAL statement_timeout = '30s';", `${entry.tag} bounds each statement`);
    for (const statement of executable) {
      // String literals (a NOTICE naming the CONCURRENTLY script) are not statements.
      assert.doesNotMatch(statement.replace(/'[^']*'/g, "''"), /\bUPDATE\s+"|\bVALIDATE CONSTRAINT\b|SET DATA TYPE|CONCURRENTLY/i, `${entry.tag}: ${statement}`);
    }
  }
  const outbox = (await migrationStatements(block[0]!)).join("\n");
  assert.match(outbox, /"mobile_push_outbox_status_check" CHECK [^;]* NOT VALID;/);
  assert.match(outbox, /ADD COLUMN "dispatcher_version" integer DEFAULT 1 NOT NULL;/);
  // The event-key index is built only when the table is small.
  const guarded = (await migrationStatements(block[0]!)).find((statement) => statement.includes(NOTIFICATION_OUTBOX_EVENT_KEY_INDEX.name))!;
  assert.match(guarded, /reltuples FROM pg_class WHERE oid = 'public\.notification_outbox'::regclass\) <= 100000/);
  assert.match((await migrationStatements(block[3]!)).join("\n"), /"thread_follows_notification_level_check"[^;]*NOT VALID;/);
  assert.match((await migrationStatements(block[4]!)).join("\n"), /"push_registrations_os_permission_check"[^;]*NOT VALID;/);
});

test("the create script, the post-migration catalog and db:migrate:deploy describe the same index", async () => {
  const spec = NOTIFICATION_OUTBOX_EVENT_KEY_INDEX;
  assert.match(spec.createSql, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_notification_outbox_receiver_event"/);
  assert.deepEqual(POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name), {
    name: spec.name,
    table: spec.table,
    columns: spec.columns,
    unique: spec.unique,
    predicate: spec.predicate,
    createScript: "db:create-notification-outbox-event-key-index",
  });
  // The other outbox entry follows the rename.
  assert.equal(POST_MIGRATION_INDEXES.find((entry) => entry.name === "idx_mobile_push_outbox_active_created")?.table, "notification_outbox");
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-notification-outbox-event-key-index"]!, /scripts\/create-notification-outbox-event-key-index\.ts$/);
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-notification-outbox-event-key-index.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
  // Every NOT VALID constraint of the block is validated by the script.
  const { block } = await journal();
  const notValid = new Set<string>();
  for (const entry of block) {
    for (const statement of await migrationStatements(entry)) {
      const match = statement.match(/ADD CONSTRAINT "(\w+)"[^;]*NOT VALID;/);
      if (match) notValid.add(match[1]!);
    }
  }
  assert.deepEqual([...notValid].sort(), NOTIFICATION_NOT_VALID_CONSTRAINTS.map((constraint) => constraint.name).sort());
});

test("after the rename an older binary still inserts, claims, updates and revokes through mobile_push_outbox; unified rows stay invisible to it", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
    await client.exec(SEED);
    await apply(client, block);

    const kinds = (await client.query<{ relname: string; relkind: string }>(`
      SELECT relname, relkind FROM pg_class WHERE relname IN ('notification_outbox', 'mobile_push_outbox') ORDER BY relname
    `)).rows;
    assert.deepEqual(kinds, [{ relname: "mobile_push_outbox", relkind: "v" }, { relname: "notification_outbox", relkind: "r" }]);
    const fks = (await client.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE conrelid = 'public.notification_outbox'::regclass AND contype = 'f' ORDER BY conname
    `)).rows.map((row) => row.conname);
    assert.deepEqual(fks, [
      "notification_outbox_message_id_messages_id_fk",
      "notification_outbox_receiver_id_users_id_fk",
      "notification_outbox_server_id_servers_id_fk",
      "notification_outbox_source_channel_id_channels_id_fk",
    ]);

    // The pre-migration row is a version 1 row, visible through the view.
    assert.deepEqual((await client.query(`SELECT "dispatcher_version", "event_key" FROM "notification_outbox" WHERE "id" = '${OLD_ROW}'`)).rows, [
      { dispatcher_version: 1, event_key: null },
    ]);

    // Insert through the view, with the old unique index as the conflict target.
    const inserted = await client.query<{ id: string }>(oldBinaryInsert("55555555-5555-4555-8555-555555555552", U3, M2));
    assert.deepEqual(inserted.rows, [{ id: "55555555-5555-4555-8555-555555555552" }]);
    const conflict = await client.query(oldBinaryInsert("55555555-5555-4555-8555-555555555553", U3, M2));
    assert.deepEqual(conflict.rows, [], "the second copy of the fact is a no-op");
    assert.deepEqual((await client.query(`SELECT "status", "dispatcher_version", "attempt_count" FROM "notification_outbox" WHERE "id" = '55555555-5555-4555-8555-555555555552'`)).rows, [
      { status: "pending", dispatcher_version: 1, attempt_count: 0 },
    ], "base defaults fill what the view insert left to default");

    // A unified (version 2) row, including one without a message.
    await client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq", "activity_at", "event_key", "category", "dispatcher_version")
        VALUES ('66666666-6666-4666-8666-666666666661', 'user', '${U4}', '${SERVER}', 'channel', '${CHANNEL}', '${M2}', 2, now(), 'message:${M2}', 'channel', 2);
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "activity_at", "event_key", "category", "payload", "dispatcher_version")
        VALUES ('66666666-6666-4666-8666-666666666662', 'user', '${U4}', '${SERVER}', now(), 'reminder:r1:2026-10-30T00:00:00Z', 'reminder', '{"text":"hi"}', 2);
    `);
    await assert.rejects(client.exec(`
      INSERT INTO "notification_outbox" ("receiver_type", "id", "receiver_id", "server_id", "activity_at", "event_key", "dispatcher_version")
        VALUES ('user', '66666666-6666-4666-8666-666666666663', '${U4}', '${SERVER}', now(), 'reminder:r1:2026-10-30T00:00:00Z', 2)
    `), /idx_notification_outbox_receiver_event/, "(receiver, event) is unique");
    const unified = await client.query(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "activity_at", "event_key", "dispatcher_version")
        VALUES ('66666666-6666-4666-8666-666666666664', 'user', '${U4}', '${SERVER}', now(), 'reminder:r1:2026-10-30T00:00:00Z', 2)
        ON CONFLICT ("receiver_id", "event_key") WHERE "event_key" IS NOT NULL DO NOTHING RETURNING "id"
    `);
    assert.deepEqual(unified.rows, [], "the unified enqueue's ON CONFLICT target resolves to the partial index");

    // The old drain: candidates, claim with SKIP LOCKED, terminal update; only version 1 rows.
    const candidates = await client.query<{ id: string }>(`
      SELECT "id" FROM "mobile_push_outbox" WHERE "status" = 'pending' ORDER BY "created_at" LIMIT 50 FOR UPDATE SKIP LOCKED
    `);
    assert.deepEqual(candidates.rows.map((row) => row.id), ["55555555-5555-4555-8555-555555555552"]);
    const claimed = await client.query(`
      UPDATE "mobile_push_outbox" SET "status" = 'processing', "locked_at" = now(), "attempt_count" = "attempt_count" + 1
       WHERE "id" = '55555555-5555-4555-8555-555555555552' AND "status" = 'pending' RETURNING "id"
    `);
    assert.equal(claimed.rows.length, 1);
    await client.exec(`UPDATE "mobile_push_outbox" SET "status" = 'sent', "sent_count" = 1, "processed_at" = now() WHERE "id" = '55555555-5555-4555-8555-555555555552'`);
    // The conversion / task-delete revoke never reaches a unified row.
    const revoked = await client.query(`
      UPDATE "mobile_push_outbox" SET "status" = 'revoked', "revoked_count" = "revoked_count" + 1
       WHERE "receiver_id" = '${U4}' AND "status" IN ('pending', 'processing') RETURNING "id"
    `);
    assert.deepEqual(revoked.rows, []);
    assert.deepEqual((await client.query(`SELECT count(*)::int AS n FROM "mobile_push_outbox"`)).rows, [{ n: 2 }]);
    assert.deepEqual((await client.query(`SELECT count(*)::int AS n FROM "notification_outbox"`)).rows, [{ n: 4 }]);

    // The widened status list holds for new writes; an unknown status does not.
    await client.exec(`UPDATE "notification_outbox" SET "status" = 'suppressed', "decision" = 'suppressed:server_none' WHERE "id" = '66666666-6666-4666-8666-666666666661'`);
    await assert.rejects(client.exec(`UPDATE "notification_outbox" SET "status" = 'bogus' WHERE "id" = '66666666-6666-4666-8666-666666666662'`), /mobile_push_outbox_status_check/);

    // What the index script does after the migrations: every NOT VALID constraint validates.
    for (const constraint of NOTIFICATION_NOT_VALID_CONSTRAINTS) {
      await client.exec(`ALTER TABLE "${constraint.table}" VALIDATE CONSTRAINT "${constraint.name}"`);
    }
    assert.deepEqual((await client.query(`
      SELECT count(*)::int AS n FROM pg_index WHERE indexrelid = 'public.idx_notification_outbox_receiver_event'::regclass AND indisvalid AND indisunique
    `)).rows, [{ n: 1 }], "built in the migration on a small table");
  } finally {
    await client.close();
  }
});

test("preview privacy becomes one account setting: the strictest live registration per user, no row without one", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
    await client.exec(SEED);
    await apply(client, block);
    const rows = (await client.query<{ user_id: string; preview_mode: string; version: number }>(`
      SELECT "user_id", "preview_mode", "version" FROM "user_notification_settings" ORDER BY "user_id"
    `)).rows;
    assert.deepEqual(rows, [
      { user_id: U1, preview_mode: "hidden", version: 1 },
      { user_id: U2, preview_mode: "sender_only", version: 1 },
      { user_id: U3, preview_mode: "full", version: 1 },
    ]);

    // Constraints of the new columns and tables.
    await assert.rejects(client.exec(`UPDATE "user_notification_settings" SET "quiet_start_minute" = 1440 WHERE "user_id" = '${U1}'`), /quiet_minutes_check/);
    await assert.rejects(client.exec(`INSERT INTO "user_channel_notification_prefs" ("user_id", "channel_id", "server_id", "level") VALUES ('${U1}', '${CHANNEL}', '${SERVER}', 'default')`), /level_check/);
    await client.exec(`INSERT INTO "user_channel_notification_prefs" ("user_id", "channel_id", "server_id", "level") VALUES ('${U1}', '${CHANNEL}', '${SERVER}', 'none')`);
    await assert.rejects(client.exec(`UPDATE "push_registrations" SET "os_permission" = 'maybe' WHERE "installation_id" = 'i-1a'`), /os_permission_check/);
    assert.deepEqual((await client.query(`SELECT "alerts_enabled", "os_permission", "last_registered_at" FROM "push_registrations" WHERE "installation_id" = 'i-1a'`)).rows, [
      { alerts_enabled: true, os_permission: null, last_registered_at: null },
    ]);
    await client.exec(`INSERT INTO "thread_follows" ("thread_channel_id", "follower_type", "follower_id", "parent_message_id", "reason", "notification_level") VALUES ('${CHANNEL}', 'user', '${U1}', '${M1}', 'manual', 'default')`);
    await assert.rejects(client.exec(`UPDATE "thread_follows" SET "notification_level" = 'loud'`), /notification_level_check/);
  } finally {
    await client.close();
  }
});
