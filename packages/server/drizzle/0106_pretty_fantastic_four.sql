ALTER TABLE "oauth_clients" ADD COLUMN "category" text DEFAULT 'Other' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "publish_status" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
UPDATE "oauth_clients" SET "enabled" = true, "publish_status" = 'published' WHERE "app_type" = 'slock_builtin';--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "publish_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "publish_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "publish_reviewed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "publish_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_publish_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("publish_reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_app_type" ON "oauth_clients" USING btree ("app_type");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_publish_status" ON "oauth_clients" USING btree ("publish_status");--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_publish_status_valid" CHECK ("oauth_clients"."publish_status" IN ('private', 'publish_requested', 'in_review', 'published', 'rejected'));
