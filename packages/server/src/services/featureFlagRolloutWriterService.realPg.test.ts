import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { runNamedCase } from "../test/runNamedCase.js";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
  FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
  type FeatureFlagRolloutGuardrailReceiptV1,
} from "@botiverse/raft-shared";
import type { Database } from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  featureFlagConfigVersions,
  featureFlagRolloutAuditEvents,
  featureFlagRules,
  featureFlags,
} from "../db/schema.js";
import { acquireFeatureFlagLock } from "./featureFlagService.js";
import {
  createFeatureFlagRolloutWriterService,
  FeatureFlagRolloutWriteConflictError,
  type FeatureFlagRolloutWriteInput,
} from "./featureFlagRolloutWriterService.js";

const REAL_PG_URL_ENV = "FEATURE_FLAG_ROLLOUT_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.FEATURE_FLAG_ROLLOUT_REAL_PG_REQUIRED === "1";
const CONTROL_PLANE_ID = "production";
const SERVER_A = "00000000-0000-4000-8000-0000000000a1";
const SERVER_B = "00000000-0000-4000-8000-0000000000b2";
const RECEIPT_A = "00000000-0000-4000-8000-0000000000d1";
const RECEIPT_B = "00000000-0000-4000-8000-0000000000d2";
const NOW_MS = Date.parse("2026-07-11T00:00:30.000Z");
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

type AdvisoryLockRow = {
  application_name: string;
  pid: number;
  granted: boolean;
  classid: string;
  objid: string;
  blocking_pids: number[];
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function baseInput(
  flagKey: string,
  intent: FeatureFlagRolloutWriteInput["intent"],
  overrides: Partial<FeatureFlagRolloutWriteInput> = {},
): FeatureFlagRolloutWriteInput {
  return {
    requestId: `real-pg-${flagKey}`,
    reason: `exercise real PostgreSQL serialization for ${flagKey}`,
    flagKey,
    intent,
    actor: { type: "human", id: "operator-real-pg" },
    ...overrides,
  };
}

function passingReceipt(input: {
  id: string;
  flagKey: string;
  configVersion: number;
  operation: FeatureFlagRolloutGuardrailReceiptV1["operation"];
}): FeatureFlagRolloutGuardrailReceiptV1 {
  return {
    schema: FEATURE_FLAG_ROLLOUT_GUARDRAIL_SCHEMA,
    id: input.id,
    verdict: "pass",
    issuer: FEATURE_FLAG_ROLLOUT_GUARDRAIL_ISSUER,
    controlPlaneId: CONTROL_PLANE_ID,
    flagKey: input.flagKey,
    configVersion: input.configVersion,
    operation: input.operation,
    policyVersion: FEATURE_FLAG_ROLLOUT_GUARDRAIL_POLICY_VERSION,
    evaluatedAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-11T00:01:00.000Z",
  };
}

function makeDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema }) as Database;
}

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

async function resetRolloutTables(db: Database): Promise<void> {
  await db.execute(sql.raw(`
    TRUNCATE TABLE
      "feature_flag_rollout_audit_events",
      "feature_flag_rules",
      "feature_flags",
      "feature_flag_config_versions"
    CASCADE
  `));
}

async function insertFlag(db: Database, flagKey: string): Promise<void> {
  await db.insert(featureFlags).values({
    key: flagKey,
    randomizationUnit: "server",
    defaultEnabled: false,
    killSwitch: false,
    salt: `${flagKey}-salt`,
  });
}

async function currentConfigVersion(db: Database): Promise<number> {
  const [row] = await db.select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, "global"));
  return row?.version ?? 0;
}

async function auditRows(db: Database) {
  return db.select().from(featureFlagRolloutAuditEvents)
    .orderBy(asc(featureFlagRolloutAuditEvents.configVersionAfter));
}

async function advisoryLockRows(observer: pg.Pool, applications: string[]): Promise<AdvisoryLockRow[]> {
  const result = await observer.query<AdvisoryLockRow>(`
    SELECT
      activity.application_name,
      activity.pid,
      locks.granted,
      locks.classid::text,
      locks.objid::text,
      pg_blocking_pids(activity.pid) AS blocking_pids
    FROM pg_stat_activity AS activity
    JOIN pg_locks AS locks ON locks.pid = activity.pid
    WHERE activity.datname = current_database()
      AND activity.application_name = ANY($1::text[])
      AND locks.locktype = 'advisory'
    ORDER BY activity.application_name, locks.granted DESC, locks.classid, locks.objid
  `, [applications]);
  return result.rows;
}

