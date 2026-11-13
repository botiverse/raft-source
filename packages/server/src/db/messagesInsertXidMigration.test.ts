import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, getTableColumns, sql } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "./index";
import { messages } from "./schema";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "./postMigrationIndexes";
import {
  assertInsertXidIndexReady,
  CREATE_INSERT_XID_INDEX_SQL,
  INSERT_XID_INDEX_COLUMNS,
  INSERT_XID_INDEX_NAME,
  INSERT_XID_INDEX_PREDICATE,
} from "../../scripts/messages-insert-xid-index";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Sync horizon (services/syncHorizon.ts): messages.insert_xid. messages is
// large and on every send path, so the migration is metadata-only under its
// ACCESS EXCLUSIVE lock (nullable column, no default, a trigger) and the
// partial index is built CONCURRENTLY by db:create-messages-insert-xid-index
// inside db:migrate:deploy, then checked by the post-migration index guard.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** By name, not number: the number moves when staging lands migrations first. */
async function readMigrationByName(name: string) {
  const file = (await readdir(path.join(SERVER_ROOT, "drizzle"))).find((entry) => new RegExp(`^\\d{4}_${name}\\.sql$`).test(entry));
  assert.ok(file, `the ${name} migration exists`);
  return { file, sql: await readFile(path.join(SERVER_ROOT, "drizzle", file), "utf8") };
}

