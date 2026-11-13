-- self_connecting (channel_external_invites.status): a self_connect operation
-- (a channel member connecting a server of theirs, jointMemberConnectService)
-- in flight on a private channel being converted. Its own status so a node of
-- an older release, whose worker scans status = 'connecting' only and makes
-- none of its identity checks, never picks one up during a rolling deploy or
-- after a rollback (design v3 §10); this release's worker scans both.
--
-- Every constraint that names 'connecting' takes 'self_connecting' with it:
-- the status CHECK, the three connect_* iff CHECKs, the one-connection-per-
-- channel and one-open-invite-per-address unique indexes. Widening only: every
-- row an older node writes still passes, and an older node's insert of a
-- second connection on a channel with a self_connecting one fails on the
-- unique index (refused, never doubled).
--
-- self_member_joined_at / self_guest_released_at: nullable, no default (no
-- row rewritten). The table is small (open invites, 14-day lifetime); the
-- indexes are rebuilt in this transaction. Bounded lock wait: give up after 5 s
-- (the deploy retries) rather than queue writes behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_status_known";--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_connect_phase_iff_connecting";--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_connect_generation_iff_connecting";--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_connect_outcome_iff_connecting";--> statement-breakpoint
DROP INDEX "idx_channel_external_invites_open_email";--> statement-breakpoint
DROP INDEX "idx_channel_external_invites_one_connecting";--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "self_member_joined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "self_guest_released_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_open_email" ON "channel_external_invites" USING btree ("channel_id","email") WHERE status IN ('pending', 'awaiting_approval', 'connecting', 'self_connecting');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_one_connecting" ON "channel_external_invites" USING btree ("channel_id") WHERE status IN ('connecting', 'self_connecting');--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_status_known" CHECK ("channel_external_invites"."status" IN ('pending', 'awaiting_approval', 'connecting', 'self_connecting', 'accepted', 'revoked', 'expired'));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_phase_iff_connecting" CHECK (("channel_external_invites"."status" IN ('connecting', 'self_connecting')) = ("channel_external_invites"."connect_phase" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_generation_iff_connecting" CHECK (("channel_external_invites"."status" IN ('connecting', 'self_connecting')) = ("channel_external_invites"."connect_generation" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_outcome_iff_connecting" CHECK (("channel_external_invites"."status" IN ('connecting', 'self_connecting')) = ("channel_external_invites"."connect_outcome" IS NOT NULL));