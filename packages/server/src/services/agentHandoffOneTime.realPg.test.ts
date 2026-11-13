// Opt-in real PostgreSQL proof of one-time Agent request redemption. This
// requires an explicitly disposable loopback database and never uses staging.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { test } from "vitest";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { oauthAccessRequests, oauthAccessTokens, oauthAgentAutoGrantBlocks, oauthClients, serverMembers, servers, users } from "../db/schema";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { createAgent } from "./agentService";
import { AGENT_REQUEST_CODE_TTL_MS, createOAuthClient, exchangeAccessRequest, requestAgentAccess } from "./oauthService";

const raw = process.env.AGENT_HANDOFF_REAL_PG_URL;
const enabled = process.env.AGENT_HANDOFF_DISPOSABLE_INSTANCE === "1";
let parsed: URL | null = null;
try { if (raw) parsed = new URL(raw); } catch { /* refused below */ }
if (raw && (!enabled || !parsed || !["postgres:", "postgresql:"].includes(parsed.protocol)
  || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  || parsed.pathname !== "/cardy_agent_code_concurrency_test")) {
  throw new Error("Use the named database on an explicitly disposable loopback PostgreSQL instance");
}

test.skipIf(!raw)("real PG serializes simultaneous redemptions and issues one token", async () => {
  const pool = new pg.Pool({ connectionString: raw!, max: 4 });
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(raw!);
  try {
    const suffix = randomUUID().slice(0, 8);
    const [owner] = await getDb().insert(users).values({ email: `agent-code-${suffix}@raft.test`, name: `agent-code-${suffix}`, displayName: "Fixture", passwordHash: "x", emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
    const [server] = await getDb().insert(servers).values({ name: `Agent code ${suffix}`, slug: `agent-code-${suffix}`, ownerId: owner!.id }).returning();
    await getDb().insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
    const agent = await createAgent(server!.id, `code-${suffix}`, { runtime: "codex" });
    const { client } = await createOAuthClient({ serverId: server!.id, createdByUserId: owner!.id, clientId: `agent-code-${suffix}`, name: "Fixture" });
    await getDb().update(oauthClients).set({ agentHandoffProtocol: "v1" }).where(eq(oauthClients.id, client.id));
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const [request] = await getDb().insert(oauthAccessRequests).values({ serverId: server!.id, agentId: agent.id, clientId: client.id, principalType: "agent", scopes: [], status: "approved", remember: false, resolvedAt: new Date(), agentHandoffChallenge: challenge }).returning();
    await assert.rejects(exchangeAccessRequest({ clientId: client.id, requestId: request!.id }), /Access request not found/);
    const blocker = await pool.connect();
    let outcomes: PromiseSettledResult<Awaited<ReturnType<typeof exchangeAccessRequest>>>[];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM oauth_access_requests WHERE id=$1 FOR UPDATE", [request!.id]);
      const { rows: [identity] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pending = Promise.allSettled(Array.from({ length: 8 }, () => exchangeAccessRequest({ clientId: client.id, requestId: request!.id, codeVerifier: verifier })));
      const deadline = Date.now() + 5_000;
      let waiters = 0;
      while (Date.now() < deadline) {
        const { rows } = await pool.query<{ n: number }>(`WITH RECURSIVE blocked(pid) AS (
          SELECT $1::int
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
            JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock'
        ) SELECT (count(*) - 1)::int AS n FROM blocked`, [identity!.pid]);
        waiters = rows[0]!.n;
        if (waiters >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(waiters >= 2, "at least two real exchange transactions wait on the same request row");
      await blocker.query("COMMIT");
      outcomes = await pending;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const refused = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(refused.length, 7);
    assert.ok(refused.every((result) => result.reason instanceof Error && result.reason.message === "request_already_consumed"));
    const tokens = await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.requestId, request!.id));
    assert.equal(tokens.length, 1);

    // Same persisted challenge may be retried concurrently after a response
    // was lost. Force insert overlap and require one recoverable request.
    await getDb().insert(oauthAgentAutoGrantBlocks).values({ agentId: agent.id, clientId: client.id, serverId: server!.id, blockedByUserId: owner!.id });
    const retryChallenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    await pool.query("CREATE FUNCTION cardy_delay_handoff_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER cardy_delay_handoff BEFORE INSERT ON oauth_access_requests FOR EACH ROW EXECUTE FUNCTION cardy_delay_handoff_insert()");
    try {
      const attempts = await Promise.all(Array.from({ length: 8 }, () => requestAgentAccess({ clientId: client.id, serverSlug: server!.slug, agentId: agent.id, scopes: ["identity"], initiatedByAgent: true, agentHandoffChallenge: retryChallenge })));
      assert.equal(new Set(attempts.map((attempt) => attempt.request!.id)).size, 1);
      assert.ok(attempts.every((attempt) => attempt.status === "pending"));
      const rows = await getDb().select({ id: oauthAccessRequests.id }).from(oauthAccessRequests).where(eq(oauthAccessRequests.agentHandoffChallenge, retryChallenge));
      assert.equal(rows.length, 1);
    } finally {
      await pool.query("DROP TRIGGER cardy_delay_handoff ON oauth_access_requests");
      await pool.query("DROP FUNCTION cardy_delay_handoff_insert()");
    }

    // Enter while still valid, hold the request row across expiry, then check
    // the real exchange uses the time after acquiring that row lock.
    const approvedAt = new Date(Date.now() - AGENT_REQUEST_CODE_TTL_MS + 3_000);
    const lateVerifier = randomBytes(32).toString("base64url");
    const lateChallenge = createHash("sha256").update(lateVerifier).digest("base64url");
    const [late] = await getDb().insert(oauthAccessRequests).values({ serverId: server!.id, agentId: agent.id, clientId: client.id, principalType: "agent", scopes: [], status: "approved", remember: false, resolvedAt: approvedAt, agentHandoffChallenge: lateChallenge }).returning();
    const held = await pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM oauth_access_requests WHERE id=$1 FOR UPDATE", [late!.id]);
      const { rows: [holder] } = await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const waiting = exchangeAccessRequest({ clientId: client.id, requestId: late!.id, codeVerifier: lateVerifier }).then(() => "issued", (error: Error) => error.message);
      let blocked = 0;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && blocked === 0) {
        const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))", [holder!.pid]);
        blocked = rows[0]!.n;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(blocked > 0 && Date.now() < approvedAt.getTime() + AGENT_REQUEST_CODE_TTL_MS, "exchange waits while the code is still valid");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, approvedAt.getTime() + AGENT_REQUEST_CODE_TTL_MS - Date.now() + 150)));
      await held.query("COMMIT");
      assert.equal(await waiting, "agent_request_expired");
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
    }
  } finally {
    await closeDatabase();
    await pool.end();
  }
}, 120_000);
