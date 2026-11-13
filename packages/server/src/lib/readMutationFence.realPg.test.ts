// Real-PostgreSQL proof for task #93 line B admission: the read-state sequencer's admission fence and servers-first
// lock order.
//
// Admission takes `servers` FOR SHARE, then the acting principal's membership row FOR SHARE, before the authority row,
// so a removal or demotion that commits first leaves zero command rows. Admission, apply and frontier take `servers`
// first, so holding a member row and then inserting a row whose foreign key references `servers` (the authority row,
// read_mutations) serializes with transitionMemberRole instead of deadlocking. Each race is held at a known point by
// a session holding a lock, and every wait is attributed to its blocking backend (pg_blocking_pids).
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import type { ServerRole } from "@botiverse/raft-shared";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import {
  agents,
  channelHumans,
  channels,
  inboxNotificationFacts,
  readMutationAuthorities,
  readMutations,
  serverAgentMembers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { createMessage } from "../services/messageService";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
  getReadMutationFrontier,
  type ReadMutationPayload,
} from "../services/readMutationSequencer";
import { transitionMemberRole } from "../services/serverService";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError } from "./actorMembershipFence";

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

async function backendPid(client: pg.PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0].pid;
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
  // Mark the rejection handled at creation; the test awaits it only after releasing its own connection.
  tracked.catch(() => undefined);
  return { tracked, state };
}

function isDeadlock(error: unknown) {
  const code = (error as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "40P01" || code?.cause?.code === "40P01";
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `read-fence-${label}-${suffix}@raft.test`,
    name: `read-fence-${label}-${suffix}`,
    displayName: `read-fence-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/** Owner, one human actor with `actorRole`, a public channel with two messages, and an agent in the Server. */
async function seed(actorRole: ServerRole = "member") {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `read-fence-server-${suffix}`,
    slug: `read-fence-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: actor.id, role: actorRole },
  ]);
  const [channel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `read-fence-channel-${suffix}`,
    type: "channel",
  }).returning();
  await getDb().insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id, role: "admin" },
    { channelId: channel.id, userId: actor.id },
  ]);
  await createMessage(channel.id, "user", owner.id, "read-fence first");
  const latest = await createMessage(channel.id, "user", owner.id, "read-fence latest");
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: `read-fence-agent-${suffix}`,
    status: "active",
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
  }).returning();
  await getDb().insert(serverAgentMembers).values({ serverId: server.id, agentId: agent.id });
  return { owner, actor, server, channel, latest, agent };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function commandRows(serverId: string, principalId: string) {
  const mutations = await getDb().select({ id: readMutations.mutationId }).from(readMutations)
    .where(and(eq(readMutations.serverId, serverId), eq(readMutations.principalId, principalId)));
  const authorities = await getDb().select({ id: readMutationAuthorities.principalId }).from(readMutationAuthorities)
    .where(and(eq(readMutationAuthorities.serverId, serverId), eq(readMutationAuthorities.principalId, principalId)));
  return { mutations: mutations.length, authorities: authorities.length };
}

/** Holds `prepare`'s uncommitted change in a session, requires `write` to wait on `queryLike` behind it, then commits. */
async function raceAgainst<T>(
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
    assert.equal(started.state.settled, false, "the fenced write must wait for the uncommitted change");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  const [outcome] = await Promise.allSettled([started!.tracked]);
  return outcome;
}

function payloadFor(kind: "channel_read_all" | "row_read" | "global_read_all", seeded: Seeded): ReadMutationPayload {
  if (kind === "channel_read_all") return { kind, scopeId: seeded.channel.id };
  if (kind === "row_read") return { kind, scopeId: seeded.channel.id, throughSeq: Number(seeded.latest.seq) };
  return { kind };
}

