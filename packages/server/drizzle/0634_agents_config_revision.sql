-- Reconciler step 11b: the revision of the config the server sends an
-- agent's daemon (services/agentConfigRevision.ts).
--
-- `agents` is a hot table. A constant DEFAULT on ADD COLUMN is metadata-only
-- on PostgreSQL 11 and later (the value is kept in pg_attribute, no row is
-- rewritten), so the ACCESS EXCLUSIVE lock is held only for the catalog
-- update. Bounded lock wait: give up after 2 s (the deploy retries) rather than
-- queue traffic behind a long transaction.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config_revision" bigint DEFAULT 0 NOT NULL;
