import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";
import { addMember, createServer } from "../services/serverService";
import { createOAuthClient, issueHumanAuthorizationCode } from "../services/oauthService";

// RFC 079 1a follow-up (Tenny, #proj-apps:769a57d4): Apps call the identity
// endpoints (userinfo, servers, membership, serverinfo, agents) from their own
// backend, so all of an App's users share one IP. Those five are limited per
// access token; every other /api/oauth route keeps the per-IP auth limit
// (200 a minute), and the five do not spend it. An invalid token (the route
// answers 401) spends a per-IP budget of its own, so spraying new tokens from
// one IP is capped. Here the per-token limit is 3 and the invalid-token one 5
// (600 and 200 in production).
const PER_TOKEN = 3;
const INVALID_PER_IP = 5;
const PER_IP = 200;
const test = createApiTest({ oauthIdentityTokenRateLimitMax: PER_TOKEN, oauthIdentityInvalidTokenRateLimitMax: INVALID_PER_IP });

const RETURN_URL = "https://limits.example.test/login/raft/callback";
const SCOPES = ["openid", "profile", "agent:read"];
const RATE_LIMITED = { error: "Too many requests, please try again later" };

type Base = { baseUrl: string };
type Answer = { status: number; body: string; limit: string | null; retryAfter: string | null };

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** One server-local App and two of its users on one Server: tokens A and B, sent from the same IP. */
async function seed(app: Base) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("limits-owner");
  const member = await seedUser("limits-member");
  const server = await createServer("Limits", `limits-${suffix}`, owner.id);
  await addMember(server.id, member.id, "member");
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `limits-${suffix}`,
    name: "Limits App",
    returnUrl: RETURN_URL,
    allowedScopes: SCOPES,
  });
  const tokenOf = async (userId: string) => {
    const { code } = await issueHumanAuthorizationCode({ clientKey: client.clientId, userId, serverId: server.id, returnUrl: RETURN_URL, scopes: SCOPES, approverSessionFamilyId: (await signInForTest(userId)).familyId });
    const res = await fetch(`${app.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret, grantType: "authorization_code", code }),
    });
    assert.equal(res.status, 200, `fixture: token exchange (${res.status}): ${await res.clone().text()}`);
    return (await res.json() as { access_token: string }).access_token;
  };
  return { server, tokenA: await tokenOf(owner.id), tokenB: await tokenOf(member.id), anotherToken: () => tokenOf(member.id) };
}

async function read(app: Base, path: string, token?: string): Promise<Answer> {
  const res = await fetch(`${app.baseUrl}${path}`, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    body: await res.text(),
    limit: res.headers.get("ratelimit-limit"),
    retryAfter: res.headers.get("retry-after"),
  };
}

/** What is left of this IP's auth budget, read from /authorize's RateLimit-Remaining; the read spends one. */
async function ipBudgetLeft(app: Base): Promise<number> {
  const res = await fetch(`${app.baseUrl}/api/oauth/authorize`);
  await res.body?.cancel();
  assert.equal(res.headers.get("ratelimit-limit"), String(PER_IP), "fixture: /authorize is behind the per-IP auth limit");
  return Number(res.headers.get("ratelimit-remaining"));
}

function assertCountedPerToken(answer: Answer, label: string) {
  assert.equal(answer.status, 200, `${label}: ${answer.body}`);
  assert.equal(answer.limit, String(PER_TOKEN), `${label}: counted per token`);
}

function assertRateLimited(answer: Answer, label: string, limit = PER_TOKEN) {
  assert.equal(answer.status, 429, `${label}: ${answer.body}`);
  assert.equal(answer.limit, String(limit), `${label}: refused by the ${limit === PER_TOKEN ? "per-token" : "invalid-token per-IP"} limit`);
  assert.deepEqual(JSON.parse(answer.body), RATE_LIMITED, label);
  const retryAfter = Number(answer.retryAfter);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `${label}: Retry-After ${answer.retryAfter}`);
}

test("each access token has its own budget across the five identity endpoints, and they leave the IP's auth budget alone", async ({ app }) => {
  const f = await seed(app);
  const membership = `/api/oauth/membership?server_id=${f.server.id}`;
  const before = await ipBudgetLeft(app);

  for (let i = 1; i <= PER_TOKEN; i += 1) assertCountedPerToken(await read(app, membership, f.tokenA), `token A /membership #${i}`);
  assertRateLimited(await read(app, membership, f.tokenA), "token A's 4th /membership");

  // Token B, from the same IP: its own budget, shared by the five endpoints.
  assertCountedPerToken(await read(app, "/api/oauth/userinfo", f.tokenB), "token B /userinfo");
  assertCountedPerToken(await read(app, "/api/oauth/servers", f.tokenB), "token B /servers");
  assertCountedPerToken(await read(app, "/api/oauth/serverinfo", f.tokenB), "token B /serverinfo");
  assertRateLimited(await read(app, "/api/oauth/agents", f.tokenB), "token B's 4th request (/agents)");

  // Eight identity requests later, the IP has spent only the second /authorize.
  // Six of them passed, more than the IP's invalid-token budget: valid tokens never spend that either.
  assert.equal(await ipBudgetLeft(app), before - 1, "the identity endpoints did not spend the per-IP budget");
});

