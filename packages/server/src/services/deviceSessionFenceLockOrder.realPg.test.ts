// Real-PostgreSQL proof that a device session's write fence (lockLiveSessionFamily) and a family revoke keep one lock
// order, users -> session_families, so they wait on each other instead of deadlocking.
//
// A family revoke (revokeSessionFamilyInTransaction: the revoke link, logout, password change) locks the person's `users`
// row FOR UPDATE and then updates the family. A device session's credential mint takes the fence and then inserts a row
// whose foreign key to `users` takes KEY SHARE. Fencing the family alone (share lock) would deadlock with a revoke that
// already holds `users`: the revoke waits on the family, the mint's insert on `users`, and PostgreSQL aborts the revoke.
// The fence therefore takes `users` FOR KEY SHARE before the family:
// - write first: the revoke waits on `users` behind the write; the write commits, the revoke follows, and the revoke
//   cascade (revokeKeysOfRevokedDeviceSessions, after the revoke) revokes what the write minted;
// - revoke first: the write waits on `users` behind the revoke, then finds the family revoked and writes nothing.
// Every lock wait is proven to be blocked by the expected backend (pg_blocking_pids).
//
// The same order holds for a person's one-time login code (an app login's, a Login with Raft code's): a family revoke
// denies the codes the family approved after it took `users`, and the exchange takes `users` (FOR UPDATE for the app
// login, which issues a session; FOR KEY SHARE for Login with Raft) before the code's row. A revoke holding `users`
// therefore makes the exchange wait, then refuse the code; without that lock first, the Login with Raft exchange
// would hold the request row while its token's foreign key waits on `users`, and the revoke would deadlock on the
// request row, and the app login would issue its session after the revoke.
// A device login's code that asks for a device session too: its poll takes `users` FOR UPDATE before it reads and
// consumes the code's row and issues the session; without that lock first, the poll would hold the code's row while
// the session's issue waits on `users`, and the revoke would deadlock denying the code.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { agentCredentials, appLoginRequests, deviceAuthorizations, oauthAccessRequests, oauthAccessTokens, serverMembers, servers, sessionFamilies, users } from "../db/schema";
import { createAgent } from "./agentService";
import { mintAgentCredential } from "./agentCredentialService";
import { approveAppLogin, exchangeAppLoginCode, startAppLogin } from "./appLoginService";
import { approveDeviceAuthorization, consumeDeviceAuthorization, createDeviceAuthorization, describeDeviceAuthorization } from "./deviceAuthService";
import { revokeKeysOfRevokedDeviceSessions } from "./deviceSessionKeys";
import { createOAuthClient, exchangeAccessRequest } from "./oauthService";
import { createSession, DeviceSessionRevokedError, lockLiveSessionFamily, revokeSessionFamilyInTransaction } from "./sessionService";
import { proofForAppLogin, proofForDeviceLogin, proofForPasswordLogin } from "./sessionIssueGate";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;

async function withRealPg(run: (observer: pg.Pool) => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED=1 but ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is unset");
    return;
  }
  const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
  await initDatabase(REAL_PG_URL);
  try {
    await run(pool);
  } finally {
    await closeDatabase();
    await pool.end();
  }
}

/** Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`. */
async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function isDeadlock(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "40P01" || code?.cause?.code === "40P01";
}

/** A person with a device-scoped session family and an external agent they may mint credentials for. */
async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `device-fence-${suffix}@raft.test`,
    name: `device-fence-${suffix}`,
    displayName: "device-fence",
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [server] = await getDb().insert(servers).values({ name: `device-fence-${suffix}`, slug: `device-fence-${suffix}`, ownerId: user.id }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "owner" });
  const agent = await createAgent(server.id, `device-fence-agent-${suffix}`, { runtime: "external" });
  const { familyId } = await createSession(await proofForDeviceLogin(user.id, null), undefined, { scope: "device" });
  return { userId: user.id, agentId: agent.id, familyId };
}

async function backendPid(tx: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> }): Promise<number> {
  const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
  return Number((result.rows[0] as { pid: number }).pid);
}

