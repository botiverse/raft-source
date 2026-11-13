#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import {
  assertTaskConversationIndexReady,
  createPool,
  describeTaskConversationIndexStatus,
  readTaskConversationIndexStatus,
} from "./channels-task-conversation-indexes";
import { ATTESTED_SEND_EVENTS_MESSAGE_INDEX } from "../src/db/attestedSendEventsIndexContract";

// db:migrate:deploy runs this after the migrations and before the
// post-migration index guard. The migration attested_send_events_message_index
// is SELECT 1: attested_send_events is large in production, so the index is
// built here with CREATE INDEX CONCURRENTLY IF NOT EXISTS (an invalid index
// left by an interrupted build is dropped CONCURRENTLY and built again).
// Idempotent. Run it against the DIRECT (non "-pooler") DATABASE_URL:
// timeouts are session-level set_config.
const STATEMENT_TIMEOUT = process.env.ATTESTED_SEND_EVENTS_INDEX_STATEMENT_TIMEOUT?.trim() || "30min";
const LOCK_TIMEOUT = process.env.ATTESTED_SEND_EVENTS_INDEX_LOCK_TIMEOUT?.trim() || "30s";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const table = await client.query<{ exists: boolean }>("SELECT to_regclass('public.attested_send_events') IS NOT NULL AS exists");
    // A deploy test's own migrations folder may predate the table; the
    // post-migration index check still guards a real deploy.
    if (table.rows[0]?.exists !== true) {
      console.log("[ATTESTED_SEND_EVENTS_INDEX_SKIPPED] reason=attested_send_events absent");
      return;
    }
    await client.query("SELECT set_config('statement_timeout', $1, false)", [STATEMENT_TIMEOUT]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", [LOCK_TIMEOUT]);
    const spec = ATTESTED_SEND_EVENTS_MESSAGE_INDEX;
    const before = await readTaskConversationIndexStatus(client, spec);
    if (before.exists && (!before.isValid || !before.isReady)) {
      console.error(describeTaskConversationIndexStatus(spec.name, before));
      console.error(`${spec.name} is invalid; dropping it concurrently to rebuild it`);
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`);
    } else if (before.exists) {
      assertTaskConversationIndexReady(spec, before);
      console.error(`${spec.name} already exists; no action needed`);
      return;
    }
    console.error(`Creating ${spec.name} concurrently (statement_timeout=${STATEMENT_TIMEOUT}, lock_timeout=${LOCK_TIMEOUT})`);
    await client.query(spec.createSql);
    const after = await readTaskConversationIndexStatus(client, spec);
    assertTaskConversationIndexReady(spec, after);
    console.error(describeTaskConversationIndexStatus(spec.name, after));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
