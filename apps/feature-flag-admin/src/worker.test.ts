import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
  REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES,
} from "@botiverse/raft-shared";
import { validateAgentManifestV0 } from "../../../packages/cli/src/commands/integration/manifest";
import { previewBody } from "./App";
import worker, { FEATURE_FLAG_AUDIT_REASON_MAX_LENGTH, internals, type Env } from "./worker";

const baseEnv: Env = {
  ASSETS: {
    fetch: async () => new Response("<div id=\"root\"></div>", { headers: { "Content-Type": "text/html" } }),
  } as unknown as Fetcher,
  RAFT_ORIGIN: "https://app.raft.build",
  RAFT_API_ORIGIN: "https://api.raft.build",
  RAFT_CLIENT_ID: "slock-feature-flag-admin",
  RAFT_CLIENT_SECRET: "client-secret",
  FEATURE_FLAG_SESSION_SECRET: "test-session-secret",
  FEATURE_FLAG_ALLOWED_SERVER_IDS: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
  FEATURE_FLAG_AUDIT_DB: persistentAdminDb("human-1"),
};

const CANONICAL_RULE_ID = "31a4b75b-c7d7-4f25-969c-ad492dd90050";
const PARTNER_RULE_ID = "a4362b16-4c5f-443a-853a-103648ff3c34";
const UNSUPPORTED_RULE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_SERVER_ID = "11111111-1111-4111-8111-111111111111";
const TEST_SERVER_SLUG = "partner-alpha";
const READ_ONLY_BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
const MUTATION_BEGIN = "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED";

function isTransactionControl(text: string): boolean {
  return text === MUTATION_BEGIN || text === "COMMIT" || text === "ROLLBACK";
}

function isServerSlugLookup(text: string): boolean {
  return text.includes("FROM servers") && text.includes("WHERE slug = $1");
}

function isServerRefsLookup(text: string): boolean {
  return text.includes("FROM servers WHERE id = ANY");
}

function activeServerRef(serverId = TEST_SERVER_ID, serverSlug = TEST_SERVER_SLUG) {
  return { id: serverId, slug: serverSlug, deleted_at: null };
}

function plainServerRuleRow(id: string, priority: number, values: string[]) {
  return {
    id,
    stage: "server",
    priority,
    decision: "allow",
    values,
    percentage_basis_points: null,
    variant: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function webPlatformRuleRow(id: string) {
  return {
    id,
    stage: "platform",
    priority: 0,
    decision: "allow",
    values: ["web"],
    percentage_basis_points: null,
    variant: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function labRuleRow(id: string, priority: number, decision: "allow" | "deny", values: string[]) {
  return {
    id,
    stage: "lab",
    priority,
    decision,
    values,
    percentage_basis_points: null,
    variant: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://flags.test${path}`, init);
}

function privilegeOracle(options: {
  systemUser?: string | null;
  omitSystemUser?: boolean;
  backendUser?: string;
  sessionUser?: string;
  currentUser?: string;
  unexpected?: string;
} = {}) {
  return async (text: string, values: unknown[] = []) => {
    if (text.includes("session_user AS session_user")) {
      const identity: Record<string, unknown> = {
        ...(options.omitSystemUser ? {} : {
          system_user: options.systemUser === undefined
            ? `scram-sha-256:${FEATURE_FLAG_ADMIN_OPERATOR_ROLE}`
            : options.systemUser,
        }),
        session_user: options.sessionUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
        current_user: options.currentUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
        backend_user: options.backendUser ?? FEATURE_FLAG_ADMIN_OPERATOR_ROLE,
      };
      return { rows: [identity] };
    }
    if (text.includes("pg_catalog.pg_roles")) return { rows: [{ allowed: true }] };
    // The verifier's effective-column-privilege census query enumerates every
    // required column grant via pg_attribute/has_column_privilege. A healthy
    // backend returns exactly the required column rows; exercise that path so
    // readiness does not fall through to the scalar fallback.
    if (text.includes("column_name") && text.includes("has_column_privilege")) {
      const rows = (REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES as ReadonlyArray<{
        kind: string; object: string; column?: string; privilege: string;
      }>)
        .filter((entry) => entry.kind === "column" && entry.column)
        .map((entry) => ({
          object_name: entry.object,
          column_name: entry.column as string,
          privilege_name: entry.privilege,
        }));
      return { rows };
    }
    if (text.includes("has_schema_privilege") || text.includes("has_table_privilege")) {
      const key = `${String(values[1])}:${String(values[2])}`;
      // Match only schema/table-kind requirements here: a column-kind grant on
      // e.g. public.users must not make table-level public.users:SELECT read
      // as granted, or the verifier's forbidden-privilege probes trip.
      const allowed = key === options.unexpected
        || REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.some(
          (entry) => entry.kind !== "column" && `${entry.object}:${entry.privilege}` === key,
        );
      return { rows: [{ allowed }] };
    }
    if (text.includes("has_column_privilege")) {
      const key = `${String(values[1])}:${String(values[2])}:${String(values[3])}`;
      const allowed = key === options.unexpected
        || REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.some(
          (entry) => entry.kind === "column"
            && `${entry.object}:${entry.column}:${entry.privilege}` === key,
        );
      return { rows: [{ allowed }] };
    }
    const key = `${String(values[1])}:${String(values[2])}`;
    return {
      rows: [{
        allowed: key === options.unexpected
          || REQUIRED_FEATURE_FLAG_ADMIN_PRIVILEGES.some(
            (entry) => `${entry.object}:${entry.privilege}` === key
              || (entry.kind === "column" && `${entry.object}:${entry.column}:${entry.privilege}` === key),
          ),
      }],
    };
  };
}

function setCookie(response: Response, name: string): string {
  const raw = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(raw, `missing Set-Cookie for ${name}`);
  return raw.split(";")[0] ?? "";
}

async function withFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function oauthFetch(userinfo: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/oauth/token")) {
      return Response.json({ access_token: "raft-token", expires_in: 3600 });
    }
    if (url.endsWith("/api/oauth/userinfo")) {
      return Response.json(userinfo);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function createHumanSessionCookie(principalId = "human-1"): Promise<string> {
  const login = await worker.fetch(request("/login"), baseEnv);
  const stateCookie = setCookie(login, internals.STATE_COOKIE);
  const callback = await withFetch(oauthFetch({
    sub: principalId,
    type: "human",
    scope: "openid profile",
    client_id: "slock-feature-flag-admin",
    server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    preferred_username: "operator",
    name: "Operator",
  }), () => worker.fetch(request("/auth/raft/callback?code=abc", {
    headers: { Cookie: stateCookie },
  }), baseEnv));
  return setCookie(callback, internals.SESSION_COOKIE);
}

async function createAgentSessionCookie(): Promise<string> {
  const callback = await withFetch(oauthFetch({
    sub: "agent-1",
    type: "agent",
    scope: "openid profile",
    client_id: "slock-feature-flag-admin",
    server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    server_slug: "botiverse",
    preferred_username: "ray",
    name: "Ray",
  }), () => worker.fetch(request("/auth/raft/callback?code=agent"), baseEnv));
  return setCookie(callback, internals.SESSION_COOKIE);
}

test("announcement DB readiness proves the actual Hyperdrive login and exact grants", async () => {
  const missingBinding = await worker.fetch(
    request("/api/readiness/operator-db", { method: "POST" }),
    baseEnv,
  );
  assert.equal(missingBinding.status, 503);

  let ended = false;
  const ready = await withPgMock(
    privilegeOracle(),
    () => worker.fetch(
      request("/api/readiness/operator-db", { method: "POST" }),
      {
        ...baseEnv,
        FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
      },
    ),
    { end: async () => { ended = true; } },
  );
  assert.equal(ready.status, 204);
  assert.equal(ended, true);
  assert.equal(ready.headers.get("Cache-Control"), "private, no-store");
});

test("operator DB readiness accepts Neon proxy connections without system_user", async () => {
  const ready = await withPgMock(
    privilegeOracle({ systemUser: null }),
    () => worker.fetch(
      request("/api/readiness/operator-db", { method: "POST" }),
      {
        ...baseEnv,
        FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
      },
    ),
  );
  assert.equal(ready.status, 204);
});

test("operator DB readiness rejects a misbound login or incomplete/effective over-grant", async () => {
  for (const query of [
    privilegeOracle({ systemUser: "scram-sha-256:broad_hyperdrive_login" }),
    privilegeOracle({ systemUser: null, backendUser: "broad_hyperdrive_login" }),
    privilegeOracle({ sessionUser: "broad_hyperdrive_login" }),
    privilegeOracle({ currentUser: "wrong_hyperdrive_login" }),
    privilegeOracle({ unexpected: "public:CREATE" }),
  ]) {
    const response = await withPgMock(query, () => worker.fetch(
      request("/api/readiness/operator-db", { method: "POST" }),
      {
        ...baseEnv,
        FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
      },
    ));
    assert.equal(response.status, 503);
  }
});

test("operator DB readiness rejects an unreadable system_user field", async () => {
  const response = await withPgMock(
    privilegeOracle({ omitSystemUser: true }),
    () => worker.fetch(
      request("/api/readiness/operator-db", { method: "POST" }),
      {
        ...baseEnv,
        FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
      },
    ),
  );
  assert.equal(response.status, 503);
});

async function withPgMock<T>(
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
  fn: () => Promise<T>,
  options?: {
    connect?: () => Promise<void>;
    end?: () => Promise<void>;
    passSessionCleanupToQuery?: boolean;
    resolveServerSlug?: (serverSlug: string, text: string) => Array<Record<string, unknown>>;
    loadServerRefs?: (serverIds: string[]) => Array<Record<string, unknown>>;
  },
): Promise<T> {
  const prototype = Client.prototype as unknown as {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    end: () => Promise<void>;
  };
  const originalConnect = prototype.connect;
  const originalQuery = prototype.query;
  const originalEnd = prototype.end;
  prototype.connect = options?.connect ?? (async () => {});
  prototype.query = async (text, values) => {
    if (text === "SELECT pg_advisory_unlock_all()" && !options?.passSessionCleanupToQuery) return { rows: [] };
    if (isServerSlugLookup(text)) {
      assert.match(text, /deleted_at IS NULL/);
      assert.match(text, /LIMIT 2/);
      const serverSlug = String(values?.[0] ?? "");
      return {
        rows: options?.resolveServerSlug
          ? options.resolveServerSlug(serverSlug, text)
          : serverSlug === TEST_SERVER_SLUG
            ? [{ server_id: TEST_SERVER_ID }]
            : [],
      };
    }
    if (isServerRefsLookup(text)) {
      const serverIds = Array.isArray(values?.[0]) ? values[0].map(String) : [];
      return {
        rows: options?.loadServerRefs
          ? options.loadServerRefs(serverIds)
          : serverIds.map((serverId) => activeServerRef(
            serverId,
            serverId === TEST_SERVER_ID ? TEST_SERVER_SLUG : `server-${serverId.slice(0, 8)}`,
          )),
      };
    }
    return query(text, values);
  };
  prototype.end = options?.end ?? (async () => {});
  try {
    return await fn();
  } finally {
    prototype.connect = originalConnect;
    prototype.query = originalQuery;
    prototype.end = originalEnd;
  }
}

function announcementPublisherDb(principalId = "human-1"): D1Database {
  return {
    prepare: (text: string) => ({
      bind: (..._values: unknown[]) => ({
        first: async () => text.includes("feature_flag_admin_role_grants")
          ? { principal_id: principalId }
          : null,
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database;
}

function persistentAdminDb(...principalIds: string[]): D1Database {
  const allowed = new Set(principalIds);
  return {
    prepare: (_text: string) => ({
      bind: (principalId: unknown, role: unknown) => ({
        first: async () => role === "admin" && allowed.has(String(principalId))
          ? { principal_id: String(principalId) }
          : null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  } as unknown as D1Database;
}

function withPersistentAdmins(db: D1Database, ...principalIds: string[]): D1Database {
  const roles = persistentAdminDb(...principalIds);
  return {
    ...db,
    prepare: (text: string) => text.includes("SELECT principal_id")
        && text.includes("FROM feature_flag_admin_role_grants")
        && text.includes("enabled = 1")
      ? roles.prepare(text)
      : db.prepare(text),
  } as D1Database;
}

type RoleGrantRow = {
  principal_id: string;
  role: "admin" | "announcement_publisher";
  enabled: number;
  granted_by_principal_id: string;
  reason: string;
  created_at: string;
  updated_at: string;
};

function roleGrantDb(...initialAdminPrincipalIds: string[]) {
  const grants = new Map<string, RoleGrantRow>();
  const audits: Array<Record<string, unknown>> = [];
  for (const principalId of initialAdminPrincipalIds) {
    grants.set(`${principalId}:admin`, {
      principal_id: principalId,
      role: "admin",
      enabled: 1,
      granted_by_principal_id: "fixture-authority",
      reason: "Pre-existing persistent admin fixture.",
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
    });
  }
  type Statement = {
    text: string;
    values: unknown[];
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<{ success: boolean }>;
  };
  const prepare = (text: string) => ({
    bind: (...values: unknown[]) => {
      const statement: Statement = {
        text,
        values,
        first: async <T>() => {
          const [principalId, role] = values.map(String);
          const row = grants.get(`${principalId}:${role}`);
          if (text.includes("enabled = 1")) return (row?.enabled === 1 ? row : null) as T | null;
          return (row ?? null) as T | null;
        },
        all: async <T>() => ({
          results: [...grants.values()]
            .filter((row) => !text.includes("enabled = 1") || row.enabled === 1)
            .sort((left, right) => `${left.principal_id}:${left.role}`.localeCompare(`${right.principal_id}:${right.role}`)) as T[],
        }),
        run: async () => {
          if (text.includes("INSERT INTO feature_flag_admin_role_grants")) {
            const [principalId, role, actorId, reason, createdAt, updatedAt] = values.map(String);
            const key = `${principalId}:${role}`;
            const existing = grants.get(key);
            grants.set(key, {
              principal_id: principalId,
              role: role as RoleGrantRow["role"],
              enabled: 1,
              granted_by_principal_id: actorId,
              reason,
              created_at: existing?.created_at ?? createdAt,
              updated_at: updatedAt,
            });
          } else if (text.includes("UPDATE feature_flag_admin_role_grants")) {
            const [actorId, reason, updatedAt, principalId, role] = values.map(String);
            const key = `${principalId}:${role}`;
            const existing = grants.get(key);
            if (existing?.enabled === 1) {
              grants.set(key, {
                ...existing,
                enabled: 0,
                granted_by_principal_id: actorId,
                reason,
                updated_at: updatedAt,
              });
            }
          } else if (text.includes("INSERT INTO feature_flag_admin_role_audit_events")) {
            const [id, actorPrincipalId, targetPrincipalId, role, action, reason, createdAt] = values;
            audits.push({ id, actorPrincipalId, targetPrincipalId, role, action, reason, createdAt });
          }
          return { success: true };
        },
      };
      return statement;
    },
  });
  const db = {
    prepare,
    batch: async (statements: Statement[]) => {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
  return { db, grants, audits };
}

test("login redirects to Login with Raft setup and stores state", async () => {
  const response = await worker.fetch(request("/login?return_to=/flags/inbox"), baseEnv);
  assert.equal(response.status, 302);
  const location = response.headers.get("Location");
  assert.ok(location);
  const setup = new URL(location);
  assert.equal(setup.origin, "https://app.raft.build");
  assert.equal(setup.pathname, "/login-with-raft/setup");
  assert.equal(setup.searchParams.get("client_id"), "slock-feature-flag-admin");
  assert.equal(setup.searchParams.get("return_to"), "https://flags.test/auth/raft/callback");
  setCookie(response, internals.STATE_COOKIE);
});

test("human callback requires browser state and creates a session", async () => {
  const login = await worker.fetch(request("/login?return_to=/console"), baseEnv);
  const stateCookie = setCookie(login, internals.STATE_COOKIE);

  const response = await withFetch(oauthFetch({
    sub: "human-1",
    type: "human",
    scope: "openid profile",
    client_id: "slock-feature-flag-admin",
    server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    server_slug: "botiverse",
    server_role: "admin",
    preferred_username: "operator",
    name: "Operator",
  }), () => worker.fetch(request("/auth/raft/callback?code=abc", {
    headers: { Cookie: stateCookie },
  }), baseEnv));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/console");
  setCookie(response, internals.SESSION_COOKIE);
});

test("no-state callback rejects humans but accepts server-scoped agents", async () => {
  const human = await withFetch(oauthFetch({
    sub: "human-1",
    type: "human",
    client_id: "slock-feature-flag-admin",
    server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
  }), () => worker.fetch(request("/auth/raft/callback?code=human"), baseEnv));
  assert.equal(human.status, 302);
  assert.match(human.headers.get("Location") ?? "", /login_error/);

  const agent = await withFetch(oauthFetch({
    sub: "agent-1",
    type: "agent",
    scope: "openid profile",
    client_id: "slock-feature-flag-admin",
    server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
    server_slug: "botiverse",
    preferred_username: "agent",
    name: "Agent",
  }), () => worker.fetch(request("/auth/raft/callback?code=agent"), baseEnv));
  assert.equal(agent.status, 302);
  assert.equal(agent.headers.get("Location"), "/");
  setCookie(agent, internals.SESSION_COOKIE);
});

test("api routes require session and operator api placeholder is bounded", async () => {
  const anonymous = await worker.fetch(request("/api/operator/feature-flags"), baseEnv);
  assert.equal(anonymous.status, 401);

  const sessionCookie = await createHumanSessionCookie();

  const pendingPg = await worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: sessionCookie },
  }), baseEnv);
  assert.equal(pendingPg.status, 501);
  const pendingPgBody = await pendingPg.json() as {
    error: { code: string; message: string };
    requestId?: string;
  };
  assert.deepEqual(pendingPgBody.error, {
    code: "operator_api_pending",
    message: "Feature flag PG Hyperdrive binding is not configured.",
  });
  assert.equal(typeof pendingPgBody.requestId, "string");

  const pendingAuthorization = await worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: sessionCookie },
  }), { ...baseEnv, FEATURE_FLAG_AUDIT_DB: undefined });
  assert.equal(pendingAuthorization.status, 501);
  assert.deepEqual(
    (await pendingAuthorization.json() as { error: { code: string; message: string } }).error,
    {
      code: "operator_api_pending",
      message: "Admin authorization storage is not configured.",
    },
  );

  const staleBootstrapEnv: Env & Record<string, unknown> = {
    ...baseEnv,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("someone-else"),
  };
  staleBootstrapEnv.FEATURE_FLAG_OPERATOR_PRINCIPAL_IDS = "human-1";
  const staleBootstrapCannotAuthorize = await worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: sessionCookie },
  }), staleBootstrapEnv);
  assert.equal(staleBootstrapCannotAuthorize.status, 403);
});

test("announcement operator surface requires a persistent Worker grant and reads PG directly", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_AUDIT_DB: announcementPublisherDb(),
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  let pgQueries = 0;
  const response = await withFetch((async () => {
    throw new Error("announcement admin must not call the Raft server");
  }) as typeof fetch, () => withPgMock(async (text) => {
    pgQueries += 1;
    if (text.includes("SELECT id") && text.includes("activated_at IS NULL")) return { rows: [] };
    if (text.includes("FROM announcements") && text.includes("ORDER BY created_at DESC")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: sessionCookie },
  }), env)));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { announcements: [] });
  assert.equal(pgQueries, 2);

  // The two denials below must fail for DIFFERENT reasons, and those reasons are what
  // pin the gate ORDER: `requireOperator` (admin) runs first, the human check second.
  // Asserting only 403/403 leaves the order free to swap without any test noticing.
  const denied = await worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: sessionCookie },
  }), { ...env, FEATURE_FLAG_AUDIT_DB: announcementPublisherDb("someone-else") });
  assert.equal(denied.status, 403);
  assert.equal(
    (await denied.json() as { error: { code: string } }).error.code,
    "operator_unauthorized",
    "a human without admin must be stopped by the admin gate, not the human gate",
  );

  const agentCookie = await createAgentSessionCookie();
  const deniedAgent = await worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: agentCookie },
  }), {
    ...env,
    FEATURE_FLAG_AUDIT_DB: announcementPublisherDb("agent-1"),
  });
  assert.equal(deniedAgent.status, 403);
  assert.equal(
    (await deniedAgent.json() as { error: { code: string } }).error.code,
    "announcement_operator_required",
    "an agent holding admin must reach and be stopped by the human gate",
  );

  // THIS is the case that pins the ORDER. The two denials above return the same code
  // under either ordering, so they cannot see a swap. An agent WITHOUT admin can:
  //   admin-gate first -> operator_unauthorized      (correct)
  //   human-gate first -> announcement_operator_required
  const deniedAgentNoAdmin = await worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: agentCookie },
  }), { ...env, FEATURE_FLAG_AUDIT_DB: announcementPublisherDb("someone-else") });
  assert.equal(deniedAgentNoAdmin.status, 403);
  assert.equal(
    (await deniedAgentNoAdmin.json() as { error: { code: string } }).error.code,
    "operator_unauthorized",
    "admin must be checked BEFORE the human gate; swapping the two gates changes this code",
  );
});

