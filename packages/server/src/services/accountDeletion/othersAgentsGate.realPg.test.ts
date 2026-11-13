// Real-PostgreSQL proof that the account deletion request's gate on other people's agents
// (requests.ts, 409 `others_agents_on_computers`) cannot be slipped past by a concurrent bind.
//
// The request locks the person's `daemons` rows FOR UPDATE (lockOwnMachines) before it reads what is bound to them, and
// revokes their keys in the same transaction. Binding an agent writes `agents.daemon_id`, whose foreign key check takes
// FOR KEY SHARE on the `daemons` row, which conflicts with FOR UPDATE:
// - a bind in flight first: the request waits for it, then sees it and answers the 409;
// - the request first: the bind waits until the request has committed (the key revoked), so nothing is bound between
//   the check and the revoke.
// Every wait is proven to be blocked by the expected backend (pg_blocking_pids). PGlite serializes transactions, so
// only a real multi-connection Postgres can show this.
//
// Runs with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth; `test:actor-membership-fence-real-pg`).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../../db/index";
import { accountDeletionRequests, agents, computers, machines, serverMembers, servers, users } from "../../db/schema";
import { migrateRealPgTestDatabase } from "../../test/integration/realPgMigrate";
import { createAgent } from "../agentService";
import { requestAccountDeletion } from "./requests";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
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

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]!.pid;
}

/** Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`, and returns its pid. */
async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number): Promise<number> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

function trackSettled<T>(promise: Promise<T>) {
  const state = { settled: false };
  const tracked = promise.finally(() => { state.settled = true; });
  tracked.catch(() => undefined);
  return { tracked, state };
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `deletion-gate-${label}-${suffix}@raft.test`,
    name: `deletion-gate-${label}-${suffix}`,
    displayName: `deletion-gate-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A person with a live Computer (laptop) in a server they share with a colleague (also an owner), and the colleague's agent, unbound. */
async function seed() {
  const person = await seedUser("person");
  const colleague = await seedUser("colleague");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({ name: `deletion-gate-${suffix}`, slug: `deletion-gate-${suffix}`, ownerId: person.id }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server!.id, userId: person.id, role: "owner" },
    { serverId: server!.id, userId: colleague.id, role: "owner" },
  ]);
  const [laptop] = await getDb().insert(machines).values({ serverId: server!.id, userId: person.id, name: "laptop", apiKeyHash: `hash-${randomUUID()}` }).returning();
  await getDb().insert(computers).values({
    serverId: server!.id, name: "laptop", machineId: laptop!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
    attachedByUserId: person.id,
  });
  const agent = await createAgent(server!.id, `colleagues-${suffix}`, { runtime: "external", creatorType: "user", creatorId: colleague.id });
  return { person, laptop: laptop!, agent };
}

const requestOf = (userId: string) => requestAccountDeletion({ userId, source: "self", actorUserId: userId });
const pendingRequests = async (userId: string) => (await getDb().select({ id: accountDeletionRequests.id }).from(accountDeletionRequests)
  .where(eq(accountDeletionRequests.userId, userId))).length;

test("real PG: a bind in flight first — the request waits on the machine row, then sees the agent and answers the 409", async () => {
  await withRealPg(async (observer) => {
    const { person, laptop, agent } = await seed();
    const bind = await observer.connect();
    let request: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof requestOf>>>> | undefined;
    try {
      await bind.query("BEGIN");
      const bindPid = await backendPid(bind);
      await bind.query("UPDATE agents SET daemon_id = $1 WHERE id = $2", [laptop.id, agent.id]);
      request = trackSettled(requestOf(person.id));
      await waitForLockWaiter(observer, '%from "daemons"%for update%', bindPid);
      assert.equal(request.state.settled, false, "the request waits for the bind");
      await bind.query("COMMIT");
    } finally {
      await bind.query("ROLLBACK").catch(() => undefined);
      bind.release();
    }
    const outcome = await request!.tracked;
    assert.equal(outcome.kind === "conflict" ? outcome.code : outcome.kind, "others_agents_on_computers");
    assert.equal(await pendingRequests(person.id), 0);
    const [key] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
    assert.equal(key!.revokedAt, null, "nothing revoked");
  });
}, TEST_TIMEOUT_MS);

test("real PG: the request first — a bind waits on the machine row until the request has committed with the key revoked", async () => {
  await withRealPg(async (observer) => {
    const { person, laptop, agent } = await seed();
    // Hold the laptop's Computer row so the request stops after its check, at the key revoke, with the machine locked.
    const hold = await observer.connect();
    const bind = await observer.connect();
    let request: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof requestOf>>>> | undefined;
    let bound: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      await hold.query("BEGIN");
      const holdPid = await backendPid(hold);
      await hold.query("SELECT 1 FROM computers WHERE machine_id = $1 FOR UPDATE", [laptop.id]);
      request = trackSettled(requestOf(person.id));
      const requestPid = await waitForLockWaiter(observer, '%update "computers"%', holdPid);
      bound = trackSettled(bind.query("UPDATE agents SET daemon_id = $1 WHERE id = $2", [laptop.id, agent.id]));
      await waitForLockWaiter(observer, "%UPDATE agents SET daemon_id%", requestPid);
      assert.equal(bound.state.settled, false, "the bind waits behind the request's machine lock");
      await hold.query("COMMIT");
      const outcome = await request.tracked;
      assert.equal(outcome.kind, "scheduled");
      await bound.tracked;
    } finally {
      await hold.query("ROLLBACK").catch(() => undefined);
      hold.release();
      bind.release();
    }
    // The bind landed only after the commit: onto a Computer already revoked (a follow-up refuses such binds).
    const [key] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
    assert.ok(key!.revokedAt);
    const [row] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, agent.id));
    assert.equal(row!.machineId, laptop.id);
  });
}, TEST_TIMEOUT_MS);
