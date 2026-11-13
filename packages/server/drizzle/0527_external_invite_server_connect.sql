-- Guest + external channels P2a-3 (#wg-rbac:#16): connecting a server with an
-- external invite (behind external_channels_v1).
--
-- channel_external_invites gains status connecting, for an invite whose
-- channel first has to become joint: connect_phase says whether the
-- channel's conversion job (connect_conversion_job_id) is still running
-- ("conversion", the invite cannot be revoked) or committed ("connection",
-- the worker connects connect_server_id and retries until it does).
-- connect_generation is fresh for each reservation and copied onto the
-- conversion job (external_connect_generation); every later write to the
-- reservation matches it, so a worker acting on an earlier reservation of the
-- same invite changes nothing.
-- connect_joiner_user_id is who joins on that server, connect_authorizer_user_id
-- its owner/admin who connected or approved; both are re-checked when
-- connecting. A connecting invite is still open: the one-open-invite-per-
-- (channel, email) index covers it, and a second partial unique index allows
-- one connecting invite per channel. channel_server_connect_requests records
-- an invitee's request that an owner/admin of their server approve.
--
-- Lock budget: channel_external_invites is new and empty in production
-- (external_channels_v1 is off), so its index rebuild and CHECKs are instant.
-- channel_conversion_jobs gains a nullable column without a default: a
-- catalog-only change under a brief ACCESS EXCLUSIVE lock (lock_timeout).
-- The new table's foreign keys take SHARE ROW EXCLUSIVE on the referenced
-- tables; fail fast instead of queueing writers behind the DDL (the deploy
-- retries). The channels FK is added NOT VALID and validated separately, as in
-- 0515, so that lock is never held across a scan.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "channel_server_connect_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invite_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"host_server_id" uuid NOT NULL,
	"target_server_id" uuid NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cancel_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "channel_server_connect_requests_status_known" CHECK ("channel_server_connect_requests"."status" IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
	CONSTRAINT "channel_server_connect_requests_cancel_reason_known" CHECK ("channel_server_connect_requests"."cancel_reason" IS NULL OR "channel_server_connect_requests"."cancel_reason" IN ('approver_lost_role', 'requester_left', 'invite_revoked'))
);
--> statement-breakpoint
ALTER TABLE "channel_external_invites" DROP CONSTRAINT "channel_external_invites_status_known";--> statement-breakpoint
DROP INDEX "idx_channel_external_invites_open_email";--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD COLUMN "external_connect_generation" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_phase" text;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_server_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_joiner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_authorizer_user_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_conversion_job_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_generation" uuid;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD COLUMN "connect_last_error" text;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_invite_id_channel_external_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."channel_external_invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" VALIDATE CONSTRAINT "channel_server_connect_requests_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_host_server_id_servers_id_fk" FOREIGN KEY ("host_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_server_connect_requests" ADD CONSTRAINT "channel_server_connect_requests_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_server_connect_requests_pending_invite" ON "channel_server_connect_requests" USING btree ("invite_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_channel_server_connect_requests_approver" ON "channel_server_connect_requests" USING btree ("approver_user_id","status");--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_server_id_servers_id_fk" FOREIGN KEY ("connect_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_joiner_user_id_users_id_fk" FOREIGN KEY ("connect_joiner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_authorizer_user_id_users_id_fk" FOREIGN KEY ("connect_authorizer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_conversion_job_id_channel_conversion_jobs_id_fk" FOREIGN KEY ("connect_conversion_job_id") REFERENCES "public"."channel_conversion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_one_connecting" ON "channel_external_invites" USING btree ("channel_id") WHERE status = 'connecting';--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_open_email" ON "channel_external_invites" USING btree ("channel_id","email") WHERE status IN ('pending', 'awaiting_approval', 'connecting');--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_phase_iff_connecting" CHECK (("channel_external_invites"."status" = 'connecting') = ("channel_external_invites"."connect_phase" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_generation_iff_connecting" CHECK (("channel_external_invites"."status" = 'connecting') = ("channel_external_invites"."connect_generation" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_connect_phase_known" CHECK ("channel_external_invites"."connect_phase" IS NULL OR "channel_external_invites"."connect_phase" IN ('conversion', 'connection'));--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_status_known" CHECK ("channel_external_invites"."status" IN ('pending', 'awaiting_approval', 'connecting', 'accepted', 'revoked', 'expired'));