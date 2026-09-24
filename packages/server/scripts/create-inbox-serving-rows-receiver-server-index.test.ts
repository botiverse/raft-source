import assert from "node:assert/strict";
import { test } from "vitest";
import { runNamedCase } from "../src/test/runNamedCase.js";
import {
  INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES,
  runInboxServingRowsIndexCreation,
  type InboxServingRowsIndexCreationDependencies,
} from "./create-inbox-serving-rows-receiver-server-index.js";
import {
  assertIndexCreationTimeouts,
  createIndexCreationPool,
  CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL,
  type InboxServingRowsIndexStatus,
} from "./inbox-serving-rows-receiver-server-index.js";

type CreationPool = ReturnType<typeof createIndexCreationPool>;
type CreationClient = Awaited<ReturnType<CreationPool["connect"]>>;

const missingStatus: InboxServingRowsIndexStatus = {
  exists: false,
  isUnique: false,
  isValid: false,
  isReady: false,
  accessMethod: null,
  columns: [],
  predicate: null,
  definition: null,
};

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

type TimeoutRow = {
  name: "statement_timeout" | "lock_timeout";
  setting: string;
  unit: "ms";
};

function makeEntryFixture(timeoutRows: TimeoutRow[]): {
  dependencies: InboxServingRowsIndexCreationDependencies;
  events: string[];
  createCalls: string[];
  client: CreationClient;
} {
  const events: string[] = [];
  const createCalls: string[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes("FROM pg_settings")) {
        events.push("timeouts");
        return { rows: timeoutRows };
      }
      if (sql === CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL) {
        events.push("create");
        createCalls.push(sql);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in entry fixture: ${sql}`);
    },
    release: () => {
      events.push("release");
    },
  } as unknown as CreationClient;
  const pool = {
    connect: async () => {
      events.push("connect");
      return client;
    },
    end: async () => {
      events.push("end");
    },
  } as unknown as CreationPool;
  let statusReadCount = 0;

  const dependencies: InboxServingRowsIndexCreationDependencies = {
    ...INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES,
    createPool: () => pool,
    assertTableExists: async (receivedClient) => {
      assert.equal(receivedClient, client, "table preflight must use the held creation client");
      events.push("table");
    },
    readStatus: async (receivedClient) => {
      assert.equal(receivedClient, client, "index reads must use the held creation client");
      events.push(`status-${statusReadCount + 1}`);
      statusReadCount += 1;
      return statusReadCount === 1 ? missingStatus : readyStatus;
    },
    log: () => undefined,
  };

  return { dependencies, events, createCalls, client };
}

test("production entry binds the dedicated direct-session pool and effective-timeout preflight", () => {
  assert.equal(
    INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES.createPool,
    createIndexCreationPool,
  );
  assert.equal(
    INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES.assertTimeouts,
    assertIndexCreationTimeouts,
  );
});

test("production entry verifies timeouts on its held client before concurrent creation", async () => {
  const fixture = makeEntryFixture([
    { name: "statement_timeout", setting: "1800000", unit: "ms" },
    { name: "lock_timeout", setting: "30000", unit: "ms" },
  ]);

  await runInboxServingRowsIndexCreation(fixture.dependencies);

  assert.deepEqual(fixture.createCalls, [CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL]);
  assert.deepEqual(fixture.events, [
    "connect",
    "timeouts",
    "table",
    "status-1",
    "create",
    "status-2",
    "release",
    "end",
  ]);
});

test("production entry performs zero creates when a timeout is missing or mismatched", async () => {
  const cases: Array<{ name: string; rows: TimeoutRow[]; error: RegExp }> = [
    {
      name: "missing statement_timeout",
      rows: [{ name: "lock_timeout", setting: "30000", unit: "ms" }],
      error: /statement_timeout mismatch: expected 1800000ms, got \(missing\)/,
    },
    {
      name: "mismatched statement_timeout",
      rows: [
        { name: "statement_timeout", setting: "15000", unit: "ms" },
        { name: "lock_timeout", setting: "30000", unit: "ms" },
      ],
      error: /statement_timeout mismatch: expected 1800000ms, got 15000ms/,
    },
  ];

  for (const testCase of cases) {
    await runNamedCase(testCase.name, async () => {
      const fixture = makeEntryFixture(testCase.rows);

      await assert.rejects(
        () => runInboxServingRowsIndexCreation(fixture.dependencies),
        testCase.error,
      );

      assert.deepEqual(fixture.createCalls, []);
      assert.deepEqual(fixture.events, ["connect", "timeouts", "release", "end"]);
    });
  }
});
