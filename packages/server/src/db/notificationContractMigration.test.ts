import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Unified notifications, contract step 1 (v1.21.43, the expand release, runs
// beside it and is its rollback image): notification_outbox loses the
// mobile_push_outbox view, its older binaries' waiting rows are closed and
// dispatcher_version defaults to 2 (the old unique index stays: it serves the
// channels / users delete cascades until step 2 replaces it); RFC 052's
// native notification tables go; the legacy level counter is copied into
// user_notification_level_versions. The columns v1.21.43 still names stay
// (contract step 2 drops them). Entries are found by tag suffix (numbers
// change on every renumber).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIXES = ["_notification_outbox_contract", "_native_notifications_drop", "_notification_level_versions_backfill"] as const;
const RFC_052_TABLES = [
  "native_notification_events",
  "native_notification_credentials",
  "native_notification_devices",
  "native_notification_enrollment_grants",
];
const LEGACY_OUTBOX_COLUMNS = ["dispatcher_version", "attempted_count", "sent_count", "skipped_count", "revoked_count", "dropped_count"];

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
  for (let i = 1; i < block.length; i += 1) assert.equal(block[i]!.idx, block[i - 1]!.idx + 1, "the three migrations are consecutive");
  // After the expand step it cleans up, including #12187's counter table.
  for (const suffix of ["_push_registrations_device_state", "_notification_level_versions"]) {
    const expand = entries.find((entry) => entry.tag.endsWith(suffix));
    assert.ok(expand && expand.idx < block[0]!.idx, suffix);
  }
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
const SERVER = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const M1 = "44444444-4444-4444-8444-444444444441";
const M2 = "44444444-4444-4444-8444-444444444442";
const V1_PENDING = "55555555-5555-4555-8555-555555555551";
const V1_PROCESSING = "55555555-5555-4555-8555-555555555552";
const V1_SENT = "55555555-5555-4555-8555-555555555553";
const V2_PENDING = "66666666-6666-4666-8666-666666666661";

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
    ('${U1}', 'c1@slock.test', 'c1', 'x'), ('${U2}', 'c2@slock.test', 'c2', 'x');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Contract', 'notif-contract', '${U1}');
  INSERT INTO "server_members" ("server_id", "user_id", "role", "server_push_mode") VALUES
    ('${SERVER}', '${U1}', 'owner', 'all'), ('${SERVER}', '${U2}', 'member', 'none');
  INSERT INTO "channels" ("id", "server_id", "name") VALUES ('${CHANNEL}', '${SERVER}', 'contract');
  INSERT INTO "messages" ("id", "channel_id", "sender_type", "sender_id", "content") VALUES
    ('${M1}', '${CHANNEL}', 'user', '${U1}', 'one'), ('${M2}', '${CHANNEL}', 'user', '${U1}', 'two');
  -- What an older binary left behind through the compatibility view (version 1).
  INSERT INTO "mobile_push_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq", "activity_at", "status", "locked_at") VALUES
    ('${V1_PENDING}', 'user', '${U2}', '${SERVER}', 'channel', '${CHANNEL}', '${M1}', 1, now(), 'pending', NULL),
    ('${V1_PROCESSING}', 'user', '${U2}', '${SERVER}', 'channel', '${CHANNEL}', '${M2}', 2, now(), 'processing', now()),
    ('${V1_SENT}', 'user', '${U1}', '${SERVER}', 'channel', '${CHANNEL}', '${M1}', 1, now(), 'sent', NULL);
  -- A unified row the dispatcher has not claimed yet.
  INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq", "activity_at", "event_key", "category", "dispatcher_version") VALUES
    ('${V2_PENDING}', 'user', '${U1}', '${SERVER}', 'channel', '${CHANNEL}', '${M2}', 2, now(), 'message:${M2}', 'channel', 2);
`;

async function columnsOf(client: PGlite, table: string): Promise<string[]> {
  return (await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'
  `)).rows.map((row) => row.column_name);
}

