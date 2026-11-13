-- Unified notifications (see notification_outbox): the account-wide settings
-- (pause, quiet hours, preview, sound; docs/contracts/notifications.md §2.1).
-- No row = the defaults. A new, empty table: its foreign key to users is
-- validated instantly; lock_timeout bounds the wait for the users lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"paused_until" timestamp with time zone,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_start_minute" integer DEFAULT 1320 NOT NULL,
	"quiet_end_minute" integer DEFAULT 480 NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"preview_mode" text DEFAULT 'full' NOT NULL,
	"sound_enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_settings_preview_mode_check" CHECK ("user_notification_settings"."preview_mode" IN ('full', 'sender_only', 'hidden')),
	CONSTRAINT "user_notification_settings_quiet_minutes_check" CHECK ("user_notification_settings"."quiet_start_minute" BETWEEN 0 AND 1439 AND "user_notification_settings"."quiet_end_minute" BETWEEN 0 AND 1439)
);
--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Preview privacy was per device (push_registrations.preview_mode); it is one
-- account setting now. A user whose live registrations disagree keeps the
-- strictest (hidden > sender_only > full); a user without one gets no row.
-- push_registrations is small (one row per phone install).
INSERT INTO "user_notification_settings" ("user_id", "preview_mode")
SELECT "user_id",
       CASE
         WHEN bool_or("preview_mode" = 'hidden') THEN 'hidden'
         WHEN bool_or("preview_mode" = 'sender_only') THEN 'sender_only'
         ELSE 'full'
       END
  FROM "push_registrations"
 WHERE "revoked_at" IS NULL AND "user_id" IS NOT NULL
 GROUP BY "user_id"
ON CONFLICT ("user_id") DO NOTHING;
