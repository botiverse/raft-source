// Real-PostgreSQL lock-order proofs for the host disconnecting a participant
// server (disconnectParticipantServerByHost). Its lock order, all before J:
// actor users row -> both servers rows KEY SHARE (id order) -> host channel
// row -> participant channel row -> host servers row SHARE -> the actor's host
// server_members row -> external_channels_v1 share lock ->
// lockComputedJointActor -> J.
//
// 1. Paused at its first J request (B's departure INSERT, FK to B, still
//    ahead), against deleting that
//    server (servers FOR UPDATE, then J): the deletion waits on the server
//    row the disconnect already holds, and both finish. Taking that row only
//    through an INSERT after J closes a J -> B / B -> J cycle.
//    Deleting B first (paused at its J request): the disconnect waits on B's
//    row before taking any channel row, then refuses (server_not_connected).
//    With B's row taken after the channel rows, deleting B's departure INSERT
//    (FK to B's projection channel row) closes a channel <-> B cycle.
// 2. The same pause against a rollout write turning external_channels_v1
//    off: the writer queues on the flag's exclusive lock until the disconnect
//    commits, so the flag can't change between its read and its writes.
// 3. The same pause against demoting the acting admin. The demotion waits on
//    the admin's server_members row, which the disconnect holds.
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray } from "drizzle-orm";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { channels, featureFlags, integrationAuditEvents, jointChannelServers, serverMembers, servers } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { acceptJointChannelInvite, createJointChannel, disconnectParticipantServerByHost, JointServerNotConnectedError } from "./channelService";
import { withFeatureFlagLock } from "./featureFlagService";
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

/** Host H (owner hostOwner, admin hostAdmin in the channel) and participant B. */
async function seedJoint(db: Database, label: string) {
  await setJointFlags(db, false);
  const seed = createSeed(db);
  const hostOwner = await seed.human(), hostAdmin = await seed.human(), peerOwner = await seed.human();
  const h = await seed.server({ owner: hostOwner }), b = await seed.server({ owner: peerOwner });
  await db.insert(serverMembers).values({ serverId: h.id, userId: hostAdmin.id, role: "admin" });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, b.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: label,
    targetServerSlug: b.slug, invitedPeople: [`@${peerOwner.name}`], userIds: [hostAdmin.id] });
  const bLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id })).id;
  // The one gate (#wg-rbac:#55): external_channels_v1 for the host.
  await enableExternalChannelsFlag(h.id);
  return { hostOwner, hostAdmin, peerOwner, h, b, J: created.jointChannel.id, hLocal: created.channel.id, bLocal };
}

async function bProjection(db: Database, x: { b: { id: string }; bLocal: string }) {
  const [side] = await db.select({ status: jointChannelServers.status, by: jointChannelServers.disconnectedByUserId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, x.bLocal), eq(jointChannelServers.serverId, x.b.id)));
  const [row] = await db.select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, x.bLocal));
  return { status: side?.status, by: side?.by ?? null, deleted: row?.deletedAt !== null };
}

/** Runs `body` with an app on a fresh real database, an observer connection and the query pause hook. */
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
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

const atAuditInsert = (text: string) => /^\s*insert into "integration_audit_events"/i.test(text);

const atFirstJointLock = (text: string, values: readonly unknown[]) => text.includes("pg_advisory_xact_lock(hashtextextended(")
  && values.some((value) => String(value).startsWith("joint-human-membership:"));

{
  // Paused at its first J request, B's departure INSERT (FK to B) still ahead.
  test.skipIf(skipJointRealPg)("host disconnect holds the participant's server row before J, so deleting that server cannot deadlock it (paused at the first J lock)", async () => {
    await withRealPg("joint_host_disconnect_delete_computed", async (observer) => {
      const db = getDb();
      const x = await seedJoint(db, "hd-delete-c");
      const pause = pauseQuery(atFirstJointLock);
      try {
        const disconnect = start(() => disconnectParticipantServerByHost(x.hLocal, x.b.id, x.hostOwner.id));
        await pause.atPause;
        const deletion = start(() => deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id }));
        // Wherever the deletion waits (B's row with the fix), it waits on the paused disconnect.
        await until(observer, "the deletion to wait on the disconnect", waitingOn("%"));
        const { rows } = await observer.query<{ query: string }>(`SELECT query FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`);
        pause.release();
        const results = { disconnect: await disconnect, deletion: await deletion };
        assertAllOk(results);
        assert.ok(rows.some((row) => /from "servers"[\s\S]*for update/i.test(row.query)), `the deletion waited on B's server row: ${JSON.stringify(rows)}`);
        assert.deepEqual(await bProjection(db, x), { status: "disconnected", by: x.hostOwner.id, deleted: true }, "disconnected by the host first");
        const [server] = await db.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, x.b.id));
        assert.notEqual(server?.deletedAt, null, "then deleted");
        const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_disconnected"));
        assert.deepEqual(audit.map((row) => row.serverId).sort(), [x.h.id, x.b.id].sort());
      } finally {
        pause.restore();
      }
    });
  }, 120_000);
}