test("each contract migration bounds its lock and statement time; nothing rewrites a table, drops a column or cascades", async () => {
  const { block } = await journal();
  for (const entry of block) {
    const executable = await migrationStatements(entry);
    assert.match(executable[0]!, /^SET LOCAL lock_timeout = '[1-5]s';$/, `${entry.tag} sets a lock timeout first`);
    assert.equal(executable[1], "SET LOCAL statement_timeout = '30s';", `${entry.tag} sets a statement timeout`);
    for (const statement of executable) {
      // v1.21.43 still names every column; step 1 drops none.
      assert.doesNotMatch(statement, /DROP COLUMN|DROP TRIGGER|DROP FUNCTION|DROP INDEX/i, `${entry.tag}: ${statement}`);
      // A drop by name says when there is nothing to drop (a NOTICE) instead of passing silently.
      assert.doesNotMatch(statement, /DROP (VIEW|TABLE) IF EXISTS/i, `${entry.tag}: ${statement}`);
      // String literals (a RAISE naming the CONCURRENTLY script) are not statements.
      assert.doesNotMatch(statement.replace(/'[^']*'/g, "''"), /\bCASCADE\b|SET DATA TYPE|CONCURRENTLY|VACUUM/i, `${entry.tag}: ${statement}`);
    }
  }
  // The one UPDATE touches only active version 1 rows (the partial active index's predicate).
  const updates = (await migrationStatements(block[0]!)).filter((statement) => /^UPDATE\b/.test(statement));
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /WHERE "status" IN \('pending', 'processing'\)\s+AND "dispatcher_version" = 1;/);
});

test("the outbox contract refuses to drop the old dedupe key while the event-key index is missing or invalid", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
    await client.exec(`DROP INDEX "idx_notification_outbox_receiver_event"`);
    await assert.rejects(apply(client, [block[0]!]), /idx_notification_outbox_receiver_event is missing or invalid/);
    await client.exec(`CREATE UNIQUE INDEX "idx_notification_outbox_receiver_event" ON "notification_outbox" ("receiver_id", "event_key") WHERE "event_key" IS NOT NULL`);
    await client.exec(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.idx_notification_outbox_receiver_event'::regclass`);
    await assert.rejects(apply(client, [block[0]!]), /missing or invalid/);
    assert.equal((await columnsOf(client, "notification_outbox")).includes("dispatcher_version"), true, "a refused migration changes nothing");
  } finally {
    await client.close();
  }
});

