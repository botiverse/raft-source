-- user_channel_read_cursors.marked_unread: Mark as Unread on a conversation
-- with nothing others wrote past the read cursor (a thread whose only message
-- from someone else is its parent, which lives in the parent channel). The
-- cursor cannot say "unread" there, so the sequencer sets this flag instead;
-- any read write of the scope clears it. NOT NULL DEFAULT false is
-- metadata-only (no table rewrite), but ADD COLUMN and CREATE TRIGGER lock one
-- of the most written tables: give up after 1.5 s (as 0461 on this table; the
-- read sequencer's own lock timeout is 3 s) rather than queue every read
-- report behind a long transaction. Its index is the next migration
-- (read_cursor_marked_unread_index).
SET LOCAL lock_timeout = '1500ms';--> statement-breakpoint
ALTER TABLE "user_channel_read_cursors" ADD COLUMN "marked_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- change_log (GET /api/sync/changes, sync:changed): setting or clearing the
-- flag is a read-state change even when the position stays (0461 logged only
-- a moved position). ref_seq stays the position; clients order by
-- readStateVersion from the pulled state.
DROP TRIGGER IF EXISTS change_log_read_cursors_upd ON public.user_channel_read_cursors;--> statement-breakpoint
CREATE TRIGGER change_log_read_cursors_upd AFTER UPDATE OF last_read_seq, marked_unread ON public.user_channel_read_cursors
  FOR EACH ROW WHEN (OLD.last_read_seq IS DISTINCT FROM NEW.last_read_seq OR OLD.marked_unread IS DISTINCT FROM NEW.marked_unread)
  EXECUTE FUNCTION public.change_log_read_cursor_fn();
