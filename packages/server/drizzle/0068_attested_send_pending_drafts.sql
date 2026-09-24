CREATE TABLE "attested_send_pending_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_ref" text NOT NULL,
	"content" text NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attested_up_to_seq" bigint NOT NULL,
	"attested_up_to_message_id" uuid,
	"new_message_count_at_hold" integer NOT NULL,
	"rehold_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attested_send_draft_outcomes" (
	"draft_id" text PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attested_send_pending_drafts" ADD CONSTRAINT "attested_send_pending_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attested_send_pending_drafts" ADD CONSTRAINT "attested_send_pending_drafts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attested_send_pending_drafts" ADD CONSTRAINT "attested_send_pending_drafts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attested_send_pending_drafts_agent_channel" ON "attested_send_pending_drafts" USING btree ("agent_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_attested_send_pending_drafts_expires_at" ON "attested_send_pending_drafts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_attested_send_draft_outcomes_expires_at" ON "attested_send_draft_outcomes" USING btree ("expires_at");
