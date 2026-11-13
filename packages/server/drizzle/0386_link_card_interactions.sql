CREATE TABLE "link_card_attempts" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"viewer_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"operation_id" uuid,
	"prepared_action_id" uuid,
	"phase" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	CONSTRAINT "link_card_attempts_provider_kind_valid" CHECK ("link_card_attempts"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_attempts_provider_key_valid" CHECK (length("link_card_attempts"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_attempts_installation_key_valid" CHECK (("link_card_attempts"."provider_kind" = 'app' AND length("link_card_attempts"."installation_key") BETWEEN 1 AND 200 AND "link_card_attempts"."installation_key" !~ '^native:') OR ("link_card_attempts"."provider_kind" = 'native' AND "link_card_attempts"."installation_key" = ('native:' || "link_card_attempts"."server_id"::text || ':' || "link_card_attempts"."provider_key"))),
	CONSTRAINT "link_card_attempts_phase_valid" CHECK ("link_card_attempts"."phase" IN ('prepare', 'execute', 'status')),
	CONSTRAINT "link_card_attempts_subject" CHECK (("link_card_attempts"."phase" = 'prepare' AND "link_card_attempts"."operation_id" IS NULL AND "link_card_attempts"."prepared_action_id" IS NOT NULL)
    OR ("link_card_attempts"."phase" <> 'prepare' AND "link_card_attempts"."operation_id" IS NOT NULL AND "link_card_attempts"."prepared_action_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "link_card_client_requests" (
	"viewer_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"client_request_id" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"url_sha256" text NOT NULL,
	"action_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_client_requests_pk" PRIMARY KEY("viewer_id","server_id","provider_kind","provider_key","installation_key","client_request_id"),
	CONSTRAINT "link_card_client_requests_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "link_card_client_requests_provider_kind_valid" CHECK ("link_card_client_requests"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_client_requests_provider_key_valid" CHECK (length("link_card_client_requests"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_client_requests_installation_key_valid" CHECK (("link_card_client_requests"."provider_kind" = 'app' AND length("link_card_client_requests"."installation_key") BETWEEN 1 AND 200 AND "link_card_client_requests"."installation_key" !~ '^native:') OR ("link_card_client_requests"."provider_kind" = 'native' AND "link_card_client_requests"."installation_key" = ('native:' || "link_card_client_requests"."server_id"::text || ':' || "link_card_client_requests"."provider_key"))),
	CONSTRAINT "link_card_client_requests_id_valid" CHECK (length("link_card_client_requests"."client_request_id") BETWEEN 16 AND 128)
);
--> statement-breakpoint
CREATE TABLE "link_card_handle_uses" (
	"handle_sha256" text PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_card_operations" (
	"operation_id" uuid PRIMARY KEY NOT NULL,
	"viewer_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"registration_revision" text NOT NULL,
	"view_nonce" text NOT NULL,
	"message_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"request_sha256" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"receipt_revision" integer DEFAULT 0 NOT NULL,
	"last_status_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"resolution_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_operations_provider_kind_valid" CHECK ("link_card_operations"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_operations_provider_key_valid" CHECK (length("link_card_operations"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_operations_installation_key_valid" CHECK (("link_card_operations"."provider_kind" = 'app' AND length("link_card_operations"."installation_key") BETWEEN 1 AND 200 AND "link_card_operations"."installation_key" !~ '^native:') OR ("link_card_operations"."provider_kind" = 'native' AND "link_card_operations"."installation_key" = ('native:' || "link_card_operations"."server_id"::text || ':' || "link_card_operations"."provider_key"))),
	CONSTRAINT "link_card_operations_state_valid" CHECK ("link_card_operations"."state" IN ('requested', 'sent', 'accepted', 'done', 'refused', 'failed_not_sent', 'unknown', 'needs_reconciliation', 'resolved_manually')),
	CONSTRAINT "link_card_operations_manual_resolution" CHECK (("link_card_operations"."state" = 'resolved_manually' AND "link_card_operations"."resolved_by_user_id" IS NOT NULL AND "link_card_operations"."resolved_at" IS NOT NULL AND length(btrim("link_card_operations"."resolution_reason")) BETWEEN 3 AND 500)
    OR ("link_card_operations"."state" <> 'resolved_manually' AND "link_card_operations"."resolved_by_user_id" IS NULL AND "link_card_operations"."resolution_reason" IS NULL AND "link_card_operations"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "link_card_prepared_actions" (
	"prepared_action_id" uuid PRIMARY KEY NOT NULL,
	"viewer_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"view_nonce" text NOT NULL,
	"handle_sha256" text NOT NULL,
	"description_sha256" text NOT NULL,
	"business_revision" text NOT NULL,
	"target" text,
	"execution_mode" text,
	"execution_account_link" text,
	"read_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_prepared_actions_consumed_by_operation_id_unique" UNIQUE("consumed_by_operation_id"),
	CONSTRAINT "link_card_prepared_actions_provider_kind_valid" CHECK ("link_card_prepared_actions"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_prepared_actions_provider_key_valid" CHECK (length("link_card_prepared_actions"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_prepared_actions_installation_key_valid" CHECK (("link_card_prepared_actions"."provider_kind" = 'app' AND length("link_card_prepared_actions"."installation_key") BETWEEN 1 AND 200 AND "link_card_prepared_actions"."installation_key" !~ '^native:') OR ("link_card_prepared_actions"."provider_kind" = 'native' AND "link_card_prepared_actions"."installation_key" = ('native:' || "link_card_prepared_actions"."server_id"::text || ':' || "link_card_prepared_actions"."provider_key"))),
	CONSTRAINT "link_card_prepared_actions_lifetime" CHECK ("link_card_prepared_actions"."expires_at" > "link_card_prepared_actions"."read_at" AND "link_card_prepared_actions"."expires_at" <= "link_card_prepared_actions"."read_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "link_card_update_tokens" (
	"token_sha256" text PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"registration_revision" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_update_id" text,
	"content_sha256" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_update_tokens_provider_kind_valid" CHECK ("link_card_update_tokens"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_update_tokens_provider_key_valid" CHECK (length("link_card_update_tokens"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_update_tokens_installation_key_valid" CHECK (("link_card_update_tokens"."provider_kind" = 'app' AND length("link_card_update_tokens"."installation_key") BETWEEN 1 AND 200 AND "link_card_update_tokens"."installation_key" !~ '^native:') OR ("link_card_update_tokens"."provider_kind" = 'native' AND "link_card_update_tokens"."installation_key" = ('native:' || "link_card_update_tokens"."server_id"::text || ':' || "link_card_update_tokens"."provider_key"))),
	CONSTRAINT "link_card_update_tokens_consumed" CHECK (("link_card_update_tokens"."consumed_update_id" IS NULL AND "link_card_update_tokens"."content_sha256" IS NULL AND "link_card_update_tokens"."receipt" IS NULL)
    OR ("link_card_update_tokens"."consumed_update_id" IS NOT NULL AND "link_card_update_tokens"."content_sha256" IS NOT NULL AND "link_card_update_tokens"."receipt" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "link_card_views" (
	"view_nonce" text PRIMARY KEY NOT NULL,
	"view_instance_id" text NOT NULL,
	"viewer_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_key" text NOT NULL,
	"installation_key" text NOT NULL,
	"message_id" uuid NOT NULL,
	"url_sha256" text NOT NULL,
	"pending_operation_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_card_views_provider_kind_valid" CHECK ("link_card_views"."provider_kind" IN ('app', 'native')),
	CONSTRAINT "link_card_views_provider_key_valid" CHECK (length("link_card_views"."provider_key") BETWEEN 1 AND 128),
	CONSTRAINT "link_card_views_installation_key_valid" CHECK (("link_card_views"."provider_kind" = 'app' AND length("link_card_views"."installation_key") BETWEEN 1 AND 200 AND "link_card_views"."installation_key" !~ '^native:') OR ("link_card_views"."provider_kind" = 'native' AND "link_card_views"."installation_key" = ('native:' || "link_card_views"."server_id"::text || ':' || "link_card_views"."provider_key")))
);
--> statement-breakpoint
ALTER TABLE "link_card_attempts" ADD CONSTRAINT "link_card_attempts_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_card_client_requests" ADD CONSTRAINT "link_card_client_requests_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_card_handle_uses" ADD CONSTRAINT "link_card_handle_uses_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_card_prepared_actions" ADD CONSTRAINT "link_card_prepared_actions_operation_fk" FOREIGN KEY ("consumed_by_operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_card_update_tokens" ADD CONSTRAINT "link_card_update_tokens_operation_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_card_views" ADD CONSTRAINT "link_card_views_pending_operation_fk" FOREIGN KEY ("pending_operation_id") REFERENCES "public"."link_card_operations"("operation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_link_card_attempts_operation" ON "link_card_attempts" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_link_card_handle_uses_expiry" ON "link_card_handle_uses" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_viewer_open" ON "link_card_operations" USING btree ("viewer_id","server_id") WHERE "link_card_operations"."state" IN ('sent', 'accepted', 'unknown');--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_installation_open" ON "link_card_operations" USING btree ("installation_key") WHERE "link_card_operations"."state" IN ('sent', 'accepted', 'unknown', 'needs_reconciliation');--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_unknown_age" ON "link_card_operations" USING btree ("created_at") WHERE "link_card_operations"."state" = 'unknown';--> statement-breakpoint
CREATE INDEX "idx_link_card_operations_terminal_trim" ON "link_card_operations" USING btree ("updated_at") WHERE "link_card_operations"."state" IN ('done', 'refused', 'failed_not_sent', 'resolved_manually');--> statement-breakpoint
CREATE INDEX "idx_link_card_prepared_actions_expiry" ON "link_card_prepared_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_link_card_update_tokens_operation" ON "link_card_update_tokens" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_link_card_views_sweep" ON "link_card_views" USING btree ("updated_at") WHERE "link_card_views"."pending_operation_id" IS NULL;