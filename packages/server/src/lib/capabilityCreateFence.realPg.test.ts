// Real-PostgreSQL proof for task #93 line G: capability-only creates (Agent create, Machine register, Computer attach)
// must re-authorize the acting human under a lock on their own `server_members` row inside the create transaction, so a
// removal or demotion that commits first leaves zero created rows. PGlite serializes transactions, so the ordering can
// only be observed against a real multi-connection Postgres. Blocking is proven from pg_stat_activity lock waits.
//
// Shape per create: another session holds an uncommitted removal (DELETE) or demotion (role UPDATE) of the actor's
// member row; the create must wait on that row; once the change commits, the create is refused and writes nothing.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the #91a fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agents, computers, machines, serverMembers, servers, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import { attachComputer } from "../services/computerCredentialService";
import { acquireMachineCreateLock, registerMachine, type MachineCreateLock } from "../services/machineService";
import { transitionMemberRole } from "../services/serverService";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError } from "./actorMembershipFence";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;

/**
 * Identifies THIS file's sessions in pg_stat_activity (task #611). The probe step runs 8 real-PG files concurrently
 * against one database, and `freezeAgentInserts` takes a TABLE lock on `agents`, so every sibling file's agent insert
 * queues behind this file's freeze too. A lock-waiter matched only on statement text plus blocking pid can therefore
 * return ANOTHER file's insert as `createPid`, after which the second wait can never be satisfied. That defect is
 * proven to produce the CI failure shape by the regression test below; the three historical runs carry no session
 * identity, so they cannot be attributed to it case by case. `pg` reads its default `application_name` from PGAPPNAME,
 * so setting it before any pool is constructed labels both this file's observer pool and its app pool.
 */
const APP_NAME = `capfence-${randomUUID().slice(0, 8)}`;

async function withRealPg(run: (observer: pg.Pool) => Promise<void>): Promise<void> {
  if (!REAL_PG_URL) {
    if (REAL_PG_REQUIRED) throw new Error("ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED=1 but ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is unset");
    return;
  }
  // PGAPPNAME is process-global. The restore sits in an OUTER finally so it also runs when migrate/init throws before
  // the body starts, or when closeDatabase()/pool.end() throws during cleanup (@skyzh, task #614).
  const priorAppName = process.env.PGAPPNAME;
  process.env.PGAPPNAME = APP_NAME;
  try {
    const pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 4, application_name: APP_NAME });
    await migrateRealPgTestDatabase(pool, MIGRATIONS_FOLDER);
    await initDatabase(REAL_PG_URL);
    try {
      await run(pool);
    } finally {
      await closeDatabase();
      await pool.end();
    }
  } finally {
    if (priorAppName === undefined) delete process.env.PGAPPNAME;
    else process.env.PGAPPNAME = priorAppName;
  }
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `create-fence-${label}-${suffix}@raft.test`,
    name: `create-fence-${label}-${suffix}`,
    displayName: `create-fence-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner plus one admin actor (admins hold createAgents and registerMachines; members hold neither). */
async function seed() {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `create-fence-server-${suffix}`,
    slug: `create-fence-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: actor.id, role: "admin" },
  ]);
  return { owner, actor, server };
}

/**
 * Owner and one admin creator whose user ids are ordered as requested, so a test can pin the sorted member-row order
 * (transitionMemberRole and the create both lock the lower user id first).
 */
