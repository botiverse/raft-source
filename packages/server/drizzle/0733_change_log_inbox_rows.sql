-- change_log: the `inbox_row` entity (#triage:#244, sync inbox rows PR2;
-- read side: services/syncChanges.ts mapChangeRow and services/syncInboxRows.ts).
-- A person's Activity row changed in a way no other change_log row says:
--   - inbox_suppression_states (Done watermarks, services/inboxSuppressionWriters.ts):
--     a mention Done, or a Done whose conversation already has newer activity,
--     writes the watermark (and a read position, when it moved) but no
--     Done marker, so before this nothing told sync the row changed (its @
--     went). ref_seq = the watermark (done_through_seq) when a Done wrote it
--     (write_site markChannelInboxDone / markThreadDone): the position a sync
--     pull compares the row against, as it does a Done's. NULL for the other
--     writers (an unfollow's watermark does not take the row out of Activity
--     All) and when the watermark is cleared (undone, follow again).
--   - inbox_target_mute_states (a channel / DM mute or unmute): ref_seq NULL.
-- People only (receiver_type 'user'); agents have no sync. In the person's
-- user scope, entity_id = the row's own id (target_channel_id /
-- source_channel_id, the viewer's local id). A retracted message logs the same
-- entity in its channel's scope from code (messageChangeLog.ts logInboxRowChanged):
-- every member's row may show it.
--
-- GET /api/sync/changes reads these rows only for a request with the
-- inbox_row capability on a server with sync_inbox_rows_v0 on; any other read
-- leaves them out in SQL, so its response is exactly as before.
--
-- Triggers, like the per-person state of 0450: each table is written from
-- several paths and the row has to be logged in the writing transaction.
-- Updates log only a change of what Activity reads (the watermark; the mute
-- and its start), not done_at / updated_at / prefs_version bookkeeping.
-- The row carries server_id: no lookup.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_inbox_suppression_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_inbox_suppression_fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.change_log_add(OLD.server_id, 'user', OLD.receiver_id, NULL, 'inbox_row', OLD.target_channel_id::text, 'upsert', NULL);
  ELSE
    PERFORM public.change_log_add(NEW.server_id, 'user', NEW.receiver_id, NULL, 'inbox_row', NEW.target_channel_id::text, 'upsert',
      CASE WHEN NEW.write_site IN ('channel.markChannelInboxDone', 'thread.markThreadDone') THEN NEW.done_through_seq END);
  END IF;
  RETURN NULL;
END
$change_log_inbox_suppression_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_inbox_suppression_ins AFTER INSERT ON public.inbox_suppression_states
  FOR EACH ROW WHEN (NEW.receiver_type = 'user')
  EXECUTE FUNCTION public.change_log_inbox_suppression_fn();--> statement-breakpoint
CREATE TRIGGER change_log_inbox_suppression_del AFTER DELETE ON public.inbox_suppression_states
  FOR EACH ROW WHEN (OLD.receiver_type = 'user')
  EXECUTE FUNCTION public.change_log_inbox_suppression_fn();--> statement-breakpoint
CREATE TRIGGER change_log_inbox_suppression_upd AFTER UPDATE ON public.inbox_suppression_states
  FOR EACH ROW WHEN (NEW.receiver_type = 'user' AND (
    OLD.done_through_seq IS DISTINCT FROM NEW.done_through_seq
    OR OLD.target_channel_id IS DISTINCT FROM NEW.target_channel_id
    OR OLD.receiver_id IS DISTINCT FROM NEW.receiver_id))
  EXECUTE FUNCTION public.change_log_inbox_suppression_fn();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_inbox_mute_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog, pg_temp
AS $change_log_inbox_mute_fn$
DECLARE r public.inbox_target_mute_states%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM public.change_log_add(r.server_id, 'user', r.receiver_id, NULL, 'inbox_row', r.source_channel_id::text, 'upsert', NULL);
  RETURN NULL;
END
$change_log_inbox_mute_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_inbox_mute_ins AFTER INSERT ON public.inbox_target_mute_states
  FOR EACH ROW WHEN (NEW.receiver_type = 'user')
  EXECUTE FUNCTION public.change_log_inbox_mute_fn();--> statement-breakpoint
CREATE TRIGGER change_log_inbox_mute_del AFTER DELETE ON public.inbox_target_mute_states
  FOR EACH ROW WHEN (OLD.receiver_type = 'user')
  EXECUTE FUNCTION public.change_log_inbox_mute_fn();--> statement-breakpoint
CREATE TRIGGER change_log_inbox_mute_upd AFTER UPDATE ON public.inbox_target_mute_states
  FOR EACH ROW WHEN (NEW.receiver_type = 'user' AND (
    OLD.activity_muted IS DISTINCT FROM NEW.activity_muted
    OR OLD.mute_from_seq IS DISTINCT FROM NEW.mute_from_seq))
  EXECUTE FUNCTION public.change_log_inbox_mute_fn();
