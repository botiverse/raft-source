import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0531 adds the two-step verification data (passkeys, TOTP, backup codes,
// auth challenges, the second-factor columns) and the approver family on app
// and device logins. Additive only: existing rows keep NULL, the constraints
// on existing tables are NOT VALID (no scan), and the new checks hold for
// rows written after it.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0531_second_factor_data";

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
const F2 = "00000000-0000-4000-8000-0000000000f2";
const R1 = "00000000-0000-4000-8000-0000000000c1";
const D1 = "00000000-0000-4000-8000-0000000000d1";

test("0531 adds the second-factor data without touching existing rows; its checks and foreign keys hold", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${U1}', 'second-factor@slock.test', 'second-factor', 'test');
      INSERT INTO "session_families" ("id", "user_id") VALUES ('${F1}', '${U1}'), ('${F2}', '${U1}');
      INSERT INTO "app_login_requests" ("id", "code_challenge", "return_uri", "expires_at") VALUES ('${R1}', 'challenge', 'raft://login/callback', now() + interval '10 minutes');
      INSERT INTO "device_authorizations" ("id", "device_code_lookup_hash", "device_code_hash", "user_code", "expires_at") VALUES ('${D1}', '\\x01', 'hash', 'ABCD-1234', now() + interval '10 minutes');
    `);

    await client.exec("BEGIN");
    for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
    await client.exec("COMMIT");

    // Existing rows: every new column NULL.
    const existing = await client.query<Record<string, unknown>>(`
      SELECT
        (SELECT "second_factor_required_at" FROM "users" WHERE "id" = '${U1}') AS required_at,
        (SELECT "second_factor_verified_at" FROM "session_families" WHERE "id" = '${F1}') AS verified_at,
        (SELECT "second_factor_method" FROM "session_families" WHERE "id" = '${F1}') AS method,
        (SELECT "approver_family_id" FROM "app_login_requests" WHERE "id" = '${R1}') AS app_login_family,
        (SELECT "approver_family_id" FROM "device_authorizations" WHERE "id" = '${D1}') AS device_family
    `);
    assert.deepEqual(existing.rows[0], { required_at: null, verified_at: null, method: null, app_login_family: null, device_family: null });

    // Constraints on existing tables are NOT VALID (no scan under the lock).
    const constraints = await client.query<{ conname: string; convalidated: boolean }>(`
      SELECT "conname", "convalidated" FROM "pg_constraint"
      WHERE "conname" IN (
        'app_login_requests_approver_family_id_session_families_id_fk',
        'device_authorizations_approver_family_id_session_families_id_fk',
        'session_families_second_factor_check'
      ) ORDER BY "conname"
    `);
    assert.deepEqual(constraints.rows, [
      { conname: "app_login_requests_approver_family_id_session_families_id_fk", convalidated: false },
      { conname: "device_authorizations_approver_family_id_session_families_id_fk", convalidated: false },
      { conname: "session_families_second_factor_check", convalidated: false },
    ]);

    // A family's verification is both columns or neither, with a known method.
    await client.exec(`UPDATE "session_families" SET "second_factor_verified_at" = now(), "second_factor_method" = 'totp' WHERE "id" = '${F1}'`);
    await rejects(client, `UPDATE "session_families" SET "second_factor_verified_at" = now() WHERE "id" = '${F2}'`, /session_families_second_factor_check/);
    await rejects(client, `UPDATE "session_families" SET "second_factor_method" = 'passkey' WHERE "id" = '${F2}'`, /session_families_second_factor_check/);
    await rejects(client, `UPDATE "session_families" SET "second_factor_verified_at" = now(), "second_factor_method" = 'sms' WHERE "id" = '${F2}'`, /session_families_second_factor_check/);

    // Approver family: set, then SET NULL when the family goes.
    await client.exec(`
      UPDATE "app_login_requests" SET "approver_family_id" = '${F2}' WHERE "id" = '${R1}';
      UPDATE "device_authorizations" SET "approver_family_id" = '${F2}' WHERE "id" = '${D1}';
    `);
    await rejects(client, `UPDATE "app_login_requests" SET "approver_family_id" = '00000000-0000-4000-8000-0000000000ff' WHERE "id" = '${R1}'`, /foreign key/);
    await client.exec(`DELETE FROM "session_families" WHERE "id" = '${F2}'`);
    const cleared = await client.query<{ app: string | null; device: string | null }>(`
      SELECT (SELECT "approver_family_id" FROM "app_login_requests" WHERE "id" = '${R1}') AS app,
             (SELECT "approver_family_id" FROM "device_authorizations" WHERE "id" = '${D1}') AS device
    `);
    assert.deepEqual(cleared.rows[0], { app: null, device: null });

    // New tables: kinds checked, challenge and credential ids unique, TOTP one per person.
    await client.exec(`
      INSERT INTO "auth_challenges" ("id", "user_id", "kind", "challenge_hash", "expires_at") VALUES (gen_random_uuid(), '${U1}', 'webauthn_assertion', 'h1', now());
      INSERT INTO "auth_challenges" ("id", "kind", "challenge_hash", "expires_at") VALUES (gen_random_uuid(), 'second_factor_login', 'h2', now());
      INSERT INTO "webauthn_credentials" ("id", "user_id", "credential_id", "public_key", "name", "transports") VALUES (gen_random_uuid(), '${U1}', '\\x0102', '\\x03', 'Laptop', ARRAY['internal', 'hybrid']);
      INSERT INTO "user_totp" ("user_id", "secret_ciphertext") VALUES ('${U1}', 'v1:x:y:z');
      INSERT INTO "user_backup_codes" ("id", "user_id", "code_hash") VALUES (gen_random_uuid(), '${U1}', '$argon2id$x');
    `);
    await rejects(client, `INSERT INTO "auth_challenges" ("id", "kind", "challenge_hash", "expires_at") VALUES (gen_random_uuid(), 'magic_link', 'h3', now())`, /auth_challenges_kind_check/);
    await rejects(client, `INSERT INTO "auth_challenges" ("id", "kind", "challenge_hash", "expires_at") VALUES (gen_random_uuid(), 'webauthn_assertion', 'h1', now())`, /auth_challenges_challenge_hash_unique/);
    await rejects(client, `INSERT INTO "webauthn_credentials" ("id", "user_id", "credential_id", "public_key", "name") VALUES (gen_random_uuid(), '${U1}', '\\x0102', '\\x04', 'Again')`, /webauthn_credentials_credential_id_unique/);
    await rejects(client, `INSERT INTO "user_totp" ("user_id", "secret_ciphertext") VALUES ('${U1}', 'again')`, /user_totp_pkey/);
    const defaults = await client.query<{ sign_count: number; backup_eligible: boolean; backup_state: boolean }>(
      `SELECT "sign_count"::int AS sign_count, "backup_eligible", "backup_state" FROM "webauthn_credentials"`,
    );
    assert.deepEqual(defaults.rows, [{ sign_count: 0, backup_eligible: false, backup_state: false }]);

    // All of it goes with the person.
    await client.exec(`DELETE FROM "session_families" WHERE "user_id" = '${U1}'; DELETE FROM "users" WHERE "id" = '${U1}'`);
    const left = await client.query<{ n: number }>(`
      SELECT ((SELECT count(*) FROM "auth_challenges" WHERE "user_id" IS NOT NULL)
        + (SELECT count(*) FROM "webauthn_credentials")
        + (SELECT count(*) FROM "user_totp")
        + (SELECT count(*) FROM "user_backup_codes"))::int AS n
    `);
    assert.equal(left.rows[0]!.n, 0);
  } finally {
    await client.close();
  }
});
