import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const correctionMigrationSql = readFileSync(
  resolve(import.meta.dirname, "../../drizzle/0138_eager_star_brand.sql"),
  "utf8",
);

const defaultsMigrationSql = readFileSync(
  resolve(import.meta.dirname, "../../drizzle/0139_watery_firebrand.sql"),
  "utf8",
);

test("translation default migration protects old off users and keeps new users opt-in", () => {
  assert.match(
    defaultsMigrationSql,
    /ALTER TABLE "users" ALTER COLUMN "auto_translation_enabled" SET DEFAULT false/,
  );
  assert.match(
    defaultsMigrationSql,
    /ALTER TABLE "users" ALTER COLUMN "preferred_translation_mode" SET DEFAULT 'off'/,
  );

  const protectLegacyOffIndex = correctionMigrationSql.indexOf("SET \"preferred_translation_mode\" = 'off'");
  const broadAutoBackfillIndex = correctionMigrationSql.indexOf("SET \"preferred_translation_mode\" = 'auto'");
  const newUserOffIndex = defaultsMigrationSql.indexOf("SET \"preferred_translation_mode\" = 'off'");

  assert.notEqual(protectLegacyOffIndex, -1);
  assert.notEqual(broadAutoBackfillIndex, -1);
  assert.notEqual(newUserOffIndex, -1);
  assert.ok(
    protectLegacyOffIndex < broadAutoBackfillIndex,
    "legacy-off protection must run before old-user manual -> auto backfill",
  );

  const legacyOffClause = correctionMigrationSql.slice(protectLegacyOffIndex, broadAutoBackfillIndex);
  assert.match(legacyOffClause, /"created_at"\s*<\s*timestamp with time zone '2026-07-06T16:48:15Z'/);
  assert.match(legacyOffClause, /"preferred_translation_mode"\s*=\s*'manual'/);
  assert.match(legacyOffClause, /"auto_translation_enabled"\s*=\s*false/);
  assert.match(legacyOffClause, /"preferred_translation_display"\s*=\s*'original'/);

  const broadBackfillClause = correctionMigrationSql.slice(broadAutoBackfillIndex);
  assert.match(broadBackfillClause, /"created_at"\s*<\s*timestamp with time zone '2026-07-06T16:48:15Z'/);
  assert.match(broadBackfillClause, /"preferred_translation_mode"\s*=\s*'manual'/);

  const newUserOffClause = defaultsMigrationSql.slice(newUserOffIndex);
  assert.match(newUserOffClause, /"created_at"\s*>=\s*timestamp with time zone '2026-07-06T16:48:15Z'/);
  assert.match(newUserOffClause, /WHERE "created_at"/);
  assert.match(newUserOffClause, /"preferred_translation_mode"\s*=\s*'auto'/);
  assert.doesNotMatch(defaultsMigrationSql, /"preferred_translation_display"\s*=\s*'original'/);
});
