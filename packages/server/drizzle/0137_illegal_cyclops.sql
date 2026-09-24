CREATE TABLE "channel_conversion_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"source_channel_type" text NOT NULL,
	"target_kind" text DEFAULT 'joint' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'prepare' NOT NULL,
	"canonical_channel_id" uuid,
	"joint_channel_id" uuid,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD CONSTRAINT "channel_conversion_jobs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD CONSTRAINT "channel_conversion_jobs_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD CONSTRAINT "channel_conversion_jobs_canonical_channel_id_channels_id_fk" FOREIGN KEY ("canonical_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD CONSTRAINT "channel_conversion_jobs_joint_channel_id_joint_channels_id_fk" FOREIGN KEY ("joint_channel_id") REFERENCES "public"."joint_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_conversion_jobs" ADD CONSTRAINT "channel_conversion_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_jobs_server_status" ON "channel_conversion_jobs" USING btree ("server_id","status");--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_jobs_phase" ON "channel_conversion_jobs" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "idx_channel_conversion_jobs_lease" ON "channel_conversion_jobs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_channel_conversion_jobs_active_source" ON "channel_conversion_jobs" USING btree ("source_channel_id") WHERE status in ('pending', 'running', 'failed');