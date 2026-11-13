// Real-PostgreSQL lock-order proofs for a channel member's self_connect
// (externalInviteConnectService.connectSelfJointChannel, design v3 §3): a Guest
// G of host H, bound to H's copy of joint J, connects SG, a server they own;
// their Guest seat ends in the same commit. Its order, every step before the
// first J: admissions (H, SG) -> SG's ns-3 -> J's lifecycle -> H's copy (FOR
// NO KEY UPDATE) -> SG's earlier copy -> servers H, SG (FOR SHARE, id order)
// -> G's member row on H (FOR UPDATE) -> G's on SG (FOR KEY SHARE) ->
// membership flags -> every J (sorted, the seat removal's and the
// connection's together); external_channels_v1's share lock is the last
// (revalidateUnderLocks).
//
// Each competitor runs both ways round: paused inside the self_connect (its
// member rows held, or every J held) while the competitor starts, and the
// competitor paused first while the self_connect starts. pg_stat_activity
// proves the second one waits; both settle (no deadlock, no lock timeout),
// and nothing written contradicts the other.
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { channelExternalInvites, computers, jointChannelMembers, jointChannelServers, serverMembers, servers } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { seedBoundGuest } from "../test/guestFixture";
import { acceptJointChannelInvite, addHuman, createJointChannel, getChannel } from "./channelService";
import { attachComputer } from "./computerCredentialService";
import { retireDueAccounts } from "./accountDeletion/cleanup";
import { requestAccountDeletion } from "./accountDeletion/requests";
import { __setSelfConnectHookForTests, type SelfConnectHookStage } from "./externalInviteConnectService";
import { acceptExternalInviteAsGuest } from "./externalInviteService";
import { connectMyServersToChannel, resolveMemberConnectEntry } from "./jointMemberConnectService";
import { addMember, deleteServer, removeMember, transitionMemberRole } from "./serverService";

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>) => {
  const promise = outside(async () => {
    assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
    return run();
  });
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
};
type Settled<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };

