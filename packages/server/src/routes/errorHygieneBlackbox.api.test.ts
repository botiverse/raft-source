import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
// Black-box regression guard for the task #169 global error boundary. Unlike
// the DROP-TABLE middleware tests in servers.api.test.ts, this induces the
// middleware-layer failure through a REAL client-reachable input path (no DB
// mutation): a malformed (non-UUID) `X-Server-Id`. `requireServer` (auth.ts)
// feeds that header straight into a uuid column query with no format check, so
// Postgres raises "invalid input syntax for type uuid" in the MIDDLEWARE layer
// (before any route try/catch), which only the global 4-arg handler can catch.
//
// This is the exact vector Hipp used for the #169 post-deploy true-environment
// gate. Committing it locks that black-box path so a future regression (e.g. a
// removed/misordered global handler, or a route that reflects raw errors) is
// caught by CI rather than by a client seeing raw SQL.
import assert from "node:assert/strict";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

// Any match on the client-visible body is a leak of DB/driver internals.
const LEAK_MARKERS = [
  /invalid input syntax for type uuid/i, // the specific pg cast error for this vector
  /Failed query/i,
  /\b(select|insert|update|delete)\b[\s\S]*\bfrom\b\s+"[a-z_]+"/i,
  /where\s+"[a-z_]+"\."[a-z_]+"/i,
  /\bparams:/i,
  /"(server_members|users|servers)"\./i,
  /\b(23505|23503|42P01|22P02)\b/, // pg unique / fk / undefined_table / invalid_text_representation
];

function assertNoLeak(bodyText: string, context: string) {
  for (const marker of LEAK_MARKERS) {
    assert.doesNotMatch(bodyText, marker, `${context}: client body leaked raw DB internals (${marker})`);
  }
}

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return (await res.json() as { accessToken: string }).accessToken;
}

// Malformed X-Server-Id (non-UUID) -> uuid cast error inside requireServer
// (middleware layer) -> must be sanitized by the global boundary, not leaked.
// Path id and X-Server-Id use the SAME non-UUID value so requireServerMatchesParam
// (header==path) passes and the request reaches the uuid-column query.
test("malformed X-Server-Id is sanitized by the global error boundary (black-box, no raw DB error)", async ({ app }) => {
  const owner = await seedUser("hyg-blackbox-server@slock.test", "hyg-blackbox-server");
  const token = await login(app.baseUrl, owner.email);
  const malformed = "not-a-uuid";

  const res = await fetch(`${app.baseUrl}/api/servers/${malformed}/members`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": malformed },
  });

  assert.equal(res.status, 500);
  const raw = await res.text();
  assertNoLeak(raw, "malformed X-Server-Id");
  const body = JSON.parse(raw) as { error: string; code?: string; correlationId?: string };
  assert.equal(body.error, "Internal server error");
  assert.equal(body.code, "internal_server_error");
  assert.equal(typeof body.correlationId, "string");
  assert.equal(res.headers.get("x-slock-error-id"), body.correlationId);
});

// A mismatched X-Server-Id vs path id is a deliberate typed 4xx from
// requireServerMatchesParam. The global boundary must NOT swallow it into a
// generic 500, and it must not leak raw internals either.
test("mismatched X-Server-Id vs path id stays a typed 4xx (not swallowed, not leaked)", async ({ app }) => {
  const owner = await seedUser("hyg-blackbox-mismatch@slock.test", "hyg-blackbox-mismatch");
  const token = await login(app.baseUrl, owner.email);

  const res = await fetch(`${app.baseUrl}/api/servers/path-value/members`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": "header-value" },
  });

  assert.ok(res.status >= 400 && res.status < 500, `expected typed 4xx, got ${res.status}`);
  const raw = await res.text();
  assert.doesNotMatch(raw, /internal_server_error/, "typed 4xx was swallowed into a generic 500");
  assertNoLeak(raw, "mismatched X-Server-Id 4xx");
});