test("manifest retires announcement_publisher and discloses the broadcast authority admin carries", async () => {
  const manifestResponse = await worker.fetch(request("/.well-known/raft-agent-manifest.json"), baseEnv);
  assert.equal(manifestResponse.status, 200, await manifestResponse.clone().text());
  const manifestJson = await manifestResponse.json() as {
    actions: Array<{
      name: string;
      description: string;
      parameters?: Record<string, { description?: string }>;
    }>;
  };
  const byName = new Map(manifestJson.actions.map((a) => [a.name, a]));

  // Positive control: read the three role actions BY KEY, so every assertion below is
  // made against cells we proved exist rather than against an absent-or-renamed field.
  const grant = byName.get("grant-admin-role");
  const revoke = byName.get("revoke-admin-role");
  const list = byName.get("list-admin-role-grants");
  assert.ok(grant && revoke && list, "the three role actions must be present in the manifest");

  // The retired role must not survive anywhere a caller reads a contract from — neither
  // snake_case nor the prose spelling that the action descriptions used.
  for (const action of [grant, revoke, list]) {
    assert.doesNotMatch(
      JSON.stringify(action),
      /announcement[_ ]publisher/i,
      `${action.name} must not advertise the retired role`,
    );
  }

  // Tenny's requirement: the coupling is visible at GRANT TIME. Assert it on the exact
  // cell a granter reads — the `role` parameter of grant-admin-role. A whole-document
  // regex would stay green while this specific line was deleted, because the action
  // description repeats the same sentence.
  assert.match(
    grant.parameters?.role?.description ?? "",
    /authority to publish announcements to every user/i,
    "the role parameter itself must disclose the broadcast authority admin confers",
  );
});

test("persistent admins manage roles with audit and role readback", async () => {
  const targetId = "11111111-2222-4333-8444-555555555555";
  const bootstrapCookie = await createHumanSessionCookie();
  const targetCookie = await createHumanSessionCookie(targetId);
  const { db, grants, audits } = roleGrantDb("human-1");
  const env = {
    ...baseEnv,
    FEATURE_FLAG_AUDIT_DB: db,
  };

  const empty = await worker.fetch(request("/api/operator/access-grants", {
    headers: { Cookie: bootstrapCookie },
  }), env);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json() as { data: { grants: unknown[] } }).data.grants.length, 1);

  const grantedAdmin = await worker.fetch(request(`/api/operator/access-grants/${targetId}/admin`, {
    method: "PUT",
    headers: { Cookie: bootstrapCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Grant reviewed Admin Worker access." }),
  }), env);
  assert.equal(grantedAdmin.status, 200, await grantedAdmin.clone().text());
  assert.equal(grants.get(`${targetId}:admin`)?.enabled, 1);
  assert.equal(audits[0]?.action, "grant");
  assert.equal(audits[0]?.actorPrincipalId, "human-1");

  const dynamicAdminList = await worker.fetch(request("/api/operator/access-grants", {
    headers: { Cookie: targetCookie },
  }), env);
  assert.equal(dynamicAdminList.status, 200, await dynamicAdminList.clone().text());
  assert.equal((await dynamicAdminList.json() as { data: { grants: unknown[] } }).data.grants.length, 2);

  // announcement_publisher is retired: granting it must fail closed and write no row.
  const retiredRole = await worker.fetch(request(
    `/api/operator/access-grants/${targetId}/announcement_publisher`,
    {
      method: "PUT",
      headers: { Cookie: bootstrapCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Retired role must no longer be grantable." }),
    },
  ), env);
  assert.equal(retiredRole.status, 400, await retiredRole.clone().text());
  assert.equal(
    (await retiredRole.json() as { error: { code: string } }).error.code,
    "invalid_admin_role",
  );
  assert.equal(grants.get(`${targetId}:announcement_publisher`), undefined);

  // A human holding only `admin` publishes: no publisher role exists or is needed.
  const announcement = await withPgMock(async (text) => {
    if (text.includes("activated_at IS NULL")) return { rows: [] };
    if (text.includes("FROM announcements") && text.includes("ORDER BY created_at DESC")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: targetCookie },
  }), {
    ...env,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  }));
  assert.equal(announcement.status, 200, await announcement.clone().text());

  // `admin` is now the only role gating announcements, so revoking it must close them.
  const revoked = await worker.fetch(request(
    `/api/operator/access-grants/${targetId}/admin`,
    {
      method: "DELETE",
      headers: { Cookie: bootstrapCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Revoke admin access after verification." }),
    },
  ), env);
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal(grants.get(`${targetId}:admin`)?.enabled, 0);
  assert.equal(audits.at(-1)?.action, "revoke");

  const deniedAfterRevoke = await worker.fetch(request("/api/operator/announcements", {
    headers: { Cookie: targetCookie },
  }), {
    ...env,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  });
  assert.equal(deniedAfterRevoke.status, 403);

  const invalidRole = await worker.fetch(request(`/api/operator/access-grants/${targetId}/owner`, {
    method: "PUT",
    headers: { Cookie: bootstrapCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "Invalid role must fail closed." }),
  }), env);
  assert.equal(invalidRole.status, 400);
});

