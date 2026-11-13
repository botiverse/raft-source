-- message_server_timeline.search_vector (#raft-architecture:#29): a copy of
-- messages.search_vector beside the row's server, so the text match of a search
-- reads one server's matches through a (server_id, search_vector) GIN instead
-- of every server's (idx_messages_search_vector_gin cannot be narrowed).
--
-- Why the timeline and not messages.server_id (0317): filling messages.server_id
-- rewrites ~17M messages rows (150+ GB of WAL, one CDC update per row to
-- RisingWave). Filling this column rewrites only timeline rows: not in
-- slock_rw_publication, and no lock on any row a send touches.
--
-- Additive here. The column is nullable with no default (no rewrite) and stored
-- out of line (STORAGE EXTERNAL, toast_tuple_target 128) so the heap the
-- timeline walk and the match's (message_id, channel_id) reads stay narrow.
-- The 0310 triggers now copy the vector on insert, and re-copy it when a
-- message's search_text changes (edit, retraction). Older rows are filled by
-- the operator backfill (db:backfill-message-server-timeline --search-vector),
-- which verifies and then builds the GIN CONCURRENTLY. Readers only use the GIN
-- behind search_server_gin_v0, switched on after that.
--
-- btree_gin (uuid needs 1.3) is created where available. Where it is not
-- (PGlite without the contrib), the GIN is simply not built and the flag stays
-- off. On a small table (tests, dev) the GIN is built here.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gin;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'btree_gin unavailable (%): idx_message_server_timeline_server_search cannot be built here', SQLERRM;
END
$$;--> statement-breakpoint
ALTER TABLE "message_server_timeline" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
ALTER TABLE "message_server_timeline" ALTER COLUMN "search_vector" SET STORAGE EXTERNAL;--> statement-breakpoint
ALTER TABLE "message_server_timeline" SET (toast_tuple_target = 128);--> statement-breakpoint
-- AFTER triggers see the generated search_vector.
CREATE OR REPLACE FUNCTION "message_server_timeline_on_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id", "search_vector")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id", NEW."search_vector"
  FROM "channels" c
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
  INSERT INTO "message_server_timeline" ("message_id", "server_id", "created_at", "channel_id", "search_vector")
  SELECT NEW."id", c."server_id", NEW."created_at", NEW."channel_id", NEW."search_vector"
  FROM "channels" c
  WHERE c."id" = NEW."channel_id"
  ON CONFLICT ("message_id") DO UPDATE
  SET "server_id" = EXCLUDED."server_id",
      "created_at" = EXCLUDED."created_at",
      "channel_id" = EXCLUDED."channel_id",
      "search_vector" = EXCLUDED."search_vector";
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- Every writer of search_text names it in its SET list (no trigger derives it),
-- so the column list keeps the WHEN's text comparison off ordinary updates.
DROP TRIGGER IF EXISTS "messages_server_timeline_update" ON "messages";--> statement-breakpoint
CREATE TRIGGER "messages_server_timeline_update"
AFTER UPDATE OF "channel_id", "created_at", "search_text" ON "messages"
FOR EACH ROW
WHEN (
  OLD."channel_id" IS DISTINCT FROM NEW."channel_id"
  OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
  OR OLD."search_text" IS DISTINCT FROM NEW."search_text"
)
EXECUTE FUNCTION "message_server_timeline_on_update"();--> statement-breakpoint
DO $$
BEGIN
  IF pg_relation_size('public.message_server_timeline'::regclass) <= 1048576
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gin') THEN
    CREATE INDEX IF NOT EXISTS "idx_message_server_timeline_server_search"
      ON "message_server_timeline" USING gin ("server_id", "search_vector")
      WITH (fastupdate = off);
  ELSE
    RAISE NOTICE 'message_server_timeline: run db:backfill-message-server-timeline --search-vector, which builds idx_message_server_timeline_server_search CONCURRENTLY after it verifies';
  END IF;
END
$$;