test("after step 1: version 1 active rows are terminal, the view, old index and RFC 052 tables are gone, v1.21.43's columns still work", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
    await client.exec(SEED);
    assert.deepEqual((await client.query(`SELECT "server_push_muted" FROM "server_members" WHERE "user_id" = '${U2}'`)).rows, [{ server_push_muted: true }], "the trigger ran before");
    await apply(client, block);

    // Outbox.
    const rows = (await client.query<{ id: string; status: string; decision: string | null; locked_at: unknown; processed_at: unknown }>(`
      SELECT "id", "status", "decision", "locked_at", "processed_at" FROM "notification_outbox" ORDER BY "id"
    `)).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [V1_PENDING, V1_PROCESSING]) {
      const row = byId.get(id)!;
      assert.deepEqual([row.status, row.decision, row.locked_at], ["skipped", "suppressed:stale", null], id);
      assert.ok(row.processed_at, "terminal rows carry processed_at");
    }
    assert.equal(byId.get(V1_SENT)?.status, "sent", "terminal rows are left as they are");
    assert.deepEqual([byId.get(V2_PENDING)?.status, byId.get(V2_PENDING)?.decision], ["pending", null], "unified rows are untouched");

    assert.deepEqual((await client.query(`SELECT to_regclass('public.mobile_push_outbox') AS rel`)).rows, [{ rel: null }], "the view is gone");
    const indexes = (await client.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'notification_outbox' ORDER BY indexname`)).rows.map((row) => row.indexname);
    assert.ok(indexes.includes("idx_mobile_push_outbox_unique_fact"), "the old unique index stays until step 2 (the delete cascades use it)");
    assert.ok(indexes.includes("idx_notification_outbox_receiver_event"));
    assert.ok(indexes.includes("idx_mobile_push_outbox_active_created"));
    // A retried unified row conflicts on (receiver, event).
    await assert.rejects(client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "activity_at", "event_key")
        VALUES ('66666666-6666-4666-8666-666666666662', 'user', '${U1}', '${SERVER}', now(), 'message:${M2}')
    `), /idx_notification_outbox_receiver_event/);

    // The columns v1.21.43 names stay: its insert (every declared column) and
    // its dispatcher's update still work; this release's insert (none of
    // them) gets dispatcher_version 2, a unified row to v1.21.43's dispatcher.
    const columns = await columnsOf(client, "notification_outbox");
    for (const column of LEGACY_OUTBOX_COLUMNS) assert.ok(columns.includes(column), `${column} stays until step 2`);
    await client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category", "dispatcher_version", "attempted_count", "sent_count", "skipped_count", "revoked_count", "dropped_count")
        VALUES ('66666666-6666-4666-8666-666666666663', 'user', '${U2}', '${SERVER}', 'channel', now(), 'message:${M1}', 'channel', 2, 0, 0, 0, 0, 0)
    `);
    await client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category")
        VALUES ('66666666-6666-4666-8666-666666666664', 'user', '${U1}', '${SERVER}', 'channel', now(), 'message:${M1}', 'channel')
    `);
    assert.deepEqual((await client.query(`SELECT "dispatcher_version" FROM "notification_outbox" WHERE "id" = '66666666-6666-4666-8666-666666666664'`)).rows, [{ dispatcher_version: 2 }]);
    await client.exec(`UPDATE "notification_outbox" SET "status" = 'dropped' WHERE "id" = '${V1_SENT}'`);

    // server_members: the boolean and its trigger stay; a mode-only write
    // (this release) keeps it in step for v1.21.43.
    assert.ok((await columnsOf(client, "server_members")).includes("server_push_muted"));
    await client.exec(`UPDATE "server_members" SET "server_push_mode" = 'mentions' WHERE "user_id" = '${U2}'`);
    assert.deepEqual((await client.query(`SELECT "server_push_mode", "server_push_muted" FROM "server_members" WHERE "user_id" = '${U2}'`)).rows, [{ server_push_mode: "mentions", server_push_muted: false }]);
    await client.exec(`UPDATE "server_members" SET "server_push_mode" = 'none' WHERE "user_id" = '${U1}'`);
    assert.deepEqual((await client.query(`SELECT "server_push_muted" FROM "server_members" WHERE "user_id" = '${U1}'`)).rows, [{ server_push_muted: true }]);

    // RFC 052.
    for (const table of RFC_052_TABLES) {
      assert.deepEqual((await client.query(`SELECT to_regclass('public.${table}') AS rel`)).rows, [{ rel: null }], `${table} is gone`);
    }
    assert.deepEqual((await client.query(`SELECT to_regclass('public.native_notification_events_stream_seq_seq') AS rel`)).rows, [{ rel: null }], "its sequence went with it");
  } finally {
    await client.close();
  }
});