async function seedOrdered(ownerIdFirst: boolean) {
  const a = await seedUser("ordered-a");
  const b = await seedUser("ordered-b");
  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  const owner = ownerIdFirst ? low : high;
  const creator = ownerIdFirst ? high : low;
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `create-fence-ordered-${suffix}`,
    slug: `create-fence-ordered-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    // Setup not yet complete, so the create really updates the owner's row (markServerSetupCompleteOnFirstAgent).
    { serverId: server.id, userId: owner.id, role: "owner", setupStatus: "in_progress" },
    { serverId: server.id, userId: creator.id, role: "admin" },
  ]);
  return { owner, creator, server };
}

/** Holds `LOCK TABLE agents IN SHARE MODE` until released, freezing an Agent INSERT after the create's fence locks. */
async function freezeAgentInserts(observer: pg.Pool) {
  const session = await observer.connect();
  await session.query("BEGIN");
  const pid = await backendPid(session);
  await session.query("LOCK TABLE agents IN SHARE MODE");
  return {
    pid,
    async release() {
      await session.query("COMMIT").catch(() => undefined);
      session.release();
    },
  };
}

function isDeadlock(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "40P01" || code?.cause?.code === "40P01";
}

function fencedCreate(serverId: string, creatorId: string, label: string) {
  return createAgent(serverId, `${label}-${randomUUID().slice(0, 6)}`, {
    creatorType: "user",
    creatorId,
    actorCapabilityFence: { userId: creatorId, capability: "createAgents" },
  });
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

/**
 * Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`, and returns its pid. Scoping the wait to
 * the blocking session keeps a concurrently running test (the probe step runs several real-PG files) from satisfying it.
 */
/**
 * Session-level snapshot used only when a wait assertion is about to fail (task #611). Records identifiers, ownership
 * and lock state, plus a statement CATEGORY from a fixed vocabulary. No statement text is emitted: `pg_stat_activity
 * .query` is not guaranteed to hold only `$n` placeholders, and even a short prefix can carry SQL literals.
 */
async function lockWaitSnapshot(observer: pg.Pool): Promise<string> {
  const { rows } = await observer.query<{
    pid: number; app: string | null; state: string | null; wait_event_type: string | null; wait_event: string | null;
    blocked_by: number[]; category: string;
  }>(
    // Emits a FIXED category vocabulary, never statement text: `pg_stat_activity.query` is not guaranteed to contain
    // only `$n` placeholders, and even a 60-char prefix can carry SQL literals (@skyzh, task #614).
    `SELECT pid, application_name AS app, state, wait_event_type, wait_event,
            pg_blocking_pids(pid) AS blocked_by,
            CASE
              WHEN query ILIKE '%lock table agents%' THEN 'agents_table_lock'
              WHEN query ILIKE '%insert into "agents"%' THEN 'agents_insert'
              WHEN query ILIKE '%from servers%for update%' THEN 'servers_for_update'
              WHEN query ILIKE '%from servers%for share%' THEN 'servers_for_share'
              WHEN query ILIKE '%server_members%for update%' THEN 'members_for_update'
              WHEN query ILIKE '%server_members%for share%' THEN 'members_for_share'
              WHEN query ILIKE '%update server_members set role%' THEN 'members_role_update'
              WHEN query ILIKE '%delete from server_members%' THEN 'members_delete'
              ELSE 'other'
            END AS category
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      ORDER BY pid`,
  );
  if (rows.length === 0) return "(no other backends)";
  return rows
    .map((row) => `pid=${row.pid} app=${row.app ?? "-"}${row.app === APP_NAME ? "(mine)" : "(foreign)"}`
      + ` state=${row.state ?? "-"} wait=${row.wait_event_type ?? "-"}/${row.wait_event ?? "-"}`
      + ` blockedBy=[${(row.blocked_by ?? []).join(",")}] category=${row.category}`)
    .join("\n    ");
}

/**
 * Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`, and returns its pid. Scoping the wait to
 * the blocking session keeps a concurrently running test (the probe step runs several real-PG files) from satisfying it.
 *
 * `describeAwaited` (task #611) is reported only on timeout. Three natural CI failures of the second wait in
 * "non-owner create first" said only that no waiter appeared, which cannot distinguish an operation that rejected
 * before taking any lock, from one still queued for a pool client, from a real lock-order change, from a waiter whose
 * statement text does not match `queryLike`. The snapshot below is taken AFTER the deadline, so the 5s budget and the
 * assertion itself are unchanged.
 */
/**
 * One poll of the lock-waiter query. `application_name` pins the match to THIS file's sessions: a sibling real-PG file
 * blocked behind the same table lock is not this test's create (task #611). `scoped: false` exists only so the
 * regression test can show what the unscoped form would have selected.
 */
async function findLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number, scoped: boolean): Promise<number | null> {
  const { rows } = await observer.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       AND ($3::boolean IS FALSE OR application_name = $4)
     LIMIT 1`,
    [queryLike, blockedBy, scoped, APP_NAME],
  );
  return rows[0]?.pid ?? null;
}

/** Polls `findLockWaiter` for a bounded window and reports absence instead of failing. Regression-test only. */
async function probeLockWaiter(
  observer: pg.Pool, queryLike: string, blockedBy: number, scoped: boolean, windowMs: number,
): Promise<number | null> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const pid = await findLockWaiter(observer, queryLike, blockedBy, scoped);
    if (pid !== null) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

/**
 * Asserts the foreign-only window used by the scoping regression (task #614):
 *   - this file's deliberately created sibling insert IS queued behind `freezePid` (asserted over the whole waiter
 *     set, so a second unrelated foreign waiter cannot displace it),
 *   - an UNSCOPED match therefore finds a waiter, and that waiter belongs to ANOTHER application_name,
 *   - while the SCOPED query finds nothing at all.
 * The last point is what fails if the `application_name` condition is deleted, and it holds regardless of how many
 * foreign sessions are queued or which one the database returns.
 */
async function waitForOwnWaiterAbsentWithForeignPresent(observer: pg.Pool, freezePid: number, siblingPid: number): Promise<void> {
  const pattern = '%insert into "agents"%';
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let waiters: number[] = [];
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))`,
      [pattern, freezePid],
    );
    waiters = rows.map((row) => row.pid);
    if (waiters.includes(siblingPid)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(waiters.includes(siblingPid), `the sibling insert must be queued behind the freeze; waiters=[${waiters.join(",")}]`);

  const unscoped = await findLockWaiter(observer, pattern, freezePid, false);
  assert.notEqual(unscoped, null, "an unscoped match finds a waiter behind the freeze");
  const { rows: owner } = await observer.query<{ app: string | null }>(
    "SELECT application_name AS app FROM pg_stat_activity WHERE pid = $1", [unscoped]);
  assert.notEqual(owner[0]?.app, APP_NAME, "the unscoped match belongs to another file's session, not this one");

  const scoped = await probeLockWaiter(observer, pattern, freezePid, true, 750);
  assert.equal(scoped, null,
    "the scoped query must find NOTHING while only foreign sessions are queued — deleting the application_name condition fails here");
}

