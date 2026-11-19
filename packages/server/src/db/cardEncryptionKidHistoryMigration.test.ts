import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// RFC 086 step 2 (PR C): every kid an App set a card encryption key under
// (oauth_app_card_encryption_kids, so a kid it used before is refused), and
// two flags on link_card_operations saying an execute carried a card form's
// values. Catalog changes only, under a 2 s lock wait.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const target = entries.find((entry) => entry.tag.endsWith("_card_encryption_kid_history"));
  assert.ok(target, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${target.tag}.sql`), "utf8"));
}

test("a 2 s lock wait, then the new table, its foreign key and the two flags with constant defaults: catalog changes only", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "link_card_operations and the oauth_clients foreign key", { maxMs: 2_000 });
  assert.match(steps[1]!, /^CREATE TABLE "oauth_app_card_encryption_kids"/);
  assert.deepEqual(steps.slice(2, 4), [
    `ALTER TABLE "link_card_operations" ADD COLUMN "sealed_inputs_submitted" boolean DEFAULT false NOT NULL;`,
    `ALTER TABLE "link_card_operations" ADD COLUMN "text_inputs_submitted" boolean DEFAULT false NOT NULL;`,
  ]);
  assert.match(steps[4]!, /^ALTER TABLE "oauth_app_card_encryption_kids" ADD CONSTRAINT .* FOREIGN KEY \("client_id"\) REFERENCES "public"."oauth_clients"\("id"\) ON DELETE cascade/);
  assert.equal(steps.length, 5, "no backfill: no release carries a key yet (0709)");
});
