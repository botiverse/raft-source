import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { test } from "vitest";
import { getDb } from "./index";
import { agents } from "./schema";
import { dbTest } from "../test/integration/dbTest";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";
import {
  createOAuthClient, exchangeAccessRequest, getIdentityByAccessToken, grantOAuthUserConsent,
} from "../services/oauthService";

/**
 * RFC 079 phase 3a (PR 1): request, token and consent rows may carry
 * server_id NULL, for account-mode logins only. Nothing writes such a row
 * yet; the database alone holds the shape (design §2.1, threats T8, T13, T15):
 * the row CHECKs, the token lifetime CHECK, oauth_login_row_mode_guard, the
 * forward-only login mode and the one account consent per person and App.
 */

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

type DatabaseErrorShape = { code?: unknown; constraint?: unknown; cause?: unknown };

/** The refusal is the named constraint's, with its SQLSTATE, not merely some error. */
function violates(code: string, constraint: string) {
  return (error: unknown) => {
    for (let current: unknown = error; current && typeof current === "object"; current = (current as DatabaseErrorShape).cause) {
      const candidate = current as DatabaseErrorShape;
      if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
        assert.deepEqual({ code: candidate.code, constraint: candidate.constraint }, { code, constraint });
        return true;
      }
    }
    assert.fail(`expected ${constraint} (${code}), got ${String(error)}`);
  };
}

type Seed = ReturnType<typeof createSeed>;
type Principal =
  | { principalType: "human"; userId: string | null; agentId?: string | null }
  | { principalType: "agent"; agentId: string; userId?: string | null };