test("direct operator API lists flags through Hyperdrive and enforces persistent admin grants", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };

  const response = await withPgMock(async (text) => {
    if (text.includes("FROM feature_flags")) {
      return {
        rows: [{
          key: "read_receipts_v0",
          description: "Read receipts",
          enabled: true,
          kill_switch: false,
          randomization_unit: "server",
          default_enabled: false,
          default_variant: null,
          updated_at: "2026-07-09T00:00:00.000Z",
        }],
      };
    }
    if (text.includes("FROM feature_flag_config_versions")) {
      return { rows: [{ version: "42" }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: sessionCookie },
  }), env));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    data: { flags: Array<{ key: string; enabled: boolean; randomizationUnit: string }> };
    configVersion: number;
  };
  assert.equal(body.configVersion, 42);
  assert.deepEqual(body.data.flags, [{
    key: "read_receipts_v0",
    description: "Read receipts",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "server",
    defaultEnabled: false,
    defaultVariant: null,
    highRisk: true,
    updatedAt: "2026-07-09T00:00:00.000Z",
  }]);

  const denied = await worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: sessionCookie },
  }), {
    ...env,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("someone-else"),
  });
  assert.equal(denied.status, 403);

  const agentSessionCookie = await createAgentSessionCookie();
  const deniedAgent = await worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: agentSessionCookie },
  }), env);
  assert.equal(deniedAgent.status, 403);

  const allowedAgent = await withPgMock(async (text) => {
    if (text.includes("FROM feature_flags")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "43" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags", {
    headers: { Cookie: agentSessionCookie },
  }), {
    ...env,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("human-1", "agent-1"),
  }));
  assert.equal(allowedAgent.status, 200);
  assert.equal((await allowedAgent.json() as { configVersion: number }).configVersion, 43);
});

test("human and agent preview use the same direct evaluator and omit variants", async () => {
  const humanCookie = await createHumanSessionCookie();
  const agentCookie = await createAgentSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("human-1", "agent-1"),
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };

  const callPreview = (cookie: string) => worker.fetch(request(
    "/api/operator/feature-flags/api_test_v0/evaluate-preview",
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        serverSlug: TEST_SERVER_SLUG,
        userId: "33333333-3333-4333-8333-333333333333",
        platform: "mobile",
      }),
    },
  ), env);

  const query = async (text: string) => {
    if (text === READ_ONLY_BEGIN || text === "COMMIT") return { rows: [] };
    if (isServerSlugLookup(text)) return { rows: [{ server_id: TEST_SERVER_ID }] };
    if (text.includes("FROM feature_flags") && text.includes("salt")) return { rows: [{
      key: "api_test_v0", enabled: true, kill_switch: false, randomization_unit: "user",
      default_enabled: true, default_variant: null, salt: "preview-salt",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [{
      id: CANONICAL_RULE_ID, stage: "platform", priority: 0, decision: "deny", values: ["mobile"],
      percentage_basis_points: null, variant: "legacy-variant-must-not-escape",
      created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "44" }] };
    throw new Error(`unexpected SQL ${text}`);
  };
  const [human, agent] = await withFetch((async () => {
    throw new Error("preview must not call the Raft server");
  }) as typeof fetch, async () => [
    await withPgMock(query, () => callPreview(humanCookie)),
    await withPgMock(query, () => callPreview(agentCookie)),
  ]);

  for (const response of [human, agent]) {
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as {
      data: { evaluation: Record<string, unknown> };
      configVersion: number;
    };
    assert.equal(body.configVersion, 44);
    assert.deepEqual(body.data.evaluation, {
      key: "api_test_v0",
      enabled: false,
      reason: "platform_rule",
    });
  }
});

test("UI preview helper bodies execute server-only, user-only, both, and neither through the Worker", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const userId = "33333333-3333-4333-8333-333333333333";
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  const scenarios = [
    { name: "server-only", body: previewBody(TEST_SERVER_SLUG, ""), reason: "default", slugReads: 1 },
    { name: "user-only", body: previewBody("", userId), reason: "missing_server_unit", slugReads: 0 },
    { name: "both", body: previewBody(TEST_SERVER_SLUG, userId), reason: "default", slugReads: 1 },
    { name: "neither", body: previewBody("", ""), reason: "missing_server_unit", slugReads: 0 },
  ] as const;

  for (const scenario of scenarios) {
    let slugReads = 0;
    const response = await withPgMock(async (text) => {
      if (text === READ_ONLY_BEGIN || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM feature_flags") && text.includes("salt")) return { rows: [{
        key: "api_test_v0", enabled: true, kill_switch: false, randomization_unit: "server",
        default_enabled: true, default_variant: null, salt: "preview-salt",
      }] };
      if (text.includes("FROM feature_flag_rules")) return { rows: [] };
      if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "44" }] };
      throw new Error(`unexpected SQL ${text}`);
    }, () => worker.fetch(request("/api/operator/feature-flags/api_test_v0/evaluate-preview", {
      method: "POST",
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify(scenario.body),
    }), env), {
      resolveServerSlug: (_serverSlug, text) => {
        slugReads += 1;
        assert.doesNotMatch(text, /FOR (?:SHARE|UPDATE)|LOCK IN SHARE MODE/);
        return [{ server_id: TEST_SERVER_ID }];
      },
    });
    assert.equal(response.status, 200, `${scenario.name}: ${await response.clone().text()}`);
    const body = await response.json() as { data: { evaluation: { reason: string } } };
    assert.equal(body.data.evaluation.reason, scenario.reason, scenario.name);
    assert.equal(slugReads, scenario.slugReads, scenario.name);
  }
});

test("feature flag detail projects active slugs and marks deleted or malformed server references", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const deletedServerId = "22222222-2222-4222-8222-222222222222";
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  const response = await withPgMock(async (text) => {
    if (text === READ_ONLY_BEGIN || text === "COMMIT") return { rows: [] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "read_receipts_v0",
      description: "Read receipts",
      enabled: true,
      kill_switch: false,
      randomization_unit: "server",
      default_enabled: false,
      default_variant: null,
      updated_at: "2026-08-21T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, [TEST_SERVER_ID, deletedServerId, "legacy-value"])] };
    }
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "45" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0", {
    headers: { Cookie: sessionCookie },
  }), env), {
    loadServerRefs: (serverIds) => {
      assert.deepEqual(serverIds.sort(), [TEST_SERVER_ID, deletedServerId].sort());
      return [
        activeServerRef(TEST_SERVER_ID, TEST_SERVER_SLUG),
        { id: deletedServerId, slug: "deleted-partner", deleted_at: "2026-08-20T00:00:00.000Z" },
      ];
    },
  });

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    data: {
      rules: Array<{ serverTargets?: Array<{ serverSlug: string | null; status: string }> }>;
      serverAllowlist: { serverTargets: Array<{ serverSlug: string | null; status: string }> };
    };
  };
  const expectedTargets = [
    { serverSlug: TEST_SERVER_SLUG, status: "active" },
    { serverSlug: null, status: "unknown_or_deleted" },
    { serverSlug: null, status: "unknown_or_deleted" },
  ];
  assert.deepEqual(body.data.rules[0]?.serverTargets, expectedTargets);
  assert.deepEqual(body.data.serverAllowlist.serverTargets, expectedTargets);
  assert.equal("serverRefs" in body.data, false);
  assert.doesNotMatch(JSON.stringify(body.data), new RegExp(TEST_SERVER_ID, "i"));
  assert.doesNotMatch(JSON.stringify(body.data), new RegExp(deletedServerId, "i"));
  assert.doesNotMatch(JSON.stringify(body.data), /legacy-value/i);
});

test("preview rejects legacy server ids before PG and fails closed for unknown or ambiguous slugs", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  let connectCalls = 0;
  const legacy = await withPgMock(async (text) => {
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/evaluate-preview", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: TEST_SERVER_ID }),
  }), env), {
    connect: async () => { connectCalls += 1; },
  });
  assert.equal(legacy.status, 400);
  assert.equal((await legacy.json() as { error: { code: string } }).error.code, "invalid_server_slug");
  assert.equal(connectCalls, 0);

  for (const scenario of ["unknown", "ambiguous"] as const) {
    let evaluatorReads = 0;
    const response = await withPgMock(async (text) => {
      if (text === READ_ONLY_BEGIN || text === "COMMIT") return { rows: [] };
      evaluatorReads += 1;
      throw new Error(`unexpected SQL ${text}`);
    }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/evaluate-preview", {
      method: "POST",
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ serverSlug: TEST_SERVER_SLUG }),
    }), env), {
      resolveServerSlug: (_serverSlug, text) => {
        assert.doesNotMatch(text, /FOR SHARE/);
        return scenario === "unknown"
          ? []
          : [{ server_id: TEST_SERVER_ID }, { server_id: "22222222-2222-4222-8222-222222222222" }];
      },
    });
    assert.equal(response.status, scenario === "unknown" ? 404 : 409);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      scenario === "unknown" ? "server_slug_unknown" : "server_slug_ambiguous",
    );
    assert.equal(evaluatorReads, 0, "fail-closed slug resolution must precede evaluator reads");
  }
});

test("server allowlist mutation rejects an unknown slug before audit or feature reads", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let auditCalls = 0;
  let featureReads = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1"),
  };
  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "7" }] };
    if (text.includes("FROM feature_flags") || text.includes("FROM feature_flag_rules")) featureReads += 1;
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: "missing-partner",
      targetRuleId: CANONICAL_RULE_ID,
      reason: "reject unknown server",
      expectedConfigVersion: 7,
    }),
  }), env), {
    resolveServerSlug: (_serverSlug, text) => {
      assert.doesNotMatch(text, /FOR (?:SHARE|UPDATE)|LOCK IN SHARE MODE/);
      return [];
    },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "server_slug_unknown");
  assert.equal(featureReads, 0);
  assert.equal(auditCalls, 0);
});

test("direct operator mutation validates request body before opening Hyperdrive client", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  let connectCalls = 0;

  const response = await withPgMock(async (text) => {
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverId: TEST_SERVER_ID,
      targetRuleId: CANONICAL_RULE_ID,
      reason: "dogfood",
      expectedConfigVersion: 7,
    }),
  }), env), {
    connect: async () => {
      connectCalls += 1;
    },
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "invalid_server_slug");
  assert.equal(connectCalls, 0);
});

test("direct operator mutation requires an exact target rule before opening Hyperdrive client", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let connectCalls = 0;
  const response = await withPgMock(async (text) => {
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/agent_migration_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: "not-a-rule-id",
      reason: "partner expansion",
      expectedConfigVersion: 7,
    }),
  }), {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  }), {
    connect: async () => {
      connectCalls += 1;
    },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_rule_id");
  assert.equal(connectCalls, 0);
});

test("direct operator mutation keeps Hyperdrive client open until mutation settles", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("audit unavailable");
          },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  let releaseBegin: (() => void) | undefined;
  let observeBegin: () => void = () => {};
  const beginObserved = new Promise<void>((resolve) => {
    observeBegin = resolve;
  });
  let endCalls = 0;

  const responsePromise = withPgMock(async (text) => {
    if (text === MUTATION_BEGIN) {
      observeBegin();
      return new Promise<{ rows: Array<Record<string, unknown>> }>((resolve) => {
        releaseBegin = () => resolve({ rows: [] });
      });
    }
    if (text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "7" }] };
    if (text.includes("FROM feature_flags WHERE key")) {
      return {
        rows: [{
          key: "read_receipts_v0",
          description: "Read receipts",
          enabled: true,
          kill_switch: false,
          randomization_unit: "server",
          default_enabled: false,
          default_variant: null,
          updated_at: "2026-07-09T00:00:00.000Z",
        }],
      };
    }
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, ["95f993fa-2a68-4797-b8ae-7beb7d984ada"])] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: CANONICAL_RULE_ID,
      reason: "dogfood",
      expectedConfigVersion: 7,
    }),
  }), env), {
    end: async () => {
      endCalls += 1;
    },
  });

  await beginObserved;
  assert.equal(endCalls, 0);
  assert.ok(releaseBegin);
  releaseBegin();
  const response = await responsePromise;

  assert.equal(response.status, 500, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json() as { error: { code: string } }).error.code, "audit_write_failed");
  assert.equal(endCalls, 1);
});

