import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0406 adds how a consent was granted. Every consent recorded before it came
// from a Login with Raft, so existing rows (active or revoked) become `login`.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0406_link_preview_consent_prompt";

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

test("0406 marks every existing consent as granted by login and only accepts the two sources", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'prompt-1@slock.test', 'prompt-1', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${S1}', 'Prompt 1', 'prompt-1', '${U1}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id") VALUES
        ('${C1}', '${S1}', 'prompt-app-1', 'hash', 'Prompt App 1', '${U1}'),
        ('${C2}', '${S1}', 'prompt-app-2', 'hash', 'Prompt App 2', '${U1}');
      INSERT INTO "oauth_user_consents" ("id", "user_id", "server_id", "client_id", "scopes", "revoked_at") VALUES
        (gen_random_uuid(), '${U1}', '${S1}', '${C1}', '["openid","profile"]', NULL),
        (gen_random_uuid(), '${U1}', '${S1}', '${C2}', '["openid"]', '2026-04-02T00:00:00Z');
    `);

    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);

    const sources = await client.query<{ client_id: string; source: string; revoked: boolean }>(
      `SELECT "client_id", "source", "revoked_at" IS NOT NULL AS "revoked" FROM "oauth_user_consents" ORDER BY "client_id"`,
    );
    assert.deepEqual(sources.rows, [
      { client_id: C1, source: "login", revoked: false },
      { client_id: C2, source: "login", revoked: true },
    ]);
    await client.query(`UPDATE "oauth_user_consents" SET "source" = 'preview_prompt' WHERE "client_id" = $1`, [C1]);
    await assert.rejects(client.query(`UPDATE "oauth_user_consents" SET "source" = 'admin' WHERE "client_id" = $1`, [C1]), /oauth_user_consents_source_check/);

    // One decline per (person, Server, App); deleting the App takes it along.
    await client.query(`INSERT INTO "oauth_link_preview_declines" ("id", "user_id", "server_id", "client_id") VALUES (gen_random_uuid(), $1, $2, $3)`, [U1, S1, C1]);
    await assert.rejects(
      client.query(`INSERT INTO "oauth_link_preview_declines" ("id", "user_id", "server_id", "client_id") VALUES (gen_random_uuid(), $1, $2, $3)`, [U1, S1, C1]),
      /idx_oauth_link_preview_declines_user_server_client/,
    );
    await client.query(`DELETE FROM "oauth_clients" WHERE "id" = $1`, [C1]);
    assert.equal((await client.query(`SELECT 1 FROM "oauth_link_preview_declines"`)).rows.length, 0);
  } finally {
    await client.close();
  }
});
