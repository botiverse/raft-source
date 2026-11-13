import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { agents, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import {
  addAgent,
  addHuman,
  createChannel,
} from "./channelService";
import {
  runChannelConversionJob,
  startChannelToJointConversion,
} from "./channelConversionService";
import {
  CHANNEL_CONVERSION_LOCK_NAMESPACE,
  setChannelConversionLockProbeForTest,
} from "./channelConversionFenceService";
import {
  lockServerResourceInTransaction,
} from "./planService";
import {
  reconfirmActionCard,
} from "./actionCardConversionService";
import {
  executeActionCard,
  prepareActionCard,
  setBeforeActionCardAttemptAuditForTest,
} from "./actionCardsService";
import { createServer as createServerService } from "./serverService";

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function lockKeyParts(serverId: string, namespace: number, resourceKey: string): [number, number] {
  const serverKey = Number.parseInt(serverId.replace(/-/g, "").slice(0, 8), 16) | 0;
  const resourceKeyHash = createHash("sha256")
    .update(`${namespace}:${resourceKey}`)
    .digest()
    .readInt32BE(0);
  return [serverKey, resourceKeyHash];
}

async function waitForPendingAdvisoryLock(
  pool: pg.Pool,
  serverId: string,
  namespace: number,
  resourceKey: string,
  timeoutMs = 2_000,
): Promise<void> {
  const [serverKey, resourceKeyHash] = lockKeyParts(serverId, namespace, resourceKey);
  const serverOid = serverKey < 0 ? serverKey + 2 ** 32 : serverKey;
  const resourceOid = resourceKeyHash < 0 ? resourceKeyHash + 2 ** 32 : resourceKeyHash;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(`
      SELECT lock.pid
        FROM pg_locks lock
        JOIN pg_stat_activity activity ON activity.pid = lock.pid
       WHERE lock.locktype = 'advisory'
         AND lock.granted = false
         AND lock.classid = $1
         AND lock.objid = $2
         AND activity.state = 'active'
       LIMIT 1
    `, [serverOid, resourceOid]);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("PostgreSQL never exposed a pending advisory-lock waiter");
}

async function assertPromiseSettles<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("real-PG competitor did not settle before the bounded cleanup deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function seedFixture(prefix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${prefix}-owner@slock.test`,
    name: `${prefix}-owner`,
    displayName: `${prefix}-owner`,
    passwordHash: "not-used-by-this-test",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `${prefix}-agent`,
    runtime: "codex",
  }).returning();
  const channel = await createChannel(server.id, `${prefix}-room`, "convert me", "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:register_app",
      name: `${prefix} app`,
      clientKey: `${prefix}-app`,
      returnUrl: "https://example.com/callback",
      scopes: [],
    },
  });
  const competitorCard = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:register_app",
      name: `${prefix} competitor app`,
      clientKey: `${prefix}-competitor-app`,
      returnUrl: "https://example.com/callback",
      scopes: [],
    },
  });
  return { owner, server, channel, card, competitorCard };
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "real PostgreSQL proves lower requested-before-acquired for conversion/reconfirm",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_conversion_lock_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "channel-conversion-lock-arrival-admin",
    });
    let setupPool: pg.Pool | undefined;
    let observationPool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "channel-conversion-lock-arrival-setup",
        max: 2,
      });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observationPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "channel-conversion-lock-arrival-observer",
        max: 1,
      });

      const runScenario = async () => {
        // The audit hook runs inside execute's transaction, and the root
        // database resolves to the ambient transaction (AsyncLocalStorage).
        // A competitor started directly from the hook would therefore run as
        // a savepoint on execute's own connection and "acquire" the lock it
        // already holds. Launch it from a context bound here, outside any
        // transaction, so it gets its own connection and really competes.
        const outsideTransaction = AsyncResource.bind(<T>(run: () => Promise<T>) => run());
        const prefix = `conversion-lock-normal-${randomUUID().slice(0, 8)}`;
        const { owner, server, channel, card, competitorCard } = await seedFixture(prefix);
        let armCompetitor = false;
        let outerAcquired = false;
        let competitorRequested = false;
        let competitorAcquired = false;
        let competitorDone = false;
        let competitorWaiting = false;
        let resolveRequested!: () => void;
        const requestedObserved = new Promise<void>((resolve) => { resolveRequested = resolve; });
        let competitor: Promise<void> | null = null;

        setChannelConversionLockProbeForTest({
          serverId: server.id,
          sourceChannelId: channel.id,
          onArrival: () => {},
          // Once armed, count only exclusive events. Execute holds the key
          // shared, and background writers (the mobile push drain) take it
          // shared too and get it at once; only the competitor's conversion
          // asks for it exclusively, and that must wait.
          onRequested: (mode) => {
            if (armCompetitor && mode === "exclusive") {
              competitorRequested = true;
              resolveRequested();
            }
          },
          onAcquired: (mode) => {
            if (!armCompetitor) {
              outerAcquired = true;
              return;
            }
            if (mode === "exclusive") competitorAcquired = true;
          },
        });
        setBeforeActionCardAttemptAuditForTest(async () => {
          setBeforeActionCardAttemptAuditForTest(null);
          assert.equal(outerAcquired, true, "outer execute must hold the canonical source lock");
          armCompetitor = true;
          competitor = outsideTransaction(async () => {
            const job = await startChannelToJointConversion({
              serverId: server.id,
              sourceChannelId: channel.id,
              createdByUserId: owner.id,
            });
            assert.equal((await runChannelConversionJob(job.id)).status, "done");
            assert.equal((await getDb().transaction((tx) => reconfirmActionCard(tx, {
              messageId: competitorCard.messageId,
              userId: owner.id,
            }))).confirmationVersion, 3);
            competitorDone = true;
          });
          // Attach a rejection handler immediately. The assertion path below
          // may fail before cleanup awaits the competitor, and Node must not
          // report that bounded failure as an unhandled rejection.
          void competitor.catch(() => {});
          await assertPromiseSettles(requestedObserved);
          await waitForPendingAdvisoryLock(
            observationPool!,
            server.id,
            136,
            channel.id,
          );
          competitorWaiting = true;
          assert.equal(competitorRequested, true, "lower requested must be observed before the lock-to-audit barrier continues");
          assert.equal(competitorWaiting, true, "PostgreSQL must expose the competitor as a pending advisory-lock waiter");
          assert.equal(competitorAcquired, false, "lower acquired must remain false while stale execute holds the lock");
          assert.equal(competitorDone, false);
        });

        try {
          const executed = await executeActionCard({ webSessionFamilyId: null,
            messageId: card.messageId,
            serverId: server.id as ServerId,
            userId: owner.id,
            expectedState: "prepared",
            expectedConfirmationVersion: 1,
          });
          assert.equal(executed.metadata.state, "executed");
          await competitor;
          assert.equal(competitorDone, true);
          assert.equal(competitorAcquired, true);
        } finally {
          const pendingCompetitor = competitor as Promise<void> | null;
          if (pendingCompetitor) await assertPromiseSettles(pendingCompetitor.catch(() => {}), 15_000);
          setBeforeActionCardAttemptAuditForTest(null);
          setChannelConversionLockProbeForTest(null);
        }
      };

      await runScenario();

      // Lower-primitive delayed-query witness. Cleanup always releases the
      // query gate before awaiting the transaction, so an ordering failure is
      // bounded instead of hanging the test process.
      const delayedServerId = randomUUID();
      const delayedSourceChannelId = randomUUID();
      let requested = false;
      let acquired = false;
      let releaseQuery!: () => void;
      let resolveBeforeQuery!: () => void;
      const allowQuery = new Promise<void>((resolve) => { releaseQuery = resolve; });
      const beforeQueryObserved = new Promise<void>((resolve) => { resolveBeforeQuery = resolve; });
      setChannelConversionLockProbeForTest({
        serverId: delayedServerId,
        sourceChannelId: delayedSourceChannelId,
        onArrival: () => {},
        onRequested: () => { requested = true; },
        onAcquired: () => { acquired = true; },
        beforeQuery: async () => {
          resolveBeforeQuery();
          await allowQuery;
        },
      });
      const delayed = getDb().transaction((tx) => lockServerResourceInTransaction(
        tx,
        delayedServerId,
        CHANNEL_CONVERSION_LOCK_NAMESPACE,
        delayedSourceChannelId,
      ));
      void delayed.catch(() => {});
      try {
        await assertPromiseSettles(beforeQueryObserved);
        assert.equal(requested, false, "lower requested must remain behind the delayed advisory query");
        releaseQuery();
        await assertPromiseSettles(delayed);
        assert.equal(requested, true);
        assert.equal(acquired, true);
      } finally {
        releaseQuery();
        await assertPromiseSettles(delayed.catch(() => {}), 15_000);
        setChannelConversionLockProbeForTest(null);
      }
    } finally {
      setBeforeActionCardAttemptAuditForTest(null);
      setChannelConversionLockProbeForTest(null);
      if (app) await app.close();
      if (observationPool) await observationPool.end();
      // The observer is created after app startup and must be closed even when
      // an ordering mutation aborts the scenario before competitor cleanup.
      if (setupPool) await setupPool.end();
      try {
        // pg.Pool.end() may resolve before the backend observes socket close.
        // Ordinary DROP waits for disconnect; FORCE can emit an asynchronous
        // 57P01 on an observer client that is still completing shutdown.
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
