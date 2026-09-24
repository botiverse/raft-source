#!/usr/bin/env tsx
import "dotenv/config";
import {
  assertRandomIdColumnExists,
  assertRandomIdIndexReady,
  createPool,
  CREATE_RANDOM_ID_INDEX_SQL,
  describeRandomIdIndexStatus,
  RANDOM_ID_INDEX_LOCK_TIMEOUT,
  RANDOM_ID_INDEX_NAME,
  RANDOM_ID_INDEX_STATEMENT_TIMEOUT,
  readRandomIdIndexStatus,
} from "./message-random-id-index.js";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertRandomIdColumnExists(client);

    const before = await readRandomIdIndexStatus(client);
    if (before.exists) {
      assertRandomIdIndexReady(before);
      console.error(describeRandomIdIndexStatus(before));
      console.error(`${RANDOM_ID_INDEX_NAME} already exists; no action needed`);
      return;
    }

    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
      RANDOM_ID_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      RANDOM_ID_INDEX_LOCK_TIMEOUT,
    ]);

    console.error(
      `Creating ${RANDOM_ID_INDEX_NAME} concurrently ` +
        `(statement_timeout=${RANDOM_ID_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${RANDOM_ID_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(CREATE_RANDOM_ID_INDEX_SQL);

    const after = await readRandomIdIndexStatus(client);
    assertRandomIdIndexReady(after);
    console.error(describeRandomIdIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
