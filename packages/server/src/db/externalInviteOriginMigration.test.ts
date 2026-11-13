import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// channel_external_invites.origin: nullable, no default, no NOT NULL and no
// trigger (older nodes still insert without it during a rolling deploy and its
// rollback window); existing rows stay NULL; a CHECK limits the values.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_external_invite_origin"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("adds a nullable column with no default and its CHECK, under a bounded lock wait, and nothing else", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "origin", { maxMs: 5_000 });
  assert.deepEqual(steps.slice(1), [
    `ALTER TABLE "channel_external_invites" ADD COLUMN "origin" text;`,
    `ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_origin_known" CHECK ("channel_external_invites"."origin" IS NULL OR "channel_external_invites"."origin" IN ('external_invite', 'host_direct', 'self_connect'));`,
  ]);
});

test("existing rows stay NULL; an insert without origin (an older node's) still succeeds; the three values are accepted and anything else refused", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE "channel_external_invites" ("id" serial PRIMARY KEY, "email" text NOT NULL);
      INSERT INTO "channel_external_invites" (email) VALUES ('before@slock.test');`);
    await db.exec("BEGIN");
    for (const step of await migration()) await db.exec(step);
    await db.exec("COMMIT");
    assert.deepEqual((await db.query(`SELECT email, origin FROM channel_external_invites`)).rows, [{ email: "before@slock.test", origin: null }]);
    await db.query(`INSERT INTO channel_external_invites (email) VALUES ('older-node@slock.test')`);
    for (const origin of ["external_invite", "host_direct", "self_connect"]) {
      await db.query(`INSERT INTO channel_external_invites (email, origin) VALUES ($1, $2)`, [`${origin}@slock.test`, origin]);
    }
    await assert.rejects(db.query(`INSERT INTO channel_external_invites (email, origin) VALUES ('x@slock.test', 'unknown')`), /channel_external_invites_origin_known/);
    assert.deepEqual((await db.query(`SELECT count(*)::int AS n FROM channel_external_invites WHERE origin IS NULL`)).rows, [{ n: 2 }]);
  } finally {
    await db.close();
  }
});
