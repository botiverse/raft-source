#!/usr/bin/env tsx
import "dotenv/config";
import {
  assertRandomIdColumnExists,
  assertRandomIdIndexReady,
  createPool,
  describeRandomIdIndexStatus,
  readRandomIdIndexStatus,
} from "./message-random-id-index.js";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertRandomIdColumnExists(client);
    const status = await readRandomIdIndexStatus(client);
    assertRandomIdIndexReady(status);
    console.error(describeRandomIdIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