test("real PG: write first: the family revoke waits on users behind the fenced mint, no deadlock, and the cascade revokes the mint", async () => {
  await withRealPg(async (observer) => {
    const { userId, agentId, familyId } = await seed();
    const fenced = deferred();
    const proceed = deferred();
    let writerPid = 0;
    const write = getDb().transaction(async (tx) => {
      await lockLiveSessionFamily(tx, familyId, userId);
      writerPid = await backendPid(tx as never);
      fenced.release();
      await proceed.promise;
      return mintAgentCredential({
        agentId,
        scopes: ["read"],
        issuedVia: "human",
        createdByUserId: userId,
        issuedBySessionFamilyId: familyId,
      }, { executor: tx });
    });
    await fenced.promise;
    const revoke = getDb().transaction((tx) => revokeSessionFamilyInTransaction(tx, userId, familyId, "device_login_revoked"));
    revoke.catch(() => undefined);
    await waitForLockWaiter(observer, "%for update%", writerPid);
    proceed.release();
    const minted = await write;
    try {
      await revoke;
    } catch (error) {
      assert.fail(isDeadlock(error) ? "the family revoke deadlocked with the fenced mint" : String(error));
    }
    const [family] = await getDb().select({ revokedAt: sessionFamilies.revokedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, familyId));
    assert.ok(family?.revokedAt, "the family is revoked");
    assert.equal(await revokeKeysOfRevokedDeviceSessions({ familyId }), 1);
    const [credential] = await getDb().select({ reason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.id, minted.credentialId));
    assert.equal(credential?.reason, "device_login_revoked");
  });
}, TEST_TIMEOUT_MS);

test("real PG: revoke first: the fenced write waits on users behind the revoke, then finds the family revoked and writes nothing", async () => {
  await withRealPg(async (observer) => {
    const { userId, agentId, familyId } = await seed();
    const revoked = deferred();
    const commit = deferred();
    let revokerPid = 0;
    const revoke = getDb().transaction(async (tx) => {
      await revokeSessionFamilyInTransaction(tx, userId, familyId, "device_login_revoked");
      revokerPid = await backendPid(tx as never);
      revoked.release();
      await commit.promise;
    });
    await revoked.promise;
    const write = getDb().transaction(async (tx) => {
      await lockLiveSessionFamily(tx, familyId, userId);
      return mintAgentCredential({ agentId, scopes: ["read"], issuedVia: "human", createdByUserId: userId, issuedBySessionFamilyId: familyId }, { executor: tx });
    });
    write.catch(() => undefined);
    await waitForLockWaiter(observer, "%for key share%", revokerPid);
    commit.release();
    await revoke;
    await assert.rejects(write, DeviceSessionRevokedError);
    const rows = await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.issuedBySessionFamilyId, familyId));
    assert.deepEqual(rows, []);
  });
}, TEST_TIMEOUT_MS);

/** A person signed in on the web (a `full` family) on a Server of their own with a Server-local App. */
async function seedWebSignIn() {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `login-code-${suffix}@raft.test`,
    name: `login-code-${suffix}`,
    displayName: "login-code",
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [server] = await getDb().insert(servers).values({ name: `login-code-${suffix}`, slug: `login-code-${suffix}`, ownerId: user.id }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "owner" });
  const gate = await proofForPasswordLogin(user.id);
  assert.equal(gate.secondFactorRequired, false);
  const { familyId } = await createSession(gate.proof);
  return { userId: user.id, serverId: server.id, familyId };
}

/** A family revoke that has taken the person's `users` row and waits for `proceed` before revoking. */
function revokeHoldingUsers(userId: string, familyId: string) {
  const held = deferred();
  const proceed = deferred();
  let pid = 0;
  const done = getDb().transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    pid = await backendPid(tx as never);
    held.release();
    await proceed.promise;
    await revokeSessionFamilyInTransaction(tx, userId, familyId, "logout");
  });
  return { held: held.promise, pid: () => pid, proceed: proceed.release, done };
}

test("real PG: a revoke holding users first: the Login with Raft exchange waits on users, no deadlock, and the code is denied", async () => {
  await withRealPg(async (observer) => {
    const { userId, serverId, familyId } = await seedWebSignIn();
    const { client } = await createOAuthClient({ serverId, createdByUserId: userId, name: "Lock order App", clientId: `lock-order-${randomUUID().slice(0, 8)}` });
    const [request] = await getDb().insert(oauthAccessRequests).values({
      serverId, principalType: "human", userId, clientId: client.id, scopes: ["openid", "profile"],
      status: "approved", resolvedByUserId: userId, resolvedAt: new Date(), approverSessionFamilyId: familyId,
    }).returning();

    const revoke = revokeHoldingUsers(userId, familyId);
    revoke.done.catch(() => undefined);
    await revoke.held;
    const exchange = exchangeAccessRequest({ clientId: client.id, requestId: request!.id });
    exchange.catch(() => undefined);
    await waitForLockWaiter(observer, "%for key share%", revoke.pid());
    revoke.proceed();
    try {
      await revoke.done;
    } catch (error) {
      assert.fail(isDeadlock(error) ? "the family revoke deadlocked with the code exchange" : String(error));
    }
    await assert.rejects(exchange, /^Error: access_denied$/);
    const [row] = await getDb().select({ status: oauthAccessRequests.status, consumedAt: oauthAccessRequests.consumedAt }).from(oauthAccessRequests).where(eq(oauthAccessRequests.id, request!.id));
    assert.deepEqual(row, { status: "denied", consumedAt: null });
    assert.deepEqual(await getDb().select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.requestId, request!.id)), []);
  });
}, TEST_TIMEOUT_MS);

