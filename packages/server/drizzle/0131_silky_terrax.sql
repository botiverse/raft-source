ALTER TABLE "inbox_serving_rows" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
UPDATE "inbox_serving_rows" SET "last_activity_at" = "latest_notified_at" WHERE "last_activity_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_inbox_serving_rows_receiver_last_activity" ON "inbox_serving_rows" USING btree ("receiver_type","receiver_id","last_activity_at");