for (const kind of ["channel_read_all", "row_read", "global_read_all"] as const) {
  test(`real PG: ${kind} admission waits for an in-flight removal of the human and, once it commits, writes no command rows`, async () => {
    await withRealPg(async (observer) => {
      const seeded = await seed();
      const outcome = await raceAgainst(observer, "%from server_members%for share%", async (session) => {
        await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.actor.id]);
      }, () => admitReadMutation({
        serverId: seeded.server.id,
        principalId: seeded.actor.id,
        mutationId: randomUUID(),
        mutation: payloadFor(kind, seeded),
      }));
      assert.equal(outcome.status, "rejected", "the admission is refused");
      const reason = (outcome as PromiseRejectedResult).reason;
      assert.ok(reason instanceof ServerMembershipRevokedError, `unexpected refusal: ${String(reason)}`);
      assert.deepEqual(await commandRows(seeded.server.id, seeded.actor.id), { mutations: 0, authorities: 0 });
    });
  }, TEST_TIMEOUT_MS);
}

test("real PG: agent-receiver admission waits for an in-flight removal of the delegating human and writes no command rows", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed("admin");
    const outcome = await raceAgainst(observer, "%from server_members%for share%", async (session) => {
      await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.actor.id]);
    }, () => admitReadMutation({
      serverId: seeded.server.id,
      principalKind: "agent",
      principalId: seeded.agent.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: seeded.channel.id },
      actor: { kind: "human", userId: seeded.actor.id },
    }));
    assert.equal(outcome.status, "rejected");
    assert.ok((outcome as PromiseRejectedResult).reason instanceof ServerMembershipRevokedError,
      `unexpected refusal: ${String((outcome as PromiseRejectedResult).reason)}`);
    assert.deepEqual(await commandRows(seeded.server.id, seeded.agent.id), { mutations: 0, authorities: 0 });
  });
}, TEST_TIMEOUT_MS);

test("real PG: agent-receiver admission re-checks delegation on the locked role — an in-flight demotion commits first and admission is refused", async () => {
  await withRealPg(async (observer) => {
    // An admin holds editAgents; a member does not, and the agent has no human creator.
    const seeded = await seed("admin");
    const outcome = await raceAgainst(observer, "%from server_members%for share%", async (session) => {
      await session.query("UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.actor.id]);
    }, () => admitReadMutation({
      serverId: seeded.server.id,
      principalKind: "agent",
      principalId: seeded.agent.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: seeded.channel.id },
      actor: { kind: "human", userId: seeded.actor.id },
    }));
    assert.equal(outcome.status, "rejected");
    const reason = (outcome as PromiseRejectedResult).reason;
    assert.ok(reason instanceof FencedAuthorizationDeniedError && reason.reason === "forbidden", `unexpected refusal: ${String(reason)}`);
    assert.deepEqual(await commandRows(seeded.server.id, seeded.agent.id), { mutations: 0, authorities: 0 });
  });
}, TEST_TIMEOUT_MS);

test("real PG: an agent reading for itself waits for an in-flight removal of its Server membership and writes no command rows", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const outcome = await raceAgainst(observer, "%from server_agent_members%for share%", async (session) => {
      await session.query("DELETE FROM server_agent_members WHERE server_id = $1 AND agent_id = $2", [seeded.server.id, seeded.agent.id]);
    }, () => admitReadMutation({
      serverId: seeded.server.id,
      principalKind: "agent",
      principalId: seeded.agent.id,
      mutationId: randomUUID(),
      mutation: { kind: "row_read", scopeId: seeded.channel.id, throughSeq: Number(seeded.latest.seq) },
    }));
    assert.equal(outcome.status, "rejected");
    const reason = (outcome as PromiseRejectedResult).reason;
    assert.ok(reason instanceof FencedAuthorizationDeniedError && reason.reason === "not_found", `unexpected refusal: ${String(reason)}`);
    assert.deepEqual(await commandRows(seeded.server.id, seeded.agent.id), { mutations: 0, authorities: 0 });
  });
}, TEST_TIMEOUT_MS);

/**
 * Freezes `write` behind a SHARE lock on `table` (its next INSERT/UPDATE/DELETE there needs ROW EXCLUSIVE), queues an
 * owner-driven transitionMemberRole on the actor behind the frozen write, then releases. With `servers` locked first
 * the transition queues on `servers` and both finish; without it the transition queues on the member row while holding
 * `servers`, and the write's foreign-key check on `servers` deadlocks once released.
 */