async function waitForLockWaiter(
  observer: pg.Pool,
  queryLike: string,
  blockedBy: number,
  describeAwaited?: () => string,
): Promise<number> {
  const budgetMs = LOCK_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const pid = await findLockWaiter(observer, queryLike, blockedBy, true);
    if (pid !== null) return pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const awaited = describeAwaited ? `\n  awaited operation: ${describeAwaited()}` : "";
  const snapshot = await lockWaitSnapshot(observer).catch((error) => `(snapshot failed: ${errorClass(error)})`);
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${budgetMs}ms`
    + `${awaited}\n  pg_stat_activity:\n    ${snapshot}`);
}

/**
 * Restricted error descriptor for diagnostics: constructor name plus a short driver code only. An error's message can
 * embed the statement or its parameters, so it is never emitted (@skyzh, task #614).
 */
function errorClass(error: unknown): string {
  const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof error;
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === "string" && /^[A-Za-z0-9_]{1,12}$/.test(raw) ? `/${raw}` : "";
  return `${name}${code}`;
}

function trackSettled<T>(promise: Promise<T>) {
  // `reason` exists for the timeout diagnostics (task #611): a wait assertion needs to report whether the awaited
  // operation had already rejected, and with what, instead of only that no waiter appeared.
  const state: { settled: boolean; rejected: boolean; reason?: string } = { settled: false, rejected: false };
  const tracked = promise.then(
    (value) => { state.settled = true; return value; },
    (error) => { state.settled = true; state.rejected = true; state.reason = errorClass(error); throw error; },
  );
  // Mark the rejection handled at creation; the test awaits it only after releasing its own connection.
  tracked.catch(() => undefined);
  return { tracked, state };
}

/** One-line settled state for a tracked operation, for wait-timeout diagnostics only. */
function describeTracked(label: string, tracked: { state: { settled: boolean; rejected: boolean; reason?: string } } | undefined): string {
  if (!tracked) return `${label}: not started`;
  const { settled, rejected, reason } = tracked.state;
  return `${label}: settled=${settled} rejected=${rejected}${reason ? ` reason=${reason}` : ""}`;
}

type MembershipChange = "removal" | "demotion";

/**
 * Holds `change` to the actor's member row uncommitted, starts `create`, requires it to wait on the member row lock,
 * then commits the change and returns the create's settled outcome.
 */
async function raceCreateAgainst<T>(
  observer: pg.Pool,
  serverId: string,
  actorId: string,
  change: MembershipChange,
  create: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const session = await observer.connect();
  let started: ReturnType<typeof trackSettled<T>> | undefined;
  try {
    await session.query("BEGIN");
    const blocker = await backendPid(session);
    if (change === "removal") {
      await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [serverId, actorId]);
    } else {
      await session.query("UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2", [serverId, actorId]);
    }
    started = trackSettled(create());
    await waitForLockWaiter(observer, "%from server_members%for share%", blocker);
    assert.equal(started.state.settled, false, `the create must wait for the uncommitted ${change} of the actor's member row`);
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  const [outcome] = await Promise.allSettled([started!.tracked]);
  return outcome;
}

