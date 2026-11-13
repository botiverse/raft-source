-- Task v2: deleting a task no longer hard-deletes its conversation (RFC 078
-- "Deleting a task"). The conversation's messages can be referenced ON DELETE
-- RESTRICT by external bridge rows (external_message_links,
-- external_outbound_deliveries, external_inbound_events, external reaction
-- facts), so the channels.task_id cascade could fail the delete. Like a deleted
-- channel, the conversation is soft-deleted (deleted_at) and detached
-- (task_id NULL) in the delete transaction, before the task row goes. The
-- check now also admits that shape: a soft-deleted task conversation without
-- its task. Widening a CHECK: existing rows already satisfy it, so NOT VALID
-- skips the table scan (as in task_conversation_channels).
--
-- Task numbers are never reused (RFC 078): a v2 task has no host message to
-- keep its number, so deleting the newest one would free it. Each channel
-- records the highest number it ever allocated; allocation takes the max of
-- that and the rows. A constant default is metadata-only (no table rewrite),
-- and 0 needs no backfill: existing channels' max still comes from the rows.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_task_id_matches_type";--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_task_id_matches_type" CHECK ((("channels"."type" = 'task') = ("channels"."task_id" IS NOT NULL)) OR ("channels"."type" = 'task' AND "channels"."task_id" IS NULL AND "channels"."deleted_at" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "task_number_high_water" integer DEFAULT 0 NOT NULL;
