import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// data_exports (#triage:#512): the export jobs table, and the export flow's
// own emailed-code kind on auth_challenges. Additive: the new table starts
// empty, the kind list is a superset (rows already there still pass).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0734_data_exports";

function statements(sqlText: string): string[] {
  return sqlText.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

async function applyBefore(client: PGlite, tag: string): Promise<void> {
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const target = journal.entries.find((entry) => entry.tag === tag);
  assert.ok(target, `${tag} is in the journal`);
  await client.exec("BEGIN");
  try {
    for (const entry of journal.entries.filter((candidate) => candidate.idx < target.idx)) {
      for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8"))) await client.exec(statement);
    }
    await client.exec("COMMIT");
  } catch (error) {
    await client.exec("ROLLBACK");
    throw error;
  }
}

async function rejects(client: PGlite, sqlText: string, pattern: RegExp): Promise<void> {
  await assert.rejects(client.exec(sqlText), pattern);
}

const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const U3 = "00000000-0000-4000-8000-0000000000a3";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const F1 = "00000000-0000-4000-8000-0000000000c1";

function row(input: { id: string; kind?: string; user?: string; server?: string | null; status?: string; extra?: string }): string {
  const kind = input.kind ?? "personal";
  const server = input.server === undefined ? (kind === "server" ? `'${S1}'` : "NULL") : input.server === null ? "NULL" : `'${input.server}'`;
  return `INSERT INTO "data_exports" ("id", "kind", "requester_user_id", "requester_session_family_id", "server_id", "scope", "scope_version", "status", "created_at", "updated_at"${input.extra ? `, ${input.extra.split("=")[0]}` : ""})
    VALUES ('${input.id}', '${kind}', '${input.user ?? U1}', '${F1}', ${server}, '{}'::jsonb, 1, '${input.status ?? "queued"}', now(), now()${input.extra ? `, ${input.extra.split("=")[1]}` : ""})`;
}

test("0734 adds data_exports and the data export email code kind", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'export-1@slock.test', 'export-1', 'test'), ('${U2}', 'export-2@slock.test', 'export-2', 'test'), ('${U3}', 'export-3@slock.test', 'export-3', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${S1}', 'Export', 'export-migration', '${U1}');
      INSERT INTO "auth_challenges" ("id", "user_id", "kind", "challenge_hash", "flow", "expires_at") VALUES (gen_random_uuid(), '${U1}', 'account_deletion_email_code', 'h-before', 'account_deletion', now() + interval '10 minutes');
    `);
    await rejects(client, `INSERT INTO "auth_challenges" ("id", "user_id", "kind", "challenge_hash", "flow", "expires_at") VALUES (gen_random_uuid(), '${U1}', 'data_export_email_code', 'h-early', 'data_export', now())`, /auth_challenges_kind_check/);

    await client.exec("BEGIN");
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    await client.exec("COMMIT");

    // Swapped without a scan: the new CHECK is NOT VALID, and the swap is the migration's last two statements.
    const swapped = await client.query<{ convalidated: boolean }>(`SELECT convalidated FROM pg_constraint WHERE conname = 'auth_challenges_kind_check'`);
    assert.deepEqual(swapped.rows, [{ convalidated: false }]);
    const tail = statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8")).slice(-2);
    assert.match(tail[0]!, /DROP CONSTRAINT "auth_challenges_kind_check"/);
    assert.match(tail[1]!, /ADD CONSTRAINT "auth_challenges_kind_check".*NOT VALID;?$/s);
    // The kind list grew; the earlier row still passes, an unknown kind does not.
    await client.exec(`INSERT INTO "auth_challenges" ("id", "user_id", "kind", "challenge_hash", "flow", "expires_at") VALUES (gen_random_uuid(), '${U1}', 'data_export_email_code', 'h-after', 'data_export', now())`);
    await rejects(client, `INSERT INTO "auth_challenges" ("id", "user_id", "kind", "challenge_hash", "expires_at") VALUES (gen_random_uuid(), '${U1}', 'something_else', 'h-bad', now())`, /auth_challenges_kind_check/);
    const kinds = await client.query<{ kind: string }>(`SELECT "kind" FROM "auth_challenges" ORDER BY "kind"`);
    assert.deepEqual(kinds.rows.map((r) => r.kind), ["account_deletion_email_code", "data_export_email_code"]);

    // A personal export names no server; a server export names one.
    await client.exec(row({ id: "00000000-0000-4000-8000-000000000001" }));
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000002", user: U2, server: S1 }), /data_exports_server_kind/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000003", user: U2, kind: "server", server: null }), /data_exports_server_kind/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000004", user: U2, kind: "other" }), /data_exports_kind_valid/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000005", user: U2, status: "paused" }), /data_exports_status_valid/);
    // Ready needs its finish and expiry; deleted needs deleted_at, and only deleted has it.
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000006", user: U2, status: "ready" }), /data_exports_ready_expires/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000007", user: U2, status: "deleted" }), /data_exports_deleted_at/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000008", user: U2, status: "failed", extra: `"deleted_at"=now()` }), /data_exports_deleted_at/);

    // One in flight per person (any kind) ...
    await rejects(client, row({ id: "00000000-0000-4000-8000-000000000009", status: "running" }), /idx_data_exports_requester_in_flight/);
    await rejects(client, row({ id: "00000000-0000-4000-8000-00000000000a", kind: "server" }), /idx_data_exports_requester_in_flight/);
    // ... and per server; finished ones don't count.
    await client.exec(row({ id: "00000000-0000-4000-8000-00000000000b", user: U2, kind: "server" }));
    await rejects(client, row({ id: "00000000-0000-4000-8000-00000000000c", user: U3, kind: "server", status: "running" }), /idx_data_exports_server_in_flight/);
    await client.exec(row({ id: "00000000-0000-4000-8000-00000000000e", user: U3 }));
    await client.exec(`UPDATE "data_exports" SET "status" = 'failed', "finished_at" = now() WHERE "id" = '00000000-0000-4000-8000-000000000001'`);
    await client.exec(row({ id: "00000000-0000-4000-8000-00000000000d" }));
    const volumes = await client.query<{ volumes: unknown }>(`SELECT "volumes" FROM "data_exports" WHERE "id" = '00000000-0000-4000-8000-00000000000d'`);
    assert.deepEqual(volumes.rows[0]!.volumes, []);

    // The rows go with their person and with their server.
    await client.exec(`DELETE FROM "servers" WHERE "id" = '${S1}'`);
    const afterServer = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "data_exports" WHERE "kind" = 'server'`);
    assert.equal(afterServer.rows[0]!.n, 0);
    await client.exec(`DELETE FROM "users" WHERE "id" = '${U1}'`);
    const left = await client.query<{ requester_user_id: string }>(`SELECT "requester_user_id" FROM "data_exports"`);
    assert.deepEqual(left.rows.map((r) => r.requester_user_id), [U3], "only someone else's export is left");
  } finally {
    await client.close();
  }
});