async function setup(seed: Seed) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seed.human();
  const person = await seed.human();
  const server = await seed.server({ owner, members: [person] });
  const otherServer = await seed.server({ owner, members: [person] });
  const [agent] = await getDb().insert(agents)
    .values({ serverId: server.id, name: `rows-${suffix}`, creatorType: "user", creatorId: owner.id })
    .returning();
  const app = async (label: string, loginMode: "server" | "account") => {
    const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, name: `${label} App`, clientId: `${label}-${suffix}` });
    // The reviewed switch is the only writer of 'account'; set it with SQL, as
    // db/oauthClientLoginMode.test.ts does.
    if (loginMode === "account") await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${client.id}`);
    return client;
  };
  return {
    owner,
    person,
    server,
    otherServer,
    human: { principalType: "human", userId: person.id } satisfies Principal,
    agent: { principalType: "agent", agentId: agent.id } satisfies Principal,
    serverApp: await app("server-mode", "server"),
    accountApp: await app("account-mode", "account"),
    app,
  };
}

/** `approverSessionFamilyId`: the sign-in that asked for a person's code (its exchange needs it live). */
function insertRequest(row: Principal & { serverId: string | null; clientId: string; approverSessionFamilyId?: string }) {
  return getDb().execute<{ id: string }>(sql`
    INSERT INTO "oauth_access_requests" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "scopes", "status", "approver_session_family_id")
    VALUES (${randomUUID()}, ${row.serverId}, ${row.principalType}, ${row.userId ?? null}, ${row.agentId ?? null}, ${row.clientId}, '["openid"]', 'approved', ${row.approverSessionFamilyId ?? null})
    RETURNING "id"
  `);
}

const HOUR_MS = 60 * 60 * 1000;

function insertToken(row: Principal & { serverId: string | null; clientId: string; createdAt?: Date; lifetimeMs?: number; rawToken?: string }) {
  const createdAt = row.createdAt ?? new Date();
  const expiresAt = new Date(createdAt.getTime() + (row.lifetimeMs ?? HOUR_MS));
  const tokenHash = createHash("sha256").update(row.rawToken ?? randomUUID()).digest("hex");
  return getDb().execute<{ id: string }>(sql`
    INSERT INTO "oauth_access_tokens" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "token_hash", "scopes", "expires_at", "created_at")
    VALUES (${randomUUID()}, ${row.serverId}, ${row.principalType}, ${row.userId ?? null}, ${row.agentId ?? null}, ${row.clientId}, ${tokenHash}, '["openid"]',
      ${expiresAt.toISOString()}::timestamptz, ${createdAt.toISOString()}::timestamptz)
    RETURNING "id"
  `);
}

function insertConsent(row: { userId: string; serverId: string | null; clientId: string }) {
  return getDb().execute<{ id: string }>(sql`
    INSERT INTO "oauth_user_consents" ("id", "user_id", "server_id", "client_id", "scopes")
    VALUES (${randomUUID()}, ${row.userId}, ${row.serverId}, ${row.clientId}, '["openid"]')
    RETURNING "id"
  `);
}

async function idOf(insert: Promise<{ rows: Array<{ id: string }> }>): Promise<string> {
  const { rows: [row] } = await insert;
  assert.ok(row);
  return row.id;
}

async function serverIdOf(table: "oauth_access_requests" | "oauth_access_tokens" | "oauth_user_consents", id: string) {
  const { rows } = await getDb().execute<{ server_id: string | null }>(sql`SELECT "server_id" FROM ${sql.identifier(table)} WHERE "id" = ${id}`);
  assert.equal(rows.length, 1, `${table} ${id} exists`);
  return rows[0]!.server_id;
}

dbTest("T15: a server-less request or token is a person's; agent and malformed rows are refused by the row CHECK", async ({ seed }) => {
  const f = await setup(seed);
  // On an account-mode App the trigger lets the row through, so the CHECK is what refuses it.
  const app = { serverId: null, clientId: f.accountApp.id };
  await assert.rejects(insertRequest({ ...app, ...f.agent }), violates(CHECK_VIOLATION, "oauth_access_requests_server_id_human_only"));
  await assert.rejects(insertToken({ ...app, ...f.agent }), violates(CHECK_VIOLATION, "oauth_access_tokens_server_id_human_only"));
  // A human row naming an agent, or no person.
  await assert.rejects(insertRequest({ ...app, ...f.human, agentId: f.agent.agentId }), violates(CHECK_VIOLATION, "oauth_access_requests_server_id_human_only"));
  await assert.rejects(insertToken({ ...app, principalType: "human", userId: null }), violates(CHECK_VIOLATION, "oauth_access_tokens_server_id_human_only"));
});

dbTest("T15 (a): a server-less human request, token or consent needs an account-mode App", async ({ seed }) => {
  const f = await setup(seed);
  const app = { serverId: null, clientId: f.serverApp.id };
  await assert.rejects(insertRequest({ ...app, ...f.human }), violates(CHECK_VIOLATION, "oauth_access_requests_server_id_null_account_only"));
  await assert.rejects(insertToken({ ...app, ...f.human }), violates(CHECK_VIOLATION, "oauth_access_tokens_server_id_null_account_only"));
  await assert.rejects(insertConsent({ ...app, userId: f.person.id }), violates(CHECK_VIOLATION, "oauth_user_consents_server_id_null_account_only"));
});

dbTest("T15 (b): no new Server-bound human request or token for an account-mode App; its agent rows and per-Server consents stay", async ({ seed }) => {
  const f = await setup(seed);
  const accountOnServer = { serverId: f.server.id, clientId: f.accountApp.id };
  await assert.rejects(insertRequest({ ...accountOnServer, ...f.human }), violates(CHECK_VIOLATION, "oauth_access_requests_server_id_bound_server_only"));
  await assert.rejects(insertToken({ ...accountOnServer, ...f.human }), violates(CHECK_VIOLATION, "oauth_access_tokens_server_id_bound_server_only"));
  // Agent grants of an account-mode App stay Server-bound (decision Q2); the
  // link-preview prompt still writes per-Server consents until 3b.
  assert.equal(await serverIdOf("oauth_access_requests", await idOf(insertRequest({ ...accountOnServer, ...f.agent }))), f.server.id);
  assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ ...accountOnServer, ...f.agent }))), f.server.id);
  assert.equal(await serverIdOf("oauth_user_consents", await idOf(insertConsent({ ...accountOnServer, userId: f.person.id }))), f.server.id);
  // A server-mode App's rows are as before.
  const serverOnServer = { serverId: f.server.id, clientId: f.serverApp.id };
  for (const principal of [f.human, f.agent]) {
    assert.equal(await serverIdOf("oauth_access_requests", await idOf(insertRequest({ ...serverOnServer, ...principal }))), f.server.id);
    assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ ...serverOnServer, ...principal }))), f.server.id);
  }
  assert.equal(await serverIdOf("oauth_user_consents", await idOf(insertConsent({ ...serverOnServer, userId: f.person.id }))), f.server.id);
});

dbTest("an account-mode App's server-less human request, token and consent are accepted", async ({ seed }) => {
  const f = await setup(seed);
  const app = { serverId: null, clientId: f.accountApp.id };
  assert.equal(await serverIdOf("oauth_access_requests", await idOf(insertRequest({ ...app, ...f.human }))), null);
  assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ ...app, ...f.human }))), null);
  assert.equal(await serverIdOf("oauth_user_consents", await idOf(insertConsent({ ...app, userId: f.person.id }))), null);
});

dbTest("T15: a row cannot leave its Server, nor a server-less row move to a server-mode App", async ({ seed }) => {
  const f = await setup(seed);
  const onServer = { serverId: f.server.id, clientId: f.serverApp.id };
  const request = await idOf(insertRequest({ ...onServer, ...f.human }));
  const token = await idOf(insertToken({ ...onServer, ...f.human }));
  const consent = await idOf(insertConsent({ ...onServer, userId: f.person.id }));
  await assert.rejects(getDb().execute(sql`UPDATE "oauth_access_requests" SET "server_id" = NULL WHERE "id" = ${request}`),
    violates(CHECK_VIOLATION, "oauth_access_requests_server_id_null_account_only"));
  await assert.rejects(getDb().execute(sql`UPDATE "oauth_access_tokens" SET "server_id" = NULL WHERE "id" = ${token}`),
    violates(CHECK_VIOLATION, "oauth_access_tokens_server_id_null_account_only"));
  await assert.rejects(getDb().execute(sql`UPDATE "oauth_user_consents" SET "server_id" = NULL WHERE "id" = ${consent}`),
    violates(CHECK_VIOLATION, "oauth_user_consents_server_id_null_account_only"));

  const accountRequest = await idOf(insertRequest({ serverId: null, clientId: f.accountApp.id, ...f.human }));
  await assert.rejects(getDb().execute(sql`UPDATE "oauth_access_requests" SET "client_id" = ${f.serverApp.id} WHERE "id" = ${accountRequest}`),
    violates(CHECK_VIOLATION, "oauth_access_requests_server_id_null_account_only"));
  for (const [table, id] of [["oauth_access_requests", request], ["oauth_access_tokens", token], ["oauth_user_consents", consent]] as const) {
    assert.equal(await serverIdOf(table, id), f.server.id);
  }
});

dbTest("a server-less token lives at most an hour; Server-bound tokens keep any lifetime (Q5)", async ({ seed }) => {
  const f = await setup(seed);
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const account = { serverId: null, clientId: f.accountApp.id, ...f.human, createdAt };
  await assert.rejects(insertToken({ ...account, lifetimeMs: HOUR_MS + 1000 }), violates(CHECK_VIOLATION, "oauth_access_tokens_account_ttl"));
  assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ ...account, lifetimeMs: HOUR_MS }))), null);

  const thirtyDays = 30 * 24 * HOUR_MS;
  assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ serverId: f.server.id, clientId: f.serverApp.id, ...f.human, createdAt, lifetimeMs: thirtyDays }))), f.server.id);
  assert.equal(await serverIdOf("oauth_access_tokens", await idOf(insertToken({ serverId: f.server.id, clientId: f.accountApp.id, ...f.agent, createdAt, lifetimeMs: thirtyDays }))), f.server.id);
});

dbTest("T8: an App never leaves account mode; server to account and account to account are allowed", async ({ seed }) => {
  const f = await setup(seed);
  const mode = async (id: string) => {
    const { rows } = await getDb().execute<{ login_mode: string }>(sql`SELECT "login_mode" FROM "oauth_clients" WHERE "id" = ${id}`);
    return rows[0]?.login_mode;
  };
  const switching = await f.app("switching", "server");
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${switching.id}`);
  assert.equal(await mode(switching.id), "account");
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${switching.id}`);
  assert.equal(await mode(switching.id), "account");

  await assert.rejects(getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'server' WHERE "id" = ${f.accountApp.id}`),
    violates(CHECK_VIOLATION, "oauth_clients_login_mode_forward_only"));
  assert.equal(await mode(f.accountApp.id), "account");
  // Other edits of an account-mode App are untouched.
  await getDb().execute(sql`UPDATE "oauth_clients" SET "name" = 'Renamed' WHERE "id" = ${f.accountApp.id}`);
  // And a server-mode App may be written with its own mode.
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'server' WHERE "id" = ${f.serverApp.id}`);
  assert.equal(await mode(f.serverApp.id), "server");
});

dbTest("T13: one account consent per person and App, upserted on the partial index; per-Server consents coexist", async ({ seed }) => {
  const f = await setup(seed);
  await idOf(insertConsent({ userId: f.person.id, serverId: null, clientId: f.accountApp.id }));
  await assert.rejects(insertConsent({ userId: f.person.id, serverId: null, clientId: f.accountApp.id }),
    violates(UNIQUE_VIOLATION, "idx_oauth_user_consents_user_client_account"));

  // The upsert PR 3's account consent relies on.
  const upsert = (scopes: string[]) => getDb().execute<{ id: string; scopes: string[] }>(sql`
    INSERT INTO "oauth_user_consents" ("id", "user_id", "server_id", "client_id", "scopes")
    VALUES (${randomUUID()}, ${f.person.id}, NULL, ${f.accountApp.id}, ${JSON.stringify(scopes)}::json)
    ON CONFLICT ("user_id", "client_id") WHERE "server_id" IS NULL
    DO UPDATE SET "scopes" = excluded."scopes", "updated_at" = now()
    RETURNING "id", "scopes"
  `);
  const { rows: [first] } = await upsert(["openid", "profile"]);
  const { rows: [second] } = await upsert(["email", "openid"]);
  assert.equal(second?.id, first?.id, "the upsert updates the one account consent");
  assert.deepEqual(second?.scopes, ["email", "openid"]);

  // Another person's account consent to the same App is their own row.
  await idOf(insertConsent({ userId: f.owner.id, serverId: null, clientId: f.accountApp.id }));
  // Per-Server consents for the same person and App, on two Servers, beside the account one.
  for (const serverId of [f.server.id, f.otherServer.id]) {
    await grantOAuthUserConsent(getDb(), { userId: f.person.id, serverId, clientId: f.accountApp.id, scopes: ["openid"], source: "preview_prompt", now: new Date() });
    await grantOAuthUserConsent(getDb(), { userId: f.person.id, serverId, clientId: f.serverApp.id, scopes: ["openid"], source: "login", now: new Date() });
  }
  const { rows } = await getDb().execute<{ client_id: string; server_id: string | null }>(sql`
    SELECT "client_id", "server_id" FROM "oauth_user_consents" WHERE "user_id" = ${f.person.id}
  `);
  const key = (row: { client_id: string; server_id: string | null }) => `${row.client_id === f.accountApp.id ? "account" : "server"}:${row.server_id ?? "none"}`;
  assert.deepEqual(rows.map(key).sort(), [
    "account:none",
    `account:${f.otherServer.id}`,
    `account:${f.server.id}`,
    `server:${f.otherServer.id}`,
    `server:${f.server.id}`,
  ].sort());
});

dbTest("rows written before an App switches to account mode survive the switch and stay writable", async ({ seed }) => {
  const f = await setup(seed);
  const app = await f.app("switched", "server");
  const onServer = { serverId: f.server.id, clientId: app.id };
  const before = {
    humanRequest: await idOf(insertRequest({ ...onServer, ...f.human })),
    humanToken: await idOf(insertToken({ ...onServer, ...f.human })),
    agentRequest: await idOf(insertRequest({ ...onServer, ...f.agent })),
    agentToken: await idOf(insertToken({ ...onServer, ...f.agent })),
    consent: await idOf(insertConsent({ ...onServer, userId: f.person.id })),
  };
  await getDb().execute(sql`UPDATE "oauth_clients" SET "login_mode" = 'account' WHERE "id" = ${app.id}`);

  assert.equal(await serverIdOf("oauth_access_requests", before.humanRequest), f.server.id);
  assert.equal(await serverIdOf("oauth_access_requests", before.agentRequest), f.server.id);
  assert.equal(await serverIdOf("oauth_access_tokens", before.humanToken), f.server.id);
  assert.equal(await serverIdOf("oauth_access_tokens", before.agentToken), f.server.id);
  assert.equal(await serverIdOf("oauth_user_consents", before.consent), f.server.id);
  // Revocation and consumption still write them (the guard watches only
  // server_id and client_id), and the per-Server consent upsert still runs.
  await getDb().execute(sql`UPDATE "oauth_access_tokens" SET "revoked_at" = now() WHERE "id" IN (${before.humanToken}, ${before.agentToken})`);
  await getDb().execute(sql`UPDATE "oauth_access_requests" SET "consumed_at" = now(), "updated_at" = now() WHERE "id" IN (${before.humanRequest}, ${before.agentRequest})`);
  const consent = await grantOAuthUserConsent(getDb(), { userId: f.person.id, serverId: f.server.id, clientId: app.id, scopes: ["profile"], source: "login", now: new Date() });
  assert.equal(consent.id, before.consent);
  assert.deepEqual(consent.scopes, ["openid", "profile"]);
});

dbTest("T18: the server-mode exchange and token lookup fail closed on a server-less row", async ({ seed }) => {
  const f = await setup(seed);
  // Control: the same paths serve a Server-bound human login.
  const { familyId } = await signInForTest(f.human.userId);
  const serverBound = await idOf(insertRequest({ serverId: f.server.id, clientId: f.serverApp.id, ...f.human, approverSessionFamilyId: familyId }));
  const exchanged = await exchangeAccessRequest({ clientId: f.serverApp.id, requestId: serverBound });
  assert.equal((await getIdentityByAccessToken(exchanged.accessToken))?.serverId, f.server.id);

  // A server-less request is never the Server-bound exchange's: it goes to
  // the account-mode exchange (PR 3), which refuses it here (the kill switch
  // is off): nothing is minted and the request stays open.
  const accountRequest = await idOf(insertRequest({ serverId: null, clientId: f.accountApp.id, ...f.human, approverSessionFamilyId: familyId }));
  await assert.rejects(exchangeAccessRequest({ clientId: f.accountApp.id, requestId: accountRequest }), /^Error: access_denied$/);
  const { rows: written } = await getDb().execute<{ tokens: number; consumed: boolean }>(sql`
    SELECT (SELECT count(*)::int FROM "oauth_access_tokens" WHERE "request_id" = ${accountRequest}) AS "tokens",
      (SELECT "consumed_at" IS NOT NULL FROM "oauth_access_requests" WHERE "id" = ${accountRequest}) AS "consumed"
  `);
  assert.deepEqual(written, [{ tokens: 0, consumed: false }]);
  // A server-less token is no server-mode identity (inner join on its Server).
  const rawToken = `slock_at_${randomUUID()}`;
  await idOf(insertToken({ serverId: null, clientId: f.accountApp.id, ...f.human, rawToken }));
  assert.equal(await getIdentityByAccessToken(rawToken), null);
});

// The migration on a database holding today's rows: nothing about them changes.
const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");
const TAG_SUFFIX = "_oauth_account_login_rows";

test("the migration keeps every existing row, validates its CHECKs and installs the guards", async () => {
  const journal = JSON.parse(await readFile(path.join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const target = journal.entries.find((entry) => entry.tag.endsWith(TAG_SUFFIX));
  assert.ok(target, `journal has a *${TAG_SUFFIX} migration`);
  const client = new PGlite();
  // One transaction per migration, as the deploy runner applies them.
  const apply = async (entries: Array<{ tag: string }>) => {
    for (const entry of entries) await client.exec(`BEGIN;\n${await readFile(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf8")}\n;COMMIT;`);
  };
  const USER = "11111111-1111-4111-8111-111111111111";
  const SERVER = "22222222-2222-4222-8222-222222222222";
  const APP = "33333333-3333-4333-8333-333333333333";
  const AGENT = "44444444-4444-4444-8444-444444444444";
  try {
    await apply(journal.entries.filter((entry) => entry.idx < target.idx));
    await client.exec(`
      INSERT INTO "users" ("id", "email", "name", "password_hash") VALUES ('${USER}', 'rows@example.test', 'rows', 'fixture-value-not-a-credential');
      INSERT INTO "servers" ("id", "name", "slug", "owner_id") VALUES ('${SERVER}', 'Rows', 'rows', '${USER}');
      INSERT INTO "agents" ("id", "server_id", "name", "creator_type", "creator_id") VALUES ('${AGENT}', '${SERVER}', 'rows-agent', 'user', '${USER}');
      INSERT INTO "oauth_clients" ("id", "server_id", "client_id", "client_secret_hash", "name", "created_by_user_id") VALUES ('${APP}', '${SERVER}', 'rows-app', 'hash', 'Rows App', '${USER}');
      INSERT INTO "oauth_access_requests" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "scopes", "status") VALUES
        ('55555555-5555-4555-8555-555555555551', '${SERVER}', 'human', '${USER}', NULL, '${APP}', '["openid"]', 'approved'),
        ('55555555-5555-4555-8555-555555555552', '${SERVER}', 'agent', NULL, '${AGENT}', '${APP}', '["agent:read"]', 'pending');
      INSERT INTO "oauth_access_tokens" ("id", "server_id", "principal_type", "user_id", "agent_id", "client_id", "token_hash", "scopes", "expires_at") VALUES
        ('66666666-6666-4666-8666-666666666661', '${SERVER}', 'human', '${USER}', NULL, '${APP}', 'hash-1', '["openid"]', now() + interval '1 hour'),
        ('66666666-6666-4666-8666-666666666662', '${SERVER}', 'agent', NULL, '${AGENT}', '${APP}', 'hash-2', '["agent:read"]', now() + interval '30 days');
      INSERT INTO "oauth_user_consents" ("id", "user_id", "server_id", "client_id", "scopes") VALUES
        ('77777777-7777-4777-8777-777777777771', '${USER}', '${SERVER}', '${APP}', '["openid"]');
    `);
    const rows = async () => (await client.query<{ id: string; server_id: string }>(`
      SELECT "id", "server_id" FROM "oauth_access_requests"
      UNION ALL SELECT "id", "server_id" FROM "oauth_access_tokens"
      UNION ALL SELECT "id", "server_id" FROM "oauth_user_consents"
      ORDER BY "id"
    `)).rows;
    const existing = await rows();
    assert.equal(existing.length, 5);
    await apply([target]);
    assert.deepEqual(await rows(), existing);

    const nullable = await client.query<{ table_name: string; is_nullable: string }>(`
      SELECT "table_name", "is_nullable" FROM information_schema.columns
      WHERE "table_schema" = 'public' AND "column_name" = 'server_id'
        AND "table_name" IN ('oauth_access_requests', 'oauth_access_tokens', 'oauth_user_consents')
      ORDER BY "table_name"
    `);
    assert.deepEqual(nullable.rows.map((row) => [row.table_name, row.is_nullable]), [
      ["oauth_access_requests", "YES"],
      ["oauth_access_tokens", "YES"],
      ["oauth_user_consents", "YES"],
    ]);
    const constraints = await client.query<{ conname: string; convalidated: boolean }>(`
      SELECT "conname", "convalidated" FROM "pg_constraint"
      WHERE "conname" IN ('oauth_access_requests_server_id_human_only', 'oauth_access_tokens_server_id_human_only', 'oauth_access_tokens_account_ttl')
      ORDER BY "conname"
    `);
    assert.deepEqual(constraints.rows, [
      { conname: "oauth_access_requests_server_id_human_only", convalidated: true },
      { conname: "oauth_access_tokens_account_ttl", convalidated: true },
      { conname: "oauth_access_tokens_server_id_human_only", convalidated: true },
    ]);
    const triggers = await client.query<{ tgname: string; table: string; fn: string }>(`
      SELECT t."tgname", t."tgrelid"::regclass::text AS "table", p."proname" AS "fn"
      FROM "pg_trigger" t JOIN "pg_proc" p ON p."oid" = t."tgfoid"
      WHERE NOT t."tgisinternal" AND p."proname" IN ('oauth_login_row_mode_guard', 'oauth_clients_login_mode_forward_only')
      ORDER BY t."tgname"
    `);
    assert.deepEqual(triggers.rows, [
      { tgname: "oauth_access_requests_login_mode_guard", table: "oauth_access_requests", fn: "oauth_login_row_mode_guard" },
      { tgname: "oauth_access_tokens_login_mode_guard", table: "oauth_access_tokens", fn: "oauth_login_row_mode_guard" },
      { tgname: "oauth_clients_login_mode_forward_only", table: "oauth_clients", fn: "oauth_clients_login_mode_forward_only" },
      { tgname: "oauth_user_consents_login_mode_guard", table: "oauth_user_consents", fn: "oauth_login_row_mode_guard" },
    ]);

    // The guard reads the App's mode under FOR SHARE, so a write and the
    // switch (FOR UPDATE, then UPDATE login_mode) queue behind each other
    // instead of the write acting on the mode from before the switch. One
    // PGlite connection cannot show the wait (and the client_id foreign key
    // already takes FOR KEY SHARE, which does not conflict with that UPDATE),
    // so this pins the lock clause itself.
    const guard = await client.query<{ def: string }>(
      `SELECT pg_get_functiondef('public.oauth_login_row_mode_guard()'::regprocedure) AS "def"`,
    );
    assert.match(guard.rows[0]?.def ?? "", /WHERE c\."id" = NEW\."client_id"\s+FOR SHARE OF c;/);
  } finally {
    await client.close();
  }
});
