import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// A Markdown version's excerpt (#proj-workspace:#217): the two migrations that
// add app_artifacts.versions.excerpt, and the one that adds excerpt_blocks
// (#220). Found by name, never by number (numbers change on renumber).
const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
const files = readdirSync(drizzleDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const addName = files.find((name) => name.endsWith("_artifact_version_excerpt.sql"));
const validateName = files.find((name) => name.endsWith("_artifact_version_excerpt_validate.sql"));
const read = (name: string) => readFileSync(resolve(drizzleDir, name), "utf8");
/** The SQL without its comments, so only statements are matched. */
const statements = (name: string) => read(name).replace(/^--.*$/gm, "");

const blocksName = files.find((name) => name.endsWith("_artifact_version_excerpt_blocks.sql"));

test("excerpt_blocks: added after excerpt, catalog only, its CHECK NOT VALID for good, nothing rewritten or backfilled", () => {
  assert.ok(blocksName, "the migration exists");
  assert.ok(files.indexOf(validateName!) < files.indexOf(blocksName), "a forward migration: 0636 and 0637 have run on staging");
  const add = statements(blocksName);
  assert.match(add, /SET LOCAL lock_timeout = '2s'/);
  assert.match(add, /ALTER TABLE "app_artifacts"\."versions" ADD COLUMN "excerpt_blocks" jsonb;/, "nullable, no default: catalog only");
  assert.match(add, /ADD CONSTRAINT "versions_excerpt_blocks_shape" CHECK \([^;]*\) NOT VALID;/);
  assert.match(add, /"excerpt" IS NOT NULL/, "never without the text");
  assert.match(add, /octet_length\("app_artifacts"\."versions"\."excerpt_blocks"::text\) <= 12288/, "bounded");
  assert.doesNotMatch(add, /\bUPDATE\b/, "additive: no backfill");
  // The column is new, so no row held a value before the CHECK: there is nothing to validate.
  for (const name of files) assert.doesNotMatch(statements(name), /VALIDATE CONSTRAINT "versions_excerpt_blocks_shape"/, name);
});

test("the column and its CHECK scan nothing under the exclusive lock; a later file validates it; nothing is rewritten or backfilled", () => {
  assert.ok(addName, "the migration exists");
  assert.ok(validateName, "the validation exists");
  assert.ok(files.indexOf(addName) < files.indexOf(validateName), "validated after it is added");
  const add = statements(addName);
  assert.match(add, /SET LOCAL lock_timeout = '2s'/, "cards and pushes read this table: fail fast, the deploy runner retries");
  assert.match(add, /ALTER TABLE "app_artifacts"\."versions" ADD COLUMN "excerpt" text;/, "nullable, no default: catalog only");
  assert.match(add, /ADD CONSTRAINT "versions_excerpt_length" CHECK \([^;]*\) NOT VALID;/, "no scan under ACCESS EXCLUSIVE");
  assert.doesNotMatch(add, /\bUPDATE\b/, "additive: no backfill");
  const validate = statements(validateName);
  assert.match(validate, /SET LOCAL lock_timeout = '2s'/);
  assert.match(validate, /ALTER TABLE "app_artifacts"\."versions" VALIDATE CONSTRAINT "versions_excerpt_length";/);
});