async function until(observer: pg.Client, what: string, sqlText: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(sqlText);
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const lockWaiters = `SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}
function assertNoDeadlock(results: Record<string, Settled>) {
  for (const [name, result] of Object.entries(results)) {
    if (!result.ok && /deadlock|lock timeout|canceling statement/i.test(describeError(result.error))) {
      assert.fail(`${name}: ${describeError(result.error)}`);
    }
  }
}

/** Pauses the self_connect inside its transaction at `stage` (its locks held) until released. */
function pauseSelfConnect(stage: SelfConnectHookStage) {
  let reached!: () => void;
  const atPause = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let fired = false;
  __setSelfConnectHookForTests(async (at) => {
    if (at !== stage || fired) return;
    fired = true;
    reached();
    await released;
  });
  return { atPause, release, restore: () => { __setSelfConnectHookForTests(null); release(); } };
}

/** A server deletion past its server row (FOR UPDATE) and, when it has any, its J locks: at its tombstone write. */
const atTombstone = (text: string) => /^\s*update "servers" set "deleted_at"/i.test(text);
/** A member removal past its J locks (prepareMemberRemoval): at its first write. */
const atRemovalWrites = (text: string) => /DELETE FROM "thread_follows"/i.test(text);

const atFirstJointLock = (text: string, values: readonly unknown[]) => text.includes("pg_advisory_xact_lock(hashtextextended(")
  && values.some((value) => String(value).startsWith("joint-human-membership:"));

/**
 * H (owner) and participant P share J; G is H's Guest bound to H's copy (in J
 * through it, with an accepted Guest invite whose retry is the competitor)
 * and owns SG. With `secondJoint`, G is also in J2 (hosted by H, joined
 * through P, of which G is a member), J2's id below J's: the seat's removal
 * revalidates both, the connection's J is not the first.
 */
async function seedWorld(db: Database, label: string, options: { secondJoint?: boolean } = {}) {
  await setJointFlags(db, false);
  const seed = createSeed(db);
  const hostOwner = await seed.human(), peerOwner = await seed.human(), g = await seed.human(), y = await seed.human(), x = await seed.human();
  const h = await seed.server({ owner: hostOwner }), p = await seed.server({ owner: peerOwner, members: [y, x] });
  const sg = await seed.server({ owner: g }), s = await seed.server({ owner: x });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, p.id, sg.id, s.id]));
  const makeJoint = async (name: string) => {
    const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name, targetServerSlug: p.slug, invitedPeople: [`@${peerOwner.name}`] });
    const pLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: p.id, acceptedByUserId: peerOwner.id })).id;
    return { J: created.jointChannel.id, hLocal: created.channel.id, pLocal };
  };
  let main = await makeJoint(`${label}-a`.slice(0, 40));
  // X: in the joint through P (no seat on the host), owns S.
  await addHuman(main.pLocal, x.id);
  let other: Awaited<ReturnType<typeof makeJoint>> | null = null;
  if (options.secondJoint) {
    const second = await makeJoint(`${label}-b`.slice(0, 40));
    // The connection's J is the larger id: the seat's removal's other J sorts first.
    [main, other] = main.J > second.J ? [main, second] : [second, main];
    await addMember(p.id, g.id);
    await addHuman(other.pLocal, g.id);
    await addHuman(other.pLocal, y.id);
  }
  await enableExternalChannelsFlag(h.id);
  // G accepted an emailed invite as a Guest of H's copy (the real path), so its retry is a real competitor.
  const token = randomBytes(32).toString("hex");
  await db.insert(channelExternalInvites).values({ channelId: main.hLocal, hostServerId: h.id, email: g.email.toLowerCase(),
    tokenHash: createHash("sha256").update(token).digest("hex"), invitedByUserId: hostOwner.id, expiresAt: new Date(Date.now() + 86_400_000), origin: "external_invite" });
  assert.equal((await acceptExternalInviteAsGuest(token, g.id)).joined, true);
  return { hostOwner, peerOwner, g, y, x, h, p, sg, s, ...main, other, token };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function selfConnect(w: World, as: "g" | "x" = "g") {
  const actor = as === "g" ? w.g : w.x;
  const channel = await getChannel(as === "g" ? w.hLocal : w.pLocal);
  const entry = await resolveMemberConnectEntry(channel!, actor.id);
  if (!entry) throw new Error("not a member");
  const result = await connectMyServersToChannel(entry, actor.id, [as === "g" ? w.sg.id : w.s.id]);
  const [outcome] = result.servers;
  if (outcome?.state === "refused") throw outcome.error;
  return outcome?.state;
}

async function state(db: Database, w: World) {
  const [seat] = await db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, w.h.id), eq(serverMembers.userId, w.g.id)));
  const [sgSide] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, w.J), eq(jointChannelServers.serverId, w.sg.id)));
  const [jm] = await db.select({ generation: jointChannelMembers.generation }).from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, w.J), eq(jointChannelMembers.userId, w.g.id)));
  return { seat: seat?.role ?? null, sg: sgSide?.status ?? null, member: jm?.generation ?? null };
}

async function withRealPg(label: string, body: (observer: pg.Client, url: string) => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    try {
      await body(observer, url);
    } finally {
      __setSelfConnectHookForTests(null);
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

/** The self_connect paused at `stage`, `competitor` started and seen waiting on a lock, then both settle. */
async function selfConnectFirst<T>(observer: pg.Client, w: World, stage: SelfConnectHookStage, competitor: () => Promise<T>, as: "g" | "x" = "g") {
  const pause = pauseSelfConnect(stage);
  try {
    const connecting = start(() => selfConnect(w, as));
    await pause.atPause;
    const other = start(competitor);
    await until(observer, "the competitor to wait on the self_connect", lockWaiters);
    pause.release();
    const results = { selfConnect: await connecting, competitor: await other };
    assertNoDeadlock(results);
    return results;
  } finally {
    pause.restore();
  }
}

/** The competitor paused at `at` (its locks held), the self_connect started and seen waiting, then both settle. */
async function competitorFirst<T>(observer: pg.Client, w: World, at: Parameters<typeof pauseQuery>[0], competitor: () => Promise<T>, as: "g" | "x" = "g") {
  const pause = pauseQuery(at);
  try {
    const other = start(competitor);
    await pause.atPause;
    const connecting = start(() => selfConnect(w, as));
    await until(observer, "the self_connect to wait on the competitor", lockWaiters);
    pause.release();
    const results = { selfConnect: await connecting, competitor: await other };
    assertNoDeadlock(results);
    return results;
  } finally {
    pause.restore();
  }
}

for (const stage of ["locked_members", "locked_joints"] as const) {
  test.skipIf(skipJointRealPg)(`the Guest's self_connect (held at ${stage}) against their own Guest accept retry: the retry waits, then answers as an invite no longer theirs; the seat ended once`, async () => {
    await withRealPg(`mc_guest_retry_${stage}`, async (observer) => {
      const db = getDb();
      const w = await seedWorld(db, `mc-retry-${stage.slice(7, 12)}`);
      const results = await selfConnectFirst(observer, w, stage, () => acceptExternalInviteAsGuest(w.token, w.g.id));
      assert.ok(results.selfConnect.ok, describeError(!results.selfConnect.ok && results.selfConnect.error));
      assert.equal(results.competitor.ok, false, "the retry finds no Guest seat any more: the neutral refusal");
      assert.deepEqual(await state(db, w), { seat: null, sg: "active", member: (await state(db, w)).member });
    });
  }, 120_000);
}