test("real PG: a revoke holding users first: the app login exchange waits on users, then refuses the code and issues no session", async () => {
  await withRealPg(async (observer) => {
    const { userId, familyId } = await seedWebSignIn();
    const verifier = randomUUID() + randomUUID();
    const started = await startAppLogin({ returnUri: "raft://login/callback", codeChallenge: createHash("sha256").update(verifier).digest("base64url") });
    assert.ok(started.ok);
    const approved = await approveAppLogin(started.requestId, userId, familyId);
    assert.ok(approved.ok);
    const code = new URL(approved.redirectUrl).searchParams.get("code")!;

    const revoke = revokeHoldingUsers(userId, familyId);
    revoke.done.catch(() => undefined);
    await revoke.held;
    // As POST /api/auth/app-login/complete: consume and issue in one transaction.
    const exchange = getDb().transaction(async (tx) => {
      const exchanged = await exchangeAppLoginCode(tx, code, verifier);
      if (!exchanged.ok) return exchanged;
      await createSession(await proofForAppLogin(userId, exchanged.approverFamilyId, tx), tx);
      return exchanged;
    });
    exchange.catch(() => undefined);
    await waitForLockWaiter(observer, "%for update%", revoke.pid());
    revoke.proceed();
    await revoke.done;
    assert.deepEqual(await exchange, { ok: false, error: "code_expired" });
    const [row] = await getDb().select({ status: appLoginRequests.status }).from(appLoginRequests).where(eq(appLoginRequests.id, started.requestId));
    assert.equal(row?.status, "denied");
    const families = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId));
    assert.deepEqual(families.map((family) => family.id), [familyId], "no session issued after the revoke");
  });
}, TEST_TIMEOUT_MS);

test("real PG: a revoke holding users first: the device code poll waits on users, then refuses the code and issues no session", async () => {
  await withRealPg(async (observer) => {
    const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "device-code-lock-order-pepper-0123456789";
    try {
      const { userId, familyId } = await seedWebSignIn();
      const login = await createDeviceAuthorization({ clientName: "raft-computer" });
      const described = await describeDeviceAuthorization({ userCode: login.userCode, userId });
      assert.ok(described.ok);
      const approved = await approveDeviceAuthorization({
        userCode: login.userCode, userId, approve: true, approvalTicket: described.approvalTicket, approverSessionFamilyId: familyId,
      });
      assert.ok(approved.ok);

      const revoke = revokeHoldingUsers(userId, familyId);
      revoke.done.catch(() => undefined);
      await revoke.held;
      // As POST /api/auth/device/token: the consume issues the device session in its transaction.
      const poll = consumeDeviceAuthorization(login.deviceCode);
      poll.catch(() => undefined);
      await waitForLockWaiter(observer, "%for update%", revoke.pid());
      revoke.proceed();
      try {
        await revoke.done;
      } catch (error) {
        assert.fail(isDeadlock(error) ? "the family revoke deadlocked with the device code poll" : String(error));
      }
      assert.deepEqual(await poll, { ok: false, error: "access_denied" });
      const [row] = await getDb().select({ status: deviceAuthorizations.status, consumedAt: deviceAuthorizations.consumedAt })
        .from(deviceAuthorizations).where(eq(deviceAuthorizations.userCode, login.userCode));
      assert.deepEqual(row, { status: "denied", consumedAt: null });
      const families = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies).where(eq(sessionFamilies.userId, userId));
      assert.deepEqual(families.map((family) => family.id), [familyId], "no device session issued after the revoke");
    } finally {
      if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
      else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
    }
  });
}, TEST_TIMEOUT_MS);
