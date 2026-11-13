// Real-PostgreSQL proof for task #101: removeMember keeps the global lock order servers -> member rows -> resource rows.
//
// removeMember now locks the `servers` row FOR SHARE and the target's `server_members` row FOR UPDATE before it deletes
// thread_follows / channel_humans, inserts the departure row (foreign key to `servers`) and deletes the member row.
// - Against the read-state sequencer, which holds the member row and then needs channel_humans for private, DM and joint
//   scopes, removal now waits on the member row instead of deadlocking (D2 in the task #93 line B analysis).
// - Against transitionMemberRole (servers FOR UPDATE, then member rows), both serialize on `servers`; without the
//   `servers` lock the departure insert's key-share on `servers` would deadlock with it (D1 shape).
// Each race is held at a known point by a session holding a row lock, and every lock wait is proven to be blocked by
// the expected backend (pg_blocking_pids), so a concurrently running real-PG file cannot satisfy it.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import {
  channelHumans,
  channels,
  readMutations,
  serverMembers,
  serverMembershipDepartures,
  servers,
  threadFollows,
  users,
} from "../db/schema";
import { createMessage } from "./messageService";
import {
  admitReadMutation,
  claimNextReadMutation,
  executeReadMutationClaim,
  isReadMutationFenceRefusal,
} from "./readMutationSequencer";
import { removeMember, ServerMemberRoleTransitionError, transitionMemberRole } from "./serverService";

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
    email: `remove-member-${label}-${suffix}@raft.test`,
    name: `remove-member-${label}-${suffix}`,
    displayName: `remove-member-${label}`,
    passwordHash: "x",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

/**
 * An owner and a member who belongs to a private channel with messages and follows a thread under it. The private scope
 * makes the read-state sequencer lock the member's channel_humans row after the member row.
 */