/** Holds `prepare`'s uncommitted change in a session, requires `create` to wait on `queryLike`, then commits. */
async function raceCreateAgainstPattern<T>(
  observer: pg.Pool,
  queryLike: string,
  prepare: (session: pg.PoolClient) => Promise<void>,
  create: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const session = await observer.connect();
  let started: ReturnType<typeof trackSettled<T>> | undefined;
  try {
    await session.query("BEGIN");
    const blocker = await backendPid(session);
    await prepare(session);
    started = trackSettled(create());
    await waitForLockWaiter(observer, queryLike, blocker);
    assert.equal(started.state.settled, false, "the create must wait for the uncommitted change");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  const [outcome] = await Promise.allSettled([started!.tracked]);
  return outcome;
}

async function agentCount(serverId: string) {
  return (await getDb().select({ id: agents.id }).from(agents).where(eq(agents.serverId, serverId))).length;
}

async function machineCount(serverId: string) {
  return (await getDb().select({ id: machines.id }).from(machines).where(eq(machines.serverId, serverId))).length;
}

async function computerCount(serverId: string) {
  return (await getDb().select({ id: computers.id }).from(computers).where(eq(computers.serverId, serverId))).length;
}

const agentFenceOptions = (actorId: string) => ({
  creatorType: "user" as const,
  creatorId: actorId,
  // Task #93 line G: the acting human and the capability re-checked under the member row lock.
  actorCapabilityFence: { userId: actorId, capability: "createAgents" as const },
});

for (const change of ["removal", "demotion"] as const) {
  test(`real PG: Agent create waits for an in-flight ${change} of the creator and, once it commits, creates nothing`, async () => {
    await withRealPg(async (observer) => {
      const { actor, server } = await seed();
      const outcome = await raceCreateAgainst(observer, server.id, actor.id, change, () =>
        createAgent(server.id, `fence-agent-${randomUUID().slice(0, 6)}`, agentFenceOptions(actor.id)));
      assert.equal(outcome.status, "rejected", "the create is refused");
      const reason = (outcome as PromiseRejectedResult).reason;
      assert.ok(
        change === "removal" ? reason instanceof ServerMembershipRevokedError : reason instanceof FencedAuthorizationDeniedError,
        `unexpected refusal: ${String(reason)}`,
      );
      assert.equal(await agentCount(server.id), 0, "zero Agents created");
    });
  }, TEST_TIMEOUT_MS);

  test(`real PG: Machine register waits for an in-flight ${change} of the registrant and, once it commits, registers nothing`, async () => {
    await withRealPg(async (observer) => {
      const { actor, server } = await seed();
      const outcome = await raceCreateAgainst(observer, server.id, actor.id, change, () =>
        registerMachine(server.id, actor.id, "fence-machine", { capability: "registerMachines" }));
      assert.equal(outcome.status, "rejected", "the registration is refused");
      const reason = (outcome as PromiseRejectedResult).reason;
      assert.ok(
        change === "removal" ? reason instanceof ServerMembershipRevokedError : reason instanceof FencedAuthorizationDeniedError,
        `unexpected refusal: ${String(reason)}`,
      );
      assert.equal(await machineCount(server.id), 0, "zero Machines registered");
    });
  }, TEST_TIMEOUT_MS);

  test(`real PG: Computer attach waits for an in-flight ${change} of the attaching human and, once it commits, attaches nothing`, async () => {
    await withRealPg(async (observer) => {
      const { actor, server } = await seed();
      const outcome = await raceCreateAgainst(observer, server.id, actor.id, change, () =>
        attachComputer({ userId: actor.id, serverSlug: server.slug, name: "fence-computer" }));
      assert.equal(outcome.status, "fulfilled");
      assert.deepEqual(
        (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof attachComputer>>>).value,
        { ok: false, error: change === "removal" ? "not_authorized" : "requires_admin" },
      );
      assert.equal(await computerCount(server.id), 0, "zero Computers attached");
      assert.equal(await machineCount(server.id), 0, "zero Machines registered for the attach");
    });
  }, TEST_TIMEOUT_MS);
}

test("real PG: owner-as-creator create first — a role change queued on the owner's row finishes after it, no deadlock", async () => {
  await withRealPg(async (observer) => {
    const { owner, server } = await seedOrdered(true);
    const freeze = await freezeAgentInserts(observer);
    let create: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof createAgent>>>> | undefined;
    let change: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      create = trackSettled(fencedCreate(server.id, owner.id, "owner-first"));
      const createPid = await waitForLockWaiter(observer, '%insert into "agents"%', freeze.pid);
      change = trackSettled(getDb().execute(
        sql`UPDATE server_members SET role = 'admin' WHERE server_id = ${server.id} AND user_id = ${owner.id}`,
      ));
      await waitForLockWaiter(observer, "%update server_members set role%", createPid);
    } finally {
      await freeze.release();
    }
    const [createOutcome, changeOutcome] = await Promise.allSettled([create!.tracked, change!.tracked]);
    assert.ok(!(createOutcome.status === "rejected" && isDeadlock(createOutcome.reason)), "the create must not deadlock");
    assert.ok(!(changeOutcome.status === "rejected" && isDeadlock(changeOutcome.reason)), "the role change must not deadlock");
    assert.equal(createOutcome.status, "fulfilled", `the create commits: ${createOutcome.status === "rejected" ? String(createOutcome.reason) : ""}`);
    assert.equal(changeOutcome.status, "fulfilled", `the queued role change commits after it: ${changeOutcome.status === "rejected" ? String(changeOutcome.reason) : ""}`);
    assert.equal(await agentCount(server.id), 1);
    const [ownerRow] = await getDb().select({ setupStatus: serverMembers.setupStatus, role: serverMembers.role })
      .from(serverMembers).where(eq(serverMembers.userId, owner.id));
    assert.equal(ownerRow?.setupStatus, "complete", "the create stamped the owner's setup row (the row it locked FOR UPDATE)");
    assert.equal(ownerRow?.role, "admin", "the queued role change committed after the create");
  });
}, TEST_TIMEOUT_MS);

