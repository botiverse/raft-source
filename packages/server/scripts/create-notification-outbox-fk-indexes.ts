#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  createPool,
  describeTaskConversationIndexStatus,
  readTaskConversationIndexStatus,
} from "./channels-task-conversation-indexes";
import {
  LEGACY_UNIQUE_INDEX_LOOKUP_SQL,
  NOTIFICATION_OUTBOX_FK_INDEXES,
  NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX,
} from "../src/db/notificationOutboxIndexContract";

// Unified notifications, contract step 2. db:migrate:deploy runs this after
// the migrations, before the post-migration index guard. On a small outbox
// migration notification_outbox_fk_indexes did all of this already.
//
// 1. Build idx_notification_outbox_source_channel and
//    idx_notification_outbox_receiver CONCURRENTLY IF NOT EXISTS (an invalid
//    index left by an interrupted build is dropped CONCURRENTLY and built
//    again), and check each is valid, ready and of the expected shape.
// 2. Only then retire the old unique key idx_mobile_push_outbox_unique_fact
//    with DROP INDEX CONCURRENTLY (no ACCESS EXCLUSIVE on the table): until
//    step 1 it was the only index the channels / users delete cascades could
//    use. Gone already: said, nothing to do. Gone by name but an index of the
//    same columns exists under another name: stop, so a hand-rebuilt copy is
//    never left behind silently.
//
// Every step is idempotent. Run it against the DIRECT (non "-pooler")
// DATABASE_URL: timeouts are session-level set_config.
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
      console.log("[NOTIFICATION_OUTBOX_FK_INDEXES_SKIPPED] reason=notification_outbox absent (no unified notification migrations in this database)");
      return;
    }
    await client.query("SELECT set_config('statement_timeout', $1, false)", [STATEMENT_TIMEOUT]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", [LOCK_TIMEOUT]);

    for (const spec of NOTIFICATION_OUTBOX_FK_INDEXES) {
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
      }
      const after = await readTaskConversationIndexStatus(client, spec);
      assertTaskConversationIndexReady(spec, after);
      console.error(describeTaskConversationIndexStatus(spec.name, after));
    }

    const legacy = NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX;
    const sameShape = (await client.query<{ name: string }>(LEGACY_UNIQUE_INDEX_LOOKUP_SQL)).rows.map((row) => row.name);
    const others = sameShape.filter((name) => name !== legacy.name);
    if (others.length > 0) {
      throw new Error(
        `notification_outbox has a unique index on (${legacy.columns.join(", ")}) under another name: ${others.join(", ")}. `
        + `It is the retired key ${legacy.name}; drop it by hand (DROP INDEX CONCURRENTLY) after checking it is that copy.`,
      );
    }
    if (sameShape.includes(legacy.name)) {
      console.error(`Dropping ${legacy.name} concurrently (the delete cascades use the indexes above now)`);
      await client.query(`DROP INDEX CONCURRENTLY "${legacy.name}"`);
    } else {
      console.log(`[NOTIFICATION_OUTBOX_LEGACY_INDEX_ABSENT] ${legacy.name} does not exist; nothing to drop`);
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
