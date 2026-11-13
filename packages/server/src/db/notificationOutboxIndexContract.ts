// Unified notifications (migrations notification_outbox,
// thread_follows_notification_level, push_registrations_device_state; and
// contract step 2, notification_outbox_fk_indexes): what
// db:create-notification-outbox-event-key-index and
// db:create-notification-outbox-fk-indexes build and validate after the
// migrations. Shared by the script, the post-migration index catalog and the
// migration tests, so the three cannot drift.

/** The unified dedupe key, (receiver, event); the enqueue's ON CONFLICT target. */
export const NOTIFICATION_OUTBOX_EVENT_KEY_INDEX = {
  name: "idx_notification_outbox_receiver_event",
  table: "notification_outbox",
  unique: true,
  columns: ["receiver_id", "event_key"],
  predicate: "(event_key IS NOT NULL)",
  createSql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_notification_outbox_receiver_event"
    ON "notification_outbox" USING btree ("receiver_id", "event_key")
    WHERE "event_key" IS NOT NULL`,
} as const;

/** Every constraint those migrations add NOT VALID; VALIDATE takes SHARE UPDATE EXCLUSIVE and lets writes go on. */
export const NOTIFICATION_NOT_VALID_CONSTRAINTS: readonly { table: string; name: string }[] = [
  { table: "notification_outbox", name: "mobile_push_outbox_status_check" },
  { table: "thread_follows", name: "thread_follows_notification_level_check" },
  { table: "push_registrations", name: "push_registrations_os_permission_check" },
];

/**
 * Contract step 2 (migration notification_outbox_fk_indexes): the indexes the
 * ON DELETE CASCADE checks from channels (source_channel_id) and users
 * (receiver_id) use. Until step 2 the only index they could use was the old
 * unique key below (the event-key index is partial, so it never serves them);
 * without one, every hard channel or user delete scans the whole outbox.
 * db:create-notification-outbox-fk-indexes builds them CONCURRENTLY, and only
 * then drops the old key.
 */
export const NOTIFICATION_OUTBOX_FK_INDEXES = [
  {
    name: "idx_notification_outbox_source_channel",
    table: "notification_outbox",
    unique: false,
    columns: ["source_channel_id"],
    predicate: null,
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_notification_outbox_source_channel"
    ON "notification_outbox" USING btree ("source_channel_id")`,
  },
  {
    name: "idx_notification_outbox_receiver",
    table: "notification_outbox",
    unique: false,
    columns: ["receiver_id"],
    predicate: null,
    createSql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_notification_outbox_receiver"
    ON "notification_outbox" USING btree ("receiver_id")`,
  },
] as const;

/**
 * The pre-unified dedupe key (receiver, source channel, message), replaced by
 * the event-key index and, for the delete cascades, by
 * NOTIFICATION_OUTBOX_FK_INDEXES. Retired by name; an index of the same shape
 * under another name (production rebuilt some tables by hand) is not dropped
 * silently but stops the retirement, so it is looked up by columns too.
 */
export const NOTIFICATION_OUTBOX_LEGACY_UNIQUE_INDEX = {
  name: "idx_mobile_push_outbox_unique_fact",
  table: "notification_outbox",
  columns: ["receiver_type", "receiver_id", "source_channel_id", "message_id"],
} as const;

/** Names of the unique indexes on notification_outbox with the legacy key's columns, in order. */
export const LEGACY_UNIQUE_INDEX_LOOKUP_SQL = `
  SELECT idx.relname AS name
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
   WHERE i.indrelid = to_regclass('public.notification_outbox')
     AND i.indisunique
     AND (
       SELECT array_agg(a.attname::text ORDER BY k.ord)
         FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
     ) = ARRAY['receiver_type', 'receiver_id', 'source_channel_id', 'message_id']
   ORDER BY idx.relname`;
