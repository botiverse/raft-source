import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
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

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createServer as createServerService } from "../services/serverService";
import { createChannel as createChannelService, addHuman } from "../services/channelService";
import { createMessage } from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

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

// Malformed path :id (non-UUID) -> 404 from requireServerMatchesParam before
// any uuid-column query runs (task #12). The global boundary must not turn it
// into a 500, and no internals may leak.
// Path id and X-Server-Id use the SAME non-UUID value so requireServerMatchesParam
// (header==path) passes the match check and reaches the UUID gate.
test("malformed server :id is a clean 404, not a 500 (black-box, no raw DB error)", async ({ app }) => {
  const owner = await seedUser("hyg-blackbox-server@slock.test", "hyg-blackbox-server");
  const token = await login(app.baseUrl, owner.email);
  const malformed = "not-a-uuid";

  const res = await fetch(`${app.baseUrl}/api/servers/${malformed}/members`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": malformed },
  });

  assert.equal(res.status, 404);
  const raw = await res.text();
  assertNoLeak(raw, "malformed server :id");
  const body = JSON.parse(raw) as { error: string };
  assert.equal(body.error, "Server not found");
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

// Malformed ids in other id-keyed GET routes. The CJK case is the real-world
// vector: a permalink typed straight into Chinese prose (`?msg=<uuid>这条…`)
// used to send the swallowed text as the id and got a uuid-cast 500.
test("malformed path and query ids on id-keyed GET routes are clean 4xx (black-box, no raw DB error)", async ({ app }) => {
  const owner = await seedUser("hyg-blackbox-ids@slock.test", "hyg-blackbox-ids");
  const token = await login(app.baseUrl, owner.email);
  const server = await createServerService("Hygiene Ids", "hygiene-ids", owner.id);
  const channel = await createChannelService(server.id, "hygiene-ids", "test channel");
  await addHuman(channel.id, owner.id);
  const messageId = (await createMessage(channel.id, "user", owner.id, "hello")).id;

  const cases: Array<{ path: (bad: string) => string; status: number }> = [
    { path: (bad) => `/api/messages/context/${bad}`, status: 400 },
    { path: (bad) => `/api/messages/context/${messageId}?channelId=${bad}`, status: 400 },
    { path: (bad) => `/api/messages/channel/${bad}`, status: 404 },
    { path: (bad) => `/api/servers/${server.id}/members/${bad}/profile`, status: 404 },
    { path: (bad) => `/api/public/servers/${server.slug}/channels/${bad}/messages`, status: 404 },
    { path: (bad) => `/api/public/servers/${server.slug}/threads/${bad}/messages`, status: 404 },
    { path: (bad) => `/api/mcp/agents/${bad}`, status: 404 },
    { path: (bad) => `/api/integrations/agents/${bad}`, status: 404 },
    { path: (bad) => `/api/integrations/clients/${bad}/app-notifications`, status: 404 },
    { path: (bad) => `/api/integrations/clients/${bad}/share-links`, status: 404 },
    { path: (bad) => `/api/integrations/marketplace/${bad}/install/app-notifications`, status: 404 },
  ];
  const malformed = ["not-a-uuid", encodeURIComponent(`${messageId}这条你是不是没收到`)];

  for (const { path, status } of cases) {
    for (const bad of malformed) {
      const url = path(bad);
      const res = await fetch(`${app.baseUrl}${url}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
      });
      const raw = await res.text();
      assert.equal(res.status, status, `${url}: ${raw}`);
      assertNoLeak(raw, url);
    }
  }

  // The 8-hex short id stays a legal /context target.
  const shortId = await fetch(`${app.baseUrl}/api/messages/context/${messageId.slice(0, 8)}?channelId=${channel.id}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  assert.equal(shortId.status, 200);
});
