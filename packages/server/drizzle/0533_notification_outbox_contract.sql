-- Unified notifications, contract step 1 of 2 (the expand migrations
-- notification_outbox .. notification_level_versions shipped in v1.21.43;
-- every binary still running or available for rollback is v1.21.43 or later).
-- Three migrations, each its own deploy phase and transaction
-- (src/db/migrationPhases.ts): notification_outbox_contract,
-- native_notifications_drop, notification_level_versions_backfill.
--
-- This one, notification_outbox: drops the mobile_push_outbox compatibility
-- view (nothing from v1.21.43 on reads it), closes the rows older binaries
-- left waiting, and makes dispatcher_version default to 2.
--
-- What stays until contract step 2:
-- - notification_outbox's dispatcher_version and legacy *_count columns, and
--   server_members' server_push_muted with its sync trigger. v1.21.43 still
--   names them (Drizzle lists every declared column in an INSERT and a plain
--   SELECT; its enqueue writes dispatcher_version 2 and its dispatcher reads
--   it; getUserServers selects server_push_muted), and it runs beside this
--   release through the canary and is its rollback image. This release
--   removes them from schema.ts, so this migration's snapshot no longer has
--   them (the SQL below does not drop them); step 2 drops them with
--   `-- schema-snapshot: unchanged`, as attachments_drop_legacy_physical did.
-- - idx_mobile_push_outbox_unique_fact, the old (receiver, channel, message)
--   unique index. It is the only index the ON DELETE CASCADE checks from
--   channels (source_channel_id) and users (receiver_id) can use; without it
--   every hard channel or user delete would scan the whole outbox. Step 2
--   builds (source_channel_id) and (receiver_id) indexes CONCURRENTLY first
--   and drops it only then.
--
-- dispatcher_version DEFAULT 2: this release's enqueue no longer writes the
-- column, and v1.21.43's dispatcher treats a row below 2 as an older binary's
-- (APNs / FCM only, no desktop or Web Push). With the default at 2 a row this
-- release writes is a unified row to both. This release depends on that
-- default, and on this migration committing before it starts (db:migrate:deploy
-- runs before the service update). The server_push_muted trigger
-- (brave_dragon_lord) likewise keeps the boolean in step with
-- server_push_mode for v1.21.43 when this release writes only the mode.
--
-- ~7.4M rows: nothing here rewrites or scans the table. DROP VIEW and SET
-- DEFAULT are catalog-only. The one UPDATE touches only active rows (pending
-- / processing, normally none; the partial index
-- idx_mobile_push_outbox_active_created holds exactly those). The table is
-- locked ACCESS EXCLUSIVE up front so the UPDATE never has to upgrade its
-- lock behind a drain (no lock-upgrade deadlock); the whole transaction is
-- short and lock_timeout bounds the wait for that lock.
--
-- The status check keeps 'sent' / 'skipped' / 'dropped': the terminal rows
-- from before the unified dispatcher (retained, millions) carry them, and the
-- UPDATE writes 'skipped' too.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Fail closed: this release's enqueue dedupes reminder and notice rows (no
-- message, so the old index never matches them) only through the
-- (receiver, event) unique index; its ON CONFLICT DO NOTHING has no target.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.idx_notification_outbox_receiver_event')
      AND i.indrelid = 'public.notification_outbox'::regclass
      AND i.indisvalid AND i.indisready AND i.indisunique
  ) THEN
    RAISE EXCEPTION 'idx_notification_outbox_receiver_event is missing or invalid: run pnpm --filter @botiverse/raft-server db:create-notification-outbox-event-key-index (CONCURRENTLY) before migrating';
  END IF;
END
$$;--> statement-breakpoint
LOCK TABLE "notification_outbox" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
-- Rows a binary before v1.21.43 left waiting (dispatcher_version 1; that
-- binary is gone and already sent desktop / Web Push itself): terminal, as a
-- stale event. Every writer from v1.21.43 on writes version 2.
UPDATE "notification_outbox"
   SET "status" = 'skipped',
       "decision" = 'suppressed:stale',
       "locked_at" = NULL,
       "processed_at" = now(),
       "updated_at" = now()
 WHERE "status" IN ('pending', 'processing')
   AND "dispatcher_version" = 1;--> statement-breakpoint
ALTER TABLE "notification_outbox" ALTER COLUMN "dispatcher_version" SET DEFAULT 2;--> statement-breakpoint
-- Already gone is not an error (nothing to contract), but it is said; a
-- relation of that name that is not a view stops the migration (DROP VIEW
-- refuses it).
DO $$
BEGIN
  IF to_regclass('public.mobile_push_outbox') IS NULL THEN
    RAISE NOTICE 'notification_outbox_contract: mobile_push_outbox does not exist; nothing to drop';
  ELSE
    DROP VIEW "mobile_push_outbox";
  END IF;
END
$$;
