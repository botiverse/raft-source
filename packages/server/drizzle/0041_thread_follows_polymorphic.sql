ALTER TABLE "thread_follows" DROP CONSTRAINT "thread_follows_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "thread_follows" DROP CONSTRAINT "thread_follows_user_id_thread_channel_id_pk";--> statement-breakpoint
DROP INDEX "idx_thread_follows_user";--> statement-breakpoint
ALTER TABLE "thread_follows" ADD COLUMN "follower_type" text;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD COLUMN "follower_id" uuid;--> statement-breakpoint
UPDATE "thread_follows" SET "follower_type" = 'user', "follower_id" = "user_id";--> statement-breakpoint
ALTER TABLE "thread_follows" ALTER COLUMN "follower_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_follows" ALTER COLUMN "follower_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_follows" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_thread_channel_id_follower_type_follower_id_pk" PRIMARY KEY("thread_channel_id","follower_type","follower_id");--> statement-breakpoint
CREATE INDEX "idx_thread_follows_follower" ON "thread_follows" USING btree ("follower_type","follower_id");--> statement-breakpoint
INSERT INTO "thread_follows" ("thread_channel_id", "follower_type", "follower_id", "parent_message_id", "reason", "created_at")
SELECT ca."channel_id", 'agent', ca."agent_id", c."parent_message_id", 'manual', ca."added_at"
FROM "channel_agents" ca
JOIN "channels" c ON c."id" = ca."channel_id"
WHERE c."type" = 'thread' AND c."parent_message_id" IS NOT NULL
ON CONFLICT ("thread_channel_id", "follower_type", "follower_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "thread_follows" ("thread_channel_id", "follower_type", "follower_id", "parent_message_id", "reason", "created_at")
SELECT ch."channel_id", 'user', ch."user_id", c."parent_message_id", 'manual', ch."joined_at"
FROM "channel_humans" ch
JOIN "channels" c ON c."id" = ch."channel_id"
WHERE c."type" = 'thread' AND c."parent_message_id" IS NOT NULL
ON CONFLICT ("thread_channel_id", "follower_type", "follower_id") DO NOTHING;
