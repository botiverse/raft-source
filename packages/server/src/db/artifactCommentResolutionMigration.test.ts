import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolvable comment threads (#proj-workspace:#249): the migration that adds
// app_artifacts.comments.resolved_*. Found by name, never by number (numbers
// change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const name = files.find((file) => file.endsWith("_artifact_comment_resolution.sql"));
/** The SQL without its comments, so only statements are matched. */
const statements = (file: string) => readFileSync(resolve(drizzleDir, file), "utf8").replace(/^--.*$/gm, "");

test("resolved_*: catalog only, the CHECK NOT VALID for good (the columns are new), nothing rewritten or backfilled", () => {
  assert.ok(name, "the migration exists");
  const sql = statements(name);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/, "comment lists and writes read this table: fail fast, the deploy runner retries");
  for (const column of [`"resolved_at" timestamp with time zone`, `"resolved_by_type" text`, `"resolved_by_id" uuid`]) {
    assert.ok(sql.includes(`ALTER TABLE "app_artifacts"."comments" ADD COLUMN ${column};`), `nullable, no default: ${column}`);
  }
  assert.match(sql, /ADD CONSTRAINT "comments_resolution" CHECK \([^;]*\) NOT VALID;/, "no scan under ACCESS EXCLUSIVE");
  assert.match(sql, /"reply_to" IS NULL\)\)/, "only a thread's root is resolved");
  assert.doesNotMatch(sql, /\bUPDATE\b/, "additive: no backfill");
  // Every existing row has all three NULL: nothing to validate.
  for (const file of files) assert.doesNotMatch(statements(file), /VALIDATE CONSTRAINT "comments_resolution"/, file);
});
