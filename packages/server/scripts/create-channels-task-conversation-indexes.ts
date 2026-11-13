#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  createPool,
  describeTaskConversationIndexStatus,
  readConstraintValidated,
  readTaskConversationIndexStatus,
  TASK_CONVERSATION_INDEX_LOCK_TIMEOUT,
  TASK_CONVERSATION_INDEX_STATEMENT_TIMEOUT,
  TASK_CONVERSATION_INDEXES,
  TASK_V2_NOT_VALID_CONSTRAINTS,
  taskIdColumnExists,
} from "./channels-task-conversation-indexes";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    // db:migrate:deploy runs this after every deploy's migrations. A database
    // whose migrations do not include Task v2 (a deploy test's own migrations
    // folder) has nothing to build; the post-migration index check after this
    // still guards a real deploy.
    if (!(await taskIdColumnExists(client))) {
      console.log("[TASK_CONVERSATION_INDEXES_SKIPPED] reason=channels.task_id absent (no task v2 migrations in this database)");
      return;
    }
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [TASK_CONVERSATION_INDEX_STATEMENT_TIMEOUT]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [TASK_CONVERSATION_INDEX_LOCK_TIMEOUT]);
    for (const spec of TASK_CONVERSATION_INDEXES) {
      const before = await readTaskConversationIndexStatus(client, spec);
      if (before.exists && (!before.isValid || !before.isReady)) {
        // An interrupted CREATE INDEX CONCURRENTLY leaves an invalid index that
        // IF NOT EXISTS would keep forever: drop it (CONCURRENTLY) and build it again.
        console.error(describeTaskConversationIndexStatus(spec.name, before));
        console.error(`${spec.name} is invalid; dropping it concurrently to rebuild it`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
      } else if (before.exists) {
        assertTaskConversationIndexReady(spec, before);
        console.error(describeTaskConversationIndexStatus(spec.name, before));
        console.error(`${spec.name} already exists; no action needed`);
        continue;
      }
      console.error(
        `Creating ${spec.name} concurrently ` +
          `(statement_timeout=${TASK_CONVERSATION_INDEX_STATEMENT_TIMEOUT}, lock_timeout=${TASK_CONVERSATION_INDEX_LOCK_TIMEOUT})`,
      );
      await client.query(spec.createSql);
      const after = await readTaskConversationIndexStatus(client, spec);
      assertTaskConversationIndexReady(spec, after);
      console.error(describeTaskConversationIndexStatus(spec.name, after));
    }
    // Every constraint the task v2 migrations add NOT VALID: VALIDATE scans without blocking writes.
    for (const constraint of TASK_V2_NOT_VALID_CONSTRAINTS) {
      const before = await readConstraintValidated(client, constraint);
      if (!before.exists) throw new Error(`${constraint.name} is missing on ${constraint.table}`);
      if (before.validated) {
        console.error(`${constraint.name}: validated; no action needed`);
        continue;
      }
      console.error(`Validating ${constraint.name} on ${before.table}`);
      await client.query(`ALTER TABLE "${before.table}" VALIDATE CONSTRAINT "${constraint.name}"`);
      console.error(`${constraint.name}: validated`);
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
