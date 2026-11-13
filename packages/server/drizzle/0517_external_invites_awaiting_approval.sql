-- Guest + external channels P2a-1 follow-up (#wg-rbac:#16): an external invite
-- whose invitee asked to connect a server needing an owner/admin's approval
-- stays open as awaiting_approval (Cody). The status CHECK admits it, and the
-- one-open-invite-per-(channel, email) partial unique index now covers both
-- pending and awaiting_approval. channel_external_invites is new and empty in
-- production (external_channels_v1 is off), so the index rebuild is instant.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_status_known";--> statement-breakpoint
DROP INDEX "idx_channel_external_invites_pending_email";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_open_email" ON "channel_external_invites" USING btree ("channel_id","email") WHERE status IN ('pending', 'awaiting_approval');--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_status_known" CHECK ("channel_external_invites"."status" IN ('pending', 'awaiting_approval', 'accepted', 'revoked', 'expired'));