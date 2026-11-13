import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  LEGACY_UNIQUE_INDEX_LOOKUP_SQL,
  NOTIFICATION_OUTBOX_FK_INDEXES,
  NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX,
} from "./notificationOutboxIndexContract";
import { POST_MIGRATION_INDEXES } from "./postMigrationIndexes";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Unified notifications, contract step 2 (after the release carrying step 1
// is the oldest image serving or available for rollback): notification_outbox
// gets (source_channel_id) and (receiver_id) indexes for the delete cascades,
// then loses the old unique key, dispatcher_version and the legacy *_count
// columns. server_members keeps server_push_muted and its sync trigger: it is
// replicated to RisingWave, and that drop waits for the RisingWave owner.
// Entries are found by tag suffix (numbers change on every renumber).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIXES = ["_notification_outbox_fk_indexes", "_notification_outbox_legacy_columns_drop"] as const;
// The most each may wait for its lock. The column drop locks notification_outbox ACCESS EXCLUSIVE:
// it waits less (#12960), so inserts queue less.
const MAX_LOCK_WAIT_MS: Record<(typeof SUFFIXES)[number], number> = {
  _notification_outbox_fk_indexes: 5_000,
  _notification_outbox_legacy_columns_drop: 2_000,
};
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
  for (let i = 1; i < block.length; i += 1) assert.equal(block[i]!.idx, block[i - 1]!.idx + 1, "the step 2 migrations are consecutive");
  // After step 1, whose release stopped naming the columns.
  for (const suffix of ["_notification_outbox_contract", "_native_notifications_drop", "_notification_level_versions_backfill"]) {
    const step1 = entries.find((entry) => entry.tag.endsWith(suffix));
    assert.ok(step1 && step1.idx < block[0]!.idx, suffix);
  }
  return { entries, block };
}

async function migrationStatements(entry: JournalEntry): Promise<string[]> {
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

async function apply(client: PGlite, entries: JournalEntry[], notices: string[] = []): Promise<void> {
  const onNotice = (notice: { message?: string }) => { if (notice.message) notices.push(notice.message); };
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of await migrationStatements(entry)) await client.exec(statement, { onNotice });
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw new Error(`${entry.tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function columnsOf(client: PGlite, table: string): Promise<string[]> {
  return (await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'
  `)).rows.map((row) => row.column_name);
}

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "11111111-1111-4111-8111-111111111112";
const SERVER = "22222222-2222-4222-8222-222222222222";
const ROW = "66666666-6666-4666-8666-666666666661";
const LEGACY = NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX.name;

const SEED = `
  INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
    ('${U1}', 's1@slock.test', 's1', 'x'), ('${U2}', 's2@slock.test', 's2', 'x');
  INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Step2', 'notif-step2', '${U1}');
  INSERT INTO "server_members" ("server_id", "user_id", "role", "server_push_mode", "notification_prefs_version") VALUES
    ('${SERVER}', '${U1}', 'owner', 'all', 3), ('${SERVER}', '${U2}', 'member', 'none', 0);
  INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category")
    VALUES ('${ROW}', 'user', '${U1}', '${SERVER}', 'channel', now(), 'message:x', 'channel');
`;

