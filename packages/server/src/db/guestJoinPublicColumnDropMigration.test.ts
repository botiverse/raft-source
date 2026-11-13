import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Retire Guest joining, step 2 (#wg-rbac:#49): the guest_join_public_column_drop
// migration. Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const migrationName = files.find((name) => name.endsWith("_guest_join_public_column_drop.sql"));
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");
/** The statements, without comment lines (the header explains what is not done). */
const statements = (source: string) => source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

function triggerColumns(source: string): string[] {
  const match = /CREATE TRIGGER change_log_channels_upd[\s\S]*?WHEN \(([\s\S]*?)\)\s*EXECUTE FUNCTION/.exec(source);
  assert.ok(match, "a change_log_channels_upd definition");
  return [...match[1]!.matchAll(/OLD\.(\w+) IS DISTINCT FROM NEW\.\1/g)].map((m) => m[1]!).sort();
}

test("guest_join_public_column_drop: the trigger loses only guest_joinable, servers loses its retired column, channels keeps its own", () => {
  assert.ok(migrationName, "the guest_join_public_column_drop migration exists");
  const source = read(migrationName);
  const sql = statements(source);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "channels and servers are hot: fail fast, the deploy runner retries");
  assert.match(source, /-- schema-snapshot: unchanged/, "schema.ts stopped declaring the columns in 0653");

  const earlier = files.slice(0, files.indexOf(migrationName))
    .filter((name) => read(name).includes("CREATE TRIGGER change_log_channels_upd"))
    .at(-1);
  assert.ok(earlier, "an earlier definition of the trigger");
  assert.match(sql, /DROP TRIGGER IF EXISTS change_log_channels_upd ON public\.channels/);
  assert.deepEqual(
    triggerColumns(sql),
    triggerColumns(read(earlier)).filter((column) => column !== "guest_joinable"),
    "every column the last definition logged, except guest_joinable",
  );

  assert.match(sql, /ALTER TABLE "servers" DROP COLUMN IF EXISTS "public_guest_join_enabled";/);
  // channels is mirrored to RisingWave as rw_channels (*): its column is not dropped here.
  assert.doesNotMatch(sql, /ALTER TABLE "channels"/, "nothing is altered on channels");
  assert.doesNotMatch(sql, /guest_joinable/, "no statement names guest_joinable");
  assert.doesNotMatch(sql, /CASCADE/);
});

test("no later migration re-creates change_log_channels_upd with guest_joinable", () => {
  assert.ok(migrationName);
  for (const name of files.slice(files.indexOf(migrationName) + 1)) {
    const source = read(name);
    if (!source.includes("CREATE TRIGGER change_log_channels_upd")) continue;
    assert.equal(triggerColumns(source).includes("guest_joinable"), false, `${name} names guest_joinable again`);
  }
});