test("direct operator mutation fails before pg write when audit insert fails", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const seenSql: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("audit unavailable");
          },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    seenSql.push(text);
    if (text === MUTATION_BEGIN || text === "ROLLBACK") return { rows: [] };
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "7" }] };
    if (text.includes("FROM feature_flags WHERE key")) {
      return {
        rows: [{
          key: "read_receipts_v0",
          description: "Read receipts",
          enabled: true,
          kill_switch: false,
          randomization_unit: "server",
          default_enabled: false,
          default_variant: null,
          updated_at: "2026-07-09T00:00:00.000Z",
        }],
      };
    }
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, ["95f993fa-2a68-4797-b8ae-7beb7d984ada"])] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: CANONICAL_RULE_ID,
      reason: "dogfood",
      expectedConfigVersion: 7,
    }),
  }), env));

  assert.equal(response.status, 500, JSON.stringify(await response.clone().json()));
  const body = await response.json() as { error: { code: string } };
  assert.equal(body.error.code, "audit_write_failed");
  assert.equal(seenSql.some((text) => text.includes("UPDATE feature_flag_rules")), false);
  assert.equal(seenSql.some((text) => text.includes("INSERT INTO feature_flag_rules")), false);
  assert.equal(seenSql.some((text) => text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("direct operator scoped write targets the partner rule while preserving canonical and unsupported rules", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const botiverseServerId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
  const addedServerId = "11111111-1111-4111-8111-111111111111";
  const partnerServerIds = [
    "7b4da5cc-a4aa-43a8-9b2d-ffb734f21628",
    "a39adf98-7df8-4191-9e81-e7005524b696",
    "fb196d3c-bfad-418e-9df7-f838af10d2ff",
    "22222222-2222-4222-8222-222222222222",
  ];
  const rules = [
    {
      id: PARTNER_RULE_ID,
      stage: "server",
      priority: -20,
      decision: "allow",
      values: [...partnerServerIds],
      percentage_basis_points: null,
      variant: null,
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-13T00:00:00.000Z",
    },
    {
      id: CANONICAL_RULE_ID,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [botiverseServerId],
      percentage_basis_points: null,
      variant: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    {
      id: UNSUPPORTED_RULE_ID,
      stage: "server",
      priority: 20,
      decision: "deny",
      values: ["blocked-partner"],
      percentage_basis_points: null,
      variant: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];
  const untouchedUnsupportedRule = structuredClone(rules[2]);
  const seenRuleWrites: Array<{ text: string; values?: unknown[] }> = [];
  const seenLocks: unknown[][] = [];
  const auditRuns: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: (text: string) => ({
        bind: () => ({
          run: async () => {
            auditRuns.push(text);
          },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text, values) => {
    if (text.includes("pg_advisory_xact_lock")) {
      seenLocks.push(values ?? []);
      return { rows: [] };
    }
    if (text === MUTATION_BEGIN || text === "COMMIT") return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "5" }] };
    if (text.includes("FROM feature_flags WHERE key")) {
      return { rows: [{
        key: "agent_migration_v0",
        description: "Agent migration",
        enabled: true,
        kill_switch: false,
        randomization_unit: "server",
        default_enabled: false,
        default_variant: null,
        updated_at: "2026-07-13T00:00:00.000Z",
      }] };
    }
    if (text.includes("FROM feature_flag_rules")) {
      assert.match(text, /ORDER BY stage ASC, priority ASC, created_at ASC, id ASC/);
      return { rows: structuredClone(rules) };
    }
    if (text.includes("UPDATE feature_flag_rules")) {
      seenRuleWrites.push({ text, values });
      assert.equal(values?.[1], PARTNER_RULE_ID);
      assert.equal(values?.[2], "agent_migration_v0");
      rules[0]!.values = JSON.parse(String(values?.[0])) as string[];
      rules[0]!.updated_at = "2026-07-13T01:00:00.000Z";
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "6" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/agent_migration_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: PARTNER_RULE_ID,
      reason: "partner expansion",
      expectedConfigVersion: 5,
    }),
  }), env));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as {
    configVersion: number;
    data: {
      serverAllowlist: { managed: boolean; ruleId: string; serverTargets: Array<{ serverSlug: string | null; status: string }> };
      serverAllowlistRules: Array<{ ruleId: string; priority: number; serverTargets: Array<{ serverSlug: string | null; status: string }> }>;
      unsupportedRuleShapes: string[];
    };
  };
  assert.equal(body.configVersion, 6);
  assert.deepEqual(body.data.serverAllowlist, {
    managed: true,
    ruleId: CANONICAL_RULE_ID,
    serverTargets: [{ serverSlug: `server-${botiverseServerId.slice(0, 8)}`, status: "active" }],
  });
  assert.deepEqual(body.data.serverAllowlistRules.map((rule) => ({
    ...rule,
    serverTargets: rule.serverTargets.map((target) => target.serverSlug),
  })), [
    {
      ruleId: PARTNER_RULE_ID,
      priority: -20,
      serverTargets: [...partnerServerIds, addedServerId]
        .sort()
        .map((id) => id === addedServerId ? TEST_SERVER_SLUG : `server-${id.slice(0, 8)}`),
    },
    { ruleId: CANONICAL_RULE_ID, priority: 0, serverTargets: [`server-${botiverseServerId.slice(0, 8)}`] },
  ]);
  assert.deepEqual(body.data.unsupportedRuleShapes, [UNSUPPORTED_RULE_ID]);
  assert.deepEqual(rules[0]!.values, [...partnerServerIds, addedServerId].sort());
  assert.deepEqual(rules[1]!.values, [botiverseServerId]);
  assert.deepEqual(rules[2], untouchedUnsupportedRule);
  assert.equal(seenRuleWrites.length, 1);
  assert.equal(seenRuleWrites.some((write) => write.values?.includes(CANONICAL_RULE_ID)), false);
  assert.equal(seenLocks.length, 2);
  assert.deepEqual(seenLocks[0], [0x46464356, 0], "Worker and canonical server writers must share the FFCV/0 lock identity");
  assert.equal(seenLocks[1]?.[0], 0x46464c47, "Worker and canonical server writers must share the FFLG per-flag lock namespace");
  assert.equal(Number.isInteger(seenLocks[1]?.[1]), true);
  assert.equal(auditRuns.length, 2);
});

test("direct operator scoped write preserves the selected rule identity when its list becomes empty", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const removedServerId = "11111111-1111-4111-8111-111111111111";
  const rules = [
    plainServerRuleRow(PARTNER_RULE_ID, -20, [removedServerId]),
    plainServerRuleRow(CANONICAL_RULE_ID, 0, ["95f993fa-2a68-4797-b8ae-7beb7d984ada"]),
  ];
  const seenWrites: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text, values) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "5" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "agent_migration_v0", enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      description: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: structuredClone(rules) };
    if (text.includes("UPDATE feature_flag_rules")) {
      seenWrites.push(text);
      assert.equal(values?.[1], PARTNER_RULE_ID);
      rules[0]!.values = JSON.parse(String(values?.[0])) as string[];
      rules[0]!.updated_at = "2026-07-13T01:00:00.000Z";
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "6" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request(`/api/operator/feature-flags/agent_migration_v0/server-allowlist/${TEST_SERVER_SLUG}`, {
    method: "DELETE",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ targetRuleId: PARTNER_RULE_ID, reason: "partner cleanup", expectedConfigVersion: 5 }),
  }), env));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as {
    data: { serverAllowlistRules: Array<{ ruleId: string; priority: number; serverTargets: Array<{ serverSlug: string | null; status: string }> }> };
  };
  assert.deepEqual(body.data.serverAllowlistRules, [
    { ruleId: PARTNER_RULE_ID, priority: -20, serverTargets: [] },
    { ruleId: CANONICAL_RULE_ID, priority: 0, serverTargets: [{ serverSlug: "server-95f993fa", status: "active" }] },
  ]);
  assert.deepEqual(rules[0]!.values, []);
  assert.equal(seenWrites.length, 1);
  assert.equal(seenWrites.some((text) => text.includes("DELETE FROM feature_flag_rules")), false);
});

test("direct operator creates the first server allowlist rule with audit, CAS, and readback", async () => {
  const sessionCookie = await createAgentSessionCookie();
  const serverA = "11111111-1111-4111-8111-111111111111";
  const serverB = "22222222-2222-4222-8222-222222222222";
  const labRule = labRuleRow("33333333-3333-4333-8333-333333333333", 10, "allow", ["alpha"]);
  const createdRuleId = "44444444-4444-4444-8444-444444444444";
  let insertedRule = false;
  let canonicalCalls = 0;
  const auditBinds: unknown[][] = [];
  const sqlTexts: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { auditBinds.push(values); } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withFetch((async () => {
    canonicalCalls += 1;
    throw new Error("direct operator mutation must not call a Raft-core admin endpoint");
  }) as typeof fetch, () => withPgMock(async (text) => {
    sqlTexts.push(text);
    if (isTransactionControl(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "42" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "read_receipts_v0",
      description: "Read receipts",
      enabled: true,
      kill_switch: false,
      randomization_unit: "server",
      default_enabled: false,
      default_variant: null,
      updated_at: "2026-07-24T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      return {
        rows: insertedRule ? [
          labRule,
          plainServerRuleRow(createdRuleId, 0, [serverA, serverB].sort()),
        ] : [
          labRule,
        ],
      };
    }
    if (text.includes("INSERT INTO feature_flag_rules")) {
      insertedRule = true;
      return { rows: [{ id: createdRuleId }] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "43" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist/rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlugs: ["partner-beta", TEST_SERVER_SLUG, "partner-beta"],
      reason: "seed the first server allowlist rule",
      expectedConfigVersion: 42,
    }),
  }), env), {
    resolveServerSlug: (serverSlug, text) => {
      assert.doesNotMatch(text, /FOR (?:SHARE|UPDATE)|LOCK IN SHARE MODE/);
      if (serverSlug === TEST_SERVER_SLUG) return [{ server_id: serverA }];
      if (serverSlug === "partner-beta") return [{ server_id: serverB }];
      return [];
    },
    loadServerRefs: (serverIds) => serverIds.map((serverId) => activeServerRef(
      serverId,
      serverId === serverA ? TEST_SERVER_SLUG : "partner-beta",
    )),
  }));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as {
    configVersion: number;
    data: {
      changed: boolean;
      auditEventId: string;
      ruleId: string;
      flag: { defaultEnabled: boolean; killSwitch: boolean };
      serverAllowlist: { managed: boolean; ruleId: string; serverTargets: Array<{ serverSlug: string | null; status: string }> };
      serverAllowlistRules: Array<{ ruleId: string; priority: number; serverTargets: Array<{ serverSlug: string | null; status: string }> }>;
    };
  };
  assert.equal(body.configVersion, 43);
  assert.equal(body.data.changed, true);
  assert.equal(body.data.ruleId, createdRuleId);
  assert.equal(insertedRule, true);
  assert.equal(body.data.flag.defaultEnabled, false);
  assert.equal(body.data.flag.killSwitch, false);
  assert.deepEqual(body.data.serverAllowlist, {
    managed: true,
    ruleId: createdRuleId,
    serverTargets: [
      { serverSlug: TEST_SERVER_SLUG, status: "active" },
      { serverSlug: "partner-beta", status: "active" },
    ],
  });
  assert.deepEqual(body.data.serverAllowlistRules, [{
    ruleId: createdRuleId,
    priority: 0,
    serverTargets: [
      { serverSlug: TEST_SERVER_SLUG, status: "active" },
      { serverSlug: "partner-beta", status: "active" },
    ],
  }]);
  assert.equal(canonicalCalls, 0);
  const globalLockIndex = sqlTexts.findIndex((text) => text.includes("pg_advisory_xact_lock"));
  const mutationBeginIndex = sqlTexts.indexOf(MUTATION_BEGIN);
  assert.equal(mutationBeginIndex, 0, "the transaction must pin a Hyperdrive backend before locking");
  assert.ok(globalLockIndex > mutationBeginIndex, "transaction-scoped serialization must follow BEGIN");
  assert.equal(sqlTexts.some((text) => text.includes("pg_advisory_lock(")), false);
  assert.equal(sqlTexts.some((text) => text.includes("pg_advisory_unlock_all")), false);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_rules")), true);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_config_versions")), true);
  assert.equal(sqlTexts.some((text) => text.includes("UPDATE feature_flags")), false);
  assert.equal(auditBinds.length, 2);
  assert.equal(auditBinds[0]?.[5], "server_allowlist_first_rule_create");
  assert.equal(auditBinds[0]?.[7], "feature_flag");
  assert.doesNotMatch(JSON.stringify(auditBinds), /partner-alpha|partner-beta/);
  assert.match(JSON.stringify(auditBinds), new RegExp(`${serverA}|${serverB}`));
  assert.equal(auditBinds[0]?.[8], "read_receipts_v0");
  assert.doesNotMatch(JSON.stringify(body.data), new RegExp(`${serverA}|${serverB}`));
});

