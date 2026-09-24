CREATE TABLE "native_notification_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_family_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"scope" text DEFAULT 'notifications:stream' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"rotated_from_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_notification_credentials_scope" CHECK ("native_notification_credentials"."scope" = 'notifications:stream')
);
--> statement-breakpoint
CREATE TABLE "native_notification_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"origin_session_family_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"app_version" text NOT NULL,
	"release_channel" text NOT NULL,
	"app_instance_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"attestation_state" text NOT NULL,
	"attestation_evidence_hash" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_notification_devices_protocol_v1" CHECK ("native_notification_devices"."protocol_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "native_notification_enrollment_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_family_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"app_id" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"app_version" text NOT NULL,
	"release_channel" text NOT NULL,
	"app_instance_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"nonce" text NOT NULL,
	"attestation_state" text NOT NULL,
	"attestation_evidence_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_notification_grants_protocol_v1" CHECK ("native_notification_enrollment_grants"."protocol_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "native_notification_events" (
	"stream_seq" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"target_uri" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "native_notification_events_version_v1" CHECK ("native_notification_events"."version" = 1),
	CONSTRAINT "native_notification_events_title_bounds" CHECK (char_length("native_notification_events"."title") BETWEEN 1 AND 160),
	CONSTRAINT "native_notification_events_body_bounds" CHECK (char_length("native_notification_events"."body") BETWEEN 1 AND 512),
	CONSTRAINT "native_notification_events_target_uri_bounds" CHECK (char_length("native_notification_events"."target_uri") BETWEEN 1 AND 512)
);
--> statement-breakpoint
ALTER TABLE "native_notification_credentials" ADD CONSTRAINT "native_notification_credentials_device_id_native_notification_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."native_notification_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_credentials" ADD CONSTRAINT "native_notification_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_credentials" ADD CONSTRAINT "native_notification_credentials_session_family_id_session_families_id_fk" FOREIGN KEY ("session_family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_devices" ADD CONSTRAINT "native_notification_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_devices" ADD CONSTRAINT "native_notification_devices_origin_session_family_id_session_families_id_fk" FOREIGN KEY ("origin_session_family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_enrollment_grants" ADD CONSTRAINT "native_notification_enrollment_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_enrollment_grants" ADD CONSTRAINT "native_notification_enrollment_grants_session_family_id_session_families_id_fk" FOREIGN KEY ("session_family_id") REFERENCES "public"."session_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_events" ADD CONSTRAINT "native_notification_events_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_notification_events" ADD CONSTRAINT "native_notification_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_native_notification_credentials_active_device" ON "native_notification_credentials" USING btree ("device_id") WHERE "native_notification_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_native_notification_credentials_user" ON "native_notification_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_native_notification_credentials_family" ON "native_notification_credentials" USING btree ("session_family_id");--> statement-breakpoint
CREATE INDEX "idx_native_notification_credentials_expiry" ON "native_notification_credentials" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_native_notification_devices_active_binding" ON "native_notification_devices" USING btree ("user_id","app_id","app_instance_id") WHERE "native_notification_devices"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_native_notification_devices_user" ON "native_notification_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_native_notification_devices_family" ON "native_notification_devices" USING btree ("origin_session_family_id");--> statement-breakpoint
CREATE INDEX "idx_native_notification_grants_expiry" ON "native_notification_enrollment_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_native_notification_grants_family" ON "native_notification_enrollment_grants" USING btree ("session_family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_native_notification_events_event_id" ON "native_notification_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_native_notification_events_dedupe_key" ON "native_notification_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_native_notification_events_user_stream" ON "native_notification_events" USING btree ("recipient_user_id","stream_seq");--> statement-breakpoint
CREATE INDEX "idx_native_notification_events_expiry" ON "native_notification_events" USING btree ("expires_at");