import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { assertBoundedLockTimeout } from "../test/migrationLockTimeout";

// RFC 087 §4: owner_kind / owner_user_id on Connections, members_can_connect on Apps, the personal
// grants table, and the data step: every pin the removed ownership rule refused (bound to a Connection
// that is not the App's default and was not created by the Agent's owner) loses its Connection and stays
// pinned, so it keeps answering login_required; the count is reported as a MIGRATION_REPORT notice.
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

const SUFFIX = "_managed_mcp_personal_accounts";

test("a bounded lock wait first, and the keys to users last (the existing table's NOT VALID)", async () => {
  const steps = await migration(SUFFIX);
  assertBoundedLockTimeout(steps[0], "MCP personal accounts", { maxMs: 2_000 });
  assert.match(steps.at(-2)!, /^ALTER TABLE "managed_mcp_personal_grants" ADD CONSTRAINT "managed_mcp_personal_grants_granted_by_user_id_users_id_fk" .* REFERENCES "public"\."users"\("id"\) ON DELETE set null/);
  assert.equal(
    steps.at(-1),
    `ALTER TABLE "managed_mcp_credentials" ADD CONSTRAINT "managed_mcp_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action NOT VALID;`,
  );
  assert.equal(steps.filter((step) => /REFERENCES "public"\."users"/.test(step)).length, 2, "no other key to users");
});

