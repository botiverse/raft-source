#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertInsertXidIndexReady,
  createPool,
  describeInsertXidIndexStatus,
  readInsertXidIndexStatus,
} from "./messages-insert-xid-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const status = await readInsertXidIndexStatus(client);
    assertInsertXidIndexReady(status);
    console.error(describeInsertXidIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