async function seed() {
  const owner = await seedUser("owner");
  const member = await seedUser("member");
  const suffix = randomUUID().slice(0, 8);
  const [server] = await getDb().insert(servers).values({
    name: `remove-member-server-${suffix}`,
    slug: `remove-member-${suffix}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [privateChannel] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `private-${suffix}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values([
    { channelId: privateChannel.id, userId: owner.id, role: "admin" },
    { channelId: privateChannel.id, userId: member.id },
  ]);
  const parent = await createMessage(privateChannel.id, "user", owner.id, "remove-member parent");
  await createMessage(privateChannel.id, "user", owner.id, "remove-member latest");
  const [thread] = await getDb().insert(channels).values({
    serverId: server.id,
    name: `thread-${suffix}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  await getDb().insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: member.id,
    parentMessageId: parent.id,
    reason: "manual",
  });
  return { owner, member, server, privateChannel, thread };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Admits and claims a channel_read_all for the member on the private channel; the claim is applied by the test. */
async function admitAndClaim(seeded: Seeded) {
  await admitReadMutation({
    serverId: seeded.server.id,
    principalId: seeded.member.id,
    mutationId: randomUUID(),
    mutation: { kind: "channel_read_all", scopeId: seeded.privateChannel.id },
  });
  const claim = await claimNextReadMutation({
    serverId: seeded.server.id,
    principalId: seeded.member.id,
    leaseOwner: "remove-member-lock-order",
    leaseMs: 60_000,
  });
  assert.ok(claim, "the member's read-all mutation was claimed");
  return claim;
}

/** Holds the member's channel_humans row FOR UPDATE in a session, returning the session and its pid. */
async function holdMemberChannelRow(observer: pg.Pool, seeded: Seeded) {
  const session = await observer.connect();
  await session.query("BEGIN");
  const pid = await backendPid(session);
  await session.query(
    "SELECT 1 FROM channel_humans WHERE channel_id = $1 AND user_id = $2 FOR UPDATE",
    [seeded.privateChannel.id, seeded.member.id],
  );
  return { session, pid };
}

async function memberResidue(seeded: Seeded) {
  const db = getDb();
  const memberRows = await db.select({ userId: serverMembers.userId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, seeded.server.id), eq(serverMembers.userId, seeded.member.id)));
  const channelRows = await db.select({ channelId: channelHumans.channelId }).from(channelHumans)
    .where(and(
      eq(channelHumans.userId, seeded.member.id),
      inArray(channelHumans.channelId, [seeded.privateChannel.id, seeded.thread.id]),
    ));
  const followRows = await db.select({ threadChannelId: threadFollows.threadChannelId }).from(threadFollows)
    .where(and(eq(threadFollows.followerId, seeded.member.id), eq(threadFollows.threadChannelId, seeded.thread.id)));
  return { members: memberRows.length, channelHumans: channelRows.length, threadFollows: followRows.length };
}

async function liveMutations(seeded: Seeded) {
  return (await getDb().select({ state: readMutations.state }).from(readMutations)
    .where(and(eq(readMutations.serverId, seeded.server.id), eq(readMutations.principalId, seeded.member.id))))
    .filter((row) => row.state === "admitted" || row.state === "executing").length;
}

test("real PG: sequencer apply first — removeMember queues on the member row, then clears follows, channel rows and membership", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const claim = await admitAndClaim(seeded);
    const hold = await holdMemberChannelRow(observer, seeded);
    let apply: ReturnType<typeof trackSettled<unknown>> | undefined;
    let removal: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      apply = trackSettled(executeReadMutationClaim({ claim }));
      // Apply holds the member row (KEY SHARE) and waits on the member's channel_humans row.
      const applyPid = await waitForLockWaiter(observer, "%from channel_humans%for key share%", hold.pid);
      removal = trackSettled(removeMember(seeded.server.id, seeded.member.id, { reason: "removed", actorUserId: seeded.owner.id }));
      // Removal must queue on the member row behind apply, before touching channel_humans.
      await waitForLockWaiter(observer, "%from server_members%for update%", applyPid);
      assert.equal(apply.state.settled, false, "apply is still waiting on the held channel row");
      assert.equal(removal.state.settled, false, "removal waits on the member row");
      await hold.session.query("COMMIT");
    } finally {
      await hold.session.query("ROLLBACK").catch(() => undefined);
      hold.session.release();
    }
    const [applyOutcome, removalOutcome] = await Promise.allSettled([apply!.tracked, removal!.tracked]);
    for (const outcome of [applyOutcome, removalOutcome]) {
      if (outcome.status === "rejected") {
        assert.equal(isDeadlock(outcome.reason), false, "apply and removal must not deadlock");
        assert.fail(`unexpected failure: ${String(outcome.reason)}`);
      }
    }
    assert.deepEqual(await memberResidue(seeded), { members: 0, channelHumans: 0, threadFollows: 0 },
      "the removal cleared the member row, channel rows and thread follows");
    assert.equal(await liveMutations(seeded), 0, "the applied mutation is terminal");
  });
}, TEST_TIMEOUT_MS);

test("real PG: removal first — sequencer apply queues on the member row and retires as authorization_revoked", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const claim = await admitAndClaim(seeded);
    const hold = await holdMemberChannelRow(observer, seeded);
    let apply: ReturnType<typeof trackSettled<Awaited<ReturnType<typeof executeReadMutationClaim>>>> | undefined;
    let removal: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      removal = trackSettled(removeMember(seeded.server.id, seeded.member.id, { reason: "removed", actorUserId: seeded.owner.id }));
      // Removal holds `servers` and the member row, and waits on the held channel_humans row.
      const removalPid = await waitForLockWaiter(observer, '%delete from "channel_humans"%', hold.pid);
      apply = trackSettled(executeReadMutationClaim({ claim }));
      // Apply must queue on the member row behind the removal.
      await waitForLockWaiter(observer, "%from server_members%for key share%", removalPid);
      assert.equal(removal.state.settled, false);
      assert.equal(apply.state.settled, false);
      await hold.session.query("COMMIT");
    } finally {
      await hold.session.query("ROLLBACK").catch(() => undefined);
      hold.session.release();
    }
    const [removalOutcome, applyOutcome] = await Promise.allSettled([removal!.tracked, apply!.tracked]);
    if (removalOutcome.status === "rejected") {
      assert.equal(isDeadlock(removalOutcome.reason), false, "removal must not deadlock");
      assert.fail(`unexpected removal failure: ${String(removalOutcome.reason)}`);
    }
    if (applyOutcome.status === "rejected") {
      assert.equal(isDeadlock(applyOutcome.reason), false, "apply must not deadlock");
      assert.fail(`unexpected apply failure: ${String(applyOutcome.reason)}`);
    }
    assert.equal(applyOutcome.value.terminalReason, "authorization_revoked", "the removed member's mutation retires without effect");
    assert.equal(applyOutcome.value.terminalState, "retired_no_effect");
    assert.deepEqual(await memberResidue(seeded), { members: 0, channelHumans: 0, threadFollows: 0 });
    assert.equal(await liveMutations(seeded), 0, "no live mutation remains");
    // Task #93 line B moved this refusal earlier: admission now fences on the Server membership row, so a removed member
    // is refused by the fence before any scope lookup. Before line B this same call reached the scope read and failed
    // with SCOPE_NOT_FOUND. Either way admission is refused and writes nothing; the fence reason is the stricter one.
    await assert.rejects(
      admitReadMutation({
        serverId: seeded.server.id,
        principalId: seeded.member.id,
        mutationId: randomUUID(),
        mutation: { kind: "channel_read_all", scopeId: seeded.privateChannel.id },
      }),
      (error: unknown) => isReadMutationFenceRefusal(error),
    );
    assert.equal(await liveMutations(seeded), 0, "the refused admission created no mutation");
  });
}, TEST_TIMEOUT_MS);

test("real PG: old removal order (channel rows before the member row) deadlocks against sequencer apply — reproduction", async () => {
  // Replays the pre-#101 statement order in a raw session. Kept as a separate reproduction of the deadlock edge the
  // reorder removes; it does not exercise removeMember itself.
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const claim = await admitAndClaim(seeded);
    const oldRemoval = await observer.connect();
    let apply: ReturnType<typeof trackSettled<unknown>> | undefined;
    let removalError: unknown;
    try {
      await oldRemoval.query("BEGIN");
      const oldRemovalPid = await backendPid(oldRemoval);
      await oldRemoval.query("SET LOCAL lock_timeout = '5s'");
      await oldRemoval.query("DELETE FROM channel_humans WHERE channel_id = $1 AND user_id = $2", [seeded.privateChannel.id, seeded.member.id]);
      apply = trackSettled(executeReadMutationClaim({ claim }));
      await waitForLockWaiter(observer, "%from channel_humans%for key share%", oldRemovalPid);
      try {
        await oldRemoval.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.member.id]);
        await oldRemoval.query("COMMIT");
      } catch (error) {
        removalError = error;
      }
    } finally {
      await oldRemoval.query("ROLLBACK").catch(() => undefined);
      oldRemoval.release();
    }
    const [applyOutcome] = await Promise.allSettled([apply!.tracked]);
    const applyDeadlocked = applyOutcome.status === "rejected" && isDeadlock(applyOutcome.reason);
    assert.ok(isDeadlock(removalError) || applyDeadlocked, "the old order must hit a 40P01 deadlock with apply");
  });
}, TEST_TIMEOUT_MS);

test("real PG: removeMember first vs an owner-driven transitionMemberRole on the same member — no deadlock", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const hold = await holdMemberChannelRow(observer, seeded);
    let removal: ReturnType<typeof trackSettled<unknown>> | undefined;
    let transition: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      removal = trackSettled(removeMember(seeded.server.id, seeded.member.id, { reason: "removed", actorUserId: seeded.owner.id }));
      const removalPid = await waitForLockWaiter(observer, '%delete from "channel_humans"%', hold.pid);
      transition = trackSettled(transitionMemberRole({
        serverId: seeded.server.id,
        actorUserId: seeded.owner.id,
        targetUserId: seeded.member.id,
        nextRole: "admin",
      }));
      // Behind the removal on `servers` (this order) or on the member row (an order without the `servers` lock, where the
      // departure insert's key-share on `servers` then deadlocks with the transition).
      await waitForLockWaiter(observer, "%for update%", removalPid);
      assert.equal(transition.state.settled, false, "the transition waits for the removal");
      await hold.session.query("COMMIT");
    } finally {
      await hold.session.query("ROLLBACK").catch(() => undefined);
      hold.session.release();
    }
    const [removalOutcome, transitionOutcome] = await Promise.allSettled([removal!.tracked, transition!.tracked]);
    if (removalOutcome.status === "rejected") {
      assert.equal(isDeadlock(removalOutcome.reason), false, "the removal and the role transition must not deadlock");
      assert.fail(`unexpected removal failure: ${String(removalOutcome.reason)}`);
    }
    assert.equal(transitionOutcome.status, "rejected", "the transition runs after the removal and finds no member");
    const reason = (transitionOutcome as PromiseRejectedResult).reason;
    assert.equal(isDeadlock(reason), false, "the removal and the role transition must not deadlock");
    assert.ok(reason instanceof ServerMemberRoleTransitionError && reason.code === "target_not_member", `unexpected transition failure: ${String(reason)}`);
    assert.deepEqual(await memberResidue(seeded), { members: 0, channelHumans: 0, threadFollows: 0 });
  });
}, TEST_TIMEOUT_MS);

test("real PG: a writer in transitionMemberRole's lock order first — removeMember waits on the servers row, then completes", async () => {
  await withRealPg(async (observer) => {
    const seeded = await seed();
    const transitionSession = await observer.connect();
    let removal: ReturnType<typeof trackSettled<unknown>> | undefined;
    try {
      await transitionSession.query("BEGIN");
      const transitionPid = await backendPid(transitionSession);
      await transitionSession.query("SELECT id FROM servers WHERE id = $1 FOR UPDATE", [seeded.server.id]);
      for (const userId of [seeded.owner.id, seeded.member.id].sort()) {
        await transitionSession.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [seeded.server.id, userId]);
      }
      await transitionSession.query("UPDATE server_members SET role = 'admin' WHERE server_id = $1 AND user_id = $2", [seeded.server.id, seeded.member.id]);
      removal = trackSettled(removeMember(seeded.server.id, seeded.member.id, { reason: "removed", actorUserId: seeded.owner.id }));
      await waitForLockWaiter(observer, "%from servers%for share%", transitionPid);
      assert.equal(removal.state.settled, false, "removal waits on the servers row");
      await transitionSession.query("COMMIT");
    } finally {
      await transitionSession.query("ROLLBACK").catch(() => undefined);
      transitionSession.release();
    }
    const [removalOutcome] = await Promise.allSettled([removal!.tracked]);
    if (removalOutcome.status === "rejected") {
      assert.equal(isDeadlock(removalOutcome.reason), false, "removal must not deadlock");
      assert.fail(`unexpected removal failure: ${String(removalOutcome.reason)}`);
    }
    assert.deepEqual(await memberResidue(seeded), { members: 0, channelHumans: 0, threadFollows: 0 });
  });
}, TEST_TIMEOUT_MS);

test("real PG: removeMember for a user who is not a member, and for a missing Server, changes nothing", async () => {
  await withRealPg(async () => {
    const seeded = await seed();
    const stranger = await seedUser("stranger");
    // Not a member: no error, nothing of the stranger's to delete, and no departure either: only a
    // membership that ended records one (RFC 083 §6.1, #13377), so a late call cannot rewrite how it ended.
    await removeMember(seeded.server.id, stranger.id, { reason: "removed", actorUserId: seeded.owner.id });
    const departures = await getDb().select({ userId: serverMembershipDepartures.userId }).from(serverMembershipDepartures)
      .where(and(eq(serverMembershipDepartures.serverId, seeded.server.id), eq(serverMembershipDepartures.userId, stranger.id)));
    assert.equal(departures.length, 0, "no departure for someone who was not a member");
    assert.deepEqual(await memberResidue(seeded), { members: 1, channelHumans: 1, threadFollows: 1 }, "the real member is untouched");
    // Missing Server: there is no membership to end, so nothing is written and nothing is cleaned up.
    await removeMember(randomUUID(), seeded.member.id, { reason: "removed" });
    assert.deepEqual(await memberResidue(seeded), { members: 1, channelHumans: 1, threadFollows: 1 }, "nothing was partially cleaned up");
  });
}, TEST_TIMEOUT_MS);
