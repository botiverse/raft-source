-- Retire Guest joining (#wg-rbac:#47, cindyz), step 1 of 2, part 2 of 2:
-- clear the retired admission columns, so an older task still serving during
-- the rollout, or a rollback to it, admits nobody through them either.
-- Replica counts (Tenny): 9 undeleted channels with guest_joinable = true (on
-- 3 public servers), 0 servers with public_guest_join_enabled.
--
-- guest_visible (the channels a public server shows signed-out visitors) and
-- publicly_visible are not touched.
--
-- Data only; schema.ts stopped declaring both columns in 0653's snapshot, and
-- a later release drops them (see 0653).
--
-- schema-snapshot: unchanged (data only; 0653's snapshot already lacks both columns)
--
-- Locks: ROW EXCLUSIVE on channels and servers (reads and other writes go on)
-- and row locks on the rows changed only. channels has no index on
-- guest_joinable, so the UPDATE is one sequential scan; no ACCESS EXCLUSIVE
-- lock is held meanwhile (0653 took and released those). A row lock held by a
-- long transaction makes this give up after 2 s (the deploy runner retries).
-- The channels UPDATE fires change_log_channels_upd (its WHEN names
-- guest_joinable), so sync clients refetch the changed channels once.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
UPDATE "channels" SET "guest_joinable" = false WHERE "guest_joinable";--> statement-breakpoint
UPDATE "servers" SET "public_guest_join_enabled" = false WHERE "public_guest_join_enabled";