async function writeFirstAgainstTransition<T>(
  observer: pg.Pool,
  seeded: Seeded,
  table: string,
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
    await freeze.query(`LOCK TABLE ${table} IN SHARE MODE`);
    writeRun = trackSettled(write());
    const writePid = await waitForLockWaiter(observer, frozenWriteLike, freezePid);
    transitionRun = trackSettled(transitionMemberRole({
      serverId: seeded.server.id,
      actorUserId: seeded.owner.id,
      targetUserId: seeded.actor.id,
      nextRole: "admin",
    }));
    // Behind the frozen write on `servers` (this order) or on the actor's member row (an order without the servers lock).
    await waitForLockWaiter(observer, "%for update%", writePid);
    assert.equal(transitionRun.state.settled, false, "the role transition must wait for the frozen write");
    await release();
  } finally {
    await release();
  }
  const [writeOutcome, transitionOutcome] = await Promise.allSettled([writeRun!.tracked, transitionRun!.tracked]);
  for (const outcome of [writeOutcome, transitionOutcome]) {
    if (outcome.status === "rejected") {
      assert.equal(isDeadlock(outcome.reason), false, "the sequencer write and the role transition must not deadlock");
      assert.fail(`unexpected failure: ${String(outcome.reason)}`);
    }
  }
  const [member] = await getDb().select({ role: serverMembers.role }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, seeded.server.id), eq(serverMembers.userId, seeded.actor.id)));
  assert.equal(member?.role, "admin", "the role transition commits after the write");
  return writeOutcome as PromiseFulfilledResult<T>;
}

test("real PG: admission first vs an owner-driven transitionMemberRole — no deadlock, command admitted, role change after", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    await writeFirstAgainstTransition(observer, seeded, "read_mutation_authorities", "%insert into \"read_mutation_authorities\"%", () => admitReadMutation({
      serverId: seeded.server.id,
      principalId: seeded.actor.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: seeded.channel.id },
    }));
    assert.deepEqual(await commandRows(seeded.server.id, seeded.actor.id), { mutations: 1, authorities: 1 });
  });
}, TEST_TIMEOUT_MS);

test("real PG: apply first vs an owner-driven transitionMemberRole — no deadlock, mutation applied, role change after", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    // A notification fact gives apply real read-state work; the race anchors on
    // apply's terminal read_mutations update (2026-09-21: the serving-rows
    // rebuild upsert this race originally anchored on was retired).
    await getDb().insert(inboxNotificationFacts).values({
      receiverType: "user",
      receiverId: seeded.actor.id,
      serverId: seeded.server.id,
      kind: "channel",
      sourceChannelId: seeded.channel.id,
      messageId: seeded.latest.id,
      messageSeq: Number(seeded.latest.seq),
      activityAt: new Date(),
    });
    await admitReadMutation({
      serverId: seeded.server.id,
      principalId: seeded.actor.id,
      mutationId: randomUUID(),
      mutation: { kind: "channel_read_all", scopeId: seeded.channel.id },
    });
    const claim = await claimNextReadMutation({
      serverId: seeded.server.id,
      principalId: seeded.actor.id,
      leaseOwner: "read-fence-apply-first",
      leaseMs: 60_000,
    });
    assert.ok(claim);
    const outcome = await writeFirstAgainstTransition(observer, seeded, "read_mutations", '%update "read_mutations"%', () => executeReadMutationClaim({ claim }));
    assert.equal(outcome.value.terminalState, "applied");
  });
}, TEST_TIMEOUT_MS);

test("real PG: frontier first for a principal with no authority row vs transitionMemberRole — no deadlock", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    await writeFirstAgainstTransition(observer, seeded, "read_mutation_authorities", "%insert into \"read_mutation_authorities\"%", () => getReadMutationFrontier({
      serverId: seeded.server.id,
      principalId: seeded.actor.id,
    }));
    assert.equal((await commandRows(seeded.server.id, seeded.actor.id)).authorities, 1);
  });
}, TEST_TIMEOUT_MS);
