import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
// Bounds on a person issuing agent keys (services/agentCredentialMintLimits.ts):
//   1. a per-person and a per-agent mint rate (429, Retry-After), shared by
//      the direct mint and the bootstrap token issue;
//   2. a cap of live person-issued keys per agent (409), which a Computer's
//      runner keys, revoked and expired keys don't count toward, held under
//      concurrent mints and on the bootstrap token exchange;
//   3. a non-UUID agent or credential id answers the same 404 as a missing one.
// The device login's agent_key grant: deviceLoginGrant.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentBootstrapTokens, agentCredentials, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { consumeAgentBootstrapToken, issueAgentBootstrapToken } from "../services/agentCredentialService";
import {
  __setAgentCredentialMintRateLimitsForTests,
  AGENT_CREDENTIAL_MINT_WINDOW_SECONDS,
  AGENT_LIVE_HUMAN_CREDENTIALS_MAX,
} from "../services/agentCredentialMintLimits";
import { RefusalError } from "../lib/refusal";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const MINT_GATES = {
  SLOCK_DEVICE_LOGIN_ENABLED: "true",
  SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED: "true",
  AGENT_BOOTSTRAP_TOKEN_PEPPER: "test-pepper-test-pepper-test-pepper-0000",
};

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withRateLimits<T>(limits: { perUser: number; perAgent: number }, fn: () => Promise<T>): Promise<T> {
  __setAgentCredentialMintRateLimitsForTests(limits);
  try {
    return await fn();
  } finally {
    __setAgentCredentialMintRateLimitsForTests(null);
  }
}

async function seedUser(label: string) {
  const suffix = randomUUID();
  const email = `${label}-${suffix}@slock.test`;
  const [user] = await getDb().insert(users).values({
    email,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { id: user!.id, token: await tokenForHuman(email) };
}

async function seedFixture() {
  const owner = await seedUser("mint-limit-owner");
  const server = await createServer("Mint Limits", `mint-limits-${randomUUID()}`, owner.id);
  const agentA = await createAgent(server.id, "LimitA", { runtime: "external", model: "external" });
  const agentB = await createAgent(server.id, "LimitB", { runtime: "external", model: "external" });
  const admin = await seedUser("mint-limit-admin");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  return { owner, admin, serverId: server.id, agentA: agentA.id, agentB: agentB.id };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function mint(baseUrl: string, token: string, agentId: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() as Record<string, any> };
}

async function issueBootstrap(baseUrl: string, f: Fixture, token: string, agentId: string) {
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/bootstrap-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": f.serverId },
    body: JSON.stringify({}),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() as Record<string, any> };
}

/** Rows straight in (no argon2 per row): `count` keys of the agent of one origin and state. */
async function seedCredentials(agentId: string, count: number, kind: { issuedVia: "human" | "computer"; createdByUserId: string | null; revoked?: boolean; expired?: boolean }) {
  if (count === 0) return;
  await getDb().insert(agentCredentials).values(Array.from({ length: count }, (_, i) => ({
    agentId,
    apiKeyHash: "seeded-not-a-real-hash",
    apiKeyPrefix: `sk_agent_seed${i}`,
    name: kind.issuedVia === "computer" ? `runner:seed-${i}` : `seed-${i}`,
    scopes: ["read"],
    issuedVia: kind.issuedVia,
    createdByUserId: kind.createdByUserId,
    ...(kind.revoked ? { revokedAt: new Date(), revokedReason: "user_revoked" } : {}),
    ...(kind.expired ? { expiresAt: new Date(Date.now() - 60_000) } : {}),
  })));
}

async function liveHumanCount(agentId: string): Promise<number> {
  const rows = await getDb().select({ id: agentCredentials.id }).from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agentId), eq(agentCredentials.issuedVia, "human"), isNull(agentCredentials.revokedAt)));
  return rows.length;
}

function assertRateLimited(res: { status: number; retryAfter: string | null; body: Record<string, any> }) {
  assert.equal(res.status, 429, JSON.stringify(res.body));
  assert.equal(res.body.code, "agent_credential_mint_rate_limited");
  const retryAfter = Number(res.retryAfter);
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= AGENT_CREDENTIAL_MINT_WINDOW_SECONDS, `Retry-After ${res.retryAfter}`);
  assert.equal(res.body.retryAfterSeconds, retryAfter);
}

