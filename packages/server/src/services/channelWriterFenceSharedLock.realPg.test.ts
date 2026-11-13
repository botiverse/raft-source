import assert from "node:assert/strict";
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
import { addAgent, addHuman, createChannel } from "./channelService";
import {
  ACTION_CARD_SOURCE_LOCK_NAMESPACE,
  CHANNEL_CONVERSION_LOCK_NAMESPACE,
  assertChannelWritableInTransaction,
  withChannelConversionResourceLock,
  withChannelWriterFence,
} from "./channelConversionFenceService";
import { assertActionCardWritableInTransaction } from "./actionCardConversionService";
import {
  executeActionCard,
  prepareActionCard,
  setBeforeActionCardAttemptAuditForTest,
} from "./actionCardsService";
import { createServer as createServerService } from "./serverService";

// The channel writer fence is one advisory key per conversion source. Writers
// (message send, push drain, membership, action cards) take it shared and must
// not serialize against each other; conversion takes it exclusive and must
// still wait for, and then block, every writer. Action cards additionally
// serialize among themselves on their own exclusive key.

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

function lockOids(serverId: string, namespace: number, resourceKey: string): [number, number] {
  const serverKey = Number.parseInt(serverId.replace(/-/g, "").slice(0, 8), 16) | 0;
  const resourceKeyHash = createHash("sha256")
    .update(`${namespace}:${resourceKey}`)
    .digest()
    .readInt32BE(0);
  return [
    serverKey < 0 ? serverKey + 2 ** 32 : serverKey,
    resourceKeyHash < 0 ? resourceKeyHash + 2 ** 32 : resourceKeyHash,
  ];
}

