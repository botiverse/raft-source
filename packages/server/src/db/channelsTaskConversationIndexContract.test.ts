import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "./index";
import { evaluatePostMigrationIndexes, POST_MIGRATION_INDEXES, readObservedIndexes } from "./postMigrationIndexes";
import {
  assertTaskConversationIndexReady,
  TASK_CONVERSATION_INDEXES,
  TASK_V2_NOT_VALID_CONSTRAINTS,
} from "../../scripts/channels-task-conversation-indexes";

// Task v2 (migrations task_source_message_id, task_conversation_*): the six
// indexes (three partial on `channels`, one on `thread_follows`, two on
// `tasks`) follow the large-table convention (0298 / 0359): built in the
// migration only on a small table, otherwise CONCURRENTLY by
// db:create-channels-task-conversation-indexes (which also validates the seven
// NOT VALID constraints), and reported by the post-migration index check until
// then.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function readServerFile(relativePath: string) {
  return readFile(path.join(SERVER_ROOT, relativePath), "utf8");
}

/** A migration by name, not number: the number moves when staging lands migrations first. */
async function readMigrationByName(name: string) {
  const file = (await readdir(path.join(SERVER_ROOT, "drizzle"))).find((entry) => new RegExp(`^\\d{4}_${name}\\.sql$`).test(entry));
  assert.ok(file, `the ${name} migration exists`);
  return readServerFile(`drizzle/${file}`);
}

/** The SQL statements, comments stripped (prose may name what the code must not do). */
function sqlStatements(migration: string): string[] {
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n"));
}

test("the task_conversation_channels migration builds the channels task indexes only on a small table, and IF NOT EXISTS", async () => {
  // By name, not number: the number moves when staging lands migrations first.
  const file = (await readdir(path.join(SERVER_ROOT, "drizzle"))).find((name) => /^\d{4}_task_conversation_channels\.sql$/.test(name));
  assert.ok(file, "the task_conversation_channels migration exists");
  const migration = await readServerFile(`drizzle/${file}`);
  const statements = migration.split("--> statement-breakpoint");
  const block = statements.find((statement) => statement.includes("idx_channels_active_task_parent"));
  assert.ok(block, "the migration must still declare idx_channels_active_task_parent");
  assert.match(block, /reltuples FROM pg_class WHERE oid = 'public\.channels'::regclass\) <= 100000/);
  assert.match(block, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_channels_active_task_parent"/);
  assert.match(block, /CREATE INDEX IF NOT EXISTS "idx_channels_task_parent_channel"/);
  assert.match(block, /CREATE INDEX IF NOT EXISTS "idx_channels_task_id"/, "the cascade from tasks has its index");
  assert.match(block, /db:create-channels-task-conversation-indexes/);
  // No unguarded CREATE INDEX on channels anywhere else in the migration.
  for (const statement of statements) {
    if (statement === block) continue;
    assert.doesNotMatch(statement, /CREATE (UNIQUE )?INDEX[^;]*ON "channels"/);
  }
});

test("the task_conversation_tasks migration builds the tasks index and validates its foreign key only on a small tasks table", async () => {
  const statements = sqlStatements(await readMigrationByName("task_conversation_tasks"));
  assert.match(statements[0]!, /SET LOCAL lock_timeout = '\d+s'/);
  const block = statements.find((statement) => statement.includes("idx_tasks_conversation_channel_id"));
  assert.ok(block, "the migration must still declare idx_tasks_conversation_channel_id");
  assert.match(block, /reltuples FROM pg_class WHERE oid = 'public\.tasks'::regclass\) <= 100000/);
  assert.match(block, /CREATE UNIQUE INDEX IF NOT EXISTS "idx_tasks_conversation_channel_id"/);
  assert.match(block, /VALIDATE CONSTRAINT "tasks_conversation_channel_id_channels_id_fk"/);
  assert.match(block, /db:create-channels-task-conversation-indexes/);
  for (const statement of statements) {
    if (statement === block) continue;
    assert.doesNotMatch(statement, /CREATE (UNIQUE )?INDEX[^;]*ON "tasks"/, "no unguarded index build on tasks");
    assert.doesNotMatch(statement, /VALIDATE CONSTRAINT/, "no unguarded validation (it scans under this migration's lock)");
  }
});

