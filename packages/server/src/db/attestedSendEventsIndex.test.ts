import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ATTESTED_SEND_EVENTS_MESSAGE_INDEX } from "./attestedSendEventsIndexContract";
import { POST_MIGRATION_INDEXES } from "./postMigrationIndexes";

// attested_send_events.message_id references messages(id) ON DELETE SET NULL.
// The table is large in production, so migration
// attested_send_events_message_index is SELECT 1 and db:migrate:deploy builds
// the index CONCURRENTLY before the post-migration index guard checks it.
const SERVER_ROOT = path.resolve(import.meta.dirname, "../..");
const DRIZZLE_DIR = path.join(SERVER_ROOT, "drizzle");
const spec = ATTESTED_SEND_EVENTS_MESSAGE_INDEX;

function executableStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

test("the migration builds nothing under the migrator's transaction", async () => {
  const files = (await readdir(DRIZZLE_DIR)).filter((file) => file.endsWith("_attested_send_events_message_index.sql"));
  assert.equal(files.length, 1, files.join(", "));
  const sqlText = await readFile(path.join(DRIZZLE_DIR, files[0]!), "utf8");
  assert.deepEqual(executableStatements(sqlText), ["SELECT 1;"]);
  // No other migration builds it either.
  for (const file of (await readdir(DRIZZLE_DIR)).filter((name) => name.endsWith(".sql"))) {
    const statements = executableStatements(await readFile(path.join(DRIZZLE_DIR, file), "utf8")).join("\n");
    assert.doesNotMatch(statements, new RegExp(`"${spec.name}"`), file);
  }
});

test("the create script, the post-migration catalog and db:migrate:deploy describe the same index", async () => {
  assert.match(spec.createSql, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${spec.name}"`));
  assert.deepEqual(POST_MIGRATION_INDEXES.find((entry) => entry.name === spec.name), {
    name: spec.name,
    table: spec.table,
    columns: spec.columns,
    unique: spec.unique,
    predicate: spec.predicate,
    createScript: "db:create-attested-send-events-message-index",
  });
  const pkg = JSON.parse(await readFile(path.join(SERVER_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts["db:create-attested-send-events-message-index"]!, /scripts\/create-attested-send-events-message-index\.ts$/);
  // Every deploy builds it after the migrations and before the guard checks it.
  const deploy = pkg.scripts["db:migrate:deploy"]!;
  const migrate = deploy.indexOf("scripts/migrate-deploy.ts");
  const create = deploy.indexOf("scripts/create-attested-send-events-message-index.ts");
  const verify = deploy.indexOf("scripts/verify-post-migration-indexes.ts");
  assert.ok(migrate >= 0 && create > migrate && verify > create, deploy);
});
