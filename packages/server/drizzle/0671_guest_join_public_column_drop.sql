-- Retire Guest joining (#wg-rbac:#47, #wg-rbac:#49), step 2 of 2, the part
-- that is safe now:
--   1. change_log_channels_upd re-created without guest_joinable in its WHEN,
--      so nothing names that column any more and a later migration can drop it.
--   2. servers.public_guest_join_enabled dropped.
-- channels.guest_joinable is NOT dropped here; see below.
--
-- schema-snapshot: unchanged (0653's snapshot already lacks both columns; the trigger is not declared in schema.ts)
--
-- Why now: v1.21.62 (#13829, migrations 0653-0654) stopped declaring, reading
-- and writing both columns and cleared them, and it is the release serving
-- production, so it is the image a rollback from this release returns to
-- (docs/operations/server-release.md). No serving or rollback image names
-- public_guest_join_enabled in an INSERT or SELECT any more.
--
-- RisingWave: servers is mirrored as rw_servers with an explicit column list
-- (infra/risingwave/sql/061-inbox-derivation-chain.sql: id, name, slug,
-- owner_id, onboarding_agent_id, plan, plan_downgraded_at, deleted_at,
-- created_at, updated_at). public_guest_join_enabled is not in it, so the
-- mirror reads nothing this drops. channels is mirrored as rw_channels (*),
-- so the mirror does have guest_joinable, and no migration has dropped a
-- column of a mirrored (*) table yet: that column stays until the drop has
-- been tried on staging and the RisingWave owner has given the production
-- order (Tenny, #wg-rbac:#49). It is false on every row and nothing reads it.
--
-- The trigger: the same WHEN list as its last definition
-- (0668_channel_announcement) minus guest_joinable. No write changes
-- guest_joinable any more (0654 cleared it, nothing declares it), so no
-- change_log row is lost. DROP + CREATE in this one transaction: no update
-- can commit between them unlogged.
--
-- Locks: ACCESS EXCLUSIVE on channels (the trigger) and on servers (the
-- column), for catalog changes only: dropping a column rewrites and scans
-- nothing. Both are hot tables, so give up after 2 s rather than queue reads
-- behind a long transaction (the deploy runner retries a lock timeout).
-- IF EXISTS: a database made from another history may not have the column.
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
    OR OLD.server_id IS DISTINCT FROM NEW.server_id OR OLD.thread_sort IS DISTINCT FROM NEW.thread_sort
    OR OLD.announcement_artifact_id IS DISTINCT FROM NEW.announcement_artifact_id)
  EXECUTE FUNCTION public.change_log_channels_fn();--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN IF EXISTS "public_guest_join_enabled";
