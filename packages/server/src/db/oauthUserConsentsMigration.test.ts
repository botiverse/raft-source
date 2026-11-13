import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0402 backfills one consent per (person, Server, App) from human tokens so
// link previews keep showing for people who logged in before the table
// existed: scopes are the union, revoked_at follows the latest token.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0402_oauth_user_consents";

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
const U2 = "00000000-0000-4000-8000-0000000000a2";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const S2 = "00000000-0000-4000-8000-0000000000b2";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";

test("0402 backfills one consent per person, Server and App from their human tokens, and re-running changes nothing", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
        ('${U1}', 'consent-1@slock.test', 'consent-1', 'test'),
        ('${U2}', 'consent-2@slock.test', 'consent-2', 'test');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES
        ('${S1}', 'Consent 1', 'consent-1', '${U1}'),
        ('${S2}', 'Consent 2', 'consent-2', '${U2}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id") VALUES
        ('${C1}', '${S1}', 'consent-app-1', 'hash', 'Consent App 1', '${U1}'),
        ('${C2}', '${S1}', 'consent-app-2', 'hash', 'Consent App 2', '${U1}');
    `);
    const token = async (row: { user: string | null; server: string; client: string; scopes: string; createdAt: string; revokedAt?: string; principal?: string }) =>
      client.query(
        `INSERT INTO "oauth_access_tokens" ("id", "server_id", "principal_type", "user_id", "client_id", "token_hash", "scopes", "expires_at", "revoked_at", "created_at")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid()::text, $5::json, $6::timestamptz + interval '1 hour', $7, $6)`,
        [row.server, row.principal ?? "human", row.user, row.client, row.scopes, row.createdAt, row.revokedAt ?? null],
      );
    // U1/S1/C1: logins with mixed scopes; an early one revoked, the latest live but long expired.
    await token({ user: U1, server: S1, client: C1, scopes: '["openid"]', createdAt: "2026-01-01T00:00:00Z", revokedAt: "2026-01-02T00:00:00Z" });
    await token({ user: U1, server: S1, client: C1, scopes: '["profile","openid"]', createdAt: "2026-02-01T00:00:00Z" });
    await token({ user: U1, server: S1, client: C1, scopes: '["email","openid"]', createdAt: "2026-03-01T00:00:00Z" });
    // U1/S1/C2: the most recent token was revoked, so the pair stays revoked.
    await token({ user: U1, server: S1, client: C2, scopes: '["openid","profile"]', createdAt: "2026-01-05T00:00:00Z" });
    await token({ user: U1, server: S1, client: C2, scopes: '["openid","profile"]', createdAt: "2026-04-01T00:00:00Z", revokedAt: "2026-04-02T00:00:00Z" });
    // U2/S2/C1: one token with no scopes still records the login.
    await token({ user: U2, server: S2, client: C1, scopes: "[]", createdAt: "2026-05-01T00:00:00Z" });
    // U2/S1/C1: two tokens minted at the same instant, one revoked: fail closed.
    await token({ user: U2, server: S1, client: C1, scopes: '["openid","profile"]', createdAt: "2026-06-01T00:00:00Z" });
    await token({ user: U2, server: S1, client: C1, scopes: '["openid","profile"]', createdAt: "2026-06-01T00:00:00Z", revokedAt: "2026-06-02T00:00:00Z" });
    // Not a person's login: an agent-principal token and a human token without a user.
    await token({ user: U2, server: S1, client: C2, scopes: '["openid","profile"]', createdAt: "2026-07-01T00:00:00Z", principal: "agent" });
    await token({ user: null, server: S2, client: C2, scopes: '["openid","profile"]', createdAt: "2026-07-01T00:00:00Z" });

    const migration = await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8");
    for (const statement of statements(migration)) await client.exec(statement);

    const consents = async () => (await client.query<{ user_id: string; server_id: string; client_id: string; scopes: string[]; granted_at: Date; updated_at: Date; revoked_at: Date | null }>(
      `SELECT "user_id", "server_id", "client_id", "scopes", "granted_at", "updated_at", "revoked_at" FROM "oauth_user_consents" ORDER BY "user_id", "server_id", "client_id"`,
    )).rows.map((row) => ({
      user: row.user_id, server: row.server_id, client: row.client_id, scopes: row.scopes,
      grantedAt: row.granted_at.toISOString(), updatedAt: row.updated_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
    }));
    const expected = [
      { user: U1, server: S1, client: C1, scopes: ["email", "openid", "profile"], grantedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", revokedAt: null },
      { user: U1, server: S1, client: C2, scopes: ["openid", "profile"], grantedAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z", revokedAt: "2026-04-02T00:00:00.000Z" },
      { user: U2, server: S1, client: C1, scopes: ["openid", "profile"], grantedAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z", revokedAt: "2026-06-02T00:00:00.000Z" },
      { user: U2, server: S2, client: C1, scopes: [], grantedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z", revokedAt: null },
    ];
    assert.deepEqual(await consents(), expected);

    // A consent written after the first run (a fresh login) survives a re-run.
    await client.query(`UPDATE "oauth_user_consents" SET "revoked_at" = NULL, "scopes" = '["openid","profile"]'::json WHERE "user_id" = $1 AND "client_id" = $2 AND "server_id" = $3`, [U1, C2, S1]);
    const relogin = { ...expected[1]!, scopes: ["openid", "profile"], revokedAt: null };
    const backfill = statements(migration).at(-1)!;
    assert.match(backfill, /^(--.*\n)*INSERT INTO "oauth_user_consents"/);
    await client.exec(backfill);
    assert.deepEqual(await consents(), [expected[0], relogin, expected[2], expected[3]]);
  } finally {
    await client.close();
  }
});