test("direct operator creates the exact Apple web platform rule with pre-audit, CAS, and readback", async () => {
  const sessionCookie = await createAgentSessionCookie();
  const createdRuleId = "55555555-5555-4555-8555-555555555555";
  let insertedRule = false;
  let canonicalCalls = 0;
  const auditBinds: unknown[][] = [];
  const sqlTexts: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => { auditBinds.push(values); },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withFetch((async () => {
    canonicalCalls += 1;
    throw new Error("direct operator mutation must not call a Raft-core admin endpoint");
  }) as typeof fetch, () => withPgMock(async (text) => {
    sqlTexts.push(text);
    if (isTransactionControl(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "21" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "apple_web_login_v0",
      description: "Apple web login",
      enabled: true,
      kill_switch: false,
      randomization_unit: "user",
      default_enabled: false,
      default_variant: null,
      updated_at: "2026-07-30T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: insertedRule ? [webPlatformRuleRow(createdRuleId)] : [] };
    }
    if (text.includes("INSERT INTO feature_flag_rules")) {
      insertedRule = true;
      return { rows: [{ id: createdRuleId }] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "22" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request(
    "/api/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules",
    {
      method: "POST",
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "enable reviewed Apple web login",
        expectedConfigVersion: 21,
      }),
    },
  ), env)));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as {
    configVersion: number;
    data: {
      changed: boolean;
      auditEventId: string;
      ruleId: string;
      flag: { defaultEnabled: boolean; killSwitch: boolean; randomizationUnit: string };
      rules: Array<{
        id: string;
        stage: string;
        priority: number;
        decision: string;
        values: string[];
        percentageBasisPoints: number | null;
        variant: string | null;
      }>;
    };
  };
  assert.equal(body.configVersion, 22);
  assert.equal(body.data.changed, true);
  assert.equal(body.data.ruleId, createdRuleId);
  assert.equal(insertedRule, true);
  assert.deepEqual(body.data.flag, {
    key: "apple_web_login_v0",
    description: "Apple web login",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "user",
    defaultEnabled: false,
    defaultVariant: null,
    highRisk: false,
    updatedAt: "2026-07-30T00:00:00.000Z",
  });
  assert.deepEqual(body.data.rules.map((rule) => ({
    id: rule.id,
    stage: rule.stage,
    priority: rule.priority,
    decision: rule.decision,
    values: rule.values,
    percentageBasisPoints: rule.percentageBasisPoints,
    variant: rule.variant,
  })), [{
    id: createdRuleId,
    stage: "platform",
    priority: 0,
    decision: "allow",
    values: ["web"],
    percentageBasisPoints: null,
    variant: null,
  }]);
  assert.equal(canonicalCalls, 0);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_rules")), true);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_config_versions")), true);
  assert.equal(auditBinds.length, 2);
  assert.equal(auditBinds[0]?.[5], "apple_web_platform_first_rule_create");
  assert.equal(auditBinds[0]?.[6], "apple_web_login_v0");
  assert.equal(auditBinds[0]?.[8], "apple_web_login_v0");
});

test("Apple web action holds before audit/canonical mutation for version, flag, or rule conflicts", async () => {
  const sessionCookie = await createHumanSessionCookie();
  for (const scenario of ["version", "absent", "existing-platform"] as const) {
    let auditCalls = 0;
    let canonicalCalls = 0;
    const env = {
      ...baseEnv,
      FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
      FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
        prepare: () => ({
          bind: () => ({ run: async () => { auditCalls += 1; } }),
        }),
      } as unknown as D1Database, "human-1", "agent-1"),
    };
    const response = await withFetch((async () => {
      canonicalCalls += 1;
      throw new Error("canonical mutation must not run for a held Apple web action");
    }) as typeof fetch, () => withPgMock(async (text) => {
      if (isTransactionControl(text) || text.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (text.includes("FROM feature_flag_config_versions")) {
        return { rows: [{ version: scenario === "version" ? "22" : "21" }] };
      }
      if (text.includes("FROM feature_flags WHERE key")) {
        return scenario === "absent" ? { rows: [] } : { rows: [{
          key: "apple_web_login_v0",
          description: null,
          enabled: true,
          kill_switch: false,
          randomization_unit: "user",
          default_enabled: false,
          default_variant: null,
          updated_at: "2026-07-30T00:00:00.000Z",
        }] };
      }
      if (text.includes("FROM feature_flag_rules")) {
        return { rows: [webPlatformRuleRow("66666666-6666-4666-8666-666666666666")] };
      }
      throw new Error(`unexpected SQL ${text}`);
    }, () => worker.fetch(request(
      "/api/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules",
      {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "held Apple web action",
          expectedConfigVersion: 21,
        }),
      },
    ), env)));
    assert.equal(response.status, scenario === "absent" ? 404 : 409);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      scenario === "version"
        ? "version_conflict"
        : scenario === "absent"
          ? "flag_not_found"
          : "rule_shape_unsupported",
    );
    assert.equal(auditCalls, 0);
    assert.equal(canonicalCalls, 0);
  }
});

test("direct operator first server rule rejects legacy server ids before opening Hyperdrive client", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let connectCalls = 0;
  const response = await withPgMock(async (text) => {
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist/rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverIds: ["not-a-uuid"],
      reason: "seed the first server allowlist rule",
      expectedConfigVersion: 42,
    }),
  }), {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  }), {
    connect: async () => { connectCalls += 1; },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_server_slug");
  assert.equal(connectCalls, 0);
});

test("direct operator first server rule rejects preexisting server rules before audit or mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let auditCalls = 0;
  const writes: string[] = [];
  let canonicalCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withFetch((async () => {
    canonicalCalls += 1;
    throw new Error("canonical writer must not be called when a server rule already exists");
  }) as typeof fetch, () => withPgMock(async (text) => {
    if (isTransactionControl(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "42" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "read_receipts_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      updated_at: "2026-07-24T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, [baseEnv.FEATURE_FLAG_ALLOWED_SERVER_IDS!])] };
    writes.push(text);
    return { rows: [] };
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist/rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlugs: [TEST_SERVER_SLUG],
      reason: "must not create a second server rule",
      expectedConfigVersion: 42,
    }),
  }), env)));

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "rule_shape_unsupported");
  assert.equal(auditCalls, 0);
  assert.equal(canonicalCalls, 0);
  assert.deepEqual(writes, []);
});

test("direct operator first server rule fails closed if readback changes flag defaults", async () => {
  const sessionCookie = await createAgentSessionCookie();
  let canonicalCalls = 0;
  let flagReadCount = 0;
  let ruleReadCount = 0;
  const createdRuleId = "44444444-4444-4444-8444-444444444444";
  const sqlTexts: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withFetch((async () => {
    canonicalCalls += 1;
    return Response.json({ rule: { id: createdRuleId }, configVersion: 43 }, { status: 201 });
  }) as typeof fetch, () => withPgMock(async (text) => {
    sqlTexts.push(text);
    if (isTransactionControl(text) || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "42" }] };
    if (text.includes("FROM feature_flags WHERE key")) {
      flagReadCount += 1;
      return { rows: [{
        key: "read_receipts_v0", description: null, enabled: true, kill_switch: false,
        randomization_unit: "server", default_enabled: flagReadCount > 1, default_variant: null,
        updated_at: "2026-07-24T00:00:00.000Z",
      }] };
    }
    if (text.includes("FROM feature_flag_rules")) {
      ruleReadCount += 1;
      return { rows: ruleReadCount > 1 ? [plainServerRuleRow(createdRuleId, 0, ["11111111-1111-4111-8111-111111111111"])] : [] };
    }
    if (text.includes("INSERT INTO feature_flag_rules")) return { rows: [{ id: createdRuleId }] };
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "43" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/read_receipts_v0/server-allowlist/rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlugs: [TEST_SERVER_SLUG],
      reason: "guard readback",
      expectedConfigVersion: 42,
    }),
  }), env)));

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "rule_shape_unsupported");
  assert.equal(canonicalCalls, 0);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_rules")), true);
  assert.equal(sqlTexts.some((text) => text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("direct operator scoped write rejects a missing target rule before audit or mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const missingRuleId = "22222222-2222-4222-8222-222222222222";
  const writes: string[] = [];
  let auditCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "5" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "agent_migration_v0", enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      description: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, [baseEnv.FEATURE_FLAG_ALLOWED_SERVER_IDS!])] };
    }
    writes.push(text);
    return { rows: [] };
  }, () => worker.fetch(request("/api/operator/feature-flags/agent_migration_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: missingRuleId,
      reason: "missing target",
      expectedConfigVersion: 5,
    }),
  }), env));

  assert.equal(response.status, 404);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "rule_not_found");
  assert.equal(auditCalls, 0);
  assert.deepEqual(writes, []);
});

test("direct operator scoped write rejects an unsupported selected rule before audit or mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const writes: string[] = [];
  let auditCalls = 0;
  const unsupportedRuleId = "22222222-2222-4222-8222-222222222222";
  const unsupportedRule = {
    id: unsupportedRuleId,
    stage: "server",
    priority: -20,
    decision: "deny",
    values: ["11111111-1111-4111-8111-111111111111"],
    percentage_basis_points: null,
    variant: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "5" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "agent_migration_v0", enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      description: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      return { rows: [plainServerRuleRow(CANONICAL_RULE_ID, 0, [baseEnv.FEATURE_FLAG_ALLOWED_SERVER_IDS!]), unsupportedRule] };
    }
    writes.push(text);
    return { rows: [] };
  }, () => worker.fetch(request("/api/operator/feature-flags/agent_migration_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: unsupportedRuleId,
      reason: "unsupported target",
      expectedConfigVersion: 5,
    }),
  }), env));

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "rule_shape_unsupported");
  assert.equal(auditCalls, 0);
  assert.deepEqual(writes, []);
});

test("direct operator scoped write rolls back if a non-target rule changes", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const addedServerId = "11111111-1111-4111-8111-111111111111";
  const botiverseServerId = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
  let ruleReads = 0;
  let rolledBack = false;
  let bumpedVersion = false;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const ruleRows = (partnerValues: string[], canonicalValues: string[]) => [
    {
      id: PARTNER_RULE_ID, stage: "server", priority: -20, decision: "allow", values: partnerValues,
      percentage_basis_points: null, variant: null,
      created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z",
    },
    {
      id: CANONICAL_RULE_ID, stage: "server", priority: 0, decision: "allow", values: canonicalValues,
      percentage_basis_points: null, variant: null,
      created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
    },
  ];

  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text.includes("pg_advisory_xact_lock") || text.includes("UPDATE feature_flag_rules")) return { rows: [] };
    if (text === "ROLLBACK") { rolledBack = true; return { rows: [] }; }
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "5" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "agent_migration_v0", enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      description: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) {
      ruleReads += 1;
      return ruleReads === 1
        ? { rows: ruleRows(["partner-a"], [botiverseServerId]) }
        : { rows: ruleRows([addedServerId, "partner-a"].sort(), [botiverseServerId, "unexpected-canonical-change"]) };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      bumpedVersion = true;
      return { rows: [{ version: "6" }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/agent_migration_v0/server-allowlist", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      serverSlug: TEST_SERVER_SLUG,
      targetRuleId: PARTNER_RULE_ID,
      reason: "scope guard",
      expectedConfigVersion: 5,
    }),
  }), env));

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "rule_shape_unsupported");
  assert.equal(rolledBack, true);
  assert.equal(bumpedVersion, false);
});

test("direct operator defaultEnabled write is audited, versioned, and preserves rules", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const rules = [plainServerRuleRow(CANONICAL_RULE_ID, 0, [baseEnv.FEATURE_FLAG_ALLOWED_SERVER_IDS!])];
  const originalRules = structuredClone(rules);
  let defaultEnabled = false;
  let updatedAt = "2026-07-13T00:00:00.000Z";
  const auditBinds: unknown[][] = [];
  const seenWrites: Array<{ text: string; values?: unknown[] }> = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => { auditBinds.push(values); },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text, values) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "8" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: "Grok runtime", enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: defaultEnabled, default_variant: null, updated_at: updatedAt,
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: structuredClone(rules) };
    if (text.includes("UPDATE feature_flags SET default_enabled")) {
      seenWrites.push({ text, values });
      assert.deepEqual(values, [true, "grok_runtime_v0"]);
      defaultEnabled = true;
      updatedAt = "2026-07-13T01:00:00.000Z";
      return { rows: [{ key: "grok_runtime_v0" }] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "9" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "public rollout", expectedConfigVersion: 8 }),
  }), env));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as {
    configVersion: number;
    data: { changed: boolean; auditEventId: string; flag: { defaultEnabled: boolean }; rules: unknown[] };
  };
  assert.equal(body.configVersion, 9);
  assert.equal(body.data.changed, true);
  assert.equal(body.data.flag.defaultEnabled, true);
  assert.equal(typeof body.data.auditEventId, "string");
  assert.deepEqual(body.data.rules, originalRules.map((rule) => ({
    id: rule.id, stage: rule.stage, priority: rule.priority, decision: rule.decision,
    percentageBasisPoints: rule.percentage_basis_points, variant: rule.variant,
    createdAt: rule.created_at, updatedAt: rule.updated_at,
    serverTargets: rule.values.map((id) => ({ serverSlug: `server-${id.slice(0, 8)}`, status: "active" })),
  })));
  assert.equal(seenWrites.length, 1);
  assert.match(seenWrites[0]!.text, /default_enabled IS DISTINCT FROM \$1 RETURNING key/);
  assert.equal(auditBinds.length, 2);
  assert.equal(auditBinds[0]?.[5], "default_enabled_update");
  assert.equal(auditBinds[0]?.[7], "flag");
  assert.equal(auditBinds[0]?.[8], "grok_runtime_v0");
});

