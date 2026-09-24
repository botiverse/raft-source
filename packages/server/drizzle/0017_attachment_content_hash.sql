ALTER TABLE "attachments" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attachments_content_hash" ON "attachments" USING btree ("content_hash");
