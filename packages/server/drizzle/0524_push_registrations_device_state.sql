-- Unified notifications (see notification_outbox): the phone's own state
-- (docs/contracts/notifications.md §3.1). alerts_enabled is the device's
-- "receive notifications here" switch (true keeps today's behavior),
-- os_permission the OS permission it reported (NULL = not reported yet),
-- last_registered_at the last POST /push/registrations (NULL on rows from
-- before it: read as updated_at, no backfill). A constant default and
-- nullable columns are catalog-only; the check is added NOT VALID (every
-- existing row is NULL) and validated by
-- db:create-notification-outbox-event-key-index after the migrations.
-- preview_key_set: which redacted-preview loc-key set the app knows (NULL = 1,
-- the keys every app has).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "push_registrations" ADD COLUMN "alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_registrations" ADD COLUMN "os_permission" text;--> statement-breakpoint
ALTER TABLE "push_registrations" ADD COLUMN "last_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_registrations" ADD CONSTRAINT "push_registrations_os_permission_check" CHECK ("push_registrations"."os_permission" IS NULL OR "push_registrations"."os_permission" IN ('granted', 'denied', 'provisional', 'unknown')) NOT VALID;--> statement-breakpoint
ALTER TABLE "push_registrations" ADD COLUMN "preview_key_set" integer;
