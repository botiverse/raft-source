import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// object_references (#proj-workspace:#336) and the mark on
// app_artifacts.versions of the links read into it: two files, found by name,
// never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const markName = files.find((name) => name.endsWith("_artifact_versions_references_extractor.sql"));
const tableName = files.find((name) => name.endsWith("_object_references.sql"));
/** The SQL without its comments, so only statements are matched. */
const statements = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8").replace(/^--.*$/gm, "");

test("the mark: one catalog-only nullable column, nothing backfilled", () => {
  assert.ok(markName, "the migration exists");
  const sql = statements(markName);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "cards and pushes read this table: fail fast, the deploy runner retries");
  assert.match(sql, /ALTER TABLE "app_artifacts"\."versions" ADD COLUMN "references_extractor" smallint;/, "nullable, no default: catalog only");
  assert.doesNotMatch(sql, /\bUPDATE\b|\bDEFAULT\b|REFERENCES/, "additive: no backfill, no rewrite, no key");
});

test("the table: one new table whose key to servers (hot) is the only lock on an existing table", () => {
  assert.ok(tableName, "the migration exists");
  assert.ok(files.indexOf(markName!) < files.indexOf(tableName), "after the mark, in a file of its own");
  const sql = statements(tableName);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "servers is hot: at most 2 s");
  assert.match(sql, /CREATE TABLE "object_references"/);
  assert.match(sql, /PRIMARY KEY\("source_kind","source_id","position"\)/);
  assert.match(sql, /FOREIGN KEY \("server_id"\) REFERENCES "public"\."servers"\("id"\) ON DELETE cascade/);
  assert.match(sql, /CREATE INDEX "idx_object_references_target" ON "object_references" USING btree \("target_kind","target_id"\)/, "backlinks");
  assert.match(sql, /CREATE INDEX "idx_object_references_server" ON "object_references" USING btree \("server_id"\)/, "the closed-server purge and the cascade");
  // No other existing table is touched while servers is locked.
  for (const match of sql.matchAll(/ALTER TABLE "([^"]+)"/g)) assert.equal(match[1], "object_references");
  assert.doesNotMatch(sql, /\bUPDATE "|\bINSERT INTO\b|\bDELETE FROM\b/, "no data step");
});