test("real PG: owner-as-creator removal first — the create waits on the owner's row and creates nothing", async () => {
  await withRealPg(async (observer) => {
    const { owner, server } = await seedOrdered(true);
    const outcome = await raceCreateAgainstPattern(observer, "%from server_members%for update%", async (session) => {
      await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [server.id, owner.id]);
    }, () => fencedCreate(server.id, owner.id, "owner-removed"));
    assert.equal(outcome.status, "rejected", "the create is refused");
    assert.ok((outcome as PromiseRejectedResult).reason instanceof ServerMembershipRevokedError,
      `unexpected refusal: ${String((outcome as PromiseRejectedResult).reason)}`);
    assert.equal(await agentCount(server.id), 0, "zero Agents created");
  });
}, TEST_TIMEOUT_MS);

test("real PG: non-owner create first — an owner-driven demotion of the creator finishes after it, no deadlock", async () => {
  await withRealPg(async (observer) => {
    const { owner, creator, server } = await seedOrdered(true);
    const freeze = await freezeAgentInserts(observer);
    let create: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof createAgent>>>> | undefined;
    let demotion: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      create = trackSettled(fencedCreate(server.id, creator.id, "admin-first"));
      const createPid = await waitForLockWaiter(observer, '%insert into "agents"%', freeze.pid);
      demotion = trackSettled(transitionMemberRole({
        serverId: server.id,
        actorUserId: owner.id,
        targetUserId: creator.id,
        nextRole: "member",
      }));
      // The demotion must be blocked on some row lock the create holds (servers row under the revised order).
      await waitForLockWaiter(observer, "%for update%", createPid, () =>
        `${describeTracked("demotion", demotion)}; ${describeTracked("create", create)}; createPid=${createPid}, freezePid=${freeze.pid}`);
    } finally {
      await freeze.release();
    }
    const [createOutcome, demotionOutcome] = await Promise.allSettled([create!.tracked, demotion!.tracked]);
    assert.ok(!(createOutcome.status === "rejected" && isDeadlock(createOutcome.reason)), "the create must not deadlock");
    assert.ok(!(demotionOutcome.status === "rejected" && isDeadlock(demotionOutcome.reason)), "the demotion must not deadlock");
    assert.equal(createOutcome.status, "fulfilled", `the create commits: ${createOutcome.status === "rejected" ? String(createOutcome.reason) : ""}`);
    assert.equal(demotionOutcome.status, "fulfilled", `the demotion commits after it: ${demotionOutcome.status === "rejected" ? String(demotionOutcome.reason) : ""}`);
    assert.equal(await agentCount(server.id), 1);
  });
}, TEST_TIMEOUT_MS);

