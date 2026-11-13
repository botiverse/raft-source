-- Guest + external channels P2a-1 (#wg-rbac:#16): channel_external_invites
-- records a host Server owner's or admin's email invite of someone outside the
-- Server to one of its channels (send, list, resend, revoke; behind
-- external_channels_v1, which no migration seeds). Accepting one (a later
-- migration's work) sets outcome guest/server/new_server, so the CHECK ties
-- outcome to status = 'accepted'. At most one pending invite per channel and
-- email (partial unique index); (host_server_id, created_at) serves the daily
-- send cap.
--
-- Lock budget: the table is new and empty, so only its foreign keys touch
-- existing tables: each takes SHARE ROW EXCLUSIVE on the referenced table
-- (channels is 377 MB and hot; servers and users are read-mostly). Fail fast
-- instead of queueing writers behind the DDL (the deploy retries). The channels
-- FK is added NOT VALID and validated separately, as in 0511, so that lock is
-- never held across a scan; the new table has no rows, so validation is
-- instant. No ON DELETE action on channel_id: channels are soft-deleted.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "channel_external_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"host_server_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"accepted_user_id" uuid,
	"accepted_server_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "channel_external_invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "channel_external_invites_status_known" CHECK ("channel_external_invites"."status" IN ('pending', 'accepted', 'revoked', 'expired')),
	CONSTRAINT "channel_external_invites_outcome_known" CHECK ("channel_external_invites"."outcome" IS NULL OR "channel_external_invites"."outcome" IN ('guest', 'server', 'new_server')),
	CONSTRAINT "channel_external_invites_outcome_iff_accepted" CHECK (("channel_external_invites"."status" = 'accepted') = ("channel_external_invites"."outcome" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "channel_external_invites" VALIDATE CONSTRAINT "channel_external_invites_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_host_server_id_servers_id_fk" FOREIGN KEY ("host_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_accepted_server_id_servers_id_fk" FOREIGN KEY ("accepted_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_external_invites" ADD CONSTRAINT "channel_external_invites_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_external_invites_pending_email" ON "channel_external_invites" USING btree ("channel_id","email") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_channel_external_invites_host_created" ON "channel_external_invites" USING btree ("host_server_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_channel_external_invites_channel" ON "channel_external_invites" USING btree ("channel_id");