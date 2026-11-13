// Real-PostgreSQL proof for the joint host-side archive (PR #13168 P2): two
// removals of the last two host-side members, on independent backends,
// serialize on the joint's advisory lock, so exactly one of them sees the host
// side go empty and queues exactly one archive. PGlite runs one transaction at
// a time, so only a real server can show the second removal waiting.
//
// The first removal is a real removeHuman held open in its own transaction;
// the second is the real server-member removal route. The waiter is proven to
// be a different backend, waiting on an advisory lock, blocked by the first
// one's PID: a competitor that joined the first transaction as a savepoint
// would share its PID and never wait.
//
// Runs in `test:joint-source-preview-real-pg` (CI) and
// `test:joint-host-side-archive-real-pg`, on a random database created from
// JOINT_SOURCE_PREVIEW_REAL_PG_URL (test/jointRealPgDatabase.ts).
import assert from "node:assert/strict";
import { test } from "vitest";
import pg from "pg";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { channels, durableTasks } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { addBoundHostGuest, guestState, seedJoint } from "../test/jointHostSideArchiveFixture";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { headers } from "../routes/channels.api.fixtures";
import { getActiveJointChannelProjectionsByLocalChannel, markRead, removeHuman } from "./channelService";
import { createMessage } from "./messageService";

const TASK_KIND = "joint.host_side_archive";

async function advisoryWaiter(observer: pg.Client, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(`SELECT a.pid FROM pg_stat_activity a
      JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted AND l.locktype = 'advisory'
      WHERE a.datname = current_database() AND a.wait_event_type = 'Lock' AND a.wait_event = 'advisory'
        AND $1 = ANY(pg_blocking_pids(a.pid))`, [blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected a backend waiting on an advisory lock held by ${blockerPid}`);
}

async function settledTasks() {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const tasks = await getDb().select({ state: durableTasks.state }).from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
    if (tasks.length > 0 && tasks.every((task) => task.state !== "open")) return tasks;
    if (Date.now() > deadline) assert.fail(`archive task not settled: ${JSON.stringify(tasks)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.skipIf(skipJointRealPg)("the last two host-side removals serialize on the joint lock and archive exactly once", async () => {
  await withJointRealPgDatabase("joint_host_side_archive", async (url) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(url, 0, { humanActivityMuteFlagDefaultEnabled: true });
    const observer = new pg.Client({ connectionString: url, application_name: "jhsa-observer" });
    observer.on("error", () => {});
    await observer.connect();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let first: Promise<number> | undefined;
    let second: Promise<Response> | undefined;
    try {
      const f = await seedJoint(app.baseUrl);
      const added = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/members`, {
        method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id), body: JSON.stringify({ userId: f.hostMember.id }),
      });
      assert.equal(added.status, 200, await added.clone().text());

      // First: the host owner leaves the channel, and its transaction stays
      // open holding the joint lock.
      let firstPid = 0;
      const firstHolding = new Promise<void>((resolve, reject) => {
        first = getDb().transaction(async (tx) => {
          firstPid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
          await removeHuman(f.hostProjection.id, f.hostOwner.id, { self: true }, tx);
          resolve();
          await released;
          return firstPid;
        });
        first.catch(reject);
      });
      await firstHolding;
      const { rows: held } = await observer.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
        WHERE pid = $1 AND locktype = 'advisory' AND granted`, [firstPid]);
      assert.ok(held[0]!.n > 0, "the first removal holds the joint's advisory lock");

      // Second: a host admin removes the other host-side member from the host
      // server (a separate request, connection and backend).
      second = fetch(`${app.baseUrl}/api/servers/${f.hostServer.id}/members/${f.hostMember.id}`, {
        method: "DELETE", headers: headers(f.token.hostAdmin, f.hostServer.id), signal: AbortSignal.timeout(20_000),
      });
      const secondPid = await advisoryWaiter(observer, firstPid);
      assert.notEqual(secondPid, firstPid, "the second removal is its own backend, not a savepoint of the first");
      const { rows: tasksWhileHeld } = await observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM durable_tasks WHERE kind = $1", [TASK_KIND]);
      assert.equal(tasksWhileHeld[0]!.n, 0, "nothing queued while the first holds the lock");

      release();
      assert.equal(await first, firstPid);
      const response = await second;
      assert.equal(response.status, 200, await response.text());

      const tasks = await settledTasks();
      assert.deepEqual(tasks.map((task) => task.state), ["succeeded"], "exactly one archive intent");
      const rows = await getDb().select({ id: channels.id, archivedAt: channels.archivedAt }).from(channels)
        .where(inArray(channels.id, [f.hostProjection.id, f.peerProjection.id]));
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.archivedAt !== null), "both projections archived");
    } finally {
      release?.();
      await Promise.allSettled([first, second].filter((p) => p !== undefined));
      await observer.end().catch(() => {});
      await app.close();
    }
  });
}, 90_000);

