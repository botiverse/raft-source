import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// The TOTP re-bind migration adds user_totp.pending_secret_ciphertext and
// pending_created_at. Additive only: an existing confirmed secret is kept as
// it was, with no pending one.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0536_second_factor_totp_rebind";

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

test("the TOTP re-bind migration adds the pending secret without touching the confirmed one", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'totp-rebind@slock.test', 'totp-rebind', 'test');
      INSERT INTO "user_totp" ("user_id", "secret_ciphertext", "confirmed_at", "last_used_step") VALUES ('${U1}', 'v1:old', now(), 7);
    `);

    await client.exec("BEGIN");
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    await client.exec("COMMIT");

    const existing = await client.query<{ secret_ciphertext: string; last_used_step: string; pending_secret_ciphertext: string | null; pending_created_at: Date | null }>(
      `SELECT "secret_ciphertext", "last_used_step", "pending_secret_ciphertext", "pending_created_at" FROM "user_totp" WHERE "user_id" = '${U1}'`,
    );
    assert.deepEqual(existing.rows.map((row) => ({ ...row, last_used_step: Number(row.last_used_step) })), [
      { secret_ciphertext: "v1:old", last_used_step: 7, pending_secret_ciphertext: null, pending_created_at: null },
    ]);
    await client.exec(`UPDATE "user_totp" SET "pending_secret_ciphertext" = 'v1:new', "pending_created_at" = now() WHERE "user_id" = '${U1}'`);
    const pending = await client.query<{ pending_secret_ciphertext: string }>(`SELECT "pending_secret_ciphertext" FROM "user_totp"`);
    assert.deepEqual(pending.rows, [{ pending_secret_ciphertext: "v1:new" }]);
  } finally {
    await client.close();
  }
});
