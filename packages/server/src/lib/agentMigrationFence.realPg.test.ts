// Real-PostgreSQL proof for task #93 line C: human-initiated agent migration writes (migrate, cancel, auto-start
// completion) re-authorize the acting human under row locks inside the write transaction, so a removal or demotion that
// commits first leaves zero migration state change. PGlite serializes transactions, so the ordering can only be observed
// against a real multi-connection Postgres. Blocking is proven from pg_stat_activity lock waits.
//
// Lock order under test (agentMigrationService.lockAgentMigrationActorAuthority): `servers` FOR SHARE, then the actor's
// `server_members` row FOR SHARE, then the Agent row FOR UPDATE, then the write's own rows. Every migration write inserts
// rows whose foreign key references `servers`; without the `servers` lock first, a role transition (servers FOR UPDATE,
// then member rows) deadlocks with the write.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the #91a and line G fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import type { ServerRole } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agentMigrations, agents, channels, machines, serverMembers, servers, users } from "../db/schema";
import {
  agentMigrationGeneration,
  beginAgentMigrationProvisioning,
  completeAgentMigrationAutoStart,
  markAgentMigrationTargetImportArrived,
  recordAgentMigrationSourceWorkspaceArchived,
  requestAgentMigrationCancellation,
  type AgentMigrationActorFence,
} from "../services/agentMigrationService";
import { beginArrivingTestAgentMigration, beginTestAgentMigration } from "../test/agentMigrationFixture";
import { transitionMemberRole } from "../services/serverService";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError } from "./actorMembershipFence";

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const MEMBER_ROW_WAIT = "%from server_members%for share%";
const SERVERS_ROW_WAIT = "%from servers%for share%";

const TRANSFER_SUMMARY = {
  includedFileCount: 1,
  includedBytes: 64,
  excludedRegenerableCount: 0,
  excludedRegenerableByCategory: { thirdPartyDependencies: 0, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
  keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
};

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
    email: `migration-fence-${label}-${suffix}@raft.test`,
    name: `migration-fence-${label}-${suffix}`,
    displayName: `migration-fence-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/**
 * Owner, one actor with `actorRole`, two Computers and an Agent on the source Computer. With `actorIsCreator` the Agent
 * is the actor's own, so the creator branch of the authority rule applies.
 */
async function seed(actorRole: ServerRole, actorIsCreator = false) {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `migration-fence-server-${suffix}`,
    slug: `migration-fence-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: actor.id, role: actorRole },
  ]);
  const [sourceMachine, targetMachine] = await getDb().insert(machines).values([
    { serverId: server.id, userId: owner.id, name: `source-${suffix}`, apiKeyHash: `source-${suffix}` },
    { serverId: server.id, userId: owner.id, name: `target-${suffix}`, apiKeyHash: `target-${suffix}` },
  ]).returning();
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: `migration-fence-agent-${suffix}`,
    status: "active",
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
    machineId: sourceMachine!.id,
    creatorType: actorIsCreator ? "user" : null,
    creatorId: actorIsCreator ? actor.id : null,
  }).returning();
  return { owner, actor, server, sourceMachine: sourceMachine!, targetMachine: targetMachine!, agent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** An in-transit migration the actor can cancel. */
async function seedInTransit(seeded: Seeded) {
  const provisioned = await beginAgentMigrationProvisioning({
    agentId: seeded.agent.id,
    targetMachineId: seeded.targetMachine.id,
    initiatedByUserId: seeded.owner.id,
    transportSessionId: `fence-session-${randomUUID().slice(0, 8)}`,
  });
  const [migration] = await getDb().update(agentMigrations)
    .set({ state: "in_transit", transportGeneration: `fence-generation-${randomUUID().slice(0, 8)}` })
    .where(eq(agentMigrations.id, provisioned.migration.id))
    .returning();
  return migration!;
}

/** A migration that arrived on the target and waits for its auto-start completion. */
async function seedStarting(seeded: Seeded) {
  const now = new Date();
  const arriving = await beginArrivingTestAgentMigration({
    agentId: seeded.agent.id,
    targetMachineId: seeded.targetMachine.id,
    initiatedByUserId: seeded.owner.id,
    now,
  }, { transferSummary: TRANSFER_SUMMARY });
  const archived = await recordAgentMigrationSourceWorkspaceArchived({
    migrationId: arriving.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: seeded.server.id,
    targetMachineId: seeded.targetMachine.id,
    now,
  });
  const arrival = await markAgentMigrationTargetImportArrived({
    migrationId: arriving.id,
    migrationGeneration: archived.migrationGeneration,
    serverId: seeded.server.id,
    targetMachineId: seeded.targetMachine.id,
    now,
  });
  assert.equal(arrival.migration.state, "starting");
  const [row] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  return row!;
}

function isDeadlock(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "40P01" || code?.cause?.code === "40P01";
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
}

/**
 * Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`, and returns its pid. Scoping the wait to
 * the blocking session keeps a concurrently running test (the probe step runs several real-PG files) from satisfying it.
 */
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
  // Mark the rejection handled at creation; the test awaits it only after releasing its own connection.
  tracked.catch(() => undefined);
  return { tracked, state };
}

