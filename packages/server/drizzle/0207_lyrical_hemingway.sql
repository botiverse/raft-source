CREATE TABLE "attachment_upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"uploader_id" text NOT NULL,
	"uploader_type" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"quota_month" text NOT NULL,
	"quota_reserved_bytes" bigint NOT NULL,
	"quota_limited" boolean NOT NULL,
	"quota_state" text DEFAULT 'reserved' NOT NULL,
	"verification_lease_id" uuid,
	"verification_lease_expires_at" timestamp with time zone,
	"object_etag" text,
	"verified_size_bytes" bigint,
	"verified_content_type" text,
	"object_cleanup_state" text DEFAULT 'not_required' NOT NULL,
	"object_cleanup_lease_id" uuid,
	"terminal_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_upload_sessions_size_positive" CHECK ("attachment_upload_sessions"."declared_size_bytes" > 0),
	CONSTRAINT "attachment_upload_sessions_reserved_bytes_nonnegative" CHECK ("attachment_upload_sessions"."quota_reserved_bytes" >= 0),
	CONSTRAINT "attachment_upload_sessions_cleanup_consistency" CHECK (("attachment_upload_sessions"."state" IN ('canceled', 'expired', 'failed') AND (
        ("attachment_upload_sessions"."object_cleanup_state" = 'deleting' AND "attachment_upload_sessions"."object_cleanup_lease_id" IS NOT NULL)
        OR ("attachment_upload_sessions"."object_cleanup_state" IN ('pending', 'deleted') AND "attachment_upload_sessions"."object_cleanup_lease_id" IS NULL)
      )) OR ("attachment_upload_sessions"."state" IN ('pending', 'verifying', 'completed')
        AND "attachment_upload_sessions"."object_cleanup_state" = 'not_required' AND "attachment_upload_sessions"."object_cleanup_lease_id" IS NULL)),
	CONSTRAINT "attachment_upload_sessions_terminal_consistency" CHECK (("attachment_upload_sessions"."state" = 'completed' AND "attachment_upload_sessions"."quota_state" = 'finalized' AND "attachment_upload_sessions"."completed_at" IS NOT NULL)
      OR ("attachment_upload_sessions"."state" IN ('canceled', 'expired', 'failed') AND "attachment_upload_sessions"."quota_state" = 'released')
      OR ("attachment_upload_sessions"."state" IN ('pending', 'verifying') AND "attachment_upload_sessions"."quota_state" = 'reserved'))
);
--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_upload_sessions_actor_request" ON "attachment_upload_sessions" USING btree ("server_id","uploader_type","uploader_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_upload_sessions_attachment" ON "attachment_upload_sessions" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_upload_sessions_storage_key" ON "attachment_upload_sessions" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_sessions_sweep" ON "attachment_upload_sessions" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_sessions_channel" ON "attachment_upload_sessions" USING btree ("channel_id");