// ── 1. rate ─────────────────────────────────────────────────────────────────

test("past the per-person rate a mint is refused 429 with Retry-After, across that person's agents; another person is unaffected", async ({ app }) => {
  await withEnv(MINT_GATES, () => withRateLimits({ perUser: 3, perAgent: 100 }, async () => {
    const f = await seedFixture();
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 201);
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 201);
    // A bootstrap token spends the same budget.
    assert.equal((await issueBootstrap(app.baseUrl, f, f.owner.token, f.agentB)).status, 201);

    const before = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, f.agentB));
    assertRateLimited(await mint(app.baseUrl, f.owner.token, f.agentB));
    assertRateLimited(await issueBootstrap(app.baseUrl, f, f.owner.token, f.agentB));
    const after = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, f.agentB));
    assert.equal(after.length, before.length, "a refused mint writes nothing");

    assert.equal((await mint(app.baseUrl, f.admin.token, f.agentB)).status, 201, "another person has their own budget");
  }));
});

test("past the per-agent rate a mint for that agent is refused 429 for everyone; another agent is unaffected", async ({ app }) => {
  await withEnv(MINT_GATES, () => withRateLimits({ perUser: 100, perAgent: 2 }, async () => {
    const f = await seedFixture();
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 201);
    assert.equal((await issueBootstrap(app.baseUrl, f, f.admin.token, f.agentA)).status, 201);
    assertRateLimited(await mint(app.baseUrl, f.owner.token, f.agentA));
    assertRateLimited(await mint(app.baseUrl, f.admin.token, f.agentA));
    assertRateLimited(await issueBootstrap(app.baseUrl, f, f.owner.token, f.agentA));
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentB)).status, 201, "another agent has its own budget");
  }));
});

test("a refused request (not authorized, invalid) spends no budget", async ({ app }) => {
  await withEnv(MINT_GATES, () => withRateLimits({ perUser: 1, perAgent: 100 }, async () => {
    const f = await seedFixture();
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA, { scopes: ["not-a-scope"] })).status, 400);
    assert.equal((await mint(app.baseUrl, f.owner.token, randomUUID())).status, 404);
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 201);
  }));
});

// ── 2. live-key cap ─────────────────────────────────────────────────────────

test(`an agent holding ${AGENT_LIVE_HUMAN_CREDENTIALS_MAX} live person-issued keys refuses the next mint 409 and says how to revoke; revoking one lets it through`, async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    await seedCredentials(f.agentA, AGENT_LIVE_HUMAN_CREDENTIALS_MAX - 1, { issuedVia: "human", createdByUserId: f.owner.id });
    const last = await mint(app.baseUrl, f.owner.token, f.agentA);
    assert.equal(last.status, 201, "the 50th live key is allowed");

    const refused = await mint(app.baseUrl, f.owner.token, f.agentA);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "agent_credential_limit_reached");
    assert.match(refused.body.error, /already has 50 active keys/);
    assert.ok(refused.body.error.includes(`DELETE /api/agents/${f.agentA}/credentials/`), refused.body.error);
    assert.match(refused.body.error, /agent's settings/);
    assert.equal(await liveHumanCount(f.agentA), AGENT_LIVE_HUMAN_CREDENTIALS_MAX, "nothing past the cap was written");

    // A replacesCredentialId mint at the cap rotates: the replaced key is revoked first, so it fits.
    const rotated = await mint(app.baseUrl, f.owner.token, f.agentA, { replacesCredentialId: last.body.credentialId });
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));

    const revoke = await fetch(`${app.baseUrl}/api/agents/${f.agentA}/credentials/${rotated.body.credentialId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${f.owner.token}` },
    });
    assert.equal(revoke.status, 204);
    assert.equal((await mint(app.baseUrl, f.admin.token, f.agentA)).status, 201, "a revoked key frees its place, for anyone with authority");
    // The cap is per agent.
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentB)).status, 201);
  });
});

