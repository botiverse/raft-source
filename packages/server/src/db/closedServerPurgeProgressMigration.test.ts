import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { servers } from "./schema";
import { dbTest as test } from "../test/integration/dbTest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// Closed-server purge progress on servers (services/closedServerPurgeDelete.ts):
// four nullable columns and a CHECK added NOT VALID. servers is a hot table:
// a 2 s lock wait, catalog changes only, no backfill, no validating scan.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith("_closed_server_purge_progress"));
  assert.ok(entry, "the migration is in the journal");
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("adds the four nullable columns and the CHECK NOT VALID, nothing else, under a 2 s lock wait", async () => {
  const steps = await migration();
  assertBoundedLockTimeout(steps[0], "servers is hot", { maxMs: 2_000 });
  assert.equal(steps[1], "SET LOCAL statement_timeout = '5s';");
  assert.deepEqual(steps.slice(2), [
    `ALTER TABLE "servers" ADD COLUMN "purge_state" text;`,
    `ALTER TABLE "servers" ADD COLUMN "purge_lease_until" timestamp with time zone;`,
    `ALTER TABLE "servers" ADD COLUMN "purge_lease_token" uuid;`,
    `ALTER TABLE "servers" ADD COLUMN "purged_at" timestamp with time zone;`,
    `ALTER TABLE "servers" ADD CONSTRAINT "servers_purge_state_known" CHECK ("servers"."purge_state" IS NULL OR "servers"."purge_state" IN ('apps', 'channels', 'object_events', 'agents', 'scrub', 'blocked', 'rows_deleted', 'done')) NOT VALID;`,
  ]);
});

test("a new server has no purge progress; an unknown purge_state is refused", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [row] = await db.select({ state: servers.purgeState, until: servers.purgeLeaseUntil, token: servers.purgeLeaseToken, purgedAt: servers.purgedAt }).from(servers).where(eq(servers.id, server.id));
  assert.deepEqual(row, { state: null, until: null, token: null, purgedAt: null });
  await db.update(servers).set({ purgeState: "channels" }).where(eq(servers.id, server.id));
  await assert.rejects(
    db.update(servers).set({ purgeState: "bogus" as never }).where(eq(servers.id, server.id)),
    (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("servers_purge_state_known"),
  );
});
