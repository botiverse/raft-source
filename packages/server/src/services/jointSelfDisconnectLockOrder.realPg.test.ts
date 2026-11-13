// Real-PostgreSQL lock-order proofs for a server disconnecting its own copy of
// a joint channel (POST /channels/:id/disconnect -> disconnectJointChannel)
// against deleting that server (deleteServer: servers FOR UPDATE, then J,
// then the projection's retire UPDATE and its
// departure INSERT, whose FK KEY-SHAREs the copy's channel row).
//
// The disconnect takes the actor's users row and its server's row (with the
// host's, which its audit event references, in id order) FOR KEY
// SHARE before its channel row, then the channel row FOR UPDATE, then
// lockComputedJointActor (the server row FOR SHARE, the member row, J). With
// the server row only after the channel row, each side held what the other
// waited for (channel -> server vs server -> J -> channel): a deadlock.
//
// 1. Deleting B first (paused at its first J request, B FOR UPDATE held):
//    the disconnect waits on B's row before its channel row, then answers 404
//    (B deleted) and writes nothing over the deletion's retire.
// 2. The disconnect first (paused at lockComputedJointActor's server FOR
//    SHARE, its channel row held): the deletion waits on B's row, and both
//    finish, the disconnect recorded by its actor.
// 3. A deleted B is refused under the locks ("Channel not found").
//
// Runs in `test:joint-source-preview-real-pg` (JOINT_SOURCE_PREVIEW_REAL_PG_URL).
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { test } from "vitest";
import pg from "pg";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { getDb } from "../db";
import { isInTransaction } from "../db/ambientTransaction";
import { channels, jointChannelServers, servers } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { accessTokenForTest } from "../test/integration/credentials";
import { createSeed } from "../test/integration/seed";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { setJointFlags } from "../test/jointSourceExitScenario";
import { headers } from "../routes/channels.api.fixtures";
import { acceptJointChannelInvite, createJointChannel, disconnectJointChannel } from "./channelService";
import { deleteServer } from "./serverService";

const outside = AsyncResource.bind(<T>(run: () => Promise<T>): Promise<T> => run());
const start = <T>(run: () => Promise<T>) => {
  const promise = outside(async () => {
    assert.equal(isInTransaction(), false, "a competitor must not join another transaction");
    return run();
  });
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
};

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) parts.push(e instanceof Error ? e.message : String(e));
  return parts.join(" <- ");
}

