ALTER TABLE "attachment_upload_sessions" ADD COLUMN "thumbnail_state" text;--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD COLUMN "thumbnail_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD COLUMN "thumbnail_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_sessions_thumbnail_pending" ON "attachment_upload_sessions" USING btree ("thumbnail_lease_expires_at","completed_at") WHERE "attachment_upload_sessions"."thumbnail_state" = 'pending';