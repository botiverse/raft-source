// Real-PostgreSQL lock-order proofs for "Your servers" (connectOwnServersToChannel,
// a host_direct operation) by someone already in the joint:
//
// 1./2. Reconnecting their own server S after its source ended reopens that
//    source row and writes channel.source_readmitted on the host
//    (externalInviteConnectService reopenEndedOwnSource). The connection takes
//    S's server row FOR SHARE and, since this change, the host's FOR KEY
//    SHARE, both before J (the joint invite's from_server_id and the audit
//    row's server_id reference them). Paused after J, right before its
//    INSERT INTO joint_channel_invites (atJointInviteInsert, the first
//    statement after J with a foreign key to the host's row), against
//    deleting the host (1) or S (2) through deleteServer (server row FOR
//    UPDATE, then J): the deletion waits on that server row, held by the
//    paused connection, and both finish. With the host's row taken only
//    through that INSERT (the revert check), the deletion takes the host's
//    row and queues on J, held by the connection, whose released INSERT then
//    queues on the host's row: a J <-> host cycle (deadlock_detected).
// 3. An open emailed invite to the actor's own address is revoked and a fresh
//    host_direct one created (createDirectConnectInvite), against an admin
//    revoking that same invite (revokeExternalInvite), in both orders: one
//    revoke wins, the other waits on the invite row (or its unique slot) and
//    sees the result, and exactly one open invite stays for (channel, email).
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import {
  channelExternalInvites,
  integrationAuditEvents,
  jointChannelAdmissions,
  jointChannelServers,
  jointMembershipDepartures,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { acceptJointChannelInvite, createJointChannel, disconnectJointChannel } from "./channelService";
import { connectOwnServersToChannel } from "./externalInviteConnectService";
import { insertExternalInvites, revokeExternalInvite } from "./externalInviteService";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "./jointMembershipDeparture";
import { deleteServer } from "./serverService";

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>) => {
  const promise = outside(async () => {
    assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
    return run();
  });
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
};
type Settled = Awaited<ReturnType<typeof start>>;

async function until(observer: pg.Client, what: string, sqlText: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ n: number }>(sqlText);
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitingOn = (queryLike: string) => `SELECT count(*)::int n FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock'
    AND query ILIKE '${queryLike}' AND cardinality(pg_blocking_pids(pid)) > 0`;

/** Who waits on a lock now, with the relation and mode it waits for (pg_locks, not granted). */
async function lockWaits(observer: pg.Client) {
  const { rows } = await observer.query<{ query: string; locktype: string; relation: string | null; mode: string }>(`SELECT a.query, l.locktype,
      l.relation::regclass::text AS relation, l.mode
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE a.datname = current_database() AND NOT l.granted AND cardinality(pg_blocking_pids(a.pid)) > 0`);
  return rows;
}

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}
function assertAllOk(results: Record<string, Settled>) {
  for (const [name, result] of Object.entries(results)) {
    if (!result.ok) assert.fail(`${name} failed: ${describeError(result.error)}`);
  }
}

/**
 * Host H (owner hostOwner; admin X in the joint through H) and participant B
 * (to make the channel joint). X owns S, connected with "Your servers" (a
 * source of X's membership), then disconnected: that source ended, X still in
 * through H. External channels on for H; computed membership, source exit off.
 */
async function seedEndedOwnSource(db: Database, label: string) {
  await setJointFlags(db, false);
  const seed = createSeed(db);
  const hostOwner = await seed.human(), x = await seed.human(), peerOwner = await seed.human();
  const h = await seed.server({ owner: hostOwner }), b = await seed.server({ owner: peerOwner }), s = await seed.server({ owner: x });
  await db.insert(serverMembers).values({ serverId: h.id, userId: x.id, role: "admin" });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, b.id, s.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: label,
    targetServerSlug: b.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [x.id] });
  await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id });
  await enableExternalChannelsFlag(h.id);
  const J = created.jointChannel.id, hLocal = created.channel.id;
  const first = await connectOwnServersToChannel(hLocal, x.id, [s.id], {});
  assert.equal(first.servers[0]?.state, "connected", JSON.stringify(first.servers));
  const [sSide] = await db.select({ localChannelId: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, J), eq(jointChannelServers.serverId, s.id)));
  await disconnectJointChannel(sSide!.localChannelId, x.id);
  for (const departure of await db.select({ id: jointMembershipDepartures.id }).from(jointMembershipDepartures)) {
    for (let batch = 0; batch < 10 && !(await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} })); batch += 1);
  }
  const [ended] = await db.select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, J), eq(jointChannelAdmissions.userId, x.id), eq(jointChannelAdmissions.serverId, s.id)));
  assert.ok(ended?.endedAt, "fixture: X's S source ended with S's disconnect");
  return { hostOwner, x, peerOwner, h, b, s, J, hLocal, ended };
}

