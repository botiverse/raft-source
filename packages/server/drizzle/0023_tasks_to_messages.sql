-- Migration: Add task fields to messages table
-- Tasks are now a property of messages (taskStatus != null means the message IS a task)
-- The old tasks table is kept but deprecated (no longer used by application code)

-- Add task columns to messages table
ALTER TABLE "messages" ADD COLUMN "task_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_number" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_assignee_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_assignee_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "task_completed_at" timestamp with time zone;--> statement-breakpoint

-- Create indexes for task queries
CREATE UNIQUE INDEX "idx_messages_channel_task_number" ON "messages" USING btree ("channel_id","task_number");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_task_status" ON "messages" USING btree ("channel_id","task_status");
