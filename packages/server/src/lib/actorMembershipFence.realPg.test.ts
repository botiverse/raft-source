// Real-PostgreSQL proof for the actor membership fence (task #91, matrix v0.2 R02/R04 atomicity for
// DB authority writes). PGlite serializes transactions on one connection, so "removal waits for an
// in-flight write" can only be observed against a real multi-connection Postgres. Blocking is proven
// from pg_stat_activity lock waits, not from timing. Runtime command dispatch ordering is out of scope
// here and tracked as task #93.
//
// Failure hygiene: every test releases its gates and settles its pending work in `finally`, and lock
// waits are bounded well below the per-test timeout, so a broken fence fails with a named assertion
// instead of leaving a transaction open and hanging teardown.
//
// CI: `pnpm --filter @botiverse/raft-server test:actor-membership-fence-real-pg`; locally, a Postgres
// container plus ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { closeDatabase, getDb, initDatabase, type DatabaseTransaction } from "../db/index";
import { computers, machines, serverMembers, servers, users } from "../db/schema";
import { adoptLegacyMachineByFingerprint } from "../services/computerAdoptionService";
import { extractApiKeyFingerprint, registerMachine } from "../services/machineService";
import { removeMember, transitionMemberRole } from "../services/serverService";
import { resetServerSetup, ServerSetupStateError } from "../services/serverSetupStateService";
import { setComputerOwner } from "../services/computerOwnerService";
import { ServerMembershipRevokedError, withActorMembershipFence } from "./actorMembershipFence";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;

test("real PG: Computer owner rejects another server's locked machine without waiting on it", async () => {
  await withRealPg(async (observer) => {
    const own = await seed("member"), foreign = await seed("member");
    const [machine] = await getDb().insert(machines).values({
      serverId: foreign.server.id, userId: foreign.actor.id, name: "foreign-owner-scope",
      apiKeyHash: randomUUID(), runtimes: [],
    }).returning();
    assert(machine);
    const blocker = await observer.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM daemons WHERE id=$1 FOR UPDATE", [machine.id]);
      const result = await getDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
        return setComputerOwner({
          serverId: own.server.id, machineId: machine.id, actorUserId: own.actor.id, ownerUserId: null,
        });
      });
      assert.deepEqual(result, { ok: false, status: 404, code: "machine_not_found" });
      const [unchanged] = await getDb().select({ ownerUserId: machines.ownerUserId }).from(machines).where(eq(machines.id, machine.id));
      assert(unchanged);
      assert.equal(unchanged.ownerUserId, null);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });
}, TEST_TIMEOUT_MS);

test("real PG: Computer owner still waits on its own server's locked machine", async () => {
  await withRealPg(async (observer) => {
    const own = await seed("admin");
    const [machine] = await getDb().insert(machines).values({
      serverId: own.server.id, userId: own.actor.id, name: "own-owner-scope",
      apiKeyHash: randomUUID(), runtimes: [],
    }).returning();
    assert(machine);
    const blocker = await observer.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM daemons WHERE id=$1 FOR UPDATE", [machine.id]);
      await assert.rejects(getDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
        return setComputerOwner({
          serverId: own.server.id, machineId: machine.id, actorUserId: own.actor.id, ownerUserId: own.actor.id,
        });
      }), (error: unknown) => {
        const value = error as { code?: string; cause?: { code?: string } };
        return value.code === "55P03" || value.cause?.code === "55P03";
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    const result = await setComputerOwner({
      serverId: own.server.id, machineId: machine.id, actorUserId: own.actor.id, ownerUserId: own.actor.id,
    });
    assert(result.ok && result.changed, "the legitimate same-server transfer must still succeed after the lock releases");
  });
}, TEST_TIMEOUT_MS);

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

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `fence-${label}-${suffix}@raft.test`,
    name: `fence-${label}-${suffix}`,
    displayName: `fence-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner plus one acting human with `actorRole`, inserted directly (no product side effects). */
async function seed(actorRole: "admin" | "member") {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `fence-server-${suffix}`,
    slug: `fence-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: actor.id, role: actorRole },
  ]);
  return { owner, actor, server };
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

/**
 * Resolves once a backend running a statement matching `queryLike` waits on a lock held by `blockedBy`. Scoping the wait
 * to the blocking session keeps a concurrently running test (the probe step runs several real-PG files) from satisfying it.
 */