/** Holds `prepare`'s uncommitted change in a session, requires `write` to wait on `queryLike`, then commits. */
async function raceWriteAgainst<T>(
  observer: pg.Pool,
  queryLike: string,
  prepare: (session: pg.PoolClient) => Promise<void>,
  write: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const session = await observer.connect();
  let started: ReturnType<typeof trackSettled<T>> | undefined;
  try {
    await session.query("BEGIN");
    const blocker = await backendPid(session);
    await prepare(session);
    started = trackSettled(write());
    await waitForLockWaiter(observer, queryLike, blocker);
    assert.equal(started.state.settled, false, "the migration write must wait for the uncommitted membership change");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  const [outcome] = await Promise.allSettled([started!.tracked]);
  return outcome;
}

type MembershipChange = "removal" | "demotion" | "demotion in transitionMemberRole's lock order";

/**
 * The uncommitted change, and the lock the fenced write must be seen waiting on while it is held. A demotion to Guest
 * binds the actor to `guestChannelId`, as every Guest is bound to its one channel (#wg-rbac:#15).
 */
function membershipChange(change: MembershipChange, seeded: Seeded, demotedRole: ServerRole, guestChannelId: string | null = null) {
  const { server, actor } = seeded;
  if (change === "removal") {
    return {
      waitsOn: MEMBER_ROW_WAIT,
      prepare: async (session: pg.PoolClient) => {
        await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [server.id, actor.id]);
      },
    };
  }
  if (change === "demotion") {
    return {
      waitsOn: MEMBER_ROW_WAIT,
      prepare: async (session: pg.PoolClient) => {
        await session.query("UPDATE server_members SET role = $3, guest_channel_id = $4 WHERE server_id = $1 AND user_id = $2", [server.id, actor.id, demotedRole, guestChannelId]);
      },
    };
  }
  return {
    // transitionMemberRole locks `servers` FOR UPDATE before the member rows, so the fenced write waits on `servers`.
    waitsOn: SERVERS_ROW_WAIT,
    prepare: async (session: pg.PoolClient) => {
      await session.query("SELECT id FROM servers WHERE id = $1 FOR UPDATE", [server.id]);
      await session.query("UPDATE server_members SET role = $3, guest_channel_id = $4 WHERE server_id = $1 AND user_id = $2", [server.id, actor.id, demotedRole, guestChannelId]);
    },
  };
}

function assertRefused(outcome: PromiseSettledResult<unknown>, change: MembershipChange) {
  assert.equal(outcome.status, "rejected", `the write must be refused after the ${change} commits`);
  const reason = (outcome as PromiseRejectedResult).reason;
  if (change === "removal") {
    assert.ok(reason instanceof ServerMembershipRevokedError, `unexpected refusal: ${String(reason)}`);
  } else {
    assert.ok(reason instanceof FencedAuthorizationDeniedError, `unexpected refusal: ${String(reason)}`);
    assert.equal(reason.reason, "forbidden");
  }
}