test("real PG: non-owner demotion first in transitionMemberRole's lock order — the create waits on the servers row and creates nothing", async () => {
  await withRealPg(async (observer) => {
    const { owner, creator, server } = await seedOrdered(true);
    const outcome = await raceCreateAgainstPattern(observer, "%from servers%for share%", async (session) => {
      await session.query("SELECT id FROM servers WHERE id = $1 FOR UPDATE", [server.id]);
      for (const userId of [owner.id, creator.id].sort()) {
        await session.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [server.id, userId]);
      }
      await session.query("UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2", [server.id, creator.id]);
    }, () => fencedCreate(server.id, creator.id, "admin-demoted"));
    assert.equal(outcome.status, "rejected");
    assert.ok((outcome as PromiseRejectedResult).reason instanceof FencedAuthorizationDeniedError,
      `unexpected refusal: ${String((outcome as PromiseRejectedResult).reason)}`);
    assert.equal(await agentCount(server.id), 0, "zero Agents created");
  });
}, TEST_TIMEOUT_MS);

test("real PG: sorted acquisition — a session locking owner then creator rows interleaves with a waiting create without deadlock", async () => {
  // The owner's id sorts first. The session holds the owner's row, the create (servers SHARE taken) waits on that row
  // without holding the creator's row, the session then locks the creator's row and commits. A create that locked the
  // creator's row first would hold it while waiting on the owner's row, and the session's creator-row lock would deadlock.
  await withRealPg(async (observer) => {
    const { owner, creator, server } = await seedOrdered(true);
    const session = await observer.connect();
    let create: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof createAgent>>>> | undefined;
    let sessionError: unknown;
    try {
      await session.query("BEGIN");
      const sessionPid = await backendPid(session);
      await session.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [server.id, owner.id]);
      create = trackSettled(fencedCreate(server.id, creator.id, "sorted"));
      await waitForLockWaiter(observer, "%from server_members%for update%", sessionPid);
      try {
        await session.query("SET LOCAL lock_timeout = '5s'");
        await session.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [server.id, creator.id]);
        await session.query("COMMIT");
      } catch (error) {
        sessionError = error;
      }
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
    const [createOutcome] = await Promise.allSettled([create!.tracked]);
    assert.ok(!isDeadlock(sessionError), "the session's creator-row lock must not deadlock with the create");
    assert.equal(sessionError, undefined, `the session commits: ${String(sessionError)}`);
    assert.ok(!(createOutcome.status === "rejected" && isDeadlock(createOutcome.reason)), "the create must not deadlock");
    assert.equal(createOutcome.status, "fulfilled", `the create commits after the session: ${createOutcome.status === "rejected" ? String(createOutcome.reason) : ""}`);
  });
}, TEST_TIMEOUT_MS);

