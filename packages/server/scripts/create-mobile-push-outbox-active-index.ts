#!/usr/bin/env -S node --import=@oxc-node/core/register
import "dotenv/config";
import {
  assertMobilePushOutboxTableExists,
  assertActiveIndexReady,
  createPool,
  createActiveIndexSql,
  describeActiveIndexStatus,
  readActiveIndexStatus,
  ACTIVE_INDEX_LOCK_TIMEOUT,
  ACTIVE_INDEX_NAME,
  ACTIVE_INDEX_STATEMENT_TIMEOUT,
} from "./mobile-push-outbox-active-index";

// The old idx_mobile_push_outbox_pending stays until a later migration drops
// it, after the drain plan is confirmed on this index.

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const table = await assertMobilePushOutboxTableExists(client);

    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [
      ACTIVE_INDEX_STATEMENT_TIMEOUT,
    ]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [
      ACTIVE_INDEX_LOCK_TIMEOUT,
    ]);

    const before = await readActiveIndexStatus(client, table);
    if (before.exists) {
      assertActiveIndexReady(before);
      console.error(describeActiveIndexStatus(before));
      console.error(`${ACTIVE_INDEX_NAME} already exists`);
      return;
    }

    console.error(
      `Creating ${ACTIVE_INDEX_NAME} on ${table} concurrently ` +
        `(statement_timeout=${ACTIVE_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${ACTIVE_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(createActiveIndexSql(table));

    const after = await readActiveIndexStatus(client, table);
    assertActiveIndexReady(after);
    console.error(describeActiveIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