async function waitForGlobalThenFlagContention(
  observer: pg.Pool,
  holderApplication: string,
  waiterApplication: string,
): Promise<AdvisoryLockRow[]> {
  const deadline = Date.now() + 5_000;
  let latest: AdvisoryLockRow[] = [];
  while (Date.now() < deadline) {
    latest = await advisoryLockRows(observer, [holderApplication, waiterApplication]);
    const holderRows = latest.filter((row) => row.application_name === holderApplication);
    const waiterRows = latest.filter((row) => row.application_name === waiterApplication);
    const holderPid = holderRows[0]?.pid;
    if (
      holderRows.length === 2
      && holderRows.every((row) => row.granted)
      && waiterRows.length === 1
      && waiterRows[0].granted === false
      && holderPid !== undefined
      && waiterRows[0].blocking_pids.includes(holderPid)
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`did not observe global-then-flag advisory-lock contention: ${JSON.stringify(latest)}`);
}

async function waitForPerFlagContentionAfterGlobal(
  observer: pg.Pool,
  flagHolderApplication: string,
  rolloutWriterApplication: string,
): Promise<AdvisoryLockRow[]> {
  const deadline = Date.now() + 5_000;
  let latest: AdvisoryLockRow[] = [];
  while (Date.now() < deadline) {
    latest = await advisoryLockRows(observer, [flagHolderApplication, rolloutWriterApplication]);
    const holderRows = latest.filter((row) => row.application_name === flagHolderApplication);
    const writerRows = latest.filter((row) => row.application_name === rolloutWriterApplication);
    const holderPid = holderRows[0]?.pid;
    const waitingWriterLock = writerRows.find((row) => !row.granted);
    if (
      holderRows.length === 1
      && holderRows[0].granted
      && writerRows.length === 2
      && writerRows.filter((row) => row.granted).length === 1
      && waitingWriterLock
      && holderPid !== undefined
      && waitingWriterLock.blocking_pids.includes(holderPid)
    ) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`did not observe per-flag contention after the global lock: ${JSON.stringify(latest)}`);
}

test(
  "authoritative rollout writer serializes two real PostgreSQL connections",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task35_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "task35-real-pg-admin",
    });
    const pools: pg.Pool[] = [];
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      const setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "task35-real-pg-observer",
        max: 2,
      });
      const firstPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "task35-real-pg-first",
        max: 1,
      });
      const secondPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "task35-real-pg-second",
        max: 1,
      });
      pools.push(setupPool, firstPool, secondPool);
      const setupDb = makeDatabase(setupPool);
      const firstDb = makeDatabase(firstPool);
      const secondDb = makeDatabase(secondPool);

      await migrate(setupDb, { migrationsFolder: MIGRATIONS_FOLDER });

      await runNamedCase("same-flag legacy lock interop waits only after the writer owns the global lock", async () => {
        await resetRolloutTables(setupDb);
        const flagKey = "real_pg_flag_lock_interop_v0";
        await insertFlag(setupDb, flagKey);
        const flagLockAcquired = deferred();
        const releaseFlagLock = deferred();
        const flagHolder = firstDb.transaction(async (tx) => {
          await acquireFeatureFlagLock(tx, flagKey);
          flagLockAcquired.resolve();
          await releaseFlagLock.promise;
        });
        await flagLockAcquired.promise;

        const operation = {
          kind: "server_allowlist_add" as const,
          ruleId: null,
          serverId: SERVER_A,
        };
        const writer = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => passingReceipt({
              id: RECEIPT_A,
              flagKey,
              configVersion: 0,
              operation,
            }),
            nowMs: () => NOW_MS,
          },
          getDatabase: () => secondDb,
        });
        let writerSettled = false;
        const writePromise = writer(baseInput(flagKey, {
          kind: "server_allowlist_set",
          flagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_A,
          desired: "present",
        }, { receiptId: RECEIPT_A, requestId: "real-pg-flag-lock-interop" }));
        void writePromise.then(
          () => { writerSettled = true; },
          () => { writerSettled = true; },
        );

        let lockRows: AdvisoryLockRow[];
        try {
          lockRows = await waitForPerFlagContentionAfterGlobal(
            setupPool,
            "task35-real-pg-first",
            "task35-real-pg-second",
          );
          assert.equal(writerSettled, false);
        } finally {
          releaseFlagLock.resolve();
        }
        assert.equal(
          lockRows.filter((row) => (
            row.application_name === "task35-real-pg-second" && row.granted
          )).length,
          1,
          "authoritative writer takes the global lock before waiting on the shared flag lock",
        );
        const [, result] = await Promise.all([flagHolder, writePromise]);
        assert.equal(result.applied, true);
        assert.equal(await currentConfigVersion(setupDb), 1);
        assert.equal((await auditRows(setupDb)).length, 1);
      });

      await runNamedCase("same flag serializes and the second decision is a zero-write no-op", async () => {
        await resetRolloutTables(setupDb);
        const flagKey = "real_pg_same_flag_v0";
        await insertFlag(setupDb, flagKey);
        const enteredProvider = deferred();
        const releaseProvider = deferred();
        const operation = {
          kind: "server_allowlist_add" as const,
          ruleId: null,
          serverId: SERVER_A,
        };
        const firstWriter = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => {
              enteredProvider.resolve();
              await releaseProvider.promise;
              return passingReceipt({
                id: RECEIPT_A,
                flagKey,
                configVersion: 0,
                operation,
              });
            },
            nowMs: () => NOW_MS,
          },
          getDatabase: () => firstDb,
        });
        let secondProviderCalls = 0;
        const secondWriter = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => {
              secondProviderCalls += 1;
              throw new Error("serialized same-state no-op must not load a receipt");
            },
            nowMs: () => NOW_MS,
          },
          getDatabase: () => secondDb,
        });

        const firstPromise = firstWriter(baseInput(flagKey, {
          kind: "server_allowlist_set",
          flagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_A,
          desired: "present",
        }, { receiptId: RECEIPT_A, requestId: "real-pg-same-first" }));
        await enteredProvider.promise;
        let secondSettled = false;
        const secondPromise = secondWriter(baseInput(flagKey, {
          kind: "server_allowlist_set",
          flagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_A,
          desired: "present",
        }, { receiptId: RECEIPT_B, requestId: "real-pg-same-second" }));
        void secondPromise.then(
          () => { secondSettled = true; },
          () => { secondSettled = true; },
        );

        let lockRows: AdvisoryLockRow[];
        try {
          lockRows = await waitForGlobalThenFlagContention(
            setupPool,
            "task35-real-pg-first",
            "task35-real-pg-second",
          );
          assert.equal(secondSettled, false);
        } finally {
          releaseProvider.resolve();
        }
        assert.equal(
          lockRows.filter((row) => row.application_name === "task35-real-pg-first").length,
          2,
          "the holder owns global and per-flag locks",
        );
        assert.equal(
          lockRows.filter((row) => row.application_name === "task35-real-pg-second").length,
          1,
          "the waiter is stopped at the global lock before taking its per-flag lock",
        );
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        assert.equal(first.applied, true);
        assert.deepEqual(second, {
          applied: false,
          reason: "no_op",
          configVersion: 1,
        });
        assert.equal(secondProviderCalls, 0);
        assert.equal(await currentConfigVersion(setupDb), 1);
        assert.equal((await auditRows(setupDb)).length, 1);
        const rules = await setupDb.select().from(featureFlagRules)
          .where(eq(featureFlagRules.flagKey, flagKey));
        assert.equal(rules.length, 1);
        assert.deepEqual(rules[0].values, [SERVER_A]);
      });

      await runNamedCase("different flags serialize through the global version and stale work is zero-write", async () => {
        await resetRolloutTables(setupDb);
        const firstFlagKey = "real_pg_cross_flag_a_v0";
        const secondFlagKey = "real_pg_cross_flag_b_v0";
        await insertFlag(setupDb, firstFlagKey);
        await insertFlag(setupDb, secondFlagKey);
        const enteredProvider = deferred();
        const releaseProvider = deferred();
        const firstOperation = {
          kind: "server_allowlist_add" as const,
          ruleId: null,
          serverId: SERVER_A,
        };
        const firstWriter = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => {
              enteredProvider.resolve();
              await releaseProvider.promise;
              return passingReceipt({
                id: RECEIPT_A,
                flagKey: firstFlagKey,
                configVersion: 0,
                operation: firstOperation,
              });
            },
            nowMs: () => NOW_MS,
          },
          getDatabase: () => firstDb,
        });
        let staleProviderCalls = 0;
        const staleSecondWriter = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => {
              staleProviderCalls += 1;
              throw new Error("stale cross-flag work must stop before receipt loading");
            },
            nowMs: () => NOW_MS,
          },
          getDatabase: () => secondDb,
        });

        const firstPromise = firstWriter(baseInput(firstFlagKey, {
          kind: "server_allowlist_set",
          flagKey: firstFlagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_A,
          desired: "present",
        }, { receiptId: RECEIPT_A, requestId: "real-pg-cross-first" }));
        await enteredProvider.promise;
        const stalePromise = staleSecondWriter(baseInput(secondFlagKey, {
          kind: "server_allowlist_set",
          flagKey: secondFlagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_B,
          desired: "present",
        }, { receiptId: RECEIPT_B, requestId: "real-pg-cross-stale" }));
        try {
          await waitForGlobalThenFlagContention(
            setupPool,
            "task35-real-pg-first",
            "task35-real-pg-second",
          );
        } finally {
          releaseProvider.resolve();
        }
        const [first, stale] = await Promise.all([firstPromise, stalePromise]);
        assert.equal(first.applied, true);
        assert.deepEqual(stale, {
          applied: false,
          reason: "config_version_mismatch",
          configVersion: 1,
        });
        assert.equal(staleProviderCalls, 0);
        assert.deepEqual(
          await setupDb.select().from(featureFlagRules)
            .where(eq(featureFlagRules.flagKey, secondFlagKey)),
          [],
        );
        assert.equal((await auditRows(setupDb)).length, 1);

        const secondOperation = {
          kind: "server_allowlist_add" as const,
          ruleId: null,
          serverId: SERVER_B,
        };
        const retryWriter = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => passingReceipt({
              id: RECEIPT_B,
              flagKey: secondFlagKey,
              configVersion: 1,
              operation: secondOperation,
            }),
            nowMs: () => NOW_MS,
          },
          getDatabase: () => secondDb,
        });
        const retry = await retryWriter(baseInput(secondFlagKey, {
          kind: "server_allowlist_set",
          flagKey: secondFlagKey,
          expectedConfigVersion: 1,
          serverId: SERVER_B,
          desired: "present",
        }, { receiptId: RECEIPT_B, requestId: "real-pg-cross-retry" }));
        assert.equal(retry.applied, true);
        if (!retry.applied) assert.fail("fresh cross-flag retry must apply");
        assert.equal(retry.configVersionBefore, 1);
        assert.equal(retry.configVersionAfter, 2);
        assert.equal(await currentConfigVersion(setupDb), 2);
        assert.deepEqual(
          (await auditRows(setupDb)).map((row) => [
            row.flagKey,
            row.configVersionBefore,
            row.configVersionAfter,
          ]),
          [
            [firstFlagKey, 0, 1],
            [secondFlagKey, 1, 2],
          ],
        );
      });

      await runNamedCase("a bypassing connection that wins absent-row version creation trips CAS and rolls back", async () => {
        await resetRolloutTables(setupDb);
        const flagKey = "real_pg_cas_rollback_v0";
        await insertFlag(setupDb, flagKey);
        const enteredProvider = deferred();
        const releaseProvider = deferred();
        const operation = {
          kind: "server_allowlist_add" as const,
          ruleId: null,
          serverId: SERVER_A,
        };
        const writer = createFeatureFlagRolloutWriterService({
          controlPlaneId: CONTROL_PLANE_ID,
          guardrail: {
            loadTrustedReceipt: async () => {
              enteredProvider.resolve();
              await releaseProvider.promise;
              return passingReceipt({
                id: RECEIPT_A,
                flagKey,
                configVersion: 0,
                operation,
              });
            },
            nowMs: () => NOW_MS,
          },
          getDatabase: () => firstDb,
        });
        const writePromise = writer(baseInput(flagKey, {
          kind: "server_allowlist_set",
          flagKey,
          expectedConfigVersion: 0,
          serverId: SERVER_A,
          desired: "present",
        }, { receiptId: RECEIPT_A, requestId: "real-pg-cas-rollback" }));
        await enteredProvider.promise;

        // Deliberately bypass the writer protocol from the second physical
        // connection. There is no version row for SELECT ... FOR UPDATE to
        // lock, so the insert wins; the authoritative writer must detect it
        // at its N->N+1 CAS and roll back mutation plus audit atomically.
        try {
          await secondPool.query(`
            INSERT INTO feature_flag_config_versions
              (scope, version, updated_by, last_audit_event_id)
            VALUES ('global', 1, 'rogue-test-connection', NULL)
          `);
        } finally {
          releaseProvider.resolve();
        }
        await assert.rejects(
          writePromise,
          (error: unknown) => (
            error instanceof FeatureFlagRolloutWriteConflictError
            && error.message === "feature flag config version insert precondition failed"
          ),
        );

        assert.equal(await currentConfigVersion(setupDb), 1, "the external winning version remains");
        assert.deepEqual(await auditRows(setupDb), [], "failed transaction leaves no audit row");
        assert.deepEqual(
          await setupDb.select().from(featureFlagRules)
            .where(eq(featureFlagRules.flagKey, flagKey)),
          [],
          "mutation before the failed CAS is rolled back",
        );
      });
    } finally {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
