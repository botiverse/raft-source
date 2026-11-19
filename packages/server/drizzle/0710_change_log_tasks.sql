-- change_log: the `task` entity (#wg-task-v2:7b87bf4a; contract: shared
-- syncChanges.ts). One row per task created, deleted, or changed in a column
-- the task list (GET /api/tasks/channel/:id) shows, in the task's channel
-- scope (its storage channel; a joint's canonical one, mapped to the viewer's
-- projection at read time, as `message` rows are). GET /api/sync/changes
-- rebuilds the task as that list holds it for the viewer.
--
-- A trigger, not calls in code (unlike `message`, messageChangeLog.ts):
-- tasks is lightly written and has many write paths, and one missed path
-- leaves a client showing a stale task. The columns below are the list row's
-- own (taskSyncColumns.test.ts fails when the row gains one not listed).
-- updated_at and last_activity_at are left out on purpose: bookkeeping and
-- conversation activity, not a change of the task.
--
-- A task moved to another channel is a delete in the old channel's scope and
-- an upsert in the new one. A task deleted with its channel (cascade) logs
-- nothing: the channel's own delete covers it.
--
-- The task status cleanup script (in_review -> in_progress, run once after
-- task v2 is on for everyone) sets SET LOCAL slock.task_status_cleanup = 'on'
-- and, in the same transaction, writes one `task_channel` row per channel it
-- changed (sent as `task` op `resnapshot`: re-read that channel's tasks)
-- instead of one row per task. No server code path sets it
-- (taskSyncColumns.test.ts greps for it).
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_tasks_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_tasks_fn$
DECLARE
  r public.tasks%ROWTYPE;
  ch record;
BEGIN
  IF current_setting('slock.task_status_cleanup', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.channel_id IS DISTINCT FROM NEW.channel_id THEN
    SELECT c.server_id, c.parent_channel_id INTO ch FROM public.channels c WHERE c.id = OLD.channel_id;
    IF FOUND THEN
      PERFORM public.change_log_add(ch.server_id, 'channel', OLD.channel_id, ch.parent_channel_id, 'task', OLD.id::text, 'delete');
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  SELECT c.server_id, c.parent_channel_id INTO ch FROM public.channels c WHERE c.id = r.channel_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM public.change_log_add(ch.server_id, 'channel', r.channel_id, ch.parent_channel_id, 'task', r.id::text,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  RETURN NULL;
END
$change_log_tasks_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_tasks_ins_del AFTER INSERT OR DELETE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.change_log_tasks_fn();--> statement-breakpoint
CREATE TRIGGER change_log_tasks_upd AFTER UPDATE ON public.tasks
  FOR EACH ROW WHEN (
    OLD.channel_id IS DISTINCT FROM NEW.channel_id
    OR OLD.task_number IS DISTINCT FROM NEW.task_number
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
    OR OLD.created_by_id IS DISTINCT FROM NEW.created_by_id
    OR OLD.claimed_by_type IS DISTINCT FROM NEW.claimed_by_type
    OR OLD.claimed_by_id IS DISTINCT FROM NEW.claimed_by_id
    OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at
    OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
    OR OLD.requires_resource_receipt IS DISTINCT FROM NEW.requires_resource_receipt
    OR OLD.resource_receipt IS DISTINCT FROM NEW.resource_receipt
    OR OLD.resource_receipt_recorded_at IS DISTINCT FROM NEW.resource_receipt_recorded_at
    OR OLD.resource_teardown_owner_agent_id IS DISTINCT FROM NEW.resource_teardown_owner_agent_id
    OR OLD.resource_expiry_followup_id IS DISTINCT FROM NEW.resource_expiry_followup_id
    OR OLD.revision IS DISTINCT FROM NEW.revision
    OR OLD.message_id IS DISTINCT FROM NEW.message_id
    OR OLD.conversation_channel_id IS DISTINCT FROM NEW.conversation_channel_id
    OR OLD.own_conversation IS DISTINCT FROM NEW.own_conversation
    OR OLD.source_message_id IS DISTINCT FROM NEW.source_message_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at)
  EXECUTE FUNCTION public.change_log_tasks_fn();