/** Runs `body` with an app on a fresh real database, an observer connection and the query pause hook. */
async function withRealPg(label: string, body: (observer: pg.Client) => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    try {
      await body(observer);
    } finally {
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

/**
 * The pause point: the connection's INSERT INTO joint_channel_invites
 * (createExternalConnectJointInvite), the first statement after its J lock
 * that references the host's server row by foreign key (from_server_id; the
 * readmission's audit INSERT, server_id, comes after it). Paused there, the
 * connection holds J (asserted from pg_locks at the pause) and, in the old
 * order, no lock on the host's row yet: deleting the host then takes that
 * row FOR UPDATE and queues on J, and the released INSERT's FK KEY SHARE
 * queues on the deletion, a cycle. With the host's row KEY SHARE-locked
 * before J, the deletion queues on that row instead.
 */
const atJointInviteInsert = (text: string) => /^\s*insert into "joint_channel_invites"/i.test(text);

/** Whether some transaction holds J's membership lock (the connection, at the pause: nothing else runs). */
async function jointLockHeld(observer: pg.Client, jointId: string): Promise<boolean> {
  const { rows } = await observer.query<{ n: number }>(`SELECT count(*)::int n FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND objsubid = 1
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [`joint-human-membership:${jointId}`]);
  return rows[0]!.n > 0;
}

async function sourceRow(db: Database, x: { J: string; x: { id: string }; s: { id: string }; ended: { generation: number } }) {
  const [row] = await db.select().from(jointChannelAdmissions).where(and(eq(jointChannelAdmissions.jointChannelId, x.J),
    eq(jointChannelAdmissions.userId, x.x.id), eq(jointChannelAdmissions.serverId, x.s.id), eq(jointChannelAdmissions.generation, x.ended.generation)));
  return row!;
}

for (const variant of [
  { name: "the host", deleted: (x: Awaited<ReturnType<typeof seedEndedOwnSource>>) => ({ id: x.h.id, by: x.hostOwner.id }) },
  { name: "the reconnected server S", deleted: (x: Awaited<ReturnType<typeof seedEndedOwnSource>>) => ({ id: x.s.id, by: x.x.id }) },
]) {
  test.skipIf(skipJointRealPg)(`Your servers reopening an ended own source holds ${variant.name}'s server row before J, so deleting it waits and both finish`, async () => {
    await withRealPg(`own_source_reopen_delete_${variant.name === "the host" ? "host" : "target"}`, async (observer) => {
      const db = getDb();
      const x = await seedEndedOwnSource(db, `own-reopen-${randomBytes(3).toString("hex")}`);
      const deleted = variant.deleted(x);
      const pause = pauseQuery(atJointInviteInsert);
      try {
        const connect = start(() => connectOwnServersToChannel(x.hLocal, x.x.id, [x.s.id], {}));
        await pause.atPause;
        assert.equal(await jointLockHeld(observer, x.J), true, "paused after the connection's J lock, before its first host-row FK statement");
        const deletion = start(() => deleteServer(deleted.id, { deletedByUserId: deleted.by }));
        await until(observer, "the deletion to wait on the paused connection", waitingOn("%"));
        const waits = await lockWaits(observer);
        pause.release();
        const results = { connect: await connect, deletion: await deletion };
        assertAllOk(results);
        // pg_locks: the deletion's FOR UPDATE of that server row waits (a tuple/transactionid lock), blocked by the paused connection.
        assert.ok(waits.some((row) => /from "servers"[\s\S]*for update/i.test(row.query)), `the deletion waited on the server row: ${JSON.stringify(waits)}`);
        const outcome = (results.connect as { ok: true; value: Awaited<ReturnType<typeof connectOwnServersToChannel>> }).value;
        assert.equal(outcome.servers[0]?.state, "connected", "connected first, under the locks it held");
        const reopened = await sourceRow(db, x);
        assert.equal(reopened.admittedBy, x.x.id, "reopened by X");
        const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.source_readmitted"));
        assert.deepEqual(audit.map((row) => row.serverId), [x.h.id], "one event on the host");
        const [server] = await db.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, deleted.id));
        assert.notEqual(server?.deletedAt, null, "then deleted");
      } finally {
        pause.restore();
      }
    });
  }, 120_000);
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** An open emailed invite (external_invite) on the host's channel to X's own address. */
async function seedOwnEmailInvite(db: Database, x: Awaited<ReturnType<typeof seedEndedOwnSource>>) {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, x.x.id));
  const [row] = await insertExternalInvites(db, [{
    channelId: x.hLocal, hostServerId: x.h.id, email: user!.email.toLowerCase(), tokenHash: sha256(randomBytes(16).toString("hex")),
    invitedByUserId: x.hostOwner.id, expiresAt: new Date(Date.now() + 86_400_000), origin: "external_invite",
  }]).returning();
  return row!;
}