test.skipIf(skipJointRealPg)("the Guest's accept retry first (held at its invite row): the self_connect waits on the host's admission lock, then connects", async () => {
  await withRealPg("mc_retry_first", async (observer) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-retry-first");
    const results = await competitorFirst(observer, w, (text) => /from "channel_external_invites"[\s\S]*for update/i.test(text), () => acceptExternalInviteAsGuest(w.token, w.g.id));
    assert.ok(results.competitor.ok && results.selfConnect.ok, describeError(!results.selfConnect.ok && results.selfConnect.error));
    assert.equal((await state(db, w)).seat, null);
  });
}, 120_000);

test.skipIf(skipJointRealPg)("against the host promoting the Guest: either order settles; promoted first, the self_connect restarts as a member's (no seat to end) and still connects", async () => {
  await withRealPg("mc_promotion", async (observer, url) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-promote-a");
    const promote = (target: World) => transitionMemberRole({ serverId: target.h.id, actorUserId: target.hostOwner.id, targetUserId: target.g.id, nextRole: "member" });
    const held = await selfConnectFirst(observer, w, "locked_members", () => promote(w));
    assert.ok(held.selfConnect.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));
    assert.equal((await state(db, w)).seat, null, "the seat ended first; the promotion found no member");

    const w2 = await seedWorld(db, "mc-promote-b");
    const promoter = new pg.Client({ connectionString: url, application_name: "mc-promoter" });
    await promoter.connect();
    try {
      // The promotion's own order (servers FOR UPDATE, then the member row), held open.
      await promoter.query("BEGIN");
      await promoter.query("SELECT id FROM servers WHERE id = $1 FOR UPDATE", [w2.h.id]);
      await promoter.query("UPDATE server_members SET role = 'member', guest_channel_id = NULL WHERE server_id = $1 AND user_id = $2", [w2.h.id, w2.g.id]);
      const connecting = start(() => selfConnect(w2));
      await until(observer, "the self_connect to wait on the promotion", lockWaiters);
      await promoter.query("COMMIT");
      const result = await connecting;
      assertNoDeadlock({ selfConnect: result });
      assert.ok(result.ok, describeError(!result.ok && result.error));
      assert.deepEqual([(await state(db, w2)).seat, (await state(db, w2)).sg], ["member", "active"], "a member now: nothing to release, SG connected");
    } finally {
      await promoter.query("ROLLBACK").catch(() => {});
      await promoter.end();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("against the host removing the Guest: either order settles; removed first, the self_connect is refused and writes nothing", async () => {
  await withRealPg("mc_removal", async (observer) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-remove-a");
    const held = await selfConnectFirst(observer, w, "locked_members", () => removeMember(w.h.id, w.g.id, { actorUserId: w.hostOwner.id }));
    assert.ok(held.selfConnect.ok && held.competitor.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));
    assert.deepEqual([(await state(db, w)).seat, (await state(db, w)).sg], [null, "active"]);

    const w2 = await seedWorld(db, "mc-remove-b");
    const first = await competitorFirst(observer, w2, atFirstJointLock, () => removeMember(w2.h.id, w2.g.id, { actorUserId: w2.hostOwner.id }));
    assert.ok(first.competitor.ok);
    assert.equal(first.selfConnect.ok, false, "refused: no longer in the channel");
    assert.deepEqual(await state(db, w2), { seat: null, sg: null, member: null });
  });
}, 120_000);

test.skipIf(skipJointRealPg)("the seat's removal reaches two joints and the connection's is not the first: against another member's removal on the other joint, either order settles", async () => {
  await withRealPg("mc_two_joints", async (observer) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-two-a", { secondJoint: true });
    assert.ok(w.other && w.other.J < w.J, "fixture: the other joint sorts first");
    const held = await selfConnectFirst(observer, w, "locked_joints", () => removeMember(w.p.id, w.y.id, { actorUserId: w.peerOwner.id }));
    assert.ok(held.selfConnect.ok && held.competitor.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));
    const [still] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, w.other!.J), eq(jointChannelMembers.userId, w.g.id)));
    assert.ok(still, "G stays in the other joint through P");

    const w2 = await seedWorld(db, "mc-two-b", { secondJoint: true });
    const first = await competitorFirst(observer, w2, atRemovalWrites, () => removeMember(w2.p.id, w2.y.id, { actorUserId: w2.peerOwner.id }));
    assert.ok(first.selfConnect.ok && first.competitor.ok, describeError(!first.selfConnect.ok && first.selfConnect.error));
    assert.equal((await state(db, w2)).sg, "active");
  });
}, 120_000);

