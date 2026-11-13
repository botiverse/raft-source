ALTER TABLE "oauth_app_link_previews" ADD COLUMN "verified_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "oauth_app_link_previews" ADD CONSTRAINT "oauth_app_link_previews_suspension" CHECK (("oauth_app_link_previews"."suspended_at" IS NULL) = ("oauth_app_link_previews"."suspended_reason" IS NULL));--> statement-breakpoint
-- Before this migration the only writer re-fetched the domain proof before every
-- upsert, so updated_at is each registration's last successful proof.
UPDATE "oauth_app_link_previews" SET "verified_at" = "updated_at", "last_checked_at" = "updated_at";