test("direct operator defaultEnabled no-op does not audit, write, or bump", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const seenSql: string[] = [];
  let auditCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    seenSql.push(text);
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "8" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: true, default_variant: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "idempotent retry", expectedConfigVersion: 8 }),
  }), env));

  assert.equal(response.status, 200);
  const body = await response.json() as { configVersion: number; data: { changed: boolean; auditEventId: null } };
  assert.deepEqual({ configVersion: body.configVersion, changed: body.data.changed, auditEventId: body.data.auditEventId }, {
    configVersion: 8, changed: false, auditEventId: null,
  });
  assert.equal(auditCalls, 0);
  assert.equal(seenSql.some((text) => text.includes("UPDATE feature_flags") || text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("three pooled backend returns cannot strand a session lock before the fourth mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("human-1"),
  };
  let connectionNumber = 0;
  let returnedConnections = 0;
  let strandedGlobalSessionOwner: number | null = null;
  let sessionLockQueries = 0;
  let sessionCleanupQueries = 0;
  let transactionLockQueries = 0;

  const responses = await withPgMock(async (text, values) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK") return { rows: [] };
    if (text.includes("pg_advisory_xact_lock")) {
      transactionLockQueries += 1;
      return { rows: [] };
    }
    // This branch models the production failure: a session lock lives on a
    // pooled backend, while the cleanup query may run on a different backend.
    // It is unreachable with transaction-scoped locks and makes a regression
    // to pg_advisory_lock fail on the fourth request for the right reason.
    if (text.includes("pg_advisory_lock(")) {
      sessionLockQueries += 1;
      if (values?.[0] === 0x46464356) {
        if (strandedGlobalSessionOwner !== null && strandedGlobalSessionOwner !== connectionNumber) {
          throw new Error("pooled backend is waiting on a stranded global session lock");
        }
        strandedGlobalSessionOwner = connectionNumber;
      }
      return { rows: [] };
    }
    if (text === "SELECT pg_advisory_unlock_all()") {
      sessionCleanupQueries += 1;
      if (connectionNumber < 3) strandedGlobalSessionOwner = null;
      return { rows: [] };
    }
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "43" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "pooled_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      updated_at: "2026-09-08T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, async () => {
    const results: Response[] = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await worker.fetch(request("/api/operator/feature-flags/pooled_runtime_v0/default-enabled", {
        method: "POST",
        headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultEnabled: false,
          reason: `pooled no-op ${index + 1}`,
          expectedConfigVersion: 43,
        }),
      }), env));
    }
    return results;
  }, {
    connect: async () => { connectionNumber += 1; },
    end: async () => { returnedConnections += 1; },
    passSessionCleanupToQuery: true,
  });

  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
  assert.equal(connectionNumber, 4);
  assert.equal(returnedConnections, 4);
  assert.equal(transactionLockQueries, 8, "each mutation must take global and per-flag xact locks");
  assert.equal(sessionLockQueries, 0);
  assert.equal(sessionCleanupQueries, 0);
  assert.equal(strandedGlobalSessionOwner, null);
});

test("direct operator defaultEnabled rejects an overlong reason before opening pg or writing audit", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let connectCalls = 0;
  let auditCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultEnabled: true,
      reason: "x".repeat(FEATURE_FLAG_AUDIT_REASON_MAX_LENGTH + 1),
      expectedConfigVersion: 8,
    }),
  }), env), {
    connect: async () => { connectCalls += 1; },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "invalid_request");
  assert.equal(connectCalls, 0);
  assert.equal(auditCalls, 0);
});

test("direct operator defaultEnabled rejects stale and missing requests before audit or write", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let auditCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const stale = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "9" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "stale request", expectedConfigVersion: 8 }),
  }), env));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: { code: string } }).error.code, "version_conflict");

  const missing = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "9" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/missing_flag/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "missing flag", expectedConfigVersion: 9 }),
  }), env));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "flag_not_found");
  assert.equal(auditCalls, 0);
});

test("direct operator defaultEnabled audit failure rolls back before pg mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const seenSql: string[] = [];
  let rollbackCalls = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { throw new Error("audit unavailable"); } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    seenSql.push(text);
    if (text === "ROLLBACK") { rollbackCalls += 1; return { rows: [] }; }
    if (text === MUTATION_BEGIN || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "8" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null, updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "public rollout", expectedConfigVersion: 8 }),
  }), env));

  assert.equal(response.status, 500);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "audit_write_failed");
  assert.ok(rollbackCalls > 0);
  assert.equal(seenSql.some((text) => text.includes("UPDATE feature_flags") || text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("direct operator defaultEnabled rolls back without commit or version bump when pg update throws", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let rollbackCalls = 0;
  let commitCalls = 0;
  let bumpedVersion = false;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text === "ROLLBACK") { rollbackCalls += 1; return { rows: [] }; }
    if (text === "COMMIT") { commitCalls += 1; return { rows: [] }; }
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "8" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      updated_at: "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    if (text.includes("UPDATE feature_flags SET default_enabled")) throw new Error("pg update failed");
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      bumpedVersion = true;
      return { rows: [{ version: "9" }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "public rollout", expectedConfigVersion: 8 }),
  }), env));

  assert.equal(response.status, 500);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "internal_error");
  assert.ok(rollbackCalls > 0);
  assert.equal(commitCalls, 0);
  assert.equal(bumpedVersion, false);
});

test("direct operator defaultEnabled rolls back if the post-write scope drifts", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let defaultEnabled = false;
  let description = "Grok runtime";
  let rolledBack = false;
  let bumpedVersion = false;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text) => {
    if (text === MUTATION_BEGIN || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text === "ROLLBACK") { rolledBack = true; return { rows: [] }; }
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "8" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: defaultEnabled, default_variant: null,
      updated_at: defaultEnabled ? "2026-07-13T01:00:00.000Z" : "2026-07-13T00:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    if (text.includes("UPDATE feature_flags SET default_enabled")) {
      defaultEnabled = true;
      description = "unexpected concurrent drift";
      return { rows: [{ key: "grok_runtime_v0" }] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      bumpedVersion = true;
      return { rows: [{ version: "9" }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/default-enabled", {
    method: "POST", headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ defaultEnabled: true, reason: "public rollout", expectedConfigVersion: 8 }),
  }), env));

  assert.equal(response.status, 500);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "internal_error");
  assert.equal(rolledBack, true);
  assert.equal(bumpedVersion, false);
});

test("direct operator creates a draft Lab with audit-before-write, CAS, and authoritative readback", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let inserted = false;
  const auditBinds: unknown[][] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { auditBinds.push(values); } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };

  const response = await withPgMock(async (text, values) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "12" }] };
    if (text.includes("FROM lab_definitions WHERE key")) {
      return { rows: inserted ? [{
        key: "search_v2", name: "Search v2", description: "New ranking path", state: "draft",
        created_at: "2026-07-22T14:00:00.000Z", updated_at: "2026-07-22T14:00:00.000Z",
      }] : [] };
    }
    if (text.includes("INSERT INTO lab_definitions")) {
      assert.deepEqual(values, ["search_v2", "Search v2", "New ranking path"]);
      assert.equal(auditBinds.length, 1, "audit insert must finish before PG mutation");
      inserted = true;
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "13" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/labs", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      labKey: "search_v2", name: "Search v2", description: "New ranking path",
      reason: "start controlled Lab", expectedConfigVersion: 12,
    }),
  }), env));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as { configVersion: number; data: { changed: boolean; lab: { key: string; state: string } } };
  assert.deepEqual({ configVersion: body.configVersion, changed: body.data.changed, lab: body.data.lab }, {
    configVersion: 13,
    changed: true,
    lab: {
      labKey: "search_v2", name: "Search v2", description: "New ranking path", state: "draft",
      createdAt: "2026-07-22T14:00:00.000Z", updatedAt: "2026-07-22T14:00:00.000Z",
    },
  });
  assert.equal(auditBinds.length, 2);
  assert.equal(auditBinds[0]?.[5], "lab_create");
  assert.equal(auditBinds[0]?.[7], "lab");
});

test("human and Agent Login catalog reads share the canonical labKey round-trip", async () => {
  const humanCookie = await createHumanSessionCookie();
  const agentCookie = await createAgentSessionCookie();
  const env = {
    ...baseEnv,
    FEATURE_FLAG_AUDIT_DB: persistentAdminDb("human-1", "agent-1"),
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
  };
  const read = (cookie: string) => withPgMock(async (text) => {
    if (text.includes("FROM lab_definitions") && text.includes("ORDER BY key ASC")) return { rows: [{
      key: "search_v2", name: "Search v2", description: "New ranking path", state: "open",
      created_at: "2026-07-22T14:00:00.000Z", updated_at: "2026-07-22T15:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "13" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/labs", { headers: { Cookie: cookie } }), env));

  const human = await read(humanCookie);
  const agent = await read(agentCookie);
  assert.equal(human.status, 200);
  assert.equal(agent.status, 200);
  const humanBody = await human.json() as { data: { labs: Array<Record<string, unknown>> }; configVersion: number };
  const agentBody = await agent.json() as { data: { labs: Array<Record<string, unknown>> }; configVersion: number };
  assert.deepEqual({ data: agentBody.data, configVersion: agentBody.configVersion }, {
    data: humanBody.data,
    configVersion: humanBody.configVersion,
  });
  assert.equal(humanBody.data.labs[0]?.labKey, "search_v2");
  assert.equal(Object.hasOwn(humanBody.data.labs[0] ?? {}, "key"), false);
});

test("Lab lifecycle is terminal after retirement and rejects before audit or mutation", async () => {
  const sessionCookie = await createHumanSessionCookie();
  let auditCalls = 0;
  const seenSql: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const response = await withPgMock(async (text) => {
    seenSql.push(text);
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "13" }] };
    if (text.includes("FROM lab_definitions WHERE key")) return { rows: [{
      key: "search_v2", name: "Search v2", description: "New ranking path", state: "retired",
      created_at: "2026-07-22T14:00:00.000Z", updated_at: "2026-07-22T14:30:00.000Z",
    }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/labs/search_v2", {
    method: "PATCH",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Renamed retired Lab", reason: "try edit history", expectedConfigVersion: 13 }),
  }), env));
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "lab_state_transition_invalid");
  assert.equal(auditCalls, 0);
  assert.equal(seenSql.some((text) => text.includes("UPDATE lab_definitions") || text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("direct operator creates a v1 Lab rule with active Lab validation and no variant", async () => {
  const sessionCookie = await createAgentSessionCookie();
  const auditBinds: unknown[][] = [];
  let createdRuleId: string | null = null;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { auditBinds.push(values); } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const flagRow = {
    key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
    randomization_unit: "server", default_enabled: false, default_variant: null,
    updated_at: "2026-07-22T14:00:00.000Z",
  };
  const response = await withPgMock(async (text, values) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "20" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [flagRow] };
    if (text.includes("FROM feature_flag_rules")) return { rows: createdRuleId ? [{
      id: createdRuleId, stage: "lab", priority: 40, decision: "allow", values: ["alpha", "beta"],
      percentage_basis_points: null, variant: null,
      created_at: "2026-07-22T14:00:00.000Z", updated_at: "2026-07-22T14:00:00.000Z",
    }] : [] };
    if (text.includes("WHERE key = ANY")) {
      assert.match(text, /state = 'open'/);
      return { rows: [{ key: "alpha" }, { key: "beta" }] };
    }
    if (text.includes("INSERT INTO feature_flag_rules")) {
      createdRuleId = String(values?.[0]);
      assert.deepEqual(values?.slice(1), ["grok_runtime_v0", 40, "allow", '["alpha","beta"]']);
      assert.equal(auditBinds.length, 1, "audit insert must finish before PG mutation");
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) return { rows: [{ version: "21" }] };
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/lab-rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      labKeys: ["beta", "alpha", "beta"], decision: "allow", priority: 40,
      reason: "enroll Labs", expectedConfigVersion: 20,
    }),
  }), env));

  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await response.json() as { configVersion: number; data: { changed: boolean; ruleId: string; rules: Array<Record<string, unknown>> } };
  assert.equal(body.configVersion, 21);
  assert.equal(body.data.changed, true);
  assert.equal(body.data.ruleId, createdRuleId);
  assert.deepEqual(body.data.rules[0], {
    id: createdRuleId, stage: "lab", priority: 40, decision: "allow", values: ["alpha", "beta"],
    percentageBasisPoints: null, variant: null,
    createdAt: "2026-07-22T14:00:00.000Z", updatedAt: "2026-07-22T14:00:00.000Z",
  });
  assert.equal(auditBinds.length, 2);
  assert.equal(auditBinds[0]?.[5], "lab_rule_create");
  assert.equal(auditBinds[0]?.[7], "lab_rule");
});

