/** Built concurrently on large databases before the durable Slack worker runs. */
export const SLACK_INBOUND_HEAD_INDEX = {
  name: "idx_external_inbound_event_conversation_head",
  table: "external_inbound_events",
  unique: false,
  columns: ["provider", "environment", "app_registration_id", "provider_authority_id",
    "provider_conversation_id", "raft_channel_id", "received_at", "id"],
  predicate: "(status = ANY (ARRAY['queued'::text, 'processing'::text]))",
  createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_external_inbound_event_conversation_head"
    ON "external_inbound_events" USING btree ("provider", "environment", "app_registration_id", "provider_authority_id",
      "provider_conversation_id", "raft_channel_id", "received_at", "id")
    WHERE "status" IN ('queued', 'processing')`,
};
