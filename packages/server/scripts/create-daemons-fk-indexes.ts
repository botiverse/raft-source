#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  createPool,
  describeTaskConversationIndexStatus,
  readTaskConversationIndexStatus,
} from "./channels-task-conversation-indexes";
import {
  DAEMONS_FK_INDEX_LOCK_TIMEOUT,
  DAEMONS_FK_INDEX_STATEMENT_TIMEOUT,
  DAEMONS_FK_INDEXES,
  daemonsFkColumnsExist,
} from "./daemons-fk-indexes";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    // db:migrate:deploy runs this after every deploy's migrations; a database
    // without these columns (a deploy test's own migrations folder) has nothing
    // to build. The post-migration index check after this still guards a real deploy.
    if (!(await daemonsFkColumnsExist(client))) {
      console.log("[DAEMONS_FK_INDEXES_SKIPPED] reason=indexed columns absent in this database");
      return;
    }
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [DAEMONS_FK_INDEX_STATEMENT_TIMEOUT]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [DAEMONS_FK_INDEX_LOCK_TIMEOUT]);
    for (const spec of DAEMONS_FK_INDEXES) {
      const before = await readTaskConversationIndexStatus(client, spec);
      if (before.exists && (!before.isValid || !before.isReady)) {
        // An interrupted CREATE INDEX CONCURRENTLY leaves an invalid index that
        // IF NOT EXISTS would keep forever: drop it (CONCURRENTLY) and build it again.
        console.error(describeTaskConversationIndexStatus(spec.name, before));
        console.error(`${spec.name} is invalid; dropping it concurrently to rebuild it`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
      } else if (before.exists) {
        assertTaskConversationIndexReady(spec, before);
        console.error(`${spec.name} already exists; no action needed`);
        continue;
      }
      console.error(
        `Creating ${spec.name} concurrently ` +
          `(statement_timeout=${DAEMONS_FK_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${DAEMONS_FK_INDEX_LOCK_TIMEOUT})`,
      );
      await client.query(spec.createSql);
      const after = await readTaskConversationIndexStatus(client, spec);
      assertTaskConversationIndexReady(spec, after);
      console.error(describeTaskConversationIndexStatus(spec.name, after));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
