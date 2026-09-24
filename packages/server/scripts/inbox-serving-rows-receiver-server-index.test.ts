import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertIndexCreationDatabaseUrlIsDirectSession,
  assertIndexCreationTimeouts,
  assertInboxServingRowsIndexReady,
  CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL,
  INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME,
  type InboxServingRowsIndexStatus,
} from "./inbox-serving-rows-receiver-server-index.js";

type TimeoutClient = Parameters<typeof assertIndexCreationTimeouts>[0];

const readyStatus: InboxServingRowsIndexStatus = {
  exists: true,
  isUnique: false,
  isValid: true,
  isReady: true,
  accessMethod: "btree",
  columns: ["receiver_type", "receiver_id", "server_id", "last_activity_at"],
  predicate: null,
  definition: "receiver/server/activity index",
};

test("receiver/server index lifecycle requires the exact production-safe shape", () => {
  assert.doesNotThrow(() => assertInboxServingRowsIndexReady(readyStatus));
  assert.match(CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL, new RegExp(INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME));

  const invalidMutants: Array<[string, InboxServingRowsIndexStatus]> = [
    ["missing", { ...readyStatus, exists: false }],
    ["unique", { ...readyStatus, isUnique: true }],
    ["invalid", { ...readyStatus, isValid: false }],
    ["not ready", { ...readyStatus, isReady: false }],
    ["wrong access", { ...readyStatus, accessMethod: "hash" }],
    ["wrong order", { ...readyStatus, columns: ["receiver_id", "receiver_type", "server_id", "last_activity_at"] }],
    ["partial", { ...readyStatus, predicate: "server_id IS NOT NULL" }],
  ];

  for (const [label, mutant] of invalidMutants) {
    assert.throws(
      () => assertInboxServingRowsIndexReady(mutant),
      undefined,
      `${label} mutant must fail closed`,
    );
  }
});

test("concurrent creation requires a direct/session DSN with startup timeouts", () => {
  const direct =
    "postgresql://user:password@ep-example.ap-southeast-1.aws.neon.tech/db"
    + "?sslmode=require&options=-c%20statement_timeout=1800000%20-c%20lock_timeout=30000";
  assert.doesNotThrow(() => assertIndexCreationDatabaseUrlIsDirectSession(direct));
  assert.throws(
    () => assertIndexCreationDatabaseUrlIsDirectSession(
      direct.replace("ep-example.", "ep-example-pooler."),
    ),
    /direct\/session endpoint/,
  );
  assert.throws(
    () => assertIndexCreationDatabaseUrlIsDirectSession(
      direct.replace("%20-c%20lock_timeout=30000", ""),
    ),
    /lock_timeout=30000/,
  );
  assert.throws(
    () => assertIndexCreationDatabaseUrlIsDirectSession(
      direct.replace("statement_timeout=1800000", "statement_timeout=15000"),
    ),
    /statement_timeout=1800000/,
  );
});

test("concurrent creation verifies effective timeouts on its held session", async () => {
  const clientFor = (statementTimeout: string, lockTimeout: string) => ({
    query: async () => ({
      rows: [
        { name: "statement_timeout", setting: statementTimeout, unit: "ms" },
        { name: "lock_timeout", setting: lockTimeout, unit: "ms" },
      ],
    }),
  }) as unknown as TimeoutClient;

  await assert.doesNotReject(() => assertIndexCreationTimeouts(clientFor("1800000", "30000")));
  await assert.rejects(
    () => assertIndexCreationTimeouts(clientFor("15000", "30000")),
    /statement_timeout mismatch/,
  );
  await assert.rejects(
    () => assertIndexCreationTimeouts(clientFor("1800000", "0")),
    /lock_timeout mismatch/,
  );
});