test("⭐ unusable pins lose their Connection and stay pinned, the count is reported; usable pins and the rest are untouched", async () => {
  const db = new PGlite();
  const u = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const s = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const g = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const app = "40000000-0000-4000-8000-000000000001";
  const c = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  try {
    await db.exec(`
      CREATE TABLE "users" ("id" uuid PRIMARY KEY, "retired_at" timestamptz);
      CREATE TABLE "servers" ("id" uuid PRIMARY KEY);
      CREATE TABLE "agents" (
        "id" uuid PRIMARY KEY, "server_id" uuid NOT NULL REFERENCES "servers"("id"),
        "creator_type" text, "creator_id" uuid, "assistant_owner_user_id" uuid
      );
      CREATE TABLE "managed_mcp_servers" ("id" uuid PRIMARY KEY, "server_id" uuid NOT NULL);
      CREATE TABLE "managed_mcp_credentials" (
        "id" uuid PRIMARY KEY, "server_id" uuid NOT NULL, "mcp_server_id" uuid NOT NULL REFERENCES "managed_mcp_servers"("id"),
        "is_server_default" boolean NOT NULL DEFAULT true, "created_by_user_id" uuid
      );
      CREATE TABLE "managed_mcp_assignments" (
        "server_id" uuid NOT NULL, "agent_id" uuid NOT NULL, "mcp_server_id" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true, "assignment_version" integer NOT NULL DEFAULT 1,
        "connection_mode" text NOT NULL DEFAULT 'default',
        "bound_connection_id" uuid REFERENCES "managed_mcp_credentials"("id") ON DELETE SET NULL,
        "updated_at" timestamptz NOT NULL DEFAULT '2025-01-01',
        PRIMARY KEY ("agent_id", "mcp_server_id"),
        CHECK ("connection_mode" = 'pinned' OR "bound_connection_id" IS NULL)
      );
      -- 1 admin, 2 Alice, 3 Bob.
      INSERT INTO "users" VALUES ('${u(1)}', NULL), ('${u(2)}', NULL), ('${u(3)}', NULL);
      INSERT INTO "servers" VALUES ('${s(1)}');
      INSERT INTO "managed_mcp_servers" VALUES ('${app}', '${s(1)}');
      INSERT INTO "managed_mcp_credentials" VALUES
        ('${c(1)}', '${s(1)}', '${app}', true,  '${u(1)}'),  -- the default, the admin's
        ('${c(2)}', '${s(1)}', '${app}', false, '${u(1)}'),  -- the admin's, not the default
        ('${c(3)}', '${s(1)}', '${app}', false, '${u(2)}'),  -- Alice's
        ('${c(4)}', '${s(1)}', '${app}', false, NULL);        -- creator unknown
      INSERT INTO "agents" VALUES
        ('${g(1)}', '${s(1)}', 'user', '${u(2)}', NULL),     -- Alice's
        ('${g(2)}', '${s(1)}', 'user', '${u(3)}', '${u(2)}'), -- Bob created it, Alice's assistant
        ('${g(3)}', '${s(1)}', 'agent', '${g(1)}', NULL),     -- made by an agent: no owner
        ('${g(4)}', '${s(1)}', 'user', '${u(3)}', NULL),      -- Bob's
        ('${g(5)}', '${s(1)}', 'user', '${u(2)}', NULL),
        ('${g(6)}', '${s(1)}', 'user', '${u(2)}', NULL),
        ('${g(7)}', '${s(1)}', 'user', '${u(2)}', NULL),
        ('${g(8)}', '${s(1)}', 'user', '${u(2)}', NULL);
      INSERT INTO "managed_mcp_assignments" ("server_id", "agent_id", "mcp_server_id", "connection_mode", "bound_connection_id") VALUES
        ('${s(1)}', '${g(1)}', '${app}', 'pinned', '${c(3)}'),   -- usable: its owner's own
        ('${s(1)}', '${g(2)}', '${app}', 'pinned', '${c(3)}'),   -- usable: the assistant's owner's own
        ('${s(1)}', '${g(3)}', '${app}', 'pinned', '${c(2)}'),   -- UNUSABLE: no owner, not the default
        ('${s(1)}', '${g(4)}', '${app}', 'pinned', '${c(3)}'),   -- UNUSABLE: Alice's, Bob's Agent
        ('${s(1)}', '${g(5)}', '${app}', 'pinned', '${c(4)}'),   -- UNUSABLE: unknown creator
        ('${s(1)}', '${g(6)}', '${app}', 'pinned', '${c(1)}'),   -- usable: the default, whoever made it
        ('${s(1)}', '${g(7)}', '${app}', 'pinned', NULL),        -- already pinned to nothing
        ('${s(1)}', '${g(8)}', '${app}', 'default', NULL);       -- follows the default
    `);
    const reports: string[] = [];
    await db.exec("BEGIN");
    for (const step of await migration(SUFFIX)) await db.exec(step, { onNotice: (notice) => reports.push(notice.message ?? "") });
    await db.exec("COMMIT");

    assert.deepEqual(reports.filter((message) => message.startsWith("MIGRATION_REPORT")), [
      "MIGRATION_REPORT migration=managed_mcp_personal_accounts cleared_pins=3",
    ]);
    // The exact shape scripts/migrate-deploy.ts releases after commit.
    assert.match(reports.find((message) => message.startsWith("MIGRATION_REPORT"))!, /^MIGRATION_REPORT migration=[a-z][a-z0-9_]{0,79}(?: [a-z][a-z0-9_]{0,63}=[0-9]{1,30}){1,20}$/);
    const rows = (await db.query<{ agent_id: string; connection_mode: string; bound_connection_id: string | null; touched: boolean }>(
      `SELECT agent_id, connection_mode, bound_connection_id, updated_at > '2025-01-01' AS touched FROM managed_mcp_assignments ORDER BY agent_id`)).rows;
    assert.deepEqual(rows, [
      { agent_id: g(1), connection_mode: "pinned", bound_connection_id: c(3), touched: false },
      { agent_id: g(2), connection_mode: "pinned", bound_connection_id: c(3), touched: false },
      { agent_id: g(3), connection_mode: "pinned", bound_connection_id: null, touched: true },
      { agent_id: g(4), connection_mode: "pinned", bound_connection_id: null, touched: true },
      { agent_id: g(5), connection_mode: "pinned", bound_connection_id: null, touched: true },
      { agent_id: g(6), connection_mode: "pinned", bound_connection_id: c(1), touched: false },
      { agent_id: g(7), connection_mode: "pinned", bound_connection_id: null, touched: false },
      { agent_id: g(8), connection_mode: "default", bound_connection_id: null, touched: false },
    ]);

    // Every existing Connection is shared, no App lets members connect yet.
    assert.deepEqual((await db.query(`SELECT DISTINCT owner_kind, owner_user_id FROM managed_mcp_credentials`)).rows, [{ owner_kind: "shared", owner_user_id: null }]);
    assert.deepEqual((await db.query(`SELECT members_can_connect FROM managed_mcp_servers`)).rows, [{ members_can_connect: false }]);
    // An insert that names neither (the previous binary's) is a shared Connection.
    await db.query(`INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, is_server_default) VALUES ('${c(9)}', '${s(1)}', '${app}', false)`);
    // The guard and the CHECK are live; the users key is NOT VALID but enforced for new rows.
    await db.query(`INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, is_server_default, owner_kind, owner_user_id) VALUES ('${c(5)}', '${s(1)}', '${app}', false, 'personal', '${u(2)}')`);
    await assert.rejects(
      db.query(`INSERT INTO managed_mcp_credentials (id, server_id, mcp_server_id, is_server_default, owner_kind, owner_user_id) VALUES ('${c(6)}', '${s(1)}', '${app}', false, 'personal', '${u(99)}')`),
      /owner_user_id_users_id_fk/,
    );
    await assert.rejects(
      db.query(`INSERT INTO managed_mcp_personal_grants (server_id, agent_id, mcp_server_id, connection_id) VALUES ('${s(1)}', '${g(4)}', '${app}', '${c(2)}')`),
      /personal Connection of the same App/,
    );
    await db.query(`INSERT INTO managed_mcp_personal_grants (server_id, agent_id, mcp_server_id, connection_id, granted_by_user_id) VALUES ('${s(1)}', '${g(4)}', '${app}', '${c(5)}', '${u(2)}')`);
    // ⭐ Owner kind and owner are fixed at insert; other columns of the row still update.
    for (const change of [`owner_kind = 'shared', owner_user_id = NULL`, `owner_user_id = '${u(3)}'`]) {
      await assert.rejects(db.query(`UPDATE managed_mcp_credentials SET ${change} WHERE id = '${c(5)}'`), /owner_kind and owner_user_id cannot change/, change);
    }
    await assert.rejects(db.query(`UPDATE managed_mcp_credentials SET owner_kind = 'personal', owner_user_id = '${u(2)}', is_server_default = false WHERE id = '${c(2)}'`),
      /cannot change/, "a shared Connection never becomes someone's own");
    await db.query(`UPDATE managed_mcp_credentials SET owner_kind = 'personal', owner_user_id = '${u(2)}', is_server_default = false WHERE id = '${c(5)}'`);
    const constraint = (await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'managed_mcp_credentials_owner_user_id_users_id_fk'`)).rows[0];
    assert.equal(constraint?.convalidated, false);
  } finally {
    await db.close();
  }
});