test("real PG: a fenced create on a Server whose owner has no member row succeeds and stamps nothing", async () => {
  await withRealPg(async () => {
    const { owner, creator, server } = await seedOrdered(true);
    await getDb().delete(serverMembers).where(eq(serverMembers.userId, owner.id));
    const before = await getDb().select().from(serverMembers).where(eq(serverMembers.serverId, server.id));
    const agent = await fencedCreate(server.id, creator.id, "ownerless");
    assert.ok(agent.id);
    assert.equal(await agentCount(server.id), 1);
    const after = await getDb().select().from(serverMembers).where(eq(serverMembers.serverId, server.id));
    assert.deepEqual(after, before, "setup rows are unchanged");
  });
}, TEST_TIMEOUT_MS);

test("real PG: registerMachine refuses a machine create lock acquired for another Server and registers nothing", async () => {
  await withRealPg(async () => {
    const { actor, server } = await seed();
    const other = await seed();
    await assert.rejects(
      getDb().transaction(async (tx) => {
        const lock = await acquireMachineCreateLock(tx, other.server.id);
        await registerMachine(server.id, actor.id, "wrong-lock-machine", { machineCreateLock: lock });
      }),
      /machine create lock was acquired for a different Server/,
    );
    assert.equal(await machineCount(server.id), 0, "zero Machines registered");
  });
}, TEST_TIMEOUT_MS);

test("real PG: registerMachine refuses a raw-cast machine create lock token and registers nothing", async () => {
  await withRealPg(async () => {
    const { actor, server } = await seed();
    await assert.rejects(
      getDb().transaction(async () => {
        const fabricated = Object.freeze({}) as unknown as MachineCreateLock;
        await registerMachine(server.id, actor.id, "cast-lock-machine", { machineCreateLock: fabricated });
      }),
      /not a machine create lock issued by acquireMachineCreateLock/,
    );
    assert.equal(await machineCount(server.id), 0, "zero Machines registered");
  });
}, TEST_TIMEOUT_MS);

test("real PG: registerMachine refuses a genuine lock token spread with a replaced executor on the same Server", async () => {
  await withRealPg(async () => {
    const { actor, server } = await seed();
    await assert.rejects(
      getDb().transaction(async (tx) => {
        const genuine = await acquireMachineCreateLock(tx, server.id);
        // The attack from review: copy a genuine handle and substitute an executor that never took the lock.
        const forged = { ...(genuine as object), tx: getDb(), serverId: server.id } as unknown as MachineCreateLock;
        await registerMachine(server.id, actor.id, "spread-lock-machine", { machineCreateLock: forged });
      }),
      /not a machine create lock issued by acquireMachineCreateLock/,
    );
    assert.equal(await machineCount(server.id), 0, "zero Machines registered");
  });
}, TEST_TIMEOUT_MS);