async function migrationRowsForAgent(observer: pg.Pool, agentId: string) {
  const { rows } = await observer.query<{ migrations: number; receipt_channels: number; outbox: number }>(`
    SELECT
      (SELECT count(*)::int FROM agent_migrations WHERE agent_id = $1) AS migrations,
      (SELECT count(*)::int FROM agent_migration_receipt_channels WHERE agent_id = $1) AS receipt_channels,
      (SELECT count(*)::int FROM agent_migration_receipt_outbox WHERE agent_id = $1) AS outbox
  `, [agentId]);
  return rows[0];
}

async function migrationSnapshot(observer: pg.Pool, migrationId: string, agentId: string) {
  const { rows } = await observer.query(
    `SELECT state, revision, cancel_requested_at, completed_at FROM agent_migrations WHERE id = $1`,
    [migrationId],
  );
  return { row: rows[0], counts: await migrationRowsForAgent(observer, agentId) };
}

const fenceFor = (seeded: Seeded, capability: AgentMigrationActorFence["capability"]): AgentMigrationActorFence => ({
  serverId: seeded.server.id,
  userId: seeded.actor.id,
  capability,
});

const CHANGES = ["removal", "demotion", "demotion in transitionMemberRole's lock order"] as const;

for (const change of CHANGES) {
  test(`real PG: migrate waits for an in-flight ${change} of the initiator and, once it commits, creates no migration`, async () => {
    await withRealPg(async (observer) => {
      const seeded = await seed("admin");
      const before = await migrationRowsForAgent(observer, seeded.agent.id);
      const { waitsOn, prepare } = membershipChange(change, seeded, "member");
      const outcome = await raceWriteAgainst(observer, waitsOn, prepare, () => beginTestAgentMigration({
        agentId: seeded.agent.id,
        targetMachineId: seeded.targetMachine.id,
        initiatedByUserId: seeded.actor.id,
        actorFence: fenceFor(seeded, "migrateAgents"),
      }));
      assertRefused(outcome, change);
      assert.deepEqual(await migrationRowsForAgent(observer, seeded.agent.id), before, "zero migration rows, receipt channels or receipts");
    });
  }, TEST_TIMEOUT_MS);

  test(`real PG: cancel waits for an in-flight ${change} of the canceller and, once it commits, changes nothing`, async () => {
    await withRealPg(async (observer) => {
      const seeded = await seed("admin");
      const migration = await seedInTransit(seeded);
      const before = await migrationSnapshot(observer, migration.id, seeded.agent.id);
      const { waitsOn, prepare } = membershipChange(change, seeded, "member");
      const outcome = await raceWriteAgainst(observer, waitsOn, prepare, () => requestAgentMigrationCancellation({
        agentId: seeded.agent.id,
        migrationRef: migration.supportRef,
        expectedRevision: migration.revision,
        initiatedByUserId: seeded.actor.id,
        reason: "fence-test",
        actorFence: fenceFor(seeded, "migrateAgents"),
      }));
      assertRefused(outcome, change);
      assert.deepEqual(await migrationSnapshot(observer, migration.id, seeded.agent.id), before, "migration state, revision and receipts unchanged");
    });
  }, TEST_TIMEOUT_MS);

  test(`real PG: auto-start completion waits for an in-flight ${change} of the starter and, once it commits, changes nothing`, async () => {
    await withRealPg(async (observer) => {
      // Members hold controlAgentRuntime; only guests lose it.
      const seeded = await seed("member");
      const [guestHome] = await getDb().insert(channels).values({ serverId: seeded.server.id, name: `guest-home-${randomUUID().slice(0, 8)}`, type: "private" }).returning();
      const migration = await seedStarting(seeded);
      const before = await migrationSnapshot(observer, migration.id, seeded.agent.id);
      const { waitsOn, prepare } = membershipChange(change, seeded, "guest", guestHome!.id);
      const outcome = await raceWriteAgainst(observer, waitsOn, prepare, () => completeAgentMigrationAutoStart({
        migrationId: migration.id,
        agentId: seeded.agent.id,
        targetMachineId: seeded.targetMachine.id,
        actorFence: fenceFor(seeded, "controlAgentRuntime"),
      }));
      assertRefused(outcome, change);
      assert.deepEqual(await migrationSnapshot(observer, migration.id, seeded.agent.id), before, "migration still starting, no completed receipt");
    });
  }, TEST_TIMEOUT_MS);
}

