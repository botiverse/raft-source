ALTER TABLE "attachment_comment_refs" ADD COLUMN "anchor_type" text;--> statement-breakpoint
ALTER TABLE "attachment_comment_refs" ADD COLUMN "anchor_data" jsonb;