/**
 * Regression for task #611, kept permanently because the original defect was invisible to every other assertion here.
 * `freezeAgentInserts` holds a TABLE lock on `agents`, so a sibling real-PG file's agent insert queues behind THIS
 * file's freeze as well. Matching a waiter on statement text plus blocking pid alone therefore selects the sibling
 * session, and the pid handed to the next wait belongs to a transaction this test never started.
 *
 * Both directions are asserted: the unscoped form must select the sibling session (so removing the
 * `application_name` condition fails precisely, rather than silently passing), and the scoped form must select only a
 * session belonging to this file.
 */
test("real PG: the lock waiter ignores a sibling file's insert queued behind the same table lock", async () => {
  await withRealPg(async (observer) => {
    const { creator, server } = await seedOrdered(true);

    // The observer pool and the app pool must BOTH be labelled, or the scoping silently excludes the real waiter.
    const appPoolName = await getDb().execute(sql`SELECT current_setting('application_name') AS app`);
    assert.equal((appPoolName.rows[0] as { app?: string } | undefined)?.app, APP_NAME, "the app pool session is labelled");
    const observerName = await observer.query<{ app: string }>("SELECT current_setting('application_name') AS app");
    assert.equal(observerName.rows[0]?.app, APP_NAME, "the observer session is labelled");

    const freeze = await freezeAgentInserts(observer);
    // A standalone Client, not a Pool: a pooled client checked out for a blocked statement keeps `pool.end()` waiting.
    const sibling = new pg.Client({ connectionString: REAL_PG_URL!, application_name: `${APP_NAME}-sibling` });
    await sibling.connect();
    let siblingInsert: Promise<unknown> = Promise.resolve();
    let create: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof createAgent>>>> | undefined;
    try {
      const siblingPid = (await sibling.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // Queue the sibling's insert FIRST, so it is the older waiter behind the freeze.
      siblingInsert = sibling.query(
        'insert into "agents" ("id", "server_id", "name") values ($1, $2, $3)',
        [randomUUID(), server.id, `sibling-${randomUUID().slice(0, 6)}`],
      ).catch(() => undefined);

      // NEGATIVE direction. Nothing here may depend on WHICH row the database returns (@skyzh, task #614): `LIMIT 1`
      // has no ORDER BY, and in the real 8-file batch several sibling files' inserts can be queued behind this
      // freeze at once, so asserting a specific foreign pid would make this very regression concurrency-dependent.
      // Membership is asserted over the full waiter SET, and the match is judged by OWNERSHIP, never identity.
      await waitForOwnWaiterAbsentWithForeignPresent(observer, freeze.pid, siblingPid);

      // POSITIVE direction: with the scope, only this file's own create is selected.
      create = trackSettled(fencedCreate(server.id, creator.id, "own-create"));
      const scoped = await waitForLockWaiter(observer, '%insert into "agents"%', freeze.pid);
      assert.notEqual(scoped, siblingPid, "the scoped waiter must not select the sibling session");
      const owner = await observer.query<{ app: string | null }>(
        "SELECT application_name AS app FROM pg_stat_activity WHERE pid = $1", [scoped]);
      assert.equal(owner.rows[0]?.app, APP_NAME, "the scoped waiter selected a session belonging to this file");
    } finally {
      await freeze.release();
      await siblingInsert.catch(() => undefined);
      await sibling.end().catch(() => undefined);

    }
    const settled = await Promise.allSettled([create!.tracked]);
    assert.equal(settled[0].status, "fulfilled", `the create still commits: ${describeTracked("create", create)}`);
  });
}, TEST_TIMEOUT_MS);
