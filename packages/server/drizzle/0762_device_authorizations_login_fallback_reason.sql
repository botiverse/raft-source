-- Why a Computer asked for a device code after trying (or skipping) the
-- loopback redirect login: its LoginModeFallbackReason ("bind_failed",
-- "browser_open_failed", "ssh", ...), sent as the authorize body's optional
-- `loginFallbackReason`. Until now the Computer kept it only in its local
-- traces. NULL when loopback was not involved, for older Computers, and for a
-- malformed value (never a reason to refuse the login). Audit only; not used
-- for any decision.
--
-- Catalog-only: a nullable column with no default rewrites nothing and scans
-- nothing under the ACCESS EXCLUSIVE lock. Every authorize and poll touches
-- this table, so give up after 2 s (the deploy retries) rather than queue them
-- behind a long transaction. No index (never searched by), no backfill.
--
-- Rolling deploy: an older replica names its own columns, never this one, and
-- its rows have none, as before. Rollback: the previous release never reads
-- the column; drop it freely.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "login_fallback_reason" text;
