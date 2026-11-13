#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertInsertXidIndexReady,
  CREATE_INSERT_XID_INDEX_SQL,
  createPool,
  describeInsertXidIndexStatus,
  INSERT_XID_INDEX_LOCK_TIMEOUT,
  INSERT_XID_INDEX_NAME,
  INSERT_XID_INDEX_STATEMENT_TIMEOUT,
  insertXidColumnExists,
  readInsertXidIndexStatus,
} from "./messages-insert-xid-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    // db:migrate:deploy runs this after every deploy's migrations. A database
    // whose migrations do not include messages_insert_xid (a deploy test's own
    // migrations folder) has nothing to build; the post-migration index check
    // after this still guards a real deploy.
    if (!(await insertXidColumnExists(client))) {
      console.log("[MESSAGES_INSERT_XID_INDEX_SKIPPED] reason=messages.insert_xid absent (no messages_insert_xid migration in this database)");
      return;
    }
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [INSERT_XID_INDEX_STATEMENT_TIMEOUT]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [INSERT_XID_INDEX_LOCK_TIMEOUT]);

    const before = await readInsertXidIndexStatus(client);
    if (before.exists && (!before.isValid || !before.isReady)) {
      // An interrupted CREATE INDEX CONCURRENTLY leaves an invalid index that
      // IF NOT EXISTS would keep forever: drop it (CONCURRENTLY) and build it again.
      console.error(describeInsertXidIndexStatus(before));
      console.error(`${INSERT_XID_INDEX_NAME} is invalid; dropping it concurrently to rebuild it`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INSERT_XID_INDEX_NAME}"`);
    } else if (before.exists) {
      assertInsertXidIndexReady(before);
      console.error(describeInsertXidIndexStatus(before));
      console.error(`${INSERT_XID_INDEX_NAME} already exists; no action needed`);
      return;
    }

    console.error(
      `Creating ${INSERT_XID_INDEX_NAME} concurrently ` +
        `(statement_timeout=${INSERT_XID_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${INSERT_XID_INDEX_LOCK_TIMEOUT})`,
    );
    await client.query(CREATE_INSERT_XID_INDEX_SQL);
    const after = await readInsertXidIndexStatus(client);
    assertInsertXidIndexReady(after);
    console.error(describeInsertXidIndexStatus(after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
