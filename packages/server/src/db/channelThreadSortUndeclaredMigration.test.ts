import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Retire forum-style channels, step 1 of 2: the channel_thread_sort_undeclared
// migration. Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrationName = files.find((name) => name.endsWith("_channel_thread_sort_undeclared.sql"));
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");
/** The statements, without comment lines (the header explains what is not done). */
const statements = (source: string) => source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

function triggerColumns(source: string): string[] {
  const match = /CREATE TRIGGER change_log_channels_upd[\s\S]*?WHEN \(([\s\S]*?)\)\s*EXECUTE FUNCTION/.exec(source);
  assert.ok(match, "a change_log_channels_upd definition");
  return [...match[1]!.matchAll(/OLD\.(\w+) IS DISTINCT FROM NEW\.\1/g)].map((m) => m[1]!).sort();
}

test("channel_thread_sort_undeclared: the trigger loses only thread_sort, the column stays for the serving and rollback images", () => {
  assert.ok(migrationName, "the channel_thread_sort_undeclared migration exists");
  const sql = statements(read(migrationName));
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "channels is hot: fail fast, the deploy runner retries");

  const earlier = files.slice(0, files.indexOf(migrationName))
    .filter((name) => read(name).includes("CREATE TRIGGER change_log_channels_upd"))
    .at(-1);
  assert.ok(earlier, "an earlier definition of the trigger");
  assert.match(sql, /DROP TRIGGER IF EXISTS change_log_channels_upd ON public\.channels/);
  assert.deepEqual(
    triggerColumns(sql),
    triggerColumns(read(earlier)).filter((column) => column !== "thread_sort"),
    "every column the last definition logged, except thread_sort",
  );

  // The serving and rollback images still declare the column: no drop yet.
  assert.doesNotMatch(sql, /ALTER TABLE/, "nothing is altered on channels");
  assert.doesNotMatch(sql, /thread_sort/, "no statement names thread_sort");
  assert.doesNotMatch(sql, /feature_flags/, "the flag row is deleted in a separate step");
  assert.doesNotMatch(sql, /CASCADE/);
});

test("no later migration re-creates change_log_channels_upd with thread_sort", () => {
  assert.ok(migrationName);
  for (const name of files.slice(files.indexOf(migrationName) + 1)) {
    const source = read(name);
    if (!source.includes("CREATE TRIGGER change_log_channels_upd")) continue;
    assert.equal(triggerColumns(source).includes("thread_sort"), false, `${name} names thread_sort again`);
  }
});
