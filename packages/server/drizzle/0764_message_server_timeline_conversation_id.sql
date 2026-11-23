-- message_server_timeline.conversation_id: the joint conversation a timeline
-- row belongs to, so the recent search's server timeline walk can also read
-- the visible joint conversations. Their messages live in the joint storage
-- server (servers.kind = 'joint_storage'), so `server_id = <searched server>`
-- never reaches them (prod: 302k joint messages, 306 servers affected).
--
-- Set only on rows whose channel is on a joint_storage server: the
-- conversation root two levels up,
--   COALESCE(parent.parent_channel_id, channels.parent_channel_id, channels.id)
-- with parent the channel's parent_channel_id row (the storage channel
-- itself, the storage root of its thread or task conversation, or the root of
-- a thread nested in one of those). NULL on every other row. Nested threads
-- exist: production has threads whose parent_channel_id is a thread (30) or a
-- task conversation (11), none in joint storage yet but nothing prevents one;
-- channels depth is at most 2 in production (2026-11-20, depth 3: 0). Two
-- levels keep the key the true root, so the walk, which asks for the visible
-- joint roots, finds a nested thread's messages too. Supported depth: the
-- conversation root is at most two levels above the message's channel
-- (production's maximum, 2026-11-20); deeper nesting is not derived (the
-- triggers stay non-recursive) and the backfill's verify reports its rows as
-- divergent, so the flag's gate fails instead of the walk dropping them
-- quietly. Derived by the 0310/0658
-- triggers, which now also join the channel's server and parent; the update
-- trigger's upsert re-derives it when a message moves channel (conversion and
-- its rollback). channels.server_id is immutable (0310), so a channel never
-- moves between a joint storage server and another one; a parent_channel_id
-- change re-derives the rows of the channel and its direct children
-- (channels_server_timeline_conversation below).
--
-- Additive here. The column is nullable with no default (metadata only).
-- Older rows are filled by the operator backfill
--   pnpm --filter @botiverse/raft-server db:backfill-message-server-timeline --conversation-id
-- which verifies (0 missing / 0 divergent over the whole timeline) and then
-- builds idx_message_server_timeline_conversation_created CONCURRENTLY. On a
-- small table (tests, dev) the index is built here.
--
-- Why the backfill builds the index and not the post-migration index guard
-- (postMigrationIndexes.ts, as 0741 did): the guard makes every deploy build
-- an index its readers need right away. Nothing reads this one until
-- search_joint_conversation_walk_v0 is on, and that flag is switched on by an
-- operator only after the backfill's verify reported 0 missing / 0 divergent
-- and the index is valid; the build belongs with that verify, as 0658's GIN.
--
-- The flag's row (below) carries that gate for the operator: server-scoped,
-- default off, no rules. Rollout: staging, then production backfill + verify,
-- on for our own servers, default on, then the flag and the off path are
-- removed in the following release.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "message_server_timeline" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "message_server_timeline_on_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id", "search_vector", "conversation_id")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id", NEW."search_vector",
    CASE WHEN s."kind" = 'joint_storage' THEN COALESCE(p."parent_channel_id", c."parent_channel_id", c."id") END
  FROM "channels" c
  JOIN "servers" s ON s."id" = c."server_id"
  LEFT JOIN "channels" p ON p."id" = c."parent_channel_id"
  WHERE c."id" = NEW."channel_id"
  ON CONFLICT ("message_id") DO NOTHING;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "message_server_timeline_on_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id", "search_vector", "conversation_id")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id", NEW."search_vector",
    CASE WHEN s."kind" = 'joint_storage' THEN COALESCE(p."parent_channel_id", c."parent_channel_id", c."id") END
  FROM "channels" c
  JOIN "servers" s ON s."id" = c."server_id"
  LEFT JOIN "channels" p ON p."id" = c."parent_channel_id"
  WHERE c."id" = NEW."channel_id"
  ON CONFLICT ("message_id") DO UPDATE
  SET "server_id" = EXCLUDED."server_id",
      "created_at" = EXCLUDED."created_at",
      "channel_id" = EXCLUDED."channel_id",
      "search_vector" = EXCLUDED."search_vector",
      "conversation_id" = EXCLUDED."conversation_id";
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- A channel's root changes when its parent_channel_id does: a thread whose
-- parent message moves (0297's messages_follow_parent_channel_id, conversion
-- and its rollback), or a task conversation re-parented. On a joint storage
-- server its rows follow, and so do its direct children's (a thread nested in
-- it takes its root two levels up). Bounded by those channels' messages
-- (idx_channels_parent_channel for the children, idx_messages_channel_created_at,
-- then the timeline's primary key), never the whole timeline, and a no-op
-- where nothing differs. A channel on any
-- other server is skipped: its rows are NULL already (only these triggers and
-- the backfill set conversation_id, only on joint storage rows, and
-- channels.server_id is immutable), so conversion's re-parenting of the source
-- server's threads reads none of their messages.
CREATE OR REPLACE FUNCTION "channels_server_timeline_conversation_on_reparent"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "servers" s WHERE s."id" = NEW."server_id" AND s."kind" = 'joint_storage'
  ) THEN
    RETURN NULL;
  END IF;
  UPDATE "message_server_timeline" t
  SET "conversation_id" = COALESCE(p."parent_channel_id", c."parent_channel_id", c."id")
  FROM "channels" c
  LEFT JOIN "channels" p ON p."id" = c."parent_channel_id"
  JOIN "messages" m ON m."channel_id" = c."id"
  WHERE c."id" IN (
      SELECT NEW."id"
      UNION ALL
      SELECT child."id" FROM "channels" child WHERE child."parent_channel_id" = NEW."id"
    )
    AND c."server_id" = NEW."server_id"
    AND t."message_id" = m."id"
    AND t."channel_id" = c."id"
    AND t."conversation_id" IS DISTINCT FROM COALESCE(p."parent_channel_id", c."parent_channel_id", c."id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "channels_server_timeline_conversation"
AFTER UPDATE OF "parent_channel_id" ON "channels"
FOR EACH ROW
WHEN (OLD."parent_channel_id" IS DISTINCT FROM NEW."parent_channel_id")
EXECUTE FUNCTION "channels_server_timeline_conversation_on_reparent"();--> statement-breakpoint
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'search_joint_conversation_walk_v0',
	'Recent search walk also reads the visible joint conversations. Turn on only after `db:backfill-message-server-timeline --conversation-id` reported 0 missing / 0 divergent over the whole timeline AND idx_message_server_timeline_conversation_created is valid; with the index missing the joint lane is an unbudgeted scan. Rollout: staging, then production backfill+verify, on for our own servers, default on, then the flag and the off path are removed in the following release.',
	true,
	false,
	'server',
	false,
	NULL,
	'search_joint_conversation_walk_v0'
) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.message_server_timeline'::regclass) <= 1048576 THEN
    CREATE INDEX IF NOT EXISTS "idx_message_server_timeline_conversation_created"
      ON "message_server_timeline" USING btree ("conversation_id", "created_at", "message_id")
      WHERE "conversation_id" IS NOT NULL;
  ELSE
    RAISE NOTICE 'message_server_timeline: run db:backfill-message-server-timeline --conversation-id, which builds idx_message_server_timeline_conversation_created CONCURRENTLY after it verifies';
  END IF;
END
$$;
