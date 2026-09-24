#!/usr/bin/env tsx
import "dotenv/config";
import { pathToFileURL } from "node:url";
import {
  assertInboxServingRowsIndexReady,
  assertInboxServingRowsTableExists,
  assertIndexCreationTimeouts,
  createIndexCreationPool,
  CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL,
  describeInboxServingRowsIndexStatus,
  INBOX_SERVING_ROWS_INDEX_LOCK_TIMEOUT_MS,
  INBOX_SERVING_ROWS_INDEX_STATEMENT_TIMEOUT_MS,
  INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME,
  readInboxServingRowsIndexStatus,
} from "./inbox-serving-rows-receiver-server-index.js";

export type InboxServingRowsIndexCreationDependencies = {
  createPool: typeof createIndexCreationPool;
  assertTimeouts: typeof assertIndexCreationTimeouts;
  assertTableExists: typeof assertInboxServingRowsTableExists;
  readStatus: typeof readInboxServingRowsIndexStatus;
  assertReady: typeof assertInboxServingRowsIndexReady;
  describeStatus: typeof describeInboxServingRowsIndexStatus;
  log: (message: string) => void;
};

export const INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES:
  InboxServingRowsIndexCreationDependencies = Object.freeze({
    createPool: createIndexCreationPool,
    assertTimeouts: assertIndexCreationTimeouts,
    assertTableExists: assertInboxServingRowsTableExists,
    readStatus: readInboxServingRowsIndexStatus,
    assertReady: assertInboxServingRowsIndexReady,
    describeStatus: describeInboxServingRowsIndexStatus,
    log: console.error,
  });

export async function runInboxServingRowsIndexCreation(
  dependencies = INBOX_SERVING_ROWS_INDEX_CREATION_DEPENDENCIES,
): Promise<void> {
  const pool = dependencies.createPool();
  const client = await pool.connect();
  try {
    await dependencies.assertTimeouts(client);
    await dependencies.assertTableExists(client);
    const before = await dependencies.readStatus(client);
    if (before.exists) {
      dependencies.assertReady(before);
      dependencies.log(dependencies.describeStatus(before));
      dependencies.log(
        `${INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME} already exists; no action needed`,
      );
      return;
    }
    dependencies.log(
      `Creating ${INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_NAME} concurrently `
      + `(startup statement_timeout=${INBOX_SERVING_ROWS_INDEX_STATEMENT_TIMEOUT_MS}ms, `
      + `lock_timeout=${INBOX_SERVING_ROWS_INDEX_LOCK_TIMEOUT_MS}ms)`,
    );
    await client.query(CREATE_INBOX_SERVING_ROWS_RECEIVER_SERVER_INDEX_SQL);
    const after = await dependencies.readStatus(client);
    dependencies.assertReady(after);
    dependencies.log(dependencies.describeStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInboxServingRowsIndexCreation().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
