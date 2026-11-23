import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// oauth_clients.server_vouched_at / server_vouched_by_user_id: the backfill vouches (at migration
// time, with one audit row each) for the user-managed server_local Apps on a live Server whose
// creator is an owner or admin there now and not retired; the users key comes last, NOT VALID,
// under a 2 s lock wait (users is hot).
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
  const steps = await migration("_oauth_clients_server_vouch");
  assertBoundedLockTimeout(steps[0], "server vouch", { maxMs: 2_000 });
  assert.equal(steps[2], `ALTER TABLE "oauth_clients" ADD COLUMN "server_vouched_at" timestamp with time zone;`);
  assert.equal(steps[3], `ALTER TABLE "oauth_clients" ADD COLUMN "server_vouched_by_user_id" uuid;`);
  assert.match(steps[4]!, /^WITH vouched AS \(/);
  assert.equal(
    steps.at(-1),
    `ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_server_vouched_by_user_id_users_id_fk" FOREIGN KEY ("server_vouched_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action NOT VALID;`,
  );
});

test("an admin or owner creator's server_local App is vouched now and audited; a member's, a retired admin's, a departed one's and others are not", async () => {
  const db = new PGlite();
  const u = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const s = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const c = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  try {
    await db.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY, "retired_at" timestamptz);
      CREATE TABLE "servers" ("id" uuid PRIMARY KEY, "deleted_at" timestamptz);
      CREATE TABLE "server_members" ("server_id" uuid NOT NULL, "user_id" uuid NOT NULL, "role" text NOT NULL);
      CREATE TABLE "oauth_clients" (
        "id" uuid PRIMARY KEY, "server_id" uuid NOT NULL, "client_id" text NOT NULL, "app_type" text NOT NULL,
        "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"), "created_at" timestamptz NOT NULL DEFAULT '2025-01-01'
      );
      CREATE TABLE "external_app_registrations" ("oauth_client_id" uuid NOT NULL);
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
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "app_type", "created_by_user_id") VALUES
        ('${c(1)}', '${s(1)}', 'by-admin', 'server_local', '${u(1)}'),
        ('${c(2)}', '${s(1)}', 'by-owner', 'server_local', '${u(2)}'),
        ('${c(3)}', '${s(1)}', 'by-member', 'server_local', '${u(3)}'),
        ('${c(4)}', '${s(1)}', 'by-retired-admin', 'server_local', '${u(4)}'),
        ('${c(5)}', '${s(1)}', 'by-departed', 'server_local', '${u(5)}'),
        ('${c(6)}', '${s(1)}', 'published', 'third_party_global', '${u(1)}'),
        ('${c(7)}', '${s(2)}', 'deleted-server', 'server_local', '${u(1)}'),
        ('${c(8)}', '${s(1)}', 'platform', 'server_local', '${u(1)}');
      INSERT INTO "external_app_registrations" VALUES ('${c(8)}');
    `);
    const before = (await db.query<{ now: string }>("SELECT now()::text AS now")).rows[0]!.now;
    await db.exec("BEGIN");
    for (const step of await migration("_oauth_clients_server_vouch")) await db.exec(step);
    await db.exec("COMMIT");

    const rows = (await db.query<{ client_id: string; by: string | null; at_now: boolean | null }>(
      `SELECT client_id, server_vouched_by_user_id AS by, server_vouched_at >= '${before}'::timestamptz AS at_now FROM oauth_clients ORDER BY id`)).rows;
    assert.deepEqual(rows, [
      { client_id: "by-admin", by: u(1), at_now: true },
      { client_id: "by-owner", by: u(2), at_now: true },
      { client_id: "by-member", by: null, at_now: null },
      { client_id: "by-retired-admin", by: null, at_now: null },
      { client_id: "by-departed", by: null, at_now: null },
      { client_id: "published", by: null, at_now: null },
      { client_id: "deleted-server", by: null, at_now: null },
      { client_id: "platform", by: null, at_now: null },
    ]);

    const audit = (await db.query<Record<string, unknown>>(
      `SELECT server_id, client_id, event_type, event_category, source, actor_type, actor_id, requester_type, requester_id, target_type, target_id, metadata
         FROM integration_audit_events ORDER BY client_id`)).rows;
    assert.deepEqual(audit, [c(1), c(2)].map((id, index) => ({
      server_id: s(1), client_id: id, event_type: "app.server_vouched", event_category: "membership", source: "system",
      actor_type: "system", actor_id: null, requester_type: "human", requester_id: u(index + 1), target_type: "app", target_id: id,
      metadata: { clientKey: index === 0 ? "by-admin" : "by-owner", reason: "backfill", backfill: true },
    })));

    const constraint = (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'oauth_clients_server_vouched_by_user_id_users_id_fk'`)).rows[0];
    assert.equal(constraint?.convalidated, false);
    await assert.rejects(db.query(`UPDATE oauth_clients SET server_vouched_by_user_id = '${u(99)}' WHERE id = '${c(3)}'`), /server_vouched_by_user_id_users_id_fk/);
  } finally {
    await db.close();
  }
});
