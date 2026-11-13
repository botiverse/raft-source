#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  createPool,
  describeTaskConversationIndexStatus,
  readConstraintValidated,
  readTaskConversationIndexStatus,
} from "./channels-task-conversation-indexes";
import {
  NOTIFICATION_NOT_VALID_CONSTRAINTS,
  NOTIFICATION_OUTBOX_EVENT_KEY_INDEX,
} from "../src/db/notificationOutboxIndexContract";

// db:migrate:deploy runs this after the migrations, before the post-migration
// index guard and before the new server starts (whose enqueue's ON CONFLICT
// needs the index). On a small table the notification_outbox migration built
// the index already. CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS (an
// invalid index left by an interrupted build is dropped CONCURRENTLY and built
// again), then VALIDATE of every constraint the notification migrations add
// NOT VALID. Every step is idempotent. Run it against the DIRECT (non
// "-pooler") DATABASE_URL: timeouts are session-level set_config.
const STATEMENT_TIMEOUT = process.env.NOTIFICATION_OUTBOX_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
const LOCK_TIMEOUT = process.env.NOTIFICATION_OUTBOX_INDEX_LOCK_TIMEOUT?.trim() || "30s";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const table = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'notification_outbox' AND c.relkind IN ('r', 'p')) AS exists",
    );
    // A deploy test's own migrations folder may stop before the rename; the
    // post-migration index check still guards a real deploy.
    if (table.rows[0]?.exists !== true) {
      console.log("[NOTIFICATION_OUTBOX_INDEX_SKIPPED] reason=notification_outbox absent (no unified notification migrations in this database)");
      return;
    }
    await client.query("SELECT set_config('statement_timeout', $1, false)", [STATEMENT_TIMEOUT]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", [LOCK_TIMEOUT]);
    const spec = NOTIFICATION_OUTBOX_EVENT_KEY_INDEX;
    const before = await readTaskConversationIndexStatus(client, spec);
    let build = true;
    if (before.exists && (!before.isValid || !before.isReady)) {
      console.error(describeTaskConversationIndexStatus(spec.name, before));
      console.error(`${spec.name} is invalid; dropping it concurrently to rebuild it`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
    } else if (before.exists) {
      assertTaskConversationIndexReady(spec, before);
      console.error(`${spec.name} already exists; no action needed`);
      build = false;
    }
    if (build) {
      console.error(`Creating ${spec.name} concurrently (statement_timeout=${STATEMENT_TIMEOUT}, lock_timeout=${LOCK_TIMEOUT})`);
      await client.query(spec.createSql);
      const after = await readTaskConversationIndexStatus(client, spec);
      assertTaskConversationIndexReady(spec, after);
      console.error(describeTaskConversationIndexStatus(spec.name, after));
    }
    for (const constraint of NOTIFICATION_NOT_VALID_CONSTRAINTS) {
      const status = await readConstraintValidated(client, constraint);
      if (!status.exists) throw new Error(`${constraint.name} is missing on ${constraint.table}`);
      if (status.validated) continue;
      console.error(`Validating ${constraint.name} on ${status.table}`);
      await client.query(`ALTER TABLE "${status.table}" VALIDATE CONSTRAINT "${constraint.name}"`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
