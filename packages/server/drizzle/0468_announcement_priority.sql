-- Additive metadata: old writers retain priority 0. Lock announcements before
-- its audit table, matching the admin write path. Existing FFA table-level
-- SELECT/INSERT/UPDATE grants cover the new columns; no broader grant is needed.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_priority_range" CHECK ("announcements"."priority" >= 0 and "announcements"."priority" <= 100);--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD COLUMN "old_priority" integer;--> statement-breakpoint
ALTER TABLE "announcement_audit_events" ADD COLUMN "new_priority" integer;
