-- External invites connect several servers at once (#wg-rbac:#16, behind
-- external_channels_v1): an invite may have one pending approval request per
-- server it connects (the unique index moves from the invite to the invite and
-- server); a connecting invite holds the further servers the invitee owns or
-- administers that it connects one after another (connect_queued_server_ids,
-- empty unless connecting: kept by the code; no CHECK yet, so an older node's
-- writes during a rolling deploy are not refused); and every server connected
-- with it is recorded (connected_server_ids: the invitee's page lists only
-- those as connected by it). Both tables are small; the new columns have
-- constant defaults (catalog only, no rewrite). Older server code never reads
-- the new columns and used the dropped index for uniqueness only.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_server_connect_requests_pending_invite_target" ON "channel_server_connect_requests" USING btree ("invite_id","target_server_id") WHERE status = 'pending';--> statement-breakpoint
DROP INDEX "idx_channel_server_connect_requests_pending_invite";--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_queued_server_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connected_server_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
