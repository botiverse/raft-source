/** Built outside the migration transaction on existing installations. */
export const SLACK_BOT_WAKE_INDEX = {
  name: "idx_slack_bot_wake_window",
  table: "external_inbound_events",
  unique: false,
  columns: ["app_registration_id", "install_id", "binding_id", "provider_conversation_id", "payload_erased_at"],
  predicate: "((provider = 'slack'::text) AND (status = 'committed'::text))",
  createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_slack_bot_wake_window"
    ON "external_inbound_events" USING btree ("app_registration_id", "install_id", "binding_id", "provider_conversation_id", "payload_erased_at")
    WHERE "provider" = 'slack' AND "status" = 'committed'`,
};
