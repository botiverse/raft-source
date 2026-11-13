import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Forum-style channels (#proj-chat:#24): the channel_thread_sort migration.
// Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrationName = files.find((name) => name.endsWith("_channel_thread_sort.sql"));
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");

function triggerColumns(source: string): string[] {
  const match = /CREATE TRIGGER change_log_channels_upd[\s\S]*?WHEN \(([\s\S]*?)\)\s*EXECUTE FUNCTION/.exec(source);
  assert.ok(match, "a change_log_channels_upd definition");
  return [...match[1]!.matchAll(/OLD\.(\w+) IS DISTINCT FROM NEW\.\1/g)].map((m) => m[1]!).sort();
}

test("channel_thread_sort: catalog-only column, trigger re-created with every earlier column plus thread_sort, flag seeded off", () => {
  assert.ok(migrationName, "the channel_thread_sort migration exists");
  const sql = read(migrationName);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "channels is hot: fail fast, the deploy runner retries");
  assert.match(sql, /ALTER TABLE "channels" ADD COLUMN "thread_sort" text DEFAULT 'time' NOT NULL/, "a constant default: no table rewrite");
  assert.doesNotMatch(sql, /ADD CONSTRAINT/, "no CHECK that would scan channels");

  // The trigger logs only the columns in its WHEN list: the new definition
  // keeps every column the previous one had and adds thread_sort.
  const earlier = files.slice(0, files.indexOf(migrationName))
    .filter((name) => read(name).includes("CREATE TRIGGER change_log_channels_upd"))
    .at(-1);
  assert.ok(earlier, "an earlier definition of the trigger");
  assert.match(sql, /DROP TRIGGER IF EXISTS change_log_channels_upd ON public\.channels/);
  assert.deepEqual(triggerColumns(sql), [...triggerColumns(read(earlier)), "thread_sort"].sort());

  assert.match(sql, /'channel_thread_sort_v0',[\s\S]*?true,\s*false,\s*'server',\s*false,\s*NULL,/, "seeded enabled with default off, server unit");
  assert.match(sql, /ON CONFLICT \("key"\) DO NOTHING/);
});
