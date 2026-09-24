ALTER TABLE "agents" ADD COLUMN "all_channel_intro_sent_at" timestamp with time zone;
UPDATE "agents"
SET "all_channel_intro_sent_at" = now()
WHERE "deleted_at" IS NULL;
