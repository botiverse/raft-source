-- change_log read_state rows only for a read position that moved. 0450 logged
-- them from the BEFORE trigger read_cursor_mirror_user_trg, but read reports
-- write the cursor with INSERT ... ON CONFLICT DO UPDATE ... WHERE (position
-- greater), and Postgres fires BEFORE INSERT for every attempt, whether or not
-- the row is inserted. So each report logged a row: one for a repeated
-- position, one carrying a lower ref_seq for a stale report the WHERE
-- rejected, and two (INSERT, then UPDATE) for a real move. AFTER INSERT fires
-- only for an inserted row and AFTER UPDATE only for an applied update, so the
-- log moves to an AFTER trigger; its WHEN keeps updates that leave the
-- position alone (read_state_version and the like) from queuing an event on
-- this hot table. The BEFORE trigger goes back to the mirror alone.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on one of the most written tables:
-- the lock timeout keeps it from queueing behind a long transaction with every
-- read report waiting behind it (as in 0458).
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.read_cursor_mirror_user_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.last_read_seq8 := NEW.last_read_seq;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.change_log_read_cursor_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $change_log_read_cursor_fn$
DECLARE v_server uuid;
BEGIN
  SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
  PERFORM public.change_log_add(v_server, 'user', NEW.user_id, NULL, 'read_state', NEW.channel_id::text,
    'upsert', NEW.last_read_seq::bigint);
  RETURN NULL;
END
$change_log_read_cursor_fn$;--> statement-breakpoint
CREATE TRIGGER change_log_read_cursors_ins AFTER INSERT ON public.user_channel_read_cursors
  FOR EACH ROW EXECUTE FUNCTION public.change_log_read_cursor_fn();--> statement-breakpoint
CREATE TRIGGER change_log_read_cursors_upd AFTER UPDATE OF last_read_seq ON public.user_channel_read_cursors
  FOR EACH ROW WHEN (OLD.last_read_seq IS DISTINCT FROM NEW.last_read_seq)
  EXECUTE FUNCTION public.change_log_read_cursor_fn();