type Waiter = { pid: number; blockedBy: number[]; locktype: string | null; relation: string | null; mode: string | null; query: string };
/** Every session of this database waiting on a lock: what it waits for (pg_locks) and on whom. */
async function waiters(observer: pg.Client): Promise<Waiter[]> {
  const { rows } = await observer.query<Waiter>(`SELECT a.pid, pg_blocking_pids(a.pid) AS "blockedBy",
      l.locktype, l.relation::regclass::text AS relation, l.mode, regexp_replace(a.query, '\\s+', ' ', 'g') AS query
    FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
    WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(a.pid)) > 0
    ORDER BY a.pid`);
  return rows;
}
async function until(observer: pg.Client, what: string, test: (rows: Waiter[]) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await waiters(observer);
    if (test(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(await waiters(observer))}`);
}
/** Polls the wait graph until `done` settles; returns the first snapshot with two sessions waiting on each other. */
async function watchForCycle(observer: pg.Client, done: Promise<unknown>): Promise<Waiter[] | null> {
  let settled = false;
  void done.finally(() => { settled = true; });
  while (!settled) {
    const rows = await waiters(observer);
    const cycle = rows.some((a) => a.blockedBy.some((pid) => rows.find((b) => b.pid === pid)?.blockedBy.includes(a.pid)));
    if (cycle) return rows;
    // Polling only: the deadlock detector fires after deadlock_timeout (1s).
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

/** Host H (hostOwner) and participant B (peerOwner), joint J connected. */
async function seedJoint(db: Database, label: string) {
  await setJointFlags(db, false);
  const seed = createSeed(db);
  const hostOwner = await seed.human(), peerOwner = await seed.human();
  const h = await seed.server({ owner: hostOwner }), b = await seed.server({ owner: peerOwner });
  await db.update(servers).set({ plan: "founder" }).where(inArray(servers.id, [h.id, b.id]));
  const created = await createJointChannel({ hostServerId: h.id, createdByUserId: hostOwner.id, name: label,
    targetServerSlug: b.slug, invitedPeople: [`@${peerOwner.name}`] });
  const bLocal = (await acceptJointChannelInvite({ inviteId: created.invites[0]!.id, targetServerId: b.id, acceptedByUserId: peerOwner.id })).id;
  return { hostOwner, peerOwner, h, b, J: created.jointChannel.id, bLocal };
}

async function bProjection(db: Database, x: { b: { id: string }; bLocal: string }) {
  const [side] = await db.select({ status: jointChannelServers.status, by: jointChannelServers.disconnectedByUserId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.localChannelId, x.bLocal), eq(jointChannelServers.serverId, x.b.id)));
  const [row] = await db.select({ deletedAt: channels.deletedAt }).from(channels).where(eq(channels.id, x.bLocal));
  const [server] = await db.select({ deletedAt: servers.deletedAt }).from(servers).where(eq(servers.id, x.b.id));
  return { status: side?.status, by: side?.by ?? null, channelDeleted: row?.deletedAt !== null, serverDeleted: server?.deletedAt !== null };
}

/** POST /channels/:id/disconnect as B's owner, through the real route. */
async function selfDisconnect(baseUrl: string, token: string, x: { b: { id: string }; bLocal: string }) {
  const response = await fetch(`${baseUrl}/api/channels/${x.bLocal}/disconnect`, { method: "POST", headers: headers(token, x.b.id) });
  return { status: response.status, body: await response.text() };
}

/** Runs `body` with an app on a fresh real database, an observer connection and the query pause hook. */
async function withRealPg(label: string, body: (observer: pg.Client, baseUrl: string) => Promise<void>) {
  await withJointRealPgDatabase(label, async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0);
    const observer = new pg.Client({ connectionString: url, application_name: `${label}-observer` });
    observer.on("error", () => {});
    await observer.connect();
    installQueryPauseHook();
    try {
      await body(observer, app.baseUrl);
    } finally {
      uninstallQueryPauseHook();
      await observer.end();
      await app.close();
    }
  });
}

const atFirstJointLock = (text: string, values: readonly unknown[]) => text.includes("pg_advisory_xact_lock(hashtextextended(")
  && values.some((value) => String(value).startsWith("joint-human-membership:"));
// lockComputedJointActor's own server row lock, after the disconnect's channel row.
const atActorServerShare = (serverId: string) => (text: string, values: readonly unknown[]) =>
  /^\s*SELECT id FROM servers WHERE id=\$1::uuid FOR SHARE\s*$/i.test(text) && values[0] === serverId;

test.skipIf(skipJointRealPg)("deleting B first: B's own disconnect waits on B's server row before its channel row, then answers 404 and writes nothing", async () => {
  await withRealPg("joint_self_disconnect_delete_first", async (observer, baseUrl) => {
    const db = getDb();
    const x = await seedJoint(db, "sd-delete-first");
    const token = await accessTokenForTest(x.peerOwner.id);
    // Paused at its first J request: B FOR UPDATE held, its retire UPDATE and
    // departure INSERT (both on B's copy's channel row) still ahead.
    const pause = pauseQuery(atFirstJointLock);
    try {
      // No person: the retire records no one, so a disconnect after it would show.
      const deletion = start(() => deleteServer(x.b.id));
      await pause.atPause;
      const disconnect = start(() => selfDisconnect(baseUrl, token, x));
      const waited = await until(observer, "the disconnect to wait on B's server row", (rows) => rows.some((row) => /FROM servers WHERE id/i.test(row.query)));
      pause.release();
      const both = Promise.all([deletion, disconnect]);
      const cycle = await watchForCycle(observer, both);
      const [deleted, disconnected] = await both;
      assert.equal(cycle, null, `the disconnect and the deletion waited on each other: ${JSON.stringify(cycle)}`);
      assert.ok(deleted.ok, `the deletion failed: ${deleted.ok ? "" : describeError(deleted.error)}`);
      assert.ok(disconnected.ok, `the disconnect request failed: ${disconnected.ok ? "" : describeError(disconnected.error)}`);
      assert.ok(waited.some((row) => /FROM servers WHERE id IN \([^)]*\) ORDER BY id FOR KEY SHARE/i.test(row.query)),
        `the disconnect waited on B's row FOR KEY SHARE, before any channel row: ${JSON.stringify(waited)}`);
      assert.equal(disconnected.value.status, 404, `the disconnect answers as an unknown channel: ${disconnected.value.status} ${disconnected.value.body}`);
      assert.deepEqual(await bProjection(db, x), { status: "disconnected", by: null, channelDeleted: false, serverDeleted: true },
        "retired by the deletion (which leaves the copy's channel row), not disconnected by B's owner");
    } finally {
      pause.restore();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("B's own disconnect first: deleting B waits on B's server row, and both finish", async () => {
  await withRealPg("joint_self_disconnect_first", async (observer, baseUrl) => {
    const db = getDb();
    const x = await seedJoint(db, "sd-disconnect-first");
    const token = await accessTokenForTest(x.peerOwner.id);
    // Paused with B's channel row held FOR UPDATE, before lockComputedJointActor's server row.
    const pause = pauseQuery(atActorServerShare(x.b.id));
    try {
      const disconnect = start(() => selfDisconnect(baseUrl, token, x));
      await pause.atPause;
      const deletion = start(() => deleteServer(x.b.id));
      const waited = await until(observer, "the deletion to wait on the disconnect", (rows) => rows.length > 0);
      pause.release();
      const both = Promise.all([disconnect, deletion]);
      const cycle = await watchForCycle(observer, both);
      const [disconnected, deleted] = await both;
      assert.equal(cycle, null, `the disconnect and the deletion waited on each other: ${JSON.stringify(cycle)}`);
      assert.ok(disconnected.ok, `the disconnect request failed: ${disconnected.ok ? "" : describeError(disconnected.error)}`);
      assert.ok(deleted.ok, `the deletion failed: ${deleted.ok ? "" : describeError(deleted.error)}`);
      assert.equal(disconnected.value.status, 200, `the disconnect succeeds: ${disconnected.value.status} ${disconnected.value.body}`);
      assert.ok(waited.some((row) => /from "servers"[\s\S]*for update/i.test(row.query)),
        `the deletion waited on B's server row: ${JSON.stringify(waited)}`);
      assert.deepEqual(await bProjection(db, x), { status: "disconnected", by: x.peerOwner.id, channelDeleted: true, serverDeleted: true },
        "disconnected by B's owner first, then deleted");
    } finally {
      pause.restore();
    }
  });
}, 120_000);

test.skipIf(skipJointRealPg)("a deleted B is refused under the locks with Channel not found and nothing written", async () => {
  await withRealPg("joint_self_disconnect_deleted", async () => {
    const db = getDb();
    // Deleting B retires its projection itself; the disconnect after it
    // writes nothing over that retire.
    const x = await seedJoint(db, "sd-deleted");
    await deleteServer(x.b.id, { deletedByUserId: x.peerOwner.id });
    const retired = await bProjection(db, x);
    assert.equal(retired.serverDeleted, true, "fixture: B is deleted");
    await assert.rejects(disconnectJointChannel(x.bLocal, x.peerOwner.id), /^Error: (Joint channel|Channel) not found$/);
    assert.deepEqual(await bProjection(db, x), retired);
  });
}, 120_000);
