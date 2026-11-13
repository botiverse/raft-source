import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0537 adds reauth_attempt_windows: password re-authentication's own
// per-person attempt window, apart from second_factor_attempt_windows.
// Additive only: the new table starts empty and goes with its person.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0537_reauth_attempt_windows";

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

test("0537 adds the re-authentication attempt window beside the second-step one", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'reauth-window@slock.test', 'reauth-window', 'test');
      INSERT INTO "second_factor_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('${U1}', now(), 3);
    `);

    await client.exec("BEGIN");
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    await client.exec("COMMIT");

    // The second-step window is left as it was; the new one starts empty.
    const secondStep = await client.query<{ attempts: number }>(`SELECT "attempts" FROM "second_factor_attempt_windows" WHERE "user_id" = '${U1}'`);
    assert.deepEqual(secondStep.rows, [{ attempts: 3 }]);
    const empty = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "reauth_attempt_windows"`);
    assert.equal(empty.rows[0]!.n, 0);

    // One window per person, for a person who exists; required columns.
    await client.exec(`INSERT INTO "reauth_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('${U1}', now(), 1)`);
    await rejects(client, `INSERT INTO "reauth_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('${U1}', now(), 1)`, /reauth_attempt_windows_pkey/);
    await rejects(client, `INSERT INTO "reauth_attempt_windows" ("user_id", "window_started_at", "attempts") VALUES ('00000000-0000-4000-8000-0000000000ff', now(), 1)`, /reauth_attempt_windows_user_id_users_id_fk/);
    await rejects(client, `UPDATE "reauth_attempt_windows" SET "attempts" = NULL`, /null value/);
    await rejects(client, `UPDATE "reauth_attempt_windows" SET "window_started_at" = NULL`, /null value/);
    const window = await client.query<{ locked_until: Date | null }>(`SELECT "locked_until" FROM "reauth_attempt_windows"`);
    assert.deepEqual(window.rows, [{ locked_until: null }]);

    // It goes with the person.
    await client.exec(`DELETE FROM "users" WHERE "id" = '${U1}'`);
    const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "reauth_attempt_windows"`);
    assert.equal(left.rows[0]!.n, 0);
  } finally {
    await client.close();
  }
});
