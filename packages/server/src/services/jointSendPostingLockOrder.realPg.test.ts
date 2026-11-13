import assert from "node:assert/strict";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { lockJointPostingAuthority } from "../lib/channelActorPermissions";
import { openTestApp } from "../test/integration/app";
import { createSeed } from "../test/integration/seed";
import { connected } from "../test/jointHumanMembershipScenarios";
import { skipJointRealPg, withJointRealPgDatabase } from "../test/jointRealPgDatabase";
import { installRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { createAgent } from "./agentService";
import { addAgent } from "./channelService";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  lockOrdinaryMessageExternalDeliveryAdmission,
} from "./externalDeliveryOutboxService";

// Prod 40P01 (messages.agent_send_transaction, #proj-o11y:058cb07b, 2026-11-05):
// two agents send into one computed-membership Joint. Each send takes the
// local joint row in lockJointPostingAuthority, then the Joint's advisory lock
// J (lockComputedJointActor), then its outbound admission locks the same row
// FOR NO KEY UPDATE. With the first lock at FOR SHARE, B held the row shared
// and waited for J while A, holding J, waited to upgrade the row past B's
// share. Taking FOR NO KEY UPDATE up front queues B on the row, before J.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function concurrentJointSends(databaseUrl: string, forSend: boolean): Promise<PromiseSettledResult<void>[]> {
  const db = getDb();
  const seed = createSeed(db);
  const x = await connected({ db, seed });
  const jointRow = x.joint.channel.id;
  const canonical = x.joint.jointChannel.canonicalChannelId;
  const agentA = await createAgent(x.a.id, `joint-send-a-${forSend}`, { runtime: "external", model: "external" });
  const agentB = await createAgent(x.a.id, `joint-send-b-${forSend}`, { runtime: "external", model: "external" });
  await addAgent(jointRow, agentA.id);
  await addAgent(jointRow, agentB.id);

  const pools: pg.Pool[] = [];
  const sender = (name: string) => {
    const url = new URL(databaseUrl);
    url.searchParams.set("application_name", name);
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    pool.on("error", () => {});
    pools.push(pool);
    return drizzle(pool, { schema });
  };
  const appB = `joint-send-b-${process.pid}-${forSend}`;
  const dbA = sender(`joint-send-a-${process.pid}-${forSend}`);
  const dbB = sender(appB);
  const send = (conn: typeof dbA, agentId: string, afterAuthority: () => Promise<void>) => conn.transaction(async (tx) => {
    await tx.execute("SET LOCAL lock_timeout = '10s'");
    await lockJointPostingAuthority(jointRow, "agent", agentId, tx, { forSend });
    await afterAuthority();
    await lockOrdinaryMessageExternalDeliveryAdmission({
      executor: tx,
      authorityChannelId: jointRow,
      requestedChannelId: jointRow,
      canonicalConversationId: canonical,
      decision: { eligible: true },
    });
  });

  try {
    const aHoldsJ = deferred();
    const releaseA = deferred();
    const sendA = send(dbA, agentA.id, async () => { aHoldsJ.resolve(); await releaseA.promise; });
    await aHoldsJ.promise;
    const sendB = send(dbB, agentB.id, async () => {});
    // B queues: on J (old order, after taking the row shared) or on the row (new order).
    const observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await observer.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [appB]);
        if (waiting.rowCount) break;
        assert.ok(Date.now() < deadline, "sender B never queued behind sender A");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await observer.end();
    }
    releaseA.resolve();
    return await Promise.allSettled([sendA, sendB]);
  } finally {
    for (const pool of pools) await pool.end().catch(() => {});
  }
}

test.skipIf(skipJointRealPg)("two sends into one computed-membership Joint queue on the joint row instead of deadlocking", async () => {
  await withJointRealPgDatabase("joint_send_lock_order", async (url) => {
    installRisingWaveReadReferences();
    __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => null);
    const app = await openTestApp(url, 0, { taskV2ConversationsFlagDefaultEnabled: true });
    try {
      const fixed = await concurrentJointSends(url, true);
      assert.deepEqual(fixed.map((result) => result.status), ["fulfilled", "fulfilled"], "both sends commit");

      // Reverse check: the old FOR SHARE order deadlocks one of them.
      const old = await concurrentJointSends(url, false);
      const failures = old.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(failures.length, 1, "FOR SHARE -> J -> upgrade deadlocks one of two concurrent sends");
      const code = (failures[0]!.reason as { code?: string; cause?: { code?: string } });
      assert.equal(code.code ?? code.cause?.code, "40P01");
    } finally {
      __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
      await app.close();
    }
  });
}, 90_000);
