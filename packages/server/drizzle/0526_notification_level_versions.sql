-- Unified notifications: the level counter per (user, server) moves off
-- server_members. Every level write (server / channel / thread scope) bumped
-- server_members.notification_prefs_version, an UPDATE of the member row,
-- which conflicts with the FOR SHARE lock the read-state and membership fences
-- take on that row and waits behind a removal holding it. The counter lives
-- here now (services/notifications/settings.ts bumpPrefsVersion); readers take
-- GREATEST(this, the legacy column), so no backfill is needed and no version a
-- client holds is reused. The legacy column stays (expand-only) and is still
-- written by server-scope writes, which update the member row anyway.
-- No foreign key to server_members or servers: its check would take a KEY
-- SHARE lock on those rows. A new, empty table: the users foreign key is
-- validated instantly; lock_timeout bounds the wait for the users lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "user_notification_level_versions" (
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notification_level_versions_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
ALTER TABLE "user_notification_level_versions" ADD CONSTRAINT "user_notification_level_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;