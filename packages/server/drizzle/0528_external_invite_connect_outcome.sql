-- Guest + external channels P2a-5 (#wg-rbac:#16): an invitee creates a new
-- server and connects it with an external invite (behind
-- external_channels_v1).
--
-- channel_external_invites gains connect_outcome, part of a connecting
-- invite's reservation like connect_phase and connect_generation: how the
-- invite ends once the worker connects the server, "new_server" when the
-- invitee created it to connect it, else "server". Set when reserving, cleared
-- with the rest of the reservation; non-null exactly while connecting.
-- Reservations made before this migration are "server" (the only route that
-- reserved then), backfilled before the CHECK.
--
-- Lock budget: channel_external_invites is new and nearly empty in
-- production (external_channels_v1 is off), so the backfill and the CHECKs'
-- scans are instant. The column is nullable without a default: a
-- catalog-only change under a brief ACCESS EXCLUSIVE lock (lock_timeout);
-- fail fast instead of queueing writers behind the DDL (the deploy retries).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_outcome" text;--> statement-breakpoint
UPDATE "channel_external_invites" SET "connect_outcome" = 'server' WHERE "status" = 'connecting';--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_outcome_iff_connecting" CHECK (("channel_external_invites"."status" = 'connecting') = ("channel_external_invites"."connect_outcome" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_outcome_known" CHECK ("channel_external_invites"."connect_outcome" IS NULL OR "channel_external_invites"."connect_outcome" IN ('server', 'new_server'));