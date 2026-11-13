import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

/**
 * Executing teeth for `0407_generic_app_root_foundation` (#wg-mcp task #19).
 *
 * The sibling `appRootFoundationMigration.test.ts` reads the migration as TEXT. That can
 * show what the SQL says; it cannot show what the SQL DOES -- and a text check passed
 * while the count/1:1/rolling invariants it claimed to protect were actually false
 * (@Huarong, `#wg-mcp:1c8190a3`). These tests apply the real journal to a real Postgres
 * (PGlite) and then assert on rows, so a claim that is not true of the database fails.
 */

const migrationUrl = (tag: string) => new URL(`../../drizzle/${tag}.sql`, import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
) as { entries: Array<{ tag: string }> };

const TAIL = "0407_generic_app_root_foundation";
const tags = journal.entries.map((entry) => entry.tag);
// Bound to 0407's OWN position, not to "whatever is last". These teeth exercise 0407, so they
// apply exactly the entries that precede it and stop there. Until 0408 landed this was the journal
// tail and `slice(0, -1)` said the same thing; it no longer does, and the re-point below is the
// deliberate correction the guard tooth was written to force.
const tailIndex = tags.indexOf(TAIL);
const priorTags = tags.slice(0, tailIndex === -1 ? 0 : tailIndex);
const tailSql = readFileSync(migrationUrl(TAIL), "utf8");
const BACKFILL_MARKER = "-- ── Backfill ─";

test("the executing teeth are bound to 0407's own journal position", () => {
  // If 0407 is renamed or removed, these teeth must be re-pointed deliberately rather than
  // silently start exercising someone else's migration.
  assert.notEqual(tailIndex, -1, "0407 must still be in the journal");
  assert.equal(tags[tailIndex], TAIL);
  assert.equal(priorTags.length, tailIndex, "exactly the entries before 0407 are applied first");
  assert.ok(!priorTags.includes(TAIL), "0407 itself is applied by the tests, not by the setup");
});

/** Each migration file is applied in its own transaction, the way the runner applies it. */
async function applyMigrations(pg: PGlite, applied: readonly string[]): Promise<void> {
  for (const tag of applied) {
    await pg.exec(`BEGIN;\n${readFileSync(migrationUrl(tag), "utf8")}\n;COMMIT;`);
  }
}

const USER = "00000000-0000-4000-8000-000000000001";
const SERVER_A = "00000000-0000-4000-8000-0000000000a1";
const SERVER_B = "00000000-0000-4000-8000-0000000000b1";