// P3: the auto-archive ends the host's bound Guests and locks their member
// rows before J, as the archive route does. A Guest marking the channel read
// holds its member row (the read fan-out takes the channel rows FOR KEY SHARE,
// then the member rows); the archive's channel locks are FOR NO KEY UPDATE, so
// the archive waits on the reader's member row and nothing closes a cycle.
test.skipIf(skipJointRealPg)("the auto-archive waits for its bound Guest's mark-read, without a deadlock", async () => {
  await withJointRealPgDatabase("joint_host_side_archive_guest_read", async (url) => {
    installRisingWaveReadReferences();
    installQueryPauseHook();
    const app = await openTestApp(url, 0, { humanActivityMuteFlagDefaultEnabled: true });
    const observer = new pg.Client({ connectionString: url, application_name: "jhsa-guest-read-observer" });
    observer.on("error", () => {});
    await observer.connect();
    let pause: ReturnType<typeof pauseQuery> | undefined;
    let reading: Promise<unknown> | undefined;
    let leaving: Promise<Response> | undefined;
    try {
      const f = await seedJoint(app.baseUrl);
      const g = await addBoundHostGuest(f);
      const [projection] = await getActiveJointChannelProjectionsByLocalChannel(f.hostProjection.id);
      assert.ok(projection);
      const message = await createMessage(projection.canonicalChannelId, "user", f.hostOwner.id, "read me");

      // The Guest's read, paused after the fan-out holds its channel and member rows.
      pause = pauseQuery((text) => text.includes("storage.type='thread'") && text.includes("JOIN messages parent"));
      reading = markRead(g.guest.id, f.hostProjection.id, Number(message.seq));
      void reading.catch(() => {});
      await pause.atPause;

      // The last host member leaves; the auto-archive task runs right after.
      leaving = fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/leave`, {
        method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id), signal: AbortSignal.timeout(20_000),
      });
      const deadline = Date.now() + 15_000;
      let waiter: { pid: number; blocker: number; query: string } | undefined;
      while (!waiter && Date.now() < deadline) {
        const { rows } = await observer.query<{ pid: number; blocker: number; query: string }>(`SELECT a.pid, b.pid AS blocker, a.query
          FROM pg_stat_activity a JOIN pg_stat_activity b ON b.pid = ANY(pg_blocking_pids(a.pid))
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
            AND a.query ILIKE '%server_members%' AND a.query ILIKE '%FOR UPDATE%'`);
        waiter = rows[0];
        if (!waiter) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(waiter, "the archive waits on the reading Guest's member row");
      assert.notEqual(waiter.pid, waiter.blocker, "a different backend holds it");
      const { rows: [taskRow] } = await observer.query<{ n: number }>("SELECT count(*)::int AS n FROM durable_tasks WHERE kind = $1 AND state = 'open'", [TASK_KIND]);
      assert.equal(taskRow!.n, 1, "the waiter is the archive task's attempt");

      pause.release();
      await reading;
      const left = await leaving;
      assert.equal(left.status, 200, await left.text());
      const tasks = await settledTasks();
      assert.deepEqual(tasks.map((task) => task.state), ["succeeded"]);
      const [task] = await getDb().select({ attempts: durableTasks.attempts, lastError: durableTasks.lastError }).from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
      assert.deepEqual(task, { attempts: 1, lastError: null }, "first attempt, no deadlock or retry");
      const rows = await getDb().select({ archivedAt: channels.archivedAt }).from(channels)
        .where(inArray(channels.id, [f.hostProjection.id, f.peerProjection.id]));
      assert.ok(rows.length === 2 && rows.every((row) => row.archivedAt !== null), "both projections archived");
      assert.deepEqual(await guestState(f, g.guest.id), { hostMember: false, jointMember: false }, "the Guest is ended");
    } finally {
      pause?.restore();
      await Promise.allSettled([reading, leaving].filter((p) => p !== undefined));
      uninstallQueryPauseHook();
      await observer.end().catch(() => {});
      await app.close();
    }
  });
}, 90_000);