// Tenny #10467 review: each migration holds one table's lock, so no lock is
// kept while the next table waits (each deploy phase is one transaction).
test("the task conversation migrations take one table each", async () => {
  // `\bON`: a trigger's `EXECUTE FUNCTION "name"` also ends in "ON".
  const touched = (sql: string) => new Set([...sql.matchAll(/(?:ALTER TABLE|\bON|TRIGGER[^;]*\bON) "(\w+)"/g)].map((match) => match[1]));
  const expected: Record<string, string> = {
    task_conversation_follows: "thread_follows",
    task_conversation_channels: "channels",
    task_conversation_tasks: "tasks",
    task_conversation_push_kind: "mobile_push_outbox",
    task_own_conversation: "tasks",
    task_conversation_detach_on_delete: "channels",
  };
  for (const [name, table] of Object.entries(expected)) {
    const statements = sqlStatements(await readMigrationByName(name));
    assert.match(statements[0]!, /SET LOCAL lock_timeout = '\d+s'/, `${name} sets a lock timeout`);
    const tables = touched(statements.filter((statement) => !statement.trimStart().startsWith("CREATE OR REPLACE FUNCTION")).join("\n"));
    assert.deepEqual([...tables], [table], `${name} alters only ${table}`);
  }
  const follows = sqlStatements(await readMigrationByName("task_conversation_follows"));
  const block = follows.find((statement) => statement.includes("idx_thread_follows_parent_task_id"));
  assert.ok(block, "the cascade from tasks into thread_follows has its index");
  assert.match(block, /reltuples FROM pg_class WHERE oid = 'public\.thread_follows'::regclass\) <= 100000/);
});

test("the task_source_message_id migration is metadata-only on a large tasks table: no backfill, NOT VALID key, guarded index", async () => {
  const statements = sqlStatements(await readMigrationByName("task_source_message_id"));
  assert.match(statements[0]!, /SET LOCAL lock_timeout = '\d+s'/);
  const code = statements.join("\n");
  // Readers fall back to tasks.message_id: no full-table UPDATE.
  assert.doesNotMatch(code, /\bUPDATE\s+"?tasks"?/i);
  assert.match(code, /ADD COLUMN "source_message_id" uuid;/);
  assert.match(code, /"tasks_source_message_id_messages_id_fk"[^;]*NOT VALID/);
  const block = statements.find((statement) => statement.includes("idx_tasks_source_message_id"));
  assert.ok(block);
  assert.match(block, /reltuples FROM pg_class WHERE oid = 'public\.tasks'::regclass\) <= 100000/);
  assert.match(block, /CREATE INDEX IF NOT EXISTS "idx_tasks_source_message_id"/);
  assert.match(block, /VALIDATE CONSTRAINT "tasks_source_message_id_messages_id_fk"/);
  for (const statement of statements) {
    if (statement === block) continue;
    assert.doesNotMatch(statement, /CREATE (UNIQUE )?INDEX/);
    assert.doesNotMatch(statement, /VALIDATE CONSTRAINT/);
  }
});

test("the index scripts build concurrently and cover every NOT VALID constraint", () => {
  for (const spec of TASK_CONVERSATION_INDEXES) {
    assert.match(spec.createSql, /CREATE (UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS/);
  }
  // Every NOT VALID constraint the migrations add is validated by the script, then verified.
  assert.deepEqual(TASK_V2_NOT_VALID_CONSTRAINTS.map((constraint) => constraint.name), [
    "tasks_source_message_id_messages_id_fk",
    "tasks_conversation_channel_id_channels_id_fk",
    "channels_task_id_tasks_id_fk",
    "channels_task_id_matches_type",
    "thread_follows_parent_task_id_tasks_id_fk",
    "thread_follows_parent_present",
    "mobile_push_outbox_kind_check",
  ]);
});

test("the post-migration catalog and the scripts describe the same indexes", () => {
  for (const spec of TASK_CONVERSATION_INDEXES) {
    const catalog = POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name);
    assert.ok(catalog, `${spec.name} must be in POST_MIGRATION_INDEXES`);
    assert.equal(catalog.table, spec.table);
    assert.deepEqual([...catalog.columns], [...spec.columns]);
    assert.equal(catalog.unique, spec.unique);
    assert.equal(catalog.predicate, spec.predicate);
    assert.equal(catalog.createScript, "db:create-channels-task-conversation-indexes");
  }
});

