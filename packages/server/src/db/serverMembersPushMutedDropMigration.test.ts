import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Unified notifications, contract step 2, server_members part (split out
// because server_members is replicated to RisingWave): server_members_push_muted_drop
// drops the server_members_push_mode_sync trigger, its function and
// server_push_muted. Found by tag suffix (numbers change on every renumber).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const SUFFIX = "_server_members_push_muted_drop";

type JournalEntry = { idx: number; tag: string };

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function journal(): Promise<{ entries: JournalEntry[]; entry: JournalEntry }> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(SUFFIX));
  assert.ok(entry, `${SUFFIX} is in the journal`);
  // After step 1 (whose release stopped naming the column) and the outbox part of step 2.
  for (const suffix of ["_notification_outbox_contract", "_notification_level_versions_backfill", "_notification_outbox_legacy_columns_drop"]) {
    const before = entries.find((candidate) => candidate.tag.endsWith(suffix));
    assert.ok(before && before.idx < entry.idx, suffix);
  }
  return { entries, entry };
}

async function apply(client: PGlite, entries: JournalEntry[], notices: string[] = []): Promise<void> {
  const onNotice = (notice: { message?: string }) => { if (notice.message) notices.push(notice.message); };
  for (const entry of entries) {
    await client.exec("BEGIN");
    try {
      for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"))) await client.exec(statement, { onNotice });
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw new Error(`${entry.tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function memberColumns(client: PGlite): Promise<string[]> {
  return (await client.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'server_members'
  `)).rows.map((row) => row.column_name);
}

const U1 = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";

async function beforeDrop(): Promise<{ client: PGlite; entry: JournalEntry }> {
  const { entries, entry } = await journal();
  const client = new PGlite();
  await apply(client, entries.filter((candidate) => candidate.idx < entry.idx));
  await client.exec(`
    INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'm1@slock.test', 'm1', 'x');
    INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Muted', 'push-muted-drop', '${U1}');
    INSERT INTO "server_members" ("server_id", "user_id", "role", "server_push_mode") VALUES ('${SERVER}', '${U1}', 'owner', 'none');
  `);
  return { client, entry };
}

test("server_members_push_muted_drop bounds its lock and statement time; no drop cascades or passes silently by IF EXISTS", async () => {
  const { entry } = await journal();
  const executable = statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
  assert.equal(executable[0], "SET LOCAL lock_timeout = '5s';");
  assert.equal(executable[1], "SET LOCAL statement_timeout = '30s';");
  for (const statement of executable) {
    assert.doesNotMatch(statement, /\bCASCADE\b|SET DATA TYPE|^UPDATE\b/i, statement);
    assert.doesNotMatch(statement, /DROP (TABLE|VIEW|INDEX|COLUMN|TRIGGER|FUNCTION) IF EXISTS/i, statement);
  }
  assert.doesNotMatch(executable.join("\n"), /notification_prefs_version/);
});

test("drops the trigger, its function and server_push_muted; server_push_mode and notification_prefs_version stay", async () => {
  const { client, entry } = await beforeDrop();
  try {
    assert.ok((await memberColumns(client)).includes("server_push_muted"));
    await apply(client, [entry]);
    const columns = await memberColumns(client);
    assert.equal(columns.includes("server_push_muted"), false);
    assert.ok(columns.includes("notification_prefs_version"), "the legacy counter stays");
    assert.deepEqual((await client.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'server_members_push_mode_sync'`)).rows, []);
    assert.deepEqual((await client.query(`SELECT proname FROM pg_proc WHERE proname = 'sync_server_member_push_mode'`)).rows, []);
    await client.exec(`UPDATE "server_members" SET "server_push_mode" = 'mentions' WHERE "user_id" = '${U1}'`);
    assert.deepEqual((await client.query(`SELECT "server_push_mode" FROM "server_members" WHERE "user_id" = '${U1}'`)).rows, [{ server_push_mode: "mentions" }]);
    await assert.rejects(client.exec(`UPDATE "server_members" SET "server_push_mode" = 'loud'`), /server_push_mode_valid/);
  } finally {
    await client.close();
  }
});

test("on a database that already lacks the trigger: a NOTICE, no error", async () => {
  const { client, entry } = await beforeDrop();
  const notices: string[] = [];
  try {
    await client.exec(`DROP TRIGGER "server_members_push_mode_sync" ON "server_members"`);
    await apply(client, [entry], notices);
    assert.ok(notices.some((message) => /trigger server_members_push_mode_sync does not exist/.test(message)), notices.join("\n"));
    assert.equal((await memberColumns(client)).includes("server_push_muted"), false);
  } finally {
    await client.close();
  }
});
