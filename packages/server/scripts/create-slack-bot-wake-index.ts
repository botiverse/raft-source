#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import { assertTaskConversationIndexReady, createPool, readTaskConversationIndexStatus } from "./channels-task-conversation-indexes";
import { SLACK_BOT_WAKE_INDEX } from "../src/services/slackBotWakeIndexContract";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    const table = await client.query<{ exists: boolean }>("SELECT to_regclass('public.external_inbound_events') IS NOT NULL AS exists");
    if (!table.rows[0]?.exists) return;
    await client.query("SELECT set_config('statement_timeout', $1, false)", ["30min"]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", ["30s"]);
    const before = await readTaskConversationIndexStatus(client, SLACK_BOT_WAKE_INDEX);
    if (before.exists && (!before.isValid || !before.isReady)) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SLACK_BOT_WAKE_INDEX.name}"`);
    } else if (before.exists) {
      assertTaskConversationIndexReady(SLACK_BOT_WAKE_INDEX, before);
      return;
    }
    await client.query(SLACK_BOT_WAKE_INDEX.createSql);
    assertTaskConversationIndexReady(SLACK_BOT_WAKE_INDEX,
      await readTaskConversationIndexStatus(client, SLACK_BOT_WAKE_INDEX));
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Slack bot wake index creation failed");
  process.exitCode = 1;
});
