import assert from "node:assert/strict";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { connected } from "../test/jointHumanMembershipScenarios";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { lockForwardAuthorityChannels } from "./attachmentForwardService";
import { getOrCreateThreadForChannel } from "./channelService";
import { createMessage, lockSendRouteAndResolveStorage } from "./messageService";

// One lock order for a send into a Joint thread and a forward into the same
// thread: the thread's local parent P before the thread T, on both sides.
// The send (lockSendRouteAndResolveStorage) took T FOR KEY SHARE first and
// then P in lockJointPostingAuthority; the forward locked P and T FOR UPDATE
// in one `WHERE id IN (...)`, in scan order. A forward holding P and waiting
// for T against a send holding T and waiting for P: 40P01, and neither path
// retries, so a person saw a failed send (Tenny, #wg-rbac:#100, #15784).
//
// The thread is picked with id < P's id when one of a few tries gets one (ids
// are random: a low parent id can leave none), and the waiter forced onto the
// primary key index, so the old single statement locks T first: the "P held"
// case then fails for the old forward. With no such thread that one reverse
// check loses its power for the run, never its pass: the fixed forward locks
// P first whatever the ids. The send's "P held" case fails for a send that
// locks T before P regardless of ids: T is not free.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test.skipIf(skipJointRealPg)("a send into a Joint thread and a forward into it lock parent then thread, in either interleaving", async () => {
  await withJointRealPgDatabase("joint_thread_send_forward_lock_order", async (databaseUrl) => {
    installRisingWaveReadReferences();
    const app = await openTestApp(databaseUrl, 0, { taskV2ConversationsFlagDefaultEnabled: true });
    const pools: pg.Pool[] = [];
    const connection = (name: string) => {
      const url = new URL(databaseUrl);
      url.searchParams.set("application_name", name);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
      pool.on("error", () => {});
      pools.push(pool);
      return drizzle(pool, { schema });
    };
    const observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    const waitUntilQueued = async (applicationName: string, label: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await observer.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
        if (waiting.rowCount) return;
        assert.ok(Date.now() < deadline, `${label} never queued`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      const db = getDb();
      const x = await connected({ db, seed: createSeed(db) });
      const parent = x.joint.channel.id;
      const canonical = x.joint.jointChannel.canonicalChannelId;
      // Prefer a thread whose id sorts before its parent's (see the header);
      // fall back to the last one tried rather than fail on random ids.
      let thread: { id: string; canonicalThreadChannelId: string } | undefined;
      for (let attempt = 0; attempt < 24 && !(thread && thread.id < parent); attempt += 1) {
        const root = await createMessage(canonical, "user", x.owner.id, `root ${attempt}`);
        thread = await getOrCreateThreadForChannel(parent, root.id, x.owner.id, "user");
      }
      assert.ok(thread, "a Joint thread");
      const threadId = thread.id;

      const sendLocks = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => lockSendRouteAndResolveStorage(tx, {
        requestedChannelId: threadId,
        jointPostingAuthorityChannelId: parent,
        senderType: "user",
        senderId: x.owner.id,
      });
      const forwardLocks = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
        lockForwardAuthorityChannels(tx, [threadId, parent]);
      /** T is free of the side under test: a FOR UPDATE on it is granted at once. */
      const assertThreadFree = async (label: string) => {
        await db.transaction(async (tx) => {
          await tx.execute("SET LOCAL lock_timeout = '200ms'");
          await tx.execute(`SELECT id FROM channels WHERE id = '${threadId}' FOR UPDATE`);
        }).catch((error: unknown) => {
          throw new Error(`${label}: the thread row must not be locked before its parent`, { cause: error });
        });
      };

      // Each side, waiting on P: it must hold nothing on T yet.
      for (const side of ["send", "forward"] as const) {
        const holderDb = connection(`p-holder-${side}-${process.pid}`);
        const waiterName = `p-waiter-${side}-${process.pid}`;
        const waiterDb = connection(waiterName);
        const holding = deferred();
        const release = deferred();
        const holder = holderDb.transaction(async (tx) => {
          await tx.execute(`SELECT id FROM channels WHERE id = '${parent}' FOR UPDATE`);
          holding.resolve();
          await release.promise;
        });
        try {
          await bounded(holding.promise, "P holder");
          const waiter = waiterDb.transaction(async (tx) => {
            await tx.execute("SET LOCAL lock_timeout = '10s'");
            // The plan production gets on a large channels table: the primary
            // key index, rows in id order (a small test table is scanned in
            // insertion order, which happens to put P first).
            await tx.execute("SET LOCAL enable_seqscan = off");
            await tx.execute("SET LOCAL enable_bitmapscan = off");
            if (side === "send") await sendLocks(tx); else await forwardLocks(tx);
          });
          await waitUntilQueued(waiterName, `${side} behind the P holder`);
          await assertThreadFree(side);
          release.resolve();
          await bounded(Promise.all([holder, waiter]), `${side} after P released`);
        } finally {
          release.resolve();
          await holder.catch(() => {});
        }
      }

      // The two interleavings of the real pair: whichever goes first, the
      // other queues and both commit (no 40P01).
      for (const first of ["send", "forward"] as const) {
        const firstDb = connection(`first-${first}-${process.pid}`);
        const secondName = `second-after-${first}-${process.pid}`;
        const secondDb = connection(secondName);
        const run = (side: "send" | "forward", conn: typeof firstDb, hold?: { holding: () => void; release: Promise<void> }): Promise<void> =>
          conn.transaction(async (tx) => {
            await tx.execute("SET LOCAL lock_timeout = '10s'");
            if (side === "send") {
              assert.equal(await sendLocks(tx), thread!.canonicalThreadChannelId, "the send stores in the canonical thread");
            } else {
              await forwardLocks(tx);
            }
            if (hold) { hold.holding(); await hold.release; }
          });
        const holding = deferred();
        const release = deferred();
        const firstRun = run(first, firstDb, { holding: holding.resolve, release: release.promise });
        try {
          await bounded(holding.promise, `${first} taking its locks`);
          const secondRun = run(first === "send" ? "forward" : "send", secondDb);
          await waitUntilQueued(secondName, `the second side behind ${first}`);
          release.resolve();
          const settled = await bounded(Promise.allSettled([firstRun, secondRun]), `both after ${first}`);
          assert.deepEqual(settled.map((result) => result.status), ["fulfilled", "fulfilled"], `${first} first: both commit`);
        } finally {
          release.resolve();
          await firstRun.catch(() => {});
        }
      }
    } finally {
      await observer.end().catch(() => {});
      for (const pool of pools) await pool.end().catch(() => {});
      await app.close();
    }
  });
}, 90_000);
