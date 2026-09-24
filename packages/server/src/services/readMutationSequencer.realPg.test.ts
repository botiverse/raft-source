import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, desc, eq, inArray } from "drizzle-orm";
import pg from "pg";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  channelHumans,
  channels,
  inboxSuppressionStates,
  jointChannelServers,
  jointChannels,
  messages,
  readMutationAuthorities,
  readMutations,
  readMutationTombstones,
  serverMembers,
  servers,
  threadFollows,
  userChannelInboxStates,
  userChannelReadCursors,
  users,
} from "../db/schema.js";
import { getInboxItems } from "./channelService.js";
import { createMessage } from "./messageService.js";
import {
  admitReadMutation,
  claimNextReadMutation,
  compactTerminalReadMutations,
  drainReadMutationOutbox,
  executeReadMutationClaim,
  ReadMutationError,
} from "./readMutationSequencer.js";

const REAL_PG_URL_ENV = "READ_MUTATION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.READ_MUTATION_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(
  adminUrl: string,
  databaseName: string,
  applicationName?: string,
  boundedLockWait = false,
): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  if (applicationName) parsed.searchParams.set("application_name", applicationName);
  if (boundedLockWait) {
    parsed.searchParams.set("options", "-c lock_timeout=5000ms -c statement_timeout=10000ms");
  }
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function waitForServiceRowLock(
  observer: pg.Client,
  applicationName: string,
  minimumCount = 1,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ wait_event_type: string | null; blocking_pids: number[] }>(`
      SELECT wait_event_type, pg_blocking_pids(pid) AS blocking_pids
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1
    `, [applicationName]);
    if (result.rows.filter((row) => row.wait_event_type === "Lock" && row.blocking_pids.length > 0).length >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("read mutation admission never reached a real PostgreSQL row-lock wait");
}

