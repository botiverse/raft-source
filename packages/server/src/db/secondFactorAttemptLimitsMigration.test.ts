import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0532 adds the per-person second-step attempt window
// (second_factor_attempt_windows) and session_families.reauthenticated_at.
// Additive only: existing families keep NULL, the new table starts empty and
// goes with its person.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0532_second_factor_attempt_limits";

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
const F1 = "00000000-0000-4000-8000-0000000000f1";

test("0532 adds the attempt window and the re-authentication marker without touching existing rows", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'attempt-window@slock.test', 'attempt-window', 'test');
      INSERT INTO "session_families" ("id", "user_id") VALUES ('${F1}', '${U1}');
    `);

    await client.exec("BEGIN");
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    await client.exec("COMMIT");

    const existing = await client.query<{ reauthenticated_at: Date | null }>(`SELECT "reauthenticated_at" FROM "session_families" WHERE "id" = '${F1}'`);
    assert.deepEqual(existing.rows, [{ reauthenticated_at: null }]);
    await client.exec(`UPDATE "session_families" SET "reauthenticated_at" = now() WHERE "id" = '${F1}'`);

    // One window per person, for a person who exists; required columns.
    await client.exec(`INSERT INTO "second_factor_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('${U1}', now(), 1)`);
    await rejects(client, `INSERT INTO "second_factor_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('${U1}', now(), 1)`, /second_factor_attempt_windows_pkey/);
    await rejects(client, `INSERT INTO "second_factor_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('00000000-0000-4000-8000-0000000000ff', now(), 1)`, /second_factor_attempt_windows_user_id_users_id_fk/);
    await rejects(client, `UPDATE "second_factor_attempt_windows" SET "attempts" = NULL`, /null value/);
    const window = await client.query<{ locked_until: Date | null }>(`SELECT "locked_until" FROM "second_factor_attempt_windows"`);
    assert.deepEqual(window.rows, [{ locked_until: null }]);

    // It goes with the person.
    await client.exec(`DELETE FROM "session_families" WHERE "user_id" = '${U1}'; DELETE FROM "users" WHERE "id" = '${U1}'`);
    const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "second_factor_attempt_windows"`);
    assert.equal(left.rows[0]!.n, 0);
  } finally {
    await client.close();
  }
});