async function outboxIndexes(client: PGlite): Promise<string[]> {
  return (await client.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename = 'notification_outbox' ORDER BY indexname`)).rows.map((row) => row.indexname);
}

async function beforeStep2(): Promise<{ client: PGlite; block: JournalEntry[] }> {
  const { entries, block } = await journal();
  const client = new PGlite();
  await apply(client, entries.filter((entry) => entry.idx < block[0]!.idx));
  await client.exec(SEED);
  return { client, block };
}

test("each step 2 migration bounds its lock and statement time; no drop cascades or passes silently by IF EXISTS", async () => {
  const { block } = await journal();
  for (const entry of block) {
    const executable = await migrationStatements(entry);
    const suffix = SUFFIXES.find((candidate) => entry.tag.endsWith(candidate))!;
    assertBoundedLockTimeout(executable[0], `${entry.tag} sets a lock timeout first`, { maxMs: MAX_LOCK_WAIT_MS[suffix] });
    assert.equal(executable[1], "SET LOCAL statement_timeout = '30s';", `${entry.tag} sets a statement timeout`);
    for (const statement of executable) {
      assert.doesNotMatch(statement, /\bCASCADE\b|SET DATA TYPE|^UPDATE\b/i, `${entry.tag}: ${statement}`);
      assert.doesNotMatch(statement, /DROP (TABLE|VIEW|INDEX|COLUMN|TRIGGER|FUNCTION) IF EXISTS/i, `${entry.tag}: ${statement}`);
    }
    // notification_prefs_version stays: the step 1 release still reads it.
    assert.doesNotMatch(executable.join("\n"), /notification_prefs_version/);
  }
});

test("the FK indexes are in the post-migration index guard and their script runs after the migrations, before the guard", async () => {
  for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) {
    const listed = POST_MIGRATION_INDEXES.find((candidate) => candidate.name === spec.name);
    assert.ok(listed, spec.name);
    assert.deepEqual([listed!.table, [...listed!.columns], listed!.unique, listed!.predicate, listed!.createScript],
      [spec.table, [...spec.columns], spec.unique, spec.predicate, "db:create-notification-outbox-fk-indexes"]);
  }
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-notification-outbox-fk-indexes"]!, /scripts\/create-notification-outbox-fk-indexes\.ts$/);
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-notification-outbox-fk-indexes.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});

test("after step 2 on a small outbox: the FK indexes exist, the old key and legacy columns are gone, server_push_muted and its trigger stay", async () => {
  const { client, block } = await beforeStep2();
  try {
    assert.ok((await outboxIndexes(client)).includes(LEGACY), "step 1 kept the old key");
    await apply(client, block);

    const indexes = await outboxIndexes(client);
    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) assert.ok(indexes.includes(spec.name), spec.name);
    assert.equal(indexes.includes(LEGACY), false, "the old key is gone");
    assert.ok(indexes.includes("idx_notification_outbox_receiver_event"));
    assert.deepEqual((await client.query(LEGACY_UNIQUE_INDEX_LOOKUP_SQL)).rows, []);
    // The delete cascades find their rows through the new indexes.
    await client.exec(`SET enable_seqscan = off`);
    for (const [column, name] of [["source_channel_id", "idx_notification_outbox_source_channel"], ["receiver_id", "idx_notification_outbox_receiver"]] as const) {
      const plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT 1 FROM "notification_outbox" WHERE "${column}" = '${U1}'`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(plan, new RegExp(name), plan);
    }
    await client.exec(`RESET enable_seqscan`);

    const outboxColumns = await columnsOf(client, "notification_outbox");
    for (const column of LEGACY_OUTBOX_COLUMNS) assert.equal(outboxColumns.includes(column), false, `${column} is dropped`);
    assert.deepEqual((await client.query(`SELECT "status", "event_key" FROM "notification_outbox" WHERE "id" = '${ROW}'`)).rows, [{ status: "pending", event_key: "message:x" }]);
    await client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category")
        VALUES ('66666666-6666-4666-8666-666666666662', 'user', '${U2}', '${SERVER}', 'channel', now(), 'message:x', 'channel')
    `);
    await assert.rejects(client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category")
        VALUES ('66666666-6666-4666-8666-666666666663', 'user', '${U2}', '${SERVER}', 'channel', now(), 'message:x', 'channel')
    `), /idx_notification_outbox_receiver_event/, "the event key still dedupes");

    // server_members is untouched: server_push_muted (replicated to RisingWave
    // as rw_server_members) and the trigger keeping it in step both stay.
    const memberColumns = await columnsOf(client, "server_members");
    assert.ok(memberColumns.includes("server_push_muted"), "server_push_muted stays until the RisingWave owner confirms its drop");
    assert.ok(memberColumns.includes("notification_prefs_version"), "the legacy counter stays");
    assert.deepEqual((await client.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'server_members_push_mode_sync'`)).rows, [{ tgname: "server_members_push_mode_sync" }]);
    await client.exec(`UPDATE "server_members" SET "server_push_mode" = 'none' WHERE "user_id" = '${U1}'`);
    assert.deepEqual((await client.query(`SELECT "server_push_mode", "server_push_muted" FROM "server_members" WHERE "user_id" = '${U1}'`)).rows, [{ server_push_mode: "none", server_push_muted: true }]);
    await assert.rejects(client.exec(`UPDATE "server_members" SET "server_push_mode" = 'loud'`), /server_push_mode_valid/);
  } finally {
    await client.close();
  }
});

test("on a large outbox the migration leaves the indexes to the CONCURRENTLY script and keeps the old key", async () => {
  const { client, block } = await beforeStep2();
  const notices: string[] = [];
  try {
    await client.exec(`UPDATE pg_class SET reltuples = 7400000 WHERE oid = 'public.notification_outbox'::regclass`);
    await apply(client, [block[0]!], notices);
    const indexes = await outboxIndexes(client);
    assert.ok(indexes.includes(LEGACY), "the old key stays until the script has built the new ones");
    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) assert.equal(indexes.includes(spec.name), false, spec.name);
    assert.ok(notices.some((message) => /db:create-notification-outbox-fk-indexes/.test(message)), notices.join("\n"));
  } finally {
    await client.close();
  }
});

test("a never-analyzed outbox (reltuples -1) is sized by a bounded count: over 100k rows the migration leaves the indexes to the script", async () => {
  const { client, block } = await beforeStep2();
  const notices: string[] = [];
  try {
    await client.exec(`
      INSERT INTO "notification_outbox" ("id", "receiver_type", "receiver_id", "server_id", "kind", "activity_at", "event_key", "category")
        SELECT gen_random_uuid(), 'user', '${U2}', '${SERVER}', 'channel', now(), 'bulk:' || g, 'channel' FROM generate_series(1, 100001) AS g;
      UPDATE pg_class SET reltuples = -1 WHERE oid = 'public.notification_outbox'::regclass;
    `);
    await apply(client, [block[0]!], notices);
    const indexes = await outboxIndexes(client);
    assert.ok(indexes.includes(LEGACY), "the old key stays until the script has built the new ones");
    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) assert.equal(indexes.includes(spec.name), false, spec.name);
    assert.ok(notices.some((message) => /db:create-notification-outbox-fk-indexes/.test(message)), notices.join("\n"));
  } finally {
    await client.close();
  }
});

test("a never-analyzed small outbox (reltuples -1) is indexed in the migration", async () => {
  const { client, block } = await beforeStep2();
  try {
    await client.exec(`UPDATE pg_class SET reltuples = -1 WHERE oid = 'public.notification_outbox'::regclass`);
    await apply(client, [block[0]!]);
    const indexes = await outboxIndexes(client);
    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) assert.ok(indexes.includes(spec.name), spec.name);
    assert.equal(indexes.includes(LEGACY), false);
  } finally {
    await client.close();
  }
});

test("a hand-rebuilt copy of the old key under another name stops the migration instead of surviving silently", async () => {
  const { client, block } = await beforeStep2();
  try {
    await client.exec(`ALTER INDEX "${LEGACY}" RENAME TO "notification_outbox_unique_fact_rebuilt"`);
    await assert.rejects(apply(client, [block[0]!]), /under another name: notification_outbox_unique_fact_rebuilt/);
    const indexes = await outboxIndexes(client);
    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) assert.equal(indexes.includes(spec.name), false, "a refused migration changes nothing");
  } finally {
    await client.close();
  }
});

test("step 2 on a database that already lacks some of what it drops: NOTICEs, no error", async () => {
  const { client, block } = await beforeStep2();
  const notices: string[] = [];
  try {
    await client.exec(`
      DROP INDEX "${LEGACY}";
      ALTER TABLE "notification_outbox" DROP COLUMN "sent_count";
    `);
    await apply(client, block, notices);
    for (const expected of [/idx_mobile_push_outbox_unique_fact does not exist/, /notification_outbox\.sent_count does not exist/]) {
      assert.ok(notices.some((message) => expected.test(message)), `${expected}: ${notices.join("\n")}`);
    }
    for (const column of LEGACY_OUTBOX_COLUMNS) assert.equal((await columnsOf(client, "notification_outbox")).includes(column), false, column);
  } finally {
    await client.close();
  }
});
