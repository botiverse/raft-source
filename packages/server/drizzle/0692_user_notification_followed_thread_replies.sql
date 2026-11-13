-- #triage:#357: "Replies in threads I follow" (docs/contracts/notifications.md
-- §1.2, §2.1), one account-wide switch beside the other notification
-- settings. Off: a reply in a followed thread or task conversation alerts
-- only when it @mentions the user; following and Activity are unchanged.
-- Every existing row (and no row at all) reads as on, today's behaviour.
--
-- Catalog-only: ADD COLUMN with a constant default and NOT NULL rewrites
-- nothing (PostgreSQL 11+) and takes the ACCESS EXCLUSIVE lock only for the
-- catalog change. The dispatcher reads this table for every notification
-- batch, so give up after 2 s (the deploy retries) rather than queue reads
-- behind a long transaction. No index, no backfill, no CHECK (a boolean).
--
-- Rolling deploy: an older replica names its own columns, never this one; a
-- row it inserts gets the default (on), and its upsert leaves the column as is.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD COLUMN "followed_thread_replies" boolean DEFAULT true NOT NULL;
