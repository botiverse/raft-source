ALTER TABLE "assistant_check_state" ADD COLUMN "next_digest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assistant_contact_settings" ADD COLUMN "digest_every_hours" integer;--> statement-breakpoint
CREATE INDEX "idx_assistant_check_state_next_digest" ON "assistant_check_state" USING btree ("next_digest_at");