async function waitForPendingAdvisoryLock(
  pool: pg.Pool,
  serverId: string,
  namespace: number,
  resourceKey: string,
  timeoutMs = 3_000,
): Promise<void> {
  const [serverOid, resourceOid] = lockOids(serverId, namespace, resourceKey);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(`
      SELECT 1
        FROM pg_locks
       WHERE locktype = 'advisory' AND granted = false AND classid = $1 AND objid = $2
       LIMIT 1
    `, [serverOid, resourceOid]);
    if (result.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL never exposed a pending waiter on advisory namespace ${namespace}`);
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
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
  const channel = await createChannel(server.id, `${prefix}-room`, "fence", "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  const prepareCard = (suffix: string) => prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:register_app",
      name: `${prefix} ${suffix}`,
      clientKey: `${prefix}-${suffix}`,
      returnUrl: "https://example.com/callback",
      scopes: [],
    },
  });
  return { owner, server, channel, prepareCard };
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "real PostgreSQL: writers share the channel fence, conversion excludes them, action cards serialize per source",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_writer_fence_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "writer-fence-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "writer-fence-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, {
        humanActivityMuteFlagDefaultEnabled: true,
      });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "writer-fence-observer", max: 1 });

      const prefix = `writer-fence-${randomUUID().slice(0, 8)}`;
      const { owner, server, channel, prepareCard } = await seedFixture(prefix);

      // 1. Two writers on the same source hold the fence at the same time.
      {
        const holderInside = gate();
        const releaseHolder = gate();
        const holder = withChannelWriterFence(channel.id, async () => {
          holderInside.open();
          await releaseHolder.opened;
        });
        void holder.catch(() => {});
        try {
          await settleWithin(holderInside.opened, "first writer entering the fence");
          await settleWithin(
            withChannelWriterFence(channel.id, async (tx) => {
              await assertChannelWritableInTransaction(tx, channel.id);
            }),
            "second writer while the first still holds the fence",
          );
        } finally {
          releaseHolder.open();
          await settleWithin(holder, "first writer");
        }
      }

      // 2. Conversion waits for a writer that holds the fence, then blocks
      //    new writers until it releases.
      {
        const writerInside = gate();
        const releaseWriter = gate();
        const writer = withChannelWriterFence(channel.id, async () => {
          writerInside.open();
          await releaseWriter.opened;
        });
        void writer.catch(() => {});
        await settleWithin(writerInside.opened, "writer entering the fence");

        let conversionAcquired = false;
        const conversionInside = gate();
        const releaseConversion = gate();
        const conversion = withChannelConversionResourceLock(server.id, channel.id, async () => {
          conversionAcquired = true;
          conversionInside.open();
          await releaseConversion.opened;
        });
        void conversion.catch(() => {});
        let blockedWriter: Promise<void> | undefined;
        try {
          await waitForPendingAdvisoryLock(observer, server.id, CHANNEL_CONVERSION_LOCK_NAMESPACE, channel.id);
          assert.equal(conversionAcquired, false, "conversion must wait while a writer holds the shared fence");

          releaseWriter.open();
          await settleWithin(writer, "writer");
          await settleWithin(conversionInside.opened, "conversion acquiring after the writer released");

          let blockedWriterEntered = false;
          blockedWriter = withChannelWriterFence(channel.id, async () => {
            blockedWriterEntered = true;
          });
          void blockedWriter.catch(() => {});
          await waitForPendingAdvisoryLock(observer, server.id, CHANNEL_CONVERSION_LOCK_NAMESPACE, channel.id);
          assert.equal(blockedWriterEntered, false, "a writer must wait while conversion holds the exclusive fence");
        } finally {
          releaseWriter.open();
          releaseConversion.open();
          await settleWithin(conversion, "conversion");
          if (blockedWriter) await settleWithin(blockedWriter, "writer queued behind conversion");
        }
      }

      // 3. Membership-style writers that also gate on an action card, on the
      //    same source, run concurrently without deadlocking. Before the split
      //    this path took the fence and then the exclusive card gate in one
      //    transaction; with a shared fence that would be a lock upgrade.
      {
        const card = await prepareCard("gate");
        const bothFenced = { count: 0, open: gate() };
        const gatedWriter = () => getDb().transaction(async (tx) => {
          await assertChannelWritableInTransaction(tx, channel.id);
          bothFenced.count += 1;
          if (bothFenced.count === 2) bothFenced.open.open();
          await bothFenced.open.opened;
          await assertActionCardWritableInTransaction(tx, server.id, card.messageId);
        });
        const results = await settleWithin(
          Promise.allSettled([gatedWriter(), gatedWriter()]),
          "two fenced writers gating on the same action card",
        );
        for (const result of results) {
          assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
        }
      }

      // 4. The same card executed twice concurrently runs its action once; the
      //    second execution waits on the action-card lock, and an ordinary
      //    writer is not blocked by the card holding its locks.
      {
        const card = await prepareCard("execute");
        let executions = 0;
        const firstInside = gate();
        const releaseFirst = gate();
        setBeforeActionCardAttemptAuditForTest(async () => {
          executions += 1;
          if (executions === 1) {
            firstInside.open();
            await releaseFirst.opened;
          }
        });
        const execute = () => executeActionCard({ webSessionFamilyId: null,
          messageId: card.messageId,
          serverId: server.id as ServerId,
          userId: owner.id,
          expectedConfirmationVersion: 1,
        });
        const first = execute();
        void first.catch(() => {});
        let second: ReturnType<typeof execute> | undefined;
        try {
          await settleWithin(firstInside.opened, "first execution reaching its audit point");
          second = execute();
          void second.catch(() => {});
          await waitForPendingAdvisoryLock(observer, server.id, ACTION_CARD_SOURCE_LOCK_NAMESPACE, channel.id);

          await settleWithin(
            withChannelWriterFence(channel.id, async () => {}),
            "ordinary writer while an action card holds its source locks",
          );

          releaseFirst.open();
          const [firstResult, secondResult] = await settleWithin(Promise.all([first, second]), "both executions");
          assert.equal(firstResult.metadata.state, "executed");
          assert.equal(secondResult.metadata.state, "executed");
          assert.equal(executions, 1, "the card action must run exactly once");
        } finally {
          releaseFirst.open();
          setBeforeActionCardAttemptAuditForTest(null);
          await settleWithin(first.catch(() => {}), "first execution cleanup", 15_000);
          if (second) await settleWithin(second.catch(() => {}), "second execution cleanup", 15_000);
        }
      }
    } finally {
      setBeforeActionCardAttemptAuditForTest(null);
      if (app) await app.close();
      if (observer) await observer.end();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
