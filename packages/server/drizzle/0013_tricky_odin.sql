ALTER TABLE "channels" ADD COLUMN "parent_message_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_channels_parent_message" ON "channels" USING btree ("parent_message_id");--> statement-breakpoint
CREATE INDEX "idx_messages_thread" ON "messages" USING btree ("thread_id");