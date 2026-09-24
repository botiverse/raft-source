#!/usr/bin/env tsx
import "dotenv/config";
import {
  assertMessagesTableExists,
  assertSenderIndexReady,
  createPool,
  CREATE_SENDER_INDEX_SQL,
  describeSenderIndexStatus,
  readSenderIndexStatus,
  SENDER_INDEX_LOCK_TIMEOUT,
  SENDER_INDEX_NAME,
  SENDER_INDEX_STATEMENT_TIMEOUT,
} from "./messages-sender-index.js";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await assertMessagesTableExists(client);

    const before = await readSenderIndexStatus(client);
    if (before.exists) {
      assertSenderIndexReady(before);
      console.error(describeSenderIndexStatus(before));
      console.error(`${SENDER_INDEX_NAME} already exists; no action needed`);
      return;
    }

    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
      SENDER_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      SENDER_INDEX_LOCK_TIMEOUT,
    ]);

    console.error(
      `Creating ${SENDER_INDEX_NAME} concurrently ` +
        `(statement_timeout=${SENDER_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${SENDER_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(CREATE_SENDER_INDEX_SQL);

    const after = await readSenderIndexStatus(client);
    assertSenderIndexReady(after);
    console.error(describeSenderIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