test("revoked and expired keys and a Computer's runner keys don't count toward the cap", async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    await seedCredentials(f.agentA, AGENT_LIVE_HUMAN_CREDENTIALS_MAX - 1, { issuedVia: "human", createdByUserId: f.owner.id });
    await seedCredentials(f.agentA, 5, { issuedVia: "human", createdByUserId: f.owner.id, revoked: true });
    await seedCredentials(f.agentA, 3, { issuedVia: "human", createdByUserId: f.owner.id, expired: true });
    await seedCredentials(f.agentA, 10, { issuedVia: "computer", createdByUserId: null });
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 201);
    assert.equal((await mint(app.baseUrl, f.owner.token, f.agentA)).status, 409);
  });
});

test("concurrent mints at one below the cap write exactly one key", async ({ app }) => {
  // PGlite runs one transaction at a time, so this pins that the count is in
  // the mint's transaction (a count before the hash would let all through);
  // on Postgres the per-agent advisory lock serializes the count and insert.
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    await seedCredentials(f.agentA, AGENT_LIVE_HUMAN_CREDENTIALS_MAX - 1, { issuedVia: "human", createdByUserId: f.owner.id });
    const results = await Promise.all([
      mint(app.baseUrl, f.owner.token, f.agentA),
      mint(app.baseUrl, f.owner.token, f.agentA),
      mint(app.baseUrl, f.admin.token, f.agentA),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal(await liveHumanCount(f.agentA), AGENT_LIVE_HUMAN_CREDENTIALS_MAX);
  });
});

test("a bootstrap token exchanged at the cap is refused 409 and stays unconsumed", async ({ app }) => {
  void app;
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    await seedCredentials(f.agentA, AGENT_LIVE_HUMAN_CREDENTIALS_MAX, { issuedVia: "human", createdByUserId: f.owner.id });
    const token = await issueAgentBootstrapToken({ agentId: f.agentA, serverId: f.serverId, issuedByUserId: f.owner.id, scopes: ["read"] });
    await assert.rejects(consumeAgentBootstrapToken(token.rawToken), (err: unknown) => {
      assert.ok(err instanceof RefusalError);
      assert.equal(err.status, 409);
      assert.equal(err.refusal.code, "agent_credential_limit_reached");
      return true;
    });
    const [row] = await getDb().select({ consumedAt: agentBootstrapTokens.consumedAt }).from(agentBootstrapTokens).where(eq(agentBootstrapTokens.id, token.tokenId));
    assert.equal(row!.consumedAt, null, "the token can be exchanged once a key is revoked");
    assert.equal(await liveHumanCount(f.agentA), AGENT_LIVE_HUMAN_CREDENTIALS_MAX);
  });
});

// ── 3. non-UUID ids ─────────────────────────────────────────────────────────

test("a non-UUID agent or credential id answers the same 404 as a missing one, on every credential route", async ({ app }) => {
  await withEnv(MINT_GATES, async () => {
    const f = await seedFixture();
    const call = async (method: string, path: string, extra: Record<string, string> = {}) => {
      const res = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.owner.token}`, ...extra },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      return { status: res.status, body: await res.text() };
    };
    for (const bad of ["not-a-uuid", "1", "00000000-0000-0000-0000-00000000000g"]) {
      for (const [method, suffix] of [["POST", "/credentials"], ["GET", "/credentials"], ["DELETE", `/credentials/${randomUUID()}`]] as const) {
        const missing = await call(method, `/api/agents/${randomUUID()}${suffix}`);
        const malformed = await call(method, `/api/agents/${bad}${suffix}`);
        assert.equal(missing.status, 404, `${method} ${suffix}`);
        assert.deepEqual(malformed, missing, `${method} /api/agents/${bad}${suffix}`);
      }
      const missingCredential = await call("DELETE", `/api/agents/${f.agentA}/credentials/${randomUUID()}`);
      assert.equal(missingCredential.status, 404);
      assert.deepEqual(await call("DELETE", `/api/agents/${f.agentA}/credentials/${bad}`), missingCredential);

      const serverHeader = { "X-Server-Id": f.serverId };
      const missingBootstrap = await call("POST", `/api/agents/${randomUUID()}/bootstrap-tokens`, serverHeader);
      assert.equal(missingBootstrap.status, 404);
      assert.deepEqual(await call("POST", `/api/agents/${bad}/bootstrap-tokens`, serverHeader), missingBootstrap);
    }
  });
});
