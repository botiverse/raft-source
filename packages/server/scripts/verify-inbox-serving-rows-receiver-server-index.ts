#!/usr/bin/env tsx
import "dotenv/config";
import {
  assertInboxServingRowsIndexReady,
  assertInboxServingRowsTableExists,
  createPool,
  describeInboxServingRowsIndexStatus,
  readInboxServingRowsIndexStatus,
} from "./inbox-serving-rows-receiver-server-index.js";

async function main(): Promise<void> {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertInboxServingRowsTableExists(client);
    const status = await readInboxServingRowsIndexStatus(client);
    assertInboxServingRowsIndexReady(status);
    console.error(describeInboxServingRowsIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
