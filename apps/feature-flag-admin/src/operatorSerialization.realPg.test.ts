// Exact concurrency tooth for the operator CAS boundary. Hosted runs this
// against PostgreSQL 16; ordinary package tests skip when no real-PG URL is
// supplied.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import worker, { internals, type Env } from "./worker";

const REAL_PG_URL_ENV = "FEATURE_FLAG_ADMIN_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.FEATURE_FLAG_ADMIN_REAL_PG_REQUIRED === "1";
const skip = REAL_PG_URL || REAL_PG_REQUIRED
  ? false
  : `${REAL_PG_URL_ENV} is required for the opt-in real-PostgreSQL gate`;

const SESSION_SECRET = "feature-flag-real-pg-session-secret";
const GLOBAL_LOCK_NAMESPACE = 0x46464356;
const GLOBAL_LOCK_KEY = 0;

function databaseUrlFor(adminUrl: string, databaseName: string, applicationName?: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

function setCookie(response: Response, name: string): string {
  const raw = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(raw, `missing Set-Cookie for ${name}`);
  return raw.split(";")[0] ?? "";
}

function adminAuditDb(auditWrites: { count: number }): D1Database {
  return {
    prepare: (text: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => text.includes("FROM feature_flag_admin_role_grants")
          && values[0] === "human-serialization"
          && values[1] === "admin"
          ? { principal_id: "human-serialization" }
          : null,
        all: async () => ({ results: [] }),
        run: async () => {
          if (text.includes("feature_flag_audit_events")) auditWrites.count += 1;
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
}

async function humanSessionCookie(env: Env): Promise<string> {
  const login = await worker.fetch(new Request("https://flags.test/login"), env);
  const stateCookie = setCookie(login, internals.STATE_COOKIE);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/oauth/token")) {
      return Response.json({ access_token: "serialization-token", expires_in: 3600 });
    }
    if (url.endsWith("/api/oauth/userinfo")) {
      return Response.json({
        sub: "human-serialization",
        type: "human",
        scope: "openid profile",
        client_id: "slock-feature-flag-admin",
        server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
        preferred_username: "serialization-reviewer",
        name: "Serialization Reviewer",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const callback = await worker.fetch(new Request("https://flags.test/auth/raft/callback?code=serialization", {
      headers: { Cookie: stateCookie },
    }), env);
    assert.equal(callback.status, 302);
    return setCookie(callback, internals.SESSION_COOKIE);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function waitForAdvisoryLockWaiter(observer: pg.Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'feature_flag_waiter'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
    `);
    if (Number(result.rows[0]?.count ?? 0) === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Worker request did not reach the transaction-scoped advisory-lock wait boundary");
}

test("transaction-scoped READ COMMITTED serialization observes the committed CAS version without session residue", { skip }, async () => {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} must be set when the gate is required`);
  const databaseName = `ff_admin_serial_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL });
  await admin.connect();
  const serverVersion = Number((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num ?? 0);
  assert.equal(Math.floor(serverVersion / 10_000), 16, "the concurrency receipt is pinned to PostgreSQL 16");
  await admin.query(`CREATE DATABASE ${databaseName}`);

  const databaseUrl = databaseUrlFor(REAL_PG_URL, databaseName);
  const waiterUrl = databaseUrlFor(REAL_PG_URL, databaseName, "feature_flag_waiter");
  const setup = new pg.Client({ connectionString: databaseUrl });
  const holder = new pg.Client({ connectionString: databaseUrl });
  const observer = new pg.Client({ connectionString: databaseUrl });
  let holderLocked = false;

  try {
    await Promise.all([setup.connect(), holder.connect(), observer.connect()]);
    await setup.query(`
      CREATE TABLE feature_flags (
        key text PRIMARY KEY,
        description text,
        enabled boolean NOT NULL,
        kill_switch boolean NOT NULL,
        randomization_unit text NOT NULL,
        default_enabled boolean NOT NULL,
        default_variant text,
        salt text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE feature_flag_rules (
        id uuid PRIMARY KEY,
        flag_key text NOT NULL REFERENCES feature_flags(key),
        stage text NOT NULL,
        priority integer NOT NULL,
        decision text NOT NULL,
        values jsonb NOT NULL,
        percentage_basis_points integer,
        variant text,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE feature_flag_config_versions (
        scope text PRIMARY KEY,
        version bigint NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        updated_by text,
        last_audit_event_id uuid
      );
      INSERT INTO feature_flags (
        key, description, enabled, kill_switch, randomization_unit,
        default_enabled, default_variant, salt
      ) VALUES ('serialization_v0', 'Serialization test', true, false, 'server', false, NULL, 'salt');
      INSERT INTO feature_flag_config_versions (scope, version, updated_by)
      VALUES ('global', 1, 'fixture');
    `);

    const auditWrites = { count: 0 };
    const env: Env = {
      ASSETS: { fetch: async () => new Response("ok") } as unknown as Fetcher,
      FEATURE_FLAG_PG: { connectionString: waiterUrl } as Hyperdrive,
      FEATURE_FLAG_AUDIT_DB: adminAuditDb(auditWrites),
      RAFT_ORIGIN: "https://app.raft.build",
      RAFT_API_ORIGIN: "https://api.raft.build",
      RAFT_CLIENT_ID: "slock-feature-flag-admin",
      RAFT_CLIENT_SECRET: "client-secret",
      FEATURE_FLAG_SESSION_SECRET: SESSION_SECRET,
      FEATURE_FLAG_ALLOWED_SERVER_IDS: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    };
    const sessionCookie = await humanSessionCookie(env);

    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock($1, $2)", [GLOBAL_LOCK_NAMESPACE, GLOBAL_LOCK_KEY]);
    holderLocked = true;
    const responsePromise = worker.fetch(new Request(
      "https://flags.test/api/operator/feature-flags/serialization_v0/default-enabled",
      {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultEnabled: false,
          reason: "concurrent no-op must still honor CAS",
          expectedConfigVersion: 1,
        }),
      },
    ), env);

    await waitForAdvisoryLockWaiter(observer);
    await holder.query(`
      UPDATE feature_flag_config_versions
      SET version = 2, updated_at = NOW(), updated_by = 'concurrent-writer'
      WHERE scope = 'global'
    `);
    await holder.query("COMMIT");
    holderLocked = false;

    const response = await responsePromise;
    assert.equal(response.status, 409, await response.clone().text());
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(body.error?.code, "version_conflict");
    assert.equal(auditWrites.count, 0, "stale no-op must not write audit state");
    const heldLocks = await observer.query(`
      SELECT count(*)::int AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = $1::oid
        AND objid = $2::oid
        AND granted
    `, [GLOBAL_LOCK_NAMESPACE, GLOBAL_LOCK_KEY]);
    assert.equal(Number(heldLocks.rows[0]?.count ?? 0), 0, "transaction completion must release every advisory lock");
    const state = await observer.query(`
      SELECT f.default_enabled, v.version
      FROM feature_flags f
      CROSS JOIN feature_flag_config_versions v
      WHERE f.key = 'serialization_v0' AND v.scope = 'global'
    `);
    assert.deepEqual(state.rows, [{ default_enabled: false, version: "2" }]);
  } finally {
    if (holderLocked) {
      await holder.query("ROLLBACK").catch(() => undefined);
    }
    await Promise.all([
      setup.end().catch(() => undefined),
      holder.end().catch(() => undefined),
      observer.end().catch(() => undefined),
    ]);
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
