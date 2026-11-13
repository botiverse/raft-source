-- Closed-server purge, `delete` mode (services/closedServerPurge.ts; design
-- "Purging closed servers 30 days after closing" v6, "Progress"): its
-- progress on the servers row, so a purge stopped by a crash, a deploy or
-- its run budget resumes where it was, and two runs never purge one server.
--   purge_state        the step the purge is on: apps, channels,
--                      object_events, agents, scrub; blocked (channels it
--                      could not clear, retried later); rows_deleted
--                      (every step this version has is done; purged_at
--                      stays NULL until a later version runs the design's
--                      remaining steps); done.
--   purge_lease_until  until when the run that claimed the server holds it.
--   purge_lease_token  which run holds it: every batch re-checks the token,
--                      the lease and that the server is still closed over
--                      30 days, under the row's lock, before it deletes.
--   purged_at          when the purge finished (the row itself is kept as
--                      the tombstone, its slug reserved).
--
-- Existing rows stay NULL: no backfill, no default, no NOT NULL. Safe for the
-- serving and rollback images: none of them reads or writes these columns
-- (drizzle names its columns, so older images never see them).
--
-- Additive only. Nullable columns rewrite no rows. The CHECK is added NOT
-- VALID and stays so: every existing row is NULL in purge_state, so none can
-- violate it, and every write from now on is checked; a VALIDATE here would
-- scan the table under the ACCESS EXCLUSIVE lock the ADD COLUMNs took.
-- Locks: ACCESS EXCLUSIVE on servers, a hot table, for the catalog changes
-- only: wait at most 2 s (the deploy retries) and do nothing else here.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "purge_state" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "purge_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "purge_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_purge_state_known" CHECK ("servers"."purge_state" IS NULL OR "servers"."purge_state" IN ('apps', 'channels', 'object_events', 'agents', 'scrub', 'blocked', 'rows_deleted', 'done')) NOT VALID;
