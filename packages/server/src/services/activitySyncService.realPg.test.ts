import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import argon2 from "argon2";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { SnapshotIngress } from "@botiverse/raft-sync-core";
import { getDb } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  activitySyncChanges,
  activitySyncPrincipalAuthorities,
  activitySyncRowAuthorities,
  activitySyncRows,
  activitySyncScopes,
  channelHumans,
  channels,
  messages,
  serverMembers,
  servers,
  users,
  userChannelReadCursors,
} from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { setActivitySyncTestHooksForTest } from "./activitySyncService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const REAL_PG_URL_ENV = "ACTIVITY_SYNC_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.ACTIVITY_SYNC_REAL_PG_REQUIRED === "1";
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

function orderedOneShotTwoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (arrivals >= 2) return;
    arrivals += 1;
    const order = arrivals;
    if (arrivals === 2) release();
    await released;
    if (order === 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
}

test(
  "real PostgreSQL authenticated Activity snapshots retry concurrent first-use and existing-scope serialization",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_activity_sync_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "activity-sync-real-pg-admin",
    });
    let setupPool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "activity-sync-real-pg-setup",
        max: 2,
      });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;

      app = await openTestApp(testUrl, 0, { onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: false });
      const db = getDb();
      const password = "activity-real-pg-password";
      const passwordHash = await argon2.hash(password);
      const [owner, sender] = await db.insert(users).values([
        {
          email: `activity-real-pg-owner-${randomUUID()}@test.invalid`,
          name: `activity-real-pg-owner-${randomUUID().slice(0, 8)}`,
          passwordHash,
          emailVerified: true,
        },
        {
          email: `activity-real-pg-sender-${randomUUID()}@test.invalid`,
          name: `activity-real-pg-sender-${randomUUID().slice(0, 8)}`,
          passwordHash,
          emailVerified: true,
        },
      ]).returning();
      const [server] = await db.insert(servers).values({
        name: "Activity Sync Real PG",
        slug: `activity-sync-real-pg-${randomUUID()}`,
        ownerId: owner.id,
        plan: "founder",
      }).returning();
      await db.insert(serverMembers).values({
        serverId: server.id,
        userId: owner.id,
        role: "owner",
      });
      const [channel] = await db.insert(channels).values({
        serverId: server.id,
        name: "activity-real-pg",
        type: "channel",
      }).returning();
      await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
      await db.insert(userChannelReadCursors).values({
        userId: owner.id,
        channelId: channel.id,
        lastReadSeq: 0,
        readStateVersion: 0,
      });
      await db.insert(messages).values({
        channelId: channel.id,
        senderType: "user",
        senderId: sender.id,
        content: "first",
        seq: 1,
      });

      const login = await fetch(`${app.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: owner.email, password }),
      });
      assert.equal(login.status, 200);
      const { accessToken } = await login.json() as { accessToken: string };
      const snapshot = (requestId: string) => fetch(
        `${app!.baseUrl}/api/channels/activity/snapshot?filter=all&windowId=main`
          + `&requestId=${requestId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "X-Server-Id": server.id,
          },
        },
      );

      const assertAuthorityState = async (
        expectedCurrentRowVersion: bigint,
        expectedWatermark: bigint,
        expectedHistoricalRowVersions: bigint[],
      ) => {
        const principals = await db.select().from(activitySyncPrincipalAuthorities);
        const rowAuthorities = await db.select().from(activitySyncRowAuthorities);
        const scopes = await db.select().from(activitySyncScopes);
        const rows = await db.select().from(activitySyncRows);
        const changes = await db.select().from(activitySyncChanges);
        assert.equal(principals.length, 1);
        assert.equal(principals[0]!.rowVersion, expectedCurrentRowVersion);
        assert.equal(scopes.length, 1);
        assert.equal(scopes[0]!.watermark, expectedWatermark);
        assert.deepEqual(
          rowAuthorities.map((row) => row.lastVersion).sort(),
          [expectedCurrentRowVersion],
        );
        assert.deepEqual(
          rows.map((row) => row.rowVersion).sort(),
          [expectedCurrentRowVersion],
        );
        assert.deepEqual(
          changes.map((change) => change.seq).sort(),
          Array.from(
            { length: Number(expectedWatermark) },
            (_value, index) => BigInt(index + 1),
          ),
        );
        assert.deepEqual(
          changes
            .filter((change) => change.rowVersion !== null)
            .map((change) => change.rowVersion!)
            .sort(),
          expectedHistoricalRowVersions,
        );
      };

      const serializationFailures: Array<string | null> = [];
      const retryDisabledBarrier = orderedOneShotTwoPartyBarrier();
      setActivitySyncTestHooksForTest({
        beforePrincipalAuthorityInsert: async (executor) => {
          await executor.execute(sql`select 1 from ${users} limit 1`);
          await retryDisabledBarrier();
        },
        onSerializationFailure: (code) => {
          serializationFailures.push(code);
        },
        disableSerializationRetry: true,
      });
      const retryDisabledResponses = await Promise.all([
        snapshot("real-pg-retry-disabled-a"),
        snapshot("real-pg-retry-disabled-b"),
      ]);
      assert.deepEqual(
        retryDisabledResponses.map((response) => response.status),
        [200, 500],
        "without the retry, concurrent first use must expose the PostgreSQL serialization abort",
      );
      assert.deepEqual(serializationFailures, ["40001"]);
      await assertAuthorityState(1n, 2n, [1n]);

      await db.delete(activitySyncChanges);
      await db.delete(activitySyncRows);
      await db.delete(activitySyncScopes);
      await db.delete(activitySyncRowAuthorities);
      await db.delete(activitySyncPrincipalAuthorities);

      let serializationRetries = 0;
      const firstUseTransactionAttempts: number[] = [];
      const firstUseBarrier = orderedOneShotTwoPartyBarrier();
      setActivitySyncTestHooksForTest({
        beforePrincipalAuthorityInsert: async (executor) => {
          await executor.execute(sql`select 1 from ${users} limit 1`);
          await firstUseBarrier();
        },
        onTransactionAttemptStart: (attempt) => {
          firstUseTransactionAttempts.push(attempt);
        },
        onSerializationRetry: () => {
          serializationRetries += 1;
        },
      });
      const firstUseResponses = await Promise.all([
        snapshot("real-pg-first-use-a"),
        snapshot("real-pg-first-use-b"),
      ]);
      assert.deepEqual(firstUseResponses.map((response) => response.status), [200, 200]);
      const firstUseBodies = await Promise.all(firstUseResponses.map(
        (response) => response.json() as Promise<SnapshotIngress>,
      ));
      assert.equal(
        firstUseBodies[0]!.window.rows[0]?.rowVersion,
        firstUseBodies[1]!.window.rows[0]?.rowVersion,
      );
      assert.equal(serializationRetries, 1, "first-use must exercise exactly one real 40001 retry");
      assert.deepEqual(
        firstUseTransactionAttempts.sort(),
        [1, 1, 2],
        "the loser must re-enter through a fresh whole-transaction callback",
      );
      await assertAuthorityState(1n, 2n, [1n]);

      await db.insert(messages).values({
        channelId: channel.id,
        senderType: "user",
        senderId: sender.id,
        content: "second",
        seq: 2,
      });
      const retriesBeforeExistingScope = serializationRetries;
      const existingScopeTransactionAttempts: number[] = [];
      setActivitySyncTestHooksForTest({
        beforePrincipalAuthorityLock: orderedOneShotTwoPartyBarrier(),
        onTransactionAttemptStart: (attempt) => {
          existingScopeTransactionAttempts.push(attempt);
        },
        onSerializationRetry: () => {
          serializationRetries += 1;
        },
      });
      const existingScopeResponses = await Promise.all([
        snapshot("real-pg-existing-a"),
        snapshot("real-pg-existing-b"),
      ]);
      assert.deepEqual(existingScopeResponses.map((response) => response.status), [200, 200]);
      const existingScopeBodies = await Promise.all(existingScopeResponses.map(
        (response) => response.json() as Promise<SnapshotIngress>,
      ));
      assert.deepEqual(
        existingScopeBodies.map((body) => (
          body.window.rows.map((row) => `${row.rowId}:${row.rowVersion}`).sort()
        )),
        [
          existingScopeBodies[0]!.window.rows.map(
            (row) => `${row.rowId}:${row.rowVersion}`,
          ).sort(),
          existingScopeBodies[0]!.window.rows.map(
            (row) => `${row.rowId}:${row.rowVersion}`,
          ).sort(),
        ],
      );
      assert.equal(
        serializationRetries - retriesBeforeExistingScope,
        1,
        "existing-scope contention must exercise exactly one real 40001 retry",
      );
      assert.deepEqual(
        existingScopeTransactionAttempts.sort(),
        [1, 1, 2],
        "existing-scope loser must re-enter through a fresh whole-transaction callback",
      );
      await assertAuthorityState(2n, 4n, [1n, 2n]);
    } finally {
      setActivitySyncTestHooksForTest(null);
      if (app) await app.close();
      if (setupPool) await setupPool.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