test("spraying new invalid tokens from one IP is capped at the IP's invalid-token budget; valid tokens never spend it", async ({ app }) => {
  const f = await seed(app);
  const membership = `/api/oauth/membership?server_id=${f.server.id}`;
  const before = await ipBudgetLeft(app);

  // More valid requests than the invalid-token budget, with two tokens: none spends it.
  for (let i = 1; i <= PER_TOKEN; i += 1) {
    assertCountedPerToken(await read(app, membership, f.tokenA), `token A #${i}`);
    assertCountedPerToken(await read(app, "/api/oauth/userinfo", f.tokenB), `token B #${i}`);
  }

  // A new token each time, so the per-token limit never applies: each is
  // looked up, answers 401 and spends the IP's budget, until it is spent.
  for (let i = 1; i <= INVALID_PER_IP; i += 1) {
    const answer = await read(app, membership, `slock_at_spray-${randomUUID()}`);
    assert.equal(answer.status, 401, `sprayed token #${i}: ${answer.body}`);
    assert.deepEqual(JSON.parse(answer.body), { error: "Invalid or expired access token" });
  }
  assertRateLimited(await read(app, membership, `slock_at_spray-${randomUUID()}`), `sprayed token #${INVALID_PER_IP + 1}`, INVALID_PER_IP);
  assertRateLimited(await read(app, "/api/oauth/userinfo", `slock_at_spray-${randomUUID()}`), "another sprayed token, another route", INVALID_PER_IP);
  // Checked before the lookup: a valid token from that IP, never used before, waits too.
  assertRateLimited(await read(app, "/api/oauth/userinfo", await f.anotherToken()), "a fresh valid token from the spraying IP", INVALID_PER_IP);

  // Its own counter: the IP's auth budget (login, authorize) is untouched; the third token's exchange spent one.
  assert.equal(await ipBudgetLeft(app), before - 2, "the spray did not spend the auth limit");
});

test("a request with no Bearer token on an identity endpoint is counted per IP, not per token", async ({ app }) => {
  await seed(app);
  const before = await ipBudgetLeft(app);
  for (let i = 1; i <= PER_TOKEN + 1; i += 1) {
    const answer = await read(app, "/api/oauth/userinfo");
    assert.equal(answer.status, 401, `no Bearer token #${i}: ${answer.body}`);
    assert.deepEqual(JSON.parse(answer.body), { error: "Missing bearer token" });
    assert.equal(answer.limit, String(PER_IP), `no Bearer token #${i}: counted per IP`);
  }
  assert.equal(await ipBudgetLeft(app), before - (PER_TOKEN + 1) - 1, "each spent the IP's auth budget");
});

test("the Server-scoped OIDC mount limits its identity endpoints per token too, with the same budget as the unscoped mount", async ({ app }) => {
  const f = await seed(app);
  const prefix = `/oidc/${f.server.slug}/api/oauth`;
  const before = await ipBudgetLeft(app);

  for (let i = 1; i <= PER_TOKEN; i += 1) assertCountedPerToken(await read(app, `${prefix}/userinfo`, f.tokenA), `scoped token A /userinfo #${i}`);
  assertRateLimited(await read(app, `${prefix}/userinfo`, f.tokenA), "scoped token A's 4th /userinfo");
  assertRateLimited(await read(app, "/api/oauth/userinfo", f.tokenA), "token A on the unscoped mount: one budget per token");

  assertCountedPerToken(await read(app, `${prefix}/serverinfo`, f.tokenB), "scoped token B /serverinfo");
  assertCountedPerToken(await read(app, `${prefix}/agents`, f.tokenB), "scoped token B /agents");
  assert.equal(await ipBudgetLeft(app), before - 1, "the scoped identity endpoints did not spend the per-IP budget");

  // servers and membership are not on this mount (404): those stay per IP.
  const notServed = await read(app, `${prefix}/membership?server_id=${f.server.id}`, f.tokenB);
  assert.equal(notServed.status, 404, notServed.body);
  assert.equal(notServed.limit, String(PER_IP), "a route the mount does not serve is counted per IP");
});
