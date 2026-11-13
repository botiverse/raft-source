-- Unified notifications (docs/contracts/notifications.md), in five
-- migrations, one table each (notification_outbox, user_notification_settings,
-- user_channel_notification_prefs, thread_follows_notification_level,
-- push_registrations_device_state): each deploy phase is its own transaction
-- (src/db/migrationPhases.ts), so no table's lock is held while the next one
-- waits. All of it is expand-only: older binaries keep running against the
-- migrated database during a rolling deploy.
-- This one: mobile_push_outbox becomes notification_outbox, the one audience
-- of every notification transport.
--
-- The table holds ~7.4M rows in production, so nothing here rewrites or scans
-- it: the rename, the new nullable / constant-default columns and DROP NOT NULL
-- are catalog-only (PostgreSQL 11+ stores a constant default without a
-- rewrite); the widened status check is added NOT VALID (existing rows already
-- satisfy the narrower list) and validated, with the new partial unique index,
-- by db:create-notification-outbox-event-key-index, which db:migrate:deploy
-- runs after the migrations and before the post-migration index guard.
-- The rename takes ACCESS EXCLUSIVE for a moment; lock_timeout bounds the
-- wait behind an in-flight drain or send.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- 30s, like the other migrations of this deploy: every statement here is
-- catalog-only except the guarded index build below, which runs only on an
-- outbox of at most 100k rows (seconds). The same holds for the other four
-- (user_notification_settings' backfill reads push_registrations, one row
-- per phone install).
ALTER TABLE "mobile_push_outbox" RENAME TO "notification_outbox";--> statement-breakpoint
-- Foreign keys carry the table name drizzle derives; index and check names
-- keep their mobile_push_outbox prefix (schema.ts names them explicitly).
ALTER TABLE "notification_outbox" RENAME CONSTRAINT "mobile_push_outbox_receiver_id_users_id_fk" TO "notification_outbox_receiver_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "notification_outbox" RENAME CONSTRAINT "mobile_push_outbox_server_id_servers_id_fk" TO "notification_outbox_server_id_servers_id_fk";--> statement-breakpoint
ALTER TABLE "notification_outbox" RENAME CONSTRAINT "mobile_push_outbox_source_channel_id_channels_id_fk" TO "notification_outbox_source_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "notification_outbox" RENAME CONSTRAINT "mobile_push_outbox_message_id_messages_id_fk" TO "notification_outbox_message_id_messages_id_fk";--> statement-breakpoint
-- Events without a conversation (reminder, system_notice) have no kind,
-- channel or message.
ALTER TABLE "notification_outbox" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ALTER COLUMN "source_channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ALTER COLUMN "message_seq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "payload" jsonb;--> statement-breakpoint
-- 1 = written by an older binary (every existing row, and every row an older
-- binary inserts through the mobile_push_outbox view below); 2 = the unified
-- enqueue. See the notificationOutbox comment in schema.ts.
ALTER TABLE "notification_outbox" ADD COLUMN "dispatcher_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "transports" jsonb;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "first_failure" jsonb;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "mobile_push_outbox_status_check";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "mobile_push_outbox_status_check" CHECK ("notification_outbox"."status" IN ('pending', 'processing', 'sent', 'skipped', 'revoked', 'dropped', 'delivered', 'suppressed', 'quiet', 'failed')) NOT VALID;--> statement-breakpoint
-- Rolling-deploy compatibility: older binaries still read and write
-- "mobile_push_outbox" (insert ... ON CONFLICT on idx_mobile_push_outbox_unique_fact,
-- the drain's select / update, conversion and task-delete revokes). A simple
-- view over the old columns is automatically updatable, so all of that keeps
-- working; their rows get dispatcher_version 1 from the column default, and
-- the unified rows (version 2) stay invisible to them. Dropped by the follow-up
-- contract migration, with the legacy count columns.
-- The view is not declared in schema.ts (temporary, for older binaries only).
CREATE VIEW "mobile_push_outbox" AS
  SELECT "id", "receiver_type", "receiver_id", "server_id", "kind", "source_channel_id", "message_id", "message_seq",
         "activity_at", "personal_mention", "unread_eligible", "status", "attempt_count", "attempted_count",
         "sent_count", "skipped_count", "revoked_count", "dropped_count", "last_error", "locked_at", "processed_at",
         "created_at", "updated_at"
    FROM "notification_outbox"
   WHERE "dispatcher_version" = 1;--> statement-breakpoint
-- The unified dedupe key, (receiver, event). Built here only on a small table
-- (tests, dev, fresh environments): on a large one a plain CREATE INDEX would
-- block every send's outbox insert for the whole scan, so the migration
-- leaves it to
--   pnpm --filter @botiverse/raft-server db:create-notification-outbox-event-key-index
-- (CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS, then indisvalid/indisready),
-- which db:migrate:deploy runs before the new server starts; the
-- post-migration index check (src/db/postMigrationIndexes.ts) reports it until
-- then. No existing row has an event_key, so the build cannot fail on a
-- duplicate.
DO $$
BEGIN
  IF (SELECT reltuples FROM pg_class WHERE oid = 'public.notification_outbox'::regclass) <= 100000 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_notification_outbox_receiver_event" ON "notification_outbox" USING btree ("receiver_id","event_key") WHERE "notification_outbox"."event_key" IS NOT NULL;
  ELSE
    RAISE NOTICE 'notification_outbox is large: run db:create-notification-outbox-event-key-index (CONCURRENTLY) to build idx_notification_outbox_receiver_event';
  END IF;
END
$$;
