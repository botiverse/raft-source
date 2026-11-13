import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Channel announcements (#proj-chat:#29): the channel_announcement migration.
// Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrationName = files.find((name) => name.endsWith("_channel_announcement.sql"));
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");

function triggerColumns(source: string): string[] {
  const match = /CREATE TRIGGER change_log_channels_upd[\s\S]*?WHEN \(([\s\S]*?)\)\s*EXECUTE FUNCTION/.exec(source);
  assert.ok(match, "a change_log_channels_upd definition");
  return [...match[1]!.matchAll(/OLD\.(\w+) IS DISTINCT FROM NEW\.\1/g)].map((m) => m[1]!).sort();
}

test("channel_announcement: catalog-only nullable column, a new hides table, trigger re-created with every earlier column plus it, flag seeded off", () => {
  assert.ok(migrationName, "the channel_announcement migration exists");
  const sql = read(migrationName);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "channels is hot: fail fast, the deploy runner retries");
  assert.match(sql, /ALTER TABLE "channels" ADD COLUMN "announcement_artifact_id" text;/, "nullable, no default: no table rewrite");
  assert.doesNotMatch(sql, /ALTER TABLE "channels" ADD CONSTRAINT|CREATE INDEX[^;]*ON "channels"/, "no CHECK, foreign key or index build on channels");
  // The hides table is new and empty: its keys and index are the only constraints added.
  assert.match(sql, /CREATE TABLE "channel_announcement_hides"/);
  for (const statement of sql.split("--> statement-breakpoint").filter((part) => /ADD CONSTRAINT|CREATE INDEX/.test(part))) {
    assert.match(statement, /"channel_announcement_hides"/, "constraints and indexes only on the new table");
  }

  const earlier = files.slice(0, files.indexOf(migrationName))
    .filter((name) => read(name).includes("CREATE TRIGGER change_log_channels_upd"))
    .at(-1);
  assert.ok(earlier, "an earlier definition of the trigger");
  assert.match(sql, /DROP TRIGGER IF EXISTS change_log_channels_upd ON public\.channels/);
  assert.deepEqual(triggerColumns(sql), [...triggerColumns(read(earlier)), "announcement_artifact_id"].sort());

  assert.match(sql, /'channel_announcement_v0',[\s\S]*?true,\s*false,\s*'server',\s*false,\s*NULL,/, "seeded enabled with default off, server unit");
  assert.match(sql, /ON CONFLICT \("key"\) DO NOTHING/);
});

test("channel_announcement_hides_drop: the hides table goes in one step, with a short lock wait and no CASCADE", () => {
  const drop = files.find((name) => name.endsWith("_channel_announcement_hides_drop.sql"));
  assert.ok(drop, "the drop migration exists");
  assert.ok(migrationName && files.indexOf(drop) > files.indexOf(migrationName), "after the migration that added it");
  const sql = read(drop);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/);
  const statements = sql.split("--> statement-breakpoint").map((part) => part.replace(/^--.*$/gm, "").trim()).filter(Boolean);
  assert.deepEqual(statements, ["SET LOCAL lock_timeout = '2s';", 'DROP TABLE "channel_announcement_hides";']);
});