async function invitesTo(db: Database, channelId: string, email: string) {
  return db.select().from(channelExternalInvites)
    .where(and(eq(channelExternalInvites.channelId, channelId), eq(channelExternalInvites.email, email)));
}

for (const order of ["Your servers first", "the admin's revoke first"] as const) {
  test.skipIf(skipJointRealPg)(`Your servers replacing an open emailed invite to the actor, against an admin revoking it (${order}): one revoke wins, one open invite left`, async () => {
    await withRealPg(`own_invite_replace_${order === "Your servers first" ? "connect" : "revoke"}_first`, async (observer) => {
      const db = getDb();
      const x = await seedEndedOwnSource(db, `own-replace-${randomBytes(3).toString("hex")}`);
      const old = await seedOwnEmailInvite(db, x);
      // The fixture's own first "Your servers" left an accepted host_direct invite to X.
      const before = new Set((await invitesTo(db, x.hLocal, old.email)).map((row) => row.id));
      // The revoke's own write (status 'revoked'), not an earlier update of the table (expireLapsedInvites).
      const atRevokeWrite = (text: string, values: readonly unknown[]) => /^\s*update "channel_external_invites" set/i.test(text) && values.includes("revoked");
      const pause = pauseQuery(atRevokeWrite);
      try {
        const first = order === "Your servers first"
          ? start(() => connectOwnServersToChannel(x.hLocal, x.x.id, [x.s.id], {}))
          : start(() => revokeExternalInvite(x.hLocal, old.id, x.hostOwner.id));
        await pause.atPause;
        const second = order === "Your servers first"
          ? start(() => revokeExternalInvite(x.hLocal, old.id, x.hostOwner.id))
          : start(() => connectOwnServersToChannel(x.hLocal, x.x.id, [x.s.id], {}));
        await until(observer, "the second to wait on the first", waitingOn("%"));
        const waits = await lockWaits(observer);
        pause.release();
        const results = { first: await first, second: await second };
        const connect = order === "Your servers first" ? results.first : results.second;
        const revoke = order === "Your servers first" ? results.second : results.first;
        assertAllOk({ connect });
        const rows = await invitesTo(db, x.hLocal, old.email);
        const oldNow = rows.find((row) => row.id === old.id)!;
        const fresh = rows.filter((row) => !before.has(row.id));
        assert.equal(oldNow.status, "revoked");
        if (order === "Your servers first") {
          assert.ok(!revoke.ok && /no longer pending/i.test(describeError(revoke.error)), `the admin's revoke sees it revoked: ${revoke.ok ? "succeeded" : describeError(revoke.error)}`);
          assert.equal(oldNow.revokedByUserId, x.x.id, "revoked by Your servers");
        } else {
          assertAllOk({ revoke });
          assert.equal(oldNow.revokedByUserId, x.hostOwner.id, "revoked by the admin; Your servers then took the freed slot");
        }
        assert.equal(fresh.length, 1, "exactly one new invite");
        assert.equal(fresh[0]!.origin, "host_direct");
        assert.ok(rows.filter((row) => ["pending", "awaiting_approval", "connecting"].includes(row.status)).length <= 1, "at most one open invite");
        assert.ok(waits.length > 0, `pg_locks shows the second waiting: ${JSON.stringify(waits)}`);
      } finally {
        pause.restore();
      }
    });
  }, 120_000);
}