test("real PG: a removed creator cannot migrate their own Agent through the creator rule", async () => {
  await withRealPg(async (observer) => {
    // A member holds no migrateAgents; the creator branch alone authorized the request-level check.
    const seeded = await seed("member", true);
    const { waitsOn, prepare } = membershipChange("removal", seeded, "member");
    const outcome = await raceWriteAgainst(observer, waitsOn, prepare, () => beginTestAgentMigration({
      agentId: seeded.agent.id,
      targetMachineId: seeded.targetMachine.id,
      initiatedByUserId: seeded.actor.id,
      actorFence: fenceFor(seeded, "migrateAgents"),
    }));
    assertRefused(outcome, "removal");
    assert.equal((await migrationRowsForAgent(observer, seeded.agent.id)).migrations, 0, "zero migrations");
  });
}, TEST_TIMEOUT_MS);

/**
 * Freezes the write after its fence locks by holding a SHARE lock on `agent_migrations` (its next INSERT or UPDATE needs
 * ROW EXCLUSIVE), queues an owner-driven transitionMemberRole behind the frozen write, then releases. With `servers`
 * locked first the transition queues on `servers` and both finish; without it the transition queues on the actor's member
 * row while holding `servers`, and the write's foreign-key check on `servers` deadlocks (40P01) once released.
 */
async function writeFirstAgainstTransition<T>(
  observer: pg.Pool,
  seeded: Seeded,
  nextRole: ServerRole,
  frozenWriteLike: string,
  write: () => Promise<T>,
) {
  const freeze = await observer.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await freeze.query("COMMIT").catch(() => undefined);
    freeze.release();
  };
  let writeRun: ReturnType<typeof trackSettled<T>> | undefined;
  let transitionRun: ReturnType<typeof trackSettled<unknown>> | undefined;
  try {
    await freeze.query("BEGIN");
    const freezePid = await backendPid(freeze);
    await freeze.query("LOCK TABLE agent_migrations IN SHARE MODE");
    writeRun = trackSettled(write());
    const writePid = await waitForLockWaiter(observer, frozenWriteLike, freezePid);
    transitionRun = trackSettled(transitionMemberRole({
      serverId: seeded.server.id,
      actorUserId: seeded.owner.id,
      targetUserId: seeded.actor.id,
      nextRole,
    }));
    // Behind the frozen write on `servers` (this order) or on the actor's member row (an order without the `servers` lock).
    await waitForLockWaiter(observer, "%for update%", writePid);
    assert.equal(transitionRun.state.settled, false, "the role transition must wait for the frozen migration write");
    await release();
  } finally {
    await release();
  }
  const [writeOutcome, transitionOutcome] = await Promise.allSettled([writeRun!.tracked, transitionRun!.tracked]);
  for (const outcome of [writeOutcome, transitionOutcome]) {
    if (outcome.status === "rejected") {
      assert.equal(isDeadlock(outcome.reason), false, "the migration write and the role transition must not deadlock");
      assert.fail(`unexpected failure: ${String(outcome.reason)}`);
    }
  }
  const [member] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(eq(serverMembers.userId, seeded.actor.id));
  assert.equal(member?.role, nextRole, "the role transition commits after the write");
}