test("the native table drop takes every lock in one statement, users last, under a short lock_timeout", async () => {
  const { block } = await journal();
  const sqlText = await readFile(path.join(DRIZZLE_DIR, `${block[1]!.tag}.sql`), "utf8");
  const executable = await migrationStatements(block[1]!);
  assert.equal(executable[0], "SET LOCAL lock_timeout = '2s';");
  const lock = sqlText.match(/'LOCK TABLE '[\s\S]*?IN ACCESS EXCLUSIVE MODE'/)?.[0];
  assert.ok(lock, "one LOCK TABLE");
  assert.match(lock!, /"session_families", "servers", "users" IN ACCESS EXCLUSIVE MODE'$/);
  assert.ok(sqlText.indexOf("'LOCK TABLE '") < sqlText.indexOf("DROP TABLE"), "the locks come before the first drop");
});

test("step 1 on a database that already lacks the view and some native tables: NOTICEs, no error", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  const notices: string[] = [];
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
    await client.exec(`DROP VIEW "mobile_push_outbox"; DROP TABLE "native_notification_events"; DROP TABLE "native_notification_credentials"`);
    const exec = client.exec.bind(client);
    client.exec = (async (query: string, options?: Parameters<PGlite["exec"]>[1]) => exec(query, {
      ...options,
      onNotice: (notice: { message?: string }) => { if (notice.message) notices.push(notice.message); },
    })) as PGlite["exec"];
    await apply(client, block);
    for (const table of RFC_052_TABLES) {
      assert.deepEqual((await client.query(`SELECT to_regclass('public.${table}') AS rel`)).rows, [{ rel: null }], `${table} is gone`);
    }
    assert.ok(notices.some((message) => /mobile_push_outbox does not exist/.test(message)), notices.join("\n"));
    assert.ok(notices.some((message) => /native_notification_events does not exist/.test(message)), notices.join("\n"));
  } finally {
    await client.close();
  }
});

test("the backfill lifts every level counter to at least the legacy column, and running it again changes nothing", async () => {
  const { entries, block } = await journal();
  const client = new PGlite();
  const U3 = "11111111-1111-4111-8111-111111111113";
  const OTHER = "22222222-2222-4222-8222-222222222223";
  try {
    await apply(client, entries.filter((entry) => entry.idx < block[2]!.idx));
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
        ('${U1}', 'b1@slock.test', 'b1', 'x'), ('${U2}', 'b2@slock.test', 'b2', 'x'), ('${U3}', 'b3@slock.test', 'b3', 'x');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES
        ('${SERVER}', 'Backfill', 'notif-backfill', '${U1}'), ('${OTHER}', 'Other', 'notif-backfill-2', '${U1}');
      INSERT INTO "server_members" ("server_id", "user_id", "role", "notification_prefs_version") VALUES
        ('${SERVER}', '${U1}', 'owner', 7),   -- no counter row yet
        ('${SERVER}', '${U2}', 'member', 9),  -- counter behind the column
        ('${SERVER}', '${U3}', 'member', 4),  -- counter ahead of the column
        ('${OTHER}', '${U1}', 'owner', 0);    -- never changed: no row
      INSERT INTO "user_notification_level_versions" ("user_id", "server_id", "version") VALUES
        ('${U2}', '${SERVER}', 3), ('${U3}', '${SERVER}', 12);
    `);
    const counters = async () => (await client.query<{ user_id: string; server_id: string; version: number }>(`
      SELECT "user_id", "server_id", "version" FROM "user_notification_level_versions" ORDER BY "user_id", "server_id"
    `)).rows;
    await apply(client, [block[2]!]);
    const expected = [
      { user_id: U1, server_id: SERVER, version: 7 },
      { user_id: U2, server_id: SERVER, version: 9 },
      { user_id: U3, server_id: SERVER, version: 12 },
    ];
    assert.deepEqual(await counters(), expected);
    const [{ updated_at: before }] = (await client.query<{ updated_at: unknown }>(`SELECT "updated_at" FROM "user_notification_level_versions" WHERE "user_id" = '${U3}'`)).rows as [{ updated_at: unknown }];
    await apply(client, [block[2]!]);
    assert.deepEqual(await counters(), expected, "idempotent");
    assert.deepEqual((await client.query(`SELECT "updated_at" FROM "user_notification_level_versions" WHERE "user_id" = '${U3}'`)).rows, [{ updated_at: before }], "a counter at or above the column is not touched");
  } finally {
    await client.close();
  }
});
