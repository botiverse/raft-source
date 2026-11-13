-- Retire Guest joining (#wg-rbac:#47, cindyz), step 1 of 2, part 1 of 2:
-- drop the two CHECKs that tie the retired admission columns to the reading
-- ones.
--   channels_guest_joinable_requires_visible      NOT guest_joinable OR guest_visible
--   servers_public_guest_join_requires_visibility NOT public_guest_join_enabled OR publicly_visible
--
-- This release no longer declares channels.guest_joinable or
-- servers.public_guest_join_enabled (so this migration's snapshot no longer
-- has them or the CHECKs), and nothing in it reads or writes them. The
-- columns stay: the release serving now and the rollback image name them in
-- every INSERT and plain SELECT (docs/operations/server-release.md). A later
-- release drops them, once no serving or rollback image declares them, with
-- `-- schema-snapshot: unchanged`; it must first recreate
-- change_log_channels_upd without guest_joinable in its WHEN (0608), since a
-- trigger that names a column blocks DROP COLUMN without CASCADE.
--
-- Why drop the CHECKs now: this release can turn guest_visible or
-- publicly_visible off without touching the retired column beside it. An
-- older task still serving during the rollout could set that column true
-- (guest_joinable on a channel, public Guest join on a server); with the CHECK
-- in place this release's next write turning the reading flag off would then
-- fail. Dropping a CHECK only loosens: no older image depends on it (they
-- validate both columns in the API too). 0654 then clears the columns.
--
-- Locks: ACCESS EXCLUSIVE on channels and on servers, for the catalog change
-- only (dropping a CHECK scans and rewrites nothing). Both are hot tables, so
-- the wait is at most 2 s (the deploy runner retries a lock timeout) and
-- nothing else is done in this transaction; the UPDATEs are 0654, in their
-- own transaction, so no seq scan runs while these locks are held. IF EXISTS:
-- a database made from another history may not have them.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_guest_joinable_requires_visible";--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT IF EXISTS "servers_public_guest_join_requires_visibility";