async function waitForApplicationLock(
  observer: pg.Client,
  waiterApplication: string,
  blockerApplication: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const result = await observer.query<{ wait_event_type: string | null }>(`
      SELECT waiter.wait_event_type
      FROM pg_stat_activity waiter
      CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocked_by(pid)
      INNER JOIN pg_stat_activity blocker ON blocker.pid = blocked_by.pid
      WHERE waiter.datname = current_database()
        AND waiter.application_name = $1
        AND blocker.application_name = $2
    `, [waiterApplication, blockerApplication]);
    if (result.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected real PostgreSQL lock wait was not observed: ${waiterApplication} blocked by ${blockerApplication}`,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type DoneRaceTargetKind = "channel" | "thread";
type DoneRaceProjection = "local" | "joint";

async function seedDoneRaceFixture(
  targetKind: DoneRaceTargetKind,
  projection: DoneRaceProjection,
  label: string,
) {
  const [owner] = await getDb().insert(users).values({
    email: `done-race-${label}-${randomUUID()}@test.invalid`,
    name: `DoneRace${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await getDb().insert(servers).values({
    name: `Done race ${label}`,
    slug: `done-race-${label}-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });

  if (targetKind === "channel" && projection === "local") {
    const [channel] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `${label}-channel`,
      type: "channel",
    }).returning();
    await getDb().insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
    const baseline = await createMessage(channel.id, "user", owner.id, `${label} baseline`);
    return { owner, server, scopeId: channel.id, storageScopeId: channel.id, baseline };
  }

  if (targetKind === "channel") {
    const [canonical, local] = await getDb().insert(channels).values([
      { serverId: server.id, name: `${label}-canonical`, type: "joint" },
      { serverId: server.id, name: `${label}-local`, type: "joint" },
    ]).returning();
    await getDb().insert(channelHumans).values({ channelId: local.id, userId: owner.id });
    const [joint] = await getDb().insert(jointChannels).values({
      canonicalChannelId: canonical.id,
      createdByServerId: server.id,
      createdByUserId: owner.id,
      status: "active",
    }).returning();
    await getDb().insert(jointChannelServers).values({
      jointChannelId: joint.id,
      serverId: server.id,
      localChannelId: local.id,
      role: "host",
      status: "active",
    });
    const baseline = await createMessage(canonical.id, "user", owner.id, `${label} baseline`);
    return { owner, server, scopeId: local.id, storageScopeId: canonical.id, baseline };
  }

  if (projection === "local") {
    const [parentChannel] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `${label}-parent`,
      type: "channel",
    }).returning();
    await getDb().insert(channelHumans).values({ channelId: parentChannel.id, userId: owner.id });
    const parent = await createMessage(parentChannel.id, "user", owner.id, `${label} parent`);
    const [thread] = await getDb().insert(channels).values({
      serverId: server.id,
      name: `${label}-thread`,
      type: "thread",
      parentMessageId: parent.id,
    }).returning();
    await getDb().insert(threadFollows).values({
      threadChannelId: thread.id,
      followerType: "user",
      followerId: owner.id,
      parentMessageId: parent.id,
      reason: "authored",
    });
    const baseline = await createMessage(thread.id, "user", owner.id, `${label} baseline reply`);
    return { owner, server, scopeId: thread.id, storageScopeId: thread.id, baseline };
  }

  const [canonicalParent, localParent] = await getDb().insert(channels).values([
    { serverId: server.id, name: `${label}-canonical-parent`, type: "joint" },
    { serverId: server.id, name: `${label}-local-parent`, type: "joint" },
  ]).returning();
  await getDb().insert(channelHumans).values({ channelId: localParent.id, userId: owner.id });
  const [parentJoint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalParent.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: parentJoint.id,
    serverId: server.id,
    localChannelId: localParent.id,
    role: "host",
    status: "active",
  });
  const parent = await createMessage(canonicalParent.id, "user", owner.id, `${label} joint parent`);
  const [canonicalThread, localThread] = await getDb().insert(channels).values([
    {
      serverId: server.id,
      name: `${label}-canonical-thread`,
      type: "thread",
      parentMessageId: parent.id,
    },
    { serverId: server.id, name: `${label}-local-thread`, type: "thread" },
  ]).returning();
  const [threadJoint] = await getDb().insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: server.id,
    createdByUserId: owner.id,
    status: "active",
  }).returning();
  await getDb().insert(jointChannelServers).values({
    jointChannelId: threadJoint.id,
    serverId: server.id,
    localChannelId: localThread.id,
    role: "host",
    status: "active",
  });
  await getDb().insert(threadFollows).values({
    threadChannelId: localThread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parent.id,
    reason: "authored",
  });
  const baseline = await createMessage(canonicalThread.id, "user", owner.id, `${label} baseline reply`);
  return { owner, server, scopeId: localThread.id, storageScopeId: canonicalThread.id, baseline };
}

test(
  "real PostgreSQL authority row serializes admissions and lease-generation CAS fences a stolen worker",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_read_mutation_${process.pid}_${randomBytes(4).toString("hex")}`;
    const serviceApplication = `read-mutation-service-${process.pid}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "read-mutation-admin" });
    let blocker: pg.Client | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();

      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName, serviceApplication);
      await initDatabase(testUrl);
      const [owner] = await getDb().insert(users).values({
        email: `read-real-pg-${randomUUID()}@test.invalid`,
        name: `ReadRealPg${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      }).returning();
      const [server] = await getDb().insert(servers).values({
        name: "Read Real PG",
        slug: `read-real-pg-${randomUUID()}`,
        ownerId: owner.id,
      }).returning();
      await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });

      const firstMutationId = randomUUID();
      await admitReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutationId: firstMutationId,
        mutation: { kind: "global_read_all" },
      });

      blocker = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-blocker"),
      });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM read_mutation_authorities WHERE server_id = $1 AND principal_id = $2 FOR UPDATE",
        [server.id, owner.id],
      );

      let secondResolved = false;
      const secondAdmission = admitReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutationId: randomUUID(),
        mutation: { kind: "global_read_all" },
      }).then((receipt) => {
        secondResolved = true;
        return receipt;
      });
      await waitForServiceRowLock(blocker, serviceApplication);
      assert.equal(secondResolved, false, "admission must still be blocked on the shared authority row");
      await blocker.query("COMMIT");
      const second = await secondAdmission;
      assert.equal(second.authoritySeq, 2);

      const t0 = new Date("2026-07-21T00:00:00.000Z");
      const contenders = await Promise.all([
        claimNextReadMutation({
          serverId: server.id,
          principalId: owner.id,
          leaseOwner: "real-worker-a",
          leaseMs: 1_000,
          now: t0,
        }),
        claimNextReadMutation({
          serverId: server.id,
          principalId: owner.id,
          leaseOwner: "real-worker-b",
          leaseMs: 1_000,
          now: t0,
        }),
      ]);
      const [stale] = contenders.filter((candidate) => candidate !== null);
      assert.ok(stale);
      assert.equal(contenders.filter((candidate) => candidate !== null).length, 1, "only one real-PG claimant wins");

      const winner = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: "real-worker-winner",
        leaseMs: 1_000,
        now: new Date(t0.getTime() + 1_001),
      });
      assert.ok(winner);
      assert.equal(winner.leaseGeneration, stale.leaseGeneration + 1);
      await assert.rejects(
        executeReadMutationClaim({ claim: stale, now: new Date(t0.getTime() + 1_002) }),
        (error: unknown) => error instanceof ReadMutationError && error.code === "CLAIM_LOST",
      );
      assert.equal((await getDb().select().from(userChannelReadCursors)).length, 0);
      const ack = await executeReadMutationClaim({ claim: winner, now: new Date(t0.getTime() + 1_002) });
      assert.equal(ack.authoritySeq, 1);

      const secondClaim = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: "real-worker-second",
        leaseMs: 60_000,
      });
      assert.ok(secondClaim);
      await executeReadMutationClaim({ claim: secondClaim });

      const fairPrincipals = await getDb().insert(users).values([0, 1].map((index) => ({
        email: `read-real-fair-${index}-${randomUUID()}@test.invalid`,
        name: `ReadRealFair${index}${randomUUID().replaceAll("-", "").slice(0, 6)}`,
        passwordHash: "x",
        emailVerified: true,
      }))).returning();
      await getDb().insert(serverMembers).values(fairPrincipals.map((principal) => ({
        serverId: server.id,
        userId: principal.id,
        role: "member" as const,
      })));
      for (const principal of fairPrincipals) {
        await admitReadMutation({
          serverId: server.id,
          principalId: principal.id,
          mutationId: randomUUID(),
          mutation: { kind: "global_read_all" },
        });
      }
      const collisionTime = new Date("2026-07-21T00:00:05.000Z");
      await getDb().update(readMutationAuthorities).set({ workerLastScheduledAt: collisionTime }).where(and(
        eq(readMutationAuthorities.serverId, server.id),
        inArray(readMutationAuthorities.principalId, fairPrincipals.map((principal) => principal.id)),
      ));
      const sortedFairPrincipals = [...fairPrincipals].sort((left, right) => left.id.localeCompare(right.id));
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM read_mutation_authorities WHERE server_id = $1 AND principal_id = $2 FOR UPDATE",
        [server.id, sortedFairPrincipals[0]!.id],
      );
      const skippedLocked = await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-fair-skip-locked" });
      assert.deepEqual(skippedLocked, { processed: 1, failed: 0 });
      const [secondFairRow] = await getDb().select().from(readMutations).where(eq(
        readMutations.principalId,
        sortedFairPrincipals[1]!.id,
      ));
      assert.ok(secondFairRow.state === "applied" || secondFairRow.state === "retired_no_effect");
      const [lockedFairRow] = await getDb().select().from(readMutations).where(eq(
        readMutations.principalId,
        sortedFairPrincipals[0]!.id,
      ));
      assert.equal(lockedFairRow.state, "admitted");
      await blocker.query("COMMIT");
      const afterUnlock = await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-fair-after-unlock" });
      assert.deepEqual(afterUnlock, { processed: 1, failed: 0 });

      const [blockedPrincipal] = await getDb().insert(users).values({
        email: `read-real-blocked-${randomUUID()}@test.invalid`,
        name: `ReadRealBlocked${randomUUID().replaceAll("-", "").slice(0, 6)}`,
        passwordHash: "x",
        emailVerified: true,
      }).returning();
      await getDb().insert(serverMembers).values({
        serverId: server.id,
        userId: blockedPrincipal.id,
        role: "member",
      });
      const blockedFirstId = randomUUID();
      const blockedSecondId = randomUUID();
      await admitReadMutation({
        serverId: server.id,
        principalId: blockedPrincipal.id,
        mutationId: blockedFirstId,
        mutation: { kind: "global_read_all" },
      });
      const livePredecessor = await claimNextReadMutation({
        serverId: server.id,
        principalId: blockedPrincipal.id,
        leaseOwner: "real-live-predecessor",
        leaseMs: 60_000,
      });
      assert.ok(livePredecessor);
      await admitReadMutation({
        serverId: server.id,
        principalId: blockedPrincipal.id,
        mutationId: blockedSecondId,
        mutation: { kind: "global_read_all" },
      });
      assert.deepEqual(
        await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-live-predecessor-check" }),
        { processed: 0, failed: 0 },
        "a live minimum executing lease must block the later admitted mutation",
      );
      await getDb().update(readMutations).set({
        leaseExpiresAt: new Date("2000-01-01T00:00:00.000Z"),
      }).where(and(
        eq(readMutations.principalId, blockedPrincipal.id),
        eq(readMutations.mutationId, blockedFirstId),
      ));
      assert.deepEqual(
        await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-expired-predecessor" }),
        { processed: 1, failed: 0 },
        "the fair worker must reclaim an expired minimum executing lease",
      );
      const blockedRowsAfterRecovery = await getDb().select().from(readMutations).where(eq(
        readMutations.principalId,
        blockedPrincipal.id,
      )).orderBy(readMutations.authoritySeq);
      assert.ok(
        blockedRowsAfterRecovery[0]?.state === "applied"
          || blockedRowsAfterRecovery[0]?.state === "retired_no_effect",
      );
      assert.equal(blockedRowsAfterRecovery[1]?.state, "admitted");
      assert.deepEqual(
        await drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-later-admitted" }),
        { processed: 1, failed: 0 },
      );

      const concurrentPrincipals = await getDb().insert(users).values([0, 1].map((index) => ({
        email: `read-real-concurrent-${index}-${randomUUID()}@test.invalid`,
        name: `ReadRealConcurrent${index}${randomUUID().replaceAll("-", "").slice(0, 6)}`,
        passwordHash: "x",
        emailVerified: true,
      }))).returning();
      await getDb().insert(serverMembers).values(concurrentPrincipals.map((principal) => ({
        serverId: server.id,
        userId: principal.id,
        role: "member" as const,
      })));
      for (const principal of concurrentPrincipals) {
        await admitReadMutation({
          serverId: server.id,
          principalId: principal.id,
          mutationId: randomUUID(),
          mutation: { kind: "global_read_all" },
        });
      }
      const concurrentDrains = await Promise.all([
        drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-concurrent-a" }),
        drainReadMutationOutbox({ batchSize: 1, leaseOwner: "real-concurrent-b" }),
      ]);
      assert.equal(
        concurrentDrains.reduce((sum, result) => sum + result.processed, 0),
        2,
        "two fair workers must claim two distinct authorities without duplicate execution",
      );
      assert.equal(concurrentDrains.reduce((sum, result) => sum + result.failed, 0), 0);
      const concurrentRows = await getDb().select().from(readMutations).where(inArray(
        readMutations.principalId,
        concurrentPrincipals.map((principal) => principal.id),
      ));
      assert.equal(concurrentRows.length, 2);
      assert.equal(concurrentRows.every((row) => row.attemptCount === 1), true);
      assert.equal(concurrentRows.every((row) => (
        row.state === "applied" || row.state === "retired_no_effect"
      )), true);

      const [scope] = await getDb().insert(channels).values({
        serverId: server.id,
        name: "compatibility-race",
        type: "channel",
      }).returning();
      await getDb().insert(channelHumans).values({ channelId: scope.id, userId: owner.id });
      const compatibilityMutationId = randomUUID();
      await admitReadMutation({
        serverId: server.id,
        principalId: owner.id,
        mutationId: compatibilityMutationId,
        mutation: { kind: "row_read", scopeId: scope.id, throughSeq: 2 },
      });
      const compatibilityClaim = await claimNextReadMutation({
        serverId: server.id,
        principalId: owner.id,
        leaseOwner: "real-worker-compatibility",
        leaseMs: 60_000,
      });
      assert.ok(compatibilityClaim);
      const legacyWriter = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-legacy-writer"),
      });
      await legacyWriter.connect();
      try {
        const compatibilityAck = await executeReadMutationClaim({
          claim: compatibilityClaim,
          afterScopeCursorLocked: async () => {
            await legacyWriter.query(`
              INSERT INTO user_channel_read_cursors (
                user_id, channel_id, last_read_seq, read_state_version, last_applied_authority_seq
              ) VALUES ($1, $2, 9, 4, 0)
            `, [owner.id, scope.id]);
          },
        });

        await getDb().update(readMutations).set({
          terminalAt: new Date("2026-01-01T00:00:00.000Z"),
        }).where(and(
          eq(readMutations.serverId, server.id),
          eq(readMutations.principalId, owner.id),
          eq(readMutations.mutationId, compatibilityMutationId),
        ));
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT 1 FROM read_mutation_authorities WHERE server_id = $1 AND principal_id = $2 FOR UPDATE",
          [server.id, owner.id],
        );
        const compaction = compactTerminalReadMutations({ before: new Date("2026-07-20T00:00:00.000Z") });
        await waitForServiceRowLock(blocker, serviceApplication, 1);
        const replay = admitReadMutation({
          serverId: server.id,
          principalId: owner.id,
          mutationId: compatibilityMutationId,
          mutation: { kind: "row_read", scopeId: scope.id, throughSeq: 2 },
        });
        await waitForServiceRowLock(blocker, serviceApplication, 2);
        await blocker.query("COMMIT");
        const [compacted, replayed] = await Promise.all([compaction, replay]);
        assert.equal(compacted.compacted, 1);
        assert.equal(replayed.outcome, "ALREADY_TERMINAL");
        assert.equal(replayed.authoritySeq, 3);
        assert.equal(replayed.terminalDigest, compatibilityAck.terminalDigest);
      } finally {
        await legacyWriter.end();
      }
      const [compatibilityCursor] = await getDb().select().from(userChannelReadCursors);
      assert.equal(compatibilityCursor.lastReadSeq, 9, "sequencer must not overwrite a concurrent legacy insert backwards");
      assert.equal(compatibilityCursor.readStateVersion, 4, "no-effect sequenced read must preserve the legacy writer's version");
      assert.equal(compatibilityCursor.lastAppliedAuthoritySeq, 0, "no-effect sequenced read must not claim a persistent effect");
      assert.equal((await getDb().select().from(readMutationTombstones).where(and(
        eq(readMutationTombstones.serverId, server.id),
        eq(readMutationTombstones.principalId, owner.id),
        eq(readMutationTombstones.mutationId, compatibilityMutationId),
      ))).length, 1);
      assert.equal((await getDb().select().from(readMutations).where(and(
        eq(readMutations.serverId, server.id),
        eq(readMutations.principalId, owner.id),
        eq(readMutations.mutationId, compatibilityMutationId),
      ))).length, 0);
      await getDb().update(readMutations).set({
        terminalAt: new Date("2026-01-03T00:00:00.000Z"),
      }).where(inArray(readMutations.principalId, fairPrincipals.map((principal) => principal.id)));
      const maintainerResults = await Promise.all([
        compactTerminalReadMutations({ before: new Date("2026-07-20T00:00:00.000Z"), limit: 10 }),
        compactTerminalReadMutations({ before: new Date("2026-07-20T00:00:00.000Z"), limit: 10 }),
      ]);
      assert.equal(maintainerResults.reduce((sum, result) => sum + result.compacted, 0), 2);
      assert.equal((await getDb().select().from(readMutationTombstones)).length, 3);
      console.log("real_pg_executed=true independent_connection_roles=5 assertion_sites=38");
    } finally {
      if (blocker) await blocker.end().catch(() => {});
      await closeDatabase().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);

