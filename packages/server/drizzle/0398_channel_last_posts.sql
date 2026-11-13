CREATE TABLE "channel_last_posts" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"last_post_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_last_posts_backfill" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_last_posts_backfill_single_row" CHECK ("channel_last_posts_backfill"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "channel_last_posts" ADD CONSTRAINT "channel_last_posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- When a person or an agent posts (a chat message; not a system message or an
-- app event), the channel's last post moves, and so does its parent's for a
-- thread reply. At most once a minute per channel (the list shows minutes).
-- The minute is checked with a plain primary-key read first: INSERT ... ON
-- CONFLICT DO UPDATE locks the conflicting row even when its WHERE is false,
-- so upserting on every post would make concurrent posts to one channel queue
-- on that row lock until each poster commits, on the hottest write path. Most
-- posts therefore take no lock here; one a minute per channel upserts. Never
-- fails a message insert: both channels exist (foreign keys).
CREATE OR REPLACE FUNCTION "channel_last_post_on_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target uuid;
BEGIN
  FOR target IN
    SELECT c."id" FROM "channels" c WHERE c."id" = NEW."channel_id"
    UNION ALL
    SELECT c."parent_channel_id" FROM "channels" c
    WHERE c."id" = NEW."channel_id" AND c."parent_channel_id" IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM "channel_last_posts" p
      WHERE p."channel_id" = target AND p."last_post_at" >= NEW."created_at" - interval '1 minute'
    ) THEN
      INSERT INTO "channel_last_posts" ("channel_id", "last_post_at")
      VALUES (target, NEW."created_at")
      ON CONFLICT ("channel_id") DO UPDATE
      SET "last_post_at" = EXCLUDED."last_post_at"
      WHERE "channel_last_posts"."last_post_at" < EXCLUDED."last_post_at";
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "messages_channel_last_post"
AFTER INSERT ON "messages"
FOR EACH ROW
WHEN (NEW."sender_type" IN ('user', 'agent') AND NEW."message_type" = 'chat')
EXECUTE FUNCTION "channel_last_post_on_insert"();
--> statement-breakpoint
-- A fresh database (no messages yet: a new environment, a test or preview VM)
-- has nothing to backfill: mark it done, so the channel list shows lastPostAt
-- without anyone running the script. One row read, whatever the table's size.
INSERT INTO "channel_last_posts_backfill" ("id")
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM "messages" LIMIT 1)
ON CONFLICT ("id") DO NOTHING;