test("direct operator rejects a paused Lab as a new rule target before audit or mutation", async () => {
  const sessionCookie = await createAgentSessionCookie();
  let auditCalls = 0;
  const seenSql: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => { auditCalls += 1; } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const response = await withPgMock(async (text) => {
    seenSql.push(text);
    if (text === MUTATION_BEGIN || text === "ROLLBACK" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: "20" }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      updated_at: "2026-07-22T14:00:00.000Z",
    }] };
    if (text.includes("FROM feature_flag_rules")) return { rows: [] };
    if (text.includes("WHERE key = ANY")) {
      assert.match(text, /state = 'open'/);
      return { rows: [] }; // The requested Lab exists but is paused, so it is not selectable.
    }
    throw new Error(`unexpected SQL ${text}`);
  }, () => worker.fetch(request("/api/operator/feature-flags/grok_runtime_v0/lab-rules", {
    method: "POST",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      labKeys: ["paused_lab"], decision: "allow", priority: 40,
      reason: "must not target paused Lab", expectedConfigVersion: 20,
    }),
  }), env));

  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "lab_not_found");
  assert.equal(auditCalls, 0);
  assert.equal(seenSql.some((text) => text.includes("INSERT INTO feature_flag_rules")
    || text.includes("UPDATE feature_flag_rules")
    || text.includes("INSERT INTO feature_flag_config_versions")), false);
});

test("direct operator updates and deletes only the exact selected Lab rule", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const targetRuleId = "33333333-3333-4333-8333-333333333333";
  const untouchedRule = plainServerRuleRow(CANONICAL_RULE_ID, 0, ["11111111-1111-4111-8111-111111111111"]);
  let target: ReturnType<typeof labRuleRow> | null = labRuleRow(targetRuleId, 20, "allow", ["alpha"]);
  let version = 30;
  const auditOperations: unknown[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: (...values: unknown[]) => ({ run: async () => { if (values[5]) auditOperations.push(values[5]); } }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const flagRow = {
    key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
    randomization_unit: "server", default_enabled: false, default_variant: null,
    updated_at: "2026-07-22T14:00:00.000Z",
  };
  const query = async (text: string, values?: unknown[]) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: String(version) }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [flagRow] };
    if (text.includes("SELECT id, stage") && text.includes("FROM feature_flag_rules")) {
      return { rows: target ? [untouchedRule, target] : [untouchedRule] };
    }
    if (text.includes("WHERE key = ANY")) {
      assert.match(text, /state = 'open'/);
      return { rows: [{ key: "beta" }] };
    }
    if (text.includes("UPDATE feature_flag_rules")) {
      assert.deepEqual(values, [5, "deny", '["beta"]', targetRuleId, "grok_runtime_v0"]);
      target = { ...labRuleRow(targetRuleId, 5, "deny", ["beta"]), updated_at: "2026-07-22T15:00:00.000Z" };
      return { rows: [] };
    }
    if (text.includes("DELETE FROM feature_flag_rules")) {
      assert.deepEqual(values, [targetRuleId, "grok_runtime_v0"]);
      target = null;
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      version += 1;
      return { rows: [{ version: String(version) }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  };

  const updated = await withPgMock(query, () => worker.fetch(request(`/api/operator/feature-flags/grok_runtime_v0/lab-rules/${targetRuleId}`, {
    method: "PATCH",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ labKeys: ["beta"], decision: "deny", priority: 5, reason: "move deny first", expectedConfigVersion: 30 }),
  }), env));
  assert.equal(updated.status, 200, JSON.stringify(await updated.clone().json()));
  const updatedBody = await updated.json() as { configVersion: number; data: { rules: Array<{ id: string; decision: string; priority: number; values: string[] }> } };
  assert.equal(updatedBody.configVersion, 31);
  assert.deepEqual(updatedBody.data.rules.find((rule) => rule.id === targetRuleId), {
    id: targetRuleId,
    stage: "lab",
    priority: 5,
    decision: "deny",
    values: ["beta"],
    percentageBasisPoints: null,
    variant: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-22T15:00:00.000Z",
  });

  const deleted = await withPgMock(query, () => worker.fetch(request(`/api/operator/feature-flags/grok_runtime_v0/lab-rules/${targetRuleId}`, {
    method: "DELETE",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "remove completed Lab slice", expectedConfigVersion: 31 }),
  }), env));
  assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()));
  const deletedBody = await deleted.json() as { configVersion: number; data: { rules: Array<{ id: string }> } };
  assert.equal(deletedBody.configVersion, 32);
  assert.equal(deletedBody.data.rules.some((rule) => rule.id === targetRuleId), false);
  assert.deepEqual(auditOperations, ["lab_rule_update", "lab_rule_delete"]);
});

test("paused-bound Lab rule permits same-target decision update and deletion without reselecting the Lab", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const targetRuleId = "33333333-3333-4333-8333-333333333333";
  let target: ReturnType<typeof labRuleRow> | null = labRuleRow(targetRuleId, 20, "allow", ["paused_lab"]);
  let version = 40;
  let openTargetQueries = 0;
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({ bind: () => ({ run: async () => {} }) }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  const query = async (text: string, values?: unknown[]) => {
    if (text === MUTATION_BEGIN || text === "COMMIT" || text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("FROM feature_flag_config_versions")) return { rows: [{ version: String(version) }] };
    if (text.includes("FROM feature_flags WHERE key")) return { rows: [{
      key: "grok_runtime_v0", description: null, enabled: true, kill_switch: false,
      randomization_unit: "server", default_enabled: false, default_variant: null,
      updated_at: "2026-07-22T14:00:00.000Z",
    }] };
    if (text.includes("SELECT id, stage") && text.includes("FROM feature_flag_rules")) return { rows: target ? [target] : [] };
    if (text.includes("WHERE key = ANY")) {
      openTargetQueries += 1;
      return { rows: [] }; // The bound Lab is paused and therefore absent from the open catalog.
    }
    if (text.includes("UPDATE feature_flag_rules")) {
      assert.deepEqual(values, [10, "deny", '["paused_lab"]', targetRuleId, "grok_runtime_v0"]);
      target = { ...labRuleRow(targetRuleId, 10, "deny", ["paused_lab"]), updated_at: "2026-07-22T15:00:00.000Z" };
      return { rows: [] };
    }
    if (text.includes("DELETE FROM feature_flag_rules")) {
      target = null;
      return { rows: [] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      version += 1;
      return { rows: [{ version: String(version) }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  };

  const updated = await withPgMock(query, () => worker.fetch(request(`/api/operator/feature-flags/grok_runtime_v0/lab-rules/${targetRuleId}`, {
    method: "PATCH",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ labKeys: ["paused_lab", "paused_lab"], decision: "deny", priority: 10, reason: "adjust decision", expectedConfigVersion: 40 }),
  }), env));
  assert.equal(updated.status, 200, JSON.stringify(await updated.clone().json()));
  assert.equal(openTargetQueries, 0, "same canonical target set must not be revalidated as a new selection");

  const deleted = await withPgMock(query, () => worker.fetch(request(`/api/operator/feature-flags/grok_runtime_v0/lab-rules/${targetRuleId}`, {
    method: "DELETE",
    headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "remove historical binding", expectedConfigVersion: 41 }),
  }), env));
  assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()));
  assert.equal(openTargetQueries, 0, "delete must not require a paused Lab to become selectable again");
});