test(
  "real PostgreSQL empty fair-worker polls never scan the authority table",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_read_mutation_idle_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "read-mutation-idle-admin" });
    let observer: pg.Client | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-idle-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();

      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-idle-service");
      await initDatabase(testUrl);
      const [owner] = await getDb().insert(users).values({
        email: `read-real-idle-${randomUUID()}@test.invalid`,
        name: `ReadRealIdle${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        passwordHash: "x",
        emailVerified: true,
      }).returning();
      const [server] = await getDb().insert(servers).values({
        name: "Read Real PG Idle",
        slug: `read-real-pg-idle-${randomUUID()}`,
        ownerId: owner.id,
      }).returning();
      const authorityRows = Array.from({ length: 2_048 }, () => ({
        serverId: server.id,
        principalType: "human" as const,
        principalId: randomUUID(),
      }));
      for (let offset = 0; offset < authorityRows.length; offset += 256) {
        await getDb().insert(readMutationAuthorities).values(authorityRows.slice(offset, offset + 256));
      }

      observer = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "read-mutation-idle-observer"),
      });
      await observer.connect();
      const index = await observer.query<{ indexdef: string }>(`
        SELECT pg_get_indexdef(indexrelid) AS indexdef
        FROM pg_index
        WHERE indexrelid = 'read_mutations_worker_pending_idx'::regclass
      `);
      const indexDefinition = index.rows[0]?.indexdef ?? "";
      assert.match(indexDefinition, /read_mutations_worker_pending_idx/);
      assert.match(indexDefinition, /WHERE/);
      assert.match(indexDefinition, /admitted/);
      assert.match(indexDefinition, /executing/);
      await observer.query("SELECT pg_stat_reset_single_table_counters('read_mutation_authorities'::regclass)");

      for (let poll = 0; poll < 32; poll += 1) {
        assert.deepEqual(
          await drainReadMutationOutbox({ batchSize: 1, leaseOwner: `real-idle-${poll}` }),
          { processed: 0, failed: 0 },
        );
      }
      await closeDatabase();

      let authorityScans = { seq_scan: 0, idx_scan: 0 };
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await observer.query("SELECT pg_stat_clear_snapshot()");
        const stats = await observer.query<{ seq_scan: string; idx_scan: string }>(`
          SELECT seq_scan::text, idx_scan::text
          FROM pg_stat_user_tables
          WHERE relid = 'read_mutation_authorities'::regclass
        `);
        authorityScans = {
          seq_scan: Number(stats.rows[0]?.seq_scan ?? 0),
          idx_scan: Number(stats.rows[0]?.idx_scan ?? 0),
        };
        if (authorityScans.seq_scan === 0 && authorityScans.idx_scan === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(
        authorityScans,
        { seq_scan: 0, idx_scan: 0 },
        "empty polls must stop before touching read_mutation_authorities",
      );
      console.log("real_pg_idle_polls=32 authority_seq_scan=0 authority_idx_scan=0 authority_rows=2048");
    } finally {
      await closeDatabase().catch(() => {});
      if (observer) await observer.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);

test(
  "real PostgreSQL canonical content lock serializes composite Done with the production message writer",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_done_writer_race_${process.pid}_${randomBytes(4).toString("hex")}`;
    const serviceApplication = `b2-done-service-${process.pid}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "b2-done-admin" });
    let observer: pg.Client | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const migrationUrl = databaseUrlFor(REAL_PG_URL, databaseName, "b2-done-migrator");
      const migrationPool = new pg.Pool({ connectionString: migrationUrl, max: 2 });
      await migrate(drizzle(migrationPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await migrationPool.end();

      await initDatabase(databaseUrlFor(
        REAL_PG_URL,
        databaseName,
        serviceApplication,
        true,
      ));
      observer = new pg.Client({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName, "b2-done-observer", true),
      });
      await observer.connect();

      const matrix = (["channel", "thread"] as const).flatMap((targetKind) =>
        (["local", "joint"] as const).flatMap((projection) =>
          (["done-first", "writer-first"] as const).map((order) => ({ targetKind, projection, order })),
        ),
      );
      let observedLockWaits = 0;
      let observedWriterFirstVisibility = 0;

      for (const [index, matrixCase] of matrix.entries()) {
        const label = `${matrixCase.targetKind}-${matrixCase.projection}-${matrixCase.order}`;
        const fixture = await seedDoneRaceFixture(matrixCase.targetKind, matrixCase.projection, label);
        const throughSeq = String(fixture.baseline.seq);
        await admitReadMutation({
          serverId: fixture.server.id,
          principalId: fixture.owner.id,
          mutationId: randomUUID(),
          mutation: {
            kind: "done",
            targetKind: matrixCase.targetKind,
            scopeId: fixture.scopeId,
            throughSeq,
          },
        });
        const claim = await claimNextReadMutation({
          serverId: fixture.server.id,
          principalId: fixture.owner.id,
          leaseOwner: `b2-done-${index}`,
          leaseMs: 60_000,
        });
        assert.ok(claim);

        const writerApplication = `b2-done-writer-${process.pid}-${index}`;
        const writerPool = new pg.Pool({
          connectionString: databaseUrlFor(
            REAL_PG_URL,
            databaseName,
            writerApplication,
            true,
          ),
          max: 1,
        });
        const writerDb = drizzle(writerPool, { schema });
        let postMessage: typeof messages.$inferSelect;
        let doneAck: Awaited<ReturnType<typeof executeReadMutationClaim>>;
        try {
          if (matrixCase.order === "done-first") {
            const doneHasCanonicalLock = deferred();
            const releaseDone = deferred();
            let doneSettled = false;
            const donePromise = executeReadMutationClaim({
              claim,
              afterBoundaryCaptured: async ({ boundary }) => {
                assert.deepEqual(boundary, [{ scopeId: fixture.scopeId, throughSeq }]);
                doneHasCanonicalLock.resolve();
                await releaseDone.promise;
              },
            }).then((ack) => {
              doneSettled = true;
              return ack;
            });
            await bounded(doneHasCanonicalLock.promise, `${label}: Done content lock`);

            let writerSettled = false;
            const writerPromise = createMessage(
              fixture.storageScopeId,
              "user",
              fixture.owner.id,
              `${label} post-frontier message`,
              "chat",
              undefined,
              undefined,
              writerDb,
            ).then((message) => {
              writerSettled = true;
              return message;
            });
            try {
              await waitForApplicationLock(observer, writerApplication, serviceApplication);
              observedLockWaits += 1;
              assert.equal(writerSettled, false, "message admission must wait for Done's canonical FOR UPDATE");
              assert.equal(doneSettled, false, "the test hook must still hold the Done transaction open");
            } finally {
              releaseDone.resolve();
            }
            [doneAck, postMessage] = await bounded(
              Promise.all([donePromise, writerPromise]),
              `${label}: Done-first completion`,
            );
          } else {
            const writerHasFkLock = deferred();
            const releaseWriter = deferred();
            let writerSettled = false;
            const writerPromise = writerDb.transaction(async (tx) => {
              const message = await createMessage(
                fixture.storageScopeId,
                "user",
                fixture.owner.id,
                `${label} post-frontier message`,
                "chat",
                undefined,
                undefined,
                tx,
              );
              writerHasFkLock.resolve();
              await releaseWriter.promise;
              return message;
            }).then((message) => {
              writerSettled = true;
              return message;
            });
            await bounded(writerHasFkLock.promise, `${label}: writer FK lock`);

            let doneSettled = false;
            const donePromise = executeReadMutationClaim({ claim }).then((ack) => {
              doneSettled = true;
              return ack;
            });
            try {
              await waitForApplicationLock(observer, serviceApplication, writerApplication);
              observedLockWaits += 1;
              assert.equal(doneSettled, false, "Done must wait for message admission's FK KEY SHARE lock");
              assert.equal(writerSettled, false, "the writer transaction must still own the FK lock");
            } finally {
              releaseWriter.resolve();
            }
            [postMessage, doneAck] = await bounded(
              Promise.all([writerPromise, donePromise]),
              `${label}: writer-first completion`,
            );
          }
        } finally {
          await writerPool.end().catch(() => {});
        }

        assert.equal(doneAck.terminalReason, "effect_applied", `${label}: Done must commit its composite effect`);
        assert.deepEqual(doneAck.capturedBoundary, [{ scopeId: fixture.scopeId, throughSeq }]);
        assert.ok(
          postMessage.seq > fixture.baseline.seq,
          `${label}: the concurrent production writer must create post-S activity`,
        );
        const [latest] = await getDb()
          .select({ id: messages.id, seq: messages.seq })
          .from(messages)
          .where(eq(messages.channelId, fixture.storageScopeId))
          .orderBy(desc(messages.seq))
          .limit(1);
        assert.equal(latest?.id, postMessage.id, `${label}: post-S activity remains canonical latest content`);

        const [cursor] = await getDb().select().from(userChannelReadCursors).where(and(
          eq(userChannelReadCursors.userId, fixture.owner.id),
          eq(userChannelReadCursors.channelId, fixture.scopeId),
        ));
        assert.equal(
          cursor?.lastReadSeq,
          fixture.baseline.seq,
          `${label}: Done must not advance the cursor across the concurrent post-S message`,
        );
        const suppressions = await getDb().select().from(inboxSuppressionStates).where(and(
          eq(inboxSuppressionStates.receiverType, "user"),
          eq(inboxSuppressionStates.receiverId, fixture.owner.id),
          eq(inboxSuppressionStates.targetChannelId, fixture.scopeId),
        ));
        assert.ok(suppressions.length > 0, `${label}: Done must persist its bounded suppression rows`);
        assert.ok(
          suppressions.every((row) => (
            row.sourceChannelId === fixture.storageScopeId
            && String(row.doneThroughSeq) === throughSeq
          )),
          `${label}: suppression must stay bounded at S on canonical storage`,
        );

        if (matrixCase.order === "writer-first") {
          const [broadState] = matrixCase.targetKind === "channel"
            ? await getDb().select({ doneAt: userChannelInboxStates.doneAt })
                .from(userChannelInboxStates)
                .where(and(
                  eq(userChannelInboxStates.userId, fixture.owner.id),
                  eq(userChannelInboxStates.channelId, fixture.scopeId),
                ))
            : await getDb().select({ doneAt: threadFollows.doneAt })
                .from(threadFollows)
                .where(and(
                  eq(threadFollows.threadChannelId, fixture.scopeId),
                  eq(threadFollows.followerType, "user"),
                  eq(threadFollows.followerId, fixture.owner.id),
                ));
          assert.ok(broadState, `${label}: Done capture must retain its locked broad-state row`);
          assert.equal(
            broadState.doneAt,
            null,
            `${label}: latest>S must not set the whole-row Done marker`,
          );

          const inbox = await getInboxItems(fixture.server.id, fixture.owner.id, {
            forceCanonicalPostgres: true,
            humanActivityMuteEnabled: false,
          });
          const active = inbox.items.find((item) => matrixCase.targetKind === "thread"
            ? item.kind === "thread" && item.threadChannelId === fixture.scopeId
            : item.kind !== "thread" && item.channelId === fixture.scopeId);
          assert.ok(active, `${label}: canonical Inbox must retain the row containing post-S activity`);
          assert.equal(active.latestActivitySeq, String(postMessage.seq));
          if (active.kind === "thread") {
            assert.equal(active.latestActivityMessageId, postMessage.id);
          } else {
            assert.equal(active.lastMessageId, postMessage.id);
          }
          observedWriterFirstVisibility += 1;
        }
      }

      assert.equal(observedLockWaits, matrix.length, "every matrix case must expose a real pg_stat_activity lock wait");
      assert.equal(observedWriterFirstVisibility, 4, "all four writer-first visibility teeth must execute");
      console.log(
        `real_pg_done_writer_matrix=${matrix.length} observed_lock_waits=${observedLockWaits} writer_first_visibility=${observedWriterFirstVisibility} production_create_message=true`,
      );
    } finally {
      await closeDatabase().catch(() => {});
      if (observer) await observer.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  },
);
