// attested_send_events.message_id references messages(id) ON DELETE SET NULL;
// without this index every message delete scans the whole ledger (millions of
// rows in production). db:create-attested-send-events-message-index builds it
// after the migrations. Shared by the script, the post-migration index catalog
// and the tests, so the three cannot drift.

/** The ON DELETE SET NULL lookup from messages; partial because most events carry no message. */
export const ATTESTED_SEND_EVENTS_MESSAGE_INDEX = {
  name: "idx_attested_send_events_message",
  table: "attested_send_events",
  unique: false,
  columns: ["message_id"],
  predicate: "(message_id IS NOT NULL)",
  createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_attested_send_events_message"
    ON "attested_send_events" USING btree ("message_id")
    WHERE "message_id" IS NOT NULL`,
} as const;
