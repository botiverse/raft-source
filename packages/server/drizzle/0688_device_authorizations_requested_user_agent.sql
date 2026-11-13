-- The User-Agent a grantless device authorize (a code that asks for a device
-- session) came with, so a later check can tell which client binary started
-- it. A grant keeps its own copy (device_login_grants.requested_user_agent).
-- Cleared with the other requester details after 30 days
-- (scrubDeviceAuthorizationRequesterDetails).
--
-- Catalog-only: a nullable column with no default rewrites nothing and scans
-- nothing under the ACCESS EXCLUSIVE lock. Every authorize and poll touches
-- this table, so give up after 2 s (the deploy retries) rather than queue them
-- behind a long transaction. No index (never searched by), no backfill.
--
-- Rolling deploy: an older replica names its own columns, never this one, and
-- its rows have none, as before.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN "requested_user_agent" text;