test("real PG: cancel vs a writer in the migration service's order (agents, then agent_migrations) does not deadlock", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed("admin");
    const migration = await seedInTransit(seeded);
    // Statement order of flipAgentMigrationMachine / abort / arrival: UPDATE agents, then UPDATE agent_migrations.
    const writer = await observer.connect();
    let cancelRun: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      await writer.query("BEGIN");
      const writerPid = await backendPid(writer);
      await writer.query("UPDATE agents SET updated_at = now() WHERE id = $1", [seeded.agent.id]);
      cancelRun = trackSettled(requestAgentMigrationCancellation({
        agentId: seeded.agent.id,
        migrationRef: migration.supportRef,
        expectedRevision: migration.revision,
        initiatedByUserId: seeded.actor.id,
        reason: "fence-test",
        actorFence: fenceFor(seeded, "migrateAgents"),
      }));
      // The cancel takes the Agent row before its migration row, so it queues behind the writer holding nothing the
      // writer needs next.
      await waitForLockWaiter(observer, "%from \"agents\"%for update%", writerPid);
      await writer.query("UPDATE agent_migrations SET revision = revision + 1, updated_at = now() WHERE id = $1", [migration.id]);
      await writer.query("COMMIT");
    } catch (error) {
      assert.equal(isDeadlock(error), false, "the migration-order writer must not deadlock with the cancel");
      throw error;
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
    const [outcome] = await Promise.allSettled([cancelRun!.tracked]);
    if (outcome.status === "rejected") {
      assert.equal(isDeadlock(outcome.reason), false, "the cancel must not deadlock with the migration-order writer");
      // The writer bumped the revision first, so the cancel reports the stale revision instead of writing.
      assert.equal((outcome.reason as Error).message, "MIGRATION_REVISION_STALE");
    } else {
      assert.fail("the cancel must observe the writer's committed revision bump");
    }
  });
}, TEST_TIMEOUT_MS);

test("real PG: migrate first vs an owner-driven transitionMemberRole — no deadlock, migration created, role change after", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed("admin");
    await writeFirstAgainstTransition(observer, seeded, "member", "%insert into \"agent_migrations\"%", () => beginTestAgentMigration({
      agentId: seeded.agent.id,
      targetMachineId: seeded.targetMachine.id,
      initiatedByUserId: seeded.actor.id,
      actorFence: fenceFor(seeded, "migrateAgents"),
    }));
    assert.equal((await migrationRowsForAgent(observer, seeded.agent.id)).migrations, 1);
  });
}, TEST_TIMEOUT_MS);

test("real PG: cancel first vs an owner-driven transitionMemberRole — no deadlock, cancellation recorded, role change after", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed("admin");
    const migration = await seedInTransit(seeded);
    await writeFirstAgainstTransition(observer, seeded, "member", "%update \"agent_migrations\"%", () => requestAgentMigrationCancellation({
      agentId: seeded.agent.id,
      migrationRef: migration.supportRef,
      expectedRevision: migration.revision,
      initiatedByUserId: seeded.actor.id,
      reason: "fence-test",
      actorFence: fenceFor(seeded, "migrateAgents"),
    }));
    const after = await migrationSnapshot(observer, migration.id, seeded.agent.id);
    assert.ok(after.row.cancel_requested_at, "the cancellation committed");
  });
}, TEST_TIMEOUT_MS);

test("real PG: completion first vs an owner-driven transitionMemberRole — no deadlock, migration completed, role change after", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed("member");
    const migration = await seedStarting(seeded);
    // A promotion takes the same locks as a demotion (servers FOR UPDATE, then member rows) and keeps controlAgentRuntime.
    await writeFirstAgainstTransition(observer, seeded, "admin", "%update \"agent_migrations\"%", () => completeAgentMigrationAutoStart({
      migrationId: migration.id,
      agentId: seeded.agent.id,
      targetMachineId: seeded.targetMachine.id,
      actorFence: fenceFor(seeded, "controlAgentRuntime"),
    }));
    const after = await migrationSnapshot(observer, migration.id, seeded.agent.id);
    assert.equal(after.row.state, "completed");
  });
}, TEST_TIMEOUT_MS);