test("generic flag and all-stage rule lifecycle preserves non-server payloads while resolving server slugs", async () => {
  const sessionCookie = await createHumanSessionCookie();
  const auditOperations: string[] = [];
  const env = {
    ...baseEnv,
    FEATURE_FLAG_PG: { connectionString: "postgres://feature-flag-test" } as Hyperdrive,
    FEATURE_FLAG_AUDIT_DB: withPersistentAdmins({
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (values.length >= 15 && typeof values[5] === "string") auditOperations.push(values[5]);
          },
        }),
      }),
    } as unknown as D1Database, "human-1", "agent-1"),
  };
  let version = 0;
  let flag: Record<string, unknown> | null = null;
  let rules: Array<Record<string, unknown>> = [];
  const timestamp = "2026-08-09T10:00:00.000Z";

  const query = async (text: string, values: unknown[] = []) => {
    if ([MUTATION_BEGIN, READ_ONLY_BEGIN, "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
    if (text.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (text.includes("SELECT version FROM feature_flag_config_versions")) {
      return { rows: [{ version: String(version) }] };
    }
    if (text.includes("INSERT INTO feature_flag_config_versions")) {
      version += 1;
      return { rows: [{ version: String(version) }] };
    }
    if (text.includes("SELECT * FROM feature_flags WHERE key = $1")) {
      return { rows: flag && flag.key === values[0] ? [{ ...flag }] : [] };
    }
    if (text.includes("FROM feature_flag_rules") && text.includes("WHERE flag_key = $1")) {
      return { rows: rules.filter((rule) => rule.flag_key === values[0]).map((rule) => ({ ...rule })) };
    }
    if (text.includes("INSERT INTO feature_flags")) {
      flag = {
        key: values[0],
        description: values[1],
        enabled: values[2],
        kill_switch: values[3],
        randomization_unit: values[4],
        default_enabled: values[5],
        default_variant: values[6],
        salt: values[7],
        created_at: timestamp,
        updated_at: timestamp,
      };
      return { rows: [{ key: values[0] }] };
    }
    if (text.includes("UPDATE feature_flags SET")) {
      assert.ok(flag);
      if (values[0]) flag.description = values[1];
      if (values[2]) flag.enabled = values[3];
      if (values[4]) flag.kill_switch = values[5];
      if (values[6]) flag.randomization_unit = values[7];
      if (values[8]) flag.default_enabled = values[9];
      if (values[10]) flag.default_variant = values[11];
      if (values[12]) flag.salt = values[13];
      flag.updated_at = timestamp;
      return { rows: [{ key: flag.key }] };
    }
    if (text.includes("DELETE FROM feature_flags")) {
      const deleted = flag && flag.key === values[0] ? [{ key: flag.key }] : [];
      flag = null;
      rules = [];
      return { rows: deleted };
    }
    if (text.includes("INSERT INTO feature_flag_rules")) {
      const row = {
        id: values[0],
        flag_key: values[1],
        stage: values[2],
        priority: values[3],
        decision: values[4],
        values: JSON.parse(String(values[5])) as string[],
        percentage_basis_points: values[6],
        variant: values[7],
        created_at: timestamp,
        updated_at: timestamp,
      };
      rules.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("UPDATE feature_flag_rules SET")) {
      const row = rules.find((candidate) => candidate.id === values[6] && candidate.flag_key === values[7]);
      if (!row) return { rows: [] };
      row.stage = values[0];
      row.priority = values[1];
      row.decision = values[2];
      row.values = JSON.parse(String(values[3])) as string[];
      row.percentage_basis_points = values[4];
      row.variant = values[5];
      row.updated_at = timestamp;
      return { rows: [{ id: row.id }] };
    }
    if (text.includes("DELETE FROM feature_flag_rules")) {
      const before = rules.length;
      rules = rules.filter((rule) => rule.id !== values[0] || rule.flag_key !== values[1]);
      return { rows: before === rules.length ? [] : [{ id: values[0] }] };
    }
    throw new Error(`unexpected SQL ${text}`);
  };

  const call = (path: string, method: string, body: Record<string, unknown>) => withPgMock(
    query,
    () => worker.fetch(request(path, {
      method,
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env),
  );

  const created = await call("/api/operator/feature-flags", "POST", {
    key: "generic_contract_v0",
    description: "initial",
    enabled: true,
    killSwitch: true,
    randomizationUnit: "server",
    defaultEnabled: false,
    defaultVariant: "control",
    salt: "initial-salt",
    reason: "create generic flag",
    expectedConfigVersion: version,
  });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await created.json() as { configVersion: number }).configVersion, 1);

  const cleared = await call("/api/operator/feature-flags/generic_contract_v0", "PATCH", {
    description: null,
    defaultVariant: null,
    salt: null,
    killSwitch: false,
    reason: "clear nullable fields",
    expectedConfigVersion: version,
  });
  assert.equal(cleared.status, 200, await cleared.clone().text());
  const clearedFlag = (await cleared.json() as { data: { flag: Record<string, unknown> } }).data.flag;
  assert.equal(clearedFlag.description, null, "explicit null clears description");
  assert.equal(clearedFlag.defaultVariant, null, "explicit null clears defaultVariant");
  assert.equal(clearedFlag.salt, "initial-salt", "explicit null must not clear NOT NULL salt");
  assert.equal(clearedFlag.killSwitch, false, "generic patch retains the second killSwitch write path");

  const omitted = await call("/api/operator/feature-flags/generic_contract_v0", "PATCH", {
    reason: "exercise omitted field semantics",
    expectedConfigVersion: version,
  });
  assert.equal(omitted.status, 200, await omitted.clone().text());
  const omittedFlag = (await omitted.json() as { data: { flag: Record<string, unknown> } }).data.flag;
  assert.equal(omittedFlag.description, null);
  assert.equal(omittedFlag.defaultVariant, null);
  assert.equal(omittedFlag.salt, "initial-salt", "undefined salt is also a no-op");

  const replaced = await call("/api/operator/feature-flags/generic_contract_v0", "PATCH", {
    description: "replacement",
    defaultVariant: "treatment",
    salt: "replacement-salt",
    reason: "replace mutable strings",
    expectedConfigVersion: version,
  });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  const replacedFlag = (await replaced.json() as { data: { flag: Record<string, unknown> } }).data.flag;
  assert.equal(replacedFlag.description, "replacement");
  assert.equal(replacedFlag.defaultVariant, "treatment");
  assert.equal(replacedFlag.salt, "replacement-salt", "non-empty string updates salt");

  const killed = await call("/api/operator/feature-flags/generic_contract_v0/kill-switch", "POST", {
    killSwitch: true,
    reason: "emergency disable",
    expectedConfigVersion: version,
  });
  assert.equal(killed.status, 200, await killed.clone().text());
  assert.equal((await killed.json() as { data: { flag: { killSwitch: boolean } } }).data.flag.killSwitch, true);

  const invalidPlatform = await call("/api/operator/feature-flags/generic_contract_v0/rules", "POST", {
    stage: "platform",
    decision: "allow",
    values: ["desktop"],
    reason: "reject invalid platform",
    expectedConfigVersion: version,
  });
  assert.equal(invalidPlatform.status, 400);
  assert.equal(version, 5, "validation failure must not bump config version");

  const invalidLab = await call("/api/operator/feature-flags/generic_contract_v0/rules", "POST", {
    stage: "lab",
    decision: "allow",
    values: ["beta", "beta"],
    reason: "reject duplicate Lab targets",
    expectedConfigVersion: version,
  });
  assert.equal(invalidLab.status, 400);

  const legacyServerIds = await call("/api/operator/feature-flags/generic_contract_v0/rules", "POST", {
    stage: "server",
    decision: "allow",
    values: [TEST_SERVER_ID],
    reason: "reject internal server identifiers at the operator boundary",
    expectedConfigVersion: version,
  });
  assert.equal(legacyServerIds.status, 400);
  assert.equal(
    (await legacyServerIds.json() as { error: { code: string } }).error.code,
    "invalid_server_slug",
  );
  assert.equal(version, 5, "legacy server identifier rejection must not bump config version");

  const stagePayloads: Array<Record<string, unknown>> = [
    { stage: "user", decision: "allow", values: ["user-a"], priority: -1 },
    { stage: "platform", decision: "deny", values: ["mobile"], priority: 0 },
    { stage: "server", decision: "allow", serverSlugs: [TEST_SERVER_SLUG], priority: 1 },
    { stage: "lab", decision: "allow", values: ["beta"], priority: 2 },
    { stage: "plan", decision: "allow", values: ["pro"], priority: 3 },
    { stage: "percentage", decision: "allow", values: [], priority: 4, percentageBasisPoints: 2500 },
  ];
  const ruleIds: string[] = [];
  for (const payload of stagePayloads) {
    const response = await call("/api/operator/feature-flags/generic_contract_v0/rules", "POST", {
      ...payload,
      reason: `create ${String(payload.stage)} rule`,
      expectedConfigVersion: version,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json() as { data: { ruleId: string }; configVersion: number };
    ruleIds.push(body.data.ruleId);
    assert.equal(body.configVersion, version);
  }
  assert.deepEqual(rules.map((rule) => rule.stage), ["user", "platform", "server", "lab", "plan", "percentage"]);
  assert.deepEqual(rules.find((rule) => rule.stage === "server")?.values, [TEST_SERVER_ID]);

  const updatedServerRule = await call(
    `/api/operator/feature-flags/generic_contract_v0/rules/${ruleIds[2]}`,
    "PATCH",
    {
      serverSlugs: [TEST_SERVER_SLUG],
      priority: 7,
      reason: "update server rule through slug boundary",
      expectedConfigVersion: version,
    },
  );
  assert.equal(updatedServerRule.status, 200, await updatedServerRule.clone().text());
  assert.deepEqual(rules.find((rule) => rule.id === ruleIds[2])?.values, [TEST_SERVER_ID]);
  assert.equal(rules.find((rule) => rule.id === ruleIds[2])?.priority, 7);

  const updatedRule = await call(
    `/api/operator/feature-flags/generic_contract_v0/rules/${ruleIds[0]}`,
    "PATCH",
    {
      stage: "platform",
      decision: "deny",
      values: ["web"],
      priority: 9,
      variant: null,
      reason: "retarget exact rule",
      expectedConfigVersion: version,
    },
  );
  assert.equal(updatedRule.status, 200, await updatedRule.clone().text());
  const updatedRuleBody = await updatedRule.json() as { data: { rules: Array<Record<string, unknown>> } };
  assert.deepEqual(
    updatedRuleBody.data.rules.find((rule) => rule.id === ruleIds[0]),
    {
      id: ruleIds[0],
      stage: "platform",
      priority: 9,
      decision: "deny",
      values: ["web"],
      percentageBasisPoints: null,
      variant: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );

  const missingRule = await call(
    "/api/operator/feature-flags/generic_contract_v0/rules/00000000-0000-4000-8000-000000000000",
    "PATCH",
    { decision: "deny", reason: "missing exact rule", expectedConfigVersion: version },
  );
  assert.equal(missingRule.status, 404);
  assert.equal((await missingRule.json() as { error: { message: string } }).error.message, "Feature flag rule not found.");

  const deletedRule = await call(
    `/api/operator/feature-flags/generic_contract_v0/rules/${ruleIds[1]}`,
    "DELETE",
    { reason: "delete exact platform rule", expectedConfigVersion: version },
  );
  assert.equal(deletedRule.status, 204, await deletedRule.clone().text());
  assert.equal(deletedRule.headers.get("X-Feature-Flag-Config-Version"), String(version));
  assert.equal(rules.some((rule) => rule.id === ruleIds[1]), false);

  const staleKill = await call("/api/operator/feature-flags/generic_contract_v0/kill-switch", "POST", {
    killSwitch: false,
    reason: "reject stale emergency write",
    expectedConfigVersion: version - 1,
  });
  assert.equal(staleKill.status, 409);
  assert.equal(version, 14);

  const deletedFlag = await call("/api/operator/feature-flags/generic_contract_v0", "DELETE", {
    reason: "delete generic flag",
    expectedConfigVersion: version,
  });
  assert.equal(deletedFlag.status, 204, await deletedFlag.clone().text());
  assert.equal(deletedFlag.headers.get("X-Feature-Flag-Config-Version"), "15");
  assert.equal(flag, null);
  assert.deepEqual(rules, []);

  const missingDetail = await withPgMock(
    query,
    () => worker.fetch(request("/api/operator/feature-flags/generic_contract_v0", {
      headers: { Cookie: sessionCookie },
    }), env),
  );
  assert.equal(missingDetail.status, 404);

  for (const [path, method, body] of [
    [
      "/api/operator/feature-flags/generic_contract_v0",
      "PATCH",
      { enabled: false, reason: "missing flag patch", expectedConfigVersion: version },
    ],
    [
      "/api/operator/feature-flags/generic_contract_v0",
      "DELETE",
      { reason: "missing flag delete", expectedConfigVersion: version },
    ],
    [
      "/api/operator/feature-flags/generic_contract_v0/kill-switch",
      "POST",
      { killSwitch: false, reason: "missing emergency target", expectedConfigVersion: version },
    ],
  ] as const) {
    const missing = await call(path, method, body);
    assert.equal(missing.status, 404, await missing.clone().text());
    assert.equal(
      (await missing.json() as { error: { message: string } }).error.message,
      "Feature flag not found.",
    );
  }
  assert.equal(version, 15, "not-found writes must not audit, mutate, or bump config version");
  assert.deepEqual(auditOperations, [
    "feature_flag_create",
    "feature_flag_update",
    "feature_flag_update",
    "feature_flag_update",
    "feature_flag_kill_switch_update",
    ...Array(6).fill("feature_flag_rule_create"),
    "feature_flag_rule_update",
    "feature_flag_rule_update",
    "feature_flag_rule_delete",
    "feature_flag_delete",
  ]);
});

test("agent manifest is public and raft-branded with legacy alias", async () => {
  for (const path of ["/.well-known/raft-agent-manifest.json", "/.well-known/slock-agent-manifest.json"]) {
    const response = await worker.fetch(request(path), baseEnv);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      schema: string;
      service: string;
      auth: { type: string };
      actions: Array<{
        name: string;
        description: string;
        endpoint: { method: string; path: string };
        parameters?: Record<string, { type: string; required?: boolean }>;
      }>;
    };
    assert.doesNotThrow(() => validateAgentManifestV0(body));
    assert.equal(body.schema, "raft-agent-manifest.v0");
    assert.equal(body.service, "slock-feature-flag-admin");
    assert.equal(body.auth.type, "login_with_raft");
    assert.deepEqual(body.actions.map((action) => action.name), [
      "list-admin-role-grants",
      "grant-admin-role",
      "revoke-admin-role",
      "list-labs",
      "create-lab",
      "update-lab",
      "set-lab-state",
      "list-feature-flags",
      "list-audiences",
      "create-audience",
      "replace-audience",
      "list-server-targets",
      "get-feature-flag",
      "create-feature-flag",
      "update-feature-flag",
      "delete-feature-flag",
      "set-kill-switch",
      "create-feature-flag-rule",
      "update-feature-flag-rule",
      "delete-feature-flag-rule",
      "set-default-enabled",
      "add-server-allowlist",
      "create-first-server-allow-rule",
      "enable-apple-web-login",
      "remove-server-allowlist",
      "create-lab-rule",
      "update-lab-rule",
      "delete-lab-rule",
      "evaluate-feature-flag-preview",
    ]);
    assert.ok(body.actions.some((action) => action.endpoint.path === "/api/operator/feature-flags/{key}/server-allowlist"));
    assert.ok(body.actions.some((action) => action.endpoint.path === "/api/operator/feature-flags/{key}/server-allowlist/rules"));
    assert.ok(body.actions.some((action) => (
      action.name === "enable-apple-web-login"
      && action.endpoint.path === "/api/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules"
    )));
    const createLab = body.actions.find((action) => action.name === "create-lab");
    assert.equal(Object.hasOwn(createLab?.parameters ?? {}, "labKey"), true);
    assert.equal(Object.hasOwn(createLab?.parameters ?? {}, "key"), false);
    assert.ok(body.actions.some((action) => action.endpoint.path === "/api/operator/labs/{labKey}"));
    assert.ok(body.actions.some((action) => action.endpoint.path === "/api/operator/labs/{labKey}/state"));
    assert.equal(
      body.actions
        .filter((action) => action.name === "add-server-allowlist" || action.name === "remove-server-allowlist")
        .every((action) => action.description.includes("targetRuleId")),
      true,
    );
    const firstServerRule = body.actions.find((action) => action.name === "create-first-server-allow-rule");
    assert.deepEqual(
      Object.entries(firstServerRule?.parameters ?? {}).filter(([, parameter]) => parameter.required).map(([name]) => name),
      ["key", "serverSlugs", "reason", "expectedConfigVersion"],
    );
    const appleWeb = body.actions.find((action) => action.name === "enable-apple-web-login");
    assert.deepEqual(
      Object.entries(appleWeb?.parameters ?? {})
        .filter(([, parameter]) => parameter.required)
        .map(([name]) => name),
      ["reason", "expectedConfigVersion"],
    );
    assert.ok(body.actions.some((action) => action.endpoint.path === "/api/operator/feature-flags/{key}/evaluate-preview"));
    const preview = body.actions.find((action) => action.name === "evaluate-feature-flag-preview");
    assert.deepEqual(Object.keys(preview?.parameters ?? {}), ["key", "serverSlug", "userId", "platform"]);
    const createRule = body.actions.find((action) => action.name === "create-feature-flag-rule");
    const updateRule = body.actions.find((action) => action.name === "update-feature-flag-rule");
    assert.equal(Object.hasOwn(createRule?.parameters ?? {}, "serverSlugs"), true);
    assert.equal(Object.hasOwn(updateRule?.parameters ?? {}, "serverSlugs"), true);
    assert.equal(Object.hasOwn(createRule?.parameters ?? {}, "serverIds"), false);
    assert.equal(Object.hasOwn(updateRule?.parameters ?? {}, "serverIds"), false);
    const setDefault = body.actions.find((action) => action.name === "set-default-enabled");
    assert.deepEqual(setDefault?.endpoint, {
      method: "POST",
      path: "/api/operator/feature-flags/{key}/default-enabled",
    });
    assert.deepEqual(
      Object.entries(setDefault?.parameters ?? {}).filter(([, parameter]) => parameter.required).map(([name]) => name),
      ["key", "defaultEnabled", "reason", "expectedConfigVersion"],
    );
  }
});
