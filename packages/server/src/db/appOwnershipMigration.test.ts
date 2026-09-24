import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/0168_sudden_black_tarantula.sql", import.meta.url),
  "utf8",
);
const replayAuthorityMigration = readFileSync(
  new URL("../../drizzle/0210_milky_chimera.sql", import.meta.url),
  "utf8",
);

test("app ownership migration backfills only non-null legacy agent owners", () => {
  assert.match(migration, /CREATE TABLE "oauth_client_maintainers"/);
  assert.match(migration, /WHERE "owner_agent_id" IS NOT NULL/);
  assert.match(migration, /idx_oauth_client_maintainers_active_owner/);
  assert.doesNotMatch(migration, /principal_type[^;]*'human'[^;]*INSERT/i);
});

test("app transfer replay authority migration is nullable and does not infer legacy authority", () => {
  assert.match(
    replayAuthorityMigration,
    /ALTER TABLE "oauth_client_maintainers" ADD COLUMN "assigned_by_authority" text/,
  );
  assert.doesNotMatch(replayAuthorityMigration, /UPDATE\s+"oauth_client_maintainers"/i);
  assert.doesNotMatch(replayAuthorityMigration, /DEFAULT\s+'owner'/i);
});
