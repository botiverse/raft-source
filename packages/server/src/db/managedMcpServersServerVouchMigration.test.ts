import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// managed_mcp_servers.server_vouched_at / server_vouched_by_user_id: the backfill vouches (at
// migration time, with one audit row each) for the MCP Apps on a live Server whose creator is an
// owner or admin there now and not retired (by that creator), and for those with no recorded creator
// (by nobody, reason legacy_no_creator: they reached every agent before the rule became fail-closed);
// the users key comes last, NOT VALID, under a 2 s lock wait.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

function statements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

async function migration(suffix: string): Promise<string[]> {
  const entries = (JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> }).entries;
  const entry = entries.find((candidate) => candidate.tag.endsWith(suffix));
  assert.ok(entry, `${suffix} is in the journal`);
  return statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"));
}

test("a bounded lock wait, the columns, the backfill, and the foreign key last and NOT VALID", async () => {
  const steps = await migration("_managed_mcp_servers_server_vouch");
  assertBoundedLockTimeout(steps[0], "MCP server vouch", { maxMs: 2_000 });
  assert.equal(steps[2], `ALTER TABLE "managed_mcp_servers" ADD COLUMN "server_vouched_at" timestamp with time zone;`);
  assert.equal(steps[3], `ALTER TABLE "managed_mcp_servers" ADD COLUMN "server_vouched_by_user_id" uuid;`);
  assert.match(steps[4]!, /^WITH vouched AS \(/);
  assert.equal(
    steps.at(-1),
    `ALTER TABLE "managed_mcp_servers" ADD CONSTRAINT "managed_mcp_servers_server_vouched_by_user_id_users_id_fk" FOREIGN KEY ("server_vouched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;`,
  );
});

test("an admin or owner creator's MCP App, and a creatorless one, are vouched now and audited; a member's, a retired admin's, a departed one's and a deleted Server's are not", async () => {
  const db = new PGlite();
  const u = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const s = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const a = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  try {
    await db.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY, "retired_at" timestamptz);
      CREATE TABLE "servers" ("id" uuid PRIMARY KEY, "deleted_at" timestamptz);
      CREATE TABLE "server_members" ("server_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" text NOT NULL);
      CREATE TABLE "managed_mcp_servers" (
        "id" uuid PRIMARY KEY, "server_id" uuid NOT NULL, "name" text NOT NULL,
        "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL, "created_at" timestamptz NOT NULL DEFAULT '2025-01-01'
      );
      CREATE TABLE "integration_audit_events" (
        "id" uuid PRIMARY KEY, "server_id" uuid, "client_id" uuid, "event_type" text NOT NULL, "event_category" text NOT NULL,
        "outcome" text NOT NULL, "source" text NOT NULL, "actor_type" text NOT NULL, "actor_id" uuid,
        "requester_type" text, "requester_id" uuid, "subject_type" text, "subject_id" uuid,
        "target_type" text NOT NULL, "target_id" uuid, "metadata" jsonb NOT NULL DEFAULT '{}'
      );
      -- 1 admin, 2 owner, 3 member, 4 retired admin, 5 left the server.
      INSERT INTO "users" VALUES ('${u(1)}', NULL), ('${u(2)}', NULL), ('${u(3)}', NULL), ('${u(4)}', now()), ('${u(5)}', NULL);
      INSERT INTO "servers" VALUES ('${s(1)}', NULL), ('${s(2)}', now());
      INSERT INTO "server_members" VALUES
        ('${s(1)}', '${u(1)}', 'admin'), ('${s(1)}', '${u(2)}', 'owner'), ('${s(1)}', '${u(3)}', 'member'), ('${s(1)}', '${u(4)}', 'admin'),
        ('${s(2)}', '${u(1)}', 'admin');
      INSERT INTO "managed_mcp_servers" ("id", "server_id", "name", "created_by_user_id") VALUES
        ('${a(1)}', '${s(1)}', 'By admin', '${u(1)}'),
        ('${a(2)}', '${s(1)}', 'By owner', '${u(2)}'),
        ('${a(3)}', '${s(1)}', 'By member', '${u(3)}'),
        ('${a(4)}', '${s(1)}', 'By retired admin', '${u(4)}'),
        ('${a(5)}', '${s(1)}', 'By departed', '${u(5)}'),
        ('${a(6)}', '${s(1)}', 'No creator', NULL),
        ('${a(7)}', '${s(2)}', 'Deleted server', '${u(1)}'),
        ('${a(8)}', '${s(2)}', 'No creator, deleted server', NULL);
    `);
    const before = (await db.query<{ now: string }>("SELECT now()::text AS now")).rows[0]!.now;
    await db.exec("BEGIN");
    for (const step of await migration("_managed_mcp_servers_server_vouch")) await db.exec(step);
    await db.exec("COMMIT");

    const rows = (await db.query<{ name: string; by: string | null; at_now: boolean | null }>(
      `SELECT name, server_vouched_by_user_id AS by, server_vouched_at >= '${before}'::timestamptz AS at_now FROM managed_mcp_servers ORDER BY id`)).rows;
    assert.deepEqual(rows, [
      { name: "By admin", by: u(1), at_now: true },
      { name: "By owner", by: u(2), at_now: true },
      { name: "By member", by: null, at_now: null },
      { name: "By retired admin", by: null, at_now: null },
      { name: "By departed", by: null, at_now: null },
      { name: "No creator", by: null, at_now: true },
      { name: "Deleted server", by: null, at_now: null },
      { name: "No creator, deleted server", by: null, at_now: null },
    ]);

    const audit = (await db.query<Record<string, unknown>>(
      `SELECT server_id, client_id, event_type, event_category, source, actor_type, actor_id, requester_type, requester_id, subject_type, subject_id, target_type, target_id, metadata
         FROM integration_audit_events ORDER BY target_id`)).rows;
    const row = (id: string, requesterId: string | null, appName: string, reason: string) => ({
      server_id: s(1), client_id: null, event_type: "app.server_vouched", event_category: "membership", source: "system",
      actor_type: "system", actor_id: null, requester_type: requesterId ? "human" : null, requester_id: requesterId, subject_type: "app", subject_id: id,
      target_type: "managed_mcp_server", target_id: id,
      metadata: { appName, reason, backfill: true },
    });
    assert.deepEqual(audit, [
      row(a(1), u(1), "By admin", "backfill"),
      row(a(2), u(2), "By owner", "backfill"),
      row(a(6), null, "No creator", "legacy_no_creator"),
    ]);

    const constraint = (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'managed_mcp_servers_server_vouched_by_user_id_users_id_fk'`)).rows[0];
    assert.equal(constraint?.convalidated, false);
    await assert.rejects(db.query(`UPDATE managed_mcp_servers SET server_vouched_by_user_id = '${u(99)}' WHERE id = '${a(3)}'`), /server_vouched_by_user_id_users_id_fk/);
    // The voucher's account deleted: the vouch stays.
    await db.query(`DELETE FROM server_members WHERE user_id = '${u(1)}'`);
    await db.query(`DELETE FROM users WHERE id = '${u(1)}'`);
    const kept = (await db.query<{ at: boolean; by: string | null }>(
      `SELECT server_vouched_at IS NOT NULL AS at, server_vouched_by_user_id AS by FROM managed_mcp_servers WHERE id = '${a(1)}'`)).rows[0];
    assert.deepEqual(kept, { at: true, by: null });
  } finally {
    await db.close();
  }
});