async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number) {
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

/**
 * Holds a fenced write open at `hold` after performing a harmless authority-scoped write that touches no
 * server/member row, so the test itself cannot create a lock cycle.
 */
async function openFencedWrite(serverId: string, userId: string, value: string) {
  const hold = gate();
  const entered = gate();
  let roleSeen: string | undefined;
  let pid = 0;
  const done = withActorMembershipFence(serverId, userId, async (tx: DatabaseTransaction, role) => {
    roleSeen = role;
    const backend = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    pid = (backend.rows[0] as { pid: number }).pid;
    await tx.execute(sql`UPDATE users SET display_name = ${value} WHERE id = ${userId}`);
    entered.release();
    await hold.opened;
  });
  // If the fence rejects before entering, surface that instead of waiting forever.
  await Promise.race([entered.opened, done]);
  return { hold, done, roleSeen: () => roleSeen, pid: () => pid };
}

async function displayName(userId: string) {
  const [row] = await getDb().select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  return row?.displayName;
}

async function membershipRole(serverId: string, userId: string) {
  const [row] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row?.role;
}

function trackSettled<T>(promise: Promise<T>) {
  const state = { settled: false };
  const tracked = promise.finally(() => { state.settled = true; });
  // Mark the rejection handled as soon as it exists. Tests await `tracked` only after releasing their own locks, and a
  // rejection that lands in between would otherwise be reported as unhandled even though the test later asserts on it.
  tracked.catch(() => undefined);
  return { tracked, state };
}

test("real PG: Server removal waits for an in-flight fenced write, which commits first", async () => {
  await withRealPg(async (observer) => {
    const { owner, actor, server } = await seed("member");
    const write = await openFencedWrite(server.id, actor.id, "written-while-member");
    const removal = trackSettled(removeMember(server.id, actor.id, { reason: "removed", actorUserId: owner.id }));
    try {
      // Task #101: removeMember takes the target's member row FOR UPDATE before any delete, so it waits there.
      await waitForLockWaiter(observer, "%from server_members%for update%", write.pid());
      assert.equal(removal.state.settled, false, "removal must be blocked by the fenced write's share lock");
    } finally {
      write.hold.release();
      await Promise.allSettled([write.done, removal.tracked]);
    }
    await write.done;
    await removal.tracked;
    assert.equal(write.roleSeen(), "member");
    assert.equal(await displayName(actor.id), "written-while-member", "the fenced write committed");
    assert.equal(await membershipRole(server.id, actor.id), undefined, "the removal committed after it");
  });
}, TEST_TIMEOUT_MS);

test("real PG: any role UPDATE on the actor's member row waits for an in-flight fenced write", async () => {
  // Protects the lock strength itself: a plain non-key UPDATE of `role` must conflict with the fence.
  // `FOR KEY SHARE` would let this UPDATE through; transitionMemberRole's own FOR UPDATE would not reveal that.
  await withRealPg(async (observer) => {
    const { actor, server } = await seed("admin");
    const write = await openFencedWrite(server.id, actor.id, "written-before-plain-role-update");
    const update = trackSettled(getDb().execute(
      sql`UPDATE server_members SET role = 'member' WHERE server_id = ${server.id} AND user_id = ${actor.id}`,
    ));
    try {
      await waitForLockWaiter(observer, "%update server_members set role%", write.pid());
      assert.equal(update.state.settled, false, "a plain role UPDATE must be blocked by the fenced write's share lock");
    } finally {
      write.hold.release();
      await Promise.allSettled([write.done, update.tracked]);
    }
    await write.done;
    await update.tracked;
    assert.equal(write.roleSeen(), "admin");
    assert.equal(await membershipRole(server.id, actor.id), "member");
  });
}, TEST_TIMEOUT_MS);

test("real PG: a role demotion through transitionMemberRole waits for an in-flight fenced write", async () => {
  await withRealPg(async (observer) => {
    const { owner, actor, server } = await seed("admin");
    const write = await openFencedWrite(server.id, actor.id, "written-while-admin");
    const demotion = trackSettled(transitionMemberRole({
      serverId: server.id,
      actorUserId: owner.id,
      targetUserId: actor.id,
      nextRole: "member",
    }));
    try {
      await waitForLockWaiter(observer, '%from "server_members"%for update%', write.pid());
      assert.equal(demotion.state.settled, false, "role transition must be blocked by the fenced write's share lock");
    } finally {
      write.hold.release();
      await Promise.allSettled([write.done, demotion.tracked]);
    }
    await write.done;
    const result = await demotion.tracked;
    assert.equal(write.roleSeen(), "admin", "the write was authorized under the pre-demotion role");
    assert.equal(result.nextRole, "member");
    assert.equal(await displayName(actor.id), "written-while-admin");
    assert.equal(await membershipRole(server.id, actor.id), "member");
  });
}, TEST_TIMEOUT_MS);

test("real PG: once removal commits first, the fenced write is refused and runs nothing", async () => {
  await withRealPg(async () => {
    const { owner, actor, server } = await seed("member");
    await removeMember(server.id, actor.id, { reason: "removed", actorUserId: owner.id });

    let ran = false;
    await assert.rejects(
      withActorMembershipFence(server.id, actor.id, async (tx) => {
        ran = true;
        await tx.execute(sql`UPDATE users SET display_name = 'must-not-commit' WHERE id = ${actor.id}`);
      }),
      (error: unknown) => error instanceof ServerMembershipRevokedError && error.message === "Not a member of this server",
    );
    assert.equal(ran, false);
    assert.notEqual(await displayName(actor.id), "must-not-commit");
  });
}, TEST_TIMEOUT_MS);

test("real PG: setup reset waits for an in-flight owner removal and, once it commits, revokes no Computers", async () => {
  // Removal-vs-reset atomicity for the confirmed setup-reset gap: reset must lock the actor's owner member row
  // FOR UPDATE, so an uncommitted removal makes it wait and the committed removal makes it refuse.
  await withRealPg(async (observer) => {
    const { owner, actor, server } = await seed("member");
    await getDb().update(serverMembers).set({ role: "owner", setupStatus: "in_progress" })
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
    await getDb().update(serverMembers).set({ role: "owner" })
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, actor.id)));
    await getDb().insert(computers).values({
      serverId: server.id,
      name: "fence-reset-laptop",
      apiKeyHash: "argon2-placeholder",
      apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
    });

    // The primary owner (servers.ownerId) is removed by another owner in a transaction that has not committed yet.
    const removal = await observer.connect();
    let reset: ReturnType<typeof trackSettled<{ revokedComputers: number }>> | undefined;
    try {
      await removal.query("BEGIN");
      const removalPid = await backendPid(removal);
      await removal.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [server.id, owner.id]);
      reset = trackSettled(resetServerSetup({ serverId: server.id, actor: { type: "user", id: owner.id } }));
      await waitForLockWaiter(observer, "%from server_members%for update%", removalPid);
      assert.equal(reset.state.settled, false, "reset must wait for the uncommitted removal of its owner row");
      await removal.query("COMMIT");
    } finally {
      await removal.query("ROLLBACK").catch(() => undefined);
      removal.release();
      if (reset) await Promise.allSettled([reset.tracked]);
    }
    await assert.rejects(
      reset!.tracked,
      (error: unknown) => error instanceof ServerSetupStateError && error.code === "INSUFFICIENT_PERMISSION",
    );
    const revoked = await getDb().select({ id: computers.id }).from(computers)
      .where(and(eq(computers.serverId, server.id), isNotNull(computers.revokedAt)));
    assert.equal(revoked.length, 0, "a reset that lost the race revokes no Computers");
  });
}, TEST_TIMEOUT_MS);

