#!/usr/bin/env -S node --import=@oxc-node/core/register
import "dotenv/config";
import {
  assertMobilePushOutboxTableExists,
  assertActiveIndexReady,
  createPool,
  describeActiveIndexStatus,
  readActiveIndexStatus,
} from "./mobile-push-outbox-active-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const table = await assertMobilePushOutboxTableExists(client);
    const status = await readActiveIndexStatus(client, table);
    assertActiveIndexReady(status);
    console.error(describeActiveIndexStatus(status));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
