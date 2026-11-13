SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_deleted_draft_only" CHECK ("announcements"."deleted_at" is null or "announcements"."status" = 'draft');
