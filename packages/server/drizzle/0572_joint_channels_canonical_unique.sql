-- One joint record per canonical channel (#triage:#30). Two first opens of
-- the same joint thread at once each read "no joint record" and each inserted
-- one; their local thread rows hung off different joint records, so a reply
-- through one was invisible through the other. The non-unique index on
-- canonical_channel_id becomes unique (same name), and
-- channelService.getOrCreateThreadForChannel upserts on it
-- (ON CONFLICT DO NOTHING, then reads the winner).
--
-- Production had 8,971 rows and no duplicate canonical_channel_id when this
-- was written, so the build does not fail. canonical_channel_id is NOT NULL,
-- so the index is not partial.
--
-- Lock budget: joint_channels is small. DROP INDEX takes a brief ACCESS
-- EXCLUSIVE and CREATE INDEX SHARE (writes wait for the build of ~9k rows),
-- both held until this migration's transaction commits; lock_timeout fails
-- fast instead of queueing readers behind the DDL (the deploy retries).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DROP INDEX "idx_joint_channels_canonical";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_joint_channels_canonical" ON "joint_channels" USING btree ("canonical_channel_id");
