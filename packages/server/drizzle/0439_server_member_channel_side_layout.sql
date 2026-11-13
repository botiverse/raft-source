-- server_members.channel_side_layout: where Thread, Tasks and Files stand
-- right of a channel (task #165), written by PATCH /servers/:id/sidebar-order
-- and read leniently (a value that doesn't parse reads as never saved).
-- Nullable, no default (metadata-only), but ADD COLUMN still takes an ACCESS
-- EXCLUSIVE lock and server_members is read on most requests: give up after
-- 5 s rather than queue every read behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "channel_side_layout" jsonb;
