import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// RFC 076 §17 on oauth_app_link_previews (read by every link card read): two
// nullable columns and a CHECK added NOT VALID. A 2 s lock wait, catalog
// changes only, no backfill, no validating scan. The CHECK itself is exercised
// in routes/linkCardOwnServerActions.api.test.ts.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

test("adds the two nullable columns and the CHECK NOT VALID, nothing else, under a 2 s lock wait", async () => {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_link_card_own_server_actions"));
  assert.ok(entry, "the migration is in the journal");
  const steps = statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
  assertBoundedLockTimeout(steps[0], "oauth_app_link_previews is read by every link card read", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '5s';");
  assert.deepEqual(steps.slice(2), [
    `ALTER TABLE "oauth_app_link_previews" ADD COLUMN "own_server_action_endpoint" text;`,
    `ALTER TABLE "oauth_app_link_previews" ADD COLUMN "own_server_actions_confirmed_at" timestamp with time zone;`,
    `ALTER TABLE "oauth_app_link_previews" ADD CONSTRAINT "oauth_app_link_previews_own_server_actions" CHECK (("oauth_app_link_previews"."own_server_action_endpoint" IS NULL) = ("oauth_app_link_previews"."own_server_actions_confirmed_at" IS NULL)) NOT VALID;`,
  ]);
});
