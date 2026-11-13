#!/usr/bin/env -S node --import @oxc-node/core/register
import "dotenv/config";
import { assertTaskConversationIndexReady, createPool, readTaskConversationIndexStatus } from "./channels-task-conversation-indexes";
import { hasSlackVerifiedIngressSchema, SLACK_INBOUND_HEAD_INDEX } from "./slack-inbound-head-index";

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    if (!await hasSlackVerifiedIngressSchema(client)) return;
    await client.query("SELECT set_config('statement_timeout', $1, false)", ["30min"]);
    await client.query("SELECT set_config('lock_timeout', $1, false)", ["30s"]);
    const before = await readTaskConversationIndexStatus(client, SLACK_INBOUND_HEAD_INDEX);
    if (before.exists && (!before.isValid || !before.isReady)) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${SLACK_INBOUND_HEAD_INDEX.name}"`);
    } else if (before.exists) {
      assertTaskConversationIndexReady(SLACK_INBOUND_HEAD_INDEX, before);
      return;
    }
    await client.query(SLACK_INBOUND_HEAD_INDEX.createSql);
    assertTaskConversationIndexReady(SLACK_INBOUND_HEAD_INDEX,
      await readTaskConversationIndexStatus(client, SLACK_INBOUND_HEAD_INDEX));
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Slack inbound index creation failed");
  process.exitCode = 1;
});
