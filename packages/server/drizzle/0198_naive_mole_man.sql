CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"notification_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"config_revision" integer NOT NULL,
	"grant_revision" integer NOT NULL,
	"subscription_revision" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"terminal_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_attempt_count_nonnegative" CHECK ("notification_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"config_revision" integer NOT NULL,
	"http_status" integer,
	"outcome" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_attempts_number_positive" CHECK ("notification_delivery_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"required_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_app_installation_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"grant_revision" integer NOT NULL,
	"effective_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_app_permission_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"requested_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_permission_revisions_revision_positive" CHECK ("oauth_app_permission_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "oauth_app_webhook_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"endpoint_url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_auth_tag" text NOT NULL,
	"previous_secret_ciphertext" text,
	"previous_secret_iv" text,
	"previous_secret_auth_tag" text,
	"previous_valid_until" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_app_webhook_configs_revision_positive" CHECK ("oauth_app_webhook_configs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "approved_request_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "approved_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "subscribed_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "grant_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "subscription_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "outbound_request_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "outbound_current_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "outbound_pending_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "outbound_current_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "outbound_current_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notification_recipients_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_installation_tokens" ADD CONSTRAINT "oauth_app_installation_tokens_installation_id_oauth_client_installs_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."oauth_client_installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_installation_tokens" ADD CONSTRAINT "oauth_app_installation_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_installation_tokens" ADD CONSTRAINT "oauth_app_installation_tokens_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_permission_revisions" ADD CONSTRAINT "oauth_app_permission_revisions_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_permission_revisions" ADD CONSTRAINT "oauth_app_permission_revisions_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_webhook_configs" ADD CONSTRAINT "oauth_app_webhook_configs_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_app_webhook_configs" ADD CONSTRAINT "oauth_app_webhook_configs_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_deliveries_notification_adapter" ON "notification_deliveries" USING btree ("notification_id","adapter");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_ready" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_delivery_attempts_delivery_number" ON "notification_delivery_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_attempts_delivery_time" ON "notification_delivery_attempts" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_events_server_time" ON "notification_events" USING btree ("server_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_notification_events_type_time" ON "notification_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_notification_recipients_installation_event" ON "notification_recipients" USING btree ("recipient_type","recipient_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_notification_recipients_event" ON "notification_recipients" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_notification_recipients_server" ON "notification_recipients" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_app_installation_tokens_hash" ON "oauth_app_installation_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_app_installation_tokens_installation" ON "oauth_app_installation_tokens" USING btree ("installation_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_app_installation_tokens_expiry" ON "oauth_app_installation_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_app_permission_revisions_client_revision" ON "oauth_app_permission_revisions" USING btree ("client_id","revision");--> statement-breakpoint
CREATE INDEX "idx_oauth_app_permission_revisions_state" ON "oauth_app_permission_revisions" USING btree ("client_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_app_webhook_configs_client" ON "oauth_app_webhook_configs" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_approved_request_revision_id_oauth_app_permission_revisions_id_fk" FOREIGN KEY ("approved_request_revision_id") REFERENCES "public"."oauth_app_permission_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oauth_client_installs_status" ON "oauth_client_installs" USING btree ("client_id","status");--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_grant_revision_nonnegative" CHECK ("oauth_client_installs"."grant_revision" >= 0);--> statement-breakpoint
ALTER TABLE "oauth_client_installs" ADD CONSTRAINT "oauth_client_installs_subscription_revision_nonnegative" CHECK ("oauth_client_installs"."subscription_revision" >= 0);