/** Legacy rows only -- nothing here knows about the App root. */
async function seedLegacy(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO users (id, email, name, password_hash)
    VALUES ('${USER}', 'fixture@example.test', 'Fixture', 'fixture-value-not-a-credential');
    INSERT INTO servers (id, name, slug, owner_id) VALUES
      ('${SERVER_A}', 'A', 'a', '${USER}'),
      ('${SERVER_B}', 'B', 'b', '${USER}');
  `);
}

async function insertOauthClient(pg: PGlite, id: string, serverId: string, appType: string): Promise<void> {
  await pg.exec(`
    INSERT INTO oauth_clients (id, server_id, client_id, client_secret_hash, name, created_by_user_id, app_type)
    VALUES ('${id}', '${serverId}', 'client-${id.slice(0, 8)}', 'fixture-value-not-a-credential', 'app ${id.slice(0, 8)}', '${USER}', '${appType}');
  `);
}

async function insertMcpServer(pg: PGlite, id: string, serverId: string): Promise<void> {
  await pg.exec(`
    INSERT INTO managed_mcp_servers (id, server_id, name, endpoint_url)
    VALUES ('${id}', '${serverId}', 'mcp ${id.slice(0, 8)}', 'https://example.test/${id.slice(0, 8)}');
  `);
}

async function rows<T = Record<string, unknown>>(pg: PGlite, sql: string): Promise<T[]> {
  return (await pg.query<T>(sql)).rows;
}

async function count(pg: PGlite, sql: string): Promise<number> {
  const [row] = await rows<{ c: number }>(pg, `SELECT count(*)::int AS c FROM ${sql}`);
  return row.c;
}

/** Applies every migration EXCEPT the tail, seeds legacy rows, and hands back the db. */
async function legacyDatabase(seed: (pg: PGlite) => Promise<void>): Promise<PGlite> {
  const pg = new PGlite();
  await applyMigrations(pg, priorTags);
  await seedLegacy(pg);
  await seed(pg);
  return pg;
}

const OAUTH_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const MCP_IDS = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];

test("backfill attaches one root per legacy row, with kind and server carried exactly", async () => {
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, OAUTH_IDS[0], SERVER_A, "server_local");
    await insertOauthClient(db, OAUTH_IDS[1], SERVER_A, "slock_builtin");
    await insertOauthClient(db, OAUTH_IDS[2], SERVER_B, "third_party_global");
    await insertMcpServer(db, MCP_IDS[0], SERVER_A);
    await insertMcpServer(db, MCP_IDS[1], SERVER_B);
  });
  try {
    await applyMigrations(pg, [TAIL]);

    assert.equal(await count(pg, "raft_apps WHERE kind = 'oauth_service'"), 3);
    assert.equal(await count(pg, "raft_apps WHERE kind = 'mcp'"), 2);
    assert.equal(await count(pg, "app_oauth_profiles"), 3);
    assert.equal(await count(pg, "app_mcp_profiles"), 2);

    // Every OAuth distribution value is carried through per row, not collapsed to a default.
    assert.deepEqual(
      await rows(pg, `
        SELECT c.app_type, a.distribution
        FROM oauth_clients c
        JOIN app_oauth_profiles p ON p.oauth_client_id = c.id
        JOIN raft_apps a ON a.id = p.app_id
        WHERE c.app_type IS DISTINCT FROM a.distribution
      `),
      [],
    );

    // A Server-scoped MCP record is server-local by construction.
    assert.deepEqual(
      await rows(pg, "SELECT DISTINCT distribution FROM raft_apps WHERE kind = 'mcp'"),
      [{ distribution: "server_local" }],
    );

    // Profile -> root must resolve to the RIGHT kind and the SAME server as its source.
    assert.deepEqual(
      await rows(pg, `
        SELECT p.app_id FROM app_oauth_profiles p
        JOIN oauth_clients c ON c.id = p.oauth_client_id
        LEFT JOIN raft_apps a ON a.id = p.app_id
        WHERE a.id IS NULL OR a.kind <> 'oauth_service' OR a.server_id <> c.server_id
      `),
      [],
    );
    assert.deepEqual(
      await rows(pg, `
        SELECT p.app_id FROM app_mcp_profiles p
        JOIN managed_mcp_servers m ON m.id = p.managed_mcp_server_id
        LEFT JOIN raft_apps a ON a.id = p.app_id
        WHERE a.id IS NULL OR a.kind <> 'mcp' OR a.server_id <> m.server_id
      `),
      [],
    );

    // No root may exist without exactly one profile pointing at it.
    assert.equal(
      await count(pg, `
        raft_apps a
        LEFT JOIN app_oauth_profiles o ON o.app_id = a.id
        LEFT JOIN app_mcp_profiles m ON m.app_id = a.id
        WHERE (o.app_id IS NULL AND m.app_id IS NULL) OR (o.app_id IS NOT NULL AND m.app_id IS NOT NULL)
      `),
      0,
    );
  } finally {
    await pg.close();
  }
});

test("a UUID reused across the two legacy namespaces yields two isolated roots", async () => {
  // `oauth_clients.id` and `managed_mcp_servers.id` are INDEPENDENT uuid namespaces; nothing
  // stops the same value appearing in both. Deriving the root id from the source id therefore
  // collapses the two Apps into one -- and `ON CONFLICT DO NOTHING` makes that collapse SILENT.
  const shared = "66666666-6666-4666-8666-666666666666";
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, shared, SERVER_A, "server_local");
    await insertMcpServer(db, shared, SERVER_B);
  });
  try {
    await applyMigrations(pg, [TAIL]);

    assert.equal(await count(pg, "raft_apps"), 2, "one root per legacy row, even on a shared source id");
    assert.equal(await count(pg, "raft_apps WHERE kind = 'oauth_service'"), 1);
    assert.equal(await count(pg, "raft_apps WHERE kind = 'mcp'"), 1);

    const [oauthRoot] = await rows<{ app_id: string }>(pg, "SELECT app_id FROM app_oauth_profiles");
    const [mcpRoot] = await rows<{ app_id: string }>(pg, "SELECT app_id FROM app_mcp_profiles");
    assert.notEqual(oauthRoot.app_id, mcpRoot.app_id, "the two adapters must not share a root");

    assert.deepEqual(
      await rows(pg, `
        SELECT a.kind, a.server_id FROM app_mcp_profiles p JOIN raft_apps a ON a.id = p.app_id
      `),
      [{ kind: "mcp", server_id: SERVER_B }],
      "the MCP profile must not resolve to the OAuth root",
    );
  } finally {
    await pg.close();
  }
});

test("re-running the tail is idempotent and changes no root", async () => {
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, OAUTH_IDS[0], SERVER_A, "server_local");
    await insertMcpServer(db, MCP_IDS[0], SERVER_A);
  });
  try {
    await applyMigrations(pg, [TAIL]);
    const before = await rows(pg, "SELECT id, server_id, kind, distribution FROM raft_apps ORDER BY kind");

    // Replay only the data half; re-running DDL would fail on `CREATE TABLE` for unrelated
    // reasons. Slice on the section marker, NOT on the first `INSERT INTO` -- the trigger
    // function bodies contain inserts of their own, and cutting there would replay a
    // fragment of plpgsql instead of the backfill.
    const marker = tailSql.indexOf(BACKFILL_MARKER);
    assert.notEqual(marker, -1, "the backfill section marker must remain present in the tail");
    const backfill = tailSql.slice(marker);
    assert.ok(!backfill.includes("CREATE FUNCTION"), "the replayed slice must contain no DDL");
    await pg.exec(`BEGIN;\n${backfill}\n;COMMIT;`);

    assert.deepEqual(await rows(pg, "SELECT id, server_id, kind, distribution FROM raft_apps ORDER BY kind"), before);
    assert.equal(await count(pg, "app_oauth_profiles"), 1);
    assert.equal(await count(pg, "app_mcp_profiles"), 1);
  } finally {
    await pg.close();
  }
});

test("an old binary's legacy create/delete keeps root and profile consistent", async () => {
  // Rolling deploy: the migration is applied while OLD server code is still serving. That code
  // knows nothing about `raft_apps`, so it writes `oauth_clients` / `managed_mcp_servers`
  // directly. Backfill-only cannot cover this -- a create after the migration leaves no root,
  // and a delete leaves the root behind.
  const pg = await legacyDatabase(async () => {});
  try {
    await applyMigrations(pg, [TAIL]);

    const lateOauth = "77777777-7777-4777-8777-777777777777";
    const lateMcp = "88888888-8888-4888-8888-888888888888";
    await insertOauthClient(pg, lateOauth, SERVER_A, "third_party_global");
    await insertMcpServer(pg, lateMcp, SERVER_B);

    assert.equal(await count(pg, "raft_apps WHERE kind = 'oauth_service'"), 1, "late OAuth create must get a root");
    assert.equal(await count(pg, "raft_apps WHERE kind = 'mcp'"), 1, "late MCP create must get a root");
    assert.equal(await count(pg, "app_oauth_profiles"), 1);
    assert.equal(await count(pg, "app_mcp_profiles"), 1);
    assert.deepEqual(
      await rows(pg, "SELECT distribution FROM raft_apps WHERE kind = 'oauth_service'"),
      [{ distribution: "third_party_global" }],
      "distribution must follow the legacy row, not a default",
    );

    await pg.exec(`DELETE FROM oauth_clients WHERE id = '${lateOauth}'`);
    await pg.exec(`DELETE FROM managed_mcp_servers WHERE id = '${lateMcp}'`);

    assert.equal(await count(pg, "raft_apps"), 0, "a legacy delete must not leave an orphan root");
    assert.equal(await count(pg, "app_oauth_profiles"), 0);
    assert.equal(await count(pg, "app_mcp_profiles"), 0);
  } finally {
    await pg.close();
  }
});

test("the database refuses a profile bound to a root of the other adapter", async () => {
  // Deriving the root id per adapter already makes a cross-adapter collision impossible.
  // This asserts the SECOND line: even a hand-written statement that computes the wrong id
  // cannot attach an MCP profile to an OAuth root, because the composite FK binds (app_id,
  // app_kind) to (raft_apps.id, raft_apps.kind). The refusal is the database's, not a test's.
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, OAUTH_IDS[0], SERVER_A, "server_local");
    await insertMcpServer(db, MCP_IDS[0], SERVER_A);
  });
  try {
    await applyMigrations(pg, [TAIL]);
    const [oauthRoot] = await rows<{ id: string }>(
      pg,
      "SELECT id FROM raft_apps WHERE kind = 'oauth_service'",
    );

    await expect(
      pg.exec(`
        INSERT INTO app_mcp_profiles (app_id, managed_mcp_server_id)
        VALUES ('${oauthRoot.id}', '${MCP_IDS[1]}')
      `),
    ).rejects.toThrow();

    // And the pinned discriminator cannot be bent to make the bad attach legal.
    await expect(
      pg.exec(`
        INSERT INTO app_mcp_profiles (app_id, app_kind, managed_mcp_server_id)
        VALUES ('${oauthRoot.id}', 'oauth_service', '${MCP_IDS[1]}')
      `),
    ).rejects.toThrow();

    assert.equal(await count(pg, "app_mcp_profiles"), 1);
  } finally {
    await pg.close();
  }
});

test("retiring the foundation in trigger-then-table order leaves legacy writes working", async () => {
  // This repo has no down-migrations: a retirement is a FORWARD migration (see 0225 ->
  // 0237). The triggers introduce a coupling that retirement must respect -- dropping the
  // three tables while the triggers still exist would leave every `oauth_clients` /
  // `managed_mcp_servers` write raising on a missing relation. That is a new constraint
  // this migration creates, so it is pinned here rather than left in a comment for
  // whoever writes the retirement to discover in production.
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, OAUTH_IDS[0], SERVER_A, "server_local");
  });
  try {
    await applyMigrations(pg, [TAIL]);
    await pg.exec(`
      DROP TRIGGER oauth_clients_app_root_sync ON oauth_clients;
      DROP TRIGGER managed_mcp_servers_app_root_sync ON managed_mcp_servers;
      DROP FUNCTION raft_apps_sync_oauth_root();
      DROP FUNCTION raft_apps_sync_mcp_root();
      DROP TABLE app_oauth_profiles;
      DROP TABLE app_mcp_profiles;
      DROP TABLE raft_apps;
      DROP FUNCTION raft_app_root_id(text, uuid);
    `);

    // The legacy tables are untouched by the teardown and keep accepting writes.
    await insertOauthClient(pg, OAUTH_IDS[1], SERVER_A, "slock_builtin");
    await insertMcpServer(pg, MCP_IDS[0], SERVER_B);
    assert.equal(await count(pg, "oauth_clients"), 2);
    assert.equal(await count(pg, "managed_mcp_servers"), 1);
  } finally {
    await pg.close();
  }
});

test("a hostile search_path cannot redirect the lifecycle triggers into shadow tables", async () => {
  // Measured defect, now pinned. Before every function was schema-qualified and pinned to
  // `SET search_path = pg_catalog, pg_temp`, a session running with `search_path = shadow,
  // public` -- where `shadow.raft_apps` carried a matching UNIQUE (id, kind) -- could do a
  // perfectly legal insert into `public.oauth_clients`, have it SUCCEED, and leave the root
  // and profile in the shadow tables while `public.raft_apps` stayed empty. No error.
  //
  // The triggers are the load-bearing surface for the rolling invariant, so their write
  // target must be a property of the migration, not of whoever happens to be connected.
  const pg = await legacyDatabase(async () => {});
  try {
    await applyMigrations(pg, [TAIL]);
    await pg.exec(`
      CREATE SCHEMA shadow;
      CREATE TABLE shadow.raft_apps (
        id uuid PRIMARY KEY, server_id uuid, kind text, distribution text,
        metadata_revision integer DEFAULT 0,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        CONSTRAINT shadow_raft_apps_id_kind_unique UNIQUE (id, kind)
      );
      CREATE TABLE shadow.app_oauth_profiles (
        app_id uuid PRIMARY KEY, app_kind text DEFAULT 'oauth_service', oauth_client_id uuid,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE shadow.app_mcp_profiles (
        app_id uuid PRIMARY KEY, app_kind text DEFAULT 'mcp', managed_mcp_server_id uuid,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      SET search_path = shadow, public;
    `);

    const shadowed = "99999999-9999-4999-8999-999999999999";
    const shadowedMcp = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    // INSERT through both legacy tables, under the hostile path.
    await pg.exec(`
      INSERT INTO public.oauth_clients (id, server_id, client_id, client_secret_hash, name, created_by_user_id, app_type)
      VALUES ('${shadowed}', '${SERVER_A}', 'c-shadow', 'fixture-value-not-a-credential', 'shadow', '${USER}', 'server_local');
      INSERT INTO public.managed_mcp_servers (id, server_id, name, endpoint_url)
      VALUES ('${shadowedMcp}', '${SERVER_B}', 'm-shadow', 'https://example.test/shadow');
    `);
    assert.equal(await count(pg, "public.raft_apps"), 2, "both roots must land in public");
    assert.equal(await count(pg, "public.app_oauth_profiles"), 1);
    assert.equal(await count(pg, "public.app_mcp_profiles"), 1);
    assert.equal(await count(pg, "shadow.raft_apps"), 0, "the shadow root table must stay empty");
    assert.equal(await count(pg, "shadow.app_oauth_profiles"), 0);
    assert.equal(await count(pg, "shadow.app_mcp_profiles"), 0);

    // UPDATE through the legacy table, still under the hostile path.
    await pg.exec(`UPDATE public.oauth_clients SET app_type = 'third_party_global' WHERE id = '${shadowed}'`);
    assert.deepEqual(
      await rows(pg, "SELECT distribution FROM public.raft_apps WHERE kind = 'oauth_service'"),
      [{ distribution: "third_party_global" }],
      "the UPDATE must reach the public root, not a shadow copy",
    );
    assert.equal(await count(pg, "shadow.raft_apps"), 0);

    // DELETE through both legacy tables, still under the hostile path.
    await pg.exec(`
      DELETE FROM public.oauth_clients WHERE id = '${shadowed}';
      DELETE FROM public.managed_mcp_servers WHERE id = '${shadowedMcp}';
    `);
    assert.equal(await count(pg, "public.raft_apps"), 0, "a legacy delete must clear the public root");
    assert.equal(await count(pg, "shadow.raft_apps"), 0);

    await pg.exec("SET search_path = public;");
    assert.equal(await count(pg, "public.raft_apps"), 0);
  } finally {
    await pg.close();
  }
});

test("a kind mismatch on an existing root raises instead of being silently swallowed", async () => {
  const pg = await legacyDatabase(async (db) => {
    await insertOauthClient(db, OAUTH_IDS[0], SERVER_A, "server_local");
  });
  try {
    await applyMigrations(pg, [TAIL]);
    const [root] = await rows<{ id: string }>(pg, "SELECT id FROM raft_apps");

    // `ON CONFLICT DO NOTHING` would make this a no-op and report success. An App root
    // changing execution adapter underneath its profile must fail closed instead.
    await expect(
      pg.exec(`UPDATE raft_apps SET kind = 'mcp' WHERE id = '${root.id}'`),
    ).rejects.toThrow();

    assert.deepEqual(await rows(pg, "SELECT kind FROM raft_apps"), [{ kind: "oauth_service" }]);
  } finally {
    await pg.close();
  }
});