test("the readiness check accepts exactly the built shape", () => {
  const byName = (name: string) => TASK_CONVERSATION_INDEXES.find((spec) => spec.name === name)!;
  const unique = byName("idx_channels_active_task_parent");
  const parent = byName("idx_channels_task_parent_channel");
  const ready = (spec: typeof unique) => ({
    exists: true, isUnique: spec!.unique, isValid: true, isReady: true, columns: [...spec!.columns], predicate: spec!.predicate,
  });
  assert.doesNotThrow(() => assertTaskConversationIndexReady(unique!, ready(unique)));
  assert.doesNotThrow(() => assertTaskConversationIndexReady(parent!, ready(parent)));
  assert.throws(() => assertTaskConversationIndexReady(unique!, { ...ready(unique), isUnique: false }), /must be unique/);
  assert.throws(() => assertTaskConversationIndexReady(parent!, { ...ready(parent), isValid: false }), /not ready\/valid/);
  assert.throws(() => assertTaskConversationIndexReady(parent!, { ...ready(parent), columns: ["parent_channel_id"] }), /unexpected columns/);
  assert.throws(() => assertTaskConversationIndexReady(parent!, { ...ready(parent), predicate: "(type = 'thread'::text)" }), /unexpected predicate/);
  // A full index on tasks: no predicate expected, a partial one is wrong.
  const conversation = TASK_CONVERSATION_INDEXES.find((spec) => spec.name === "idx_tasks_conversation_channel_id")!;
  assert.equal(conversation.table, "tasks");
  assert.doesNotThrow(() => assertTaskConversationIndexReady(conversation, ready(conversation)));
  assert.throws(() => assertTaskConversationIndexReady(conversation, { ...ready(conversation), predicate: "(conversation_channel_id IS NOT NULL)" }), /unexpected predicate/);
  assert.throws(() => assertTaskConversationIndexReady(conversation, { ...ready(conversation), isUnique: false }), /must be unique/);
});

test("a small migrated database has all six indexes in the catalog's shape, and the tasks keys validated", async ({ db: _db }) => {
  const query = async (text: string, values?: unknown[]) => {
    const tables = (values?.[0] ?? []) as string[];
    const inlined = text.replace("$1::text[]", `ARRAY[${tables.map((table) => `'${table.replace(/'/g, "''")}'`).join(",")}]::text[]`);
    const result = await getDb().execute(sql.raw(inlined));
    return { rows: result.rows as Record<string, unknown>[] };
  };
  const specs = POST_MIGRATION_INDEXES.filter((spec) => TASK_CONVERSATION_INDEXES.some((index) => index.name === spec.name));
  assert.equal(specs.length, 6);
  const states = evaluatePostMigrationIndexes(await readObservedIndexes(query, specs), specs);
  for (const state of states) assert.equal(state.state, "ok", `${state.spec.name}: ${state.state}`);
  // Small tasks table: the migrations validated its NOT VALID keys inline. The
  // other tables' constraints are validated only by the script.
  for (const constraint of TASK_V2_NOT_VALID_CONSTRAINTS.filter((entry) => entry.table === "tasks")) {
    const result = await getDb().execute(sql.raw(`SELECT convalidated FROM pg_constraint WHERE conname = '${constraint.name}'`));
    assert.equal((result.rows[0] as { convalidated?: boolean } | undefined)?.convalidated, true, constraint.name);
  }
});
