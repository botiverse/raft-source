import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// channel_external_invites.sent_to_host_member: NOT NULL DEFAULT false (no
// rewrite, no backfill); an older node's insert without it reads false.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_external_invite_sent_to_host_member"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("adds one boolean column defaulting to false, under a bounded lock wait, and nothing else", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "sent_to_host_member", { maxMs: 5_000 });
  assert.deepEqual(steps.slice(1), [
    `ALTER TABLE "channel_external_invites" ADD COLUMN "sent_to_host_member" boolean DEFAULT false NOT NULL;`,
  ]);
});

test("existing rows and an insert without the column (an older node's) read false; true is stored as sent", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "channel_external_invites" ("id" serial PRIMARY KEY, "email" text NOT NULL);
      INSERT INTO "channel_external_invites" (email) VALUES ('before@slock.test');`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    await db.query(`INSERT INTO channel_external_invites (email) VALUES ('older-node@slock.test')`);
    await db.query(`INSERT INTO channel_external_invites (email, sent_to_host_member) VALUES ('member@slock.test', true)`);
    assert.deepEqual((await db.query(`SELECT email, sent_to_host_member FROM channel_external_invites ORDER BY id`)).rows, [
      { email: "before@slock.test", sent_to_host_member: false },
      { email: "older-node@slock.test", sent_to_host_member: false },
      { email: "member@slock.test", sent_to_host_member: true },
    ]);
  } finally {
    await db.close();
  }
});