/** The SQL statements, comments stripped (prose may name what the code must not do). */
function sqlStatements(migration: string): string[] {
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

test("the messages_insert_xid migration is metadata-only on messages: bounded lock wait, nullable column, trigger, no index build", async () => {
  const { sql: migration } = await readMigrationByName("messages_insert_xid");
  const statements = sqlStatements(migration);
  assertBoundedLockTimeout(statements[0]);
  assert.equal(statements[1], "SET LOCAL statement_timeout = '30s';");
  assert.equal(statements[2], `ALTER TABLE "messages" ADD COLUMN "insert_xid" "xid8";`, "nullable, no default: no rewrite, no scan");
  const code = statements.join("\n");
  assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX/, "the index is built CONCURRENTLY after the migration");
  assert.doesNotMatch(code, /\bUPDATE\s+"?(public\.)?"?messages"?/i, "no backfill: old rows stay NULL");
  assert.doesNotMatch(code, /NOT NULL|DEFAULT/i);
  assert.match(code, /NEW\.insert_xid := pg_current_xact_id\(\);/, "always overwritten, whatever the writer supplied");
  assert.doesNotMatch(code, /IF NEW\.insert_xid IS NULL/);
  assert.match(code, /CREATE TRIGGER messages_set_insert_xid\s+BEFORE INSERT ON public\.messages\s+FOR EACH ROW EXECUTE FUNCTION public\.messages_set_insert_xid\(\);/);
  // One table: no other relation's lock is taken in this phase.
  const touched = new Set([...code.matchAll(/(?:ALTER TABLE|\bON) "?(?:public\.)?"?(\w+)"?/g)].map((match) => match[1]));
  assert.deepEqual([...touched], ["messages"]);
});

test("insert_xid stays out of the drizzle table and its snapshot: no ORM read can fetch it, no generate drops it", async () => {
  // Structural leak guard: `select().from(messages)`, `returning()` and
  // getTableColumns(messages) select only declared columns, so the inserting
  // transaction id cannot reach a client, agent, webhook, export or log
  // through a message row.
  assert.equal(Object.values(getTableColumns(messages)).some((column) => column.name === "insert_xid"), false);
  assert.equal("insertXid" in getTableColumns(messages), false);
  // drizzle-kit diffs schema.ts against the latest snapshot: neither lists it,
  // so a later generate emits no DROP for the column or its index.
  const journal = JSON.parse(await readFile(path.join(SERVER_ROOT, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number }[] };
  const last = String(journal.entries.at(-1)!.idx).padStart(4, "0");
  const snapshot = await readFile(path.join(SERVER_ROOT, "drizzle", "meta", `${last}_snapshot.json`), "utf8");
  assert.doesNotMatch(snapshot, /insert_xid/);

  // The only source that names the column: the sync statement and its
  // contract (services), the index lifecycle (db, scripts), and tests. Each
  // reader only filters on it inside SQL and never selects it, so no row it
  // returns carries the id; one that changes the column's meaning (the
  // trigger, NULL for old rows) must update every reader listed here.
  const allowed = new Set([
    "src/services/messageService.ts",
    "src/services/syncHorizon.ts",
    // /events late rows (#11921): `NOT pg_visible_in_snapshot(insert_xid, <pull snapshot>)`
    // over a skip record's seq range; selects seq and created_at only, and
    // relies on the trigger's pg_current_xact_id() and NULL for old rows.
    "src/services/agentInboxLateRows.ts",
    "src/db/postMigrationIndexes.ts",
    "src/db/pgliteMigrations.ts",
    "src/db/schema.ts",
    "scripts/messages-insert-xid-index.ts",
    "scripts/create-messages-insert-xid-index.ts",
  ]);
  const offenders: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(SERVER_ROOT, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") await walk(child);
      } else if (/\.ts$/.test(entry.name) && !/\.(test|realPg\.test)\.ts$/.test(entry.name) && !child.startsWith("src/test/")) {
        const text = await readFile(path.join(SERVER_ROOT, child), "utf8");
        if (/insert_xid|insertXid/.test(text) && !allowed.has(child)) offenders.push(child);
      }
    }
  };
  await walk("src");
  await walk("scripts");
  assert.deepEqual(offenders, [], "insert_xid is read only by the sync horizon");
});

test("the create script, the post-migration catalog and db:migrate:deploy describe the same index", async () => {
  assert.match(CREATE_INSERT_XID_INDEX_SQL, /CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_messages_insert_xid"\s+ON "messages" USING btree \("insert_xid"\)\s+WHERE insert_xid IS NOT NULL/);
  const catalog = POST_MIGRATION_INDEXES.find((spec) => spec.name === INSERT_XID_INDEX_NAME);
  assert.ok(catalog, "idx_messages_insert_xid is in POST_MIGRATION_INDEXES");
  assert.deepEqual(catalog, {
    name: INSERT_XID_INDEX_NAME,
    table: "messages",
    columns: [INSERT_XID_INDEX_COLUMNS],
    unique: false,
    predicate: INSERT_XID_INDEX_PREDICATE,
    createScript: "db:create-messages-insert-xid-index",
  });
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-messages-insert-xid-index"]!, /scripts\/create-messages-insert-xid-index\.ts$/);
  assert.match(pkg.scripts["db:verify-messages-insert-xid-index"]!, /scripts\/verify-messages-insert-xid-index\.ts$/);
  // Every deploy builds it after the migrations and before the guard checks it.
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-messages-insert-xid-index.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});

test("the readiness check accepts exactly the built shape", () => {
  const ready = { exists: true, isUnique: false, isValid: true, isReady: true, columns: ["insert_xid"], predicate: "(insert_xid IS NOT NULL)" };
  assert.doesNotThrow(() => assertInsertXidIndexReady(ready));
  assert.throws(() => assertInsertXidIndexReady({ ...ready, exists: false }), /is missing/);
  assert.throws(() => assertInsertXidIndexReady({ ...ready, isUnique: true }), /must not be unique/);
  assert.throws(() => assertInsertXidIndexReady({ ...ready, isValid: false }), /not ready\/valid/);
  assert.throws(() => assertInsertXidIndexReady({ ...ready, isReady: false }), /not ready\/valid/);
  assert.throws(() => assertInsertXidIndexReady({ ...ready, columns: ["insert_xid", "seq"] }), /unexpected columns/);
  assert.throws(() => assertInsertXidIndexReady({ ...ready, predicate: null }), /unexpected predicate/);
});

test("on a migrated database the trigger always records the inserting transaction, and the index has the catalog's shape", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const db = getDb();

  // insert_xid is not in the drizzle table (on purpose): raw SQL.
  const insert = async (insertXid: string | null | undefined) => db.transaction(async (tx) => {
    const id = randomUUID();
    const result = insertXid === undefined
      ? await tx.execute(sql`INSERT INTO messages (id, channel_id, sender_type, sender_id, content)
          VALUES (${id}, ${channel.id}, 'user', ${owner.id}, 'insert_xid omitted') RETURNING insert_xid::text AS "insertXid"`)
      : await tx.execute(sql`INSERT INTO messages (id, channel_id, sender_type, sender_id, content, insert_xid)
          VALUES (${id}, ${channel.id}, 'user', ${owner.id}, 'insert_xid supplied', ${insertXid}::xid8) RETURNING insert_xid::text AS "insertXid"`);
    const current = await tx.execute(sql`SELECT pg_current_xact_id()::text AS xid`);
    return {
      row: { id, insertXid: (result.rows[0] as { insertXid: string | null }).insertXid },
      xid: String((current.rows[0] as { xid: unknown }).xid),
    };
  });
  const readInsertXid = async (id: string) => {
    const result = await db.execute(sql`SELECT insert_xid::text AS "insertXid" FROM messages WHERE id = ${id}`);
    return (result.rows[0] as { insertXid: string | null } | undefined)?.insertXid;
  };
  for (const supplied of [undefined, null, "1", "999999999999"]) {
    const { row, xid } = await insert(supplied);
    assert.equal(row.insertXid, xid, `supplied ${String(supplied)}: the trigger wrote the inserting transaction`);
  }
  // The ORM writes a row without knowing the column: the trigger still fills it, and the row has no insertXid key.
  const [ormRow] = await db.insert(messages).values({ channelId: channel.id, senderType: "user", senderId: owner.id, content: "orm" }).returning();
  assert.equal("insertXid" in ormRow!, false);
  assert.match((await readInsertXid(ormRow!.id)) ?? "", /^[0-9]+$/);
  // An UPDATE does not touch it.
  const { row } = await insert(undefined);
  await db.update(messages).set({ content: "edited" }).where(eq(messages.id, row.id));
  assert.equal(await readInsertXid(row.id), row.insertXid);

  // PGlite builds the index with the other compatibility indexes (pgliteMigrations.ts).
  const query = async (text: string, values?: unknown[]) => {
    const tables = (values?.[0] ?? []) as string[];
    const inlined = text.replace("$1::text[]", `ARRAY[${tables.map((table) => `'${table.replace(/'/g, "''")}'`).join(",")}]::text[]`);
    const result = await db.execute(sql.raw(inlined));
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const spec = POST_MIGRATION_INDEXES.filter((entry) => entry.name === INSERT_XID_INDEX_NAME);
  const [state] = evaluatePostMigrationIndexes(await readObservedIndexes(query, spec), spec);
  assert.equal(state?.state, "ok");
});
