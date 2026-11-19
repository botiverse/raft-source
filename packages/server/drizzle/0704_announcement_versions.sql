-- Announcement versions (task #38, #wg-announcement:f455efa7). Editing a
-- published announcement creates a new row in the same series; a later
-- published version that has started replaces the earlier ones. Existing rows
-- become version 1 of their own series. Additive only: older servers ignore
-- the columns, and the FFA role already has table-level SELECT/INSERT/UPDATE.
ALTER TABLE "announcements" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "dismissal_floor_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_series_id_announcements_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_announcements_series_version" ON "announcements" USING btree (coalesce("series_id", "id"),"version") WHERE "announcements"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_version_shape" CHECK ("announcements"."version" >= 1 and "announcements"."dismissal_floor_version" >= 1 and "announcements"."dismissal_floor_version" <= "announcements"."version" and (("announcements"."series_id" is null) = ("announcements"."version" = 1)));