test.skipIf(skipJointRealPg)("deleting the participant server first: the disconnect waits on its row before any channel row, then refuses with server_not_connected and writes nothing", async () => {
  await withRealPg("joint_host_disconnect_delete_first", async (observer) => {
    const db = getDb();
    const x = await seedJoint(db, "hd-delete-first");
    // The deletion, paused at its first J request: it holds B FOR UPDATE, and
    // its departure INSERT (FK to B's projection channel row) is still ahead.
    const pause = pauseQuery(atFirstJointLock);
    try {
      const deletion = start(() => deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id }));
      await pause.atPause;
      const disconnect = start(() => disconnectParticipantServerByHost(x.hLocal, x.b.id, x.hostOwner.id));
      await until(observer, "the disconnect to wait on B's server row", waitingOn("%FROM servers WHERE id IN%FOR KEY SHARE%"));
      pause.release();
      const results = { deletion: await deletion, disconnect: await disconnect };
      assertAllOk({ deletion: results.deletion });
      assert.ok(!results.disconnect.ok && results.disconnect.error instanceof JointServerNotConnectedError,
        `the disconnect refuses: ${results.disconnect.ok ? "it succeeded" : describeError(results.disconnect.error)}`);
      const [side] = await db.select({ by: jointChannelServers.disconnectedByUserId }).from(jointChannelServers)
        .where(eq(jointChannelServers.localChannelId, x.bLocal));
      assert.notEqual(side?.by, x.hostOwner.id, "the deletion disconnected B, not the host");
      const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "channel.server_disconnected"));
      assert.deepEqual(audit, [], "nothing audited");
    } finally {
      pause.restore();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("external_channels_v1 is pinned: a rollout write turning it off waits for the disconnect", async () => {
  await withRealPg("joint_host_disconnect_flag", async (observer) => {
    const db = getDb();
    const x = await seedJoint(db, "hd-flag-pin");
    const pause = pauseQuery(atAuditInsert);
    try {
      const disconnect = start(() => disconnectParticipantServerByHost(x.hLocal, x.b.id, x.hostOwner.id));
      await pause.atPause;
      const flagOff = start(() => withFeatureFlagLock(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, async (tx) => {
        await tx.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY));
      }));
      await until(observer, "the flag writer to wait on the flag's lock", waitingOn("%pg_advisory_xact_lock(%"));
      pause.release();
      assertAllOk({ disconnect: await disconnect, flagOff: await flagOff });
      assert.equal((await bProjection(db, x)).status, "disconnected");
    } finally {
      pause.restore();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("demoting the acting admin waits for the disconnect on the admin's member row", async () => {
  await withRealPg("joint_host_disconnect_demote", async (observer, url) => {
    const db = getDb();
    const x = await seedJoint(db, "hd-demote");
    const pause = pauseQuery(atAuditInsert);
    const demoter = new pg.Client({ connectionString: url, application_name: "hd-demoter" });
    try {
      const disconnect = start(() => disconnectParticipantServerByHost(x.hLocal, x.b.id, x.hostAdmin.id));
      await pause.atPause;
      await demoter.connect();
      const demotion = demoter.query(`UPDATE server_members SET role = 'member' WHERE server_id = $1 AND user_id = $2`, [x.h.id, x.hostAdmin.id]);
      await until(observer, "the demotion to wait on the admin's member row", waitingOn("%UPDATE server_members%"));
      pause.release();
      assertAllOk({ disconnect: await disconnect });
      await demotion;
      assert.deepEqual(await bProjection(db, x), { status: "disconnected", by: x.hostAdmin.id, deleted: true });
    } finally {
      pause.restore();
      await demoter.end().catch(() => {});
    }
  });
}, 120_000);
