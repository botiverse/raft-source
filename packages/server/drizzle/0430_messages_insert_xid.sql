-- Sync horizon (message catch-up). messages.seq is a bigserial allocated at
-- INSERT, but transactions commit in another order: a reader that returned
-- seq > since and advanced its cursor to the largest seq it saw never fetched a
-- smaller-seq message whose transaction committed later. insert_xid records the
-- inserting transaction (pg_current_xact_id()); readers compare it with their
-- snapshot's xmin (the horizon) to find rows that finished after they passed
-- their seq (messageService.syncMessagesWithHorizon).
--
-- messages is large and on every send path, so this is metadata-only under the
-- ACCESS EXCLUSIVE lock: a nullable column without a default (no rewrite, no
-- scan; rows written before it stay NULL = committed long ago) and a trigger.
-- The partial index idx_messages_insert_xid is NOT built here: the
-- post-migration lifecycle step (db:create-messages-insert-xid-index, run by
-- db:migrate:deploy after the migrations, then checked by the post-migration
-- index guard) builds it CONCURRENTLY. Bounded lock wait: if a long
-- transaction holds messages, give up after 5s (the deploy retries) instead of
-- queueing every send behind the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "insert_xid" "xid8";--> statement-breakpoint
-- Always the inserting transaction: a value the writer supplies (or an
-- explicit NULL) is overwritten, so no caller can place a row outside the
-- horizon. pg_current_xact_id() is the top-level transaction id even inside a
-- savepoint, which is the id snapshot visibility is decided by.
CREATE OR REPLACE FUNCTION public.messages_set_insert_xid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $messages_set_insert_xid$
BEGIN
  NEW.insert_xid := pg_current_xact_id();
  RETURN NEW;
END
$messages_set_insert_xid$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS messages_set_insert_xid ON public.messages;
--> statement-breakpoint
CREATE TRIGGER messages_set_insert_xid
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_set_insert_xid();