test("real PG: legacy Computer adoption waits for an in-flight removal and, once it commits, adopts nothing", async () => {
  // adopt-legacy passes its fast membership pre-check against the still-visible member row, then its fenced transaction
  // must wait on the uncommitted removal and observe it: zero Computer rows and the legacy machine left unmigrated.
  await withRealPg(async (observer) => {
    const { actor, server } = await seed("member");
    const { machine, apiKey } = await registerMachine(server.id, actor.id, "fence-legacy-daemon");

    const removal = await observer.connect();
    let adoption: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof adoptLegacyMachineByFingerprint>>>> | undefined;
    try {
      await removal.query("BEGIN");
      const removalPid = await backendPid(removal);
      await removal.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [server.id, actor.id]);
      adoption = trackSettled(adoptLegacyMachineByFingerprint({
        userId: actor.id,
        serverSlug: server.slug,
        legacyMachineId: machine.id,
        apiKeyFingerprint: extractApiKeyFingerprint(apiKey),
      }));
      await waitForLockWaiter(observer, "%from server_members%for share%", removalPid);
      assert.equal(adoption.state.settled, false, "adoption must wait for the uncommitted removal of its member row");
      await removal.query("COMMIT");
    } finally {
      await removal.query("ROLLBACK").catch(() => undefined);
      removal.release();
      if (adoption) await Promise.allSettled([adoption.tracked]);
    }
    assert.deepEqual(await adoption!.tracked, { ok: false, code: "not_authorized" });
    const adopted = await getDb().select({ id: computers.id }).from(computers).where(eq(computers.machineId, machine.id));
    assert.equal(adopted.length, 0, "an adoption that lost the race creates no Computer attachment");
    const [legacy] = await getDb().select({ migratedAt: machines.legacyKeyMigratedAt }).from(machines).where(eq(machines.id, machine.id));
    assert.equal(legacy.migratedAt, null, "the legacy machine is left unmigrated");
  });
}, TEST_TIMEOUT_MS);

test("real PG: concurrent fenced writes by the same actor do not block each other", async () => {
  await withRealPg(async () => {
    const { actor, server } = await seed("member");
    const first = await openFencedWrite(server.id, actor.id, "first-writer");
    // The second writer only takes the member share lock (no row write of its own): the first writer's
    // uncommitted `users` update would otherwise make it wait on that row and hide what is being measured.
    const second = trackSettled(withActorMembershipFence(server.id, actor.id, async (tx) => {
      await tx.execute(sql`SELECT 1`);
    }));
    let outcome: "completed" | "blocked";
    try {
      // The second share lock must be granted while the first is still held.
      outcome = await Promise.race([
        second.tracked.then(() => "completed" as const, () => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), LOCK_WAIT_TIMEOUT_MS)),
      ]);
    } finally {
      first.hold.release();
      await Promise.allSettled([first.done, second.tracked]);
    }
    await first.done;
    await second.tracked;
    assert.equal(outcome, "completed", "a second share holder must not wait for the first");
  });
}, TEST_TIMEOUT_MS);
