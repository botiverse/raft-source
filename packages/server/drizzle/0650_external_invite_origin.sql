-- Which creation path made an external invite (channel_external_invites.origin;
-- services/externalInviteService.ts insertExternalInvites): external_invite
-- (the host owner/admin's email invite or its resend), host_direct (their
-- "Your servers" direct connect), self_connect (a channel member connecting a
-- server of theirs; a later release). The connect worker refuses a value it
-- does not know, and a host_direct operation by someone already in the joint
-- records the connected server as a source of their current membership.
--
-- Existing rows stay NULL: created before this column, origin not recorded.
-- No backfill, no default, no NOT NULL: during the rolling deploy and its
-- rollback window older nodes insert without the column. A NULL guard for new
-- rows comes in a later release, once every writer sets it.
--
-- Additive only: a nullable column rewrites no rows; the CHECK reads the table
-- once (every row NULL). Bounded lock wait: give up after 5 s (the deploy
-- retries) rather than queue writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_origin_known" CHECK ("channel_external_invites"."origin" IS NULL OR "channel_external_invites"."origin" IN ('external_invite', 'host_direct', 'self_connect'));
