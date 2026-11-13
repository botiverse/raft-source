import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Retire Guest joining, last step (#wg-rbac:#49): channels_guest_joinable_drop.
// Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");
const statements = (source: string) => source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

test("channels_guest_joinable_drop: one catalog-only drop, after the trigger stopped naming the column", () => {
  const migrationName = files.find((name) => name.endsWith("_channels_guest_joinable_drop.sql"));
  assert.ok(migrationName, "the channels_guest_joinable_drop migration exists");
  const source = read(migrationName);
  const sql = statements(source);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "channels is hot: fail fast, the deploy runner retries");
  assert.match(source, /-- schema-snapshot: unchanged/);
  assert.match(sql, /ALTER TABLE "channels" DROP COLUMN IF EXISTS "guest_joinable";/);
  assert.doesNotMatch(sql, /CASCADE/, "nothing may depend on the column by now");
  assert.equal([...sql.matchAll(/\b(ALTER|DROP|CREATE|UPDATE|DELETE|INSERT)\b/g)].length, 2, "ALTER TABLE ... DROP COLUMN and nothing else");

  // The last definition of change_log_channels_upd before this migration must not name the column:
  // a trigger that names a column blocks DROP COLUMN without CASCADE.
  const earlier = files.slice(0, files.indexOf(migrationName))
    .filter((name) => read(name).includes("CREATE TRIGGER change_log_channels_upd"))
    .at(-1);
  assert.ok(earlier, "an earlier definition of the trigger");
  assert.doesNotMatch(statements(read(earlier)), /guest_joinable/, `${earlier} still names guest_joinable`);
});