for (const which of ["sg", "h"] as const) {
  test.skipIf(skipJointRealPg)(`against deleting ${which === "sg" ? "the connected server" : "the host"}: either order settles`, async () => {
    await withRealPg(`mc_delete_${which}`, async (observer) => {
      const db = getDb();
      const w = await seedWorld(db, `mc-del-${which}-a`);
      const deletion = (target: World) => deleteServer(which === "sg" ? target.sg.id : target.h.id, { deletedByUserId: which === "sg" ? target.g.id : target.hostOwner.id });
      const held = await selfConnectFirst(observer, w, "locked_joints", () => deletion(w));
      assert.ok(held.selfConnect.ok && held.competitor.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));

      const w2 = await seedWorld(db, `mc-del-${which}-b`);
      const first = await competitorFirst(observer, w2, atTombstone, () => deletion(w2));
      assert.ok(first.competitor.ok);
      assert.equal(first.selfConnect.ok, false, "refused after the deletion");
      const [seat] = await db.select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, w2.h.id), eq(serverMembers.userId, w2.g.id)));
      if (which === "sg") assert.equal(seat?.role, "guest", "the seat kept");
    });
  }, 120_000);
}

test.skipIf(skipJointRealPg)("a Computer attach and the self_connect: attached first, refused guest_has_computer; the self_connect first, the attach waits on the member row and then finds no member (nothing attached, nothing revoked)", async () => {
  await withRealPg("mc_computer", async (observer) => {
    const db = getDb();
    // Attached first: G attached it as an admin, then became the Guest of the channel.
    const w = await seedWorld(db, "mc-computer-a");
    const [host] = await db.select({ slug: servers.slug }).from(servers).where(eq(servers.id, w.h.id));
    await db.update(serverMembers).set({ role: "admin", guestChannelId: null }).where(and(eq(serverMembers.serverId, w.h.id), eq(serverMembers.userId, w.g.id)));
    assert.equal((await attachComputer({ userId: w.g.id, serverSlug: host!.slug, name: "g-before" })).ok, true);
    await seedBoundGuest({ serverId: w.h.id, userId: w.g.id, channelId: w.hLocal });
    await assert.rejects(selfConnect(w), (err: unknown) => (err as { code?: string }).code === "guest_has_computer");
    assert.equal((await state(db, w)).seat, "guest");

    // The self_connect first: G passes the attach's unlocked check as an admin, becomes the Guest, then the attach's
    // locked check queues behind the self_connect's member row and answers after its commit.
    const w2 = await seedWorld(db, "mc-computer-b");
    const [host2] = await db.select({ slug: servers.slug }).from(servers).where(eq(servers.id, w2.h.id));
    await db.update(serverMembers).set({ role: "admin", guestChannelId: null }).where(and(eq(serverMembers.serverId, w2.h.id), eq(serverMembers.userId, w2.g.id)));
    const attachPause = pauseQuery((text) => /server_members[\s\S]*for share/i.test(text));
    const connectPause = pauseSelfConnect("locked_members");
    try {
      const attach = start(() => attachComputer({ userId: w2.g.id, serverSlug: host2!.slug, name: "g-after" }));
      await attachPause.atPause;
      await seedBoundGuest({ serverId: w2.h.id, userId: w2.g.id, channelId: w2.hLocal });
      const connecting = start(() => selfConnect(w2));
      await connectPause.atPause;
      attachPause.release();
      await until(observer, "the attach to wait on the member row", lockWaiters);
      connectPause.release();
      const results = { selfConnect: await connecting, attach: await attach };
      assertNoDeadlock(results);
      assert.ok(results.selfConnect.ok, describeError(!results.selfConnect.ok && results.selfConnect.error));
      assert.ok(results.attach.ok && !results.attach.value.ok, "the attach is refused");
      assert.deepEqual(await db.select().from(computers).where(eq(computers.attachedByUserId, w2.g.id)), [], "nothing attached");
    } finally {
      attachPause.restore();
      connectPause.restore();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("the J lock set changes between the guess and the locks: the self_connect detects it, restarts with the new set and connects", async () => {
  await withRealPg("mc_restart", async () => {
    const db = getDb();
    const w = await seedWorld(db, "mc-restart");
    // Another joint H hosts, with P: G (a member of P) joins it there only after the self_connect guessed its J set.
    const extra = await createJointChannel({ hostServerId: w.h.id, createdByUserId: w.hostOwner.id, name: "mc-restart-x", targetServerSlug: w.p.slug, invitedPeople: [`@${w.peerOwner.name}`] });
    const extraP = (await acceptJointChannelInvite({ inviteId: extra.invites[0]!.id, targetServerId: w.p.id, acceptedByUserId: w.peerOwner.id })).id;
    await addMember(w.p.id, w.g.id);
    const guesses: Array<{ attempt: number; jointIds: readonly string[] }> = [];
    __setSelfConnectHookForTests(async (stage, at) => {
      if (stage !== "guessed") return;
      guesses.push({ attempt: at.attempt!, jointIds: at.jointIds! });
      // A concurrent transaction, committed between this attempt's guess and its locks.
      if (at.attempt === 0) await outside(() => addHuman(extraP, w.g.id));
    });
    try {
      assert.equal(await selfConnect(w), "connected");
    } finally {
      __setSelfConnectHookForTests(null);
    }
    assert.deepEqual(guesses.map((guess) => guess.attempt), [0, 1], "one restart");
    assert.equal(guesses[0]!.jointIds.includes(extra.jointChannel.id), false, "the first guess did not have the new joint");
    assert.equal(guesses[1]!.jointIds.includes(extra.jointChannel.id), true, "the restart's does");
    assert.deepEqual([(await state(db, w)).seat, (await state(db, w)).sg], [null, "active"]);
    const [stillIn] = await db.select().from(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, extra.jointChannel.id), eq(jointChannelMembers.userId, w.g.id)));
    assert.ok(stillIn, "G stays in the other joint through P");
  });
}, 120_000);

test.skipIf(skipJointRealPg)("a participant's member (no seat to end) against deleting the host: the host's server row is held before J, so either order settles", async () => {
  await withRealPg("mc_member_delete_host", async (observer) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-mdel-a");
    const held = await selfConnectFirst(observer, w, "locked_joints", () => deleteServer(w.h.id, { deletedByUserId: w.hostOwner.id }), "x");
    assert.ok(held.selfConnect.ok && held.competitor.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));
    const w2 = await seedWorld(db, "mc-mdel-b");
    const first = await competitorFirst(observer, w2, atTombstone, () => deleteServer(w2.h.id, { deletedByUserId: w2.hostOwner.id }), "x");
    assert.ok(first.competitor.ok);
    assert.equal(first.selfConnect.ok, false, "refused after the host's deletion");
  });
}, 120_000);

// ── Account deletion (Cody: users row FOR UPDATE, then the servers the person owns FOR UPDATE, handOverOwnedServers) ──

/** The person's deletion through the product path: requested, made due, then the cleanup's retirement (handOverOwnedServers). */
async function deleteAccount(db: Database, userId: string) {
  const requested = await requestAccountDeletion({ userId, source: "self", actorUserId: userId });
  assert.equal(requested.kind, "scheduled", JSON.stringify(requested));
  await db.execute(sql`UPDATE account_deletion_requests SET scheduled_for = now() - interval '1 minute' WHERE user_id = ${userId}::uuid AND state = 'pending'`);
  return retireDueAccounts({ retirementsPerRun: 1 });
}
const atHandOver = (text: string) => /from "servers"[\s\S]*"owner_id"[\s\S]*for update/i.test(text);

/** A deletion request holding the users row FOR UPDATE, its pending request not yet written or committed. */
const atRequestInsert = (text: string) => /^\s*insert into "account_deletion_requests"/i.test(text);

test.skipIf(skipJointRealPg)("a self_connect whose connect transaction starts waiting on the users row while the deletion request is still uncommitted sees the request once it commits, and is refused (Cody 20bec603)", async () => {
  await withRealPg("mc_account_request_uncommitted", async (observer) => {
    const db = getDb();
    const w = await seedWorld(db, "mc-acct-req");
    // The self_connect past its earlier transactions (invite, guess), before its connect transaction.
    const connectPause = pauseSelfConnect("guessed");
    const requestPause = pauseQuery(atRequestInsert);
    try {
      const connecting = start(() => selfConnect(w, "x"));
      await connectPause.atPause;
      // The request holds the users row FOR UPDATE; its pending row is not written or committed yet.
      const request = start(() => requestAccountDeletion({ userId: w.x.id, source: "self", actorUserId: w.x.id }));
      await requestPause.atPause;
      // The connect transaction's first statement waits on that row, its snapshot from before the request commits.
      connectPause.release();
      await until(observer, "the connect transaction to wait on the request's users row lock", lockWaiters);
      requestPause.release();
      const results = { selfConnect: await connecting, competitor: await request };
      assertNoDeadlock(results);
      assert.ok(results.competitor.ok, describeError(!results.competitor.ok && results.competitor.error));
      assert.equal((results.competitor.value as { kind: string }).kind, "scheduled");
      assert.equal(results.selfConnect.ok, false, "refused: the request committed while the connect transaction waited");
    } finally {
      requestPause.restore();
      connectPause.restore();
    }
    const [side] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
      .where(and(eq(jointChannelServers.jointChannelId, w.J), eq(jointChannelServers.serverId, w.s.id)));
    assert.equal(side, undefined, "nothing connected");
  });
}, 120_000);

for (const as of ["x", "g"] as const) {
  const who = as === "x" ? "a participant's member" : "a Guest of the host";
  test.skipIf(skipJointRealPg)(`${who} self-connecting against their own account deletion: the users row is taken first, so either order settles`, async () => {
    await withRealPg(`mc_account_deletion_${as}`, async (observer) => {
      const db = getDb();
      // The self_connect first (its users row, servers, members and every J held): the deletion request waits on the users row.
      const w = await seedWorld(db, `mc-acct-${as}-a`);
      const actor = as === "x" ? w.x : w.g;
      const held = await selfConnectFirst(observer, w, "locked_joints", () => deleteAccount(db, actor.id), as);
      assert.ok(held.selfConnect.ok, describeError(!held.selfConnect.ok && held.selfConnect.error));
      assert.ok(held.competitor.ok, describeError(!held.competitor.ok && held.competitor.error));
      assert.deepEqual(held.competitor.value, [actor.id], "then retired");

      // The deletion first (its users row FOR UPDATE held, the owned servers still ahead): the self_connect waits on the users row, then is refused.
      const w2 = await seedWorld(db, `mc-acct-${as}-b`);
      const actor2 = as === "x" ? w2.x : w2.g;
      const requested = await requestAccountDeletion({ userId: actor2.id, source: "self", actorUserId: actor2.id });
      assert.equal(requested.kind, "scheduled");
      await db.execute(sql`UPDATE account_deletion_requests SET scheduled_for = now() - interval '1 minute' WHERE user_id = ${actor2.id}::uuid AND state = 'pending'`);
      const first = await competitorFirst(observer, w2, atHandOver, () => retireDueAccounts({ retirementsPerRun: 1 }), as);
      assert.ok(first.competitor.ok, describeError(!first.competitor.ok && first.competitor.error));
      assert.equal(first.selfConnect.ok, false, "refused: the account is being deleted");
      const target = as === "x" ? w2.s.id : w2.sg.id;
      const [side] = await db.select({ status: jointChannelServers.status }).from(jointChannelServers)
        .where(and(eq(jointChannelServers.jointChannelId, w2.J), eq(jointChannelServers.serverId, target)));
      assert.equal(side, undefined, "nothing connected");
    });
  }, 120_000);
}
