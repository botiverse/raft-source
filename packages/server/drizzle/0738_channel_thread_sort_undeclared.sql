-- Retire forum-style channels (channel_thread_sort_v0, added by
-- channel_thread_sort), step 1 of 2. Product removed the option: every channel
-- is in post order, as if thread_sort = 'time'.
--
-- This release no longer declares channels.thread_sort (so this migration's
-- snapshot no longer has it), and nothing in it reads or writes the column:
-- PATCH /api/channels/:id ignores `threadSort`, and
-- GET /api/messages/channel/:channelId/by-activity is gone.
--
-- The column stays: the release serving now and the rollback image still
-- declare it, so they name it in every INSERT and plain SELECT on channels
-- (docs/operations/aws-ecs-canary-release.md; a DROP COLUMN they reference is
-- a NO-GO). It is NOT NULL DEFAULT 'time', so this release's INSERTs, which
-- omit it, still work. A later release drops it, once no serving or rollback
-- image declares it, with `ALTER TABLE "channels" DROP COLUMN IF EXISTS
-- "thread_sort"` and `-- schema-snapshot: unchanged`.
--
-- What this one does: change_log_channels_upd re-created without thread_sort
-- in its WHEN, so no trigger names the column and the later drop needs no
-- CASCADE. The same WHEN list as its last definition
-- (guest_join_public_column_drop) minus thread_sort. Neither image refers to
-- the trigger. The one effect: an older task still serving during the rollout
-- (or a rollback) that changes thread_sort logs no change_log row for it, so
-- sync clients don't refetch that channel for the setting alone; this release
-- ignores the setting anyway. DROP + CREATE in this one transaction: no update
-- can commit between them unlogged.
--
-- The channel_thread_sort_v0 feature_flags row is not deleted here: that is a
-- separate, final step.
--
-- RisingWave: channels is mirrored as rw_channels with a fixed column list
-- (infra/aws-server/envs/release-qa/sql/risingwave-cdc-bootstrap.sql, captured
-- from production; staging is the same) that has no thread_sort, and the CDC
-- source has auto.schema.change = false. No materialized view names the
-- column. Triggers are not replicated.
--
-- Locks: ACCESS EXCLUSIVE on channels, for the catalog change only (the
-- trigger). channels is hot: give up after 2 s rather than queue reads behind
-- a long transaction (the deploy runner retries a lock timeout).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_channels_upd ON public.channels;--> statement-breakpoint
CREATE TRIGGER change_log_channels_upd AFTER UPDATE ON public.channels
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.type IS DISTINCT FROM NEW.type OR OLD.archived_at IS DISTINCT FROM NEW.archived_at
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at OR OLD.guest_visible IS DISTINCT FROM NEW.guest_visible
    OR OLD.parent_channel_id IS DISTINCT FROM NEW.parent_channel_id
    OR OLD.parent_message_id IS DISTINCT FROM NEW.parent_message_id OR OLD.task_id IS DISTINCT FROM NEW.task_id
    OR OLD.server_id IS DISTINCT FROM NEW.server_id
    OR OLD.announcement_artifact_id IS DISTINCT FROM NEW.announcement_artifact_id)
  EXECUTE FUNCTION public.change_log_channels_fn();
