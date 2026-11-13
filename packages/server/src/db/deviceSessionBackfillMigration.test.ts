import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// 0495 marks device-login sessions issued before scopes existed as `device`,
// only where a grant matches exactly one family of the approver in its
// consume window (revoked families counted, so a web login made seconds
// after a signed-out device login is never taken for it).
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const MIGRATION = "0495_device_session_backfill";

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

async function applyMigration(client: PGlite): Promise<void> {
  for (const statement of statements(await readFile(path.join(DRIZZLE_DIR, `${MIGRATION}.sql`), "utf8"))) await client.exec(statement);
}

const U1 = "00000000-0000-4000-8000-0000000000a1";
const U2 = "00000000-0000-4000-8000-0000000000a2";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("0495 marks only unambiguous pre-scope device sessions, records them on the grant, and re-running changes nothing", async () => {
  const client = new PGlite();
  try {
    await applyBefore(client, MIGRATION);
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES
        ('${U1}', 'backfill-1@slock.test', 'backfill-1', 'test'),
        ('${U2}', 'backfill-2@slock.test', 'backfill-2', 'test');
    `);
    let grantNo = 0;
    const grant = async (row: { id: string; user: string; consumedAt: string; familyId?: string }) => {
      grantNo += 1;
      await client.query(
        `INSERT INTO "device_authorizations"
           ("id", "device_code_lookup_hash", "device_code_hash", "user_code", "status", "approved_by_user_id", "expires_at", "consumed_at", "consumed_session_family_id")
         VALUES ($1, decode(md5($6), 'hex'), 'hash', $2, 'consumed', $3, $4::timestamptz + interval '10 minutes', $4, $5)`,
        [row.id, `CODE-${grantNo}`, row.user, row.consumedAt, row.familyId ?? null, `lookup-${row.id}`],
      );
    };
    const family = async (row: { id: string; user: string; createdAt: string; revoked?: boolean }) =>
      client.query(
        `INSERT INTO "session_families" ("id", "user_id", "created_at", "revoked_at") VALUES ($1, $2, $3, $4)`,
        [row.id, row.user, row.createdAt, row.revoked ? row.createdAt : null],
      );

    // G1: one family of the approver just after the consume: the device session.
    await family({ id: id(101), user: U1, createdAt: "2026-10-01T10:00:00.050Z" });
    await grant({ id: id(1), user: U1, consumedAt: "2026-10-01T10:00:00.000Z" });
    // G2: two families in the window: ambiguous, neither touched.
    await family({ id: id(201), user: U1, createdAt: "2026-10-02T10:00:00.100Z" });
    await family({ id: id(202), user: U1, createdAt: "2026-10-02T10:00:03.000Z" });
    await grant({ id: id(2), user: U1, consumedAt: "2026-10-02T10:00:00.000Z" });
    // G3: the device session was signed out; a web login 5s later is the only live family.
    await family({ id: id(301), user: U2, createdAt: "2026-10-03T10:00:00.100Z", revoked: true });
    await family({ id: id(302), user: U2, createdAt: "2026-10-03T10:00:05.000Z" });
    await grant({ id: id(3), user: U2, consumedAt: "2026-10-03T10:00:00.000Z" });
    // G4: issued after 0493, so it already names its family: never guessed at.
    await family({ id: id(401), user: U2, createdAt: "2026-10-04T10:00:00.100Z" });
    await family({ id: id(402), user: U2, createdAt: "2026-10-04T10:00:01.000Z" });
    await grant({ id: id(4), user: U2, consumedAt: "2026-10-04T10:00:00.000Z", familyId: id(401) });
    // G5: the one family in the window is revoked: nothing to change.
    await family({ id: id(501), user: U1, createdAt: "2026-10-05T10:00:00.100Z", revoked: true });
    await grant({ id: id(5), user: U1, consumedAt: "2026-10-05T10:00:00.000Z" });
    // A family outside every window stays a person's own session.
    await family({ id: id(901), user: U1, createdAt: "2026-10-01T12:00:00.000Z" });

    const state = async () => ({
      families: (await client.query<{ id: string; scope: string }>(`SELECT "id", "scope" FROM "session_families" ORDER BY "id"`)).rows
        .map((row) => `${row.id.slice(-3)}:${row.scope}`),
      grants: (await client.query<{ id: string; family: string | null }>(`SELECT "id", "consumed_session_family_id" AS family FROM "device_authorizations" ORDER BY "id"`)).rows
        .map((row) => `${row.id.slice(-1)}:${row.family ? row.family.slice(-3) : "-"}`),
    });

    await applyMigration(client);
    const after = await state();
    assert.deepEqual(after, {
      families: ["101:device", "201:full", "202:full", "301:full", "302:full", "401:full", "402:full", "501:full", "901:full"],
      grants: ["1:101", "2:-", "3:-", "4:401", "5:-"],
    });

    // Re-running changes nothing: G1 now names its family and is skipped.
    await applyMigration(client);
    assert.deepEqual(await state(), after);
  } finally {
    await client.close();
  }
});
