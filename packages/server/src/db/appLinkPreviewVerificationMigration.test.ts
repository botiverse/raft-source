import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0405: an App link preview registration's last successful domain proof
// is updated_at (the only writer re-proved before every upsert), so both proof
// columns start there; nothing starts suspended.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0405_app_link_preview_verification";

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

const U1 = "00000000-0000-4000-8000-0000000000a1";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";

test("0405 starts each link preview registration's proof times at updated_at, unsuspended; a suspension needs its reason", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'proof@slock.test', 'proof', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${S1}', 'Proof', 'proof', '${U1}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id") VALUES
        ('${C1}', '${S1}', 'proof-app-1', 'hash', 'Proof App 1', '${U1}'),
        ('${C2}', '${S1}', 'proof-app-2', 'hash', 'Proof App 2', '${U1}');
      INSERT INTO "oauth_app_link_previews" ("client_id", "origin", "endpoint", "paths", "revision", "updated_at") VALUES
        ('${C1}', 'https://one.example.test', 'https://one.example.test/cb', '["/a"]', gen_random_uuid(), '2026-01-01T00:00:00Z'),
        ('${C2}', 'https://two.example.test', 'https://two.example.test/cb', '["/b"]', gen_random_uuid(), '2026-05-01T00:00:00Z');
    `);
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    const rows = (await client.query<{ client_id: string; verified_at: Date; last_checked_at: Date; suspended_at: Date | null; suspended_reason: string | null }>(
      `SELECT "client_id", "verified_at", "last_checked_at", "suspended_at", "suspended_reason" FROM "oauth_app_link_previews" ORDER BY "client_id"`,
    )).rows.map((row) => ({ client: row.client_id, verified: row.verified_at.toISOString(), checked: row.last_checked_at.toISOString(), suspendedAt: row.suspended_at, reason: row.suspended_reason }));
    assert.deepEqual(rows, [
      { client: C1, verified: "2026-01-01T00:00:00.000Z", checked: "2026-01-01T00:00:00.000Z", suspendedAt: null, reason: null },
      { client: C2, verified: "2026-05-01T00:00:00.000Z", checked: "2026-05-01T00:00:00.000Z", suspendedAt: null, reason: null },
    ]);
    await assert.rejects(client.exec(`UPDATE "oauth_app_link_previews" SET "suspended_at" = now() WHERE "client_id" = '${C1}'`), /oauth_app_link_previews_suspension/);
    await client.exec(`UPDATE "oauth_app_link_previews" SET "suspended_at" = now(), "suspended_reason" = 'proof_mismatch' WHERE "client_id" = '${C1}'`);
  } finally {
    await client.close();
  }
});
