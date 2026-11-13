-- Joint membership sources per external invite (services/
-- externalInviteConnectService.ts, "Membership sources"): the invite is one
-- operation of its invitee's, however many servers it connects, and records
-- which of them are sources of the joiner's joint membership (computed
-- mode). Set when the invitee first uses the invite; never cleared.
--
-- Additive only: three nullable columns rewrite no rows; the CHECK reads
-- channel_external_invites once (every row NULL) and only this release
-- writes the column. Bounded lock wait: give up after 5 s (the deploy
-- retries) rather than queue writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "source_state" text;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "source_start_generation" integer;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "source_generation" integer;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_source_state_known" CHECK ("channel_external_invites"."source_state" IS NULL OR "channel_external_invites"."source_state" IN ('awaiting_joint_creation', 'awaiting_first_join', 'joined', 'member_at_start', 'no_sources'));